import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, EventEmitter, OnInit, Output,
} from '@angular/core'
import { ChangeManagementService, ChangeRequest, ChangeStatus } from '../services/change-management.service'
import { TopologyService } from '../services/topology.service'

@Component({
    selector: 'change-manager',
    templateUrl: './change-manager.component.pug',
    styleUrls: ['./change-manager.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangeManagerComponent implements OnInit {

    @Output() closed = new EventEmitter<void>()

    selectedRequest: ChangeRequest | null = null
    showNewForm = false
    actionInProgress = false
    rejectNotes = ''

    // New change request form
    newNodeId = ''
    newProposedConfig = ''

    constructor (
        public changeSvc: ChangeManagementService,
        private topoSvc: TopologyService,
        private cdr: ChangeDetectorRef,
    ) {}

    async ngOnInit (): Promise<void> {
        await this.changeSvc.loadRequests()
        this.cdr.markForCheck()
    }

    get requests (): ChangeRequest[] { return this.changeSvc.requests }
    get pendingCount (): number { return this.changeSvc.pendingCount }

    get topoNodes (): Array<{ id: string; label: string; vendor: string }> {
        const topo = this.topoSvc.topology
        return (topo?.nodes ?? [])
            .filter(n => n.vendor)
            .map(n => ({ id: n.id, label: n.label, vendor: n.vendor ?? '' }))
    }

    // ── Row selection ────────────────────────────────────────────────────────

    selectRequest (cr: ChangeRequest): void {
        this.selectedRequest = this.selectedRequest?.id === cr.id ? null : cr
        this.showNewForm = false
        this.rejectNotes = ''
        this.cdr.markForCheck()
    }

    // ── Status helpers ───────────────────────────────────────────────────────

    statusClass (status: ChangeStatus): string {
        switch (status) {
            case 'pending':    return 'status-amber'
            case 'approved':   return 'status-blue'
            case 'deployed':   return 'status-green'
            case 'verified':   return 'status-green-bold'
            case 'failed':     return 'status-red'
            case 'rolled-back': return 'status-grey'
            case 'rejected':   return 'status-red-dim'
            default:           return ''
        }
    }

    formatTime (iso?: string): string {
        if (!iso) { return '—' }
        try {
            const d = new Date(iso)
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
                ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        } catch { return iso }
    }

    // ── New change request ───────────────────────────────────────────────────

    toggleNewForm (): void {
        this.showNewForm = !this.showNewForm
        if (this.showNewForm) {
            this.selectedRequest = null
            this.newNodeId = ''
            this.newProposedConfig = ''
            // Pre-fill with first available node
            if (this.topoNodes.length > 0) {
                this.newNodeId = this.topoNodes[0].id
                this._prefillConfig()
            }
        }
        this.cdr.markForCheck()
    }

    onNodeChange (): void {
        this._prefillConfig()
        this.cdr.markForCheck()
    }

    private _prefillConfig (): void {
        const topo = this.topoSvc.topology
        const node = topo?.nodes?.find(n => n.id === this.newNodeId)
        this.newProposedConfig = node?.startupConfig ?? ''
    }

    submitRequest (): void {
        if (!this.newNodeId || !this.newProposedConfig.trim()) { return }

        const topo = this.topoSvc.topology
        const node = topo?.nodes?.find(n => n.id === this.newNodeId)
        const nodeLabel = node?.label ?? this.newNodeId
        const currentConfig = node?.startupConfig ?? undefined

        this.changeSvc.createRequest(
            this.newNodeId,
            nodeLabel,
            this.newProposedConfig,
            currentConfig,
        )

        this.showNewForm = false
        this.newNodeId = ''
        this.newProposedConfig = ''
        this.cdr.markForCheck()
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    approveChange (): void {
        if (!this.selectedRequest) { return }
        this.changeSvc.approveChange(this.selectedRequest.id)
        this._refreshSelected()
    }

    rejectChange (): void {
        if (!this.selectedRequest) { return }
        this.changeSvc.rejectChange(this.selectedRequest.id, this.rejectNotes || undefined)
        this._refreshSelected()
    }

    async deployChange (): Promise<void> {
        if (!this.selectedRequest || this.actionInProgress) { return }
        this.actionInProgress = true
        this.cdr.markForCheck()

        await this.changeSvc.deployChange(this.selectedRequest.id, async (nodeId, lines) => {
            const api = (window as any).netopsAPI
            const topo = this.topoSvc.topology
            const node = topo?.nodes?.find(n => n.id === nodeId)
            if (!node || !api?.sshRunCommand) { throw new Error('Node not reachable') }

            const host = (node.mgmtIp ?? '').split('/')[0].trim()
            if (!host || !node.sshUsername || !node.sshPassword) {
                throw new Error('Missing credentials or management IP')
            }

            // Push config lines as a single command block
            const command = lines.join('\n')
            const result = await api.sshRunCommand({
                host, port: node.sshPort ?? 22,
                username: node.sshUsername.trim(),
                password: node.sshPassword,
                timeoutMs: 30000,
                command,
            })
            return result?.output ?? result?.error ?? 'No output'
        })

        this.actionInProgress = false
        this._refreshSelected()
    }

    async verifyChange (): Promise<void> {
        if (!this.selectedRequest || this.actionInProgress) { return }
        this.actionInProgress = true
        this.cdr.markForCheck()

        await this.changeSvc.verifyChange(this.selectedRequest.id, async (nodeId) => {
            const api = (window as any).netopsAPI
            const topo = this.topoSvc.topology
            const node = topo?.nodes?.find(n => n.id === nodeId)
            if (!node || !api?.sshRunCommand) { throw new Error('Node not reachable') }

            const host = (node.mgmtIp ?? '').split('/')[0].trim()
            if (!host || !node.sshUsername || !node.sshPassword) {
                throw new Error('Missing credentials or management IP')
            }

            const result = await api.sshRunCommand({
                host, port: node.sshPort ?? 22,
                username: node.sshUsername.trim(),
                password: node.sshPassword,
                timeoutMs: 30000,
                command: 'show running-config',
            })
            return result?.output ?? ''
        })

        this.actionInProgress = false
        this._refreshSelected()
    }

    async rollbackChange (): Promise<void> {
        if (!this.selectedRequest || this.actionInProgress) { return }
        this.actionInProgress = true
        this.cdr.markForCheck()

        await this.changeSvc.rollbackChange(this.selectedRequest.id, async (nodeId, lines) => {
            const api = (window as any).netopsAPI
            const topo = this.topoSvc.topology
            const node = topo?.nodes?.find(n => n.id === nodeId)
            if (!node || !api?.sshRunCommand) { throw new Error('Node not reachable') }

            const host = (node.mgmtIp ?? '').split('/')[0].trim()
            if (!host || !node.sshUsername || !node.sshPassword) {
                throw new Error('Missing credentials or management IP')
            }

            const command = lines.join('\n')
            const result = await api.sshRunCommand({
                host, port: node.sshPort ?? 22,
                username: node.sshUsername.trim(),
                password: node.sshPassword,
                timeoutMs: 30000,
                command,
            })
            return result?.output ?? result?.error ?? 'No output'
        })

        this.actionInProgress = false
        this._refreshSelected()
    }

    removeRequest (): void {
        if (!this.selectedRequest) { return }
        this.changeSvc.removeRequest(this.selectedRequest.id)
        this.selectedRequest = null
        this.cdr.markForCheck()
    }

    // ── Diff helpers ─────────────────────────────────────────────────────────

    get diffLines (): Array<{ type: 'add' | 'remove' | 'context'; text: string }> {
        if (!this.selectedRequest?.diff) { return [] }
        return this.selectedRequest.diff.split('\n').map(line => {
            if (line.startsWith('+ ')) { return { type: 'add' as const, text: line } }
            if (line.startsWith('- ')) { return { type: 'remove' as const, text: line } }
            return { type: 'context' as const, text: line }
        })
    }

    // ── Utilities ────────────────────────────────────────────────────────────

    close (): void { this.closed.emit() }

    private _refreshSelected (): void {
        if (this.selectedRequest) {
            this.selectedRequest = this.changeSvc.requests.find(r => r.id === this.selectedRequest!.id) ?? null
        }
        this.cdr.markForCheck()
    }
}
