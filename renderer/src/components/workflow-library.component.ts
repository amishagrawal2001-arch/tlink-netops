import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Input, OnInit, Output,
} from '@angular/core'
import { TopologyNode } from '../api/interfaces'
import { TopologyService } from '../services/topology.service'
import { InventoryService } from '../services/inventory.service'
import { WorkflowService, Workflow, WorkflowResult } from '../services/workflow.service'
import {
    PlaybookTemplate, PlaybookCategory, PLAYBOOKS,
    groupByCategory, searchPlaybooks,
    CustomPlaybook, loadCustomPlaybooks, saveCustomPlaybooks, customAsTemplate,
} from '../services/workflow-library'

interface RunRow {
    node: TopologyNode
    /** Per-node execution status */
    status: 'pending' | 'running' | 'ok' | 'fail'
    output?: string
    durationMs?: number
}

/**
 * Workflow Library — modal that surfaces the pre-built playbook catalog,
 * collects parameters, picks target nodes, and executes the synthesized
 * workflow against each target.
 *
 * Three states:
 *   1. Browse — pick a playbook from the categorized list
 *   2. Configure — fill in the playbook's parameters + pick target nodes
 *   3. Run — show per-node progress and results
 */
@Component({
    selector: 'workflow-library',
    templateUrl: './workflow-library.component.pug',
    styleUrls: ['./workflow-library.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowLibraryComponent implements OnInit {
    @Output() closed = new EventEmitter<void>()

    /** Optional preselection from caller (e.g. right-click → run X on this node). */
    @Input() prefilledNodeIds: string[] = []

    // ── State machine ─────────────────────────────────────────────────────────
    view: 'browse' | 'configure' | 'run' = 'browse'

    // Browse view
    searchQuery = ''
    grouped: Array<{ category: PlaybookCategory; items: PlaybookTemplate[] }> = []

    // Configure view
    selected: PlaybookTemplate | null = null
    paramValues: Record<string, any> = {}
    paramError = ''
    targetNodeIds = new Set<string>()
    /** Targets eligible (have SSH creds + mgmtIp + matching vendor). */
    eligibleNodes: Array<{ node: TopologyNode; supported: boolean; reason?: string }> = []

    // Run view
    runs: RunRow[] = []
    runStarted = 0
    runComplete = false
    /** Set when the user clicks Cancel — the dispatch loop checks this
     *  between targets and halts. Already-in-flight SSH commands aren't
     *  aborted; pending approvals are auto-rejected. */
    runCancelled = false

    cancelRun (): void {
        if (this.runComplete) { return }
        this.runCancelled = true
        // Resolve any approvals belonging to this batch so paused workflows return.
        this.wfSvc.rejectAllApprovals('user cancelled run')
        this.cdr.markForCheck()
    }

    constructor (
        private cdr: ChangeDetectorRef,
        private topoSvc: TopologyService,
        private invSvc: InventoryService,
        private wfSvc: WorkflowService,
    ) {}

    /** User's saved custom playbooks (loaded from prefs at init). Surfaced as a
     *  "Custom" category alongside the built-ins. Each entry is rendered via
     *  `customAsTemplate` which delegates back to a base playbook with the
     *  saved param values pre-filled. */
    customPlaybooks: CustomPlaybook[] = []

    /** Save dialog state — shown after a successful run lets the user capture
     *  the just-configured parameter set as a reusable named playbook. */
    showSaveDialog = false
    saveDialogName = ''
    saveDialogDescription = ''
    saveDialogError = ''

    async ngOnInit (): Promise<void> {
        // Load custom playbooks BEFORE first refresh so they show up in the
        // browse list immediately on open.
        this.customPlaybooks = await loadCustomPlaybooks()
        this._refreshCatalog()
    }

    close (): void { this.closed.emit() }

    // ── Browse → Configure ────────────────────────────────────────────────────

    /** Build the full template list = built-ins ∪ projected customs. Customs
     *  whose base playbook has been removed (shouldn't happen but defensive)
     *  are dropped silently. */
    private _allTemplates (): PlaybookTemplate[] {
        const baseById = new Map(PLAYBOOKS.map(p => [p.id, p]))
        const projected = this.customPlaybooks
            .map(c => customAsTemplate(c, baseById.get(c.basePlaybookId)))
            .filter((t): t is PlaybookTemplate => !!t)
        return [...PLAYBOOKS, ...projected]
    }

    private _refreshCatalog (): void {
        const list = searchPlaybooks(this.searchQuery, this._allTemplates())
        this.grouped = groupByCategory(list)
        this.cdr.markForCheck()
    }

    onSearchChange (): void { this._refreshCatalog() }

    // ── Save as Custom Playbook ──────────────────────────────────────────────

    /** Open the save dialog from the run-results view. Pre-fills name with
     *  the base playbook's name + " (custom)" so the user has a sensible
     *  starting point. */
    openSaveDialog (): void {
        if (!this.selected) { return }
        // Don't let the user save a custom-of-a-custom — keeps the chain flat.
        // (Saving a custom would create one whose base is itself a custom,
        // which complicates the projection. Custom playbooks always derive
        // from a built-in template.)
        const isAlreadyCustom = !PLAYBOOKS.some(p => p.id === this.selected!.id)
        if (isAlreadyCustom) {
            this.saveDialogError = 'Cannot save a custom playbook as another custom — modify the params and re-run, then save against the base.'
            return
        }
        this.saveDialogName = `${this.selected.name} (custom)`
        this.saveDialogDescription = ''
        this.saveDialogError = ''
        this.showSaveDialog = true
        this.cdr.markForCheck()
    }

    cancelSaveDialog (): void {
        this.showSaveDialog = false
        this.saveDialogError = ''
        this.cdr.markForCheck()
    }

    async confirmSaveDialog (): Promise<void> {
        const name = this.saveDialogName.trim()
        if (!name) { this.saveDialogError = 'Name is required'; this.cdr.markForCheck(); return }
        if (!this.selected) { return }
        // Reject duplicate names — would confuse the user in the browse list.
        if (this.customPlaybooks.some(c => c.name.toLowerCase() === name.toLowerCase())) {
            this.saveDialogError = `A custom playbook named "${name}" already exists`
            this.cdr.markForCheck()
            return
        }
        const id = `custom-${Date.now()}-${Math.floor(Math.random() * 9999)}`
        const newCustom: CustomPlaybook = {
            id,
            name,
            description: this.saveDialogDescription.trim(),
            basePlaybookId: this.selected.id,
            paramValues: { ...this.paramValues },
            createdAt: new Date().toISOString(),
        }
        this.customPlaybooks = [...this.customPlaybooks, newCustom]
        await saveCustomPlaybooks(this.customPlaybooks)
        this.showSaveDialog = false
        this._refreshCatalog()
    }

    /** Delete a custom playbook (called from the browse view). */
    async deleteCustomPlaybook (id: string): Promise<void> {
        const cp = this.customPlaybooks.find(c => c.id === id)
        if (!cp) { return }
        if (!confirm(`Delete custom playbook "${cp.name}"? This cannot be undone.`)) { return }
        this.customPlaybooks = this.customPlaybooks.filter(c => c.id !== id)
        await saveCustomPlaybooks(this.customPlaybooks)
        this._refreshCatalog()
    }

    /** True when the playbook currently configured/run is a built-in (vs
     *  a saved custom one) — used to gate the "Save as custom playbook"
     *  button so customs can't be re-saved as further customs. */
    get canSaveAsCustom (): boolean {
        return !!this.selected && PLAYBOOKS.some(p => p.id === this.selected!.id)
    }

    /** True for templates whose id matches a saved custom (used by the
     *  browse-list to render a delete button only on user-saved entries). */
    isCustomTemplate (t: PlaybookTemplate): boolean {
        return this.customPlaybooks.some(c => c.id === t.id)
    }

    pickPlaybook (p: PlaybookTemplate): void {
        this.selected = p
        this.paramValues = {}
        this.paramError = ''
        // Pre-fill defaults
        for (const param of p.parameters) {
            if (param.default != null) { this.paramValues[param.name] = param.default }
        }
        this._buildEligibleList()
        // Pre-select if caller passed in node IDs
        this.targetNodeIds = new Set(this.prefilledNodeIds.filter(id =>
            this.eligibleNodes.some(e => e.supported && e.node.id === id),
        ))
        this.view = 'configure'
        this.cdr.markForCheck()
    }

    backToBrowse (): void {
        this.selected = null
        this.view = 'browse'
        this.cdr.markForCheck()
    }

    /** Compute which topology nodes are eligible for the selected playbook
     *  (must have SSH creds + mgmt IP + matching vendor). */
    private _buildEligibleList (): void {
        const pb = this.selected
        if (!pb) { this.eligibleNodes = []; return }
        const out: Array<{ node: TopologyNode; supported: boolean; reason?: string }> = []
        for (const n of this.topoSvc.topology.nodes) {
            // Filter out non-network types
            if (n.type === 'host' || n.type === 'pc' || n.type === 'cloud' || n.type === 'bridge') { continue }
            const hasCreds = !!n.sshUsername && !!n.sshPassword && !!(n.mgmtIp || '').split('/')[0]
            const vendorOk = pb.vendors.length === 0
                || pb.vendors.some(v => (n.vendor || '').toLowerCase().startsWith(v.toLowerCase()))
            const supported = hasCreds && vendorOk
            const reason = !hasCreds
                ? 'no SSH creds / mgmt IP'
                : !vendorOk
                    ? `vendor "${n.vendor || 'unset'}" not supported`
                    : undefined
            out.push({ node: n, supported, reason })
        }
        this.eligibleNodes = out
    }

    toggleTarget (nodeId: string): void {
        if (this.targetNodeIds.has(nodeId)) { this.targetNodeIds.delete(nodeId) }
        else                                 { this.targetNodeIds.add(nodeId) }
        this.cdr.markForCheck()
    }

    selectAllEligible (): void {
        for (const e of this.eligibleNodes) {
            if (e.supported) { this.targetNodeIds.add(e.node.id) }
        }
        this.cdr.markForCheck()
    }

    clearTargets (): void {
        this.targetNodeIds.clear()
        this.cdr.markForCheck()
    }

    onParamChange (name: string, value: any): void {
        this.paramValues[name] = value
        this.paramError = ''
        this.cdr.markForCheck()
    }

    /** Validate parameters; returns null on success or an error message. */
    private _validateParams (): string | null {
        if (!this.selected) { return 'No playbook selected' }
        for (const p of this.selected.parameters) {
            if (p.required) {
                const v = this.paramValues[p.name]
                if (v == null || v === '') { return `${p.label} is required` }
            }
        }
        return null
    }

    // ── Configure → Run ───────────────────────────────────────────────────────

    async startRun (): Promise<void> {
        const err = this._validateParams()
        if (err) { this.paramError = err; this.cdr.markForCheck(); return }
        if (!this.targetNodeIds.size) {
            this.paramError = 'Pick at least one target node'
            this.cdr.markForCheck()
            return
        }

        this.runs = [...this.targetNodeIds].map(id => {
            const node = this.topoSvc.topology.nodes.find(n => n.id === id)!
            return { node, status: 'pending' }
        })
        this.runComplete = false
        this.runCancelled = false
        this.runStarted = Date.now()
        this.view = 'run'
        this.cdr.markForCheck()

        await this._executeRows(this.runs)
        this.runComplete = true
        this.cdr.markForCheck()
    }

    /** Execute the workflow against the given rows. Shared by startRun (full
     *  run) and retryFailed (partial re-run against just the failed nodes). */
    private async _executeRows (rows: RunRow[]): Promise<void> {
        // Sequential. Could parallelize later; sequential is safer for changes
        // that depend on the previous step (and leaves room for approval gates).
        for (const row of rows) {
            // Honor user cancellation between targets — already-in-flight
            // workflows finish their current step but no new target starts.
            if (this.runCancelled) {
                row.status = 'fail'
                row.output = 'Cancelled by user'
                this.cdr.markForCheck()
                continue
            }
            row.status = 'running'
            this.cdr.markForCheck()
            try {
                const wf = this._buildWorkflow(row.node)
                const result: WorkflowResult = await this.wfSvc.executeWorkflow(
                    wf,
                    { nodeId: row.node.id, nodeLabel: row.node.label, trigger: 'workflow-library' },
                    this.invSvc,
                )
                row.status = result.success ? 'ok' : 'fail'
                row.durationMs = result.totalDurationMs
                row.output = result.steps.map(s => s.output).join('\n').slice(0, 2000)
            } catch (e) {
                row.status = 'fail'
                row.output = (e as Error).message
            }
            this.cdr.markForCheck()
        }
    }

    /** Re-run the same playbook (same params) against ONLY the failed targets
     *  from the last run. Most-asked workflow ergonomics — closes the loop on
     *  partial-fail batches without re-applying to working nodes. */
    async retryFailed (): Promise<void> {
        const failed = this.runs.filter(r => r.status === 'fail')
        if (!failed.length) { return }
        // Reset just the failed rows to 'pending' so the UI shows them as
        // queued again (the OK rows stay green from the previous run).
        for (const r of failed) {
            r.status = 'pending'
            r.output = ''
            r.durationMs = undefined
        }
        this.runComplete = false
        this.runCancelled = false
        this.cdr.markForCheck()
        await this._executeRows(failed)
        this.runComplete = true
        this.cdr.markForCheck()
    }

    /** Build a Workflow object the existing service can execute. */
    private _buildWorkflow (node: TopologyNode): Workflow {
        const pb = this.selected!
        // Hand the playbook the full node + topology staging defaults — needed
        // by playbooks like "Apply Staging Only" that merge fabric + per-node.
        const steps = pb.buildSteps(this.paramValues, node.vendor || '', {
            node,
            topologyStaging: (this.topoSvc.topology as any).staging,
        })
        return {
            id: `library-${pb.id}-${Date.now()}`,
            name: `${pb.name} → ${node.label}`,
            trigger: 'workflow-library' as any,
            steps,
            enabled: true,
            createdAt: new Date().toISOString(),
        }
    }

    /** Aggregate counts for the run-results header. */
    get runStats () {
        const total = this.runs.length
        const ok = this.runs.filter(r => r.status === 'ok').length
        const fail = this.runs.filter(r => r.status === 'fail').length
        const running = this.runs.filter(r => r.status === 'running').length
        const pending = this.runs.filter(r => r.status === 'pending').length
        return { total, ok, fail, running, pending }
    }

    runAgain (): void {
        this.runs = []
        this.runComplete = false
        this.view = 'configure'
        this.cdr.markForCheck()
    }

    expandedRowId: string | null = null
    toggleRowDetails (rowId: string): void {
        this.expandedRowId = this.expandedRowId === rowId ? null : rowId
        this.cdr.markForCheck()
    }
}
