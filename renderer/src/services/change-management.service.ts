/**
 * Change Management — create, approve, deploy, verify, and rollback
 * configuration changes to network devices with full audit trail.
 */

import { Injectable } from '@angular/core'

// ── Interfaces ───────────────────────────────────────────────────────────────

export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'deployed' | 'verified' | 'failed' | 'rolled-back'

export interface ChangeRequest {
    id: string
    nodeId: string
    nodeLabel: string
    proposedConfig: string
    currentConfig?: string
    diff?: string
    status: ChangeStatus
    createdAt: string
    approvedAt?: string
    deployedAt?: string
    verifiedAt?: string
    rollbackConfig?: string
    notes?: string
    deployResult?: string
    verifyResult?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let _nextId = 1
function uid (): string { return `cr_${Date.now()}_${_nextId++}` }

function nowIso (): string { return new Date().toISOString() }

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ChangeManagementService {

    private _requests: ChangeRequest[] = []
    private _api = (window as any).netopsAPI

    /** All change requests (read-only snapshot). */
    get requests (): ChangeRequest[] { return this._requests }

    /** Count of pending change requests. */
    get pendingCount (): number {
        return this._requests.filter(r => r.status === 'pending').length
    }

    /** Count of active (non-terminal) change requests. */
    get activeCount (): number {
        return this._requests.filter(r =>
            r.status !== 'rejected' && r.status !== 'verified' && r.status !== 'rolled-back',
        ).length
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    async loadRequests (): Promise<void> {
        try {
            const saved = await this._api?.prefGet?.('change-requests')
            if (Array.isArray(saved) && saved.length > 0) {
                this._requests = saved
            }
        } catch { /* ignore read errors */ }
    }

    saveRequests (): void {
        this._api?.prefSet?.('change-requests', this._requests)
    }

    // ── CRUD ─────────────────────────────────────────────────────────────────

    /**
     * Create a new change request.
     * Computes a line-by-line diff if currentConfig is provided.
     */
    createRequest (
        nodeId: string,
        nodeLabel: string,
        proposedConfig: string,
        currentConfig?: string,
    ): ChangeRequest {
        const diff = currentConfig ? this._computeDiff(currentConfig, proposedConfig) : undefined

        const cr: ChangeRequest = {
            id: uid(),
            nodeId,
            nodeLabel,
            proposedConfig,
            currentConfig,
            diff,
            status: 'pending',
            createdAt: nowIso(),
        }
        this._requests = [...this._requests, cr]
        this.saveRequests()
        return cr
    }

    /**
     * Approve a pending change request.
     */
    approveChange (id: string): void {
        this._requests = this._requests.map(r => {
            if (r.id !== id || r.status !== 'pending') { return r }
            return { ...r, status: 'approved' as ChangeStatus, approvedAt: nowIso() }
        })
        this.saveRequests()
    }

    /**
     * Reject a pending change request with an optional reason.
     */
    rejectChange (id: string, notes?: string): void {
        this._requests = this._requests.map(r => {
            if (r.id !== id || r.status !== 'pending') { return r }
            return { ...r, status: 'rejected' as ChangeStatus, notes: notes ?? r.notes }
        })
        this.saveRequests()
    }

    /**
     * Deploy an approved change by pushing config lines to the device via SSH.
     *
     * @param id       Change request ID.
     * @param pushFn   Async function: (nodeId, configLines) => Promise<string> — pushes config and returns output.
     */
    async deployChange (
        id: string,
        pushFn: (nodeId: string, configLines: string[]) => Promise<string>,
    ): Promise<string> {
        const cr = this._requests.find(r => r.id === id)
        if (!cr || cr.status !== 'approved') { return 'Change not in approved state' }

        // Save current config as rollback target
        const rollbackConfig = cr.currentConfig

        try {
            const lines = cr.proposedConfig.split('\n').filter(l => l.trim())
            const output = await pushFn(cr.nodeId, lines)

            this._requests = this._requests.map(r => {
                if (r.id !== id) { return r }
                return {
                    ...r,
                    status: 'deployed' as ChangeStatus,
                    deployedAt: nowIso(),
                    rollbackConfig,
                    deployResult: output,
                }
            })
            this.saveRequests()
            return output
        } catch (err: any) {
            const errMsg = err?.message ?? String(err)
            this._requests = this._requests.map(r => {
                if (r.id !== id) { return r }
                return {
                    ...r,
                    status: 'failed' as ChangeStatus,
                    deployResult: `Deploy error: ${errMsg}`,
                }
            })
            this.saveRequests()
            return `Deploy error: ${errMsg}`
        }
    }

    /**
     * Verify a deployed change by fetching the current config and comparing
     * with the proposed config.
     *
     * @param id             Change request ID.
     * @param fetchConfigFn  Async function: (nodeId) => Promise<string> — retrieves current device config.
     */
    async verifyChange (
        id: string,
        fetchConfigFn: (nodeId: string) => Promise<string>,
    ): Promise<string> {
        const cr = this._requests.find(r => r.id === id)
        if (!cr || cr.status !== 'deployed') { return 'Change not in deployed state' }

        try {
            const currentConfig = await fetchConfigFn(cr.nodeId)

            // Check if all proposed lines are present in the current config
            const proposedLines = cr.proposedConfig.split('\n').map(l => l.trim()).filter(Boolean)
            const currentLines = new Set(currentConfig.split('\n').map(l => l.trim()))
            const missing = proposedLines.filter(l => !currentLines.has(l))

            if (missing.length === 0) {
                this._requests = this._requests.map(r => {
                    if (r.id !== id) { return r }
                    return {
                        ...r,
                        status: 'verified' as ChangeStatus,
                        verifiedAt: nowIso(),
                        verifyResult: 'All proposed lines verified in running config',
                    }
                })
                this.saveRequests()
                return 'Verified successfully'
            } else {
                const diffReport = `Missing ${missing.length} line(s):\n` + missing.map(l => `  - ${l}`).join('\n')
                this._requests = this._requests.map(r => {
                    if (r.id !== id) { return r }
                    return {
                        ...r,
                        status: 'failed' as ChangeStatus,
                        verifyResult: diffReport,
                    }
                })
                this.saveRequests()
                return diffReport
            }
        } catch (err: any) {
            const errMsg = err?.message ?? String(err)
            this._requests = this._requests.map(r => {
                if (r.id !== id) { return r }
                return {
                    ...r,
                    status: 'failed' as ChangeStatus,
                    verifyResult: `Verify error: ${errMsg}`,
                }
            })
            this.saveRequests()
            return `Verify error: ${errMsg}`
        }
    }

    /**
     * Rollback a deployed (or failed) change by pushing the saved rollback config.
     *
     * @param id       Change request ID.
     * @param pushFn   Async function: (nodeId, configLines) => Promise<string>.
     */
    async rollbackChange (
        id: string,
        pushFn: (nodeId: string, configLines: string[]) => Promise<string>,
    ): Promise<string> {
        const cr = this._requests.find(r => r.id === id)
        if (!cr) { return 'Change request not found' }
        if (cr.status !== 'deployed' && cr.status !== 'failed') { return 'Change not in deployable state' }
        if (!cr.rollbackConfig) { return 'No rollback config available' }

        try {
            const lines = cr.rollbackConfig.split('\n').filter(l => l.trim())
            const output = await pushFn(cr.nodeId, lines)

            this._requests = this._requests.map(r => {
                if (r.id !== id) { return r }
                return {
                    ...r,
                    status: 'rolled-back' as ChangeStatus,
                    deployResult: `Rolled back: ${output}`,
                }
            })
            this.saveRequests()
            return output
        } catch (err: any) {
            return `Rollback error: ${err?.message ?? err}`
        }
    }

    /**
     * Remove a change request from the list (for housekeeping).
     */
    removeRequest (id: string): void {
        this._requests = this._requests.filter(r => r.id !== id)
        this.saveRequests()
    }

    // ── Diff computation ────────────────────────────────────────────────────

    /**
     * Compute a simple line-by-line diff with +/- markers.
     */
    _computeDiff (before: string, after: string): string {
        const oldLines = before.split('\n')
        const newLines = after.split('\n')
        const oldSet = new Set(oldLines.map(l => l.trim()))
        const newSet = new Set(newLines.map(l => l.trim()))
        const result: string[] = []

        for (const line of oldLines) {
            const trimmed = line.trim()
            if (!trimmed) { continue }
            if (!newSet.has(trimmed)) {
                result.push(`- ${line}`)
            }
        }
        for (const line of newLines) {
            const trimmed = line.trim()
            if (!trimmed) { continue }
            if (!oldSet.has(trimmed)) {
                result.push(`+ ${line}`)
            }
        }

        if (result.length === 0) { return '(no changes)' }
        return result.join('\n')
    }
}
