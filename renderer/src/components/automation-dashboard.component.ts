import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Output, OnInit, OnDestroy,
} from '@angular/core'
import { InventoryService } from '../services/inventory.service'
import { ComplianceService, ComplianceResult } from '../services/compliance.service'
import { TopologyService } from '../services/topology.service'
import { Subscription } from 'rxjs'

@Component({
    selector: 'automation-dashboard',
    templateUrl: './automation-dashboard.component.pug',
    styleUrls: ['./automation-dashboard.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutomationDashboardComponent implements OnInit, OnDestroy {

    @Output() closed = new EventEmitter<void>()

    activeAlarms: Array<{ id: string; nodeId: string; severity: string; category: string; message: string; raisedAt: string }> = []
    recentEvents: Array<{ type: string; nodeId: string; timestamp: string; detail?: string }> = []
    backupNodes: Array<{ label: string; lastBackup: string; hasDrift: boolean }> = []
    lastPollTime = '—'
    healthScore = 100
    activeRulesCount = 0
    totalRulesCount = 0
    complianceResults: ComplianceResult[] = []
    complianceStatus = ''

    private _sub?: Subscription
    private _nodeMap = new Map<string, string>()

    constructor (
        private invSvc: InventoryService,
        private compSvc: ComplianceService,
        private topoSvc: TopologyService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit (): void {
        this._refresh()
        this._sub = this.invSvc.store$.subscribe(() => {
            this._refresh()
            this.cdr.markForCheck()
        })
    }

    ngOnDestroy (): void {
        this._sub?.unsubscribe()
    }

    close (): void { this.closed.emit() }

    private _refresh (): void {
        const store = this.invSvc.store

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
    }

    getNodeLabel (nodeId: string): string {
        // Try to find node label from topology (passed through or cached)
        return this._nodeMap.get(nodeId) ?? nodeId.slice(0, 8)
    }

    formatTime (iso: string): string {
        try {
            const d = new Date(iso)
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        } catch { return iso }
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
        this.complianceStatus = 'Running...'
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
            this.complianceStatus = `${this.complianceResults.length} node(s) checked — avg score ${avgScore}%`
        } catch (err: any) {
            this.complianceStatus = `Error: ${err?.message ?? err}`
        }
        this._refresh()
        this.cdr.markForCheck()
    }
}
