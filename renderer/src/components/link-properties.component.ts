import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, EventEmitter, Input,
    OnChanges, OnDestroy, OnInit, Output, SimpleChanges,
} from '@angular/core'
import { Subscription } from 'rxjs'
import { TopologyService } from '../services/topology.service'
import { TopologyLink, TopologyNode, BW_PRESETS } from '../api/interfaces'

@Component({
    selector: 'link-properties',
    templateUrl: './link-properties.component.pug',
    styleUrls: ['./link-properties.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LinkPropertiesComponent implements OnInit, OnChanges, OnDestroy {

    @Input() linkId: string | null = null
    @Output() closed = new EventEmitter<void>()

    link: TopologyLink | null = null
    sourceNode: TopologyNode | null = null
    targetNode: TopologyNode | null = null

    draft: Partial<TopologyLink> = {}

    readonly bwPresets = BW_PRESETS
    readonly linkTypes: Array<'ethernet' | 'serial'> = ['ethernet', 'serial']

    private _sub: Subscription | null = null

    constructor (
        private svc: TopologyService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit (): void {
        this._sub = this.svc.topology$.subscribe(() => {
            this._loadLink()
            this.cdr.markForCheck()
        })
    }

    ngOnChanges (changes: SimpleChanges): void {
        if (changes['linkId']) { this._loadLink() }
    }

    ngOnDestroy (): void { this._sub?.unsubscribe() }

    private _loadLink (): void {
        if (!this.linkId) { this.link = null; return }
        this.link = this.svc.getLink(this.linkId) ?? null
        if (!this.link) { return }

        const { source, target } = this.svc.linkNodes(this.link)
        this.sourceNode = source ?? null
        this.targetNode = target ?? null

        this.draft = {
            type:        this.link.type,
            bandwidth:   this.link.bandwidth,
            latency:     this.link.latency ?? 0,
            packetLoss:  this.link.packetLoss ?? 0,
            duplex:      this.link.duplex ?? 'full',
            notes:       this.link.notes ?? '',
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    get sourcePortLabel (): string {
        return this.sourceNode?.ports.find(p => p.id === this.link?.sourcePortId)?.label ?? ''
    }

    get targetPortLabel (): string {
        return this.targetNode?.ports.find(p => p.id === this.link?.targetPortId)?.label ?? ''
    }

    get bandwidthLabel (): string {
        if (!this.draft.bandwidth) { return 'Unlimited' }
        if (this.draft.bandwidth >= 1000) { return `${this.draft.bandwidth / 1000} Gbps` }
        return `${this.draft.bandwidth} Mbps`
    }

    // ── Apply helpers ────────────────────────────────────────────────────────

    applyType (type: 'ethernet' | 'serial'): void {
        if (!this.linkId) { return }
        this.draft.type = type
        this.svc.updateLinkConfig(this.linkId, { type })
        this.cdr.markForCheck()
    }

    applyBandwidth (value: number | undefined): void {
        if (!this.linkId) { return }
        this.draft.bandwidth = value
        this.svc.updateLinkConfig(this.linkId, { bandwidth: value })
        this.cdr.markForCheck()
    }

    applyLatency (): void {
        if (!this.linkId) { return }
        const v = Number(this.draft.latency ?? 0)
        this.svc.updateLinkConfig(this.linkId, { latency: isNaN(v) ? 0 : Math.max(0, v) })
    }

    applyPacketLoss (): void {
        if (!this.linkId) { return }
        const v = Number(this.draft.packetLoss ?? 0)
        const clamped = isNaN(v) ? 0 : Math.min(100, Math.max(0, v))
        this.draft.packetLoss = clamped
        this.svc.updateLinkConfig(this.linkId, { packetLoss: clamped })
        this.cdr.markForCheck()
    }

    applyDuplex (d: 'full' | 'half'): void {
        if (!this.linkId) { return }
        this.draft.duplex = d
        this.svc.updateLinkConfig(this.linkId, { duplex: d })
        this.cdr.markForCheck()
    }

    applyNotes (): void {
        if (!this.linkId) { return }
        this.svc.updateLinkConfig(this.linkId, { notes: this.draft.notes ?? '' })
    }

    deleteLink (): void {
        if (!this.linkId) { return }
        if (!confirm('Delete this link?')) { return }
        this.svc.removeLink(this.linkId)
        this.closed.emit()
    }

    close (): void { this.closed.emit() }
}
