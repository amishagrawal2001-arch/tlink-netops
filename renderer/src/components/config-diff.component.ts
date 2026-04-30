import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Input, OnInit, Output,
} from '@angular/core'
import { TopologyNode, ConfigBackupEntry } from '../api/interfaces'
import { TopologyService } from '../services/topology.service'
import { InventoryService } from '../services/inventory.service'
import { diffLines, diffStats, foldUnchanged, diffToUnifiedText, DiffHunk } from '../services/config-diff'
import { getVendorCommands } from '../services/vendor-command-map'

type Source = 'generated' | 'live' | 'backup' | 'manual'

@Component({
    selector: 'config-diff',
    templateUrl: './config-diff.component.pug',
    styleUrls: ['./config-diff.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigDiffComponent implements OnInit {
    @Input() nodeId!: string
    @Output() closed = new EventEmitter<void>()

    node: TopologyNode | null = null

    // Source pickers — default A=generated, B=live (the most common "did my change land?" case)
    aSource: Source = 'generated'
    bSource: Source = 'live'

    // Per-source content + state
    aContent = ''
    bContent = ''
    aLoading = false
    bLoading = false
    aError = ''
    bError = ''

    // Backup pickers (when source = 'backup', user picks which backup timestamp)
    backups: ConfigBackupEntry[] = []
    aBackupId = ''
    bBackupId = ''

    // Manual paste content (when source = 'manual')
    aManualText = ''
    bManualText = ''

    // Display
    hunks: DiffHunk[] = []
    foldUnchangedLines = true
    /** Number of unchanged context lines to keep around each change. */
    contextLines = 3

    constructor (
        private cdr: ChangeDetectorRef,
        private topoSvc: TopologyService,
        private invSvc: InventoryService,
    ) {}

    ngOnInit (): void {
        this.node = this.topoSvc.getNode(this.nodeId) ?? null
        this.backups = this.invSvc.getBackupsForNode(this.nodeId) ?? []
        if (this.backups.length) {
            this.aBackupId = this.backups[0].id
            this.bBackupId = this.backups[Math.min(1, this.backups.length - 1)].id
        }
        // Auto-load A and B based on default sources
        this._loadSide('a')
        this._loadSide('b')
    }

    close (): void { this.closed.emit() }

    /** Source A or B picker changed → reload that side's content. */
    onSourceChange (side: 'a' | 'b'): void { this._loadSide(side) }

    /** Trigger a re-fetch of a live SSH pull (only useful when source='live'). */
    refresh (side: 'a' | 'b'): void { this._loadSide(side, true) }

    /** Re-compute the diff between current aContent / bContent. */
    private _recomputeDiff (): void {
        const raw = diffLines(this.aContent || '', this.bContent || '')
        this.hunks = this.foldUnchangedLines
            ? foldUnchanged(raw, this.contextLines)
            : raw
        this.cdr.markForCheck()
    }

    get stats () { return diffStats(this.hunks) }

    /** Has any actual change? Used to disable the Push diff button. */
    get hasChanges (): boolean {
        const s = this.stats
        return s.added > 0 || s.removed > 0
    }

    /** Display label shown next to the source picker. */
    sourceLabel (s: Source): string {
        switch (s) {
            case 'generated': return 'Generated (intended)'
            case 'live':      return 'Live (SSH pull)'
            case 'backup':    return 'Backup'
            case 'manual':    return 'Manual paste'
        }
    }

    /** Toggle the fold-unchanged behavior and re-render. */
    toggleFold (): void {
        this.foldUnchangedLines = !this.foldUnchangedLines
        this._recomputeDiff()
    }

    /** Copy the unified-diff text to the system clipboard. */
    async copyDiff (): Promise<void> {
        const text = diffToUnifiedText(this.hunks)
        try { await navigator.clipboard.writeText(text) } catch { /* swallow */ }
    }

    // ── Source loaders ────────────────────────────────────────────────────────

    private async _loadSide (side: 'a' | 'b', forceRefresh = false): Promise<void> {
        const setLoading = (v: boolean): void => {
            if (side === 'a') { this.aLoading = v } else { this.bLoading = v }
            this.cdr.markForCheck()
        }
        const setContent = (v: string): void => {
            if (side === 'a') { this.aContent = v } else { this.bContent = v }
        }
        const setError = (v: string): void => {
            if (side === 'a') { this.aError = v } else { this.bError = v }
        }
        const source = side === 'a' ? this.aSource : this.bSource

        setError('')
        setLoading(true)
        try {
            switch (source) {
                case 'generated': {
                    // Use the topology service's generated config if the node was
                    // generated. Otherwise fall back to the stored startupConfig.
                    const node = this.topoSvc.getNode(this.nodeId)
                    setContent(node?.startupConfig ?? '')
                    break
                }
                case 'live': {
                    const text = await this._pullLive(forceRefresh)
                    setContent(text)
                    break
                }
                case 'backup': {
                    const id = side === 'a' ? this.aBackupId : this.bBackupId
                    const entry = this.backups.find(b => b.id === id)
                    setContent(entry?.content ?? '')
                    break
                }
                case 'manual': {
                    setContent(side === 'a' ? this.aManualText : this.bManualText)
                    break
                }
            }
        } catch (err) {
            setError((err as Error).message)
            setContent('')
        }
        setLoading(false)
        this._recomputeDiff()
    }

    /**
     * Pull the live running-config from the device via SSH. Uses vendor-
     * specific command (e.g. `show running-config` for Cisco, `show
     * configuration | display set` for Junos). Falls back to a generic
     * command set if the vendor isn't known.
     */
    private async _pullLive (_forceRefresh: boolean): Promise<string> {
        const node = this.topoSvc.getNode(this.nodeId)
        if (!node) { throw new Error('Node not found') }
        if (!node.mgmtIp || !node.sshUsername || !node.sshPassword) {
            throw new Error('Node has no SSH credentials configured')
        }
        const api = (window as any).netopsAPI
        if (!api?.sshRunCommand) { throw new Error('SSH API not available') }

        const cmds = getVendorCommands(node.vendor || '')
        const cmd = cmds.showRunningConfig || cmds.showStartupConfig || 'show running-config'

        const result = await api.sshRunCommand({
            host: node.mgmtIp,
            port: node.sshPort ?? 22,
            username: node.sshUsername,
            password: node.sshPassword,
            command: cmd,
            timeoutMs: 15000,
        })
        if (!result?.ok) {
            throw new Error(result?.message ?? 'SSH command failed')
        }
        return (result.stdout ?? result.output ?? '').toString()
    }

    // ── Manual-text bindings — keep aManualText/bManualText in sync with
    //     the active manual content if user is using manual on either side. ──
    onManualChange (side: 'a' | 'b', text: string): void {
        if (side === 'a') {
            this.aManualText = text
            if (this.aSource === 'manual') { this.aContent = text }
        } else {
            this.bManualText = text
            if (this.bSource === 'manual') { this.bContent = text }
        }
        this._recomputeDiff()
    }
}
