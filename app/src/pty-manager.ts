/**
 * PTY Session Manager
 *
 * Manages node-pty sessions for embedded terminal panel.
 * Each session wraps a pseudo-terminal, forwarding data between
 * the renderer (xterm.js) and the spawned process.
 */

import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import * as os from 'os'

export interface PtySession {
    id: string
    label: string
    pty: pty.IPty
    sender: WebContents
}

const sessions = new Map<string, PtySession>()

/** Default shell for the current platform */
function defaultShell (): string {
    if (process.platform === 'win32') {
        return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/bash'
}

/**
 * Create a new PTY session.
 * The spawned process output is forwarded to the renderer via `sender.send('pty-data', id, data)`.
 * When the process exits, `sender.send('pty-exit', id, exitCode)` is sent.
 */
export function createSession (opts: {
    id: string
    label: string
    command?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
    sender: WebContents
}): PtySession {
    const shell = opts.command || defaultShell()
    const args = opts.args || []
    const cwd = opts.cwd || os.homedir()

    const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        ...(opts.env || {}),
    }

    const ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        cwd,
        env,
    })

    const session: PtySession = {
        id: opts.id,
        label: opts.label,
        pty: ptyProcess,
        sender: opts.sender,
    }

    // Buffer PTY output to reduce IPC overhead — flush every 16ms (~60fps)
    let ptyBuffer = ''
    let ptyFlushTimer: ReturnType<typeof setTimeout> | null = null
    const PTY_FLUSH_INTERVAL = 16

    const flushPtyBuffer = () => {
        ptyFlushTimer = null
        if (ptyBuffer && !session.sender.isDestroyed()) {
            try {
                session.sender.send('pty-data', opts.id, ptyBuffer)
            } catch (_) { /* renderer closed */ }
        }
        ptyBuffer = ''
    }

    ptyProcess.onData((data: string) => {
        ptyBuffer += data
        if (!ptyFlushTimer) {
            ptyFlushTimer = setTimeout(flushPtyBuffer, PTY_FLUSH_INTERVAL)
        }
    })

    ptyProcess.onExit(({ exitCode }) => {
        // Flush any remaining buffered output before signalling exit
        if (ptyFlushTimer) { clearTimeout(ptyFlushTimer); ptyFlushTimer = null }
        if (ptyBuffer) { flushPtyBuffer() }
        try {
            if (!session.sender.isDestroyed()) {
                session.sender.send('pty-exit', opts.id, exitCode)
            }
        } catch (_) { /* renderer closed */ }
        sessions.delete(opts.id)
    })

    sessions.set(opts.id, session)
    return session
}

/** Write data from renderer to the PTY stdin. */
export function writeToSession (id: string, data: string): void {
    const session = sessions.get(id)
    if (session) {
        session.pty.write(data)
    }
}

/** Resize the PTY. */
export function resizeSession (id: string, cols: number, rows: number): void {
    const session = sessions.get(id)
    if (session) {
        try { session.pty.resize(cols, rows) } catch (_) { /* ignore */ }
    }
}

/** Kill and remove a single session. */
export function destroySession (id: string): void {
    const session = sessions.get(id)
    if (session) {
        try { session.pty.kill() } catch (_) { /* already exited */ }
        sessions.delete(id)
    }
}

/** Kill all sessions — call on app quit. */
export function destroyAllSessions (): void {
    for (const [id, session] of sessions) {
        try { session.pty.kill() } catch (_) { /* ignore */ }
        sessions.delete(id)
    }
}

/** Get number of active sessions. */
export function sessionCount (): number {
    return sessions.size
}
