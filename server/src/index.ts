// ═══════════════════════════════════════════════════════════════════════════════
// NetOps Backend Server — standalone Express + WebSocket for large-scale polling
// ═══════════════════════════════════════════════════════════════════════════════

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { Client } from 'ssh2'

const app = express()
app.use(express.json())

// CORS — allow connections from any origin (Electron app)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { return res.sendStatus(204) }
    next()
})

const server = createServer(app)
const wss = new WebSocketServer({ server })

// ─── WebSocket client tracking ─────────────────────────────────────────────

const clients = new Set<WebSocket>()
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown'
    console.log(`[WS] Client connected from ${ip} (${clients.size + 1} total)`)
    clients.add(ws)
    ws.on('close', () => {
        clients.delete(ws)
        console.log(`[WS] Client disconnected (${clients.size} remaining)`)
    })
})

function broadcast (data: any): void {
    const msg = JSON.stringify(data)
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) { ws.send(msg) }
    }
}

// ─── SSH helper ─────────────────────────────────────────────────────────────

interface SshParams {
    host: string
    port?: number
    username: string
    password: string
    commands: string[]
    timeoutMs?: number
}

function sshRunCommands (params: SshParams): Promise<{ ok: boolean; outputs: string[]; error?: string }> {
    const { host, port = 22, username, password, commands, timeoutMs = 30000 } = params
    return new Promise((resolve) => {
        const conn = new Client()
        let settled = false
        const timer = setTimeout(() => done({ ok: false, outputs: [], error: `Timeout after ${timeoutMs} ms` }), timeoutMs + 500)

        function done (result: { ok: boolean; outputs: string[]; error?: string }): void {
            if (settled) { return }
            settled = true
            clearTimeout(timer)
            try { conn.end() } catch { /* no-op */ }
            resolve(result)
        }

        conn.on('ready', async () => {
            const outputs: string[] = []
            for (const cmd of commands) {
                try {
                    const out = await new Promise<string>((res, rej) => {
                        conn.exec(cmd, (err, stream) => {
                            if (err) { return rej(err) }
                            let buf = ''
                            stream.on('data', (chunk: Buffer) => { buf += chunk.toString() })
                            stream.stderr.on('data', (chunk: Buffer) => { buf += chunk.toString() })
                            stream.on('close', () => res(buf.trim()))
                            stream.on('error', rej)
                        })
                    })
                    outputs.push(out)
                } catch (err: any) {
                    outputs.push(`[error] ${err.message}`)
                }
            }
            done({ ok: true, outputs })
        })

        conn.on('error', (err: Error) => {
            done({ ok: false, outputs: [], error: `SSH connection failed: ${err.message}` })
        })

        try {
            conn.connect({
                host,
                port,
                username,
                password,
                readyTimeout: timeoutMs,
                algorithms: {
                    kex: [
                        'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
                        'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
                        'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1',
                    ],
                },
            })
        } catch (err: any) {
            done({ ok: false, outputs: [], error: `SSH connect error: ${err.message}` })
        }
    })
}

// ─── SSH shell session (interactive) ────────────────────────────────────────

interface ShellParams {
    host: string
    port?: number
    username: string
    password: string
    commands: string[]
    /** Slow delay (ms) for control commands. Default 300. */
    delayMs?: number
    /** Fast delay (ms) for config body lines. Default 50. */
    fastDelayMs?: number
    /** Grace (ms) after sending `exit` before resolving. Default 2000. */
    exitGraceMs?: number
    /** Hard upper bound for the whole session. Default: scaled with command count. */
    timeoutMs?: number
}

/**
 * Classify a command as "control" (needs extra time — mode transitions,
 * commit, save, exit) vs "body" (a config line that can be streamed fast).
 * For a typical 28-command Juniper push, dynamic pacing drops send time from
 * ~8.4s (300ms × 28) to ~2s (300ms × 6 control + 50ms × 22).
 */
function _isControlCommand (cmd: string): boolean {
    const t = cmd.trim().toLowerCase()
    if (!t) { return false }
    if (cmd.length === 1 && cmd.charCodeAt(0) < 32) { return true }
    const controlPatterns = [
        /^cli$/, /^configure(\s|$)/, /^conf(\s|$)/,
        /^sr_cli$/, /^enter\s+candidate$/, /^system-view$/,
        /^fastcli(\s|$)/,
        /^load\s+(set|replace|merge|override)\s+terminal$/,
        /^commit(\s|$)/, /^commit\s+now$/,
        /^end$/, /^exit$/, /^exit\s+all$/, /^quit$/, /^return$/,
        /^write\s+(memory|mem|erase)/,
        /^copy\s+running-config\s+startup-config/,
        /^save(\s|$)/, /^save\s+configuration/,
        /^sudo\s+config\s+save/,
    ]
    return controlPatterns.some(p => p.test(t))
}

/**
 * Open an interactive SSH shell, send commands with a delay, then gracefully exit.
 *
 * Robustness notes:
 *   - Control characters (e.g. Juniper's Ctrl-D = \x04) MUST be sent raw without \n.
 *   - Network device shells often do NOT close cleanly after `exit`, so we always
 *     have a grace timer that resolves with the collected output.
 *   - A hard session timeout ensures we never hang the request indefinitely.
 *   - Output is scanned for common device error patterns so that a rejected
 *     config push returns ok=false instead of masquerading as success.
 *   - Dynamic pacing: control commands get the slow delay; body lines get fast.
 */
function sshShellSession (params: ShellParams): Promise<{ ok: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
        const client = new Client()
        const slowDelay = params.delayMs ?? 300
        const fastDelay = params.fastDelayMs ?? 50
        const exitGrace = params.exitGraceMs ?? 2000
        // Scale session budget with command count. With fast pacing, avg cost
        // ≈ 150 ms/cmd, so budget = max(60s, cmds×150 + 30s slack).
        const sessionBudget = params.timeoutMs ?? Math.max(60_000, params.commands.length * 150 + 30_000)
        let output = ''
        let settled = false

        const hardTimer = setTimeout(() => {
            done({
                ok: false,
                output,
                error: `Session timed out after ${sessionBudget / 1000}s on ${params.host}`,
            })
        }, sessionBudget)

        function done (result: { ok: boolean; output: string; error?: string }): void {
            if (settled) { return }
            settled = true
            clearTimeout(hardTimer)
            try { client.end() } catch { /* no-op */ }
            resolve(result)
        }

        // Inspect accumulated output for vendor-agnostic device error patterns.
        //
        // Success/failure precedence:
        //   1. Explicit commit-failure markers ALWAYS override any success signals.
        //   2. Explicit commit-success markers (Juniper `commit complete`, Nokia
        //      `commit successful`, Arista `copy ... OK`) signal success even if
        //      earlier benign errors appeared in output (e.g. a `cli` no-op on
        //      physical QFX, or a `write memory` noise line).
        //   3. Otherwise, generic error patterns fail the push.
        function checkOutputForErrors (): { ok: boolean; output: string; error?: string } {
            const trimmed = output.trim()

            // ── Hard failures — these override any success signal ─────────────
            const failurePatterns = [
                /commit\s+failed/i,
                /commit\s+check\s+failed/i,
                /configuration\s+check-out\s+failed/i,
                /failed to commit/i,
                /authorization\s+failed/i,
                /permission\s+denied/i,
            ]
            for (const p of failurePatterns) {
                if (p.test(trimmed)) {
                    const lines = trimmed.split('\n')
                    const errLine = lines.find(l => p.test(l)) ?? ''
                    const tail = trimmed.length > 400 ? '…' + trimmed.slice(-400) : trimmed
                    return {
                        ok: false,
                        output: trimmed,
                        error: `Device error on ${params.host}: ${errLine.trim()} · output: ${tail}`,
                    }
                }
            }

            // ── Explicit success markers — trust these even if earlier output
            //    had benign errors (e.g. unknown-command from prefix commands) ──
            const successPatterns = [
                /commit\s+complete/i,          // Juniper
                /commit\s+successful/i,        // Nokia SR Linux / SR-OS
                /\[ok\]/i,                     // SR Linux "[ok]"
                /save complete/i,              // Generic save
                /configuration\s+saved/i,      // Generic save
                /copy\s+complete/i,            // Cisco `copy run start`
                /\[ok\]\s*$/im,                // Generic ok line
            ]
            if (successPatterns.some(p => p.test(trimmed))) {
                return { ok: true, output: trimmed }
            }

            // ── Otherwise, generic error patterns fail the push ───────────────
            const errorPatterns = [
                /error:\s+configuration/i,
                /syntax error/i,
                /invalid (?:input|command)/i,
                /ambiguous command/i,
                /unrecognized command/i,
                /% incomplete command/i,
                /% unknown /i,
                /% invalid /i,
            ]
            const match = errorPatterns.find(p => p.test(trimmed))
            if (match) {
                const lines = trimmed.split('\n')
                const errLine = lines.find(l => match.test(l)) ?? ''
                const tail = trimmed.length > 400 ? '…' + trimmed.slice(-400) : trimmed
                return {
                    ok: false,
                    output: trimmed,
                    error: `Device error on ${params.host}: ${errLine.trim()} · output: ${tail}`,
                }
            }
            return { ok: true, output: trimmed }
        }

        client.on('ready', () => {
            client.shell((err, stream) => {
                if (err) { done({ ok: false, output: '', error: `SSH shell failed: ${err.message}` }); return }

                stream.on('data', (data: Buffer) => { output += data.toString() })
                stream.stderr.on('data', (data: Buffer) => { output += data.toString() })

                stream.on('close', () => { done(checkOutputForErrors()) })
                stream.on('error', (streamErr: Error) => {
                    done({ ok: false, output, error: `SSH shell stream error on ${params.host}: ${streamErr.message}` })
                })

                // Send commands sequentially with dynamic pacing.
                let i = 0
                let stopped = false
                const sendNext = (): void => {
                    if (settled || stopped) { return }
                    if (i < params.commands.length) {
                        const cmd = params.commands[i++]
                        const isControl = _isControlCommand(cmd)
                        try {
                            // Control chars (e.g. Juniper Ctrl-D = \x04) must be sent raw
                            if (cmd.length === 1 && cmd.charCodeAt(0) < 32) {
                                stream.write(cmd)
                            } else {
                                stream.write(cmd + '\n')
                            }
                        } catch { stopped = true; return }
                        setTimeout(sendNext, isControl ? slowDelay : fastDelay)
                    } else {
                        // All commands sent — give the device time to process
                        // the last commit/save, then send `exit`. 2 s grace
                        // (was 10 s) — most devices close within 1 s or never.
                        setTimeout(() => {
                            try { stream.end('exit\n') } catch { /* no-op */ }
                            setTimeout(() => {
                                if (!settled) { done(checkOutputForErrors()) }
                            }, exitGrace)
                        }, slowDelay * 2)
                    }
                }
                // Wait for the initial prompt before sending.
                setTimeout(sendNext, slowDelay)
            })
        })

        client.on('error', (err) => { done({ ok: false, output, error: `SSH connection failed: ${err.message}` }) })
        client.on('close', () => {
            if (!settled) { done({ ok: false, output, error: 'SSH connection closed unexpectedly' }) }
        })

        try {
            client.connect({
                host: params.host,
                port: params.port || 22,
                username: params.username,
                password: params.password,
                readyTimeout: 15000,
                algorithms: {
                    kex: [
                        'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
                        'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
                        'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1',
                    ],
                },
            })
        } catch (err: any) {
            done({ ok: false, output: '', error: `SSH connect error: ${err.message}` })
        }
    })
}

// ─── Concurrency limiter ────────────────────────────────────────────────────

async function runWithConcurrency<T> (tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = []
    let idx = 0
    const run = async (): Promise<void> => {
        while (idx < tasks.length) {
            const i = idx++
            results[i] = await tasks[i]()
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => run()))
    return results
}

// ─── REST API ───────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
    res.json({ ok: true, clients: clients.size, uptime: process.uptime() })
})

app.post('/api/poll', async (req, res) => {
    const { host, port, username, password, commands, timeoutMs } = req.body
    if (!host || !username || !password || !commands?.length) {
        console.log(`[POLL] ❌ Rejected — missing fields: host=${host || 'EMPTY'}, user=${username || 'EMPTY'}, cmds=${commands?.length || 0}`)
        return res.status(400).json({ ok: false, error: `Missing required fields: ${!host ? 'host ' : ''}${!username ? 'username ' : ''}${!password ? 'password ' : ''}${!commands?.length ? 'commands' : ''}`.trim() })
    }
    console.log(`[POLL] ${host}:${port || 22} — ${commands.length} commands`)
    const result = await sshRunCommands({ host, port, username, password, commands, timeoutMs })
    console.log(`[POLL] ${host} — ${result.ok ? 'OK' : 'FAILED: ' + (result.error || 'unknown')}`)
    const pollResult = {
        type: 'poll_result',
        nodeId: host,
        ok: result.ok,
        data: result,
        timestamp: new Date().toISOString(),
    }
    broadcast(pollResult)
    res.json(result)
})

app.post('/api/poll-all', async (req, res) => {
    const { devices } = req.body
    if (!Array.isArray(devices) || !devices.length) {
        return res.status(400).json({ ok: false, error: 'devices array is required' })
    }

    const tasks = devices.map((dev: any) => async () => {
        const result = await sshRunCommands({
            host: dev.host,
            port: dev.port,
            username: dev.username,
            password: dev.password,
            commands: dev.commands || [],
            timeoutMs: dev.timeoutMs,
        })
        const pollResult = {
            type: 'poll_result',
            nodeId: dev.host,
            ok: result.ok,
            data: result,
            timestamp: new Date().toISOString(),
        }
        broadcast(pollResult)
        return pollResult
    })

    const results = await runWithConcurrency(tasks, 10)
    res.json({ ok: true, results })
})

app.post('/api/backup', async (req, res) => {
    const { host, port, username, password, command, timeoutMs } = req.body
    console.log(`[BACKUP] ${host}:${port || 22} — ${command || 'show running-config'}`)
    if (!host || !username || !password) {
        return res.status(400).json({ ok: false, error: 'Missing required fields (host, username, password)' })
    }
    const backupCmd = command || 'show running-config'
    const result = await sshRunCommands({ host, port, username, password, commands: [backupCmd], timeoutMs })
    console.log(`[BACKUP] ${host} — ${result.ok ? 'OK (' + (result.outputs?.[0]?.length ?? 0) + ' chars)' : 'FAILED: ' + (result.error || 'unknown')}`)
    res.json({
        ok: result.ok,
        output: result.outputs?.[0] ?? '',
        error: result.error,
        timestamp: new Date().toISOString(),
    })
})

app.post('/api/discover', async (req, res) => {
    const { host, port, username, password, command, timeoutMs } = req.body
    if (!host || !username || !password) {
        return res.status(400).json({ ok: false, error: 'Missing required fields (host, username, password)' })
    }
    const lldpCmd = command || 'show lldp neighbors detail'
    const result = await sshRunCommands({ host, port, username, password, commands: [lldpCmd], timeoutMs })
    res.json({
        ok: result.ok,
        output: result.outputs?.[0] ?? '',
        error: result.error,
        timestamp: new Date().toISOString(),
    })
})

app.post('/api/load-config', async (req, res) => {
    const { host, port, username, password, commands, delayMs, timeoutMs } = req.body
    console.log(`[LOAD-CONFIG] ${host}:${port || 22} — ${commands?.length || 0} commands`)
    if (!host || !username || !password || !commands?.length) {
        return res.status(400).json({ ok: false, error: 'Missing required fields' })
    }
    const result = await sshShellSession({ host, port, username, password, commands, delayMs: delayMs || 300, timeoutMs })
    if (result.ok) {
        console.log(`[LOAD-CONFIG] ${host} — OK (${result.output.length} chars)`)
    } else {
        const tail = (result.output || '').trim().slice(-400)
        console.log(`[LOAD-CONFIG] ${host} — FAILED: ${result.error}`)
        if (tail) { console.log(`[LOAD-CONFIG] ${host} — device said: …${tail}`) }
    }
    res.json(result)
})

// ─── Container live polling (for remote labs) ──────────────────────────────

import { execSync, exec as execCb } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(execCb)

interface DockerServer { host: string; port?: number; username: string; password: string }

/**
 * Run a docker command either locally or on a remote server via SSH.
 * When `server` is provided, the command is executed over SSH on that host.
 * When omitted, the command runs locally via child_process.
 */
async function dockerCmd (
    cmd: string,
    server?: DockerServer,
    timeoutMs = 15000,
): Promise<{ stdout: string; stderr: string }> {
    if (!server) {
        return execAsync(cmd, { timeout: timeoutMs })
    }
    // Remote: run docker command over SSH on the target server
    const result = await sshRunCommands({
        host: server.host,
        port: server.port ?? 22,
        username: server.username,
        password: server.password,
        commands: [cmd],
        timeoutMs,
    })
    if (!result.ok) { throw new Error(result.error || 'SSH command failed') }
    return { stdout: result.outputs[0] || '', stderr: '' }
}

app.post('/api/container-poll', async (req, res) => {
    const { containers, server } = req.body  // containers: Array<{name, kind}>, server?: {host, port, username, password}
    if (!Array.isArray(containers) || !containers.length) {
        return res.status(400).json({ ok: false, error: 'Missing containers array' })
    }

    const remote: DockerServer | undefined = server?.host ? server : undefined
    console.log(`[CONTAINER-POLL] ${containers.length} containers${remote ? ` via SSH → ${remote.host}` : ' (local)'}`)
    const results: Array<{ containerName: string; state: string; bgpNeighbors: any[]; srEnabled?: boolean; srLabelsCount?: number; vniActive?: number }> = []

    // Step 1: Docker inspect all containers for state
    try {
        const ids = containers.map(c => c.name).join(' ')
        const { stdout } = await dockerCmd(`docker inspect --format '{{.Name}}|{{.State.Status}}' ${ids}`, remote, 10_000)
        const stateMap = new Map<string, string>()
        for (const line of stdout.trim().split('\n')) {
            if (!line.includes('|')) continue
            const sepIdx = line.lastIndexOf('|')
            const rawName = line.slice(0, sepIdx).replace(/^\//, '')
            const state = line.slice(sepIdx + 1)
            stateMap.set(rawName, state)
        }

        // Step 2: For running containers, get BGP summary
        for (const c of containers) {
            const state = stateMap.get(c.name) ?? 'unknown'
            const entry: any = { containerName: c.name, state, bgpNeighbors: [] }

            if (state === 'running') {
                let bgpCmd: string[] | null = null
                const kind = (c.kind || '').toLowerCase()
                if (kind.includes('sonic') || kind.includes('frr')) { bgpCmd = ['vtysh', '-c', 'show bgp summary json'] }
                else if (kind.includes('srl') || kind.includes('nokia')) { bgpCmd = ['sr_cli', '-d', 'show network-instance default protocols bgp neighbor'] }
                else if (kind.includes('ceos') || kind.includes('arista')) { bgpCmd = ['Cli', '-p', '15', '-c', 'show bgp summary | json'] }
                else if (kind.includes('crpd') || kind.includes('juniper') || kind.includes('junos')) { bgpCmd = ['cli', '-c', 'show bgp summary'] }

                if (bgpCmd) {
                    try {
                        const quotedArgs = bgpCmd.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')
                        const cmdStr = `docker exec ${c.name} ${quotedArgs}`
                        console.log(`[CONTAINER-POLL] BGP cmd: ${cmdStr}${remote ? ` (via ${remote.host})` : ''}`)
                        const { stdout: bgpOut, stderr: bgpErr } = await dockerCmd(cmdStr, remote, 15_000)
                        if (bgpErr) { console.log(`[CONTAINER-POLL] BGP stderr: ${bgpErr.trim().slice(0, 100)}`) }
                        console.log(`[CONTAINER-POLL] BGP output (${bgpOut.length} chars): ${bgpOut.trim().slice(0, 200)}`)
                        // Parse BGP output — try JSON first (FRR/SONiC/Arista), fall back to regex
                        let parsed = false
                        try {
                            const json = JSON.parse(bgpOut.trim())
                            // FRR/SONiC: { ipv4Unicast: { peers: { "10.0.0.1": { remoteAs, state, pfxRcd } } } }
                            const afi = json.ipv4Unicast ?? json.ipv6Unicast ?? json
                            const peers = afi.peers ?? json.peers ?? {}
                            for (const [ip, info] of Object.entries<any>(peers)) {
                                const rawState = (info.state || info.bgpState || '').toLowerCase()
                                const state = rawState.includes('establ') ? 'established'
                                    : rawState.includes('active') ? 'active'
                                    : rawState.includes('connect') ? 'connect'
                                    : rawState.includes('idle') ? 'idle'
                                    : rawState.includes('opensent') ? 'opensent'
                                    : rawState.includes('openconfirm') ? 'openconfirm'
                                    : rawState || 'unknown'
                                entry.bgpNeighbors.push({
                                    neighborIp: ip,
                                    state,
                                    asn: info.remoteAs ?? info.asn ?? 0,
                                    prefixCount: info.pfxRcd ?? info.prefixReceivedCount ?? 0,
                                })
                            }
                            parsed = Object.keys(peers).length > 0
                            if (parsed) { console.log(`[CONTAINER-POLL] ${c.name}: parsed ${entry.bgpNeighbors.length} BGP peers from JSON`) }
                        } catch { /* not JSON, fall through to regex */ }

                        // Regex fallback for text-based outputs (Nokia SRL, Juniper cRPD, etc.)
                        if (!parsed) {
                            const ipRe = /(\d+\.\d+\.\d+\.\d+)/
                            const stateWords = ['establ', 'active', 'connect', 'idle', 'openconfirm', 'opensent']
                            for (const line of bgpOut.split('\n')) {
                                const ipMatch = line.match(ipRe)
                                if (!ipMatch) continue
                                const lower = line.toLowerCase()
                                let bgpState = 'unknown'
                                for (const sw of stateWords) {
                                    if (lower.includes(sw)) { bgpState = sw === 'establ' ? 'established' : sw; break }
                                }
                                if (bgpState === 'unknown' && !lower.includes('neighbor')) continue
                                const asnMatch = line.match(/\b(\d{4,6})\b/)
                                entry.bgpNeighbors.push({
                                    neighborIp: ipMatch[1],
                                    state: bgpState,
                                    asn: asnMatch ? Number(asnMatch[1]) : 0,
                                    prefixCount: 0,
                                })
                            }
                        }
                    } catch (bgpErr: any) { console.log(`[CONTAINER-POLL] BGP failed for ${c.name}: ${bgpErr.message?.slice(0, 100)}`) }
                }

                // SR label count (best-effort, supports SONiC/FRR, Arista, Juniper, Nokia SRL)
                let srCmd: string[] | null = null
                if (kind.includes('sonic') || kind.includes('frr')) { srCmd = ['vtysh', '-c', 'show mpls table'] }
                else if (kind.includes('ceos') || kind.includes('arista')) { srCmd = ['Cli', '-p', '15', '-c', 'show mpls label range'] }
                else if (kind.includes('srl') || kind.includes('nokia')) { srCmd = ['sr_cli', '-d', 'show network-instance default segment-routing mpls'] }
                else if (kind.includes('crpd') || kind.includes('juniper') || kind.includes('junos')) { srCmd = ['cli', '-c', 'show route table mpls.0'] }
                if (srCmd) {
                    try {
                        const quoted = srCmd.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')
                        const { stdout: srOut } = await dockerCmd(`docker exec ${c.name} ${quoted}`, remote, 10_000)
                        const labels = (srOut || '').split('\n').filter(l => /\b(1[6-9]\d{3}|2\d{4})\b/.test(l))
                        entry.srEnabled = labels.length > 0
                        entry.srLabelsCount = labels.length
                    } catch { /* skip */ }
                }

                // VNI count (best-effort, supports SONiC/FRR, Arista, Nokia SRL, Juniper)
                let vniCmd: string[] | null = null
                if (kind.includes('sonic') || kind.includes('frr')) { vniCmd = ['vtysh', '-c', 'show evpn vni json'] }
                else if (kind.includes('ceos') || kind.includes('arista')) { vniCmd = ['Cli', '-p', '15', '-c', 'show vxlan vni | json'] }
                else if (kind.includes('srl') || kind.includes('nokia')) { vniCmd = ['sr_cli', '-d', 'show tunnel-interface vxlan1 vxlan-interface 0'] }
                else if (kind.includes('crpd') || kind.includes('juniper') || kind.includes('junos')) { vniCmd = ['cli', '-c', 'show ethernet-switching vxlan-tunnel-end-point remote'] }
                if (vniCmd) {
                    try {
                        const quoted = vniCmd.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')
                        const { stdout: vniOut } = await dockerCmd(`docker exec ${c.name} ${quoted}`, remote, 10_000)
                        if (kind.includes('sonic') || kind.includes('frr')) {
                            try {
                                const json = JSON.parse(vniOut.trim())
                                entry.vniActive = typeof json === 'object' ? Object.keys(json).length : 0
                            } catch { entry.vniActive = 0 }
                        } else {
                            const vniLines = (vniOut || '').split('\n').filter(l => /\bvni\b/i.test(l) && /\d{4,}/.test(l))
                            entry.vniActive = vniLines.length
                        }
                    } catch { /* skip */ }
                }
            }

            results.push(entry)
        }

        console.log(`[CONTAINER-POLL] ${results.length} polled — ${results.filter(r => r.state === 'running').length} running`)
        res.json({ ok: true, containers: results })
    } catch (err: any) {
        console.log(`[CONTAINER-POLL] ❌ Failed: ${err.message}`)
        res.json({ ok: false, error: err.message, containers: [] })
    }
})

// ─── Start server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000
server.listen(PORT, () => {
    console.log(`NetOps backend server listening on port ${PORT}`)
})
