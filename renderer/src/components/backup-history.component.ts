import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Output, OnInit,
} from '@angular/core'
import { InventoryService } from '../services/inventory.service'
import { TopologyService } from '../services/topology.service'
import { ConfigBackupEntry } from '../api/interfaces'

@Component({
    selector: 'backup-history',
    templateUrl: './backup-history.component.pug',
    styleUrls: ['./backup-history.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackupHistoryComponent implements OnInit {

    @Output() closed = new EventEmitter<void>()

    backups: (ConfigBackupEntry & { nodeLabel: string })[] = []
    selectedBackup: ConfigBackupEntry | null = null
    diffResult: string | null = null
    selectedForDiff: [string | null, string | null] = [null, null]

    constructor (
        public invSvc: InventoryService,
        private topoSvc: TopologyService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit (): void {
        this._refreshBackups()
    }

    private _refreshBackups (): void {
        const nodes = this.topoSvc.topology.nodes
        const nodeMap = new Map(nodes.map(n => [n.id, n.label]))

        this.backups = [...this.invSvc.store.configBackups]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .map(b => ({
                ...b,
                nodeLabel: nodeMap.get(b.nodeId) ?? b.nodeId,
            }))
    }

    close (): void { this.closed.emit() }

    selectBackup (id: string): void {
        if (this.selectedBackup?.id === id) {
            this.selectedBackup = null
        } else {
            this.selectedBackup = this.backups.find(b => b.id === id) ?? null
        }
        this.diffResult = null
        this.cdr.markForCheck()
    }

    toggleDiffSelection (id: string): void {
        if (this.selectedForDiff[0] === id) {
            this.selectedForDiff = [this.selectedForDiff[1], null]
        } else if (this.selectedForDiff[1] === id) {
            this.selectedForDiff = [this.selectedForDiff[0], null]
        } else if (this.selectedForDiff[0] == null) {
            this.selectedForDiff = [id, this.selectedForDiff[1]]
        } else {
            this.selectedForDiff = [this.selectedForDiff[0], id]
        }
        this.diffResult = null
        this.cdr.markForCheck()
    }

    showDiff (): void {
        const [idA, idB] = this.selectedForDiff
        if (!idA || !idB) { return }
        const a = this.invSvc.store.configBackups.find(b => b.id === idA)
        const b = this.invSvc.store.configBackups.find(b => b.id === idB)
        if (!a || !b) { return }
        this.diffResult = this.invSvc.diffConfigs(a, b)
        this.selectedBackup = null
        this.cdr.markForCheck()
    }

    async restoreBackup (entry: ConfigBackupEntry): Promise<void> {
        if (!confirm(`Restore ${entry.configType} config to device? This will push the backed-up configuration.`)) {
            return
        }
        const result = await this.invSvc.loadConfig(entry.nodeId, entry.id)
        if (result.ok) {
            alert('Config restored successfully.')
        } else {
            alert(`Restore failed: ${result.output}`)
        }
        this.cdr.markForCheck()
    }

    async backupAllNow (): Promise<void> {
        const count = await this.invSvc.backupAllConfigs('manual')
        this._refreshBackups()
        this.cdr.markForCheck()
        alert(`Backed up ${count} device(s).`)
    }

    toggleSchedule (): void {
        if (this.invSvc.scheduledBackupsActive) {
            this.invSvc.stopScheduledBackups()
        } else {
            this.invSvc.startScheduledBackups()
        }
        this.cdr.markForCheck()
    }

    canDiff (): boolean {
        return this.selectedForDiff[0] != null && this.selectedForDiff[1] != null
    }

    isDiffSelected (id: string): boolean {
        return this.selectedForDiff[0] === id || this.selectedForDiff[1] === id
    }

    shortHash (hash: string): string {
        return hash ? hash.slice(0, 8) : ''
    }

    formatTime (iso: string): string {
        try {
            const d = new Date(iso)
            return d.toLocaleString()
        } catch {
            return iso
        }
    }
}
