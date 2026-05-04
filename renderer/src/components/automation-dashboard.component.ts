import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Output, OnInit, OnDestroy,
} from '@angular/core'
import { InventoryService } from '../services/inventory.service'
import { ComplianceService, ComplianceResult } from '../services/compliance.service'
import { TopologyService } from '../services/topology.service'
import {
    WorkflowService, WorkflowResult, PendingApproval,
} from '../services/workflow.service'
import { SchedulerService, ScheduledJob } from '../services/scheduler.service'
import { PushHistoryService, PushHistoryEntry } from '../services/push-history.service'
import {
    isSupportedStagingVendor,
} from '../services/vendor-staging-builder'
import {
    loadDeviceInventory, resolveSshCredentials,
} from '../services/inventory-creds'
import { Subscription } from 'rxjs'

@Component({
    selector: 'automation-dashboard',
    templateUrl: './automation-dashboard.component.pug',
    styleUrls: ['./automation-dashboard.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationDashboardComponent implements OnInit, OnDestroy {

    @Output() closed = new EventEmitter<void>()
    /** Emitted when the user wants to drill into a specific panel.
     *  The canvas listens and opens the corresponding overlay. */
    @Output() openApprovals = new EventEmitter<void>()
    @Output() openWorkflowLibrary = new EventEmitter<void>()
    @Output() openScheduledJobs = new EventEmitter<void>()

    activeAlarms: Array<{ id: string; nodeId: string; severity: string; category: string; message: string; raisedAt: string }> = []
    recentEvents: Array<{ type: string; nodeId: string; timestamp: string; detail?: string }> = []
    backupNodes: Array<{ label: string; lastBackup: string; hasDrift: boolean }> = []
    lastPollTime = '—'
    healthScore = 100
    activeRulesCount = 0
    totalRulesCount = 0

    // ── Compliance ──────────────────────────────────────────────────────────
    complianceResults: ComplianceResult[] = []
    complianceStatus = ''
    complianceRunning = false

    // ── Workflow Service surfaces ───────────────────────────────────────────
    pendingApprovals: PendingApproval[] = []
    recentRuns: WorkflowResult[] = []
    activeRuns: Array<{ runId: string; description: string; cancelled: boolean }> = []
    approvalHistoryRecent: Array<{ workflowName: string; gate?: string; nodeLabel: string; decision: string; resolvedAt: string }> = []

    // ── Scheduler ───────────────────────────────────────────────────────────
    upcomingJobs: ScheduledJob[] = []
    schedulerRunning = false

    // ── Push History (audit trail) ──────────────────────────────────────────
    recentPushes: PushHistoryEntry[] = []
    /** Set of expanded push-history rows (so user can see per-node detail). */
    expandedPushIds = new Set<string>()

    // ── Workflow Run drill-down ─────────────────────────────────────────────
    /** Set of expanded workflow-run rows. Stored by run timestamp+name (we
     *  don't have a real id on WorkflowResult, so combine fields). */
    expandedRunKeys = new Set<string>()

    // ── Day-0 Staging summary card ──────────────────────────────────────────
    staging = {
        configured: false,
        sectionList: '',          // e.g. "NTP, SNMP, Syslog"
        nodesWithOverrides: 0,
        eligibleNodes: 0,
        unsupportedVendorCount: 0,
        lastPushIso: '',          // newest push-history entry with mode='staging'
    }

    // ── Inventory Readiness card ────────────────────────────────────────────
    readiness = {
        totalDevices: 0,          // network nodes (excludes hosts/bridges)
        mapped: 0,
        canPush: 0,
        missingCreds: 0,
        missingMgmtIp: 0,
        missingVendor: 0,
    }

    private _sub?: Subscription
    private _approvalsUnsub: (() => void) | null = null
    private _pushHistoryUnsub: (() => void) | null = null
    private _refreshTimer: ReturnType<typeof setInterval> | null = null
    private _nodeMap = new Map<string, string>()
    private _inventoryCache: Awaited<ReturnType<typeof loadDeviceInventory>> = []

    constructor (
        private invSvc: InventoryService,
        private compSvc: ComplianceService,
        private topoSvc: TopologyService,
        private wfSvc: WorkflowService,
        private schedSvc: SchedulerService,
        private pushHistorySvc: PushHistoryService,
        private cdr: ChangeDetectorRef,
    ) {}

    async ngOnInit (): Promise<void> {
        // Pre-warm caches before first refresh so summary cards render immediately.
        await this.pushHistorySvc.ensureLoaded()
        this._inventoryCache = await loadDeviceInventory()

        this._refresh()
        this._sub = this.invSvc.store$.subscribe(() => {
            this._refresh()
            this.cdr.markForCheck()
        })
        // Live updates on pending approvals (count badge + oldest gate).
        this._approvalsUnsub = this.wfSvc.onApprovalsChange((list) => {
            this.pendingApprovals = list
            this.cdr.markForCheck()
        })
        // Live updates on push history.
        this._pushHistoryUnsub = this.pushHistorySvc.onChange((list) => {
            this.recentPushes = list.slice(0, 20)
            this._refreshStagingSummary()
            this.cdr.markForCheck()
        })
        // Periodic refresh for activeRuns / upcomingJobs / runHistory — these
        // services don't broadcast change events, so poll every 4 s while open.
        this._refreshTimer = setInterval(() => {
            this._refreshDynamic()
            this.cdr.markForCheck()
        }, 4000)
    }

    ngOnDestroy (): void {
        this._sub?.unsubscribe()
        this._approvalsUnsub?.()
        this._pushHistoryUnsub?.()
        if (this._refreshTimer) { clearInterval(this._refreshTimer) }
    }

    close (): void { this.closed.emit() }

    private _refresh (): void {
        const store = this.invSvc.store

        // Build node-id → label map so alarms / events / backups show real names.
        // (Was declared but never populated — alarms used to render an 8-char
        //  uuid prefix instead of "Switch-1".)
        this._nodeMap = new Map(
            this.topoSvc.topology.nodes.map(n => [n.id, n.label] as const),
        )

        // Alarms
        this.activeAlarms = (store.alarms ?? [])
            .filter(a => !a.clearedAt)
            .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
            .slice(0, 50)

        // Events
        this.recentEvents = (store.eventLog ?? [])
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, 50)

        // Backups
        const backupMap = new Map<string, { last: string; hasDrift: boolean }>()
        for (const b of (store.configBackups ?? [])) {
            const existing = backupMap.get(b.nodeId)
            if (!existing || b.timestamp > existing.last) {
                backupMap.set(b.nodeId, { last: b.timestamp, hasDrift: false })
            }
        }
        // Check drift via alarms
        for (const a of this.activeAlarms) {
            if (a.category === 'config_drift') {
                const entry = backupMap.get(a.nodeId)
                if (entry) { entry.hasDrift = true }
            }
        }
        this.backupNodes = Array.from(backupMap.entries()).map(([nodeId, info]) => ({
            label: this.getNodeLabel(nodeId),
            lastBackup: this.formatTime(info.last),
            hasDrift: info.hasDrift,
        }))

        // Rules
        const rules = store.eventRules ?? []
        this.totalRulesCount = rules.length
        this.activeRulesCount = rules.filter(r => r.enabled).length

        // Last poll
        this.lastPollTime = store.lastFullPollAt ? this.formatTime(store.lastFullPollAt) : '—'

        // Health score
        const criticalCount = this.activeAlarms.filter(a => a.severity === 'critical').length
        const majorCount = this.activeAlarms.filter(a => a.severity === 'major').length
        this.healthScore = Math.max(0, 100 - criticalCount * 20 - majorCount * 10)

        this._refreshStagingSummary()
        this._refreshReadiness()
        this._refreshDynamic()
    }

    /** Build the Day-0 Staging summary card. */
    private _refreshStagingSummary (): void {
        const topo = this.topoSvc.topology
        const fabric: any = (topo as any).staging
        const sections: string[] = []
        if (fabric?.ntp)    { sections.push('NTP') }
        if (fabric?.snmp)   { sections.push('SNMP') }
        if (fabric?.lldp)   { sections.push('LLDP') }
        if (fabric?.syslog) { sections.push('Syslog') }
        if (fabric?.dns)    { sections.push('DNS') }
        if (fabric?.aaa)    { sections.push('AAA') }
        if (fabric?.banner) { sections.push('Banner') }

        const networkNodes = topo.nodes.filter(n => n.type !== 'host' && n.type !== 'bridge')
        const overrides   = networkNodes.filter(n => !!(n as any).staging).length
        const supported   = networkNodes.filter(n => n.vendor && isSupportedStagingVendor(n.vendor))
        const unsupported = networkNodes.filter(n => n.vendor && !isSupportedStagingVendor(n.vendor)).length

        // Most-recent staging push (across all sources).
        const lastStagingPush = this.pushHistorySvc.recent(50)
            .find(p => p.mode === 'staging' && !p.dryRun)

        this.staging = {
            configured: sections.length > 0,
            sectionList: sections.join(', '),
            nodesWithOverrides: overrides,
            eligibleNodes: supported.length,
            unsupportedVendorCount: unsupported,
            lastPushIso: lastStagingPush?.timestamp ?? '',
        }
    }

    /** Build the Inventory Readiness card by resolving creds for every node. */
    private _refreshReadiness (): void {
        const networkNodes = this.topoSvc.topology.nodes
            .filter(n => n.type !== 'host' && n.type !== 'bridge')

        let mapped = 0
        let canPush = 0
        let missingCreds = 0
        let missingMgmtIp = 0
        let missingVendor = 0

        for (const n of networkNodes) {
            if ((n as any).mapped) { mapped++ }
            if (!n.vendor) { missingVendor++ }
            const host = (n.mgmtIp ?? '').split('/')[0].trim()
            if (!host) { missingMgmtIp++ }
            const creds = resolveSshCredentials(n, this._inventoryCache)
            if (host && creds.source !== 'none') { canPush++ }
            else if (host) { missingCreds++ }
        }
        this.readiness = {
            totalDevices: networkNodes.length,
            mapped,
            canPush,
            missingCreds,
            missingMgmtIp,
            missingVendor,
        }
    }

    /** Refresh data sources that the inventory store$ subscription doesn't
     *  cover (workflow runs, scheduler jobs, approval history). Cheap reads,
     *  safe to call on a 4-s timer. */
    private _refreshDynamic (): void {
        // Pending approvals — also refreshed live by onApprovalsChange but
        // re-sync here in case the service was populated before subscribe.
        this.pendingApprovals = [...this.wfSvc.pendingApprovals]

        // Last 10 workflow runs, newest first.
        this.recentRuns = [...this.wfSvc.history]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, 10)

        // In-flight workflow runs.
        this.activeRuns = this.wfSvc.activeRuns

        // Last 10 resolved approvals (history is already newest-first).
        this.approvalHistoryRecent = this.wfSvc.approvalHistory
            .slice(0, 10)
            .map(h => ({
                workflowName: h.workflowName,
                gate: h.gate,
                nodeLabel: h.nodeLabel,
                decision: h.decision,
                resolvedAt: this.formatTime(h.resolvedAt),
            }))

        // Next 5 scheduled jobs by nextRun ascending; only enabled ones.
        const enabled = this.schedSvc.jobs.filter(j => j.enabled && j.nextRun)
        enabled.sort((a, b) => (a.nextRun ?? '').localeCompare(b.nextRun ?? ''))
        this.upcomingJobs = enabled.slice(0, 5)

        this.schedulerRunning = this.schedSvc.isRunning
    }

    getNodeLabel (nodeId: string): string {
        return this._nodeMap.get(nodeId) ?? nodeId.slice(0, 8)
    }

    formatTime (iso: string): string {
        try {
            const d = new Date(iso)
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        } catch { return iso }
    }

    /** Time-until helper for upcoming jobs (e.g. "in 12m", "in 2h"). */
    formatRelative (iso: string | undefined): string {
        if (!iso) { return '—' }
        try {
            const ms = new Date(iso).getTime() - Date.now()
            if (ms < 0)              { return 'overdue' }
            if (ms < 60_000)         { return 'in <1m' }
            if (ms < 3_600_000)      { return `in ${Math.round(ms / 60_000)}m` }
            if (ms < 86_400_000)     { return `in ${Math.round(ms / 3_600_000)}h` }
            return `in ${Math.round(ms / 86_400_000)}d`
        } catch { return iso }
    }

    /** Pretty-print a node's top failed compliance rules for the dashboard
     *  table cell. Angular templates don't accept arrow-function expressions,
     *  so the .map() lives here instead of in the pug binding. */
    topFailures (r: ComplianceResult): string {
        const failed = r.failed ?? []
        if (!failed.length) { return '—' }
        const names = failed.slice(0, 2).map(rule => rule.name)
        const overflow = failed.length > 2 ? ` · +${failed.length - 2} more` : ''
        return names.join(' · ') + overflow
    }

    /** Compact duration: "1.2 s", "450 ms", "3.4 m". */
    formatDuration (ms: number): string {
        if (!ms || ms < 0) { return '—' }
        if (ms < 1000)       { return `${ms} ms` }
        if (ms < 60_000)     { return `${(ms / 1000).toFixed(1)} s` }
        return `${(ms / 60_000).toFixed(1)} m`
    }

    acknowledgeAlarm (alarmId: string): void {
        this.invSvc.acknowledgeAlarm(alarmId)
        this._refresh()
        this.cdr.markForCheck()
    }

    clearAlarm (alarmId: string): void {
        this.invSvc.clearAlarm(alarmId)
        this._refresh()
        this.cdr.markForCheck()
    }

    backupAllNow (): void {
        this.invSvc.backupAllConfigs('manual')
    }

    pollAllNow (): void {
        this.invSvc.pollAllDevices()
    }

    async runComplianceCheck (): Promise<void> {
        this.complianceRunning = true
        this.complianceStatus = 'Running…'
        this.cdr.markForCheck()
        try {
            await this.compSvc.loadRules()
            const topo = this.topoSvc.topology
            const nodes = topo.nodes
                .filter(n => n.vendor)
                .map(n => ({ id: n.id, label: n.label, vendor: n.vendor!, role: n.role ?? '' }))
            this.complianceResults = await this.compSvc.checkAllCompliance(
                nodes,
                async (nodeId) => {
                    const node = topo.nodes.find(n => n.id === nodeId)
                    return node?.startupConfig ?? ''
                },
            )
            const avgScore = this.complianceResults.length > 0
                ? Math.round(this.complianceResults.reduce((s, r) => s + r.score, 0) / this.complianceResults.length)
                : 100
            const passed = this.complianceResults.filter(r => r.score >= 80).length
            this.complianceStatus = `${this.complianceResults.length} node(s) checked · ${passed} passed (≥ 80%) · avg score ${avgScore}%`
        } catch (err: any) {
            this.complianceStatus = `Error: ${err?.message ?? err}`
        }
        this.complianceRunning = false
        this._refresh()
        this.cdr.markForCheck()
    }

    /** Cancel an in-flight workflow run. The workflow service marks it
     *  cancelled and resolves any pending approval gates as 'reject'. */
    cancelRun (runId: string): void {
        this.wfSvc.cancelWorkflow(runId)
        // Optimistic UI update so the row reflects cancelled state immediately.
        this.activeRuns = this.activeRuns.map(r =>
            r.runId === runId ? { ...r, cancelled: true } : r,
        )
        this.cdr.markForCheck()
    }

    /** Resolve a pending approval inline from the dashboard (no need to
     *  jump to the Pending Approvals panel for simple approve/reject). */
    decideApproval (id: string, decision: 'approve' | 'reject'): void {
        this.wfSvc.resolveApproval(id, decision)
    }

    /** Manually fire a scheduled job NOW, independent of its schedule.
     *  Convenience for "I want this to run on demand from the dashboard". */
    async runJobNow (job: ScheduledJob): Promise<void> {
        if (!this.schedSvc.onRunAction) {
            this.complianceStatus = 'Scheduler action dispatcher not initialised — open Scheduled Jobs panel first.'
            this.cdr.markForCheck()
            return
        }
        try {
            await this.schedSvc.onRunAction(job.action, job.config ?? {})
            this._refreshDynamic()
            this.cdr.markForCheck()
        } catch (err: any) {
            console.warn('[dashboard] runJobNow failed:', err)
        }
    }

    requestApprovalsPanel ():        void { this.openApprovals.emit() }
    requestWorkflowLibrary ():       void { this.openWorkflowLibrary.emit() }
    requestScheduledJobsPanel ():    void { this.openScheduledJobs.emit() }

    // ── Push History row toggling ───────────────────────────────────────────
    togglePushExpand (id: string): void {
        if (this.expandedPushIds.has(id)) { this.expandedPushIds.delete(id) }
        else { this.expandedPushIds.add(id) }
        this.cdr.markForCheck()
    }
    isPushExpanded (id: string): boolean { return this.expandedPushIds.has(id) }

    // ── Workflow Run drill-down ────────────────────────────────────────────
    /** Build a stable key for a workflow run row so we can track expanded state. */
    runKey (r: WorkflowResult): string { return `${r.timestamp}_${r.workflowName}` }
    toggleRunExpand (r: WorkflowResult): void {
        const k = this.runKey(r)
        if (this.expandedRunKeys.has(k)) { this.expandedRunKeys.delete(k) }
        else { this.expandedRunKeys.add(k) }
        this.cdr.markForCheck()
    }
    isRunExpanded (r: WorkflowResult): boolean { return this.expandedRunKeys.has(this.runKey(r)) }

    /** Compact relative time ("2h ago", "12m ago", "just now"). */
    formatAge (iso: string): string {
        if (!iso) { return '—' }
        try {
            const ms = Date.now() - new Date(iso).getTime()
            if (ms < 0)             { return 'in the future' }
            if (ms < 60_000)        { return 'just now' }
            if (ms < 3_600_000)     { return `${Math.round(ms / 60_000)}m ago` }
            if (ms < 86_400_000)    { return `${Math.round(ms / 3_600_000)}h ago` }
            return `${Math.round(ms / 86_400_000)}d ago`
        } catch { return iso }
    }

    /** Wipe push history with confirmation. */
    clearPushHistory (): void {
        if (!confirm('Clear all push history? This cannot be undone.')) { return }
        this.pushHistorySvc.clear()
    }
}
