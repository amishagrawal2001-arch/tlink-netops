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
        const res = await fetch(`${this._url}/api/poll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port, username, password, commands }),
        })
        return res.json()
    }

    /** Poll multiple devices; results are streamed back via the WebSocket. */
    async pollAll (devices: any[]): Promise<any> {
        const res = await fetch(`${this._url}/api/poll-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ devices }),
        })
        return res.json()
    }

    /** Fetch running config from a device via the backend. */
    async backup (host: string, port: number, username: string, password: string, command?: string): Promise<any> {
        const res = await fetch(`${this._url}/api/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port, username, password, command }),
        })
        return res.json()
    }

    /** Run LLDP discovery on a device via the backend. */
    async discover (host: string, port: number, username: string, password: string, command?: string): Promise<any> {
        const res = await fetch(`${this._url}/api/discover`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port, username, password, command }),
        })
        return res.json()
    }

    /** Run a single command on a device via the backend (returns sshRunCommand-compatible result). */
    async runCommand (host: string, port: number, username: string, password: string, command: string): Promise<any> {
        const res = await fetch(`${this._url}/api/poll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port, username, password, commands: [command], timeoutMs: 30000 }),
        })
        const data = await res.json()
        // Transform to match sshRunCommand result format
        return { ok: data.ok, output: data.outputs?.[0] ?? '', message: data.error }
    }

    /** Load (restore) config onto a device via an interactive shell session on the backend. */
    async loadConfig (host: string, port: number, username: string, password: string, commands: string[], delayMs?: number): Promise<any> {
        const res = await fetch(`${this._url}/api/load-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port, username, password, commands, delayMs }),
        })
        return res.json()
    }

    /** Check backend server health. */
    async status (): Promise<any> {
        const res = await fetch(`${this._url}/api/status`)
        return res.json()
    }
}
