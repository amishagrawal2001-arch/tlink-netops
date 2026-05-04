/**
 * Workflow Chains — define multi-step automated workflows triggered by events.
 * Each workflow has ordered steps (notify, backup, run_command, webhook, log)
 * that execute sequentially when a matching event fires.
 */

import { Injectable } from '@angular/core'
import { EventTrigger } from '../api/interfaces'

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface WorkflowStep {
    /**
     * approval — pauses the workflow until a designated user clicks Approve
     *            or Reject in the Pending Approvals panel. Use to gate
     *            destructive ops (commit, reboot) behind a two-person rule.
     */
    action: 'notify' | 'backup_config' | 'run_command' | 'webhook' | 'log' | 'approval'
    config: Record<string, any>
    continueOnError: boolean
}

/**
 * A workflow paused at an approval step. The Pending Approvals panel
 * subscribes to pendingApprovals$ to render these and call resolveApproval.
 */
export interface PendingApproval {
    id: string
    workflowName: string
    /** Human-readable description (from approval step's config.message). */
    message: string
    /** Optional gate-name for display ("Production change", "Reboot…"). */
    gate?: string
    /** Context the workflow is running against. */
    nodeId: string
    nodeLabel: string
    trigger: string
    /** Promise resolution that the workflow loop is awaiting. */
    resolve: (decision: 'approve' | 'reject') => void
    requestedAt: string
}

/** Resolved approval — moved into history after the operator decides
 *  (or it auto-rejects). Displayed below the active queue for an audit
 *  trail of who approved what, when. */
export interface ResolvedApproval {
    workflowName: string
    message: string
    gate?: string
    nodeLabel: string
    decision: 'approve' | 'reject' | 'timeout' | 'cancelled'
    requestedAt: string
    resolvedAt: string
}

export interface Workflow {
    id: string
    name: string
    trigger: EventTrigger
    nodeFilter?: string
    vendorFilter?: string
    steps: WorkflowStep[]
    enabled: boolean
    createdAt: string
}

export interface WorkflowStepResult {
    action: string
    ok: boolean
    output: string
    durationMs: number
}

export interface WorkflowResult {
    workflowId: string
    workflowName: string
    trigger: string
    timestamp: string
    steps: WorkflowStepResult[]
    totalDurationMs: number
    success: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let _nextId = 1
function uid (): string { return `wf_${Date.now()}_${_nextId++}` }

function globMatch (pattern: string, value: string): boolean {
    if (!pattern || pattern === '*') { return true }
    const re = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                      .replace(/\*/g, '.*')
                      .replace(/\?/g, '.') + '$',
        'i',
    )
    return re.test(value)
}

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class WorkflowService {

    private _workflows: Workflow[] = []
    private _history: WorkflowResult[] = []
    private _api = (window as any).netopsAPI

    /** Pending approval gates — the UI panel reads from here and resolves
     *  decisions back via resolveApproval(). */
    private _pendingApprovals: PendingApproval[] = []
    private _approvalListeners: Array<(list: PendingApproval[]) => void> = []
    private _nextApprovalId = 1
    /** Resolved approvals — last 50 kept for audit. */
    private _approvalHistory: ResolvedApproval[] = []
    get approvalHistory (): ResolvedApproval[] { return this._approvalHistory }

    /** Active workflow runs that callers may want to cancel.
     *  Each entry: runId → { cancel(): void; cancelled: boolean }. */
    private _activeRuns = new Map<string, { cancelled: boolean; description: string }>()
    private _nextRunId = 1
    /** Snapshot of active runs (read-only). */
    get activeRuns (): Array<{ runId: string; description: string; cancelled: boolean }> {
        return [...this._activeRuns.entries()].map(([runId, v]) => ({ runId, ...v }))
    }
    /** Mark an in-flight workflow run as cancelled. The executor checks the
     *  flag between steps and bails with a "cancelled" result. Already-
     *  in-flight SSH commands aren't aborted — they finish their current
     *  step, then the loop exits. */
    cancelWorkflow (runId: string): void {
        const e = this._activeRuns.get(runId)
        if (e) {
            e.cancelled = true
            // If a workflow is paused at an approval gate, resolve it as
            // reject so the runner can see the cancellation immediately
            // instead of waiting for the operator.
            for (const p of [...this._pendingApprovals]) {
                // Best-effort match by description prefix; pending approvals
                // don't carry the runId directly (they belong to a single
                // execute call). For simplicity, resolve all of THIS run's
                // approvals via the workflow-name match.
                if (e.description.includes(p.workflowName)) {
                    this.resolveApproval(p.id, 'reject')
                }
            }
        }
    }

    /** All currently loaded workflows (read-only snapshot). */
    get workflows (): Workflow[] { return this._workflows }

    /** Execution history — last 50 runs. */
    get history (): WorkflowResult[] { return this._history }

    /** Snapshot of pending approval gates. */
    get pendingApprovals (): PendingApproval[] { return this._pendingApprovals }

    /** Subscribe to changes in the pending-approvals list. Returns an
     *  unsubscribe function. */
    onApprovalsChange (cb: (list: PendingApproval[]) => void): () => void {
        this._approvalListeners.push(cb)
        cb(this._pendingApprovals)
        return () => {
            const i = this._approvalListeners.indexOf(cb)
            if (i >= 0) { this._approvalListeners.splice(i, 1) }
        }
    }

    private _emitApprovals (): void {
        const snap = [...this._pendingApprovals]
        for (const l of this._approvalListeners) {
            try { l(snap) } catch { /* ignore */ }
        }
    }

    /** UI calls this when the operator clicks Approve or Reject. */
    resolveApproval (id: string, decision: 'approve' | 'reject'): void {
        const idx = this._pendingApprovals.findIndex(p => p.id === id)
        if (idx < 0) { return }
        const [pending] = this._pendingApprovals.splice(idx, 1)
        try { pending.resolve(decision) } catch { /* ignore */ }
        this._archiveApproval(pending, decision)
        this._emitApprovals()
    }

    private _archiveApproval (
        pending: PendingApproval,
        decision: ResolvedApproval['decision'],
    ): void {
        this._approvalHistory = [
            {
                workflowName: pending.workflowName,
                message:      pending.message,
                gate:         pending.gate,
                nodeLabel:    pending.nodeLabel,
                decision,
                requestedAt:  pending.requestedAt,
                resolvedAt:   new Date().toISOString(),
            },
            ...this._approvalHistory,
        ].slice(0, 50)
    }

    /**
     * Reject EVERY pending approval at once. Used by the canvas's
     * ngOnDestroy and by an explicit "Reject all" UI affordance to stop
     * waiting workflows from leaking forever (their resolve promise stays
     * pending and the Workflow execution is paused on `await`).
     */
    rejectAllApprovals (reason = 'app shutdown'): void {
        const list = [...this._pendingApprovals]
        this._pendingApprovals.length = 0
        const archiveDecision: ResolvedApproval['decision'] =
            reason.includes('shutdown') || reason.includes('unmounted') ? 'cancelled' : 'reject'
        for (const p of list) {
            try { p.resolve('reject') } catch { /* ignore */ }
            this._archiveApproval(p, archiveDecision)
        }
        if (list.length) {
            console.warn(`[workflow] auto-rejected ${list.length} pending approval(s): ${reason}`)
        }
        this._emitApprovals()
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    async loadWorkflows (): Promise<void> {
        try {
            const saved = await this._api?.prefGet?.('workflows')
            if (Array.isArray(saved) && saved.length > 0) {
                this._workflows = saved
            }
        } catch { /* ignore read errors */ }
        try {
            const hist = await this._api?.prefGet?.('workflow-history')
            if (Array.isArray(hist)) {
                this._history = hist.slice(-50)
            }
        } catch { /* ignore */ }
    }

    saveWorkflows (): void {
        this._api?.prefSet?.('workflows', this._workflows)
    }

    private _saveHistory (): void {
        this._api?.prefSet?.('workflow-history', this._history.slice(-50))
    }

    // ── CRUD ─────────────────────────────────────────────────────────────────

    addWorkflow (workflow: Omit<Workflow, 'id' | 'createdAt'>): Workflow {
        const full: Workflow = {
            ...workflow,
            id: uid(),
            createdAt: new Date().toISOString(),
        }
        this._workflows = [...this._workflows, full]
        this.saveWorkflows()
        return full
    }

    updateWorkflow (id: string, changes: Partial<Workflow>): void {
        this._workflows = this._workflows.map(w => w.id === id ? { ...w, ...changes } : w)
        this.saveWorkflows()
    }

    removeWorkflow (id: string): void {
        this._workflows = this._workflows.filter(w => w.id !== id)
        this.saveWorkflows()
    }

    toggleWorkflow (id: string): void {
        this._workflows = this._workflows.map(w => w.id === id ? { ...w, enabled: !w.enabled } : w)
        this.saveWorkflows()
    }

    // ── Execution ───────────────────────────────────────────────────────────

    /**
     * Execute a workflow step-by-step.
     * @param workflow  The workflow to run.
     * @param event     Context event (nodeId, trigger type, etc.).
     * @param invSvc    InventoryService for backup_config actions.
     */
    async executeWorkflow (
        workflow: Workflow,
        event: { nodeId: string; nodeLabel: string; trigger: string },
        invSvc: any,
    ): Promise<WorkflowResult> {

        const overallStart = Date.now()
        const stepResults: WorkflowStepResult[] = []
        let allOk = true

        // Register this run as cancellable. The runner checks runState.cancelled
        // between steps; if set, exits early and reports "cancelled".
        const runId = `run-${Date.now()}-${++this._nextRunId}`
        const runState = { cancelled: false, description: workflow.name }
        this._activeRuns.set(runId, runState)

        stepLoop: for (const step of workflow.steps) {
            // Cancellation check before each step. Already-in-flight SSH
            // commands can't be interrupted, but we won't START another one.
            if (runState.cancelled) {
                stepResults.push({
                    action: step.action,
                    ok: false,
                    output: 'Workflow cancelled by user',
                    durationMs: 0,
                })
                allOk = false
                break stepLoop
            }
            const stepStart = Date.now()
            let ok = true
            let output = ''

            try {
                switch (step.action) {
                    case 'notify': {
                        const message = step.config['message'] ?? `Workflow "${workflow.name}" step: notify`
                        invSvc?.raiseAlarm?.(event.nodeId, 'minor', 'automation', message)
                        output = `Notification raised: ${message}`
                        break
                    }

                    case 'backup_config': {
                        const configType = step.config['configType'] ?? 'running'
                        const result = await invSvc?.backupConfig?.(event.nodeId, configType, 'event')
                        output = result ? `Backup saved (${configType})` : 'Backup failed or skipped'
                        ok = !!result
                        break
                    }

                    case 'run_command': {
                        const command = step.config['command']
                        if (!command) { output = 'No command specified'; ok = false; break }

                        const topo = invSvc?.topoSvc?.topology
                        const node = topo?.nodes?.find((n: any) => n.id === event.nodeId)
                        if (!node || !node.sshUsername || !node.sshPassword) {
                            output = 'Node not reachable (missing credentials)'; ok = false; break
                        }
                        const host = (node.mgmtIp ?? '').split('/')[0].trim()
                        if (!host) { output = 'No management IP'; ok = false; break }

                        const result = await this._api?.sshRunCommand?.({
                            host, port: node.sshPort ?? 22,
                            username: node.sshUsername.trim(),
                            password: node.sshPassword,
                            timeoutMs: 30000,
                            command,
                        })
                        output = result?.output ?? result?.error ?? 'No output'
                        ok = result?.ok ?? false
                        break
                    }

                    case 'webhook': {
                        const url = step.config['url']
                        if (!url) { output = 'No URL specified'; ok = false; break }
                        const method = step.config['method'] ?? 'POST'
                        const headers: Record<string, string> = {
                            'Content-Type': 'application/json',
                            ...(step.config['headers'] ?? {}),
                        }
                        const body = JSON.stringify({
                            workflow: workflow.name,
                            trigger: event.trigger,
                            nodeId: event.nodeId,
                            nodeLabel: event.nodeLabel,
                            timestamp: new Date().toISOString(),
                            ...(step.config['payload'] ?? {}),
                        })
                        try {
                            const resp = await fetch(url, { method, headers, body })
                            output = `HTTP ${resp.status} ${resp.statusText}`
                            ok = resp.ok
                        } catch (err: any) {
                            output = `Fetch error: ${err?.message ?? err}`
                            ok = false
                        }
                        break
                    }

                    case 'log': {
                        const message = step.config['message'] ?? `Workflow "${workflow.name}" log step`
                        output = message
                        // eslint-disable-next-line no-console
                        console.log(`[Workflow ${workflow.name}]`, message)
                        break
                    }

                    case 'approval': {
                        // Pause execution until the operator clicks Approve or
                        // Reject in the Pending Approvals panel.
                        // Optional timeoutMinutes: auto-rejects after that
                        // many minutes so a stale approval can't pause a
                        // workflow forever.
                        const message = String(step.config['message'] ?? `Approval needed for ${workflow.name}`)
                        const gate = step.config['gate'] ? String(step.config['gate']) : undefined
                        const timeoutMin = Number(step.config['timeoutMinutes']) || 0
                        let approvalId = ''
                        let timedOut = false
                        const decision = await new Promise<'approve' | 'reject'>(resolve => {
                            approvalId = `appr-${Date.now()}-${++this._nextApprovalId}`
                            const pending: PendingApproval = {
                                id: approvalId,
                                workflowName: workflow.name,
                                message, gate,
                                nodeId: event.nodeId,
                                nodeLabel: event.nodeLabel,
                                trigger: event.trigger,
                                resolve,
                                requestedAt: new Date().toISOString(),
                            }
                            this._pendingApprovals.push(pending)
                            this._emitApprovals()
                            // Auto-reject after timeout if configured.
                            if (timeoutMin > 0) {
                                setTimeout(() => {
                                    // Only fire if still pending (didn't already resolve)
                                    const idx = this._pendingApprovals.findIndex(p => p.id === approvalId)
                                    if (idx >= 0) {
                                        const [removed] = this._pendingApprovals.splice(idx, 1)
                                        timedOut = true
                                        try { resolve('reject') } catch { /* ignore */ }
                                        this._archiveApproval(removed, 'timeout')
                                        this._emitApprovals()
                                    }
                                }, timeoutMin * 60_000)
                            }
                        })
                        if (decision === 'approve') {
                            output = `Approved by operator: ${message}`
                        } else if (timedOut) {
                            output = `Auto-rejected after ${timeoutMin} min timeout: ${message}`
                            ok = false
                        } else {
                            output = `Rejected by operator: ${message}`
                            ok = false
                            // Stop the rest of the workflow on rejection
                            // unless this step is configured to continue.
                            if (!step.continueOnError) {
                                stepResults.push({ action: step.action, ok, output, durationMs: Date.now() - stepStart })
                                allOk = false
                                break stepLoop  // exit the for-loop, not just the switch
                            }
                        }
                        break
                    }

                    default:
                        output = `Unknown action: ${step.action}`
                        ok = false
                }
            } catch (err: any) {
                ok = false
                output = `Error: ${err?.message ?? err}`
            }

            const durationMs = Date.now() - stepStart
            stepResults.push({ action: step.action, ok, output, durationMs })

            if (!ok) {
                allOk = false
                if (!step.continueOnError) { break }
            }
        }

        // De-register this run so it stops appearing in activeRuns.
        this._activeRuns.delete(runId)

        const result: WorkflowResult = {
            workflowId: workflow.id,
            workflowName: workflow.name,
            trigger: event.trigger,
            timestamp: new Date().toISOString(),
            steps: stepResults,
            totalDurationMs: Date.now() - overallStart,
            success: allOk,
        }

        this._history = [...this._history.slice(-49), result]
        this._saveHistory()

        return result
    }

    // ── Query ───────────────────────────────────────────────────────────────

    /**
     * Get all enabled workflows whose trigger + filters match the given event.
     */
    getApplicableWorkflows (event: {
        trigger: EventTrigger
        nodeLabel?: string
        vendor?: string
    }): Workflow[] {
        return this._workflows.filter(w => {
            if (!w.enabled) { return false }
            if (w.trigger !== event.trigger) { return false }
            if (w.nodeFilter && !globMatch(w.nodeFilter, event.nodeLabel ?? '')) { return false }
            if (w.vendorFilter && !globMatch(w.vendorFilter, event.vendor ?? '')) { return false }
            return true
        })
    }
}
