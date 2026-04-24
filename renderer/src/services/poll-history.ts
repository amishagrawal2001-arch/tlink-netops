// ═══════════════════════════════════════════════════════════════════════════════
// Poll History Service
// In-memory ring buffer of poll snapshots with optional localStorage persistence.
// Enables "time machine" replay of past Twin data.
// ═══════════════════════════════════════════════════════════════════════════════

export interface PollSnapshot {
    timestamp: number
    /** Container name → { state, bgpNeighbors, srLabelsCount, vniActive } */
    containers: Array<{
        containerName: string
        state: string
        bgpUp: number
        bgpTotal: number
        srLabelsCount?: number
        vniActive?: number
    }>
    /** Per-node health (CPU/mem percentages) */
    nodeHealth: Array<{ nodeId: string; cpu: number; mem: number; alarms: number }>
    /** Per-node config drift flag */
    driftNodes: string[]
}

export class PollHistoryService {
    /** Maximum number of snapshots to keep in memory (ring buffer) */
    private readonly maxSize: number
    private buffer: PollSnapshot[] = []
    private readonly storageKey = 'netops-poll-history'

    constructor (maxSize = 200) {
        this.maxSize = maxSize
        this._loadFromStorage()
    }

    /** Record a new snapshot. Automatically drops oldest when exceeding maxSize. */
    record (snapshot: PollSnapshot): void {
        this.buffer.push(snapshot)
        while (this.buffer.length > this.maxSize) {
            this.buffer.shift()
        }
        this._saveToStorage()
    }

    /** Get all snapshots in chronological order */
    getAll (): PollSnapshot[] {
        return [...this.buffer]
    }

    /** Get snapshots within a time range [startMs, endMs] (inclusive) */
    getRange (startMs: number, endMs: number): PollSnapshot[] {
        return this.buffer.filter(s => s.timestamp >= startMs && s.timestamp <= endMs)
    }

    /** Get the snapshot closest to a target timestamp (within tolerance) */
    getAt (timestampMs: number, toleranceMs = 60_000): PollSnapshot | null {
        let best: PollSnapshot | null = null
        let bestDiff = Infinity
        for (const s of this.buffer) {
            const diff = Math.abs(s.timestamp - timestampMs)
            if (diff < bestDiff && diff <= toleranceMs) {
                best = s
                bestDiff = diff
            }
        }
        return best
    }

    /** Count snapshots held in memory */
    get size (): number { return this.buffer.length }

    /** First and last timestamps held (or null if empty) */
    getBounds (): { first: number; last: number } | null {
        if (!this.buffer.length) { return null }
        return {
            first: this.buffer[0].timestamp,
            last: this.buffer[this.buffer.length - 1].timestamp,
        }
    }

    /** Compute a diff between two snapshots — useful for "what changed" queries */
    diffSnapshots (before: PollSnapshot, after: PollSnapshot): {
        nodesNewlyDown: string[]
        nodesNewlyUp: string[]
        bgpNeighborsLost: Array<{ container: string; before: number; after: number }>
        newDriftNodes: string[]
        resolvedDriftNodes: string[]
    } {
        const beforeState = new Map(before.containers.map(c => [c.containerName, c]))
        const afterState = new Map(after.containers.map(c => [c.containerName, c]))
        const nodesNewlyDown: string[] = []
        const nodesNewlyUp: string[] = []
        const bgpNeighborsLost: Array<{ container: string; before: number; after: number }> = []

        for (const [name, a] of afterState) {
            const b = beforeState.get(name)
            if (!b) { continue }
            if (b.state === 'running' && a.state !== 'running') { nodesNewlyDown.push(name) }
            if (b.state !== 'running' && a.state === 'running') { nodesNewlyUp.push(name) }
            if (b.bgpUp > a.bgpUp) {
                bgpNeighborsLost.push({ container: name, before: b.bgpUp, after: a.bgpUp })
            }
        }

        const beforeDrift = new Set(before.driftNodes)
        const afterDrift = new Set(after.driftNodes)
        const newDriftNodes = [...afterDrift].filter(n => !beforeDrift.has(n))
        const resolvedDriftNodes = [...beforeDrift].filter(n => !afterDrift.has(n))

        return { nodesNewlyDown, nodesNewlyUp, bgpNeighborsLost, newDriftNodes, resolvedDriftNodes }
    }

    /** Clear all history (in memory and storage) */
    clear (): void {
        this.buffer = []
        try { localStorage.removeItem(this.storageKey) } catch { /* noop */ }
    }

    private _saveToStorage (): void {
        try {
            // Keep only last 50 in storage to avoid quota issues
            const toSave = this.buffer.slice(-50)
            localStorage.setItem(this.storageKey, JSON.stringify(toSave))
        } catch { /* quota exceeded or unavailable */ }
    }

    private _loadFromStorage (): void {
        try {
            const data = localStorage.getItem(this.storageKey)
            if (data) {
                const parsed = JSON.parse(data)
                if (Array.isArray(parsed)) { this.buffer = parsed.slice(-this.maxSize) }
            }
        } catch { /* corrupted data, ignore */ }
    }
}
