import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Input, OnInit, Output,
} from '@angular/core'
import { TopologyNode } from '../api/interfaces'
import { TopologyService } from '../services/topology.service'
import { InventoryService } from '../services/inventory.service'
import { WorkflowService, Workflow, WorkflowResult } from '../services/workflow.service'
import {
    PlaybookTemplate, PlaybookCategory,
    groupByCategory, searchPlaybooks,
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

    ngOnInit (): void {
        this._refreshCatalog()
    }

    close (): void { this.closed.emit() }

    // ── Browse → Configure ────────────────────────────────────────────────────

    private _refreshCatalog (): void {
        const list = searchPlaybooks(this.searchQuery)
        this.grouped = groupByCategory(list)
        this.cdr.markForCheck()
    }

    onSearchChange (): void { this._refreshCatalog() }

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

        // Execute against each target sequentially. Could parallelize later;
        // sequential is safer for changes that depend on the previous step
        // (and leaves the door open for an optional approval gate).
        for (const row of this.runs) {
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
