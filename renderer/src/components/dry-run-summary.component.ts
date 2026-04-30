import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Input, OnInit, Output,
} from '@angular/core'
import { TopologyNode } from '../api/interfaces'
import { TopologyService } from '../services/topology.service'
import { diffLines, diffStats, foldUnchanged, DiffHunk } from '../services/config-diff'
import { getVendorCommands } from '../services/vendor-command-map'

interface DryRunRow {
    node: TopologyNode
    /** Per-row state */
    status: 'pending' | 'pulling' | 'ready' | 'error' | 'no-live' | 'no-intent'
    error?: string
    /** Live config pulled from device */
    live?: string
    /** Generated/intended config from topology */
    intent?: string
    /** Computed diff (cached) */
    hunks?: DiffHunk[]
    added?: number
    removed?: number
    /** UI: this row expanded to show full diff */
    expanded: boolean
}

/**
 * Dry-run preview for a multi-node config push.
 *
 * For each node about to receive a push, it pulls the live config via SSH,
 * diffs against the intended (generated) config, and shows the per-node
 * +/- counts plus an expand-to-see-the-diff row. Nothing is actually
 * committed to the devices.
 *
 * The user can then either Push (proceeds with the real push) or Cancel.
 */
@Component({
    selector: 'dry-run-summary',
    templateUrl: './dry-run-summary.component.pug',
    styleUrls: ['./dry-run-summary.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DryRunSummaryComponent implements OnInit {
    /** IDs of nodes to include in the dry-run. If empty, all nodes with
     *  startupConfig + creds are included. */
    @Input() nodeIds: string[] = []
    @Output() closed = new EventEmitter<void>()
    /** User clicked Push. Owner re-runs the push with skipConfirm + same scope. */
    @Output() pushRequested = new EventEmitter<{ nodeIds: string[] }>()

    rows: DryRunRow[] = []
    overallLoading = true
    /** When false, fold unchanged lines in expanded diff views. */
    foldUnchangedLines = true

    constructor (
        private cdr: ChangeDetectorRef,
        private topoSvc: TopologyService,
    ) {}

    ngOnInit (): void {
        this._buildRows()
        this._pullAll()
    }

    close (): void { this.closed.emit() }

    /** User clicked Push — emit and let owner do the real thing. */
    confirmPush (): void {
        // Only push nodes that actually have a diff (others would be no-ops).
        const ids = this.rows
            .filter(r => r.status === 'ready' && (r.added || r.removed))
            .map(r => r.node.id)
        if (!ids.length) {
            this.close()
            return
        }
        this.pushRequested.emit({ nodeIds: ids })
        this.close()
    }

    toggleRow (row: DryRunRow): void {
        if (row.status !== 'ready') { return }
        row.expanded = !row.expanded
        this.cdr.markForCheck()
    }

    toggleFold (): void {
        this.foldUnchangedLines = !this.foldUnchangedLines
        // Re-fold all visible rows
        for (const r of this.rows) {
            if (r.live != null && r.intent != null) {
                const raw = diffLines(r.intent, r.live)
                r.hunks = this.foldUnchangedLines ? foldUnchanged(raw, 3) : raw
            }
        }
        this.cdr.markForCheck()
    }

    /** Aggregate footer stats. */
    get totals () {
        let nodes = 0, added = 0, removed = 0, withChanges = 0, errors = 0
        for (const r of this.rows) {
            nodes++
            if (r.status === 'error') { errors++ }
            if (r.added)   { added += r.added }
            if (r.removed) { removed += r.removed }
            if ((r.added ?? 0) > 0 || (r.removed ?? 0) > 0) { withChanges++ }
        }
        return { nodes, added, removed, withChanges, errors }
    }

    private _buildRows (): void {
        const all = this.topoSvc.topology.nodes
        const scope = this.nodeIds.length ? new Set(this.nodeIds) : null
        const candidates = all.filter(n => {
            if (scope && !scope.has(n.id)) { return false }
            if (!n.startupConfig?.trim()) { return false }   // nothing to push
            const host = (n.mgmtIp ?? '').split('/')[0]
            if (!host) { return false }
            // Need creds — direct on node OR mapped (creds resolved at push time)
            if (!n.sshUsername || !n.sshPassword) { return false }
            return true
        })
        this.rows = candidates.map(n => ({
            node: n,
            status: 'pending',
            intent: n.startupConfig,
            expanded: false,
        }))
    }

    private async _pullAll (): Promise<void> {
        // Run SSH pulls in parallel waves of 4 — same idea as discovery, but
        // smaller because pulls usually take longer (running-config can be big).
        const concurrency = 4
        for (let i = 0; i < this.rows.length; i += concurrency) {
            const wave = this.rows.slice(i, i + concurrency)
            await Promise.all(wave.map(r => this._pullOne(r)))
            this.cdr.markForCheck()
        }
        this.overallLoading = false
        this.cdr.markForCheck()
    }

    private async _pullOne (row: DryRunRow): Promise<void> {
        row.status = 'pulling'
        this.cdr.markForCheck()
        try {
            const api = (window as any).netopsAPI
            if (!api?.sshRunCommand) { throw new Error('SSH API not available') }
            const cmds = getVendorCommands(row.node.vendor || '')
            const cmd = cmds.showRunningConfig || cmds.showStartupConfig || 'show running-config'
            const host = (row.node.mgmtIp ?? '').split('/')[0]
            const result = await api.sshRunCommand({
                host,
                port: row.node.sshPort ?? 22,
                username: row.node.sshUsername,
                password: row.node.sshPassword,
                command: cmd,
                timeoutMs: 15000,
            })
            if (!result?.ok) { throw new Error(result?.message ?? 'SSH command failed') }
            row.live = (result.stdout ?? result.output ?? '').toString()

            if (!row.live) { row.status = 'no-live'; return }
            if (!row.intent) { row.status = 'no-intent'; return }

            const raw = diffLines(row.intent, row.live)
            row.hunks = this.foldUnchangedLines ? foldUnchanged(raw, 3) : raw
            const s = diffStats(row.hunks)
            row.added = s.added
            row.removed = s.removed
            row.status = 'ready'
        } catch (err) {
            row.status = 'error'
            row.error = (err as Error).message
        } finally {
            this.cdr.markForCheck()
        }
    }
}
