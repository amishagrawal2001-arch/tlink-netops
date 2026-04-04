// ═══════════════════════════════════════════════════════════════════════════════
// NetOps Backend Server — standalone Express + WebSocket for large-scale polling
// ═══════════════════════════════════════════════════════════════════════════════

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { Client } from 'ssh2'

const app = express()
app.use(express.json())

const server = createServer(app)
const wss = new WebSocketServer({ server })

// ─── WebSocket client tracking ─────────────────────────────────────────────

const clients = new Set<WebSocket>()
wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
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
        return res.status(400).json({ ok: false, error: 'Missing required fields (host, username, password, commands)' })
    }
    const result = await sshRunCommands({ host, port, username, password, commands, timeoutMs })
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
    if (!host || !username || !password) {
        return res.status(400).json({ ok: false, error: 'Missing required fields (host, username, password)' })
    }
    const backupCmd = command || 'show running-config'
    const result = await sshRunCommands({ host, port, username, password, commands: [backupCmd], timeoutMs })
    res.json({
        ok: result.ok,
        config: result.outputs?.[0] ?? '',
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

// ─── Start server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4000
server.listen(PORT, () => {
    console.log(`NetOps backend server listening on port ${PORT}`)
})
