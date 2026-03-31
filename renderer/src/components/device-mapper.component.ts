import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Input, OnInit, Output,
} from '@angular/core'
import { TopologyNode, Topology } from '../api/interfaces'
import { NetworkDiscoveryService, DiscoveredDevice } from '../services/network-discovery.service'

interface MappingEntry {
    hostname: string
    mgmtIp: string
    vendor: string
    model: string
}

@Component({
    selector: 'device-mapper',
    templateUrl: './device-mapper.component.pug',
    styleUrls: ['./device-mapper.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceMapperComponent implements OnInit {

    @Input() topology!: Topology
    @Input() discoveredDevices: DiscoveredDevice[] = []
    @Output() closed = new EventEmitter<void>()
    @Output() mappingApplied = new EventEmitter<Map<string, MappingEntry>>()
    @Output() discoveryRequested = new EventEmitter<void>()

    topologyNodes: TopologyNode[] = []
    mappings = new Map<string, MappingEntry>()
    discovering = false

    constructor (
        private cdr: ChangeDetectorRef,
        private discoverySvc: NetworkDiscoveryService,
    ) {}

    ngOnInit (): void {
        this.topologyNodes = (this.topology?.nodes ?? []).filter(n =>
            n.type === 'router' || n.type === 'switch' || n.type === 'firewall'
        )
    }

    close (): void { this.closed.emit() }

    async startDiscovery (): Promise<void> {
        const api = (window as any).netopsAPI

        // Load saved credentials
        const savedHost = await api?.prefGet?.('discovery-host') ?? ''
        const savedUser = await api?.prefGet?.('discovery-user') ?? ''

        const host = prompt('Seed device IP address:', savedHost)
        if (!host) { return }
        const username = prompt('SSH username:', savedUser)
        if (!username) { return }
        const password = prompt('SSH password:')
        if (!password) { return }

        // Save credentials for next time (not password)
        api?.prefSet?.('discovery-host', host)
        api?.prefSet?.('discovery-user', username)

        this.discovering = true
        this.cdr.markForCheck()

        try {
            const result = await this.discoverySvc.discoverFromSeed(host, 22, username, password, { maxDepth: 3 })
            this.discoveredDevices = result.devices
            // Auto-match after discovery
            this.autoMatch()
        } catch (err) {
            alert(`Discovery failed: ${(err as Error).message}`)
        }

        this.discovering = false
        this.cdr.markForCheck()
    }

    autoMatch (): void {
        this.mappings.clear()

        for (const node of this.topologyNodes) {
            const normalLabel = node.label.toLowerCase().replace(/[\s_-]/g, '')
            const nodeVendor = (node.vendor ?? '').toLowerCase()

            // Try hostname match first, then vendor+model match
            let bestMatch: DiscoveredDevice | null = null
            let bestScore = 0

            for (const dev of this.discoveredDevices) {
                const normalHost = dev.hostname.toLowerCase().replace(/[\s_-]/g, '')
                let score = 0

                // Exact hostname match
                if (normalHost === normalLabel) { score += 100 }
                // Partial hostname match
                else if (normalHost.includes(normalLabel) || normalLabel.includes(normalHost)) { score += 50 }

                // Vendor match
                if (nodeVendor && dev.vendor.toLowerCase().includes(nodeVendor)) { score += 30 }

                // Model match
                if (node.model && dev.model && dev.model.toLowerCase().includes(node.model.toLowerCase())) { score += 20 }

                if (score > bestScore) {
                    bestScore = score
                    bestMatch = dev
                }
            }

            // Only accept matches with reasonable confidence
            if (bestMatch && bestScore >= 30) {
                this.mappings.set(node.id, {
                    hostname: bestMatch.hostname,
                    mgmtIp: bestMatch.mgmtIp,
                    vendor: bestMatch.vendor,
                    model: bestMatch.model,
                })
            }
        }

        this.cdr.markForCheck()
    }

    onMapChange (nodeId: string, event: Event): void {
        const hostname = (event.target as HTMLSelectElement).value
        if (!hostname) {
            this.mappings.delete(nodeId)
        } else {
            const dev = this.discoveredDevices.find(d => d.hostname === hostname)
            if (dev) {
                this.mappings.set(nodeId, {
                    hostname: dev.hostname,
                    mgmtIp: dev.mgmtIp,
                    vendor: dev.vendor,
                    model: dev.model,
                })
            }
        }
        this.cdr.markForCheck()
    }

    applyMapping (): void {
        this.mappingApplied.emit(new Map(this.mappings))
        this.closed.emit()
    }
}
