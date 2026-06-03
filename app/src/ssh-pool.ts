// ═══════════════════════════════════════════════════════════════════════════════
// SshConnectionPool — reuse SSH connections across commands
// ═══════════════════════════════════════════════════════════════════════════════

import { Client, type ConnectConfig } from 'ssh2'

interface PoolEntry {
    client: Client
    key: string
    inUse: boolean
    lastUsed: number
    connected: boolean
}

export class SshConnectionPool {
    private _pool = new Map<string, PoolEntry[]>()
    private _maxPerHost = 3
    private _maxTotal = 50
    private _idleTimeoutMs = 60_000
    private _cleanupTimer: ReturnType<typeof setInterval>

    constructor () {
        this._cleanupTimer = setInterval(() => this._cleanupIdle(), 30_000)
    }

    /**
     * Acquire an SSH connection from the pool or create a new one.
     * Returns `{ client, release }` — caller MUST call `release()` when done.
     */
    async getConnection (
        host: string, port: number, username: string, password: string,
        connectOpts?: Partial<ConnectConfig>,
    ): Promise<{ client: Client; release: () => void }> {
        const key = `${host}:${port}:${username}`

        // 1. Try to reuse an idle, connected entry for this host
        const entries = this._pool.get(key) ?? []
        for (const entry of entries) {
            if (!entry.inUse && entry.connected) {
                entry.inUse = true
                entry.lastUsed = Date.now()
                return { client: entry.client, release: () => this._release(entry) }
            }
        }

        // 2. If max-per-host reached, wait briefly for a free slot
        if (entries.length >= this._maxPerHost) {
            const freed = await this._waitForSlot(key, 5_000)
            if (freed) {
                freed.inUse = true
                freed.lastUsed = Date.now()
                return { client: freed.client, release: () => this._release(freed) }
            }
            // Timeout — fall through and create a new connection anyway
            // (evict the oldest idle entry first)
            const idleIdx = entries.findIndex(e => !e.inUse)
            if (idleIdx !== -1) {
                const evicted = entries.splice(idleIdx, 1)[0]
                try { evicted.client.end() } catch { /* no-op */ }
            }
        }

        // 3. If total pool size at max, evict oldest idle connection globally
        if (this._totalCount() >= this._maxTotal) {
            this._evictOldestIdle()
        }

        // 4. Create a new connection
        const client = new Client()
        const entry: PoolEntry = { client, key, inUse: true, lastUsed: Date.now(), connected: false }

        if (!this._pool.has(key)) { this._pool.set(key, []) }
        this._pool.get(key)!.push(entry)

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._removeEntry(entry)
                try { client.end() } catch { /* no-op */ }
                reject(new Error(`SSH pool: connection timeout to ${host}:${port}`))
            }, (connectOpts?.readyTimeout ?? 10_000) + 2_000)

            // Track which gate has fired so we know whether to reject the
            // pending promise (handshake-time error) vs. just clean up
            // (post-handshake error after the consumer moved on).
            let settled = false

            client.once('ready', () => {
                clearTimeout(timeout)
                settled = true
                entry.connected = true
                resolve({ client, release: () => this._release(entry) })
            })

            // Persistent error listener — `on`, not `once`. This is critical:
            // ssh2 can emit `error` multiple times (e.g. handshake fail
            // followed by a connection-reset 'close', or a healthy connection
            // that gets RST'd by the server later). With `once`, the second
            // error has no listener → Node treats it as an uncaught exception
            // and Electron's main process tears down the whole app.
            //
            // Symptom we're fixing: "Connection lost before handshake" bubbling
            // up as an Uncaught Exception that crashes the renderer + main.
            client.on('error', (err: Error) => {
                clearTimeout(timeout)
                this._removeEntry(entry)
                if (!settled) {
                    settled = true
                    reject(err)
                } else {
                    // Connection was already in use (or already returned to the
                    // caller) when the error fired. Log so the issue isn't
                    // invisible, but DO NOT throw — the consumer will detect
                    // the broken connection on next exec.
                    console.warn(`[ssh-pool] post-handshake error on ${host}:${port}: ${err.message}`)
                }
            })

            // Same defence-in-depth for 'close': switch to `on` so we always
            // have a listener for stale event emissions.
            client.on('close', () => {
                entry.connected = false
                this._removeEntry(entry)
            })

            client.connect({
                host, port, username, password,
                readyTimeout: 10_000,
                ...connectOpts,
            })
        })
    }

    /** Mark a connection as available for reuse. */
    private _release (entry: PoolEntry): void {
        entry.inUse = false
        entry.lastUsed = Date.now()
    }

    /** Wait for an idle connection on `key`, up to `ms` milliseconds. */
    private _waitForSlot (key: string, ms: number): Promise<PoolEntry | null> {
        return new Promise(resolve => {
            const deadline = Date.now() + ms
            const check = (): void => {
                const entries = this._pool.get(key) ?? []
                const idle = entries.find(e => !e.inUse && e.connected)
                if (idle) { resolve(idle); return }
                if (Date.now() >= deadline) { resolve(null); return }
                setTimeout(check, 200)
            }
            check()
        })
    }

    /** Close connections that have been idle longer than _idleTimeoutMs. */
    private _cleanupIdle (): void {
        const now = Date.now()
        for (const [key, entries] of this._pool) {
            const keep: PoolEntry[] = []
            for (const e of entries) {
                if (!e.inUse && (now - e.lastUsed > this._idleTimeoutMs || !e.connected)) {
                    try { e.client.end() } catch { /* no-op */ }
                } else {
                    keep.push(e)
                }
            }
            if (keep.length === 0) {
                this._pool.delete(key)
            } else {
                this._pool.set(key, keep)
            }
        }
    }

    /** Evict the single oldest idle connection across all hosts. */
    private _evictOldestIdle (): void {
        let oldest: PoolEntry | null = null
        for (const entries of this._pool.values()) {
            for (const e of entries) {
                if (!e.inUse && (!oldest || e.lastUsed < oldest.lastUsed)) {
                    oldest = e
                }
            }
        }
        if (oldest) {
            try { oldest.client.end() } catch { /* no-op */ }
            this._removeEntry(oldest)
        }
    }

    /** Remove a single entry from the pool. */
    private _removeEntry (entry: PoolEntry): void {
        const entries = this._pool.get(entry.key)
        if (!entries) { return }
        const idx = entries.indexOf(entry)
        if (idx !== -1) { entries.splice(idx, 1) }
        if (entries.length === 0) { this._pool.delete(entry.key) }
    }

    private _totalCount (): number {
        let n = 0
        for (const entries of this._pool.values()) { n += entries.length }
        return n
    }

    /** Close all connections, clear timers. Call on app quit. */
    destroyAll (): void {
        clearInterval(this._cleanupTimer)
        for (const entries of this._pool.values()) {
            for (const e of entries) {
                try { e.client.end() } catch { /* no-op */ }
            }
        }
        this._pool.clear()
    }

    get stats (): { total: number; inUse: number; idle: number } {
        let total = 0, inUse = 0, idle = 0
        for (const entries of this._pool.values()) {
            for (const e of entries) {
                total++
                if (e.inUse) { inUse++ } else { idle++ }
            }
        }
        return { total, inUse, idle }
    }
}
