// ═════════════════════════════════════════════════════════════════════════════
// Push History — persistent audit trail of every config-push batch.
//
// Each push driver (pushAllConfigs, runPushStaging, executePushConfig,
// executePushStaging) calls record() once per batch. The service keeps the
// last 100 entries in memory and persists them to user-prefs under the
// `push-history` key so the audit log survives reload.
//
// The Automation Dashboard reads from `recent()` and shows a per-batch list
// with success/fail counts and an expand-to-detail row.
// ═════════════════════════════════════════════════════════════════════════════

import { Injectable } from '@angular/core'

export type PushMode      = 'full' | 'staging'
export type PushSource    = 'canvas' | 'node' | 'dashboard' | 'scheduler' | 'workflow' | 'rollback'

export interface PushHistoryEntry {
    /** Stable id for UI keying. */
    id: string
    /** ISO timestamp of when the batch started. */
    timestamp: string
    /** What kind of push: full startup config, or just the Day-0 staging block. */
    mode: PushMode
    /** Where the push originated. */
    source: PushSource
    /** Human-readable scope description ("All nodes (12)", "Selected (3)", "Single: Switch-1"). */
    scope: string
    /** Sequential or parallel? */
    sequential: boolean
    /** Whether the push was a real apply or a dry-run preview. */
    dryRun: boolean
    /** Per-node outcome — keep this small (label + ok flag + first 200 chars of error/output). */
    results: Array<{
        nodeId: string
        nodeLabel: string
        ok: boolean
        message?: string         // first 200 chars; err on success path = ''
        durationMs?: number
    }>
    /** Aggregate counts derived from results — denormalised for fast dashboard rendering. */
    succeeded: number
    failed: number
    /** Total wall-clock time of the batch in ms (start of first push to end of last). */
    totalDurationMs?: number
}

const MAX_HISTORY = 100
const PREFS_KEY   = 'push-history'

@Injectable({ providedIn: 'root' })
export class PushHistoryService {

    private _history: PushHistoryEntry[] = []
    private _api = (typeof window !== 'undefined' ? (window as any).netopsAPI : undefined)
    private _loaded = false
    private _listeners: Array<(list: PushHistoryEntry[]) => void> = []

    /** Lazy-load from prefs the first time anyone reads the history. */
    async ensureLoaded (): Promise<void> {
        if (this._loaded) { return }
        this._loaded = true
        if (!this._api?.prefGet) { return }
        try {
            const saved = await this._api.prefGet(PREFS_KEY)
            if (Array.isArray(saved)) {
                this._history = saved.slice(-MAX_HISTORY)
                this._emit()
            }
        } catch { /* ignore — start with empty history */ }
    }

    /** Newest-first snapshot of history. Returns at most `limit` entries. */
    recent (limit = MAX_HISTORY): PushHistoryEntry[] {
        // Sort fresh each call — the array is small (≤100) so cost is negligible.
        return [...this._history]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, limit)
    }

    /** Subscribe to history changes (returns unsub function). */
    onChange (cb: (list: PushHistoryEntry[]) => void): () => void {
        this._listeners.push(cb)
        cb(this.recent())
        return () => {
            const i = this._listeners.indexOf(cb)
            if (i >= 0) { this._listeners.splice(i, 1) }
        }
    }

    /** Append a new batch. Newest-first within the in-memory array. */
    record (entry: Omit<PushHistoryEntry, 'id'>): PushHistoryEntry {
        const full: PushHistoryEntry = {
            ...entry,
            id: `push_${Date.now()}_${Math.floor(Math.random() * 9999)}`,
        }
        this._history = [full, ...this._history].slice(0, MAX_HISTORY)
        this._persist()
        this._emit()
        return full
    }

    /** Wipe history. Confirm at the call site. */
    clear (): void {
        this._history = []
        this._persist()
        this._emit()
    }

    private _persist (): void {
        try { this._api?.prefSet?.(PREFS_KEY, this._history) } catch { /* ignore */ }
    }

    private _emit (): void {
        const snap = this.recent()
        for (const l of this._listeners) {
            try { l(snap) } catch { /* ignore */ }
        }
    }
}
