import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, EventEmitter, OnInit, Output,
} from '@angular/core'
import { ComplianceService, GoldenConfigRule, ComplianceResult } from '../services/compliance.service'
import { InventoryService } from '../services/inventory.service'
import { TopologyService } from '../services/topology.service'

@Component({
    selector: 'compliance-panel',
    templateUrl: './compliance-panel.component.pug',
    styleUrls: ['./compliance-panel.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CompliancePanelComponent implements OnInit {

    @Output() closed = new EventEmitter<void>()

    activeTab: 'rules' | 'results' = 'rules'
    results: ComplianceResult[] = []
    checking = false

    // Add-rule form
    showAddForm = false
    newName = ''
    newVendor = '*'
    newRole = ''
    newPattern = ''
    newSeverity: GoldenConfigRule['severity'] = 'major'
    newDescription = ''

    // Edit-rule state
    editingId: string | null = null
    editName = ''
    editVendor = '*'
    editRole = ''
    editPattern = ''
    editSeverity: GoldenConfigRule['severity'] = 'major'
    editDescription = ''

    readonly vendorOptions = ['*', 'cisco', 'cisco*', 'juniper', 'arista', 'nokia', 'sonic', 'huawei', 'hpe', 'dell', 'mikrotik', 'extreme']
    readonly severityOptions: GoldenConfigRule['severity'][] = ['critical', 'major', 'minor', 'warning']

    constructor (
        public compSvc: ComplianceService,
        private invSvc: InventoryService,
        private topoSvc: TopologyService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit (): void {
        this.compSvc.initDefaultRules()
    }

    get rules (): GoldenConfigRule[] { return this.compSvc.rules }

    // ── Tab switching ────────────────────────────────────────────────────────

    setTab (tab: 'rules' | 'results'): void {
        this.activeTab = tab
        this.cdr.markForCheck()
    }

    // ── Rule CRUD ────────────────────────────────────────────────────────────

    toggleAddForm (): void {
        this.showAddForm = !this.showAddForm
        this.cdr.markForCheck()
    }

    addRule (): void {
        if (!this.newName.trim() || !this.newPattern.trim()) { return }
        this.compSvc.addRule({
            name: this.newName.trim(),
            vendor: this.newVendor,
            role: this.newRole || undefined,
            pattern: this.newPattern.trim(),
            severity: this.newSeverity,
            description: this.newDescription.trim(),
            enabled: true,
        })
        this.newName = ''
        this.newPattern = ''
        this.newDescription = ''
        this.newRole = ''
        this.showAddForm = false
        this.cdr.markForCheck()
    }

    startEdit (rule: GoldenConfigRule): void {
        this.editingId = rule.id
        this.editName = rule.name
        this.editVendor = rule.vendor
        this.editRole = rule.role ?? ''
        this.editPattern = rule.pattern
        this.editSeverity = rule.severity
        this.editDescription = rule.description
        this.cdr.markForCheck()
    }

    saveEdit (): void {
        if (!this.editingId) { return }
        this.compSvc.updateRule(this.editingId, {
            name: this.editName.trim(),
            vendor: this.editVendor,
            role: this.editRole || undefined,
            pattern: this.editPattern.trim(),
            severity: this.editSeverity,
            description: this.editDescription.trim(),
        })
        this.editingId = null
        this.cdr.markForCheck()
    }

    cancelEdit (): void {
        this.editingId = null
        this.cdr.markForCheck()
    }

    removeRule (id: string): void {
        this.compSvc.removeRule(id)
        this.cdr.markForCheck()
    }

    toggleRule (id: string): void {
        this.compSvc.toggleRule(id)
        this.cdr.markForCheck()
    }

    // ── Compliance Check ─────────────────────────────────────────────────────

    async runCheck (): Promise<void> {
        this.checking = true
        this.cdr.markForCheck()

        const topo = this.topoSvc.topology
        const nodes = (topo?.nodes ?? [])
            .filter(n => n.vendor && n.sshUsername && n.sshPassword)
            .map(n => ({
                id: n.id,
                label: n.label,
                vendor: n.vendor ?? '',
                role: n.role ?? '',
            }))

        try {
            this.results = await this.compSvc.checkAllCompliance(
                nodes,
                async (nodeId: string) => {
                    const backup = this.invSvc.store.configBackups
                        .filter(b => b.nodeId === nodeId && b.configType === 'running')
                        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]
                    return backup?.content ?? ''
                },
            )
        } catch {
            this.results = []
        }

        this.checking = false
        this.activeTab = 'results'
        this.cdr.markForCheck()
    }

    scoreClass (score: number): string {
        if (score >= 90) { return 'score-green' }
        if (score >= 70) { return 'score-amber' }
        return 'score-red'
    }

    close (): void {
        this.closed.emit()
    }
}
