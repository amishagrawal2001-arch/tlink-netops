import { app, BrowserWindow, ipcMain, dialog, nativeImage } from 'electron'

// Set app name before anything else — controls dock tooltip and Activity Monitor
app.name = 'NetOps'

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { Client } from 'ssh2'
import {
    SshPayload, SshResult, SshTerminalPayload, SshTerminalResult,
    _asPositiveInt, _parseSshPayload, _parseSshTerminalPayload, _connectConfig,
} from './ipc-helpers'
import * as ptyManager from './pty-manager'
import { SshConnectionPool } from './ssh-pool'

const sshPool = new SshConnectionPool()

const windows = new Map<number, BrowserWindow>()

const htmlPath = path.join(__dirname, '../../index.html')

// ─── Global SSH-error backstop ──────────────────────────────────────────────
// Defence-in-depth: any `ssh2`-related error that escapes a per-call-site
// handler (e.g. a 'close'/'error' fired AFTER our promise resolved, a stale
// connection that the server reset, a handshake torn down at the wrong
// moment) would otherwise bubble up to Node as an Uncaught Exception and
// take down the entire Electron main process, killing the user's session.
//
// Filter for SSH-shaped errors and log-and-continue. Real bugs in our own
// code still surface (we re-throw anything that doesn't match a known SSH
// error pattern).
process.on('uncaughtException', (err: Error) => {
    const msg = err?.message ?? String(err)
    const stack = err?.stack ?? ''
    const isSsh2 =
        /Connection lost before handshake|Handshake failed|All configured authentication methods failed|Keepalive timeout|read ECONNRESET/i.test(msg) ||
        /node_modules\/ssh2\//.test(stack) ||
        (err && (err as any).level === 'client-socket')
    if (isSsh2) {
        console.warn('[ssh] swallowed stray ssh2 error after caller returned:', msg)
        return  // do not crash the app
    }
    // Not an SSH error — re-emit so legitimate bugs aren't silently hidden.
    console.error('[uncaughtException]', err)
    throw err
})

// Same shape for unhandled promise rejections — ssh2 sometimes wraps async
// flows whose rejection escapes when the consumer has already moved on.
process.on('unhandledRejection', (reason: any) => {
    const msg = reason?.message ?? String(reason)
    if (/ssh2|ssh\b|handshake|ECONNRESET/i.test(msg)) {
        console.warn('[ssh] swallowed unhandled rejection:', msg)
        return
    }
    console.error('[unhandledRejection]', reason)
})

function _testSshConnection (payload: SshPayload): Promise<SshResult> {
    return new Promise(resolve => {
        const conn = new Client()
        let settled = false
        const timer = setTimeout(() => done({ ok: false, message: `SSH timeout after ${payload.timeoutMs} ms` }), payload.timeoutMs + 500)

        function done (result: SshResult): void {
            if (settled) { return }
            settled = true
            clearTimeout(timer)
            try { conn.end() } catch { /* no-op */ }
            resolve(result)
        }

        conn.on('ready', () => {
            done({ ok: true, message: `Connected to ${payload.host}:${payload.port}` })
        })

        conn.on('error', (err: Error) => {
            done({ ok: false, message: `SSH connection failed: ${err.message}` })
        })

        conn.on('close', () => {
            if (!settled) {
                done({ ok: false, message: 'SSH connection closed unexpectedly' })
            }
        })

        try {
            conn.connect(_connectConfig(payload))
        } catch (err) {
            done({ ok: false, message: `SSH connect error: ${(err as Error).message}` })
        }
    })
}

function _runSshCommand (payload: SshPayload, command: string): Promise<SshResult> {
    return new Promise(resolve => {
        let settled = false
        let releaseFn: (() => void) | null = null
        const timer = setTimeout(() => done({ ok: false, message: `SSH timeout after ${payload.timeoutMs} ms` }), payload.timeoutMs + 1000)

        function done (result: SshResult): void {
            if (settled) { return }
            settled = true
            clearTimeout(timer)
            if (releaseFn) { releaseFn() }
            resolve(result)
        }

        const cfg = _connectConfig(payload)
        sshPool.getConnection(payload.host, payload.port, payload.username, payload.password, cfg)
            .then(({ client: conn, release }) => {
                releaseFn = release
                conn.exec(command, (err, stream) => {
                    if (err) {
                        done({ ok: false, message: `SSH exec failed: ${err.message}` })
                        return
                    }

                    let stdout = ''
                    let stderr = ''

                    stream.on('data', (chunk: Buffer | string) => {
                        stdout += chunk.toString()
                    })

                    stream.stderr.on('data', (chunk: Buffer | string) => {
                        stderr += chunk.toString()
                    })

                    stream.on('close', (code: number | null) => {
                        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
                        const hasOutput = !!output
                        const codeOk = code === null || code === 0
                        done({
                            ok: codeOk || hasOutput,
                            message: codeOk || hasOutput
                                ? `Command completed on ${payload.host}`
                                : `Remote command exited with code ${code}`,
                            output: output || '(no output)',
                        })
                    })

                    stream.on('error', (streamErr: Error) => {
                        done({ ok: false, message: `SSH stream failed: ${streamErr.message}` })
                    })
                })
            })
            .catch(err => {
                done({ ok: false, message: `SSH connection failed: ${(err as Error).message}` })
            })
    })
}

/**
 * Run multiple commands via SSH exec channel by writing them to stdin.
 * Unlike sshShellSession (interactive shell), exec channel closes reliably.
 */
function _runSshExecMulti (
    payload: SshPayload, commands: string[],
): Promise<SshResult> {
    return new Promise(resolve => {
        const conn = new Client()
        let settled = false
        let output = ''
        // Connection timeout — only for establishing SSH + opening shell
        const connTimer = setTimeout(() => {
            done({ ok: false, message: `SSH connection timeout after ${payload.timeoutMs} ms` })
        }, payload.timeoutMs)

        function done (result: SshResult): void {
            if (settled) { return }
            settled = true
            clearTimeout(connTimer)
            try { conn.end() } catch { /* no-op */ }
            resolve(result)
        }

        conn.on('ready', () => {
            conn.exec('/bin/sh', { pty: true }, (err, stream) => {
                if (err) {
                    done({ ok: false, message: `SSH exec failed: ${err.message}` })
                    return
                }

                // Shell opened — cancel connection timeout, use grace timer instead
                clearTimeout(connTimer)

                stream.on('data', (chunk: Buffer | string) => {
                    output += chunk.toString()
                })

                stream.stderr.on('data', (chunk: Buffer | string) => {
                    output += chunk.toString()
                })

                // Check output for device-level error indicators
                const checkOutputForErrors = (): SshResult => {
                    const trimmed = output.trim()
                    const lower = trimmed.toLowerCase()
                    const errorPatterns = [
                        /commit\s+failed/i,
                        /error:\s+configuration/i,
                        /syntax error/i,
                        /invalid (?:input|command)/i,
                        /unknown command/i,
                        /failed to commit/i,
                        /commit\s+check\s+failed/i,
                        /authorization\s+failed/i,
                        /permission\s+denied/i,
                    ]
                    const match = errorPatterns.find(p => p.test(trimmed))
                    if (match) {
                        // Extract the matching error line for context
                        const lines = trimmed.split('\n')
                        const errLine = lines.find(l => match.test(l)) ?? ''
                        return {
                            ok: false,
                            message: `Device error on ${payload.host}: ${errLine.trim()}`,
                            output: trimmed || '(no output)',
                        }
                    }
                    return {
                        ok: true,
                        message: `Commands completed on ${payload.host}`,
                        output: trimmed || '(no output)',
                    }
                }

                stream.on('close', () => {
                    done(checkOutputForErrors())
                })

                stream.on('error', (streamErr: Error) => {
                    done({ ok: false, message: `SSH stream error: ${streamErr.message}`, output })
                })

                // Write all commands at once, then exit
                for (const cmd of commands) {
                    if (cmd.length === 1 && cmd.charCodeAt(0) < 32) {
                        stream.write(cmd)
                    } else {
                        stream.write(cmd + '\n')
                    }
                }
                stream.write('exit\n')

                // Grace timer: resolve after 10s with collected output.
                // Network device shells often don't close cleanly after exit.
                setTimeout(() => {
                    if (!settled) {
                        done(checkOutputForErrors())
                    }
                }, 10000)
            })
        })

        conn.on('error', (err: Error) => {
            done({ ok: false, message: `SSH connection failed: ${err.message}` })
        })

        conn.on('close', () => {
            if (!settled) {
                done({ ok: false, message: 'SSH connection closed unexpectedly' })
            }
        })

        try {
            conn.connect(_connectConfig(payload))
        } catch (err) {
            done({ ok: false, message: `SSH connect error: ${(err as Error).message}` })
        }
    })
}

function _spawnDetached (cmd: string, args: string[]): void {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
}

/** Async spawn that doesn't block the Electron main process */
function _spawnAsync (cmd: string, args: string[], opts?: { timeout?: number; env?: NodeJS.ProcessEnv }): Promise<{ status: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
        const child = spawn(cmd, args, { stdio: 'pipe', env: opts?.env ?? process.env })
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = opts?.timeout ? setTimeout(() => {
            if (!settled) { settled = true; child.kill('SIGKILL'); resolve({ status: 1, stdout, stderr: 'Timeout' }) }
        }, opts.timeout) : null
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
        child.on('close', (code) => {
            if (timer) { clearTimeout(timer) }
            if (!settled) { settled = true; resolve({ status: code ?? 1, stdout, stderr }) }
        })
        child.on('error', (err) => {
            if (timer) { clearTimeout(timer) }
            if (!settled) { settled = true; resolve({ status: 1, stdout, stderr: err.message }) }
        })
    })
}

function _openSshTerminal (payload: SshTerminalPayload): SshTerminalResult & { sessionId?: string } {
    const target = `${payload.username}@${payload.host}`
    // When password provided, use SSH_ASKPASS helper + SetsID to make ssh use the helper instead of tty prompt
    // Options: -o PreferredAuthentications=password for simpler auth flow, -o StrictHostKeyChecking=no for labs
    const sshOptions = '-o PreferredAuthentications=password,keyboard-interactive,publickey -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR'
    const sshCommand = `ssh ${sshOptions} -p ${payload.port} ${target}`
    const sessionId = `ssh-${payload.host}-${Date.now()}`

    // Build env with SSH_ASKPASS if password provided
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    if (payload.password) {
        _ensureAskpass(payload.password)
        env['TLINK_SSH_PASSWORD'] = payload.password
        env['SSH_ASKPASS'] = _ASKPASS_SCRIPT
        env['SSH_ASKPASS_REQUIRE'] = 'force'  // OpenSSH 8.4+
        env['DISPLAY'] = env['DISPLAY'] || ':0'
    }

    let shell: string
    let shellArgs: string[]
    if (process.platform === 'win32') {
        shell = process.env.COMSPEC || 'cmd.exe'
        shellArgs = ['/c', sshCommand]
    } else {
        // setsid detaches from controlling tty so SSH uses SSH_ASKPASS instead of prompting the tty
        // (without this, ssh detects the pty and asks directly, ignoring SSH_ASKPASS)
        shell = '/bin/sh'
        shellArgs = payload.password
            ? ['-c', `setsid -w ${sshCommand} < /dev/null || ${sshCommand}`]
            : ['-lc', sshCommand]
    }

    return _openTerminalWindow({
        sessionId,
        label: `SSH: ${target}`,
        command: shell,
        args: shellArgs,
        env,
    })
}

function createWindow (initialTopologyJson?: string): BrowserWindow {
    const iconPath = path.join(__dirname, '..', '..', 'assets', process.platform === 'darwin' ? 'icon.icns' : 'icon.png')
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: 'NetOps',
        icon: iconPath,
        backgroundColor: '#0d1117',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    })

    // Pass the initial topology JSON via a URL query param (base64) — race-free approach
    const query: Record<string, string> = initialTopologyJson
        ? { t: Buffer.from(initialTopologyJson).toString('base64') }
        : {}

    win.loadFile(htmlPath, { query })

    if (!app.isPackaged && process.env.NODE_ENV !== 'production') {
        win.webContents.openDevTools({ mode: 'detach' })
    }

    windows.set(win.id, win)
    win.on('closed', () => { windows.delete(win.id) })

    return win
}

const terminalHtmlPath = path.join(__dirname, '../../terminal.html')

function _openTerminalWindow (opts: {
    sessionId: string
    label: string
    command: string
    args: string[]
    env?: Record<string, string>
}): { ok: true; sessionId: string; message: string } | { ok: false; message: string } {
    try {
        const win = new BrowserWindow({
            width: 820,
            height: 520,
            minWidth: 400,
            minHeight: 250,
            title: opts.label,
            backgroundColor: '#1e1e2e',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload-terminal.js'),
            },
        })

        win.loadFile(terminalHtmlPath, { query: { sid: opts.sessionId } })

        // Spawn PTY once the window is ready to receive data
        win.webContents.once('did-finish-load', () => {
            ptyManager.createSession({
                id: opts.sessionId,
                label: opts.label,
                command: opts.command,
                args: opts.args,
                env: opts.env,
                sender: win.webContents,
            })
        })

        // Destroy PTY when window closes
        win.on('closed', () => {
            ptyManager.destroySession(opts.sessionId)
        })

        return { ok: true, sessionId: opts.sessionId, message: opts.label }
    } catch (err) {
        return { ok: false, message: `Failed to open terminal: ${(err as Error).message}` }
    }
}

app.whenReady().then(() => {
    // Set dock icon on macOS
    if (process.platform === 'darwin') {
        const dockIcon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'))
        if (!dockIcon.isEmpty()) { app.dock.setIcon(dockIcon) }
    }
    createWindow()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { app.quit() }
})

app.on('before-quit', () => {
    sshPool.destroyAll()
    ptyManager.destroyAllSessions()
})

app.on('activate', () => {
    if (windows.size === 0) { createWindow() }
})

// ─── IPC: File save/load ─────────────────────────────────────────────────────

ipcMain.handle('save-topology', async (_event, json: string, defaultName: string) => {
    const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Save Topology',
        defaultPath: `${defaultName}.topo.json`,
        filters: [{ name: 'Topology JSON', extensions: ['json', 'topo.json'] }],
    })
    if (canceled || !filePath) { return { ok: false } }
    fs.writeFileSync(filePath, json, 'utf8')
    return { ok: true, filePath }
})

// Direct save — write to a known path without showing a dialog (Ctrl+S after first save)
ipcMain.handle('save-topology-direct', async (_event, json: string, filePath: string) => {
    try {
        fs.writeFileSync(filePath, json, 'utf8')
        return { ok: true, filePath }
    } catch (err) {
        return { ok: false, message: `Failed to save: ${(err as Error).message}` }
    }
})

ipcMain.handle('load-topology', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
        title: 'Open Topology',
        filters: [{ name: 'Topology JSON', extensions: ['json', 'topo.json'] }],
        properties: ['openFile'],
    })
    if (canceled || !filePaths[0]) { return { ok: false } }
    const json = fs.readFileSync(filePaths[0], 'utf8')
    return { ok: true, json, filePath: filePaths[0] }
})

// ─── IPC: Workspace — save/load all tabs in one file ─────────────────────────

ipcMain.handle('save-workspace', async (_event, json: string, defaultName: string) => {
    const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Save Workspace',
        defaultPath: `${defaultName}.workspace.json`,
        filters: [{ name: 'Tlink Workspace', extensions: ['workspace.json'] }],
    })
    if (canceled || !filePath) { return { ok: false } }
    fs.writeFileSync(filePath, json, 'utf8')
    return { ok: true, filePath }
})

// Direct workspace save — write to a known path without dialog
ipcMain.handle('save-workspace-direct', async (_event, json: string, filePath: string) => {
    try {
        fs.writeFileSync(filePath, json, 'utf8')
        return { ok: true, filePath }
    } catch (err) {
        return { ok: false, message: `Failed to save workspace: ${(err as Error).message}` }
    }
})

ipcMain.handle('load-workspace', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
        title: 'Open Workspace',
        filters: [{ name: 'Tlink Workspace', extensions: ['workspace.json', 'json'] }],
        properties: ['openFile'],
    })
    if (canceled || !filePaths[0]) { return { ok: false } }
    const json = fs.readFileSync(filePaths[0], 'utf8')
    return { ok: true, json, filePath: filePaths[0] }
})

// ─── IPC: Open topology in a new window ──────────────────────────────────────

ipcMain.handle('open-in-new-window', async (_event, json: string) => {
    createWindow(json)
    return { ok: true }
})

// ─── IPC: Help window (separate floating window) ─────────────────────────────

let helpWindow: BrowserWindow | null = null

ipcMain.handle('open-help-window', async (_event) => {
    if (helpWindow && !helpWindow.isDestroyed()) {
        helpWindow.focus()
        return { ok: true }
    }
    const parent = BrowserWindow.getFocusedWindow() ?? undefined
    helpWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 400,
        minHeight: 300,
        title: 'Help & Usage Guide',
        backgroundColor: '#0d1117',
        alwaysOnTop: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    })
    helpWindow.loadFile(htmlPath, { query: { mode: 'help' } })
    helpWindow.on('resize', () => {
        if (!helpWindow || helpWindow.isDestroyed()) { return }
        const [w, h] = helpWindow.getSize()
        helpWindow.setTitle(`Help & Usage Guide — ${w} × ${h}`)
    })
    helpWindow.on('closed', () => { helpWindow = null })
    return { ok: true }
})

ipcMain.handle('close-help-window', async () => {
    if (helpWindow && !helpWindow.isDestroyed()) { helpWindow.close() }
    helpWindow = null
    return { ok: true }
})

// ─── IPC: Live SSH checks (physical devices) ────────────────────────────────

ipcMain.handle('ssh-test-connection', async (_event, rawPayload: unknown): Promise<SshResult> => {
    const parsed = _parseSshPayload(rawPayload)
    if ('message' in parsed) { return { ok: false, message: parsed.message } }
    return _testSshConnection(parsed.value)
})

ipcMain.handle('ssh-run-show-version', async (_event, rawPayload: unknown): Promise<SshResult> => {
    const parsed = _parseSshPayload(rawPayload)
    if ('message' in parsed) { return { ok: false, message: parsed.message } }
    return _runSshCommand(parsed.value, 'show version')
})

ipcMain.handle('open-ssh-terminal', async (_event, rawPayload: unknown): Promise<SshTerminalResult & { sessionId?: string }> => {
    const parsed = _parseSshTerminalPayload(rawPayload)
    if ('message' in parsed) { return { ok: false, message: parsed.message } }
    return _openSshTerminal(parsed.value)
})

// ─── IPC: Inventory — arbitrary SSH command ──────────────────────────────────

ipcMain.handle('ssh-run-command', async (_event, rawPayload: unknown): Promise<SshResult> => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const command = String(obj['command'] ?? '').trim()
    if (!command) { return { ok: false, message: 'Command is required' } }

    const parsed = _parseSshPayload(rawPayload)
    if ('message' in parsed) { return { ok: false, message: parsed.message } }
    return _runSshCommand(parsed.value, command)
})

// ─── IPC: Streaming SSH command (sends chunks as they arrive) ──────────────

function _runSshCommandStream (payload: SshPayload, command: string, sender: Electron.WebContents, streamId: string): Promise<SshResult> {
    return new Promise(resolve => {
        const conn = new Client()
        let settled = false
        const timer = setTimeout(() => done({ ok: false, message: `SSH timeout after ${payload.timeoutMs} ms` }), payload.timeoutMs + 1000)

        function done (result: SshResult): void {
            if (settled) { return }
            settled = true
            clearTimeout(timer)
            try { conn.end() } catch { /* no-op */ }
            resolve(result)
        }

        conn.on('ready', () => {
            conn.exec(command, (err, stream) => {
                if (err) {
                    done({ ok: false, message: `SSH exec failed: ${err.message}` })
                    return
                }

                let stdout = ''
                let stderr = ''

                stream.on('data', (chunk: Buffer | string) => {
                    const text = chunk.toString()
                    stdout += text
                    try { sender.send(`ssh-stream-${streamId}`, text) } catch { /* window may be gone */ }
                })

                stream.stderr.on('data', (chunk: Buffer | string) => {
                    const text = chunk.toString()
                    stderr += text
                    try { sender.send(`ssh-stream-${streamId}`, text) } catch { /* window may be gone */ }
                })

                stream.on('close', (code: number | null) => {
                    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
                    const hasOutput = !!output
                    const codeOk = code === null || code === 0
                    done({
                        ok: codeOk || hasOutput,
                        message: codeOk || hasOutput
                            ? `Command completed on ${payload.host}`
                            : `Remote command exited with code ${code}`,
                        output: output || '(no output)',
                    })
                })

                stream.on('error', (streamErr: Error) => {
                    done({ ok: false, message: `SSH stream failed: ${streamErr.message}` })
                })
            })
        })

        conn.on('error', (err: Error) => {
            done({ ok: false, message: `SSH connection failed: ${err.message}` })
        })

        conn.on('close', () => {
            if (!settled) {
                done({ ok: false, message: 'SSH connection closed unexpectedly' })
            }
        })

        try {
            conn.connect(_connectConfig(payload))
        } catch (err) {
            done({ ok: false, message: `SSH connect error: ${(err as Error).message}` })
        }
    })
}

ipcMain.handle('ssh-run-command-stream', async (event, rawPayload: unknown): Promise<SshResult> => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const command = String(obj['command'] ?? '').trim()
    const streamId = String(obj['streamId'] ?? '').trim()
    if (!command) { return { ok: false, message: 'Command is required' } }
    if (!streamId) { return { ok: false, message: 'streamId is required' } }

    const parsed = _parseSshPayload(rawPayload)
    if ('message' in parsed) { return { ok: false, message: parsed.message } }
    return _runSshCommandStream(parsed.value, command, event.sender, streamId)
})

// ─── IPC: Inventory — run multiple commands on one SSH session ───────────────

interface SshMultiResult {
    ok: boolean
    message: string
    results: SshResult[]
}

function _runSshMultiCommand (payload: SshPayload, commands: string[]): Promise<SshMultiResult> {
    return new Promise(resolve => {
        const conn = new Client()
        let settled = false
        const results: SshResult[] = []
        const timer = setTimeout(() => done({
            ok: false, message: `SSH timeout after ${payload.timeoutMs} ms`, results,
        }), payload.timeoutMs + commands.length * 5000)

        function done (result: SshMultiResult): void {
            if (settled) { return }
            settled = true
            clearTimeout(timer)
            try { conn.end() } catch { /* no-op */ }
            resolve(result)
        }

        function runNext (index: number): void {
            if (index >= commands.length) {
                done({ ok: true, message: `Completed ${commands.length} commands on ${payload.host}`, results })
                return
            }

            conn.exec(commands[index], (err, stream) => {
                if (err) {
                    results.push({ ok: false, message: `Command "${commands[index]}" exec failed: ${err.message}` })
                    runNext(index + 1)
                    return
                }

                let stdout = ''
                let stderr = ''

                stream.on('data', (chunk: Buffer | string) => { stdout += chunk.toString() })
                stream.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString() })

                stream.on('close', (code: number | null) => {
                    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
                    // Network devices (Juniper, Cisco, etc.) often return non-zero
                    // exit codes even on successful commands.  Treat any command that
                    // produced output as successful — the parser will decide validity.
                    const hasOutput = !!output
                    const codeOk = code === null || code === 0
                    results.push({
                        ok: codeOk || hasOutput,
                        message: !codeOk && !hasOutput
                            ? `Command "${commands[index]}" exited with code ${code}`
                            : `Command completed`,
                        output: output || '(no output)',
                    })
                    runNext(index + 1)
                })

                stream.on('error', (streamErr: Error) => {
                    results.push({ ok: false, message: `Stream error on "${commands[index]}": ${streamErr.message}` })
                    runNext(index + 1)
                })
            })
        }

        conn.on('ready', () => { runNext(0) })

        conn.on('error', (err: Error) => {
            done({ ok: false, message: `SSH connection failed: ${err.message}`, results })
        })

        conn.on('close', () => {
            if (!settled) {
                done({ ok: false, message: 'SSH connection closed unexpectedly', results })
            }
        })

        try {
            conn.connect(_connectConfig(payload))
        } catch (err) {
            done({ ok: false, message: `SSH connect error: ${(err as Error).message}`, results })
        }
    })
}

ipcMain.handle('ssh-run-commands', async (_event, rawPayload: unknown): Promise<SshMultiResult> => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload', results: [] }
    }
    const obj = rawPayload as Record<string, unknown>
    const commands = Array.isArray(obj['commands']) ? obj['commands'].map(String) : []
    if (!commands.length) { return { ok: false, message: 'Commands array is required', results: [] } }

    const parsed = _parseSshPayload(rawPayload)
    if ('message' in parsed) { return { ok: false, message: parsed.message, results: [] } }
    return _runSshMultiCommand(parsed.value, commands)
})

// ─── SSH shell session (for config loading) ─────────────────────────────────

/**
 * Classify a command as "control" (needs extra time — mode transitions,
 * commit, save, exit) vs "body" (a config line that can be streamed fast).
 * Mirrors the same logic in server/src/index.ts.
 */
function _isControlCommand (cmd: string): boolean {
    const t = cmd.trim().toLowerCase()
    if (!t) { return false }
    if (cmd.length === 1 && cmd.charCodeAt(0) < 32) { return true }     // Ctrl-D / Ctrl-Z
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
 * Commands that need EXTRA time to land before the next command can
 * be sent — these aren't just control commands, they're full
 * subprocess launches that the device takes 1–3s to bring up.
 *
 * Most important: `cli` on Junos EVO / cRPD. The binary launches the
 * Junos CLI on top of the FreeBSD/EVO shell; with only the standard
 * slowDelay between commands, the next `configure` lands at the SHELL
 * (where `set` is a noop builtin) instead of inside the CLI — exactly
 * the bug observed on QFX5240 EVO push.
 */
function _isHeavyControlCommand (cmd: string): boolean {
    const t = cmd.trim().toLowerCase()
    return t === 'cli'        // Junos CLI launcher
        || t === 'sr_cli'     // SR Linux CLI
        || t === 'fastcli'    // Arista cEOS FastCli
}

function _runSshShellSession (
    payload: SshPayload, commands: string[], delayMs: number,
): Promise<SshResult> {
    // ── Strict-commit detection ─────────────────────────────────────────────
    // If the command stream contains a `commit` / `save` / `copy run start`
    // step (i.e. the postamble actually tried to commit), then we REQUIRE
    // seeing a vendor-specific success marker (`commit complete`, `commit
    // successful`, `copy complete`, etc.) before reporting ok. Otherwise a
    // silent commit failure — license missing, candidate conflict, exclusive-
    // lock held by another session — falls through the no-error-pattern
    // path and reports false success.
    const expectsCommit = commands.some(c => {
        const t = c.trim().toLowerCase()
        return t === 'commit'
            || t === 'commit and-quit'
            || t === 'commit confirmed'
            || t === 'commit now'
            || t === 'write memory'
            || t === 'copy running-config startup-config'
            || t === 'save'
    })
    return new Promise(resolve => {
        const conn = new Client()
        let settled = false
        let output = ''
        // Dynamic pacing: caller-supplied `delayMs` becomes the *slow* delay
        // for control commands; body lines stream 6× faster (min 50ms).
        const slowDelay = Math.max(delayMs, 50)
        const fastDelay = Math.max(Math.floor(delayMs / 6), 50)

        // Connection timeout — only covers SSH connect + shell open
        const connTimer = setTimeout(
            () => done({ ok: false, message: `SSH connection timeout after ${payload.timeoutMs} ms` }),
            payload.timeoutMs,
        )

        function done (result: SshResult): void {
            if (settled) { return }
            settled = true
            clearTimeout(connTimer)
            try { conn.end() } catch { /* no-op */ }
            resolve(result)
        }

        // Inspect accumulated output for vendor-agnostic device error patterns.
        //
        // Success/failure precedence:
        //   1. Explicit commit-failure markers ALWAYS override any success signal.
        //   2. Explicit commit-success markers (Juniper `commit complete`, Nokia
        //      `commit successful`, Cisco `copy complete`) signal success even if
        //      earlier benign errors appeared in output (e.g. a `cli` no-op on
        //      physical QFX where SSH drops directly into the Junos CLI).
        //   3. Otherwise, generic error patterns fail the push.
        const checkOutputForErrors = (): SshResult => {
            const trimmed = output.trim()

            // ── Hard failures override any success signal ─────────────────────
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
                        message: `Device error on ${payload.host}: ${errLine.trim()} · output: ${tail}`,
                        output: trimmed || '(no output)',
                    }
                }
            }

            // ── Explicit success markers — trust these even if earlier output
            //    had benign errors (e.g. unknown-command from prefix commands) ──
            const successPatterns = [
                /commit\s+complete/i,          // Juniper
                /commit\s+successful/i,        // Nokia SR Linux / SR-OS
                /save complete/i,              // Generic save
                /configuration\s+saved/i,      // Generic save
                /copy\s+complete/i,            // Cisco `copy run start`
                /\[ok\]\s*$/im,                // SR Linux "[ok]"
            ]
            if (successPatterns.some(p => p.test(trimmed))) {
                return {
                    ok: true,
                    message: `Shell session completed on ${payload.host}`,
                    output: trimmed || '(no output)',
                }
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
                    message: `Device error on ${payload.host}: ${errLine.trim()} · output: ${tail}`,
                    output: trimmed || '(no output)',
                }
            }
            // ── Strict mode: when a commit step is in the command stream we
            //    REQUIRE seeing a success marker. Silently-failing commits
            //    (license missing, candidate conflict, exclusive lock by
            //    another session) print a warning that doesn't match our
            //    error patterns and would otherwise fall through as ok.
            //    Fail closed instead.
            if (expectsCommit) {
                const tail = trimmed.length > 400 ? '…' + trimmed.slice(-400) : trimmed
                return {
                    ok: false,
                    message: `Commit not confirmed on ${payload.host} — no "commit complete" / "commit successful" / "copy complete" marker in device output. The candidate config may not be applied. · output: ${tail || '(no output)'}`,
                    output: trimmed || '(no output)',
                }
            }
            return {
                ok: true,
                message: `Shell session completed on ${payload.host}`,
                output: trimmed || '(no output)',
            }
        }

        conn.on('ready', () => {
            conn.shell((err, stream) => {
                if (err) {
                    done({ ok: false, message: `SSH shell failed: ${err.message}` })
                    return
                }

                // Shell opened — cancel connection timeout
                clearTimeout(connTimer)

                stream.on('data', (chunk: Buffer | string) => {
                    output += chunk.toString()
                })

                stream.stderr.on('data', (chunk: Buffer | string) => {
                    output += chunk.toString()
                })

                stream.on('close', () => {
                    done(checkOutputForErrors())
                })

                stream.on('error', (streamErr: Error) => {
                    const tail = output.trim().slice(-400)
                    done({
                        ok: false,
                        message: `SSH shell stream error on ${payload.host}: ${streamErr.message}${tail ? ' · output: …' + tail : ''}`,
                        output,
                    })
                })

                // Send commands sequentially with dynamic delays:
                //   • Control commands (configure/commit/save/exit/Ctrl-D) get
                //     the slow delay so the device has time to process them.
                //   • Config body lines get the fast delay — Juniper `load set
                //     terminal` is buffered so lines can stream at near-wire
                //     speed.
                // 3-tier pacing:
                //   • heavy control (cli / sr_cli / fastcli) → 2.5 s — these
                //     launch a CLI subprocess on top of a shell and need
                //     real time to come up before the next command can land
                //     in the right context.
                //   • regular control (configure, commit, exit, ^D, etc) →
                //     slowDelay (default 500 ms)
                //   • config body lines → fastDelay (~85 ms)
                const HEAVY_CONTROL_DELAY = Math.max(slowDelay * 5, 2500)
                let index = 0
                let stopped = false
                function sendNext (): void {
                    if (settled || stopped) { return }
                    if (index >= commands.length) {
                        // All commands sent — wait for final output, then close gracefully.
                        // 2 s grace replaces the old 10 s — most devices close within 1 s
                        // of `exit` or never close at all.
                        setTimeout(() => {
                            try { stream.end('exit\n') } catch { /* no-op */ }
                            setTimeout(() => {
                                if (!settled) { done(checkOutputForErrors()) }
                            }, 2000)
                        }, slowDelay * 2)
                        return
                    }
                    const cmd = commands[index++]
                    const isHeavy = _isHeavyControlCommand(cmd)
                    const isControl = isHeavy || _isControlCommand(cmd)
                    try {
                        // Control chars (e.g. Ctrl-D \x04) must be sent raw without newline
                        if (cmd.length === 1 && cmd.charCodeAt(0) < 32) {
                            stream.write(cmd)
                        } else {
                            stream.write(cmd + '\n')
                        }
                    } catch { stopped = true; return }
                    const nextDelay = isHeavy ? HEAVY_CONTROL_DELAY : isControl ? slowDelay : fastDelay
                    setTimeout(sendNext, nextDelay)
                }

                // Wait for initial prompt before sending commands
                setTimeout(sendNext, slowDelay)
            })
        })

        conn.on('error', (err: Error) => {
            done({ ok: false, message: `SSH connection failed: ${err.message}` })
        })

        conn.on('close', () => {
            if (!settled) {
                done({ ok: false, message: 'SSH connection closed unexpectedly' })
            }
        })

        try {
            conn.connect(_connectConfig(payload))
        } catch (err) {
            done({ ok: false, message: `SSH connect error: ${(err as Error).message}` })
        }
    })
}

ipcMain.handle('ssh-shell-session', async (_event, rawPayload: unknown): Promise<SshResult> => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const commands = Array.isArray(obj['commands']) ? obj['commands'].map(String) : []
    if (!commands.length) { return { ok: false, message: 'Commands array is required' } }
    const delayMs = typeof obj['delayMs'] === 'number' ? obj['delayMs'] : 500

    const parsed = _parseSshPayload(rawPayload)
    if ('message' in parsed) { return { ok: false, message: parsed.message } }
    return _runSshShellSession(parsed.value, commands, delayMs)
})

ipcMain.handle('ssh-shell-session-via-bastion', async (_event, rawPayload: unknown): Promise<SshResult> => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>

    // Validate bastion credentials
    const bastionRaw = obj['bastion']
    if (!bastionRaw || typeof bastionRaw !== 'object') {
        return { ok: false, message: 'Bastion configuration is required' }
    }
    const bastionParsed = _parseSshPayload(bastionRaw)
    if (!bastionParsed.ok) { return { ok: false, message: `Bastion: ${(bastionParsed as { ok: false; message: string }).message}` } }
    const bastion = (bastionParsed as { ok: true; value: SshPayload }).value

    // Validate target credentials
    const targetRaw = obj['target']
    if (!targetRaw || typeof targetRaw !== 'object') {
        return { ok: false, message: 'Target configuration is required' }
    }
    const targetParsed = _parseSshPayload(targetRaw)
    if (!targetParsed.ok) { return { ok: false, message: `Target: ${(targetParsed as { ok: false; message: string }).message}` } }
    const target = (targetParsed as { ok: true; value: SshPayload }).value

    const commands = Array.isArray(obj['commands']) ? obj['commands'].map(String) : []
    if (!commands.length) { return { ok: false, message: 'Commands array is required' } }
    const delayMs = typeof obj['delayMs'] === 'number' ? obj['delayMs'] : 500

    return new Promise(resolve => {
        const bastionConn = new Client()
        let settled = false
        let output = ''

        const connTimer = setTimeout(
            () => done({ ok: false, message: `Bastion SSH connection timeout after ${bastion.timeoutMs} ms` }),
            bastion.timeoutMs,
        )

        function done (result: SshResult): void {
            if (settled) { return }
            settled = true
            clearTimeout(connTimer)
            try { bastionConn.end() } catch { /* no-op */ }
            resolve(result)
        }

        bastionConn.on('error', (err: Error) => {
            done({ ok: false, message: `Bastion SSH error: ${err.message}` })
        })

        bastionConn.on('ready', () => {
            clearTimeout(connTimer)

            // Use TCP forwarding through the bastion to reach the target
            bastionConn.forwardOut('127.0.0.1', 0, target.host, target.port, (fwdErr, channel) => {
                if (fwdErr) {
                    done({ ok: false, message: `Bastion port-forward failed: ${fwdErr.message}` })
                    return
                }

                // Connect a second SSH client through the forwarded channel
                const targetConn = new Client()

                targetConn.on('error', (err: Error) => {
                    done({ ok: false, message: `Target SSH error via bastion: ${err.message}` })
                })

                targetConn.on('ready', () => {
                    targetConn.shell((shellErr, stream) => {
                        if (shellErr) {
                            done({ ok: false, message: `Target shell failed: ${shellErr.message}` })
                            return
                        }

                        stream.on('data', (chunk: Buffer | string) => { output += chunk.toString() })
                        stream.stderr.on('data', (chunk: Buffer | string) => { output += chunk.toString() })

                        stream.on('close', () => {
                            try { targetConn.end() } catch { /* no-op */ }
                            done({
                                ok: true,
                                message: `Shell session completed on ${target.host} via bastion ${bastion.host}`,
                                output: output.trim() || '(no output)',
                            })
                        })

                        stream.on('error', (streamErr: Error) => {
                            done({ ok: false, message: `Target shell stream error: ${streamErr.message}`, output })
                        })

                        // Send commands sequentially with delays (mirrors _runSshShellSession)
                        let index = 0
                        function sendNext (): void {
                            if (settled) { return }
                            if (index >= commands.length) {
                                setTimeout(() => {
                                    try { stream.end('exit\n') } catch { /* no-op */ }
                                    setTimeout(() => {
                                        if (!settled) {
                                            try { targetConn.end() } catch { /* no-op */ }
                                            done({
                                                ok: true,
                                                message: `Shell session completed on ${target.host} via bastion ${bastion.host}`,
                                                output: output.trim() || '(no output)',
                                            })
                                        }
                                    }, 10000)
                                }, delayMs * 2)
                                return
                            }
                            const cmd = commands[index++]
                            try {
                                if (cmd.length === 1 && cmd.charCodeAt(0) < 32) {
                                    stream.write(cmd)
                                } else {
                                    stream.write(cmd + '\n')
                                }
                            } catch (writeErr) {
                                done({ ok: false, message: `Failed to write command: ${(writeErr as Error).message}`, output })
                                return
                            }
                            setTimeout(sendNext, delayMs)
                        }
                        sendNext()
                    })
                })

                targetConn.connect({
                    sock: channel,
                    username: target.username,
                    password: target.password,
                    readyTimeout: target.timeoutMs,
                    keepaliveInterval: 0,
                })
            })
        })

        bastionConn.connect(_connectConfig(bastion))
    })
})

ipcMain.handle('ssh-exec-multi', async (_event, rawPayload: unknown): Promise<SshResult> => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const commands = Array.isArray(obj['commands']) ? obj['commands'].map(String) : []
    if (!commands.length) { return { ok: false, message: 'Commands array is required' } }

    const parsed = _parseSshPayload(rawPayload)
    if ('message' in parsed) { return { ok: false, message: parsed.message } }
    return _runSshExecMulti(parsed.value, commands)
})

// ─── IPC: Inventory — file I/O ───────────────────────────────────────────────

ipcMain.handle('inventory-save', async (_event, json: string, filePath: string) => {
    try {
        fs.writeFileSync(filePath, json, 'utf8')
        return { ok: true }
    } catch (err) {
        return { ok: false, message: `Failed to save inventory: ${(err as Error).message}` }
    }
})

ipcMain.handle('inventory-load', async (_event, filePath: string) => {
    try {
        if (!fs.existsSync(filePath)) { return { ok: false, message: 'Inventory file not found' } }
        const json = fs.readFileSync(filePath, 'utf8')
        return { ok: true, json }
    } catch (err) {
        return { ok: false, message: `Failed to load inventory: ${(err as Error).message}` }
    }
})

ipcMain.handle('inventory-export-config', async (_event, content: string, defaultName: string) => {
    const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export Config Backup',
        defaultPath: defaultName,
        filters: [{ name: 'Config files', extensions: ['cfg', 'conf', 'txt'] }],
    })
    if (canceled || !filePath) { return { ok: false } }
    fs.writeFileSync(filePath, content, 'utf8')
    return { ok: true, filePath }
})

ipcMain.handle('file-hash', async (_event, content: string) => {
    const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex')
    return { hash }
})

// ─── IPC: Preferences (persistent key-value store) ───────────────────────────

const prefsFilePath = () => path.join(app.getPath('userData'), 'netops-prefs.json')

function loadPrefs (): Record<string, any> {
    try { return JSON.parse(fs.readFileSync(prefsFilePath(), 'utf-8')) } catch { return {} }
}

function savePrefs (prefs: Record<string, any>): void {
    fs.writeFileSync(prefsFilePath(), JSON.stringify(prefs, null, 2), 'utf-8')
}

ipcMain.handle('pref-get', async (_e, key: string) => {
    const prefs = loadPrefs()
    return prefs[key] ?? null
})

ipcMain.handle('pref-set', async (_e, key: string, value: any) => {
    const prefs = loadPrefs()
    prefs[key] = value
    savePrefs(prefs)
    return { ok: true }
})

// ─── IPC: Config Snippet Library ──────────────────────────────────────────────

const snippetFilePath = () => path.join(app.getPath('userData'), 'netops-snippets.json')

ipcMain.handle('snippet-load-all', async () => {
    try {
        const fp = snippetFilePath()
        if (!fs.existsSync(fp)) { return { ok: true, snippets: [] } }
        const raw = fs.readFileSync(fp, 'utf8')
        const snippets = JSON.parse(raw)
        return { ok: true, snippets: Array.isArray(snippets) ? snippets : [] }
    } catch (err) {
        return { ok: false, snippets: [], message: `Failed to load snippets: ${(err as Error).message}` }
    }
})

ipcMain.handle('snippet-save', async (_event, snippets: any[]) => {
    try {
        fs.writeFileSync(snippetFilePath(), JSON.stringify(snippets, null, 2), 'utf8')
        return { ok: true }
    } catch (err) {
        return { ok: false, message: `Failed to save snippets: ${(err as Error).message}` }
    }
})

ipcMain.handle('snippet-delete', async (_event, id: string) => {
    try {
        const fp = snippetFilePath()
        if (!fs.existsSync(fp)) { return { ok: true } }
        const raw = fs.readFileSync(fp, 'utf8')
        const snippets = JSON.parse(raw)
        const filtered = Array.isArray(snippets) ? snippets.filter((s: any) => s.id !== id) : []
        fs.writeFileSync(fp, JSON.stringify(filtered, null, 2), 'utf8')
        return { ok: true }
    } catch (err) {
        return { ok: false, message: `Failed to delete snippet: ${(err as Error).message}` }
    }
})

// ─── IPC: SNMP polling ───────────────────────────────────────────────────────

import { _parseSnmpPayload, SnmpPayload, SnmpResult } from './snmp-helpers'

async function _doSnmpGet (payload: SnmpPayload, oids: string[]): Promise<SnmpResult> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const snmp = require('net-snmp')
        const sessionOpts: any = { port: payload.port, timeout: payload.timeoutMs }

        let session: any
        if (payload.version === '2c') {
            session = snmp.createSession(payload.host, payload.community, sessionOpts)
        } else {
            const user: any = { name: payload.username }
            if (payload.authProtocol) {
                user.level = payload.privProtocol
                    ? snmp.SecurityLevel.authPriv
                    : snmp.SecurityLevel.authNoPriv
                user.authProtocol = payload.authProtocol === 'sha'
                    ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5
                user.authKey = payload.authPassword
                if (payload.privProtocol) {
                    user.privProtocol = payload.privProtocol === 'aes'
                        ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des
                    user.privKey = payload.privPassword
                }
            } else {
                user.level = snmp.SecurityLevel.noAuthNoPriv
            }
            session = snmp.createV3Session(payload.host, user, sessionOpts)
        }

        return new Promise<SnmpResult>((resolve) => {
            session.get(oids, (error: any, varbinds: any[]) => {
                session.close()
                if (error) {
                    return resolve({ ok: false, message: `SNMP GET error: ${error.message ?? error}` })
                }
                const data = varbinds.map((vb: any) => ({
                    oid: vb.oid,
                    type: snmp.ObjectType[vb.type] ?? String(vb.type),
                    value: vb.value?.toString() ?? '',
                }))
                resolve({ ok: true, message: 'SNMP GET successful', data })
            })
        })
    } catch (err) {
        return { ok: false, message: `SNMP error: ${(err as Error).message}` }
    }
}

ipcMain.handle('snmp-get', async (_event, raw: unknown) => {
    const parsed = _parseSnmpPayload(raw)
    if (!parsed.ok) { return { ok: false, message: (parsed as { ok: false; message: string }).message } }
    const oids = (raw as any)?.oids
    if (!Array.isArray(oids) || !oids.length) {
        return { ok: false, message: 'SNMP GET requires an array of OIDs' }
    }
    return _doSnmpGet(parsed.value, oids)
})

ipcMain.handle('snmp-test-connection', async (_event, raw: unknown) => {
    const parsed = _parseSnmpPayload(raw)
    if (!parsed.ok) { return { ok: false, message: (parsed as { ok: false; message: string }).message } }
    // Test with sysDescr.0
    return _doSnmpGet(parsed.value, ['1.3.6.1.2.1.1.1.0'])
})

ipcMain.handle('snmp-walk', async (_event, raw: unknown) => {
    const parsed = _parseSnmpPayload(raw)
    if (!parsed.ok) { return { ok: false, message: (parsed as { ok: false; message: string }).message } }
    const oid = (raw as any)?.oid
    if (typeof oid !== 'string' || !oid) {
        return { ok: false, message: 'SNMP WALK requires an OID string' }
    }

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const snmp = require('net-snmp')
        const sessionOpts: any = { port: parsed.value.port, timeout: parsed.value.timeoutMs }
        const payload = parsed.value

        let session: any
        if (payload.version === '2c') {
            session = snmp.createSession(payload.host, payload.community, sessionOpts)
        } else {
            const user: any = { name: payload.username }
            if (payload.authProtocol) {
                user.level = payload.privProtocol
                    ? snmp.SecurityLevel.authPriv
                    : snmp.SecurityLevel.authNoPriv
                user.authProtocol = payload.authProtocol === 'sha'
                    ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5
                user.authKey = payload.authPassword
                if (payload.privProtocol) {
                    user.privProtocol = payload.privProtocol === 'aes'
                        ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des
                    user.privKey = payload.privPassword
                }
            } else {
                user.level = snmp.SecurityLevel.noAuthNoPriv
            }
            session = snmp.createV3Session(payload.host, user, sessionOpts)
        }

        const data: { oid: string; type: string; value: string }[] = []
        return new Promise<SnmpResult>((resolve) => {
            session.subtree(oid, 20,
                (varbinds: any[]) => {
                    for (const vb of varbinds) {
                        data.push({
                            oid: vb.oid,
                            type: snmp.ObjectType[vb.type] ?? String(vb.type),
                            value: vb.value?.toString() ?? '',
                        })
                    }
                },
                (error: any) => {
                    session.close()
                    if (error) {
                        return resolve({ ok: false, message: `SNMP WALK error: ${error.message ?? error}` })
                    }
                    resolve({ ok: true, message: `SNMP WALK returned ${data.length} varbinds`, data })
                },
            )
        })
    } catch (err) {
        return { ok: false, message: `SNMP error: ${(err as Error).message}` }
    }
})

// ─── IPC: Syslog server ─────────────────────────────────────────────────────

import { startSyslogServer, stopSyslogServer, isSyslogServerRunning, SyslogMessage } from './syslog-server'

ipcMain.handle('syslog-start', async (_event, port?: number) => {
    const p = typeof port === 'number' && port > 0 && port <= 65535 ? port : 1514
    const mainWin = [...windows.values()][0]
    const result = startSyslogServer(p, (msg: SyslogMessage) => {
        if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send('syslog-message', msg)
        }
    })
    return result
})

ipcMain.handle('syslog-stop', async () => {
    return stopSyslogServer()
})

ipcMain.handle('syslog-status', async () => {
    // Resolve first non-internal IPv4 address for vendor config hints
    let localIp = '< this-host-ip >'
    try {
        const os = require('os')
        const ifaces = os.networkInterfaces()
        for (const name of Object.keys(ifaces)) {
            for (const info of ifaces[name] ?? []) {
                if (info.family === 'IPv4' && !info.internal) {
                    localIp = info.address
                    break
                }
            }
            if (localIp !== '< this-host-ip >') { break }
        }
    } catch (_) { /* ignore */ }
    return { running: isSyslogServerRunning(), localIp }
})

// ═══════════════════════════════════════════════════════════════════════════════
// Containerlab lab management
// ═══════════════════════════════════════════════════════════════════════════════

interface ClabTerminalResult {
    ok: boolean
    message: string
}

function _openClabTerminal (command: string, labName: string, extraEnv?: Record<string, string>): ClabTerminalResult & { sessionId?: string } {
    const sessionId = `clab-${labName}-${Date.now()}`
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash')
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-lc', command]
    // Always pass _dockerEnv() so SSH_ASKPASS, DOCKER_HOST etc. are available
    // as process-level env vars (in addition to being inline in the command string).
    const env = { ..._dockerEnv(), ...(extraEnv ?? {}) }
    return _openTerminalWindow({
        sessionId,
        label: `Clab: ${labName}`,
        command: shell,
        args: shellArgs,
        env,
    })
}

// ── Containerlab server management ──────────────────────────────────────────

import type { ClabServerProfile, ClabServerState, ClabServerResourcesResult, ClabServerHeartbeatResult } from './ipc-helpers'
import { CLAB_SERVER_DEFAULT_STATE } from './ipc-helpers'

const CLAB_SERVERS_FILE = path.join(app.getPath('userData'), 'clab-servers.json')

function _loadServerState (): ClabServerState {
    try {
        if (fs.existsSync(CLAB_SERVERS_FILE)) {
            const data = JSON.parse(fs.readFileSync(CLAB_SERVERS_FILE, 'utf8'))
            // Ensure the built-in Local profile always exists
            if (!data.profiles?.some((p: ClabServerProfile) => p.id === 'local')) {
                data.profiles = [CLAB_SERVER_DEFAULT_STATE.profiles[0], ...(data.profiles ?? [])]
            }
            return data
        }
    } catch { /* ignore corrupt file */ }
    return { ...CLAB_SERVER_DEFAULT_STATE }
}

function _saveServerState (state: ClabServerState): void {
    fs.writeFileSync(CLAB_SERVERS_FILE, JSON.stringify(state, null, 2), 'utf8')
}

function _activeServer (): ClabServerProfile {
    const state = _loadServerState()
    return state.profiles.find(p => p.id === state.activeServerId)
        ?? state.profiles[0]
}

/** Look up a server profile by ID.  Falls back to active server if not found. */
function _getServerById (serverId: string): ClabServerProfile {
    if (!serverId) { return _activeServer() }
    const state = _loadServerState()
    return state.profiles.find(p => p.id === serverId) ?? _activeServer()
}

function _isRemote (): boolean {
    return _activeServer().type === 'ssh'
}

/** Build ssh2 ConnectConfig for a server profile — uses password or ssh-agent. */
function _ssh2ConnectOpts (server: ClabServerProfile): import('ssh2').ConnectConfig {
    const opts: import('ssh2').ConnectConfig = {
        host: server.host,
        port: server.port ?? 22,
        username: server.username,
        readyTimeout: 10_000,
    }
    if (server.password) {
        opts.password = server.password
    } else {
        opts.agent = process.env['SSH_AUTH_SOCK']
    }
    return opts
}

// SSH_ASKPASS helper — creates a tiny script that echoes the stored password
// so that Docker SSH transport (and any other SSH-based tool) can authenticate.
// On Windows, creates a .bat file; on macOS/Linux, creates a .sh file.
const _ASKPASS_DIR = path.join(app.getPath('userData'), '.ssh-helpers')
const _ASKPASS_SCRIPT = process.platform === 'win32'
    ? path.join(_ASKPASS_DIR, 'askpass.bat')
    : path.join(_ASKPASS_DIR, 'askpass.sh')

function _ensureAskpass (password: string): void {
    if (!fs.existsSync(_ASKPASS_DIR)) { fs.mkdirSync(_ASKPASS_DIR, { recursive: true }) }
    if (process.platform === 'win32') {
        // Windows: batch script that echoes the password from the env var
        const script = '@echo off\r\necho %TLINK_SSH_PASSWORD%\r\n'
        fs.writeFileSync(_ASKPASS_SCRIPT, script, { encoding: 'utf8' })
    } else {
        // macOS/Linux: shell script
        const script = '#!/bin/sh\necho "$TLINK_SSH_PASSWORD"\n'
        fs.writeFileSync(_ASKPASS_SCRIPT, script, { mode: 0o700, encoding: 'utf8' })
    }
}

function _dockerEnv (): Record<string, string> {
    const server = _activeServer()
    if (server.type === 'ssh' && server.host && server.username) {
        const portPart = server.port && server.port !== 22 ? `:${server.port}` : ''
        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            DOCKER_HOST: `ssh://${server.username}@${server.host}${portPart}`,
        }
        // If password auth, set SSH_ASKPASS so Docker's SSH transport can use it
        if (server.password) {
            _ensureAskpass(server.password)
            env['TLINK_SSH_PASSWORD'] = server.password
            env['SSH_ASKPASS'] = _ASKPASS_SCRIPT
            env['SSH_ASKPASS_REQUIRE'] = 'force'
            env['DISPLAY'] = env['DISPLAY'] || ':0'
        }
        return env
    }
    return process.env as Record<string, string>
}

function _sshTarget (): { user: string; host: string; port: number } | null {
    const server = _activeServer()
    if (server.type !== 'ssh' || !server.host || !server.username) { return null }
    return { user: server.username, host: server.host, port: server.port ?? 22 }
}

/** Upload files to a remote server via SFTP (ssh2). Uses SSH agent auth.
 *  When `server` is provided it targets that server; otherwise uses the active server.
 */
async function _scpFiles (
    files: Array<{ remotePath: string; content: string }>,
    mkdirs?: string[],
    server?: ClabServerProfile,
): Promise<{ ok: boolean; message: string }> {
    const srv = server ?? _activeServer()
    if (srv.type !== 'ssh' || !srv.host || !srv.username) {
        return { ok: false, message: 'No remote server configured' }
    }
    const target = { user: srv.username, host: srv.host, port: srv.port ?? 22 }

    return new Promise(resolve => {
        const conn = new Client()
        const timer = setTimeout(() => {
            try { conn.end() } catch { /* no-op */ }
            resolve({ ok: false, message: 'SFTP timeout after 15 s' })
        }, 15_000)

        conn.on('error', (err: Error) => {
            clearTimeout(timer)
            resolve({ ok: false, message: `SSH error: ${err.message}` })
        })

        conn.on('ready', () => {
            conn.sftp(async (err, sftp) => {
                if (err) {
                    clearTimeout(timer)
                    conn.end()
                    resolve({ ok: false, message: `SFTP error: ${err.message}` })
                    return
                }

                try {
                    // Create remote directories
                    for (const dir of mkdirs ?? []) {
                        await new Promise<void>((res, rej) => {
                            conn.exec(`mkdir -p "${dir}"`, (e, stream) => {
                                if (e) { rej(e); return }
                                stream.on('close', () => res())
                                stream.on('data', () => {})
                                stream.stderr.on('data', () => {})
                            })
                        })
                    }

                    // Write files
                    for (const file of files) {
                        await new Promise<void>((res, rej) => {
                            const ws = sftp.createWriteStream(file.remotePath)
                            ws.on('error', rej)
                            ws.on('close', () => res())
                            ws.end(file.content, 'utf8')
                        })
                    }

                    clearTimeout(timer)
                    conn.end()
                    resolve({ ok: true, message: `Uploaded ${files.length} file(s)` })
                } catch (uploadErr) {
                    clearTimeout(timer)
                    conn.end()
                    resolve({ ok: false, message: `Upload failed: ${(uploadErr as Error).message}` })
                }
            })
        })

        conn.connect({
            ...(_ssh2ConnectOpts(srv)),
            host: target.host,
            port: target.port,
            username: target.user,
        })
    })
}

ipcMain.handle('clab-server-list', async () => {
    const state = _loadServerState()
    return { profiles: state.profiles, activeServerId: state.activeServerId }
})

ipcMain.handle('clab-server-save', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = (rawPayload as Record<string, unknown>)['profile'] as Record<string, unknown> | undefined
    if (!obj) { return { ok: false, message: 'Missing profile' } }

    const profile: ClabServerProfile = {
        id: String(obj['id'] ?? `server-${Date.now()}`).trim(),
        name: String(obj['name'] ?? 'Remote Server').trim(),
        type: obj['type'] === 'ssh' ? 'ssh' : 'local',
        host: String(obj['host'] ?? '').trim() || undefined,
        port: Number(obj['port']) || 22,
        username: String(obj['username'] ?? '').trim() || undefined,
        password: obj['password'] ? String(obj['password']) : undefined,
        remoteLabDir: String(obj['remoteLabDir'] ?? '').trim() || undefined,
    }

    // Cannot modify built-in local profile type
    if (profile.id === 'local') { profile.type = 'local' }

    // Validate SSH profiles
    if (profile.type === 'ssh') {
        if (!profile.host) { return { ok: false, message: 'Host is required for SSH servers' } }
        if (!profile.username) { return { ok: false, message: 'Username is required for SSH servers' } }
    }

    const state = _loadServerState()
    const idx = state.profiles.findIndex(p => p.id === profile.id)
    if (idx >= 0) {
        state.profiles[idx] = profile
    } else {
        state.profiles.push(profile)
    }
    _saveServerState(state)
    return { ok: true, message: 'Server saved' }
})

ipcMain.handle('clab-server-delete', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const id = String((rawPayload as Record<string, unknown>)['id'] ?? '').trim()
    if (!id || id === 'local') { return { ok: false, message: 'Cannot delete the Local server' } }

    const state = _loadServerState()
    state.profiles = state.profiles.filter(p => p.id !== id)
    if (state.activeServerId === id) { state.activeServerId = 'local' }
    _saveServerState(state)
    return { ok: true, message: 'Server deleted' }
})

ipcMain.handle('clab-server-set-active', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const id = String((rawPayload as Record<string, unknown>)['id'] ?? '').trim()
    if (!id) { return { ok: false, message: 'Server ID required' } }

    const state = _loadServerState()
    if (!state.profiles.some(p => p.id === id)) {
        return { ok: false, message: 'Server not found' }
    }
    state.activeServerId = id
    _saveServerState(state)
    return { ok: true, message: `Switched to ${id}` }
})

ipcMain.handle('clab-server-test', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, ssh: false, docker: false, clab: false, message: 'Invalid payload' }
    }
    const id = String((rawPayload as Record<string, unknown>)['id'] ?? '').trim()
    const state = _loadServerState()
    const profile = state.profiles.find(p => p.id === id)
    if (!profile) {
        return { ok: false, ssh: false, docker: false, clab: false, message: 'Server not found' }
    }

    if (profile.type === 'local') {
        // Test local Docker + clab
        const dockerCheck = await _spawnAsync('docker', ['info'], { timeout: 10_000 })
        const docker = dockerCheck.status === 0
        const clabMode = await _detectClabMode()
        // KVM check: /dev/kvm on Linux, Hypervisor.framework on macOS
        let kvm = false
        if (process.platform === 'linux') {
            kvm = fs.existsSync('/dev/kvm')
        } else if (process.platform === 'darwin') {
            const hvf = await _spawnAsync('sysctl', ['-n', 'kern.hv_support'], { timeout: 3_000 })
            kvm = hvf.stdout?.trim() === '1'
        }
        return {
            ok: docker && clabMode.mode !== 'none',
            ssh: true,
            docker,
            clab: clabMode.mode !== 'none',
            kvm,
            message: docker ? 'Local Docker running' : 'Docker not running',
        }
    }

    // Remote SSH server test
    if (!profile.host || !profile.username) {
        return { ok: false, ssh: false, docker: false, clab: false, message: 'Host and username required' }
    }

    const portPart = profile.port && profile.port !== 22 ? ':' + profile.port : ''
    const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        DOCKER_HOST: `ssh://${profile.username}@${profile.host}${portPart}`,
    }

    // If password auth, set SSH_ASKPASS so Docker's SSH transport can use it
    if (profile.password) {
        _ensureAskpass(profile.password)
        env['TLINK_SSH_PASSWORD'] = profile.password
        env['SSH_ASKPASS'] = _ASKPASS_SCRIPT
        env['SSH_ASKPASS_REQUIRE'] = 'force'
        env['DISPLAY'] = env['DISPLAY'] || ':0'
    }

    // Test SSH + Docker via DOCKER_HOST
    const dockerTest = await _spawnAsync('docker', ['info'], {
        timeout: 15_000, env: env as NodeJS.ProcessEnv,
    })
    const docker = dockerTest.status === 0
    if (!docker) {
        const errMsg = dockerTest.stderr?.trim() || 'Cannot connect'
        return { ok: false, ssh: false, docker: false, clab: false, message: `SSH/Docker failed: ${errMsg}` }
    }

    // Docker worked → SSH is also working. Now test containerlab.
    const clabTest = await _spawnAsync('docker', ['run', '--rm', CLAB_DOCKER_IMAGE, 'containerlab', 'version'], {
        timeout: 15_000, env: env as NodeJS.ProcessEnv,
    })
    const clab = clabTest.status === 0

    // KVM check on remote server via ssh2
    let kvm = false
    try {
        kvm = await new Promise<boolean>((resolve) => {
            const conn = new Client()
            const timer = setTimeout(() => { try { conn.end() } catch {} resolve(false) }, 8_000)
            conn.on('error', () => { clearTimeout(timer); resolve(false) })
            conn.on('ready', () => {
                conn.exec('test -c /dev/kvm && echo KVM_OK || echo KVM_NO', (err, stream) => {
                    if (err) { clearTimeout(timer); conn.end(); resolve(false); return }
                    let out = ''
                    stream.on('data', (d: Buffer) => { out += d.toString() })
                    stream.on('close', () => {
                        clearTimeout(timer); conn.end()
                        resolve(out.trim().includes('KVM_OK'))
                    })
                })
            })
            conn.connect({ ..._ssh2ConnectOpts(profile), readyTimeout: 8_000 })
        })
    } catch { /* ignore */ }

    return {
        ok: docker,
        ssh: true,
        docker,
        clab,
        kvm,
        message: docker && clab ? 'Connected — Docker + Containerlab OK' :
                 docker ? 'Docker OK, containerlab not found on remote' :
                 'Connection failed',
    }
})

// ── Server heartbeat (lightweight connectivity check) ────────────────────────

ipcMain.handle('clab-server-heartbeat', async (): Promise<ClabServerHeartbeatResult> => {
    const server = _activeServer()
    if (server.type === 'local') {
        return { ok: true, latencyMs: 0 }
    }
    if (!server.host || !server.username) {
        return { ok: false }
    }
    const start = Date.now()
    return new Promise<ClabServerHeartbeatResult>(resolve => {
        const conn = new Client()
        const timeout = setTimeout(() => {
            conn.end()
            resolve({ ok: false })
        }, 5_000)
        conn.on('ready', () => {
            conn.exec('echo ok', (err, stream) => {
                if (err) { clearTimeout(timeout); conn.end(); resolve({ ok: false }); return }
                stream.on('close', () => {
                    clearTimeout(timeout)
                    conn.end()
                    resolve({ ok: true, latencyMs: Date.now() - start })
                })
                stream.resume()
            })
        })
        conn.on('error', () => { clearTimeout(timeout); resolve({ ok: false }) })
        conn.connect({
            ..._ssh2ConnectOpts(server),
            readyTimeout: 5_000,
        })
    })
})

// ── Server resources (CPU, memory, disk, containers) ─────────────────────────

ipcMain.handle('clab-server-resources', async (): Promise<ClabServerResourcesResult> => {
    const server = _activeServer()

    if (server.type === 'local') {
        // Local resources via Node.js os module
        const cpus = os.cpus()
        const cpuCount = cpus.length
        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const usedMem = totalMem - freeMem

        // Disk usage
        let diskUsed = '—'
        let diskTotal = '—'
        try {
            const dfOut = spawnSync('df', ['-h', '/'], { encoding: 'utf8', timeout: 5_000 })
            if (dfOut.status === 0) {
                const lines = dfOut.stdout.trim().split('\n')
                if (lines.length >= 2) {
                    const parts = lines[1].split(/\s+/)
                    diskTotal = parts[1] ?? '—'
                    diskUsed = parts[2] ?? '—'
                }
            }
        } catch { /* ignore */ }

        // Container count
        let containers = 0
        try {
            const ps = spawnSync('docker', ['ps', '-q'], { encoding: 'utf8', timeout: 5_000 })
            if (ps.status === 0) {
                containers = ps.stdout.trim().split('\n').filter(Boolean).length
            }
        } catch { /* ignore */ }

        // VM count + KVM check (local)
        let vms = 0
        let kvm = false
        if (process.platform === 'linux') {
            kvm = fs.existsSync('/dev/kvm')
            try {
                const vl = spawnSync('virsh', ['list', '--state-running', '--name'], { encoding: 'utf8', timeout: 5_000 })
                if (vl.status === 0) { vms = vl.stdout.trim().split('\n').filter(Boolean).length }
            } catch { /* ignore */ }
        } else if (process.platform === 'darwin') {
            const hvf = spawnSync('sysctl', ['-n', 'kern.hv_support'], { stdio: 'pipe', encoding: 'utf8', timeout: 3_000 })
            kvm = hvf.stdout?.trim() === '1'
        }

        return {
            ok: true,
            cpu: `${cpuCount} cores`,
            memUsed: `${(usedMem / 1073741824).toFixed(1)} GB`,
            memTotal: `${(totalMem / 1073741824).toFixed(1)} GB`,
            diskUsed,
            diskTotal,
            containers,
            vms,
            kvm,
        }
    }

    // Remote: SSH exec commands
    if (!server.host || !server.username) {
        return { ok: false, message: 'Host/username not set' }
    }

    return new Promise<ClabServerResourcesResult>(resolve => {
        const conn = new Client()
        const timeout = setTimeout(() => {
            conn.end()
            resolve({ ok: false, message: 'Timeout' })
        }, 10_000)

        conn.on('ready', () => {
            // Run combined command for all metrics (including KVM + VM count)
            const cmd = [
                'nproc 2>/dev/null || echo 0',
                'free -m 2>/dev/null | grep Mem || echo "Mem: 0 0 0"',
                'df -h / 2>/dev/null | tail -1 || echo "— — — —"',
                'docker ps -q 2>/dev/null | wc -l || echo 0',
                'test -c /dev/kvm && echo KVM_OK || echo KVM_NO',
                'virsh list --state-running --name 2>/dev/null | grep -c . || echo 0',
            ].join(' && echo "---SEP---" && ')

            conn.exec(cmd, (err, stream) => {
                if (err) { clearTimeout(timeout); conn.end(); resolve({ ok: false, message: err.message }); return }
                let data = ''
                stream.on('data', (chunk: Buffer) => { data += chunk.toString() })
                stream.on('close', () => {
                    clearTimeout(timeout)
                    conn.end()
                    try {
                        const parts = data.split('---SEP---').map(s => s.trim())
                        const cpuCores = parts[0] ?? '?'
                        const memLine = parts[1] ?? ''
                        const diskLine = parts[2] ?? ''
                        const containerCount = parseInt(parts[3] ?? '0', 10) || 0
                        const kvmLine = (parts[4] ?? '').trim()
                        const vmCount = parseInt(parts[5] ?? '0', 10) || 0

                        // Parse memory: "Mem:   total   used   free ..."
                        const memParts = memLine.split(/\s+/)
                        const memTotalMB = parseInt(memParts[1] ?? '0', 10)
                        const memUsedMB = parseInt(memParts[2] ?? '0', 10)

                        // Parse disk
                        const diskParts = diskLine.split(/\s+/)

                        resolve({
                            ok: true,
                            cpu: `${cpuCores} cores`,
                            memUsed: memTotalMB > 1024 ? `${(memUsedMB / 1024).toFixed(1)} GB` : `${memUsedMB} MB`,
                            memTotal: memTotalMB > 1024 ? `${(memTotalMB / 1024).toFixed(1)} GB` : `${memTotalMB} MB`,
                            diskUsed: diskParts[2] ?? '—',
                            diskTotal: diskParts[1] ?? '—',
                            containers: containerCount,
                            vms: vmCount,
                            kvm: kvmLine.includes('KVM_OK'),
                        })
                    } catch {
                        resolve({ ok: false, message: 'Failed to parse resources' })
                    }
                })
            })
        })
        conn.on('error', (err) => { clearTimeout(timeout); resolve({ ok: false, message: err.message }) })
        conn.connect({
            ..._ssh2ConnectOpts(server),
            readyTimeout: 8_000,
        })
    })
})

// ── Validate host interfaces for pre-deploy checks ────────────────────────────

ipcMain.handle('clab-validate-host-interfaces', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const interfaces = Array.isArray(obj['interfaces']) ? obj['interfaces'] as string[] : []
    const serverId = String(obj['serverId'] ?? '').trim()

    if (!interfaces.length) { return { ok: true, results: [] } }

    const server = serverId ? _getServerById(serverId) : _activeServer()
    const serverLabel = server.type === 'ssh' ? `${server.name ?? server.id} (${server.host})` : 'local'

    type IfaceResult = {
        name: string
        exists: boolean
        state: string        // 'up', 'down', 'unknown'
        hasIp: boolean
        inBridge: boolean
        bridgeName: string
        error: string
    }

    const results: IfaceResult[] = []

    try {
        // Get full interface details in one shot
        const cmd = server.type === 'local' && process.platform === 'darwin'
            ? 'ifconfig -a'
            : 'ip -d addr show'

        // Helper to run command on the resolved server (not _activeServer)
        const runOnServer = async (c: string): Promise<{ ok: boolean; stdout: string; message: string }> => {
            if (server.type === 'local') {
                const r = await _spawnAsync('bash', ['-c', c], { timeout: 10_000 })
                return { ok: r.status === 0, stdout: r.stdout ?? '', message: r.stderr?.trim() ?? '' }
            }
            // SSH to the specific server
            return new Promise(resolve => {
                const conn = new Client()
                const timer = setTimeout(() => { try { conn.end() } catch {} resolve({ ok: false, stdout: '', message: 'Timeout' }) }, 10_000)
                conn.on('error', (err: Error) => { clearTimeout(timer); resolve({ ok: false, stdout: '', message: err.message }) })
                conn.on('ready', () => {
                    conn.exec(c, (err, stream) => {
                        if (err) { clearTimeout(timer); conn.end(); resolve({ ok: false, stdout: '', message: err.message }); return }
                        let out = '', errOut = ''
                        stream.on('data', (d: Buffer) => { out += d.toString() })
                        stream.stderr.on('data', (d: Buffer) => { errOut += d.toString() })
                        stream.on('close', (code: number) => { clearTimeout(timer); conn.end(); resolve({ ok: code === 0, stdout: out, message: errOut.trim() }) })
                    })
                })
                conn.connect({ ..._ssh2ConnectOpts(server), readyTimeout: 8_000 })
            })
        }

        let output = ''
        const cmdRes = await runOnServer(cmd)
        output = cmdRes.stdout

        // Also get bridge membership info
        let bridgeOutput = ''
        if (!(server.type === 'local' && process.platform === 'darwin')) {
            const brRes = await runOnServer('bridge link show 2>/dev/null')
            bridgeOutput = brRes.stdout
        }

        // Parse bridge membership: build map of iface → master bridge
        const bridgeMap = new Map<string, string>()
        for (const line of bridgeOutput.split('\n')) {
            const match = line.match(/^\d+:\s+(\S+).*master\s+(\S+)/)
            if (match) { bridgeMap.set(match[1], match[2]) }
        }

        if (process.platform === 'darwin' && server.type === 'local') {
            // macOS: parse ifconfig output
            for (const ifName of interfaces) {
                const regex = new RegExp(`^${ifName}:.*?(?=^\\S|$(?!\\n))`, 'ms')
                const block = output.match(regex)?.[0] ?? ''
                const exists = block.length > 0
                const state = block.includes('status: active') || block.includes('RUNNING') ? 'up' : 'down'
                const hasIp = /inet\s/.test(block)
                results.push({ name: ifName, exists, state, hasIp, inBridge: false, bridgeName: '', error: '' })
            }
        } else {
            // Linux: parse ip addr show output
            // Build a map of interface blocks
            const ifaceBlocks = new Map<string, string>()
            const blocks = output.split(/^\d+:\s+/m).filter(Boolean)
            for (const block of blocks) {
                const nameMatch = block.match(/^(\S+?)[@:]/)
                if (nameMatch) { ifaceBlocks.set(nameMatch[1], block) }
            }

            for (const ifName of interfaces) {
                const block = ifaceBlocks.get(ifName) ?? ''
                const exists = block.length > 0
                const stateMatch = block.match(/state\s+(\S+)/)
                const state = stateMatch ? stateMatch[1].toLowerCase() : (exists ? 'unknown' : '')
                const hasIp = /inet\s/.test(block)
                const inBridge = bridgeMap.has(ifName)
                const bridgeName = bridgeMap.get(ifName) ?? ''
                results.push({ name: ifName, exists, state, hasIp, inBridge, bridgeName, error: '' })
            }
        }

    } catch (err) {
        return { ok: false, message: `Validation failed on ${serverLabel}: ${(err as Error).message}`, results: [] }
    }

    return { ok: true, results, server: serverLabel }
})

// ── Validate bridges for pre-deploy checks ────────────────────────────────────

ipcMain.handle('clab-validate-bridges', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const bridges = Array.isArray(obj['bridges']) ? obj['bridges'] as string[] : []
    const serverId = String(obj['serverId'] ?? '').trim()

    if (!bridges.length) { return { ok: true, results: [] } }

    const server = serverId ? _getServerById(serverId) : _activeServer()
    const serverLabel = server.type === 'ssh' ? `${server.name ?? server.id} (${server.host})` : 'local'

    type BridgeResult = { name: string; exists: boolean; state: string; error: string }
    const results: BridgeResult[] = []

    try {
        // Check Linux bridges — run on the resolved server, not _activeServer
        const cmd = 'ip -br link show type bridge 2>/dev/null; virsh net-list --all 2>/dev/null; ovs-vsctl list-br 2>/dev/null'
        let output = ''
        if (server.type === 'local') {
            const result = await _spawnAsync('bash', ['-c', cmd], { timeout: 10_000 })
            output = result.stdout ?? ''
        } else {
            // SSH to the specific server
            output = await new Promise<string>(resolve => {
                const conn = new Client()
                const timer = setTimeout(() => { try { conn.end() } catch {} resolve('') }, 10_000)
                conn.on('error', () => { clearTimeout(timer); resolve('') })
                conn.on('ready', () => {
                    conn.exec(cmd, (err, stream) => {
                        if (err) { clearTimeout(timer); conn.end(); resolve(''); return }
                        let out = ''
                        stream.on('data', (d: Buffer) => { out += d.toString() })
                        stream.on('close', () => { clearTimeout(timer); conn.end(); resolve(out) })
                    })
                })
                conn.connect({ ..._ssh2ConnectOpts(server), readyTimeout: 8_000 })
            })
        }
        const allText = output.toLowerCase()

        for (const brName of bridges) {
            const exists = allText.includes(brName.toLowerCase())
            results.push({ name: brName, exists, state: exists ? 'found' : 'missing', error: '' })
        }
    } catch (err) {
        return { ok: false, message: `Bridge validation failed on ${serverLabel}: ${(err as Error).message}`, results: [] }
    }

    return { ok: true, results, server: serverLabel }
})

// ── List physical host interfaces on the active server ────────────────────────

const _VIRT_IFACE_RE = /^(lo|docker[0-9]*|br-|veth|clab|ovs-|virbr|flannel|cni|tunl|dummy|kube|bond0$)/

ipcMain.handle('clab-list-host-interfaces', async (_event, rawPayload?: unknown) => {
    const serverId = (rawPayload && typeof rawPayload === 'object') ? String((rawPayload as Record<string, unknown>)['serverId'] ?? '') : ''
    const server = serverId ? _getServerById(serverId) : _activeServer()
    console.log('[host-ifaces] Server:', server.id, server.type, server.type === 'ssh' ? server.host : 'local', serverId ? `(requested: ${serverId})` : '(active)')

    const parseInterfaces = (output: string): Array<{ name: string; state: string }> => {
        return output.trim().split('\n')
            .map(line => {
                const parts = line.trim().split(/\s+/)
                const name = (parts[0] ?? '').replace(/@.*$/, '')  // strip @if... suffix
                const state = (parts[1] ?? '').toLowerCase()
                return { name, state }
            })
            .filter(i => i.name && !_VIRT_IFACE_RE.test(i.name))
    }

    if (server.type === 'local') {
        try {
            if (process.platform === 'darwin') {
                // macOS: use ifconfig to list interfaces
                const result = spawnSync('ifconfig', ['-l'], {
                    stdio: 'pipe', encoding: 'utf8', timeout: 5_000,
                })
                if (result.status !== 0) {
                    return { ok: false, interfaces: [], message: 'ifconfig failed' }
                }
                const allNames = result.stdout.trim().split(/\s+/)
                const macVirtRe = /^(utun|awdl|llw|anpi|bridge|ap\d|gif|stf|ipsec|pktap|XHC|feth)/
                const interfaces: Array<{ name: string; state: string }> = []
                for (const name of allNames) {
                    if (_VIRT_IFACE_RE.test(name) || macVirtRe.test(name)) { continue }
                    const info = spawnSync('ifconfig', [name], { stdio: 'pipe', encoding: 'utf8', timeout: 2_000 })
                    const statusMatch = info.stdout?.match(/status:\s*(\w+)/)
                    const state = statusMatch ? statusMatch[1] : (info.stdout?.includes('RUNNING') ? 'up' : 'down')
                    interfaces.push({ name, state })
                }
                return { ok: true, interfaces }
            }
            // Linux: use ip command
            const result = spawnSync('ip', ['-br', 'link', 'show'], {
                stdio: 'pipe', encoding: 'utf8', timeout: 5_000,
            })
            if (result.status !== 0) {
                return { ok: false, interfaces: [], message: result.stderr?.trim() || 'ip command failed' }
            }
            return { ok: true, interfaces: parseInterfaces(result.stdout) }
        } catch (err) {
            return { ok: false, interfaces: [], message: (err as Error).message }
        }
    }

    // Remote server via SSH
    if (!server.host || !server.username) {
        return { ok: false, interfaces: [], message: 'Host/username not set' }
    }

    return new Promise(resolve => {
        const conn = new Client()
        const timeout = setTimeout(() => {
            conn.end()
            resolve({ ok: false, interfaces: [], message: 'Timeout' })
        }, 8_000)

        conn.on('ready', () => {
            conn.exec('ip -br link show', (err, stream) => {
                if (err) { clearTimeout(timeout); conn.end(); resolve({ ok: false, interfaces: [], message: err.message }); return }
                let data = ''
                stream.on('data', (chunk: Buffer) => { data += chunk.toString() })
                stream.on('close', () => {
                    clearTimeout(timeout)
                    conn.end()
                    resolve({ ok: true, interfaces: parseInterfaces(data) })
                })
            })
        })
        conn.on('error', (err) => { clearTimeout(timeout); resolve({ ok: false, interfaces: [], message: err.message }) })
        conn.connect({
            ..._ssh2ConnectOpts(server),
            readyTimeout: 5_000,
        })
    })
})

const CLAB_BIN_DIR = path.join(os.homedir(), '.tlink-netops', 'bin')
const CLAB_BIN_PATH = path.join(CLAB_BIN_DIR, 'containerlab')
const CLAB_DOCKER_IMAGE = 'ghcr.io/srl-labs/clab'

type ClabMode = 'binary' | 'docker-image' | 'none'

async function _whichBinAsync (name: string): Promise<boolean> {
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which'
        const r = await _spawnAsync(cmd, [name], { timeout: 3_000 })
        return r.status === 0
    } catch { return false }
}

async function _detectClabMode (): Promise<{ mode: ClabMode; bin: string }> {
    // 1. App-managed binary (auto-installed, Linux only — no native binary on macOS/Windows)
    if (process.platform === 'linux' && fs.existsSync(CLAB_BIN_PATH)) {
        return { mode: 'binary', bin: CLAB_BIN_PATH }
    }
    // 2. System-installed clab (Linux/macOS PATH or Windows WSL)
    if (await _whichBinAsync('clab')) { return { mode: 'binary', bin: 'clab' } }
    // 3. System-installed containerlab
    if (await _whichBinAsync('containerlab')) { return { mode: 'binary', bin: 'containerlab' } }
    // 4. Docker image available (macOS, Windows, or Linux fallback)
    try {
        const imgCheck = await _spawnAsync('docker', ['image', 'inspect', CLAB_DOCKER_IMAGE], { timeout: 5_000 })
        if (imgCheck.status === 0) { return { mode: 'docker-image', bin: '' } }
    } catch { /* ignore */ }
    return { mode: 'none', bin: '' }
}

function _buildClabDockerCommand (clabArgs: string, filePath: string): string {
    const labDir = path.dirname(filePath)

    if (process.platform === 'win32') {
        // Windows: Docker Desktop uses //var/run/docker.sock internally via WSL2
        // Volume mounts use Windows-style paths — Docker Desktop translates automatically
        return [
            'docker run --rm -it --privileged',
            '--network host',
            '-v //var/run/docker.sock:/var/run/docker.sock',
            '--pid="host"',
            `-v "${labDir}":"${labDir.replace(/\\/g, '/')}"`,
            `-w "${labDir.replace(/\\/g, '/')}"`,
            CLAB_DOCKER_IMAGE,
            `containerlab ${clabArgs}`,
        ].join(' ')
    }

    // macOS: no /var/run/netns (doesn't exist on macOS)
    if (process.platform === 'darwin') {
        return [
            'docker run --rm -it --privileged',
            '--network host',
            '-v /var/run/docker.sock:/var/run/docker.sock',
            '--pid="host"',
            `-v "${labDir}":"${labDir}"`,
            `-w "${labDir}"`,
            CLAB_DOCKER_IMAGE,
            `containerlab ${clabArgs}`,
        ].join(' ')
    }

    // Linux: full mount suite including /var/run/netns
    return [
        'docker run --rm -it --privileged',
        '--network host',
        '-v /var/run/docker.sock:/var/run/docker.sock',
        '-v /var/run/netns:/var/run/netns',
        '--pid="host"',
        `-v "${labDir}":"${labDir}"`,
        `-w "${labDir}"`,
        CLAB_DOCKER_IMAGE,
        `containerlab ${clabArgs}`,
    ].join(' ')
}

/**
 * Build a containerlab docker command for a remote server.
 * Uses DOCKER_HOST=ssh://... so Docker talks to the remote daemon while
 * the `docker run` command is executed locally.
 *
 * Cross-platform:
 *   macOS/Linux: ENV=val docker run ...
 *   Windows:     set ENV=val && docker run ...
 */
function _buildRemoteClabDockerCommand (clabArgs: string, filePath: string, server: ClabServerProfile): string {
    const labDir = path.posix.dirname(filePath) // remote paths are always Linux
    const portPart = server.port && server.port !== 22 ? ':' + server.port : ''
    const dockerHost = `ssh://${server.username}@${server.host}${portPart}`
    const isWin = process.platform === 'win32'

    // Collect env vars to set before the docker command
    const envVars: Array<{ key: string; value: string }> = [
        { key: 'DOCKER_HOST', value: dockerHost },
    ]

    if (server.password) {
        _ensureAskpass(server.password)
        envVars.push(
            { key: 'TLINK_SSH_PASSWORD', value: server.password },
            { key: 'SSH_ASKPASS', value: _ASKPASS_SCRIPT },
            { key: 'SSH_ASKPASS_REQUIRE', value: 'force' },
        )
        if (!isWin) {
            envVars.push({ key: 'DISPLAY', value: process.env['DISPLAY'] || ':0' })
        }
    }

    // Build env prefix per platform
    let envPrefix: string
    if (isWin) {
        // Windows cmd.exe: set VAR=val && set VAR2=val2 && command
        envPrefix = envVars.map(e => `set "${e.key}=${e.value}"`).join(' && ') + ' && '
    } else {
        // macOS/Linux: VAR="val" VAR2="val2" command
        envPrefix = envVars.map(e => `${e.key}="${e.value}"`).join(' ') + ' '
    }

    // Docker socket path differs on Windows (Docker Desktop WSL2)
    const dockerSock = isWin ? '//var/run/docker.sock' : '/var/run/docker.sock'

    const dockerArgs = [
        'docker run --rm -it --privileged',
        '--network host',
        `-v ${dockerSock}:/var/run/docker.sock`,
    ]
    // /var/run/netns doesn't exist on Windows or macOS
    if (process.platform === 'linux') {
        dockerArgs.push('-v /var/run/netns:/var/run/netns')
    }
    dockerArgs.push(
        '--pid="host"',
        `-v "${labDir}":"${labDir}"`,
        `-w "${labDir}"`,
        CLAB_DOCKER_IMAGE,
        `containerlab ${clabArgs}`,
    )

    return envPrefix + dockerArgs.join(' ')
}

async function _isDockerInstalled (): Promise<boolean> {
    if (await _whichBinAsync('docker')) { return true }
    // macOS: Docker Desktop installs here even if not in PATH
    if (process.platform === 'darwin') {
        return fs.existsSync('/Applications/Docker.app') || fs.existsSync('/usr/local/bin/docker')
    }
    // Windows: common install paths
    if (process.platform === 'win32') {
        return fs.existsSync('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe')
    }
    return false
}

ipcMain.handle('clab-check-prereqs', async () => {
    const dockerCheck = await _spawnAsync('docker', ['info'], { timeout: 15_000, env: _dockerEnv() as NodeJS.ProcessEnv })
    const docker = dockerCheck.status === 0

    // ── Remote server ────────────────────────────────────────────────────
    if (_isRemote()) {
        const server = _activeServer()
        const label = server.name || server.host || 'remote'
        if (!docker) {
            const errMsg = dockerCheck.stderr?.trim()?.split('\n').pop() || 'Cannot connect'
            return {
                ok: false, docker: false, dockerInstalled: false,
                dockerMessage: `Cannot reach Docker on ${label}: ${errMsg}`,
                clab: false, clabMessage: 'Check Docker connection first',
            }
        }

        // Docker works → also test containerlab via docker image
        const clabTest = await _spawnAsync('docker', ['run', '--rm', CLAB_DOCKER_IMAGE, 'containerlab', 'version'], {
            timeout: 15_000, env: _dockerEnv() as NodeJS.ProcessEnv,
        })
        const clab = clabTest.status === 0
        const clabMessage = clab
            ? `containerlab via Docker on ${label}`
            : `containerlab image not found on ${label} — click "Install"`

        return { ok: docker && clab, docker, dockerInstalled: true, dockerMessage: `Docker running on ${label}`, clab, clabMessage }
    }

    // ── Local server ─────────────────────────────────────────────────────
    const dockerInstalled = docker || await _isDockerInstalled()

    let dockerMessage: string
    if (docker) {
        dockerMessage = 'Docker is running'
    } else if (dockerInstalled) {
        dockerMessage = 'Docker is installed but not running — click "Start Docker" to launch it'
    } else {
        dockerMessage = 'Docker is not installed'
    }

    let clab = false
    let clabMessage = ''
    const clabMode = await _detectClabMode()

    if (clabMode.mode === 'binary') {
        const vCheck = await _spawnAsync(clabMode.bin, ['version'], { timeout: 5_000 })
        clab = true
        clabMessage = vCheck.stdout?.trim().split('\n')[0] || `containerlab (${clabMode.bin})`
    } else if (clabMode.mode === 'docker-image') {
        clab = true
        clabMessage = `using Docker image ${CLAB_DOCKER_IMAGE}`
    } else {
        clabMessage = 'containerlab not found — click "Install" to set up automatically'
    }

    return { ok: docker && clab, docker, dockerInstalled, dockerMessage, clab, clabMessage }
})

ipcMain.handle('clab-start-docker', async () => {
    // Remote server — cannot start Docker from here
    if (_isRemote()) {
        const server = _activeServer()
        return { ok: false, message: `Start Docker on the remote host "${server.name || server.host}" manually, then re-check.` }
    }

    try {
        if (process.platform === 'darwin') {
            // Try Docker Desktop first, then OrbStack, then Colima
            if (fs.existsSync('/Applications/Docker.app')) {
                spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' })
                return { ok: true, message: 'Starting Docker Desktop — wait a moment then try Deploy again' }
            }
            if (fs.existsSync('/Applications/OrbStack.app')) {
                spawnSync('open', ['-a', 'OrbStack'], { stdio: 'ignore' })
                return { ok: true, message: 'Starting OrbStack — wait a moment then try Deploy again' }
            }
            const colimaCheck = spawnSync('which', ['colima'], { stdio: 'ignore', timeout: 3_000 })
            if (colimaCheck.status === 0) {
                _spawnDetached('colima', ['start'])
                return { ok: true, message: 'Starting Colima — wait a moment then try Deploy again' }
            }
            return { ok: false, message: 'No Docker runtime found. Install Docker Desktop from https://docker.com/products/docker-desktop' }
        }

        if (process.platform === 'win32') {
            if (fs.existsSync('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe')) {
                _spawnDetached('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe', [])
                return { ok: true, message: 'Starting Docker Desktop — wait a moment then try Deploy again' }
            }
            return { ok: false, message: 'Docker Desktop not found. Install from https://docker.com/products/docker-desktop' }
        }

        // Linux: try systemctl
        const systemctlCheck = spawnSync('which', ['systemctl'], { stdio: 'ignore', timeout: 3_000 })
        if (systemctlCheck.status === 0) {
            const startResult = spawnSync('sudo', ['systemctl', 'start', 'docker'], {
                stdio: 'pipe', encoding: 'utf8', timeout: 15_000,
            })
            if (startResult.status === 0) {
                return { ok: true, message: 'Docker service started — try Deploy again' }
            }
            return { ok: false, message: 'Failed to start Docker service. Run: sudo systemctl start docker' }
        }

        return { ok: false, message: 'Could not start Docker. Start it manually and try again.' }
    } catch (err) {
        return { ok: false, message: `Failed to start Docker: ${(err as Error).message}` }
    }
})

ipcMain.handle('clab-auto-install', async () => {
    try {
        // ── macOS / Windows: pull containerlab Docker image (no native binary) ──
        if (process.platform === 'darwin' || process.platform === 'win32') {
            const dockerCheck = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5_000, env: _dockerEnv() })
            if (dockerCheck.status !== 0) {
                return { ok: false, message: 'Docker must be running first. Start Docker, then try Install again.' }
            }

            const pullResult = spawnSync('docker', ['pull', CLAB_DOCKER_IMAGE], {
                stdio: 'pipe', encoding: 'utf8', timeout: 180_000, env: _dockerEnv(),
            })

            if (pullResult.status === 0) {
                return { ok: true, message: `Pulled ${CLAB_DOCKER_IMAGE} — containerlab runs via Docker on macOS` }
            }

            return { ok: false, message: `Failed to pull ${CLAB_DOCKER_IMAGE}: ${pullResult.stderr?.trim().split('\n').pop() || 'docker pull error'}` }
        }

        // ── Linux: download binary from GitHub releases ────────────────────
        const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'

        // Step 1: Get latest release tag
        const tagResult = spawnSync('curl', [
            '-sL', '-H', 'Accept: application/json',
            'https://api.github.com/repos/srl-labs/containerlab/releases/latest',
        ], { encoding: 'utf8', timeout: 15_000 })

        if (tagResult.status !== 0) {
            return { ok: false, message: 'Failed to check latest version. Check your internet connection.' }
        }

        let version = ''
        try {
            const release = JSON.parse(tagResult.stdout)
            version = String(release.tag_name ?? '').replace(/^v/, '')
        } catch {
            return { ok: false, message: 'Failed to parse GitHub release info' }
        }

        if (!version) {
            return { ok: false, message: 'Could not determine latest containerlab version' }
        }

        // Step 2: Download the tarball
        const downloadUrl = `https://github.com/srl-labs/containerlab/releases/download/v${version}/containerlab_${version}_linux_${arch}.tar.gz`
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlink-clab-install-'))
        const tmpFile = path.join(tmpDir, 'containerlab.tar.gz')

        const dlResult = spawnSync('curl', ['-sL', '-o', tmpFile, downloadUrl], {
            encoding: 'utf8', timeout: 120_000,
        })

        if (dlResult.status !== 0) {
            fs.rm(tmpDir, { recursive: true, force: true }, () => undefined)
            return { ok: false, message: `Download failed from ${downloadUrl}` }
        }

        // Verify download (Linux tar.gz is ~14-16 MB)
        if (!fs.existsSync(tmpFile)) {
            fs.rm(tmpDir, { recursive: true, force: true }, () => undefined)
            return { ok: false, message: 'Download file not found after curl completed' }
        }

        const stat = fs.statSync(tmpFile)
        if (stat.size < 100_000) {
            fs.rm(tmpDir, { recursive: true, force: true }, () => undefined)
            return { ok: false, message: `Download failed — received ${stat.size} bytes (expected ~15 MB). URL: ${downloadUrl}` }
        }

        // Step 3: Extract the binary
        fs.mkdirSync(CLAB_BIN_DIR, { recursive: true })
        const tarResult = spawnSync('tar', ['-xzf', tmpFile, '-C', CLAB_BIN_DIR, 'containerlab'], {
            encoding: 'utf8', timeout: 30_000,
        })

        fs.rm(tmpDir, { recursive: true, force: true }, () => undefined)

        if (tarResult.status !== 0) {
            return { ok: false, message: `Failed to extract: ${tarResult.stderr?.trim() || 'tar error'}` }
        }

        // Step 4: Make executable
        fs.chmodSync(CLAB_BIN_PATH, 0o755)

        // Verify
        const verifyResult = spawnSync(CLAB_BIN_PATH, ['version'], { encoding: 'utf8', timeout: 5_000, stdio: 'pipe' })
        if (verifyResult.status === 0) {
            const vLine = verifyResult.stdout?.trim().split('\n')[0] || `containerlab v${version}`
            return { ok: true, message: `Installed ${vLine} to ${CLAB_BIN_DIR}` }
        }

        return { ok: true, message: `Installed containerlab v${version} to ${CLAB_BIN_DIR}` }
    } catch (err) {
        return { ok: false, message: `Install failed: ${(err as Error).message}` }
    }
})

ipcMain.handle('clab-check-images', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { images: [], hostArch: '' }
    }
    const obj = rawPayload as Record<string, unknown>
    const imageNames = obj['images']
    if (!Array.isArray(imageNames)) { return { images: [], hostArch: '' } }

    // Detect host architecture (what Docker's VM is running)
    const hostArchResult = spawnSync('docker', ['info', '--format', '{{.Architecture}}'], {
        stdio: 'pipe', encoding: 'utf8', timeout: 15_000, env: _dockerEnv(),
    })
    const hostArch = hostArchResult.stdout?.trim() || process.arch  // e.g. "aarch64", "x86_64"

    const normalizeArch = (a: string): string => {
        const lower = a.toLowerCase()
        if (lower === 'aarch64' || lower === 'arm64') { return 'arm64' }
        if (lower === 'x86_64' || lower === 'amd64') { return 'amd64' }
        return lower
    }

    const dockerEnv = _dockerEnv()
    // Helper: list all tags for a given repo name (increased timeout for remote SSH)
    const _listRepoTags = (repoName: string): string[] => {
        const ls = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}', repoName], {
            stdio: 'pipe', encoding: 'utf8', timeout: 15_000, env: dockerEnv,
        })
        if (ls.status !== 0 || !ls.stdout.trim()) { return [] }
        return ls.stdout.trim().split('\n').filter(t => t && !t.endsWith(':<none>'))
    }

    const results: Array<{ name: string; available: boolean; size: string; arch: string; archMismatch: boolean; actualTag?: string; alternativeTags?: string[] }> = []
    for (const img of imageNames) {
        const name = String(img)
        const repoName = name.split(':')[0]
        const check = spawnSync('docker', ['image', 'inspect', name, '--format', '{{.Size}}||{{.Architecture}}||{{.Os}}'], {
            stdio: 'pipe', encoding: 'utf8', timeout: 15_000, env: dockerEnv,
        })
        if (check.status === 0) {
            // Exact tag found
            const parts = check.stdout.trim().split('||')
            const sizeBytes = parseInt(parts[0], 10)
            const sizeMB = isNaN(sizeBytes) ? '?' : `${(sizeBytes / 1_048_576).toFixed(0)} MB`
            const imageArch = (parts[1] ?? '').trim()
            const archMismatch = !!imageArch && normalizeArch(imageArch) !== normalizeArch(hostArch)
            // Also check if other tags of the same repo exist
            const allTags = _listRepoTags(repoName)
            const otherTags = allTags.length > 1 ? allTags : undefined
            results.push({ name, available: true, size: sizeMB, arch: imageArch, archMismatch, alternativeTags: otherTags })
        } else {
            // Exact tag not found — check if any image with same repo name exists
            const allTags = _listRepoTags(repoName)
            if (allTags.length > 0) {
                // Use the first available tag as the match
                const firstTag = allTags[0]
                const inspectFirst = spawnSync('docker', ['image', 'inspect', firstTag, '--format', '{{.Size}}||{{.Architecture}}'], {
                    stdio: 'pipe', encoding: 'utf8', timeout: 15_000, env: dockerEnv,
                })
                let fSize = ''
                let fArch = ''
                if (inspectFirst.status === 0) {
                    const fp = inspectFirst.stdout.trim().split('||')
                    const sb = parseInt(fp[0], 10)
                    fSize = isNaN(sb) ? '?' : `${(sb / 1_048_576).toFixed(0)} MB`
                    fArch = (fp[1] ?? '').trim()
                }
                const archMismatch = !!fArch && normalizeArch(fArch) !== normalizeArch(hostArch)
                results.push({
                    name: firstTag,
                    available: true,
                    size: fSize,
                    arch: fArch,
                    archMismatch,
                    actualTag: firstTag,
                    alternativeTags: allTags.length > 1 ? allTags : undefined,
                })
            } else {
                results.push({ name, available: false, size: '', arch: '', archMismatch: false })
            }
        }
    }
    return { images: results, hostArch }
})

/** Send docker progress message to all renderer windows */
function _sendDockerProgress (msg: string): void {
    for (const [, win] of windows) {
        try { win.webContents.send('docker-progress', msg) } catch { /* ignore */ }
    }
}

ipcMain.handle('clab-pull-image', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const imageName = String(obj['image'] ?? '').trim()
    if (!imageName) { return { ok: false, message: 'No image name provided' } }

    return new Promise<{ ok: boolean; message: string }>(resolve => {
        const proc = spawn('docker', ['pull', imageName], {
            stdio: 'pipe', env: _dockerEnv(),
        })

        let lastLine = ''
        const timeout = setTimeout(() => {
            proc.kill()
            resolve({ ok: false, message: 'Pull timed out after 10 minutes' })
        }, 600_000)

        const handleData = (chunk: Buffer) => {
            const lines = chunk.toString().split(/\r?\n/).filter(Boolean)
            for (const line of lines) {
                lastLine = line
                _sendDockerProgress(line)
            }
        }

        proc.stdout?.on('data', handleData)
        proc.stderr?.on('data', handleData)

        proc.on('close', (code) => {
            clearTimeout(timeout)
            _sendDockerProgress('')  // clear progress
            if (code === 0) {
                resolve({ ok: true, message: `Pulled ${imageName}` })
            } else {
                resolve({ ok: false, message: lastLine || 'pull failed' })
            }
        })

        proc.on('error', (err) => {
            clearTimeout(timeout)
            _sendDockerProgress('')
            resolve({ ok: false, message: `Pull failed: ${err.message}` })
        })
    })
})

ipcMain.handle('clab-load-image', async (_event, rawPayload: unknown) => {
    // Accept optional imageName hint from the renderer (used as docker import tag + auto-tag target)
    const importTag = (rawPayload && typeof rawPayload === 'object')
        ? String((rawPayload as Record<string, unknown>)['imageName'] ?? '').trim()
        : ''

    /** If the loaded image name differs from what the app expects, auto-tag it.
     *  Also applies well-known aliases (e.g. arm64v8/crpd:X → crpd:latest). */
    const _autoTag = (loadedName: string): string => {
        if (!loadedName) { return loadedName }

        const tagsToApply: string[] = []
        // Auto-detect well-known image families and tag to the :latest alias
        // e.g. "arm64v8/crpd:25.4R1.12" → also tag as "crpd:latest"
        const wellKnown: Array<{ pattern: RegExp; tag: string }> = [
            { pattern: /\bcrpd[:/]/i,                         tag: 'crpd:latest' },
            { pattern: /\bsonic-vs[:/]/i,                     tag: 'docker-sonic-vs:latest' },
            { pattern: /\bsrlinux[:/]/i,                      tag: 'ghcr.io/nokia/srlinux:latest' },
            { pattern: /\bceos[:/]/i,                          tag: 'ceos:latest' },
            { pattern: /\bvr-vqfx[:/]/i,                      tag: 'vrnetlab/vr-vqfx:latest' },
            { pattern: /\bvr-vjunosswitch[:/]/i,              tag: 'vrnetlab/vr-vjunosswitch:latest' },
            { pattern: /\bvr-vjunosrouter[:/]/i,              tag: 'vrnetlab/vr-vjunosrouter:latest' },
        ]
        let matchedWellKnown = false
        for (const wk of wellKnown) {
            if (wk.pattern.test(loadedName) && loadedName !== wk.tag && !tagsToApply.includes(wk.tag)) {
                tagsToApply.push(wk.tag)
                matchedWellKnown = true
            }
        }
        // Only apply the renderer's importTag hint if the loaded image didn't match
        // any well-known family — prevents cross-tagging (e.g. cRPD tagged as SONiC)
        if (importTag && !matchedWellKnown && loadedName !== importTag) {
            tagsToApply.push(importTag)
        }

        let primaryTag = loadedName
        for (const tag of tagsToApply) {
            const tagResult = spawnSync('docker', ['tag', loadedName, tag], {
                stdio: 'pipe', encoding: 'utf8', timeout: 10_000, env: _dockerEnv(),
            })
            if (tagResult.status === 0 && primaryTag === loadedName) {
                primaryTag = tag  // Return first successful tag as the primary name
            }
        }
        return primaryTag
    }

    const { filePaths, canceled } = await dialog.showOpenDialog({
        title: 'Load Docker Image',
        filters: [
            { name: 'Docker Image', extensions: ['gz', 'tar', 'tgz', 'img', 'xz', 'bz2'] },
            { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
    })
    if (canceled || !filePaths[0]) {
        return { ok: false, message: 'Cancelled', imageName: '' }
    }

    const filePath = filePaths[0]
    try {
        // ── Attempt 1: docker load (works for Docker save archives) ──────
        const loadResult = await new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
            const proc = spawn('docker', ['load', '-i', filePath], {
                stdio: 'pipe', env: _dockerEnv(),
            })
            let stdout = '', stderr = ''
            const timer = setTimeout(() => { proc.kill(); resolve({ status: 1, stdout, stderr: 'Timeout after 10 min' }) }, 600_000)

            proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString()
                stdout += text
                for (const line of text.split(/\r?\n/).filter(Boolean)) {
                    _sendDockerProgress(line)
                }
            })
            proc.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString()
                stderr += text
                for (const line of text.split(/\r?\n/).filter(Boolean)) {
                    _sendDockerProgress(line)
                }
            })
            proc.on('close', (code) => { clearTimeout(timer); resolve({ status: code ?? 1, stdout, stderr }) })
            proc.on('error', (err) => { clearTimeout(timer); resolve({ status: 1, stdout, stderr: err.message }) })
        })

        _sendDockerProgress('')  // clear progress
        if (loadResult.status === 0) {
            const output = loadResult.stdout?.trim() || ''
            const match = output.match(/Loaded image:\s*(.+)/i)
            const rawName = match ? match[1].trim() : ''
            const imageName = _autoTag(rawName)
            return { ok: true, message: output || 'Image loaded', imageName }
        }

        const loadErr = loadResult.stderr?.trim() || ''

        // ── Attempt 2: Fix broken symlinks (Juniper .tgz files) ─────────
        // Juniper images have layer.tar → .HASH.tar symlinks where the
        // actual file is named HASH.tar (without the dot prefix).
        // Extract, replace symlinks with copies, re-pack, and docker load.
        if (loadErr.includes('no target for symlink') || loadErr.includes('symlink')) {
            const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlink-imgfix-'))
            try {
                // Determine if .tgz (gzip) or plain .tar
                const isGzip = filePath.match(/\.(tgz|gz)$/i)
                const tarFlags = isGzip ? 'xzf' : 'xf'
                const extractResult = spawnSync('tar', [tarFlags, filePath, '-C', fixDir], {
                    stdio: 'pipe', encoding: 'utf8', timeout: 120_000,
                })
                if (extractResult.status !== 0) {
                    throw new Error(`Extract failed: ${extractResult.stderr?.trim() || 'unknown error'}`)
                }

                // Find and fix symlinked layer.tar files
                const fixSymlinks = (dir: string): void => {
                    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const entryPath = path.join(dir, entry.name)
                        if (entry.isDirectory()) {
                            fixSymlinks(entryPath)
                        } else if (entry.isSymbolicLink()) {
                            const linkTarget = fs.readlinkSync(entryPath)
                            // Try resolving relative to the archive root (strip leading dot)
                            const targetName = path.basename(linkTarget).replace(/^\./, '')
                            const candidatePaths = [
                                path.resolve(path.dirname(entryPath), linkTarget),       // original target
                                path.join(fixDir, targetName),                            // root without dot
                                path.join(fixDir, path.basename(linkTarget)),             // root with dot
                            ]
                            let resolved = false
                            for (const candidate of candidatePaths) {
                                if (fs.existsSync(candidate) && !fs.lstatSync(candidate).isSymbolicLink()) {
                                    fs.unlinkSync(entryPath)
                                    fs.copyFileSync(candidate, entryPath)
                                    resolved = true
                                    break
                                }
                            }
                            if (!resolved) {
                                throw new Error(`Cannot resolve symlink: ${entry.name} → ${linkTarget}`)
                            }
                        }
                    }
                }
                fixSymlinks(fixDir)

                // Re-pack and docker load
                const fixedTar = path.join(fixDir, '__fixed.tar')
                const packResult = spawnSync('tar', ['cf', fixedTar, '-C', fixDir, '.'], {
                    stdio: 'pipe', encoding: 'utf8', timeout: 120_000,
                })
                if (packResult.status !== 0) {
                    throw new Error(`Repack failed: ${packResult.stderr?.trim() || 'unknown error'}`)
                }

                const reloadResult = spawnSync('docker', ['load', '-i', fixedTar], {
                    stdio: 'pipe', encoding: 'utf8', timeout: 600_000, env: _dockerEnv(),
                })
                if (reloadResult.status === 0) {
                    const output = reloadResult.stdout?.trim() || ''
                    const match = output.match(/Loaded image:\s*(.+)/i)
                    const rawName = match ? match[1].trim() : ''
                    const imageName = _autoTag(rawName)
                    return { ok: true, message: `${output} (symlink fix applied)`, imageName }
                }
                throw new Error(reloadResult.stderr?.trim() || 'docker load failed after symlink fix')
            } catch (fixErr) {
                // Fall through to docker import
                console.error('Symlink fix failed:', (fixErr as Error).message)
            } finally {
                fs.rm(fixDir, { recursive: true, force: true }, () => undefined)
            }
        }

        // ── Attempt 3: docker import (works for filesystem tarballs / .img.gz) ──
        // Derive a tag: use the hint from the renderer, or fall back to filename
        const tag = importTag
            || path.basename(filePath)
                .replace(/\.(img|tar|docker|tgz)?\.(gz|xz|bz2)$/i, '')
                .replace(/\.(img|tar|tgz)$/i, '')
                + ':latest'

        const importResult = spawnSync('docker', ['import', filePath, tag], {
            stdio: 'pipe', encoding: 'utf8', timeout: 600_000, env: _dockerEnv(),
        })
        if (importResult.status === 0) {
            const sha = importResult.stdout?.trim().slice(0, 20) || ''
            return { ok: true, message: `Imported as ${tag} (${sha})`, imageName: tag }
        }

        // All attempts failed
        const importErr = importResult.stderr?.trim().split('\n').pop() || ''
        return {
            ok: false,
            message: `docker load: ${loadErr.split('\n').pop() || 'failed'}. docker import: ${importErr || 'failed'}`,
            imageName: '',
        }
    } catch (err) {
        return { ok: false, message: `Load failed: ${(err as Error).message}`, imageName: '' }
    }
})

// ── Docker Image Manager ────────────────────────────────────────────────────

ipcMain.handle('docker-list-images', async () => {
    try {
        const listResult = spawnSync('docker', [
            'images', '--format', '{{.Repository}}:{{.Tag}}||{{.ID}}||{{.Size}}||{{.CreatedSince}}',
        ], { stdio: 'pipe', encoding: 'utf8', timeout: 10_000, env: _dockerEnv() })

        if (listResult.status !== 0) {
            return { images: [], hostArch: '', error: listResult.stderr?.trim() || 'docker images failed' }
        }

        // Detect host architecture
        const hostArchResult = spawnSync('docker', ['info', '--format', '{{.Architecture}}'], {
            stdio: 'pipe', encoding: 'utf8', timeout: 5_000, env: _dockerEnv(),
        })
        const hostArch = hostArchResult.stdout?.trim() || process.arch

        const normalizeArch = (a: string): string => {
            const lower = a.toLowerCase()
            if (lower === 'aarch64' || lower === 'arm64') { return 'arm64' }
            if (lower === 'x86_64' || lower === 'amd64') { return 'amd64' }
            return lower
        }

        const lines = listResult.stdout.trim().split('\n').filter(Boolean)
        const images: Array<{ name: string; id: string; size: string; created: string; arch: string; archMismatch: boolean }> = []

        for (const line of lines) {
            const [name, id, size, created] = line.split('||')
            if (!name || name === '<none>:<none>') { continue }

            // Get architecture
            const inspectResult = spawnSync('docker', ['inspect', name, '--format', '{{.Architecture}}'], {
                stdio: 'pipe', encoding: 'utf8', timeout: 3_000, env: _dockerEnv(),
            })
            const arch = inspectResult.stdout?.trim() || ''
            const archMismatch = !!arch && normalizeArch(arch) !== normalizeArch(hostArch)

            images.push({ name: name.trim(), id: (id ?? '').trim().slice(0, 12), size: (size ?? '').trim(), created: (created ?? '').trim(), arch, archMismatch })
        }

        return { images, hostArch }
    } catch (err) {
        return { images: [], hostArch: '', error: (err as Error).message }
    }
})

ipcMain.handle('docker-search', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload', results: [] }
    }
    const term = String((rawPayload as Record<string, unknown>)['term'] ?? '').trim()
    if (!term) { return { ok: false, message: 'No search term', results: [] } }
    try {
        const result = spawnSync('docker', [
            'search', '--format', '{{.Name}}\t{{.Description}}\t{{.StarCount}}\t{{.IsOfficial}}', '--limit', '25', term,
        ], { stdio: 'pipe', encoding: 'utf8', timeout: 30_000, env: _dockerEnv() })
        if (result.status !== 0) {
            return { ok: false, message: result.stderr?.trim() || 'search failed', results: [] }
        }
        const lines = (result.stdout || '').trim().split('\n').filter(Boolean)
        const results = lines.map(line => {
            const parts = line.split('\t')
            return {
                name: parts[0] || '',
                description: parts[1] || '',
                stars: parseInt(parts[2] || '0', 10),
                official: parts[3] === '[OK]',
            }
        })
        return { ok: true, results }
    } catch (err) {
        return { ok: false, message: `Search failed: ${(err as Error).message}`, results: [] }
    }
})

ipcMain.handle('docker-system-df', async () => {
    try {
        const result = spawnSync('docker', ['system', 'df', '--format', '{{.Type}}\t{{.TotalCount}}\t{{.Size}}\t{{.Reclaimable}}'], {
            stdio: 'pipe', encoding: 'utf8', timeout: 15_000, env: _dockerEnv(),
        })
        if (result.status !== 0) {
            return { ok: false, message: result.stderr?.trim() || 'docker system df failed' }
        }
        const lines = (result.stdout || '').trim().split('\n').filter(Boolean)
        const rows: Array<{ type: string; count: string; size: string; reclaimable: string }> = []
        for (const line of lines) {
            const parts = line.split('\t')
            if (parts.length >= 4) {
                rows.push({ type: parts[0], count: parts[1], size: parts[2], reclaimable: parts[3] })
            }
        }
        return { ok: true, rows }
    } catch (err) {
        return { ok: false, message: `Failed: ${(err as Error).message}` }
    }
})

ipcMain.handle('docker-delete-image', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const imageName = String((rawPayload as Record<string, unknown>)['image'] ?? '').trim()
    if (!imageName) { return { ok: false, message: 'No image name provided' } }

    try {
        // Try normal delete first
        let result = spawnSync('docker', ['rmi', imageName], {
            stdio: 'pipe', encoding: 'utf8', timeout: 30_000, env: _dockerEnv(),
        })
        if (result.status === 0) {
            return { ok: true, message: `Removed ${imageName}` }
        }
        // If failed due to container using it, retry with --force
        const errMsg = result.stderr?.trim() || ''
        if (errMsg.includes('must be forced') || errMsg.includes('conflict')) {
            result = spawnSync('docker', ['rmi', '--force', imageName], {
                stdio: 'pipe', encoding: 'utf8', timeout: 30_000, env: _dockerEnv(),
            })
            if (result.status === 0) {
                return { ok: true, message: `Force removed ${imageName}` }
            }
        }
        return { ok: false, message: result.stderr?.trim().split('\n').pop() || 'delete failed' }
    } catch (err) {
        return { ok: false, message: `Delete failed: ${(err as Error).message}` }
    }
})

ipcMain.handle('docker-delete-images', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload', results: [] }
    }
    const images = (rawPayload as Record<string, unknown>)['images']
    if (!Array.isArray(images) || images.length === 0) {
        return { ok: false, message: 'No images provided', results: [] }
    }
    const results: Array<{ image: string; ok: boolean; message: string }> = []
    for (const img of images) {
        const name = String(img).trim()
        if (!name) { continue }
        try {
            let result = spawnSync('docker', ['rmi', name], {
                stdio: 'pipe', encoding: 'utf8', timeout: 30_000, env: _dockerEnv(),
            })
            if (result.status === 0) {
                results.push({ image: name, ok: true, message: `Removed ${name}` })
            } else {
                // Retry with --force if container is using the image
                const errMsg = result.stderr?.trim() || ''
                if (errMsg.includes('must be forced') || errMsg.includes('conflict')) {
                    result = spawnSync('docker', ['rmi', '--force', name], {
                        stdio: 'pipe', encoding: 'utf8', timeout: 30_000, env: _dockerEnv(),
                    })
                    if (result.status === 0) {
                        results.push({ image: name, ok: true, message: `Force removed ${name}` })
                    } else {
                        results.push({ image: name, ok: false, message: result.stderr?.trim().split('\n').pop() || 'delete failed' })
                    }
                } else {
                    results.push({ image: name, ok: false, message: errMsg.split('\n').pop() || 'delete failed' })
                }
            }
        } catch (err) {
            results.push({ image: name, ok: false, message: `Delete failed: ${(err as Error).message}` })
        }
    }
    const failed = results.filter(r => !r.ok)
    if (failed.length === 0) {
        return { ok: true, message: `Removed ${results.length} image(s)`, results }
    }
    return { ok: false, message: `${failed.length} of ${results.length} failed`, results }
})

ipcMain.handle('docker-tag-image', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const source = String(obj['source'] ?? '').trim()
    const target = String(obj['target'] ?? '').trim()
    if (!source || !target) { return { ok: false, message: 'Source and target names required' } }

    try {
        const result = spawnSync('docker', ['tag', source, target], {
            stdio: 'pipe', encoding: 'utf8', timeout: 10_000, env: _dockerEnv(),
        })
        if (result.status === 0) {
            return { ok: true, message: `Tagged ${source} → ${target}` }
        }
        const errMsg = result.stderr?.trim().split('\n').pop() || 'tag failed'
        return { ok: false, message: errMsg }
    } catch (err) {
        return { ok: false, message: `Tag failed: ${(err as Error).message}` }
    }
})

// ═══════════════════════════════════════════════════════════════════════════════
// vrnetlab Image Builder
// ═══════════════════════════════════════════════════════════════════════════════

const VRNETLAB_DIR = path.join(os.homedir(), '.tlink-netops', 'vrnetlab')

// srl-labs/vrnetlab uses nested vendor/product directories
const VRNETLAB_VENDOR_MAP: Record<string, { dir: string; label: string; extensions: string[] }> = {
    // Cisco — extensions match what each vendor's launch.py actually supports
    cisco_xrv9k:           { dir: 'cisco/xrv9k',         label: 'Cisco XRv9000',          extensions: ['qcow2'] },
    cisco_xrv:             { dir: 'cisco/xrv',            label: 'Cisco XRv',              extensions: ['vmdk'] },
    cisco_csr1000v:        { dir: 'cisco/csr1000v',       label: 'Cisco CSR1000v',         extensions: ['qcow2', 'iso'] },
    cisco_c8000v:          { dir: 'cisco/c8000v',         label: 'Cisco Catalyst 8000v',   extensions: ['qcow2', 'iso'] },
    cisco_n9kv:            { dir: 'cisco/n9kv',           label: 'Cisco Nexus 9000v',      extensions: ['qcow2'] },
    cisco_cat9kv:          { dir: 'cisco/cat9kv',         label: 'Cisco Catalyst 9000v',   extensions: ['qcow2', 'img'] },
    cisco_asav:            { dir: 'cisco/asav',           label: 'Cisco ASAv',             extensions: ['qcow2'] },
    cisco_ftdv:            { dir: 'cisco/ftdv',           label: 'Cisco FTDv',             extensions: ['qcow2', 'iso'] },
    cisco_vios:            { dir: 'cisco/vios',           label: 'Cisco vIOS',             extensions: ['qcow2'] },
    cisco_xrd:             { dir: 'cisco/xrd',            label: 'Cisco XRd',              extensions: ['qcow2'] },
    // Juniper
    juniper_vmx:           { dir: 'juniper/vmx',          label: 'Juniper vMX',            extensions: ['img', 'tgz'] },
    juniper_vqfx:          { dir: 'juniper/vqfx',         label: 'Juniper vQFX',           extensions: ['qcow2'] },
    juniper_vsrx:          { dir: 'juniper/vsrx',         label: 'Juniper vSRX',           extensions: ['qcow2', 'iso'] },
    juniper_vjunosrouter:  { dir: 'juniper/vjunosrouter', label: 'Juniper vJunos Router',  extensions: ['qcow2', 'img'] },
    juniper_vjunosswitch:  { dir: 'juniper/vjunosswitch', label: 'Juniper vJunos Switch',  extensions: ['qcow2', 'img'] },
    juniper_vjunosevolved: { dir: 'juniper/vjunosevolved', label: 'Juniper vJunos Evolved', extensions: ['qcow2', 'img'] },
    // Nokia
    nokia_sros:            { dir: 'nokia/sros',           label: 'Nokia SR OS',            extensions: ['qcow2'] },
    nokia_cmglinux:        { dir: 'nokia/cmglinux',       label: 'Nokia CMG Linux',        extensions: ['qcow2', 'iso'] },
    // Arista
    arista_veos:           { dir: 'arista/veos',          label: 'Arista vEOS',            extensions: ['vmdk'] },
    // Others
    paloalto_pan:          { dir: 'paloalto',             label: 'Palo Alto PAN',          extensions: ['qcow2', 'tgz'] },
    mikrotik_routeros:     { dir: 'mikrotik',             label: 'MikroTik RouterOS',      extensions: ['vmdk'] },
    sonic_vs:              { dir: 'sonic',                label: 'SONiC VS',               extensions: ['qcow2'] },
}

ipcMain.handle('vrnetlab-vendors', async () => {
    return Object.entries(VRNETLAB_VENDOR_MAP).map(([id, v]) => ({
        id,
        label: v.label,
        extensions: v.extensions,
    }))
})

ipcMain.handle('vrnetlab-select-image', async () => {
    const result = await dialog.showOpenDialog({
        title: 'Select Vendor VM Image',
        properties: ['openFile'],
        filters: [
            { name: 'VM Images', extensions: ['qcow2', 'vmdk', 'iso', 'ova', 'img'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    })
    if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, path: '' }
    }
    return { ok: true, path: result.filePaths[0] }
})

ipcMain.handle('vrnetlab-build-image', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const vendor = String(obj['vendor'] ?? '').trim()
    const vmImagePath = String(obj['vmImagePath'] ?? '').trim()

    const vendorInfo = VRNETLAB_VENDOR_MAP[vendor]
    if (!vendorInfo) {
        return { ok: false, message: `Unknown vendor: ${vendor}` }
    }
    if (!vmImagePath || !fs.existsSync(vmImagePath)) {
        return { ok: false, message: 'VM image file not found' }
    }

    // Build script: clone srl-labs/vrnetlab if needed, copy image, run make
    const vendorDir = path.join(VRNETLAB_DIR, vendorInfo.dir)
    const imageName = path.basename(vmImagePath)

    // vrnetlab Makefile system:
    //   IMAGE_GLOB=*.qcow2  →  IMAGES=$(shell ls *.qcow2)
    //   `make docker-image` loops over $(IMAGES) and calls `make docker-build` per image.
    //   VERSION is extracted via sed that strips the vendor prefix and .qcow2 extension.
    //
    // For non-qcow2 formats (iso, vmdk, img, tgz) the glob won't find the file,
    // so we must call `make docker-build` directly with IMAGE= and VERSION= to
    // bypass the glob-based loop entirely.
    const ext = path.extname(imageName).toLowerCase()
    const isDefaultGlob = ext === '.qcow2'

    // Extract version string from filename (mirrors Makefile sed logic)
    // e.g. "vJunosEvolved-25.4R1.13-EVO.iso" → "25.4R1.13-EVO"
    const baseName = path.basename(imageName, ext)
    const dashIdx = baseName.indexOf('-')
    const version = dashIdx >= 0 ? baseName.substring(dashIdx + 1) : baseName

    // qcow2: default `make docker-image` (glob works fine)
    // other formats: call `make docker-build` directly, passing IMAGE= and VERSION=
    const makeCmd = isDefaultGlob
        ? `make docker-image`
        : `make IMAGE="${imageName}" VERSION="${version}" docker-build`

    const steps = [
        `echo "=== vrnetlab Image Builder (srl-labs/vrnetlab) ==="`,
        `echo "Vendor: ${vendorInfo.label}"`,
        `echo "Image: ${imageName}"`,
        `echo "Format: ${ext.replace('.', '').toUpperCase()}"`,
        `echo ""`,
        // Clone srl-labs/vrnetlab if not present (containerlab-compatible fork)
        `if [ ! -d "${VRNETLAB_DIR}/.git" ]; then`,
        `  echo "Cloning srl-labs/vrnetlab repository..."`,
        `  rm -rf "${VRNETLAB_DIR}"`,
        `  git clone --depth 1 https://github.com/srl-labs/vrnetlab.git "${VRNETLAB_DIR}"`,
        `fi`,
        // Verify vendor directory exists in the repo
        `if [ ! -d "${vendorDir}" ]; then`,
        `  echo "ERROR: Vendor directory ${vendorInfo.dir} not found in vrnetlab repo"`,
        `  exit 1`,
        `fi`,
        // Copy VM image into the vendor directory
        `echo "Copying VM image to ${vendorInfo.dir}/..."`,
        `cp "${vmImagePath}" "${vendorDir}/${imageName}"`,
        // Build Docker image
        `echo ""`,
        `echo "Building Docker image (this may take several minutes)..."`,
        `echo "Requires Docker to be running and KVM support on the host."`,
        `cd "${vendorDir}"`,
        makeCmd,
        `echo ""`,
        `echo "=== Build complete ==="`,
        `echo "The new image should now appear in Docker Image Manager."`,
        `echo "Run 'docker images | grep vrnetlab' to verify."`,
    ]

    const command = steps.join('\n')
    return _openClabTerminal(command, `vrnetlab-${vendor}`)
})

// ═══════════════════════════════════════════════════════════════════════════════
// Libvirt / virsh VM Management
// ═══════════════════════════════════════════════════════════════════════════════

/** Run a virsh command locally or via SSH on the active server */
const _VIRSH_NOT_FOUND_MSG = 'virsh (libvirt) is not installed on this server. Install with: sudo apt install -y libvirt-daemon-system'

async function _runVirsh (args: string): Promise<{ ok: boolean; stdout: string; message: string }> {
    const server = _activeServer()

    if (server.type === 'local') {
        const result = spawnSync('bash', ['-c', `virsh ${args}`], {
            stdio: 'pipe', encoding: 'utf8', timeout: 10_000,
        })
        const msg = result.stderr?.trim() || ''
        if (!result.status && !result.stdout && (msg.includes('command not found') || msg.includes('not found'))) {
            return { ok: false, stdout: '', message: _VIRSH_NOT_FOUND_MSG }
        }
        return {
            ok: result.status === 0,
            stdout: result.stdout ?? '',
            message: msg,
        }
    }

    // Remote: use ssh2
    if (!server.host || !server.username) {
        return { ok: false, stdout: '', message: 'Host/username not set' }
    }

    return new Promise(resolve => {
        const conn = new Client()
        const timer = setTimeout(() => {
            try { conn.end() } catch {}
            resolve({ ok: false, stdout: '', message: 'Timeout' })
        }, 10_000)

        conn.on('error', (err: Error) => {
            clearTimeout(timer)
            resolve({ ok: false, stdout: '', message: err.message })
        })

        conn.on('ready', () => {
            conn.exec(`virsh ${args}`, (err, stream) => {
                if (err) { clearTimeout(timer); conn.end(); resolve({ ok: false, stdout: '', message: err.message }); return }
                let out = ''
                let errOut = ''
                stream.on('data', (d: Buffer) => { out += d.toString() })
                stream.stderr.on('data', (d: Buffer) => { errOut += d.toString() })
                stream.on('close', (code: number) => {
                    clearTimeout(timer)
                    conn.end()
                    const msg = errOut.trim()
                    if (code !== 0 && (msg.includes('command not found') || msg.includes('not found'))) {
                        resolve({ ok: false, stdout: '', message: _VIRSH_NOT_FOUND_MSG })
                    } else {
                        resolve({ ok: code === 0, stdout: out, message: msg })
                    }
                })
            })
        })

        conn.connect({ ..._ssh2ConnectOpts(server), readyTimeout: 8_000 })
    })
}

ipcMain.handle('virsh-list', async () => {
    const result = await _runVirsh('list --all')
    if (!result.ok && !result.stdout) {
        return { ok: false, vms: [], message: result.message || 'virsh not available' }
    }
    // Parse virsh list output: " Id   Name   State"
    const lines = result.stdout.split('\n').slice(2).filter(l => l.trim())
    const vms = lines.map(line => {
        const parts = line.trim().split(/\s+/)
        const id = parts[0] ?? '-'
        const name = parts[1] ?? ''
        const state = parts.slice(2).join(' ') || 'unknown'
        return { id, name, state }
    }).filter(v => v.name)

    // Enrich with autostart state
    for (const vm of vms) {
        try {
            const info = await _runVirsh(`dominfo ${_shellQ(vm.name)}`)
            if (info.ok) {
                const m = info.stdout.match(/Autostart:\s+(\S+)/)
                ;(vm as any).autostart = m ? m[1] === 'enable' : false
            } else {
                ;(vm as any).autostart = false
            }
        } catch {
            ;(vm as any).autostart = false
        }
    }

    return { ok: true, vms }
})

ipcMain.handle('virsh-action', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const vm = String(obj['vm'] ?? '').trim()
    const action = String(obj['action'] ?? '').trim()
    const allowed = ['start', 'shutdown', 'destroy', 'reboot', 'suspend', 'resume']
    if (!vm || !_isSafeName(vm) || !allowed.includes(action)) {
        return { ok: false, message: `Invalid action: ${action}` }
    }
    return _runVirsh(`${action} ${_shellQ(vm)}`)
})

ipcMain.handle('virsh-info', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const vm = String((rawPayload as Record<string, unknown>)['vm'] ?? '').trim()
    if (!vm) { return { ok: false, message: 'VM name required' } }
    const result = await _runVirsh(`dominfo ${_shellQ(vm)}`)
    if (!result.ok) { return { ok: false, message: result.message } }
    // Parse key:value pairs
    const info: Record<string, string> = {}
    for (const line of result.stdout.split('\n')) {
        const idx = line.indexOf(':')
        if (idx > 0) {
            info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
        }
    }
    return {
        ok: true,
        state: info['State'] ?? 'unknown',
        cpu: info['CPU(s)'] ?? '0',
        memory: info['Max memory'] ?? '0',
        autostart: info['Autostart'] ?? 'disable',
    }
})

ipcMain.handle('virsh-console', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const vm = String((rawPayload as Record<string, unknown>)['vm'] ?? '').trim()
    if (!vm) { return { ok: false, message: 'VM name required' } }
    if (!_isSafeName(vm)) { return { ok: false, message: 'Invalid VM name' } }

    const server = _activeServer()
    let shellCmd: string

    if (server.type === 'ssh' && server.host && server.username) {
        const portPart = server.port && server.port !== 22 ? `-p ${server.port} ` : ''
        shellCmd = `ssh -t ${portPart}${server.username}@${server.host} "virsh console ${_shellQ(vm)}"`
    } else {
        shellCmd = `virsh console ${_shellQ(vm)}`
    }

    const sessionId = `vm-console-${vm}-${Date.now()}`
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash')
    const shellArgs = process.platform === 'win32' ? ['/c', shellCmd] : ['-lc', shellCmd]
    return _openTerminalWindow({
        sessionId,
        label: `VM: ${vm}`,
        command: shell,
        args: shellArgs,
        env: { ...process.env as Record<string, string> },
    })
})

ipcMain.handle('virsh-snapshot-list', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, snapshots: [] }
    }
    const vm = String((rawPayload as Record<string, unknown>)['vm'] ?? '').trim()
    if (!vm) { return { ok: false, snapshots: [], message: 'VM name required' } }
    const result = await _runVirsh(`snapshot-list ${_shellQ(vm)}`)
    if (!result.ok) { return { ok: false, snapshots: [], message: result.message } }
    const lines = result.stdout.split('\n').slice(2).filter(l => l.trim())
    const snapshots = lines.map(line => {
        const parts = line.trim().split(/\s{2,}/)
        return { name: parts[0] ?? '', created: parts[1] ?? '', state: parts[2] ?? '' }
    }).filter(s => s.name)
    return { ok: true, snapshots }
})

ipcMain.handle('virsh-snapshot-create', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const vm = String(obj['vm'] ?? '').trim()
    const name = String(obj['name'] ?? '').trim() || `snap-${Date.now()}`
    if (!vm) { return { ok: false, message: 'VM name required' } }
    return _runVirsh(`snapshot-create-as ${_shellQ(vm)} ${_shellQ(name)}`)
})

ipcMain.handle('virsh-snapshot-revert', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const vm = String(obj['vm'] ?? '').trim()
    const name = String(obj['name'] ?? '').trim()
    if (!vm || !name) { return { ok: false, message: 'VM name and snapshot name required' } }
    return _runVirsh(`snapshot-revert ${_shellQ(vm)} ${_shellQ(name)}`)
})

ipcMain.handle('virsh-create-vm', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const name = String(obj['name'] ?? '').trim()
    const cpu = parseInt(String(obj['cpu'] ?? '2'), 10) || 2
    const memoryMb = parseInt(String(obj['memoryMb'] ?? '2048'), 10) || 2048
    const diskPath = String(obj['diskPath'] ?? '').trim()
    const networkBridge = String(obj['networkBridge'] ?? 'virbr0').trim()

    if (!name) { return { ok: false, message: 'VM name required' } }
    if (!diskPath) { return { ok: false, message: 'Disk image path required' } }
    if (!_isSafeName(name)) { return { ok: false, message: 'Invalid VM name (use alphanumeric, hyphens, underscores)' } }

    // Generate libvirt XML domain definition
    const xml = `<domain type='kvm'>
  <name>${_xmlEsc(name)}</name>
  <memory unit='MiB'>${memoryMb}</memory>
  <vcpu>${cpu}</vcpu>
  <os>
    <type arch='x86_64'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/><apic/>
  </features>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='${_xmlEsc(diskPath)}'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='bridge'>
      <source bridge='${_xmlEsc(networkBridge)}'/>
      <model type='virtio'/>
    </interface>
    <serial type='pty'><target port='0'/></serial>
    <console type='pty'><target type='serial' port='0'/></console>
    <graphics type='vnc' port='-1' autoport='yes'/>
  </devices>
</domain>`

    // Write XML to temp file, define, and start
    const tmpXml = path.join(os.tmpdir(), `tlink-vm-${name}.xml`)
    const server = _activeServer()

    if (server.type === 'ssh' && server.host && server.username) {
        // Remote: upload XML via SFTP then define+start
        const remoteTmpXml = `/tmp/tlink-vm-${name}.xml`
        const uploadResult = await _scpFiles(
            [{ remotePath: remoteTmpXml, content: xml }],
            undefined,
            server,
        )
        if (!uploadResult.ok) { return uploadResult }
        const defResult = await _runVirsh(`define ${_shellQ(remoteTmpXml)}`)
        if (!defResult.ok) { return defResult }
        return _runVirsh(`start ${_shellQ(name)}`)
    } else {
        // Local
        fs.writeFileSync(tmpXml, xml, 'utf8')
        const defResult = await _runVirsh(`define ${_shellQ(tmpXml)}`)
        if (!defResult.ok) { return defResult }
        try { fs.unlinkSync(tmpXml) } catch {}
        return _runVirsh(`start ${_shellQ(name)}`)
    }
})

// ── List disk images in /var/lib/libvirt/images ─────────────────────────────
ipcMain.handle('virsh-list-disk-images', async () => {
    const imgDir = '/var/lib/libvirt/images'
    const cmd = `ls -lhp "${imgDir}" 2>/dev/null | grep -v '/$' | tail -n +2`
    const server = _activeServer()

    let output = ''
    if (server.type === 'local') {
        const result = spawnSync('bash', ['-c', cmd], {
            stdio: 'pipe', encoding: 'utf8', timeout: 10_000,
        })
        if (result.status !== 0 && !result.stdout) {
            return { ok: false, images: [], message: result.stderr?.trim() || 'Failed to list images' }
        }
        output = result.stdout ?? ''
    } else {
        const res = await _runShellCmd(cmd)
        if (!res.ok && !res.stdout) {
            return { ok: false, images: [], message: res.message || 'Failed to list images' }
        }
        output = res.stdout
    }

    const images: Array<{ name: string; size: string; path: string }> = []
    for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) { continue }
        // ls -lh output: -rw-r--r-- 1 root root 1.2G Jan  5 10:30 sonic-vs.qcow2
        const parts = trimmed.split(/\s+/)
        if (parts.length >= 9) {
            const size = parts[4]
            const name = parts.slice(8).join(' ')
            if (name) {
                images.push({ name, size, path: `${imgDir}/${name}` })
            }
        }
    }
    return { ok: true, images }
})

// ── Upload a local disk image to /var/lib/libvirt/images on the server ──────
ipcMain.handle('virsh-upload-disk-image', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const localPath = String(obj['localPath'] ?? '').trim()
    if (!localPath) { return { ok: false, message: 'No file path specified' } }

    const fileName = path.basename(localPath)
    const remoteDest = `/var/lib/libvirt/images/${fileName}`
    const server = _activeServer()

    if (server.type === 'local') {
        // Local: copy the file
        try {
            // Ensure target dir exists
            spawnSync('bash', ['-c', 'sudo -n mkdir -p /var/lib/libvirt/images'], {
                stdio: 'pipe', encoding: 'utf8', timeout: 5_000,
            })
            const result = spawnSync('bash', ['-c', `sudo -n cp ${_shellQ(localPath)} ${_shellQ(remoteDest)}`], {
                stdio: 'pipe', encoding: 'utf8', timeout: 300_000, // 5 min for large images
            })
            if (result.status !== 0) {
                return { ok: false, message: result.stderr?.trim() || 'Copy failed' }
            }
            return { ok: true, path: remoteDest, message: `Copied to ${remoteDest}` }
        } catch (err) {
            return { ok: false, message: (err as Error).message }
        }
    } else {
        // Remote: SCP upload
        if (!server.host || !server.username) {
            return { ok: false, message: 'Host/username not set for remote server' }
        }
        // Ensure remote dir exists
        await _runShellCmd('sudo mkdir -p /var/lib/libvirt/images')

        return new Promise(resolve => {
            const conn = new Client()
            const timer = setTimeout(() => {
                try { conn.end() } catch {}
                resolve({ ok: false, message: 'SFTP upload timeout (5 min)' })
            }, 300_000) // 5 min

            conn.on('error', (err: Error) => {
                clearTimeout(timer)
                resolve({ ok: false, message: `SSH error: ${err.message}` })
            })

            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) {
                        clearTimeout(timer); conn.end()
                        resolve({ ok: false, message: `SFTP error: ${err.message}` })
                        return
                    }
                    // Upload to /tmp first, then sudo mv
                    const tmpDest = `/tmp/tlink-upload-${fileName}`
                    const readStream = fs.createReadStream(localPath)
                    const writeStream = sftp.createWriteStream(tmpDest)

                    writeStream.on('error', (e: Error) => {
                        clearTimeout(timer); conn.end()
                        resolve({ ok: false, message: `Upload error: ${e.message}` })
                    })

                    writeStream.on('close', () => {
                        // Move from /tmp to /var/lib/libvirt/images with sudo
                        conn.exec(`sudo mv "${tmpDest}" "${remoteDest}" && sudo chmod 644 "${remoteDest}"`, (e, stream) => {
                            if (e) {
                                clearTimeout(timer); conn.end()
                                resolve({ ok: false, message: `Move error: ${e.message}` })
                                return
                            }
                            let errOut = ''
                            stream.stderr.on('data', (d: Buffer) => { errOut += d.toString() })
                            stream.on('close', (code: number) => {
                                clearTimeout(timer); conn.end()
                                if (code === 0) {
                                    resolve({ ok: true, path: remoteDest, message: `Uploaded to ${remoteDest}` })
                                } else {
                                    resolve({ ok: false, message: errOut.trim() || 'Failed to move file' })
                                }
                            })
                        })
                    })

                    readStream.pipe(writeStream)
                })
            })

            conn.connect({ ..._ssh2ConnectOpts(server), readyTimeout: 300_000 })
        })
    }
})

// ═══════════════════════════════════════════════════════════════════════════════
// Bridge & Network Management
// ═══════════════════════════════════════════════════════════════════════════════

/** Shell-quote a value by wrapping in single quotes with proper escaping */
function _shellQ (s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Escape a string for safe inclusion in XML attribute/element text */
function _xmlEsc (s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Validate that a name contains only safe characters (alphanumeric, hyphens, underscores, dots) */
function _isSafeName (s: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(s)
}

/** Run a shell command locally or via SSH on the active server */
async function _runShellCmd (cmd: string, timeoutMs = 10_000): Promise<{ ok: boolean; stdout: string; message: string }> {
    const server = _activeServer()

    if (server.type === 'local') {
        // Use sudo -n (non-interactive) to prevent hanging on password prompt
        const safeCmd = cmd.replace(/\bsudo\b/g, 'sudo -n')
        const result = spawnSync('bash', ['-c', safeCmd], {
            stdio: 'pipe', encoding: 'utf8', timeout: timeoutMs,
        })
        let msg = result.stderr?.trim() || ''
        if (msg.includes('sudo: a password is required') || msg.includes('sudo:')) {
            msg = 'sudo requires a password. Run this operation on a remote server or configure passwordless sudo.'
        }
        return {
            ok: result.status === 0,
            stdout: result.stdout ?? '',
            message: msg,
        }
    }

    if (!server.host || !server.username) {
        return { ok: false, stdout: '', message: 'Host/username not set' }
    }

    return new Promise(resolve => {
        const conn = new Client()
        const timer = setTimeout(() => {
            try { conn.end() } catch {}
            resolve({ ok: false, stdout: '', message: 'Timeout' })
        }, timeoutMs)

        conn.on('error', (err: Error) => {
            clearTimeout(timer)
            resolve({ ok: false, stdout: '', message: err.message })
        })

        conn.on('ready', () => {
            conn.exec(cmd, (err, stream) => {
                if (err) { clearTimeout(timer); conn.end(); resolve({ ok: false, stdout: '', message: err.message }); return }
                let out = ''
                let errOut = ''
                stream.on('data', (d: Buffer) => { out += d.toString() })
                stream.stderr.on('data', (d: Buffer) => { errOut += d.toString() })
                stream.on('close', (code: number) => {
                    clearTimeout(timer)
                    conn.end()
                    resolve({ ok: code === 0, stdout: out, message: errOut.trim() })
                })
            })
        })

        conn.connect({ ..._ssh2ConnectOpts(server), readyTimeout: 8_000 })
    })
}

ipcMain.handle('bridge-list', async (_event, rawPayload?: unknown) => {
    // Accept optional serverId to query a specific server's bridges
    const serverId = (rawPayload && typeof rawPayload === 'object') ? String((rawPayload as Record<string, unknown>)['serverId'] ?? '') : ''
    const requestedServer = serverId && serverId !== 'local' ? _getServerById(serverId) : null
    // Temporarily switch active server context for _runShellCmd if querying a specific server
    const origActiveId = _loadServerState().activeServerId
    if (requestedServer && requestedServer.id !== origActiveId) {
        const state = _loadServerState()
        state.activeServerId = requestedServer.id
        _saveServerState(state)
    }
    try {
    return await _bridgeListImpl()
    } finally {
        // Restore original active server
        if (requestedServer && requestedServer.id !== origActiveId) {
            const state = _loadServerState()
            state.activeServerId = origActiveId
            _saveServerState(state)
        }
    }
})

async function _bridgeListImpl () {
    const bridges: Array<{
        name: string
        type: 'linux' | 'libvirt' | 'ovs'
        state: string
        subnet?: string
        mode?: string
        interfaces: string[]
    }> = []

    // 1. Linux bridges — discover bridge devices, then find their member ports
    try {
        const linuxBrNames = new Set<string>()

        // Step A: Discover all bridge interfaces using multiple methods
        // Method 1: ip -j link show type bridge (JSON, iproute2 4.14+)
        try {
            const brDevicesJ = await _runShellCmd('ip -j link show type bridge 2>/dev/null')
            if (brDevicesJ.ok && brDevicesJ.stdout.trim()) {
                const devs = JSON.parse(brDevicesJ.stdout) as Array<{ ifname?: string }>
                for (const d of devs) { if (d.ifname) { linuxBrNames.add(d.ifname) } }
            }
        } catch { /* ip -j not available or parse error */ }

        // Method 2: ip link show type bridge (non-JSON fallback — parse text output)
        if (linuxBrNames.size === 0) {
            try {
                const brDevicesT = await _runShellCmd('ip link show type bridge 2>/dev/null')
                if (brDevicesT.ok && brDevicesT.stdout.trim()) {
                    // Lines like "4: docker0: <BROADCAST,MULTICAST,UP> ..."
                    const ifnameRe = /^\d+:\s+([^:@\s]+)/
                    for (const line of brDevicesT.stdout.split('\n')) {
                        const m = line.match(ifnameRe)
                        if (m) { linuxBrNames.add(m[1]) }
                    }
                }
            } catch { /* ip not available */ }
        }

        // Method 3: brctl show (legacy, needs bridge-utils)
        try {
            const brctl = await _runShellCmd('brctl show 2>/dev/null')
            if (brctl.ok && brctl.stdout.trim()) {
                const lines = brctl.stdout.split('\n').slice(1).filter(l => l.trim())
                for (const line of lines) {
                    const parts = line.split(/\s+/).filter(Boolean)
                    if (parts.length >= 3 && !line.startsWith('\t') && !line.startsWith(' ')) {
                        linuxBrNames.add(parts[0])
                    }
                }
            }
        } catch { /* brctl not available */ }

        // Method 4: read /sys/class/net/*/bridge (works on all Linux, no tool dependencies)
        try {
            const sysfs = await _runShellCmd('ls -1d /sys/class/net/*/bridge 2>/dev/null | sed "s|/sys/class/net/||;s|/bridge||"')
            if (sysfs.ok && sysfs.stdout.trim()) {
                for (const name of sysfs.stdout.trim().split('\n').filter(Boolean)) {
                    linuxBrNames.add(name)
                }
            }
        } catch { /* sysfs not available */ }

        // Step B: For each discovered bridge, find member ports
        if (linuxBrNames.size > 0) {
            const memberMap = new Map<string, string[]>()
            for (const br of linuxBrNames) { memberMap.set(br, []) }

            // Try bridge -j for member ports
            try {
                const members = await _runShellCmd('bridge -j link show 2>/dev/null')
                if (members.ok && members.stdout.trim()) {
                    const items = JSON.parse(members.stdout) as Array<{ master?: string; ifname?: string }>
                    for (const item of items) {
                        if (item.master && memberMap.has(item.master) && item.ifname) {
                            memberMap.get(item.master)!.push(item.ifname)
                        }
                    }
                }
            } catch {
                // Fallback: read /sys/class/net/<bridge>/brif/ for member ports
                try {
                    for (const br of linuxBrNames) {
                        const brif = await _runShellCmd(`ls /sys/class/net/${_shellQ(br)}/brif/ 2>/dev/null`)
                        if (brif.ok && brif.stdout.trim()) {
                            for (const iface of brif.stdout.trim().split('\n').filter(Boolean)) {
                                memberMap.get(br)?.push(iface)
                            }
                        }
                    }
                } catch { /* ok */ }
            }
            for (const [name, ifaces] of memberMap) {
                bridges.push({ name, type: 'linux', state: 'active', interfaces: ifaces })
            }
        }
    } catch { /* no linux bridges */ }

    // 2. Libvirt networks
    try {
        const netList = await _runVirsh('net-list --all')
        if (netList.ok && netList.stdout) {
            const lines = netList.stdout.split('\n').slice(2).filter(l => l.trim())
            for (const line of lines) {
                const parts = line.trim().split(/\s+/)
                const name = parts[0] ?? ''
                const state = parts[1] ?? 'inactive'
                if (!name || name === '---') { continue }
                // Get details via net-dumpxml
                let subnet = ''
                let mode = ''
                const ifaces: string[] = []
                try {
                    const xmlResult = await _runVirsh(`net-dumpxml ${_shellQ(name)}`)
                    if (xmlResult.ok) {
                        const ipMatch = xmlResult.stdout.match(/address=['"]([^'"]+)['"]/)
                        const prefixMatch = xmlResult.stdout.match(/prefix=['"]([^'"]+)['"]/)
                        if (ipMatch) { subnet = prefixMatch ? `${ipMatch[1]}/${prefixMatch[1]}` : ipMatch[1] }
                        const fwdMatch = xmlResult.stdout.match(/forward\s+mode=['"]([^'"]+)['"]/)
                        if (fwdMatch) { mode = fwdMatch[1] }
                        const brMatch = xmlResult.stdout.match(/bridge\s+name=['"]([^'"]+)['"]/)
                        if (brMatch) { ifaces.push(brMatch[1]) }
                    }
                } catch { /* ok */ }
                bridges.push({ name, type: 'libvirt', state, subnet, mode: mode || 'isolated', interfaces: ifaces })
            }
        }
    } catch { /* no virsh */ }

    // 3. OVS bridges
    try {
        const ovs = await _runShellCmd('ovs-vsctl list-br 2>/dev/null || sudo ovs-vsctl list-br 2>/dev/null')
        if (ovs.ok && ovs.stdout.trim()) {
            const ovsBrNames = ovs.stdout.trim().split('\n').filter(Boolean)
            // Remove OVS bridges from Linux list (OVS internal bridges also appear as Linux bridges)
            for (const ovsName of ovsBrNames) {
                const idx = bridges.findIndex(b => b.name === ovsName && b.type === 'linux')
                if (idx >= 0) { bridges.splice(idx, 1) }
            }
            for (const brName of ovsBrNames) {
                const ports = await _runShellCmd(`ovs-vsctl list-ports ${_shellQ(brName)} 2>/dev/null`)
                const ifaces = ports.ok ? ports.stdout.trim().split('\n').filter(Boolean) : []
                bridges.push({ name: brName, type: 'ovs', state: 'active', interfaces: ifaces })
            }
        }
    } catch { /* no ovs */ }

    return { ok: true, bridges }
}

ipcMain.handle('bridge-create-libvirt', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const name = String(obj['name'] ?? '').trim()
    const mode = String(obj['mode'] ?? 'nat').trim()
    const allowedModes = ['nat', 'route', 'isolated', 'bridge']
    if (!allowedModes.includes(mode)) { return { ok: false, message: `Invalid mode: ${mode}. Allowed: ${allowedModes.join(', ')}` } }
    const subnet = String(obj['subnet'] ?? '').trim()   // e.g. "192.168.100.0/24"
    const dhcp = obj['dhcp'] !== false
    const dhcpStart = String(obj['dhcpStart'] ?? '').trim()
    const dhcpEnd = String(obj['dhcpEnd'] ?? '').trim()
    const autostart = obj['autostart'] !== false

    if (!name) { return { ok: false, message: 'Network name required' } }
    if (!_isSafeName(name)) { return { ok: false, message: 'Invalid network name (use alphanumeric, hyphens, underscores)' } }

    // Parse subnet
    let ipAddr = ''
    let prefix = '24'
    if (subnet) {
        const parts = subnet.split('/')
        ipAddr = parts[0]
        prefix = parts[1] || '24'
    }

    let xml = `<network>\n  <name>${_xmlEsc(name)}</name>\n`
    if (mode !== 'isolated') {
        xml += `  <forward mode='${_xmlEsc(mode)}'/>\n`
    }
    xml += `  <bridge name='${_xmlEsc(name)}' stp='on' delay='0'/>\n`
    if (ipAddr) {
        xml += `  <ip address='${_xmlEsc(ipAddr)}' prefix='${_xmlEsc(prefix)}'>\n`
        if (dhcp && dhcpStart && dhcpEnd) {
            xml += `    <dhcp>\n      <range start='${_xmlEsc(dhcpStart)}' end='${_xmlEsc(dhcpEnd)}'/>\n    </dhcp>\n`
        }
        xml += `  </ip>\n`
    }
    xml += `</network>`

    const server = _activeServer()
    const tmpPath = `/tmp/tlink-net-${name}.xml`

    if (server.type === 'ssh' && server.host && server.username) {
        const uploadResult = await _scpFiles(
            [{ remotePath: tmpPath, content: xml }],
            undefined,
            server,
        )
        if (!uploadResult.ok) { return uploadResult }
    } else {
        fs.writeFileSync(tmpPath, xml, 'utf8')
    }

    const defResult = await _runVirsh(`net-define ${_shellQ(tmpPath)}`)
    if (!defResult.ok) { return defResult }

    const startResult = await _runVirsh(`net-start ${_shellQ(name)}`)
    if (!startResult.ok) { return { ok: true, message: `Defined but could not start: ${startResult.message}` } }

    if (autostart) {
        await _runVirsh(`net-autostart ${_shellQ(name)}`)
    }

    // Clean up temp file
    if (server.type === 'local') {
        try { fs.unlinkSync(tmpPath) } catch {}
    }

    return { ok: true, message: `Network ${name} created and started` }
})

ipcMain.handle('bridge-delete-libvirt', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const name = String((rawPayload as Record<string, unknown>)['name'] ?? '').trim()
    if (!name) { return { ok: false, message: 'Network name required' } }
    if (!_isSafeName(name)) { return { ok: false, message: 'Invalid network name' } }

    // Try to stop first (ignore error if already inactive)
    await _runVirsh(`net-destroy ${_shellQ(name)}`)
    return _runVirsh(`net-undefine ${_shellQ(name)}`)
})

ipcMain.handle('bridge-action-libvirt', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const name = String(obj['name'] ?? '').trim()
    const action = String(obj['action'] ?? '').trim()
    const allowed = ['start', 'destroy', 'autostart']
    if (!name || !allowed.includes(action)) {
        return { ok: false, message: `Invalid action: ${action}` }
    }
    if (!_isSafeName(name)) { return { ok: false, message: 'Invalid network name' } }
    if (action === 'autostart') {
        const enable = obj['enable'] !== false
        return _runVirsh(`net-autostart ${enable ? '' : '--disable '}${_shellQ(name)}`)
    }
    return _runVirsh(`net-${action} ${_shellQ(name)}`)
})

ipcMain.handle('bridge-create-linux', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const name = String(obj['name'] ?? '').trim()
    const ipAddr = String(obj['ipAddress'] ?? '').trim()   // e.g. "10.0.0.1/24"

    if (!name) { return { ok: false, message: 'Bridge name required' } }
    if (!_isSafeName(name)) { return { ok: false, message: 'Invalid bridge name (use alphanumeric, hyphens, underscores)' } }

    let cmd = `sudo ip link add ${_shellQ(name)} type bridge && sudo ip link set ${_shellQ(name)} up`
    if (ipAddr) {
        cmd += ` && sudo ip addr add ${_shellQ(ipAddr)} dev ${_shellQ(name)}`
    }
    return _runShellCmd(cmd)
})

ipcMain.handle('bridge-delete-linux', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const name = String((rawPayload as Record<string, unknown>)['name'] ?? '').trim()
    if (!name) { return { ok: false, message: 'Bridge name required' } }
    if (!_isSafeName(name)) { return { ok: false, message: 'Invalid bridge name' } }
    return _runShellCmd(`sudo ip link set ${_shellQ(name)} down && sudo ip link del ${_shellQ(name)}`)
})

ipcMain.handle('bridge-create-ovs', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const name = String(obj['name'] ?? '').trim()
    const vxlanRemote = String(obj['vxlanRemote'] ?? '').trim()
    const vni = parseInt(String(obj['vni'] ?? '0'), 10)

    if (!name) { return { ok: false, message: 'Bridge name required' } }
    if (!_isSafeName(name)) { return { ok: false, message: 'Invalid bridge name (use alphanumeric, hyphens, underscores)' } }

    if (vxlanRemote && !/^[\d.:a-fA-F]+$/.test(vxlanRemote)) {
        return { ok: false, message: 'Invalid VXLAN remote IP address' }
    }

    let cmd = `sudo ovs-vsctl add-br ${_shellQ(name)}`
    if (vxlanRemote && vni > 0) {
        const vxlanIface = `vxlan-${vni}`
        cmd += ` && sudo ovs-vsctl add-port ${_shellQ(name)} ${_shellQ(vxlanIface)} -- set interface ${_shellQ(vxlanIface)} type=vxlan options:remote_ip=${_shellQ(vxlanRemote)} options:key=${vni}`
    }
    return _runShellCmd(cmd)
})

ipcMain.handle('bridge-delete-ovs', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const name = String((rawPayload as Record<string, unknown>)['name'] ?? '').trim()
    if (!name) { return { ok: false, message: 'Bridge name required' } }
    if (!_isSafeName(name)) { return { ok: false, message: 'Invalid bridge name' } }
    return _runShellCmd(`sudo ovs-vsctl del-br ${_shellQ(name)}`)
})

ipcMain.handle('vxlan-setup-tunnel', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const bridgeName = String(obj['bridgeName'] ?? '').trim()
    const remoteIp = String(obj['remoteIp'] ?? '').trim()
    const vni = parseInt(String(obj['vni'] ?? '100'), 10)
    const method = String(obj['method'] ?? 'linux').trim()   // 'linux' or 'ovs'

    if (!bridgeName || !remoteIp) {
        return { ok: false, message: 'Bridge name and remote IP required' }
    }
    if (!_isSafeName(bridgeName)) { return { ok: false, message: 'Invalid bridge name (use alphanumeric, hyphens, underscores)' } }
    if (!/^[\d.:a-fA-F]+$/.test(remoteIp)) { return { ok: false, message: 'Invalid remote IP address' } }
    if (method !== 'linux' && method !== 'ovs') { return { ok: false, message: 'Invalid method: must be "linux" or "ovs"' } }

    if (method === 'ovs') {
        const vxlanIface = `vxlan-${vni}`
        const cmd = `sudo ovs-vsctl --may-exist add-br ${_shellQ(bridgeName)} && sudo ovs-vsctl add-port ${_shellQ(bridgeName)} ${_shellQ(vxlanIface)} -- set interface ${_shellQ(vxlanIface)} type=vxlan options:remote_ip=${_shellQ(remoteIp)} options:key=${vni}`
        return _runShellCmd(cmd)
    }

    // Linux VXLAN
    const vxlanIf = `vxlan${vni}`
    const cmd = [
        `sudo ip link add ${_shellQ(vxlanIf)} type vxlan id ${vni} remote ${_shellQ(remoteIp)} dstport 4789`,
        `sudo ip link add ${_shellQ(bridgeName)} type bridge 2>/dev/null || true`,
        `sudo ip link set ${_shellQ(vxlanIf)} master ${_shellQ(bridgeName)}`,
        `sudo ip link set ${_shellQ(vxlanIf)} up`,
        `sudo ip link set ${_shellQ(bridgeName)} up`,
    ].join(' && ')
    return _runShellCmd(cmd)
})

ipcMain.handle('virsh-delete-vm', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const vm = String(obj['vm'] ?? '').trim()
    const removeStorage = obj['removeStorage'] === true
    if (!vm) { return { ok: false, message: 'VM name required' } }
    if (!_isSafeName(vm)) { return { ok: false, message: 'Invalid VM name' } }
    const args = removeStorage ? `undefine ${_shellQ(vm)} --remove-all-storage` : `undefine ${_shellQ(vm)}`
    return _runVirsh(args)
})

ipcMain.handle('virsh-snapshot-delete', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const vm = String(obj['vm'] ?? '').trim()
    const name = String(obj['name'] ?? '').trim()
    if (!vm || !name) { return { ok: false, message: 'VM and snapshot name required' } }
    if (!_isSafeName(vm)) { return { ok: false, message: 'Invalid VM name' } }
    if (!_isSafeName(name)) { return { ok: false, message: 'Invalid snapshot name' } }
    return _runVirsh(`snapshot-delete ${_shellQ(vm)} ${_shellQ(name)}`)
})

ipcMain.handle('virsh-autostart', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const vm = String(obj['vm'] ?? '').trim()
    const enable = obj['enable'] !== false
    if (!vm) { return { ok: false, message: 'VM name required' } }
    if (!_isSafeName(vm)) { return { ok: false, message: 'Invalid VM name' } }
    return _runVirsh(`autostart ${enable ? '' : '--disable '}${_shellQ(vm)}`)
})

ipcMain.handle('clab-save-topology', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const content = String(obj['content'] ?? '')
    const labName = String(obj['labName'] ?? 'lab').replace(/[^a-zA-Z0-9_-]/g, '-')
    const extraFiles = Array.isArray(obj['extraFiles']) ? obj['extraFiles'] as Array<{ name: string; content: string }> : []

    // ── Remote server: upload via SFTP ──────────────────────────────────────
    if (_isRemote()) {
        const server = _activeServer()
        const remoteBase = server.remoteLabDir || '/tmp/containerlab-labs'
        const remoteLab = `${remoteBase}/${labName}`
        const remoteFile = `${remoteLab}/${labName}.clab.yml`

        const filesToUpload: Array<{ remotePath: string; content: string }> = [
            { remotePath: remoteFile, content },
        ]
        for (const extra of extraFiles) {
            if (extra.name && extra.content) {
                const safeName = path.basename(extra.name).replace(/[^a-zA-Z0-9_.\-]/g, '_')
                if (!safeName) { continue }
                filesToUpload.push({ remotePath: `${remoteLab}/${safeName}`, content: extra.content })
            }
        }

        const result = await _scpFiles(filesToUpload, [remoteLab])
        if (!result.ok) {
            return { ok: false, message: `Remote upload failed: ${result.message}` }
        }
        return { ok: true, message: `Uploaded to ${server.host}:${remoteFile}`, filePath: remoteFile }
    }

    // ── Local server: write to disk ─────────────────────────────────────────
    let labDir = String(obj['labDir'] ?? '').trim()
    if (labDir.startsWith('~/')) { labDir = path.join(os.homedir(), labDir.slice(2)) }
    if (!labDir) { labDir = path.join(os.homedir(), 'containerlab-labs') }

    try {
        const labPath  = path.join(labDir, labName)
        // Remove stale containerlab persistent directory so deploy uses fresh startup configs.
        // Without this, clab --reconfigure mounts the old config from the previous deploy.
        const clabDir = path.join(labPath, `clab-${labName}`)
        if (fs.existsSync(clabDir)) {
            fs.rmSync(clabDir, { recursive: true, force: true })
        }
        fs.mkdirSync(labPath, { recursive: true })
        const filePath = path.join(labPath, `${labName}.clab.yml`)
        fs.writeFileSync(filePath, content, 'utf8')

        // Write extra files (e.g. SONiC-VS startup config JSONs, FRR configs)
        for (const extra of extraFiles) {
            if (extra.name && extra.content) {
                // Sanitize filename: strip path separators to prevent directory traversal
                const safeName = path.basename(extra.name).replace(/[^a-zA-Z0-9_.\-]/g, '_')
                if (!safeName) { continue }
                const extraPath = path.join(labPath, safeName)
                fs.writeFileSync(extraPath, extra.content, 'utf8')
            }
        }

        return { ok: true, message: `Saved to ${filePath}`, filePath }
    } catch (err) {
        return { ok: false, message: `Failed to save topology: ${(err as Error).message}` }
    }
})

ipcMain.handle('clab-deploy', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const filePath = String(obj['filePath'] ?? '').trim()
    if (!filePath) {
        return { ok: false, message: 'Topology file path is required' }
    }

    const labName = path.basename(filePath, '.clab.yml')

    // ── Remote: use DOCKER_HOST to run containerlab Docker image against remote daemon
    if (_isRemote()) {
        const server = _activeServer()
        const command = _buildRemoteClabDockerCommand(`deploy --reconfigure -t "${filePath}"`, filePath, server)
        return _openClabTerminal(command, labName)
    }

    // ── Local: existing behavior ─────────────────────────────────────────
    if (!fs.existsSync(filePath)) {
        return { ok: false, message: 'Topology file not found' }
    }

    const clab = await _detectClabMode()
    let command: string

    if (clab.mode === 'binary') {
        const prefix = process.platform !== 'win32' ? 'sudo ' : ''
        command = `${prefix}${clab.bin} deploy --reconfigure -t "${filePath}"`
    } else if (clab.mode === 'docker-image') {
        command = _buildClabDockerCommand(`deploy --reconfigure -t "${filePath}"`, filePath)
    } else {
        return { ok: false, message: 'Containerlab not available. Click "Install" in the dialog first.' }
    }

    return _openClabTerminal(command, labName)
})

// ── Multi-server: save topology to a specific server ─────────────────────────
ipcMain.handle('clab-save-topology-to-server', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const content = String(obj['content'] ?? '')
    const labName = String(obj['labName'] ?? 'lab').replace(/[^a-zA-Z0-9_-]/g, '-')
    const serverId = String(obj['serverId'] ?? '')
    const extraFiles = Array.isArray(obj['extraFiles']) ? obj['extraFiles'] as Array<{ name: string; content: string }> : []

    const server = _getServerById(serverId)

    if (server.type === 'ssh') {
        // Remote server — upload via SFTP
        const remoteBase = server.remoteLabDir || '/tmp/containerlab-labs'
        const remoteLab = `${remoteBase}/${labName}`
        const remoteFile = `${remoteLab}/${labName}.clab.yml`

        const filesToUpload: Array<{ remotePath: string; content: string }> = [
            { remotePath: remoteFile, content },
        ]
        for (const extra of extraFiles) {
            if (extra.name && extra.content) {
                const safeName = path.basename(extra.name).replace(/[^a-zA-Z0-9_.\-]/g, '_')
                if (!safeName) { continue }
                filesToUpload.push({ remotePath: `${remoteLab}/${safeName}`, content: extra.content })
            }
        }

        const result = await _scpFiles(filesToUpload, [remoteLab], server)
        if (!result.ok) {
            return { ok: false, message: `Remote upload to ${server.name} failed: ${result.message}` }
        }
        return { ok: true, message: `Uploaded to ${server.host}:${remoteFile}`, filePath: remoteFile, serverId: server.id }
    }

    // Local server — write to disk
    const labDir = path.join(os.homedir(), 'containerlab-labs')
    try {
        const labPath = path.join(labDir, labName)
        fs.mkdirSync(labPath, { recursive: true })
        const filePath = path.join(labPath, `${labName}.clab.yml`)
        fs.writeFileSync(filePath, content, 'utf8')
        for (const extra of extraFiles) {
            if (extra.name && extra.content) {
                const safeName = path.basename(extra.name).replace(/[^a-zA-Z0-9_.\-]/g, '_')
                if (!safeName) { continue }
                fs.writeFileSync(path.join(labPath, safeName), extra.content, 'utf8')
            }
        }
        return { ok: true, message: `Saved to ${filePath}`, filePath, serverId: server.id }
    } catch (err) {
        return { ok: false, message: `Failed to save: ${(err as Error).message}` }
    }
})

// ── Multi-server: deploy to a specific server ────────────────────────────────
ipcMain.handle('clab-deploy-to-server', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const filePath = String(obj['filePath'] ?? '').trim()
    const serverId = String(obj['serverId'] ?? '')
    if (!filePath) {
        return { ok: false, message: 'Topology file path is required' }
    }

    const server = _getServerById(serverId)
    const labName = path.basename(filePath, '.clab.yml')

    if (server.type === 'ssh') {
        // Remote: use DOCKER_HOST to run containerlab Docker image against remote daemon
        const command = _buildRemoteClabDockerCommand(`deploy --reconfigure -t "${filePath}"`, filePath, server)
        return _openClabTerminal(command, `${labName}-${server.name}`)
    }

    // Local: existing binary / docker-image approach
    if (!fs.existsSync(filePath)) {
        return { ok: false, message: 'Topology file not found' }
    }

    const clab = await _detectClabMode()
    let command: string

    if (clab.mode === 'binary') {
        const prefix = process.platform !== 'win32' ? 'sudo ' : ''
        command = `${prefix}${clab.bin} deploy --reconfigure -t "${filePath}"`
    } else if (clab.mode === 'docker-image') {
        command = _buildClabDockerCommand(`deploy --reconfigure -t "${filePath}"`, filePath)
    } else {
        return { ok: false, message: 'Containerlab not available on local server' }
    }

    return _openClabTerminal(command, `${labName}-${server.name}`)
})

ipcMain.handle('clab-destroy', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const filePath = String(obj['filePath'] ?? '').trim()
    if (!filePath) {
        return { ok: false, message: 'Topology file path is required' }
    }

    const labName = path.basename(filePath, '.clab.yml')

    // ── Remote: use DOCKER_HOST to run containerlab Docker image against remote daemon
    if (_isRemote()) {
        const server = _activeServer()
        const command = _buildRemoteClabDockerCommand(`destroy -t "${filePath}"`, filePath, server)
        return _openClabTerminal(command, labName)
    }

    // ── Local: existing behavior ─────────────────────────────────────────
    if (!fs.existsSync(filePath)) {
        return { ok: false, message: 'Topology file not found' }
    }

    const clab = await _detectClabMode()
    let command: string

    if (clab.mode === 'binary') {
        const prefix = process.platform !== 'win32' ? 'sudo ' : ''
        command = `${prefix}${clab.bin} destroy -t "${filePath}"`
    } else if (clab.mode === 'docker-image') {
        command = _buildClabDockerCommand(`destroy -t "${filePath}"`, filePath)
    } else {
        return { ok: false, message: 'Containerlab not available' }
    }

    return _openClabTerminal(command, labName)
})

ipcMain.handle('clab-destroy-lab', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const labName = String(obj['labName'] ?? '').trim()
    if (!labName) {
        return { ok: false, message: 'Lab name is required' }
    }

    try {
        const dockerEnv = _dockerEnv() as NodeJS.ProcessEnv
        // Find all containers belonging to this lab
        const psResult = await _spawnAsync('docker', [
            'ps', '-a',
            '--filter', `label=containerlab=${labName}`,
            '--format', '{{.ID}}',
        ], { timeout: 10_000, env: dockerEnv })

        const ids = (psResult.stdout || '').trim().split('\n').filter(Boolean)
        if (!ids.length) {
            return { ok: true, message: `No containers found for lab "${labName}"` }
        }

        // Stop all containers first
        await _spawnAsync('docker', ['stop', ...ids], {
            timeout: 60_000, env: dockerEnv,
        })

        // Then remove them
        const rmResult = await _spawnAsync('docker', ['rm', '-f', ...ids], {
            timeout: 30_000, env: dockerEnv,
        })

        // Also clean up the Docker network if it exists (clab-<labName>)
        await _spawnAsync('docker', ['network', 'rm', `clab-${labName}`], {
            timeout: 10_000, env: dockerEnv,
        })

        if (rmResult.status === 0) {
            return { ok: true, message: `Destroyed ${ids.length} container(s) for lab "${labName}"` }
        }

        return { ok: false, message: rmResult.stderr?.trim() || `Failed to remove containers for "${labName}"` }
    } catch (err) {
        return { ok: false, message: `Destroy failed: ${(err as Error).message}` }
    }
})

// ── Container logs (stream in terminal) ─────────────────────────────────────

ipcMain.handle('clab-container-logs', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const containerName = String(obj['container'] ?? '').trim()
    if (!containerName) {
        return { ok: false, message: 'Container name required' }
    }

    // Build docker logs command — uses DOCKER_HOST for remote
    const isWin = process.platform === 'win32'
    const envVars: string[] = []
    const dockerEnv = _dockerEnv()
    if (dockerEnv['DOCKER_HOST']) {
        if (isWin) {
            envVars.push(`set "DOCKER_HOST=${dockerEnv['DOCKER_HOST']}"`)
        } else {
            envVars.push(`DOCKER_HOST="${dockerEnv['DOCKER_HOST']}"`)
        }
    }
    if (dockerEnv['SSH_ASKPASS']) {
        if (isWin) {
            envVars.push(`set "TLINK_SSH_PASSWORD=${dockerEnv['TLINK_SSH_PASSWORD'] ?? ''}"`)
            envVars.push(`set "SSH_ASKPASS=${dockerEnv['SSH_ASKPASS']}"`)
            envVars.push(`set "SSH_ASKPASS_REQUIRE=force"`)
        } else {
            envVars.push(`TLINK_SSH_PASSWORD="${dockerEnv['TLINK_SSH_PASSWORD'] ?? ''}"`)
            envVars.push(`SSH_ASKPASS="${dockerEnv['SSH_ASKPASS']}"`)
            envVars.push(`SSH_ASKPASS_REQUIRE="force"`)
            envVars.push(`DISPLAY="${dockerEnv['DISPLAY'] || ':0'}"`)
        }
    }

    const envPrefix = envVars.length > 0
        ? (isWin ? envVars.join(' && ') + ' && ' : envVars.join(' ') + ' ')
        : ''

    // docker logs may be empty for some containers (e.g. SONiC-VS).
    // Show last 200 lines, then follow. If no output after 3s, show a hint.
    const command = `${envPrefix}docker logs --tail 200 "${containerName}" 2>&1; echo ""; echo "--- Streaming live logs (Ctrl+C to stop) ---"; ${envPrefix}docker logs -f --tail 0 "${containerName}"`
    return _openClabTerminal(command, `logs-${containerName}`)
})

// ── Read topology file for diff ─────────────────────────────────────────────

ipcMain.handle('clab-read-topology-file', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const filePath = String(obj['filePath'] ?? '').trim()
    if (!filePath) { return { ok: false, message: 'No file path' } }
    try {
        const content = fs.readFileSync(filePath, 'utf8')
        return { ok: true, content }
    } catch (err) {
        return { ok: false, message: `Read failed: ${(err as Error).message}` }
    }
})

// ── Lab Snapshots ───────────────────────────────────────────────────────────

ipcMain.handle('clab-snapshot-create', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const containers = obj['containers'] as string[] | undefined
    const snapshotName = String(obj['snapshotName'] ?? `snap-${Date.now()}`).trim()
    if (!Array.isArray(containers) || containers.length === 0) {
        return { ok: false, message: 'No containers specified' }
    }
    const results: Array<{ container: string; image: string; ok: boolean; message: string }> = []
    for (const ctn of containers) {
        const name = String(ctn).trim()
        if (!name) { continue }
        const imageName = `${name}:${snapshotName}`
        try {
            const r = spawnSync('docker', ['commit', name, imageName], {
                stdio: 'pipe', encoding: 'utf8', timeout: 60_000, env: _dockerEnv(),
            })
            if (r.status === 0) {
                results.push({ container: name, image: imageName, ok: true, message: 'Committed' })
            } else {
                results.push({ container: name, image: imageName, ok: false, message: r.stderr?.trim() || 'commit failed' })
            }
        } catch (err) {
            results.push({ container: name, image: imageName, ok: false, message: (err as Error).message })
        }
    }
    const failed = results.filter(r => !r.ok)
    return { ok: failed.length === 0, message: `Committed ${results.length - failed.length}/${results.length}`, results }
})

ipcMain.handle('clab-snapshot-list', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const prefix = String(obj['prefix'] ?? '').trim()
    try {
        const r = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}'], {
            stdio: 'pipe', encoding: 'utf8', timeout: 15_000, env: _dockerEnv(),
        })
        if (r.status !== 0) { return { ok: false, message: r.stderr?.trim() || 'list failed', snapshots: [] } }
        const lines = (r.stdout || '').trim().split('\n').filter(Boolean)
        const snapshots = lines
            .map(line => {
                const parts = line.split('\t')
                return { image: parts[0] || '', size: parts[1] || '', created: parts[2] || '' }
            })
            .filter(s => s.image.includes(':snap-'))
        return { ok: true, snapshots }
    } catch (err) {
        return { ok: false, message: (err as Error).message, snapshots: [] }
    }
})

// ── SFTP File Browser ───────────────────────────────────────────────────────

ipcMain.handle('sftp-list-dir', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const dirPath = String(obj['path'] ?? '/').trim()
    const server = _activeServer()
    if (!server || server.type === 'local') {
        // Local directory listing
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            const items = entries.map(e => ({
                name: e.name,
                isDir: e.isDirectory(),
                size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : 0,
            }))
            return { ok: true, items }
        } catch (err) {
            return { ok: false, message: `Read dir failed: ${(err as Error).message}` }
        }
    }
    // SSH / SFTP
    return new Promise(resolve => {
        const conn = new Client()
        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) { conn.end(); return resolve({ ok: false, message: err.message }) }
                sftp.readdir(dirPath, (err2, list) => {
                    conn.end()
                    if (err2) { return resolve({ ok: false, message: err2.message }) }
                    const items = (list || []).map(f => ({
                        name: f.filename,
                        isDir: (f.attrs.mode! & 0o40000) !== 0,
                        size: f.attrs.size ?? 0,
                    }))
                    resolve({ ok: true, items })
                })
            })
        })
        conn.on('error', (e) => resolve({ ok: false, message: e.message }))
        conn.connect(_ssh2ConnectOpts(server))
    })
})

ipcMain.handle('sftp-read-file', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const filePath = String(obj['path'] ?? '').trim()
    if (!filePath) { return { ok: false, message: 'No path' } }
    const server = _activeServer()
    if (!server || server.type === 'local') {
        try {
            const content = fs.readFileSync(filePath, 'utf8')
            return { ok: true, content }
        } catch (err) { return { ok: false, message: (err as Error).message } }
    }
    return new Promise(resolve => {
        const conn = new Client()
        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) { conn.end(); return resolve({ ok: false, message: err.message }) }
                let data = ''
                const stream = sftp.createReadStream(filePath, { encoding: 'utf8' })
                stream.on('data', (chunk: string) => { data += chunk })
                stream.on('end', () => { conn.end(); resolve({ ok: true, content: data }) })
                stream.on('error', (e: Error) => { conn.end(); resolve({ ok: false, message: e.message }) })
            })
        })
        conn.on('error', (e) => resolve({ ok: false, message: e.message }))
        conn.connect(_ssh2ConnectOpts(server))
    })
})

ipcMain.handle('sftp-delete-file', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const filePath = String(obj['path'] ?? '').trim()
    if (!filePath) { return { ok: false, message: 'No path' } }
    const server = _activeServer()
    if (!server || server.type === 'local') {
        try { fs.unlinkSync(filePath); return { ok: true } } catch (err) { return { ok: false, message: (err as Error).message } }
    }
    return new Promise(resolve => {
        const conn = new Client()
        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) { conn.end(); return resolve({ ok: false, message: err.message }) }
                sftp.unlink(filePath, (err2) => {
                    conn.end()
                    if (err2) { return resolve({ ok: false, message: err2.message }) }
                    resolve({ ok: true })
                })
            })
        })
        conn.on('error', (e) => resolve({ ok: false, message: e.message }))
        conn.connect(_ssh2ConnectOpts(server))
    })
})

// ── Packet Capture ──────────────────────────────────────────────────────────

const _captureProcesses = new Map<string, ReturnType<typeof spawn>>()

ipcMain.handle('clab-start-capture', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const container = String(obj['container'] ?? '').trim()
    const iface = String(obj['iface'] ?? 'any').trim()
    const count = Math.min(1000, Math.max(10, Number(obj['count'] ?? 200)))
    if (!container) { return { ok: false, message: 'No container name' } }
    const captureId = `${container}-${iface}-${Date.now()}`
    try {
        const proc = spawn('docker', ['exec', container, 'tcpdump', '-i', iface, '-c', String(count), '-nn', '-l'], {
            stdio: 'pipe', env: _dockerEnv(),
        })
        _captureProcesses.set(captureId, proc)
        const handleData = (chunk: Buffer) => {
            const lines = chunk.toString().split(/\r?\n/).filter(Boolean)
            for (const line of lines) {
                for (const [, win] of windows) {
                    try { win.webContents.send('capture-data', { captureId, line }) } catch { /* ignore */ }
                }
            }
        }
        proc.stdout?.on('data', handleData)
        proc.stderr?.on('data', handleData)
        proc.on('close', () => {
            _captureProcesses.delete(captureId)
            for (const [, win] of windows) {
                try { win.webContents.send('capture-data', { captureId, line: '__CAPTURE_DONE__' }) } catch { /* ignore */ }
            }
        })
        proc.on('error', () => { _captureProcesses.delete(captureId) })
        return { ok: true, captureId }
    } catch (err) {
        return { ok: false, message: `Capture failed: ${(err as Error).message}` }
    }
})

ipcMain.handle('clab-stop-capture', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const captureId = String(obj['captureId'] ?? '').trim()
    const proc = _captureProcesses.get(captureId)
    if (proc) { proc.kill(); _captureProcesses.delete(captureId) }
    return { ok: true }
})

// ── Container start / stop / suspend (pause/unpause) ────────────────────────

ipcMain.handle('clab-container-start', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const container = String(obj['container'] ?? '').trim()
    if (!container) { return { ok: false, message: 'No container name specified' } }
    try {
        const r = spawnSync('docker', ['start', container], {
            stdio: 'pipe', encoding: 'utf8', timeout: 15_000, env: _dockerEnv(),
        })
        if (r.status !== 0) {
            return { ok: false, message: r.stderr?.trim() || 'docker start failed' }
        }
        return { ok: true }
    } catch (err) { return { ok: false, message: (err as Error).message } }
})

ipcMain.handle('clab-container-stop', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const container = String(obj['container'] ?? '').trim()
    if (!container) { return { ok: false, message: 'No container name specified' } }
    try {
        const r = spawnSync('docker', ['stop', container], {
            stdio: 'pipe', encoding: 'utf8', timeout: 30_000, env: _dockerEnv(),
        })
        if (r.status !== 0) {
            return { ok: false, message: r.stderr?.trim() || 'docker stop failed' }
        }
        return { ok: true }
    } catch (err) { return { ok: false, message: (err as Error).message } }
})

ipcMain.handle('clab-container-suspend', async (_event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const container = String(obj['container'] ?? '').trim()
    const suspend = obj['suspend'] !== false
    try {
        const cmd = suspend ? 'pause' : 'unpause'
        const r = spawnSync('docker', [cmd, container], {
            stdio: 'pipe', encoding: 'utf8', timeout: 15_000, env: _dockerEnv(),
        })
        if (r.status !== 0) {
            return { ok: false, message: r.stderr?.trim() || `docker ${cmd} failed` }
        }
        return { ok: true }
    } catch (err) { return { ok: false, message: (err as Error).message } }
})

// ── Embedded terminal (PTY) ─────────────────────────────────────────────────

ipcMain.handle('pty-create', async (event, rawPayload: unknown) => {
    const obj = (rawPayload && typeof rawPayload === 'object') ? rawPayload as Record<string, unknown> : {}
    const id = String(obj['id'] ?? '').trim()
    const label = String(obj['label'] ?? 'Terminal')
    const command = obj['command'] ? String(obj['command']) : undefined
    const args = Array.isArray(obj['args']) ? (obj['args'] as unknown[]).map(String) : []
    const cwd = obj['cwd'] ? String(obj['cwd']) : undefined
    const env = (obj['env'] && typeof obj['env'] === 'object') ? obj['env'] as Record<string, string> : undefined
    const cols = typeof obj['cols'] === 'number' ? obj['cols'] : 80
    const rows = typeof obj['rows'] === 'number' ? obj['rows'] : 24
    if (!id) { return { ok: false, message: 'Session id required' } }
    try {
        ptyManager.createSession({ id, label, command, args, cwd, env, cols, rows, sender: event.sender })
        return { ok: true, sessionId: id }
    } catch (err) {
        return { ok: false, message: (err as Error).message }
    }
})

ipcMain.on('pty-input', (_event, sessionId: string, data: string) => {
    ptyManager.writeToSession(sessionId, data)
})

ipcMain.on('pty-resize', (_event, sessionId: string, cols: number, rows: number) => {
    ptyManager.resizeSession(sessionId, cols, rows)
})

ipcMain.handle('pty-destroy', async (_event, sessionId: string) => {
    ptyManager.destroySession(sessionId)
    return { ok: true }
})

ipcMain.handle('clab-parse-topology', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const filePath = String(obj['filePath'] ?? '').trim()
    if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, message: `Topology file not found: ${filePath}` }
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8')
        const lines = content.split('\n')

        let labName = ''
        const nodes: Array<{ name: string; kind: string; image: string; labels?: Record<string, string> }> = []
        const links: Array<{ srcNode: string; srcPort: string; tgtNode: string; tgtPort: string }> = []

        // Simple line-by-line YAML parser for containerlab topology format
        let section = ''       // 'kinds' | 'nodes' | 'links' | 'mgmt'
        let currentNode = ''
        let currentKind = ''
        let inLabels = false
        const kindImageMap: Record<string, string> = {}

        for (const line of lines) {
            const trimmed = line.trimEnd()
            if (!trimmed || trimmed.startsWith('#')) { continue }

            // Top-level: name
            const nameMatch = trimmed.match(/^name:\s*(.+)/)
            if (nameMatch) { labName = nameMatch[1].trim(); continue }

            // Section detection (under topology:)
            if (trimmed === 'topology:') { continue }
            if (/^\s{2}kinds:\s*$/.test(trimmed))  { section = 'kinds'; currentNode = ''; continue }
            if (/^\s{2}nodes:\s*$/.test(trimmed))  { section = 'nodes'; currentNode = ''; continue }
            if (/^\s{2}links:\s*$/.test(trimmed))  { section = 'links'; currentNode = ''; continue }
            if (/^\s{2}mgmt:\s*$/.test(trimmed))   { section = 'mgmt'; currentNode = ''; continue }

            if (section === 'kinds') {
                // 4-space indent = kind name, 6-space indent = kind property
                const kindNameMatch = trimmed.match(/^\s{4}(\S+):\s*$/)
                if (kindNameMatch) { currentKind = kindNameMatch[1]; continue }
                const kindImageMatch = trimmed.match(/^\s{6}image:\s*(.+)/)
                if (kindImageMatch && currentKind) { kindImageMap[currentKind] = kindImageMatch[1].trim(); continue }
            }

            if (section === 'nodes') {
                // 4-space indent = node name, 6-space indent = node property
                const nodeNameMatch = trimmed.match(/^\s{4}(\S+):\s*$/)
                if (nodeNameMatch) { currentNode = nodeNameMatch[1]; inLabels = false; nodes.push({ name: currentNode, kind: '', image: '' }); continue }

                // Detect labels sub-section (6-space indent)
                if (/^\s{6}labels:\s*$/.test(trimmed) && currentNode) { inLabels = true; continue }

                // Parse label key-value pairs (8-space indent)
                if (inLabels && currentNode) {
                    const labelMatch = trimmed.match(/^\s{8}([\w-]+):\s*"?([^"]*)"?\s*$/)
                    if (labelMatch) {
                        const n = nodes.find(nd => nd.name === currentNode)
                        if (n) {
                            if (!n.labels) { n.labels = {} }
                            n.labels[labelMatch[1]] = labelMatch[2]
                        }
                        continue
                    }
                    // Non-label line at 6-space indent = end of labels
                    if (/^\s{6}\S/.test(trimmed)) { inLabels = false }
                }

                const kindMatch = trimmed.match(/^\s{6}kind:\s*(\S+)/)
                if (kindMatch && currentNode) {
                    const n = nodes.find(nd => nd.name === currentNode)
                    if (n) { n.kind = kindMatch[1] }
                    continue
                }
                const imageMatch = trimmed.match(/^\s{6}image:\s*(.+)/)
                if (imageMatch && currentNode) {
                    const n = nodes.find(nd => nd.name === currentNode)
                    if (n) { n.image = imageMatch[1].trim() }
                    continue
                }
            }

            if (section === 'links') {
                const endpointsMatch = trimmed.match(/endpoints:\s*\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/)
                if (endpointsMatch) {
                    const [, src, tgt] = endpointsMatch
                    const [srcNode, srcPort] = src.split(':')
                    const [tgtNode, tgtPort] = tgt.split(':')
                    links.push({ srcNode, srcPort, tgtNode, tgtPort })
                }
            }
        }

        // Fill in images from kinds map where not explicitly set on node
        for (const n of nodes) {
            if (!n.image && n.kind && kindImageMap[n.kind]) {
                n.image = kindImageMap[n.kind]
            }
        }

        return { ok: true, labName, nodes, links }
    } catch (err) {
        return { ok: false, message: `Parse failed: ${(err as Error).message}` }
    }
})

ipcMain.handle('clab-detect-running', async () => {
    try {
        const dockerEnv = _dockerEnv()
        // Find ALL containerlab containers (any lab)
        const psResult = await _spawnAsync('docker', [
            'ps', '-a',
            '--filter', 'label=containerlab',
            '--format', '{{.ID}}',
        ], { timeout: 10_000, env: dockerEnv })

        if (psResult.status !== 0 || !psResult.stdout.trim()) {
            return { ok: true, labs: [] }
        }

        const ids = psResult.stdout.trim().split('\n').filter(Boolean)
        if (!ids.length) { return { ok: true, labs: [] } }

        const jsonResult = await _spawnAsync('docker', ['inspect', ...ids], {
            timeout: 15_000, env: dockerEnv,
        })

        if (jsonResult.status !== 0) {
            return { ok: false, message: 'docker inspect failed', labs: [] }
        }

        const inspected = JSON.parse(jsonResult.stdout)

        // Group containers by lab name
        const labMap = new Map<string, Array<{
            name: string; state: string; ipv4Address: string; ipv6Address: string; kind: string; image: string
        }>>()

        for (const c of inspected) {
            const name = String(c.Name ?? '').replace(/^\//, '')
            const state = String(c.State?.Status ?? '')
            const image = String(c.Config?.Image ?? '')
            const labels = c.Config?.Labels ?? {}
            const labName = String(labels['containerlab'] ?? '')
            const kind = String(labels['clab-node-kind'] ?? '')
            const topoFile = String(labels['clab-topo-file'] ?? '')

            let ipv4 = ''
            let ipv6 = ''
            const networks = c.NetworkSettings?.Networks ?? {}
            for (const net of Object.values(networks) as any[]) {
                if (net.IPAddress) { ipv4 = ipv4 || net.IPAddress }
                if (net.GlobalIPv6Address) { ipv6 = ipv6 || net.GlobalIPv6Address }
            }

            if (!labMap.has(labName)) { labMap.set(labName, []) }
            labMap.get(labName)!.push({ name, state, ipv4Address: ipv4, ipv6Address: ipv6, kind, image })
        }

        const labs = Array.from(labMap.entries()).map(([labName, containers]) => {
            // Try to find the topology file from the first container's labels
            const firstContainer = inspected.find((c: any) =>
                String(c.Config?.Labels?.['containerlab'] ?? '') === labName
            )
            const topoFile = String(firstContainer?.Config?.Labels?.['clab-topo-file'] ?? '')

            return { labName, topoFile, containers }
        })

        const srv = _activeServer()
        return { ok: true, labs, server: { id: srv.id, name: srv.name, type: srv.type, host: srv.host } }
    } catch (err) {
        return { ok: false, message: `Detection failed: ${(err as Error).message}`, labs: [] }
    }
})

ipcMain.handle('clab-inspect', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload', containers: [] }
    }
    const obj = rawPayload as Record<string, unknown>
    const filePath = String(obj['filePath'] ?? '').trim()
    if (!filePath) {
        return { ok: false, message: 'Topology file path is required', containers: [] }
    }

    // Derive lab name from file path (e.g. "sonic-dual-dc-bgp-peering" from "sonic-dual-dc-bgp-peering.clab.yml")
    const labName = path.basename(filePath, '.clab.yml')

    try {
        const dockerEnv = _dockerEnv()
        // Use docker ps directly — works on all platforms without Docker-in-Docker issues
        const psResult = await _spawnAsync('docker', [
            'ps', '-a',
            '--filter', `label=containerlab=${labName}`,
            '--format', '{{.ID}}',
        ], { timeout: 10_000, env: dockerEnv })

        if (psResult.status !== 0) {
            return { ok: false, message: psResult.stderr?.trim() || 'docker ps failed', containers: [] }
        }

        const ids = psResult.stdout.trim().split('\n').filter(Boolean)
        if (!ids.length) {
            return { ok: true, message: 'No containers found for this lab', containers: [] }
        }

        // Inspect each container for detailed info (not used below but kept for compat)
        await _spawnAsync('docker', [
            'inspect', '--format',
            '{{.Name}}\t{{.State.Status}}\t{{.Config.Image}}\t{{.Config.Labels}}',
            ...ids,
        ], { timeout: 15_000, env: dockerEnv })

        // Also get IPs via docker inspect JSON
        const jsonResult = await _spawnAsync('docker', ['inspect', ...ids], {
            timeout: 15_000, env: dockerEnv,
        })

        const containers: Array<{ name: string; state: string; ipv4Address: string; ipv6Address: string; kind: string; image: string }> = []

        if (jsonResult.status === 0) {
            try {
                const inspected = JSON.parse(jsonResult.stdout)
                for (const c of inspected) {
                    const name = String(c.Name ?? '').replace(/^\//, '')
                    const state = String(c.State?.Status ?? '')
                    const image = String(c.Config?.Image ?? '')
                    const labels = c.Config?.Labels ?? {}
                    const kind = String(labels['clab-node-kind'] ?? '')

                    // Extract IPv4 from the containerlab management network
                    let ipv4 = ''
                    let ipv6 = ''
                    const networks = c.NetworkSettings?.Networks ?? {}
                    for (const net of Object.values(networks) as any[]) {
                        if (net.IPAddress) { ipv4 = ipv4 || net.IPAddress }
                        if (net.GlobalIPv6Address) { ipv6 = ipv6 || net.GlobalIPv6Address }
                    }

                    containers.push({ name, state, ipv4Address: ipv4, ipv6Address: ipv6, kind, image })
                }
            } catch {
                // fall through to return whatever we have
            }
        }

        return { ok: true, message: `Found ${containers.length} containers`, containers }
    } catch (err) {
        return { ok: false, message: `Inspect failed: ${(err as Error).message}`, containers: [] }
    }
})

// ── Live topology status polling ────────────────────────────────────────────

/** Check if a containerlab kind is a Junos-based kind (crpd or vrnetlab VMs) */
function _isJunosKind (kind: string): boolean {
    return kind === 'crpd' || kind === 'juniper_vqfx' || kind === 'juniper_vjunosswitch' || kind === 'juniper_vjunosrouter' || kind === 'juniper_vjunosevolved'
}

function _bgpSummaryCommand (kind: string): string[] | null {
    switch (kind) {
        case 'sonic-vs':
        case 'sonic':
            return ['vtysh', '-c', 'show bgp summary json']
        case 'ceos':
            return ['Cli', '-p', '15', '-c', 'show bgp summary | json']
        case 'srl':
            return ['sr_cli', '-d', 'show network-instance default protocols bgp neighbor']
        case 'crpd':
        case 'juniper_vqfx':
        case 'juniper_vjunosswitch':
        case 'juniper_vjunosrouter':
        case 'juniper_vjunosevolved':
            return ['cli', '-c', 'show bgp summary']
        case 'huawei_ne':
        case 'huawei':
            return ['display', 'bgp', 'peer']
        case 'xrd':
        case 'xrv9k':
        case 'cisco_xrv':
            return ['show', 'bgp', 'summary']
        default:
            return null
    }
}

/** SR-MPLS label binding / SRv6 locator status command per vendor */
function _srStatusCommand (kind: string): string[] | null {
    switch (kind) {
        case 'sonic-vs':
        case 'sonic':
            return ['vtysh', '-c', 'show mpls table']
        case 'ceos':
            return ['Cli', '-p', '15', '-c', 'show mpls label range']
        case 'srl':
            return ['sr_cli', '-d', 'show network-instance default segment-routing mpls']
        case 'crpd':
        case 'juniper_vqfx':
        case 'juniper_vjunosrouter':
            return ['cli', '-c', 'show route table mpls.0']
        case 'xrd':
        case 'xrv9k':
            return ['show', 'mpls', 'forwarding']
        default:
            return null
    }
}

/** VNI / VTEP status command for EVPN-VXLAN */
function _vniStatusCommand (kind: string): string[] | null {
    switch (kind) {
        case 'sonic-vs':
        case 'sonic':
            return ['vtysh', '-c', 'show evpn vni json']
        case 'ceos':
            return ['Cli', '-p', '15', '-c', 'show vxlan vni | json']
        case 'srl':
            return ['sr_cli', '-d', 'show tunnel-interface vxlan1 vxlan-interface 0']
        case 'crpd':
        case 'juniper_vqfx':
        case 'juniper_vjunosswitch':
            return ['cli', '-c', 'show ethernet-switching vxlan-tunnel-end-point remote']
        default:
            return null
    }
}

interface SrVniStatus {
    srEnabled: boolean
    srLabelsCount: number
    vniActive: number
}

function _parseSrStatus (kind: string, stdout: string): { srEnabled: boolean; labelsCount: number } {
    if (!stdout || !stdout.trim()) { return { srEnabled: false, labelsCount: 0 } }
    try {
        if (kind === 'sonic-vs' || kind === 'sonic') {
            // vtysh "show mpls table" — count label entries (each label is a line with numeric prefix)
            const labels = stdout.split('\n').filter(l => /^\s*\d+\s/.test(l))
            return { srEnabled: labels.length > 0, labelsCount: labels.length }
        }
        // Generic: any numeric-looking label entries
        const labels = stdout.split('\n').filter(l => /\b(1[6-9]\d{3}|2\d{4})\b/.test(l))
        return { srEnabled: labels.length > 0, labelsCount: labels.length }
    } catch { return { srEnabled: false, labelsCount: 0 } }
}

/** Simple promise-throttling helper — limits N concurrent promises. */
async function _runWithConcurrency<T> (tasks: Array<() => Promise<T>>, limit: number): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = new Array(tasks.length)
    if (tasks.length === 0) { return results }
    // Clamp limit to [1, tasks.length] — ensures at least 1 worker and never more than needed
    const workerCount = Math.max(1, Math.min(limit, tasks.length))
    let idx = 0
    const workers: Promise<void>[] = []
    const runWorker = async (): Promise<void> => {
        while (idx < tasks.length) {
            const current = idx++
            try {
                const value = await tasks[current]()
                results[current] = { status: 'fulfilled', value }
            } catch (reason) {
                results[current] = { status: 'rejected', reason }
            }
        }
    }
    for (let i = 0; i < workerCount; i++) { workers.push(runWorker()) }
    await Promise.all(workers)
    return results
}

function _parseVniStatus (kind: string, stdout: string): number {
    if (!stdout || !stdout.trim()) { return 0 }
    try {
        if (kind === 'sonic-vs' || kind === 'sonic') {
            // Parse FRR EVPN VNI JSON output
            const parsed = JSON.parse(stdout.trim())
            return typeof parsed === 'object' ? Object.keys(parsed).length : 0
        }
        // Generic: count lines mentioning VNI
        const vniLines = stdout.split('\n').filter(l => /\bvni\b/i.test(l) && /\d{4,}/.test(l))
        return vniLines.length
    } catch { return 0 }
}

interface ParsedBgpNeighbor {
    neighborIp: string
    state: string
    asn: number
    prefixCount: number
}

function _parseBgpSummary (kind: string, stdout: string): ParsedBgpNeighbor[] {
    const neighbors: ParsedBgpNeighbor[] = []

    if (kind === 'sonic-vs' || kind === 'sonic') {
        // FRR JSON format: { "ipv4Unicast": { "peers": { "10.10.1.0": { "state": "Established", ... } } } }
        try {
            const json = JSON.parse(stdout)
            // FRR may wrap in address families or have a flat peers object
            const afs = ['ipv4Unicast', 'ipv6Unicast', 'l2VpnEvpn']
            for (const af of afs) {
                const peers = json[af]?.peers ?? json?.peers
                if (!peers || typeof peers !== 'object') { continue }
                for (const [ip, data] of Object.entries(peers)) {
                    const d = data as Record<string, unknown>
                    const rawState = String(d['state'] ?? d['bgpState'] ?? 'unknown')
                    neighbors.push({
                        neighborIp: ip,
                        state: rawState.toLowerCase().replace(/\s+/g, ''),
                        asn: Number(d['remoteAs'] ?? d['peerAs'] ?? 0),
                        prefixCount: Number(d['pfxRcd'] ?? d['prefixReceivedCount'] ?? 0),
                    })
                }
                if (neighbors.length > 0) { break }
            }
            // Also check top-level peers (FRR sometimes uses this format)
            if (neighbors.length === 0 && json.peers) {
                for (const [ip, data] of Object.entries(json.peers)) {
                    const d = data as Record<string, unknown>
                    const rawState = String(d['state'] ?? d['bgpState'] ?? 'unknown')
                    neighbors.push({
                        neighborIp: ip,
                        state: rawState.toLowerCase().replace(/\s+/g, ''),
                        asn: Number(d['remoteAs'] ?? d['peerAs'] ?? 0),
                        prefixCount: Number(d['pfxRcd'] ?? d['prefixReceivedCount'] ?? 0),
                    })
                }
            }
        } catch { /* JSON parse failed — ignore */ }
    } else if (kind === 'ceos') {
        // Arista JSON format: { "vrfs": { "default": { "peers": { ... } } } }
        try {
            const json = JSON.parse(stdout)
            const peers = json?.vrfs?.default?.peers ?? json?.peers
            if (peers && typeof peers === 'object') {
                for (const [ip, data] of Object.entries(peers)) {
                    const d = data as Record<string, unknown>
                    const rawState = String(d['peerState'] ?? d['state'] ?? 'unknown')
                    neighbors.push({
                        neighborIp: ip,
                        state: rawState.toLowerCase().replace(/\s+/g, ''),
                        asn: Number(d['asn'] ?? d['peerAsn'] ?? 0),
                        prefixCount: Number(d['prefixReceived'] ?? d['prefixAccepted'] ?? 0),
                    })
                }
            }
        } catch { /* JSON parse failed — ignore */ }
    } else if (kind === 'srl' || _isJunosKind(kind)) {
        // Text-based parsing — look for lines with IP addresses and state keywords
        const lines = stdout.split('\n')
        // Common pattern: <IP>  <ASN>  <state>  <uptime>  <prefixes>
        const ipRe = /(\d+\.\d+\.\d+\.\d+|[0-9a-fA-F:]+(?:::[0-9a-fA-F]+)+)/
        // JunOS truncates "Established" to "Establ" in column output
        const statePatterns: Array<[string, string]> = [
            ['establ', 'established'],
            ['active', 'active'],
            ['connect', 'connect'],
            ['idle', 'idle'],
            ['openconfirm', 'openconfirm'],
            ['opensent', 'opensent'],
        ]
        for (const line of lines) {
            const ipMatch = line.match(ipRe)
            if (!ipMatch) { continue }
            const lower = line.toLowerCase()
            let state = 'unknown'
            for (const [pattern, name] of statePatterns) {
                if (lower.includes(pattern)) { state = name; break }
            }
            if (state === 'unknown' && !lower.includes('neighbor')) { continue }
            const asnMatch = line.match(/\b(\d{4,6})\b/)
            neighbors.push({
                neighborIp: ipMatch[1],
                state,
                asn: asnMatch ? Number(asnMatch[1]) : 0,
                prefixCount: 0,
            })
        }
    }

    return neighbors
}

ipcMain.handle('clab-poll-live-status', async (_event, rawPayload: unknown) => {
    const obj = (typeof rawPayload === 'object' && rawPayload !== null)
        ? rawPayload as Record<string, unknown> : {}
    const containers = Array.isArray(obj['containers'])
        ? obj['containers'] as Array<{ name: string; kind: string }> : []

    if (!containers.length) { return { ok: false, message: 'No containers', containers: [] } }

    const dockerEnv = _dockerEnv()

    // Step 1: async docker inspect all containers at once for state
    const ids = containers.map(c => c.name)
    const inspectResult = await _spawnAsync('docker', [
        'inspect', '--format', '{{.Name}}|{{.State.Status}}', ...ids,
    ], { timeout: 10_000, env: dockerEnv })

    const stateMap = new Map<string, string>()
    if (inspectResult.stdout) {
        for (const line of inspectResult.stdout.trim().split('\n')) {
            if (!line.includes('|')) { continue }
            const sepIdx = line.lastIndexOf('|')
            const rawName = line.slice(0, sepIdx)
            const state = line.slice(sepIdx + 1)
            const name = rawName.startsWith('/') ? rawName.slice(1) : rawName
            stateMap.set(name, state)
        }
    }

    // Step 2: For running network containers, get BGP + SR + VNI with concurrency limiting
    // (prevents overloading Docker daemon with 60+ simultaneous exec calls on large labs)
    const results: Array<{ containerName: string; state: string; bgpNeighbors: ParsedBgpNeighbor[]; srEnabled?: boolean; srLabelsCount?: number; vniActive?: number }> = []
    type TaskMeta = { idx: number; type: 'bgp' | 'sr' | 'vni'; kind: string }
    const tasks: Array<() => Promise<{ stdout: string }>> = []
    const taskMeta: TaskMeta[] = []

    for (let i = 0; i < containers.length; i++) {
        const c = containers[i]
        const state = stateMap.get(c.name) ?? 'unknown'
        results.push({ containerName: c.name, state, bgpNeighbors: [] })

        if (state === 'running') {
            const bgpCmd = _bgpSummaryCommand(c.kind)
            if (bgpCmd) {
                tasks.push(() => _spawnAsync('docker', ['exec', c.name, ...bgpCmd], { timeout: 15_000, env: dockerEnv }))
                taskMeta.push({ idx: i, type: 'bgp', kind: c.kind })
            }
            const srCmd = _srStatusCommand(c.kind)
            if (srCmd) {
                tasks.push(() => _spawnAsync('docker', ['exec', c.name, ...srCmd], { timeout: 10_000, env: dockerEnv }))
                taskMeta.push({ idx: i, type: 'sr', kind: c.kind })
            }
            const vniCmd = _vniStatusCommand(c.kind)
            if (vniCmd) {
                tasks.push(() => _spawnAsync('docker', ['exec', c.name, ...vniCmd], { timeout: 10_000, env: dockerEnv }))
                taskMeta.push({ idx: i, type: 'vni', kind: c.kind })
            }
        }
    }

    // Throttle to max 15 concurrent docker execs to prevent daemon overload
    const settled = await _runWithConcurrency(tasks, 15)

    for (let j = 0; j < settled.length; j++) {
        const res = settled[j]
        const meta = taskMeta[j]
        if (res.status !== 'fulfilled' || !res.value.stdout) { continue }
        if (meta.type === 'bgp') {
            results[meta.idx].bgpNeighbors = _parseBgpSummary(meta.kind, res.value.stdout)
        } else if (meta.type === 'sr') {
            const sr = _parseSrStatus(meta.kind, res.value.stdout)
            results[meta.idx].srEnabled = sr.srEnabled
            results[meta.idx].srLabelsCount = sr.labelsCount
        } else if (meta.type === 'vni') {
            results[meta.idx].vniActive = _parseVniStatus(meta.kind, res.value.stdout)
        }
    }

    return { ok: true, containers: results }
})

ipcMain.handle('clab-enable-interfaces', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const containerName = String(obj['containerName'] ?? '').trim()
    const kind = String(obj['kind'] ?? '').trim().toLowerCase()
    const linkCount = Number(obj['linkCount'] ?? 0)

    if (!containerName) { return { ok: false, message: 'Container name required' } }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
        return { ok: false, message: 'Invalid container name' }
    }

    try {
        if (kind === 'sonic-vs' || kind === 'sonic') {
            // SONiC-VS: enable connected Ethernet interfaces
            // containerlab maps: eth1→Ethernet0, eth2→Ethernet4, eth3→Ethernet8, …
            const count = linkCount || 0
            if (count === 0) {
                return { ok: true, message: 'No linked interfaces to enable' }
            }

            // Step 1: Bring up Linux-level ethN interfaces first (the underlying veth pairs).
            //         Without this, SONiC-level Ethernet ports cannot come up.
            const ethUpCmds: string[] = []
            for (let i = 1; i <= count; i++) {
                ethUpCmds.push(`ip link set eth${i} up 2>/dev/null`)
            }

            // Step 2: Set SONiC PORT admin_status to "up" in CONFIG_DB,
            //         then fall back to `config interface startup` CLI.
            const sonicCmds: string[] = []
            for (let i = 0; i < count; i++) {
                const intf = `Ethernet${i * 4}`
                sonicCmds.push(
                    `sonic-db-cli CONFIG_DB HSET "PORT|${intf}" admin_status up mtu 9100 speed 100000 2>/dev/null` +
                    ` || config interface startup ${intf} 2>/dev/null`
                )
            }

            // Step 3: Start zebra + bgpd and load FRR config.
            //         The frr.conf is bind-mounted into /etc/frr/frr.conf by containerlab.
            //         SONiC's orchagent needs time to create Ethernet interfaces in the kernel
            //         after PORT entries are pushed to CONFIG_DB. We wait for interfaces
            //         to appear in FRR/zebra before loading the config, then retry to catch
            //         any interface commands that failed on earlier passes.
            const frrCmds = [
                // Ensure zebra and bgpd are running
                'supervisorctl start zebra 2>/dev/null',
                'supervisorctl start bgpd 2>/dev/null',
                'supervisorctl start staticd 2>/dev/null',
                // Wait for SONiC to create interfaces (up to 60s, checking every 3s)
                'for i in $(seq 1 20); do vtysh -c "show interface Ethernet0" 2>/dev/null | grep -q "Ethernet0" && break; sleep 3; done',
                // Load FRR config — applies interface IPs + BGP config
                'vtysh -f /etc/frr/frr.conf 2>/dev/null',
                // Wait and retry — some interfaces may not have been ready on first pass
                'sleep 5',
                'vtysh -f /etc/frr/frr.conf 2>/dev/null',
                // Third retry after more time for slow-starting interfaces
                'sleep 10',
                'vtysh -f /etc/frr/frr.conf 2>/dev/null',
                // Write the running config to ensure persistence
                'vtysh -c "write memory" 2>/dev/null',
            ]

            // Combine: Linux up → SONiC config → FRR/BGP start
            const script = ethUpCmds.join(' ; ') + ' ; ' + sonicCmds.join(' ; ') + ' ; ' + frrCmds.join(' ; ')
            const result = await _spawnAsync('docker', [
                'exec', containerName, 'bash', '-c', script,
            ], { timeout: 120_000, env: _dockerEnv() as NodeJS.ProcessEnv })

            // Even if exit code is non-zero, some interfaces may have been enabled
            const stderr = (result.stderr || '').trim()
            if (result.status === 0 || !stderr) {
                return { ok: true, message: `Enabled ${count} interfaces + started bgpd on ${containerName}` }
            }
            return { ok: false, message: stderr || 'Failed to enable interfaces' }
        } else if (kind === 'linux') {
            // Linux/server/PC: bring up interfaces and assign IPs
            const portIps = Array.isArray(obj['portIps']) ? obj['portIps'] as Array<{ ethIndex: number; ip: string }> : []
            const defaultGw = typeof obj['defaultGw'] === 'string' ? (obj['defaultGw'] as string) : ''
            const cmds: string[] = []
            for (const p of portIps) {
                if (typeof p.ethIndex !== 'number' || typeof p.ip !== 'string') { continue }
                cmds.push(`ip link set eth${p.ethIndex} up`)
                cmds.push(`ip addr add ${p.ip} dev eth${p.ethIndex} 2>/dev/null`)
            }
            if (defaultGw) {
                cmds.push(`ip route replace default via ${defaultGw} 2>/dev/null`)
            }
            if (!cmds.length) {
                return { ok: true, message: 'No IP configuration for this linux container' }
            }
            const result = await _spawnAsync('docker', [
                'exec', containerName, 'sh', '-c', cmds.join(' ; '),
            ], { timeout: 15_000, env: _dockerEnv() as NodeJS.ProcessEnv })
            const stderr = (result.stderr || '').trim()
            if (result.status === 0 || !stderr) {
                return { ok: true, message: `Configured ${portIps.length} interface(s) on ${containerName}` }
            }
            return { ok: false, message: stderr || 'Failed to configure interfaces' }
        }
        return { ok: true, message: 'No interface enablement needed for this kind' }
    } catch (err) {
        return { ok: false, message: `Enable failed: ${(err as Error).message}` }
    }
})

// ── Container config push helpers ─────────────────────────────────────────────

interface PushResult { ok: boolean; message: string; output?: string }

function _pushConfigSonic (containerName: string, configLines: string[]): PushResult {
    // Split lines: 'config ...' and 'hostname ...' go to SONiC CLI, rest is FRR config
    const sonicCmds: string[] = []
    const frrLines: string[] = []

    for (const line of configLines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) { continue }
        if (trimmed.startsWith('config ') || trimmed.startsWith('hostname ')) {
            sonicCmds.push(trimmed)
        } else {
            frrLines.push(line)   // preserve original indentation for FRR
        }
    }

    let output = ''

    // Push SONiC CLI commands via bash
    if (sonicCmds.length) {
        const script = sonicCmds.join(' && ')
        const r = spawnSync('docker', ['exec', containerName, 'bash', '-c', script], {
            stdio: 'pipe', encoding: 'utf8', timeout: 60_000, env: _dockerEnv(),
        })
        output += (r.stdout || '') + (r.stderr || '')
    }

    // Push FRR config via vtysh — use stdin pipe to avoid escaping issues
    if (frrLines.length) {
        const frrContent = frrLines.join('\n') + '\n'
        // Write config file into container
        const wr = spawnSync('docker', ['exec', '-i', containerName, 'bash', '-c', 'cat > /tmp/_push.cfg'], {
            input: frrContent, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000, env: _dockerEnv(),
        })
        output += (wr.stderr || '')

        // Load via vtysh
        const ld = spawnSync('docker', ['exec', containerName, 'vtysh', '-f', '/tmp/_push.cfg'], {
            stdio: 'pipe', encoding: 'utf8', timeout: 60_000, env: _dockerEnv(),
        })
        output += (ld.stdout || '') + (ld.stderr || '')

        // Cleanup
        spawnSync('docker', ['exec', containerName, 'rm', '-f', '/tmp/_push.cfg'], {
            stdio: 'pipe', encoding: 'utf8', timeout: 5_000, env: _dockerEnv(),
        })
    }

    return { ok: true, message: `Config pushed to ${containerName}`, output: output.trim() || '(no output)' }
}

function _pushConfigCeos (containerName: string, configLines: string[]): PushResult {
    const allLines = ['configure terminal', ...configLines.filter(l => l.trim()), 'end', 'write memory']
    const content = allLines.join('\n') + '\n'
    const r = spawnSync('docker', ['exec', '-i', containerName, 'FastCli', '-p', '15'], {
        input: content, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000, env: _dockerEnv(),
    })
    const output = (r.stdout || '') + (r.stderr || '')
    return { ok: r.status === 0 || !!output, message: `Config pushed to ${containerName}`, output: output.trim() || '(no output)' }
}

function _pushConfigSrl (containerName: string, configLines: string[]): PushResult {
    const allLines = ['enter candidate', ...configLines.filter(l => l.trim()), 'commit now']
    const content = allLines.join('\n') + '\n'
    const r = spawnSync('docker', ['exec', '-i', containerName, 'sr_cli'], {
        input: content, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000, env: _dockerEnv(),
    })
    const output = (r.stdout || '') + (r.stderr || '')
    return { ok: r.status === 0 || !!output, message: `Config pushed to ${containerName}`, output: output.trim() || '(no output)' }
}

function _pushConfigCrpd (containerName: string, _configLines: string[]): PushResult {
    // cRPD containers use enforce-startup-config: true in containerlab YAML,
    // which loads the curly-brace startup config at deploy time. The startup
    // config includes the complete underlay + overlay BGP config, interfaces,
    // routing-options, and policy-options.
    //
    // Pushing vendor-config-builder set-format commands on top would conflict
    // (duplicate BGP peers, wrong interface names like et-0/0/0 vs ethN).
    // So we skip the push and just verify the config is loaded.
    const r = spawnSync('docker', ['exec', containerName, 'cli', '-c', 'show configuration protocols bgp | display set | count'], {
        stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000, env: _dockerEnv(),
    })
    const output = (r.stdout || '').trim()
    const lineCount = parseInt(output.match(/Count: (\d+)/)?.[1] ?? '0', 10)
    return {
        ok: lineCount > 0,
        message: lineCount > 0
            ? `Config verified on ${containerName} (${lineCount} BGP config lines)`
            : `Config may not be loaded on ${containerName}`,
        output,
    }
}

// ── Fetch running config from container for diff ──────────────────────────────

ipcMain.handle('clab-fetch-config', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const containerName = String(obj['containerName'] ?? '').trim()
    const kind = String(obj['kind'] ?? '').trim().toLowerCase()

    if (!containerName) { return { ok: false, message: 'Container name required' } }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
        return { ok: false, message: 'Invalid container name' }
    }

    // Verify container is running
    const check = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', containerName], {
        stdio: 'pipe', encoding: 'utf8', timeout: 5_000, env: _dockerEnv(),
    })
    if (check.status !== 0 || check.stdout?.trim() !== 'true') {
        return { ok: false, message: `Container "${containerName}" is not running` }
    }

    let cmd: string[]
    if (kind === 'sonic-vs' || kind === 'sonic') {
        cmd = ['docker', 'exec', containerName, 'show', 'runningconfiguration', 'all']
    } else if (kind === 'ceos') {
        cmd = ['docker', 'exec', containerName, 'FastCli', '-p', '15', '-c', 'show running-config']
    } else if (kind === 'srl') {
        cmd = ['docker', 'exec', containerName, 'sr_cli', 'info', 'flat']
    } else if (_isJunosKind(kind)) {
        cmd = ['docker', 'exec', containerName, 'cli', '-c', 'show configuration | display set']
    } else {
        return { ok: false, message: `Config fetch not supported for kind: ${kind}` }
    }

    try {
        const result = spawnSync(cmd[0], cmd.slice(1), {
            stdio: 'pipe', encoding: 'utf8', timeout: 30_000, env: _dockerEnv(),
        })
        if (result.status !== 0) {
            return { ok: false, message: `Fetch failed: ${result.stderr?.trim() || 'exit code ' + result.status}` }
        }
        return { ok: true, output: result.stdout ?? '', message: 'Running config fetched' }
    } catch (err) {
        return { ok: false, message: `Fetch error: ${(err as Error).message}` }
    }
})

// ── Container config push IPC handler ─────────────────────────────────────────

ipcMain.handle('clab-push-config', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' } as PushResult
    }
    const obj = rawPayload as Record<string, unknown>
    const containerName = String(obj['containerName'] ?? '').trim()
    const kind = String(obj['kind'] ?? '').trim().toLowerCase()
    const configLines = Array.isArray(obj['configLines']) ? obj['configLines'].map(String) : []

    if (!containerName) { return { ok: false, message: 'Container name required' } as PushResult }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
        return { ok: false, message: 'Invalid container name' } as PushResult
    }
    if (!configLines.length) { return { ok: false, message: 'No config lines to push' } as PushResult }

    // Verify container is running
    const check = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', containerName], {
        stdio: 'pipe', encoding: 'utf8', timeout: 5_000, env: _dockerEnv(),
    })
    if (check.status !== 0 || check.stdout?.trim() !== 'true') {
        return { ok: false, message: `Container "${containerName}" is not running` } as PushResult
    }

    try {
        if (kind === 'sonic-vs' || kind === 'sonic') {
            return _pushConfigSonic(containerName, configLines)
        } else if (kind === 'ceos') {
            return _pushConfigCeos(containerName, configLines)
        } else if (kind === 'srl') {
            return _pushConfigSrl(containerName, configLines)
        } else if (_isJunosKind(kind)) {
            return _pushConfigCrpd(containerName, configLines)
        }
        return { ok: false, message: `Config push not supported for container kind: ${kind}` } as PushResult
    } catch (err) {
        return { ok: false, message: `Config push failed: ${(err as Error).message}` } as PushResult
    }
})

ipcMain.handle('open-container-console', async (_event, rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== 'object') {
        return { ok: false, message: 'Invalid payload' }
    }
    const obj = rawPayload as Record<string, unknown>
    const containerName = String(obj['containerName'] ?? '').trim()
    if (!containerName) {
        return { ok: false, message: 'Container name is required' }
    }

    const kind = String((obj as Record<string, unknown>)['kind'] ?? '').trim().toLowerCase()

    // Validate container name to prevent command injection
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
        return { ok: false, message: `Invalid container name: "${containerName}"` }
    }

    // Verify the container is actually running
    const check = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', containerName], {
        stdio: 'pipe', encoding: 'utf8', timeout: 5_000, env: _dockerEnv(),
    })
    if (check.status !== 0 || check.stdout?.trim() !== 'true') {
        return { ok: false, message: `Container "${containerName}" is not running` }
    }

    // Pick the right CLI based on container kind
    let cliCmd: string
    if (kind === 'sonic-vs' || kind === 'sonic') {
        cliCmd = 'vtysh'
    } else if (kind === 'srl') {
        cliCmd = 'sr_cli'
    } else if (kind === 'ceos') {
        cliCmd = 'Cli'
    } else if (_isJunosKind(kind)) {
        cliCmd = 'cli'
    } else if (kind === 'linux') {
        cliCmd = 'sh'
    } else {
        cliCmd = "sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'"
    }

    // Build the full command — for remote servers use DOCKER_HOST so Docker's
    // SSH transport handles auth (including SSH_ASKPASS for password auth),
    // rather than raw `ssh -t` which can't use askpass in a PTY.
    const shellCmd = `docker exec -it ${containerName} ${cliCmd}`

    // Open terminal window with PTY
    const sessionId = `console-${containerName}-${Date.now()}`
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash')
    const shellArgs = process.platform === 'win32' ? ['/c', shellCmd] : ['-lc', shellCmd]
    const env = { ...process.env as Record<string, string>, ..._dockerEnv() }
    return _openTerminalWindow({
        sessionId,
        label: `Console: ${containerName}`,
        command: shell,
        args: shellArgs,
        env,
    })
})
