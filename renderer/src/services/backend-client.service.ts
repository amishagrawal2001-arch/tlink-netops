// ═══════════════════════════════════════════════════════════════════════════════
// Backend Client Service — connects to the optional NetOps backend server
// ═══════════════════════════════════════════════════════════════════════════════

import { Injectable } from '@angular/core'
import { Subject, Observable } from 'rxjs'

export interface PollResult {
    nodeId: string
    ok: boolean
    data: any
    timestamp: string
}

@Injectable({ providedIn: 'root' })
export class BackendClientService {
    private _ws: WebSocket | null = null
    private _results$ = new Subject<PollResult>()
    private _connected = false
    private _url = ''

    get isConnected (): boolean { return this._connected }
    get url (): string { return this._url }
    get results$ (): Observable<PollResult> { return this._results$.asObservable() }

    connect (url: string): void {
        this.disconnect()
        this._url = url
        this._ws = new WebSocket(url.replace(/^http/, 'ws'))
        this._ws.onopen = () => { this._connected = true }
        this._ws.onclose = () => { this._connected = false }
        this._ws.onerror = () => { this._connected = false }
        this._ws.onmessage = (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data)
                if (data.type === 'poll_result') {
                    this._results$.next(data as PollResult)
                }
            } catch { /* ignore malformed messages */ }
        }
    }

    disconnect (): void {
        this._ws?.close()
        this._ws = null
        this._connected = false
    }

    /** Poll a single device via the backend server REST API. */
    async pollDevice (
        host: string, port: number, username: string, password: string, commands: string[],
    ): Promise<any> {
        try {
            if (!this._url || !this._connected) {
                return { ok: false, message: 'Backend not connected', results: [] }
            }
            const res = await fetch(`${this._url}/api/poll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, username, password, commands }),
            })
            if (!res.ok) { return { ok: false, message: `HTTP ${res.status}`, results: [] } }
            const data = await res.json()
            // Transform to match local sshRunCommands result format
            return {
                ok: data.ok,
                message: data.error ?? '',
                results: (data.outputs ?? []).map((output: string) => ({ ok: true, output, message: '' })),
            }
        } catch (err: any) {
            return { ok: false, message: err.message, results: [] }
        }
    }

    /** Poll multiple devices; results are streamed back via the WebSocket. */
    async pollAll (devices: any[]): Promise<any> {
        try {
            if (!this._url || !this._connected) {
                return { ok: false, message: 'Backend not connected', results: [] }
            }
            const res = await fetch(`${this._url}/api/poll-all`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ devices }),
            })
            if (!res.ok) { return { ok: false, message: `HTTP ${res.status}`, results: [] } }
            return res.json()
        } catch (err: any) {
            return { ok: false, message: err.message, results: [] }
        }
    }

    /** Fetch running config from a device via the backend. */
    async backup (host: string, port: number, username: string, password: string, command?: string): Promise<any> {
        try {
            if (!this._url || !this._connected) {
                return { ok: false, output: '', message: 'Backend not connected' }
            }
            const res = await fetch(`${this._url}/api/backup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, username, password, command }),
            })
            if (!res.ok) { return { ok: false, output: '', message: `HTTP ${res.status}` } }
            const data = await res.json()
            return { ok: data.ok, output: data.output ?? data.config ?? '', message: data.error ?? '' }
        } catch (err: any) {
            return { ok: false, output: '', message: err.message }
        }
    }

    /** Run LLDP discovery on a device via the backend. */
    async discover (host: string, port: number, username: string, password: string, command?: string): Promise<any> {
        try {
            if (!this._url || !this._connected) {
                return { ok: false, output: '', message: 'Backend not connected' }
            }
            const res = await fetch(`${this._url}/api/discover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, username, password, command }),
            })
            if (!res.ok) { return { ok: false, output: '', message: `HTTP ${res.status}` } }
            const data = await res.json()
            return { ok: data.ok, output: data.output ?? '', message: data.error ?? '' }
        } catch (err: any) {
            return { ok: false, output: '', message: err.message }
        }
    }

    /** Run a single command on a device via the backend (returns sshRunCommand-compatible result). */
    async runCommand (host: string, port: number, username: string, password: string, command: string): Promise<any> {
        try {
            if (!this._url || !this._connected) {
                return { ok: false, output: '', message: 'Backend not connected' }
            }
            const res = await fetch(`${this._url}/api/poll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, username, password, commands: [command], timeoutMs: 30000 }),
            })
            if (!res.ok) { return { ok: false, output: '', message: `HTTP ${res.status}` } }
            const data = await res.json()
            // Transform to match sshRunCommand result format
            return { ok: data.ok, output: data.outputs?.[0] ?? '', message: data.error ?? '' }
        } catch (err: any) {
            return { ok: false, output: '', message: err.message }
        }
    }

    /** Load (restore) config onto a device via an interactive shell session on the backend. */
    async loadConfig (host: string, port: number, username: string, password: string, commands: string[], delayMs?: number): Promise<any> {
        try {
            if (!this._url || !this._connected) {
                return { ok: false, output: '', message: 'Backend not connected' }
            }
            const res = await fetch(`${this._url}/api/load-config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, username, password, commands, delayMs }),
            })
            if (!res.ok) { return { ok: false, output: '', message: `HTTP ${res.status}` } }
            const data = await res.json()
            return { ok: data.ok, output: data.output ?? '', message: data.error ?? '' }
        } catch (err: any) {
            return { ok: false, output: '', message: err.message }
        }
    }

    /** Check backend server health. */
    /** Poll container status + BGP via the backend server (for remote labs).
     *  When `server` is provided, the backend SSHes into that host to run docker commands.
     *  When omitted, the backend runs docker commands locally on its own host. */
    async containerPoll (
        containers: Array<{ name: string; kind: string }>,
        server?: { host: string; port?: number; username: string; password: string },
    ): Promise<any> {
        try {
            if (!this._url || !this._connected) {
                return { ok: false, error: 'Backend not connected', containers: [] }
            }
            const body: any = { containers }
            if (server) { body.server = server }
            const res = await fetch(`${this._url}/api/container-poll`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            if (!res.ok) { return { ok: false, error: `HTTP ${res.status}`, containers: [] } }
            return res.json()
        } catch (err: any) {
            return { ok: false, error: err.message, containers: [] }
        }
    }

    async status (): Promise<any> {
        try {
            if (!this._url || !this._connected) {
                return { ok: false, message: 'Backend not connected' }
            }
            const res = await fetch(`${this._url}/api/status`)
            if (!res.ok) { return { ok: false, message: `HTTP ${res.status}` } }
            return res.json()
        } catch (err: any) {
            return { ok: false, message: err.message }
        }
    }
}
