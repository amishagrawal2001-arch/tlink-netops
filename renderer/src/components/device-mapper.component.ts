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

interface ExtendedDevice extends DiscoveredDevice {
    sshUsername?: string
    sshPassword?: string
}

@Component({
    selector: 'device-mapper',
    templateUrl: './device-mapper.component.pug',
    styleUrls: ['./device-mapper.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceMapperComponent implements OnInit {

    @Input() topology!: Topology
    @Output() closed = new EventEmitter<void>()
    @Output() mappingApplied = new EventEmitter<Map<string, MappingEntry>>()

    discoveredDevices: ExtendedDevice[] = []
    topologyNodes: TopologyNode[] = []
    mappings = new Map<string, MappingEntry>()
    discovering = false
    activeTab: 'mapping' | 'inventory' = 'inventory'
    editingIdx = -1
    searchQuery = ''
    showClearConfirm = false
    addError = ''

    private _api = (window as any).netopsAPI

    get filteredDevices (): ExtendedDevice[] {
        if (!this.searchQuery) { return this.discoveredDevices }
        const q = this.searchQuery.toLowerCase()
        return this.discoveredDevices.filter(d =>
            d.hostname.toLowerCase().includes(q) ||
            d.mgmtIp.toLowerCase().includes(q) ||
            d.vendor.toLowerCase().includes(q)
        )
    }

    constructor (
        private cdr: ChangeDetectorRef,
        private discoverySvc: NetworkDiscoveryService,
    ) {}

    ngOnInit (): void {
        this.topologyNodes = (this.topology?.nodes ?? []).filter(n =>
            n.type === 'router' || n.type === 'switch' || n.type === 'firewall'
        )
        this._loadInventory()
    }

    private async _loadInventory (): Promise<void> {
        const saved = await this._api?.prefGet?.('device-inventory')
        if (Array.isArray(saved)) {
            this.discoveredDevices = saved
            this.cdr.markForCheck()
        }
    }

    private _saveInventory (): void {
        this._api?.prefSet?.('device-inventory', this.discoveredDevices)
    }

    editDevice (idx: number): void { this.editingIdx = idx; this.cdr.markForCheck() }

    saveDeviceEdit (idx: number, field: string, event: Event): void {
        const value = (event.target as HTMLInputElement).value
        if (idx >= 0 && idx < this.discoveredDevices.length) {
            (this.discoveredDevices[idx] as any)[field] = value
            this._saveInventory()
        }
    }

    downloadSampleCsv (): void {
        const csv = [
            'hostname,mgmtIp,vendor,model,serialNumber,sshUsername,sshPassword',
            'Spine-1,172.16.0.1,Juniper,QFX5130-32CD,JN1234ABC01,admin,Juniper123!',
            'Spine-2,172.16.0.2,Juniper,QFX5130-32CD,JN1234ABC02,admin,Juniper123!',
            'Leaf-1,172.16.0.3,Juniper,QFX5120-48Y,JN5678DEF01,admin,Juniper123!',
            'Leaf-2,172.16.0.4,Arista,DCS-7050TX3-48C8,AR9012GHI01,admin,Arista456!',
            'Leaf-3,172.16.0.5,Cisco,Nexus 93180YC-FX,FOC2345JKL1,admin,Cisco789!',
            'Border-Leaf,172.16.0.6,Juniper,QFX5120-32C,JN3456MNO01,admin,Juniper123!',
        ].join('\n')
        this._downloadFile(csv, 'devices-sample.csv', 'text/csv')
    }

    downloadSampleJson (): void {
        const json = JSON.stringify({ devices: [
            { hostname: 'Spine-1', mgmtIp: '172.16.0.1', vendor: 'Juniper', model: 'QFX5130-32CD', sshUsername: 'admin', sshPassword: 'Juniper123!' },
            { hostname: 'Spine-2', mgmtIp: '172.16.0.2', vendor: 'Juniper', model: 'QFX5130-32CD', sshUsername: 'admin', sshPassword: 'Juniper123!' },
            { hostname: 'Leaf-1', mgmtIp: '172.16.0.3', vendor: 'Juniper', model: 'QFX5120-48Y', sshUsername: 'admin', sshPassword: 'Juniper123!' },
            { hostname: 'Leaf-2', mgmtIp: '172.16.0.4', vendor: 'Arista', model: 'DCS-7050TX3-48C8', sshUsername: 'admin', sshPassword: 'Arista456!' },
            { hostname: 'Leaf-3', mgmtIp: '172.16.0.5', vendor: 'Cisco', model: 'Nexus 93180YC-FX', sshUsername: 'admin', sshPassword: 'Cisco789!' },
            { hostname: 'Border-Leaf', mgmtIp: '172.16.0.6', vendor: 'Juniper', model: 'QFX5120-32C', sshUsername: 'admin', sshPassword: 'Juniper123!' },
        ] }, null, 2)
        this._downloadFile(json, 'devices-sample.json', 'application/json')
    }

    private _downloadFile (content: string, filename: string, mimeType: string): void {
        const blob = new Blob([content], { type: mimeType })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    removeDevice (idx: number): void {
        this.discoveredDevices.splice(idx, 1)
        this._saveInventory()
        this.cdr.markForCheck()
    }

    clearAllDevices (): void {
        this.showClearConfirm = true
        this.cdr.markForCheck()
    }

    confirmClearAll (): void {
        this.discoveredDevices = []
        this._saveInventory()
        this.showClearConfirm = false
        this.cdr.markForCheck()
    }

    close (): void { this.closed.emit() }

    // Discovery form state
    showDiscoveryForm = false
    discoveryForm = { host: '', username: '', password: '' }
    discoveryError = ''

    async startDiscovery (): Promise<void> {
        if (!this.showDiscoveryForm) {
            // Show form first, pre-fill from saved prefs
            const api = this._api
            this.discoveryForm.host = await api?.prefGet?.('discovery-host') ?? ''
            this.discoveryForm.username = await api?.prefGet?.('discovery-user') ?? ''
            this.discoveryForm.password = ''
            this.showDiscoveryForm = true
            this.discoveryError = ''
            this.cdr.markForCheck()
            return
        }

        // Validate
        if (!this.discoveryForm.host || !this.discoveryForm.username || !this.discoveryForm.password) {
            this.discoveryError = 'All fields are required'
            this.cdr.markForCheck()
            return
        }

        // Save credentials for next time (not password)
        this._api?.prefSet?.('discovery-host', this.discoveryForm.host)
        this._api?.prefSet?.('discovery-user', this.discoveryForm.username)

        this.discovering = true
        this.showDiscoveryForm = false
        this.discoveryError = ''
        this.cdr.markForCheck()

        try {
            const result = await this.discoverySvc.discoverFromSeed(
                this.discoveryForm.host, 22, this.discoveryForm.username, this.discoveryForm.password, { maxDepth: 3 }
            )
            const existingHosts = new Set(this.discoveredDevices.map(d => d.hostname))
            const newDevices = result.devices.filter(d => !d.hostname || !existingHosts.has(d.hostname))
            this.discoveredDevices = [...this.discoveredDevices, ...newDevices]
            this._saveInventory()
            this.autoMatch()
        } catch (err) {
            this.discoveryError = `Discovery failed: ${(err as Error).message}`
        }

        this.discovering = false
        this.cdr.markForCheck()
    }

    onFileUpload (event: Event): void {
        const input = event.target as HTMLInputElement
        const file = input.files?.[0]
        if (!file) { return }

        const reader = new FileReader()
        reader.onload = () => {
            const content = reader.result as string
            try {
                if (file.name.endsWith('.json')) {
                    this._parseJsonDevices(content)
                } else {
                    this._parseCsvDevices(content)
                }
                this._saveInventory()
                this.autoMatch()
            } catch (err) {
                alert(`Failed to parse file: ${(err as Error).message}`)
            }
            this.cdr.markForCheck()
        }
        reader.readAsText(file)
        input.value = '' // reset so same file can be re-uploaded
    }

    private _parseJsonDevices (content: string): void {
        const data = JSON.parse(content)
        const devices = Array.isArray(data) ? data : data.devices ?? data.hosts ?? [data]
        const existingHosts = new Set(this.discoveredDevices.map(d => d.hostname))
        for (const d of devices) {
            const hostname = d.hostname ?? d.name ?? d.host ?? ''
            const mgmtIp = d.mgmtIp ?? d.ip ?? d.management_ip ?? d.address ?? ''
            const vendor = d.vendor ?? d.platform ?? d.os ?? ''
            const model = d.model ?? d.hardware ?? ''
            const sshUsername = d.sshUsername ?? d.ssh_username ?? d.username ?? ''
            const sshPassword = d.sshPassword ?? d.ssh_password ?? d.password ?? ''
            if (hostname || mgmtIp) {
                if (hostname && existingHosts.has(hostname)) { continue }
                if (hostname) { existingHosts.add(hostname) }
                this.discoveredDevices.push({ hostname, mgmtIp, vendor, model, interfaces: [], sshUsername, sshPassword })
            }
        }
    }

    private _parseCsvDevices (content: string): void {
        const lines = content.split('\n').map(l => l.trim()).filter(l => l)
        if (lines.length < 2) { return }

        // Parse header to find column indices
        const header = lines[0].toLowerCase().split(',').map(h => h.trim())
        // Use exact match first, then partial match for each field
        const hostIdx = header.findIndex(h => h === 'hostname') >= 0
            ? header.findIndex(h => h === 'hostname')
            : header.findIndex(h => h.includes('hostname') || h === 'name' || h === 'host' || h === 'device_name')
        const ipIdx = header.findIndex(h => h === 'mgmtip' || h === 'mgmt_ip' || h === 'management_ip') >= 0
            ? header.findIndex(h => h === 'mgmtip' || h === 'mgmt_ip' || h === 'management_ip')
            : header.findIndex(h => h === 'ip' || h === 'address' || h === 'ip_address')
        const vendorIdx = header.findIndex(h => h === 'vendor' || h === 'platform' || h === 'manufacturer')
        const modelIdx = header.findIndex(h => h === 'model' || h === 'hardware' || h === 'device_type')
        const serialIdx = header.findIndex(h => h.includes('serial'))
        const sshUserIdx = header.findIndex(h => h === 'sshusername' || h === 'ssh_username' || h === 'username')
        const sshPassIdx = header.findIndex(h => h === 'sshpassword' || h === 'ssh_password' || h === 'password')

        const existingHosts = new Set(this.discoveredDevices.map(d => d.hostname))

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim().replace(/^["']|["']$/g, ''))
            if (!cols.length || !cols.some(c => c)) { continue }  // skip empty rows
            const hostname = hostIdx >= 0 ? cols[hostIdx] ?? '' : cols[0] ?? ''
            const mgmtIp = ipIdx >= 0 ? cols[ipIdx] ?? '' : cols[1] ?? ''
            const vendor = vendorIdx >= 0 ? cols[vendorIdx] ?? '' : ''
            const model = modelIdx >= 0 ? cols[modelIdx] ?? '' : ''
            const sshUsername = sshUserIdx >= 0 ? cols[sshUserIdx] ?? '' : ''
            const sshPassword = sshPassIdx >= 0 ? cols[sshPassIdx] ?? '' : ''
            if (hostname || mgmtIp) {
                if (hostname && existingHosts.has(hostname)) { continue }
                if (hostname) { existingHosts.add(hostname) }
                this.discoveredDevices.push({ hostname, mgmtIp, vendor, model, interfaces: [], sshUsername, sshPassword })
            }
        }
    }

    // Inline add form state
    showAddForm = false
    newDevice = { hostname: '', mgmtIp: '', vendor: '', model: '', sshUsername: '', sshPassword: '' }

    addManualDevice (): void {
        this.showAddForm = true
        this.newDevice = { hostname: '', mgmtIp: '', vendor: '', model: '', sshUsername: '', sshPassword: '' }
        this.addError = ''
        this.cdr.markForCheck()
    }

    confirmAddDevice (): void {
        const hostname = this.newDevice.hostname.trim()
        const mgmtIp = this.newDevice.mgmtIp.trim()
        if (!hostname && !mgmtIp) {
            this.addError = 'Hostname or IP is required'
            this.cdr.markForCheck()
            return
        }
        if (!hostname) {
            this.addError = 'Hostname cannot be only whitespace'
            this.cdr.markForCheck()
            return
        }
        if (mgmtIp && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(mgmtIp)) {
            this.addError = 'Invalid IP address format'
            this.cdr.markForCheck()
            return
        }
        this.addError = ''
        this.discoveredDevices.push({
            hostname,
            mgmtIp,
            vendor: this.newDevice.vendor.trim(),
            model: this.newDevice.model.trim(),
            interfaces: [],
            sshUsername: this.newDevice.sshUsername,
            sshPassword: this.newDevice.sshPassword,
        })
        this._saveInventory()
        this.showAddForm = false
        this.cdr.markForCheck()
    }

    exportInventoryCsv (): void {
        const headers = 'hostname,mgmtIp,vendor,model,sshUsername,sshPassword'
        const rows = this.discoveredDevices.map(d =>
            [d.hostname, d.mgmtIp, d.vendor, d.model, d.sshUsername ?? '', d.sshPassword ?? '']
                .map(v => `"${(v ?? '').replace(/"/g, '""')}"`)
                .join(',')
        )
        const csv = [headers, ...rows].join('\n')
        const blob = new Blob([csv], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'device-inventory.csv'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    /** Returns devices not already mapped to another node (except the current node's own mapping) */
    getAvailableDevices (nodeId: string): DiscoveredDevice[] {
        const usedHostnames = new Set<string>()
        for (const [id, entry] of this.mappings) {
            if (id !== nodeId && entry.hostname) {
                usedHostnames.add(entry.hostname)
            }
        }
        return this.discoveredDevices.filter(d => !usedHostnames.has(d.hostname))
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
