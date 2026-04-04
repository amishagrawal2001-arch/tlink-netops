/**
 * Workflow Chains — define multi-step automated workflows triggered by events.
 * Each workflow has ordered steps (notify, backup, run_command, webhook, log)
 * that execute sequentially when a matching event fires.
 */

import { Injectable } from '@angular/core'
import { EventTrigger } from '../api/interfaces'

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface WorkflowStep {
    action: 'notify' | 'backup_config' | 'run_command' | 'webhook' | 'log'
    config: Record<string, any>
    continueOnError: boolean
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

    /** All currently loaded workflows (read-only snapshot). */
    get workflows (): Workflow[] { return this._workflows }

    /** Execution history — last 50 runs. */
    get history (): WorkflowResult[] { return this._history }

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

        for (const step of workflow.steps) {
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
