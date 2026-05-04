import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, OnInit, Output,
} from '@angular/core'
import { TopologyNode, NodePort } from '../api/interfaces'
import { TopologyService } from '../services/topology.service'
import { InventoryService } from '../services/inventory.service'
import { WorkflowService, WorkflowStep, Workflow } from '../services/workflow.service'

type BulkAction = 'shut' | 'no-shut' | 'mtu' | 'description' | 'clear-counters'

interface PreviewLine {
    nodeLabel: string
    vendor: string
    portCount: number
    command: string
}

interface NodePortPair {
    node: TopologyNode
    port: NodePort
    /** Quick label "spine-1 / et-0/0/5" */
    label: string
    selected: boolean
}

interface RunRow {
    nodeId: string
    label: string
    port: string
    status: 'pending' | 'running' | 'ok' | 'fail'
    output?: string
}

/**
 * Bulk Port Operations — multi-node multi-port action dispatcher.
 *
 * Compared to the workflow library's single-port playbooks, this dialog
 * lets you tick many `(node, port)` pairs and apply ONE action to all of
 * them in a single shot — useful during maintenance windows when, e.g.,
 * shutting every uplink to a spine you're about to reload.
 *
 * Generates vendor-correct commands per node and runs them in parallel
 * waves of 4 (same pattern as discovery / dry-run).
 */
@Component({
    selector: 'bulk-port-ops',
    templateUrl: './bulk-port-ops.component.pug',
    styleUrls: ['./bulk-port-ops.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BulkPortOpsComponent implements OnInit {
    @Output() closed = new EventEmitter<void>()

    view: 'configure' | 'preview' | 'run' = 'configure'

    /** Synthesized commands per node — recomputed when entering preview. */
    preview: PreviewLine[] = []

    action: BulkAction = 'shut'
    /** action-specific params */
    mtuValue = 9216
    descriptionValue = ''

    pairs: NodePortPair[] = []
    /** Filter text — reduces the visible pair list. */
    filterText = ''

    runs: RunRow[] = []
    runComplete = false
    runCancelled = false
    error = ''

    cancelRun (): void {
        if (this.runComplete) { return }
        this.runCancelled = true
        this.cdr.markForCheck()
    }

    constructor (
        private cdr: ChangeDetectorRef,
        private topoSvc: TopologyService,
        private invSvc: InventoryService,
        private wfSvc: WorkflowService,
    ) {}

    ngOnInit (): void {
        // Build the (node, port) flat list from current topology.
        const out: NodePortPair[] = []
        for (const n of this.topoSvc.topology.nodes) {
            // Skip non-network types
            if (n.type === 'host' || n.type === 'pc' || n.type === 'cloud' || n.type === 'bridge') { continue }
            const host = (n.mgmtIp ?? '').split('/')[0]
            if (!host || !n.sshUsername || !n.sshPassword) { continue }   // can't push without creds
            for (const p of n.ports) {
                out.push({
                    node: n,
                    port: p,
                    label: `${n.label} / ${p.label}`,
                    selected: false,
                })
            }
        }
        this.pairs = out
        this.cdr.markForCheck()
    }

    close (): void { this.closed.emit() }

    get filteredPairs (): NodePortPair[] {
        if (!this.filterText.trim()) { return this.pairs }
        const q = this.filterText.toLowerCase()
        return this.pairs.filter(p => p.label.toLowerCase().includes(q))
    }

    get selectedCount (): number {
        return this.pairs.filter(p => p.selected).length
    }

    toggleAllVisible (): void {
        const list = this.filteredPairs
        const allSel = list.every(p => p.selected)
        for (const p of list) { p.selected = !allSel }
        this.cdr.markForCheck()
    }

    clearSelection (): void {
        for (const p of this.pairs) { p.selected = false }
        this.cdr.markForCheck()
    }

    setAction (a: BulkAction): void {
        this.action = a
        this.error = ''
        this.cdr.markForCheck()
    }

    /** Validate params for the selected action. Returns null on ok. */
    private _validate (): string | null {
        if (!this.selectedCount) { return 'Pick at least one port.' }
        if (this.action === 'mtu') {
            if (!Number.isFinite(this.mtuValue) || this.mtuValue < 64 || this.mtuValue > 16384) {
                return 'MTU must be a number between 64 and 16384.'
            }
        }
        if (this.action === 'description' && !this.descriptionValue.trim()) {
            return 'Description text is required.'
        }
        return null
    }

    /** Compute the synthesized commands without actually running anything,
     *  then transition to the preview view. Lets the operator inspect the
     *  exact vendor-specific commands before clicking Apply. */
    showPreview (): void {
        const err = this._validate()
        if (err) { this.error = err; this.cdr.markForCheck(); return }
        const selected = this.pairs.filter(p => p.selected)
        const byNode = new Map<string, { node: TopologyNode; ports: NodePort[] }>()
        for (const p of selected) {
            if (!byNode.has(p.node.id)) { byNode.set(p.node.id, { node: p.node, ports: [] }) }
            byNode.get(p.node.id)!.ports.push(p.port)
        }
        this.preview = []
        for (const g of byNode.values()) {
            this.preview.push({
                nodeLabel: g.node.label,
                vendor: g.node.vendor || '—',
                portCount: g.ports.length,
                command: this._buildCommand(g.node.vendor || '', g.ports) || '# UNSUPPORTED VENDOR',
            })
        }
        this.error = ''
        this.view = 'preview'
        this.cdr.markForCheck()
    }

    backToConfigure (): void {
        this.view = 'configure'
        this.cdr.markForCheck()
    }

    async startRun (): Promise<void> {
        const err = this._validate()
        if (err) { this.error = err; this.cdr.markForCheck(); return }

        const selected = this.pairs.filter(p => p.selected)
        // Group selected ports by node — fewer SSH sessions, fewer config commits.
        const byNode = new Map<string, { node: TopologyNode; ports: NodePort[] }>()
        for (const p of selected) {
            if (!byNode.has(p.node.id)) { byNode.set(p.node.id, { node: p.node, ports: [] }) }
            byNode.get(p.node.id)!.ports.push(p.port)
        }

        this.runs = selected.map(p => ({
            nodeId: p.node.id,
            label: p.node.label,
            port: p.port.label,
            status: 'pending',
        }))
        this.error = ''
        this.runComplete = false
        this.view = 'run'
        this.cdr.markForCheck()

        // Dispatch in parallel waves of 4 nodes (each sends one workflow with
        // all its selected ports in one commit).
        const concurrency = 4
        const nodes = [...byNode.values()]
        for (let i = 0; i < nodes.length; i += concurrency) {
            // Honor user cancellation between waves.
            if (this.runCancelled) {
                for (const r of this.runs) {
                    if (r.status === 'pending') {
                        r.status = 'fail'
                        r.output = 'Cancelled by user'
                    }
                }
                break
            }
            const wave = nodes.slice(i, i + concurrency)
            await Promise.all(wave.map(g => this._dispatchOne(g)))
            this.cdr.markForCheck()
        }
        this.runComplete = true
        this.cdr.markForCheck()
    }

    private async _dispatchOne (group: { node: TopologyNode; ports: NodePort[] }): Promise<void> {
        const cmd = this._buildCommand(group.node.vendor || '', group.ports)
        if (!cmd) {
            for (const p of group.ports) {
                const r = this.runs.find(x => x.nodeId === group.node.id && x.port === p.label)
                if (r) { r.status = 'fail'; r.output = `Unsupported vendor: ${group.node.vendor || 'unset'}` }
            }
            return
        }

        // Mark all ports for this node as running
        for (const p of group.ports) {
            const r = this.runs.find(x => x.nodeId === group.node.id && x.port === p.label)
            if (r) { r.status = 'running' }
        }
        this.cdr.markForCheck()

        // Build a one-step workflow and reuse the workflow service's executor
        // (consistent SSH plumbing + history logging).
        const wf: Workflow = {
            id: `bulk-port-${Date.now()}`,
            name: `Bulk ${this.action} → ${group.node.label} (${group.ports.length} port${group.ports.length === 1 ? '' : 's'})`,
            trigger: 'bulk-port-ops' as any,
            steps: [{ action: 'run_command', config: { command: cmd }, continueOnError: false } as WorkflowStep],
            enabled: true,
            createdAt: new Date().toISOString(),
        }
        try {
            const result = await this.wfSvc.executeWorkflow(
                wf,
                { nodeId: group.node.id, nodeLabel: group.node.label, trigger: 'bulk-port-ops' },
                this.invSvc,
            )
            const stepOk = result.success
            const out = result.steps[0]?.output ?? ''
            for (const p of group.ports) {
                const r = this.runs.find(x => x.nodeId === group.node.id && x.port === p.label)
                if (!r) { continue }
                r.status = stepOk ? 'ok' : 'fail'
                r.output = out.slice(0, 1000)
            }
        } catch (e) {
            for (const p of group.ports) {
                const r = this.runs.find(x => x.nodeId === group.node.id && x.port === p.label)
                if (r) { r.status = 'fail'; r.output = (e as Error).message }
            }
        }
    }

    /** Compose vendor-correct command lines for the action against N ports.
     *  Returns '' for unsupported vendors so the run UI can flag the row. */
    private _buildCommand (vendor: string, ports: NodePort[]): string {
        const v = vendor.toLowerCase()
        const isJun     = /^juniper/.test(v)
        const isCisAri  = /^cisco|^arista|^nxos|^iosxr|^hpe|^dell/.test(v)   // IOS-like family
        const isHuawei  = /^huawei/.test(v)
        const isNokia   = /^nokia/.test(v)
        const isExtreme = /^extreme/.test(v)
        const isMikrotik = /^mikrotik/.test(v)
        const isSonic   = /^sonic/.test(v)

        // Junos: configure private; … commit and-quit
        if (isJun) {
            const lines: string[] = []
            for (const p of ports) {
                switch (this.action) {
                    case 'shut':       lines.push(`set interfaces ${p.label} disable`); break
                    case 'no-shut':    lines.push(`delete interfaces ${p.label} disable`); break
                    case 'mtu':        lines.push(`set interfaces ${p.label} mtu ${this.mtuValue}`); break
                    case 'description':lines.push(`set interfaces ${p.label} description "${this.descriptionValue.replace(/"/g, '\\"')}"`); break
                    case 'clear-counters':
                        return ports.map(pp => `clear interfaces statistics ${pp.label}`).join('; ')
                }
            }
            if (!lines.length) { return '' }
            return `configure private; ${lines.join('; ')}; commit and-quit`
        }

        // Cisco/Arista/NXOS/IOS-XR/HPE-Comware/Dell-OS10 — IOS-style stanza
        if (isCisAri) {
            if (this.action === 'clear-counters') {
                return ports.map(p => `clear counters ${p.label}`).join('\n')
            }
            const out: string[] = ['configure terminal']
            for (const p of ports) {
                out.push(`interface ${p.label}`)
                switch (this.action) {
                    case 'shut':        out.push(' shutdown'); break
                    case 'no-shut':     out.push(' no shutdown'); break
                    case 'mtu':         out.push(` mtu ${this.mtuValue}`); break
                    case 'description': out.push(` description ${this.descriptionValue}`); break
                }
            }
            out.push('end', 'write memory')
            return out.join('\n')
        }

        // Huawei VRP — `system-view` modal CLI; `undo shutdown` for no-shut
        if (isHuawei) {
            if (this.action === 'clear-counters') {
                return ports.map(p => `reset counters interface ${p.label}`).join('\n')
            }
            const out: string[] = ['system-view']
            for (const p of ports) {
                out.push(`interface ${p.label}`)
                switch (this.action) {
                    case 'shut':        out.push(' shutdown'); break
                    case 'no-shut':     out.push(' undo shutdown'); break
                    case 'mtu':         out.push(` jumboframe enable ${this.mtuValue}`); break
                    case 'description': out.push(` description ${this.descriptionValue}`); break
                }
            }
            out.push('quit', 'save force')
            return out.join('\n')
        }

        // Nokia SR OS — candidate config + commit
        if (isNokia) {
            if (this.action === 'clear-counters') { return '' }    // not common; skip
            const lines: string[] = ['enter candidate']
            for (const p of ports) {
                switch (this.action) {
                    case 'shut':        lines.push(`configure interface ${p.label} admin-state disable`); break
                    case 'no-shut':     lines.push(`configure interface ${p.label} admin-state enable`); break
                    case 'mtu':         lines.push(`configure interface ${p.label} mtu ${this.mtuValue}`); break
                    case 'description': lines.push(`configure interface ${p.label} description "${this.descriptionValue}"`); break
                }
            }
            lines.push('commit')
            return lines.join('; ')
        }

        // Extreme XOS — single-line commands, no modal CLI
        if (isExtreme) {
            const verb = this.action === 'shut' ? 'disable port'
                : this.action === 'no-shut' ? 'enable port'
                : this.action === 'mtu' ? 'configure jumbo-frame size'
                : this.action === 'clear-counters' ? 'clear counters ports'
                : null
            if (!verb) { return '' }
            if (this.action === 'description') { return '' }   // EXOS uses display-string differently; skip
            return ports.map(p => `${verb} ${p.label}`).join('\n')
        }

        // MikroTik RouterOS — /interface set syntax
        if (isMikrotik) {
            if (this.action === 'clear-counters') { return '' }   // /interface monitor-traffic doesn't reset
            return ports.map(p => {
                switch (this.action) {
                    case 'shut':        return `/interface set [find name="${p.label}"] disabled=yes`
                    case 'no-shut':     return `/interface set [find name="${p.label}"] disabled=no`
                    case 'mtu':         return `/interface set [find name="${p.label}"] mtu=${this.mtuValue}`
                    case 'description': return `/interface set [find name="${p.label}"] comment="${this.descriptionValue}"`
                    default:            return ''
                }
            }).filter(Boolean).join('\n')
        }

        // SONiC — `config interface …` runs as one command per port plus
        // a single `config save -y` at the end so the change persists.
        // Counter-clear is global (sonic-clear has no per-iface variant).
        if (isSonic) {
            if (this.action === 'clear-counters') {
                return 'sonic-clear counters'   // global, ignores selection
            }
            const desc = this.descriptionValue.replace(/"/g, '\\"')
            const lines = ports.map(p => {
                switch (this.action) {
                    case 'shut':        return `sudo config interface shutdown ${p.label}`
                    case 'no-shut':     return `sudo config interface startup ${p.label}`
                    case 'mtu':         return `sudo config interface mtu ${p.label} ${this.mtuValue}`
                    case 'description': return `sudo config interface description ${p.label} "${desc}"`
                    default:            return ''
                }
            }).filter(Boolean)
            if (!lines.length) { return '' }
            // Persist the changes — without `config save` they're lost on reboot.
            lines.push('sudo config save -y')
            return lines.join('\n')
        }

        return ''   // unsupported vendor
    }

    runAgain (): void {
        this.runs = []
        this.runComplete = false
        this.view = 'configure'
        this.cdr.markForCheck()
    }

    get stats () {
        return {
            total: this.runs.length,
            ok: this.runs.filter(r => r.status === 'ok').length,
            fail: this.runs.filter(r => r.status === 'fail').length,
            running: this.runs.filter(r => r.status === 'running').length,
        }
    }
}
