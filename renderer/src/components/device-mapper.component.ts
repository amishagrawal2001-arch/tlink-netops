import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Input, OnInit, Output, ViewEncapsulation,
} from '@angular/core'
import { TopologyNode, Topology } from '../api/interfaces'
import { NetworkDiscoveryService, DiscoveredDevice, DiscoveredLink } from '../services/network-discovery.service'
import { InventoryService } from '../services/inventory.service'
import { isValidMgmtAddress } from '../services/address-validators'

interface MappingEntry {
    hostname: string
    mgmtIp: string
    vendor: string
    model: string
    sshUsername?: string
    sshPassword?: string
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
    // Make .mapper-* styles global so other dialogs (scheduler-panel,
    // backup-history) can reuse the same overlay/dialog/header chrome.
    // Class names are uniquely prefixed so global scope is safe.
    encapsulation: ViewEncapsulation.None,
})
export class DeviceMapperComponent implements OnInit {

    @Input() topology!: Topology
    @Output() closed = new EventEmitter<void>()
    @Output() mappingApplied = new EventEmitter<{
        mappings: Map<string, MappingEntry>;
        push: boolean;
        /** LLDP-discovered adjacencies. Canvas uses these to auto-insert links. */
        discoveredLinks?: DiscoveredLink[];
    }>()
    /** Auto-build a fresh topology directly from the discovered devices + LLDP
     *  adjacencies. Bypasses the manual node mapping step entirely. */
    @Output() buildFromDiscoveryRequested = new EventEmitter<{
        devices: ExtendedDevice[];
        links: DiscoveredLink[];
        replace: boolean;
    }>()
    /** Streamed-discovery deltas — fires after every BFS/inventory wave so
     *  the canvas can grow incrementally rather than waiting for the whole
     *  discovery to finish. Cumulatively, the deltas equal the full result. */
    @Output() liveDiscoveryDelta = new EventEmitter<{
        newDevices: ExtendedDevice[];
        newLinks: DiscoveredLink[];
    }>()
    /** Fires when the user picks a different role for a topology node from
     *  the Mapping tab. Canvas owner persists via topology service. */
    @Output() nodeRoleChanged = new EventEmitter<{ nodeId: string; role: string }>()

    /** Available roles surfaced as a Mapping-tab dropdown. Mirrors the
     *  NodeRole type from interfaces.ts so the labels stay friendly. */
    readonly availableRoles: Array<{ value: string; label: string }> = [
        { value: 'super-spine', label: 'Super-Spine' },
        { value: 'spine',       label: 'Spine' },
        { value: 'core',        label: 'Core' },
        { value: 'aggregation', label: 'Aggregation' },
        { value: 'border-leaf', label: 'Border-Leaf' },
        { value: 'leaf',        label: 'Leaf' },
        { value: 'tor',         label: 'ToR' },
        { value: 'access',      label: 'Access' },
        { value: 'gateway',     label: 'Gateway' },
        { value: 'custom',      label: 'Custom / Unspecified' },
    ]

    /** Mapping tab dropdown handler. Mutates the local node ref so the UI
     *  is immediately reactive, then emits upward so the topology service
     *  picks up the change (triggers re-layout-aware tier inference,
     *  config regeneration, persistence, undo/redo). */
    onRoleChange (node: TopologyNode, event: Event): void {
        const role = (event.target as HTMLSelectElement).value
        ;(node as any).role = role
        this.nodeRoleChanged.emit({ nodeId: node.id, role })
        this.cdr.markForCheck()
    }
    /** When true, fold every wave's deltas straight onto the canvas. Defaults
     *  to true; user can disable it to inspect/curate inventory before
     *  committing to a topology build. */
    @Input() liveBuildEnabled = true

    discoveredDevices: ExtendedDevice[] = []
    /** LLDP adjacencies from the most recent discovery run. Persists until
     *  the next discovery or "Clear All" — so Apply Mapping can draw links. */
    discoveredLinks: DiscoveredLink[] = []
    /** Subset of discoveredDevices the user has checkbox-selected for build.
     *  Empty set means "no explicit selection" → Build Topology uses ALL.
     *  Stores hostname (lowercased) as the membership key. */
    selectedDeviceHosts = new Set<string>()

    /** True if the device is explicitly selected (or if no selection at all,
     *  in which case everything is implicitly "selected" for the build). */
    isDeviceSelected (dev: ExtendedDevice): boolean {
        if (!this.selectedDeviceHosts.size) { return false }
        return this.selectedDeviceHosts.has((dev.hostname || '').toLowerCase())
    }
    toggleDeviceSelection (dev: ExtendedDevice): void {
        const key = (dev.hostname || '').toLowerCase()
        if (!key) { return }
        if (this.selectedDeviceHosts.has(key)) { this.selectedDeviceHosts.delete(key) }
        else                                    { this.selectedDeviceHosts.add(key) }
        this.cdr.markForCheck()
    }
    /** Select-all toggle: returns true when every visible (filtered) device is selected. */
    get allFilteredSelected (): boolean {
        const list = this.filteredDevices
        if (!list.length) { return false }
        return list.every(d => this.selectedDeviceHosts.has((d.hostname || '').toLowerCase()))
    }
    toggleSelectAllFiltered (): void {
        const list = this.filteredDevices
        if (this.allFilteredSelected) {
            for (const d of list) { this.selectedDeviceHosts.delete((d.hostname || '').toLowerCase()) }
        } else {
            for (const d of list) {
                const k = (d.hostname || '').toLowerCase()
                if (k) { this.selectedDeviceHosts.add(k) }
            }
        }
        this.cdr.markForCheck()
    }
    clearDeviceSelection (): void {
        this.selectedDeviceHosts.clear()
        this.cdr.markForCheck()
    }

    /**
     * Bulk-delete every checkbox-selected device along with any LLDP link
     * that touches one of them. Useful workflow:
     *   1. Type a filter (e.g. "geoman" or "srv")
     *   2. Click select-all in the header → all visible matches selected
     *   3. Click 🗑 Delete Selected → all gone in one shot
     *
     * Confirms first because it's destructive.
     */
    deleteSelected (): void {
        const sel = this.selectedDeviceHosts
        if (!sel.size) { return }
        const count = sel.size
        const ok = confirm(
            `Delete ${count} selected device(s) and any LLDP link(s) touching them?\n\n` +
            `This cannot be undone (you'd need to re-run discovery).`,
        )
        if (!ok) { return }

        // Lookup helper — case-insensitive against the selection set.
        const isSel = (s: string): boolean => sel.has((s || '').toLowerCase())

        // Drop devices whose hostname is in the selection.
        this.discoveredDevices = this.discoveredDevices.filter(d => !isSel(d.hostname))
        // Drop any LLDP link that touches a selected device on either end.
        this.discoveredLinks = this.discoveredLinks.filter(l =>
            !isSel(l.srcHost) && !isSel(l.dstHost),
        )
        sel.clear()
        this.lastDiscoverySummary =
            `Deleted ${count} device(s); inventory now ${this.discoveredDevices.length} ` +
            `device(s), ${this.discoveredLinks.length} link(s)`
        this._saveInventory()
        this.cdr.markForCheck()
    }
    /** One-line summary of the most recent discovery — shown in the inventory
     *  tab's action bar so users see the device + link count immediately. */
    lastDiscoverySummary = ''
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
        private invSvc: InventoryService,
    ) {}

    ngOnInit (): void {
        this.topologyNodes = (this.topology?.nodes ?? []).filter(n =>
            n.type === 'router' || n.type === 'switch' || n.type === 'firewall'
        )
        this._loadInventory().then(() => this._rehydrateExistingMappings())
    }

    /**
     * Rebuild the mappings Map from nodes that are already mapped in the topology.
     * Runs after inventory loads so we can enrich with vendor/model/creds if the node
     * has an inventory match. Falls back to node fields otherwise.
     */
    private _rehydrateExistingMappings (): void {
        this.mappings.clear()
        for (const node of this.topologyNodes) {
            if (!(node as any).mapped) { continue }
            const hostname = node.label
            const mgmtIp = (node.mgmtIp ?? '').split('/')[0]
            // Try to find the inventory device that matches — prefer mgmtIp then hostname
            const dev = this.discoveredDevices.find(d =>
                (d.mgmtIp && d.mgmtIp === mgmtIp) ||
                d.hostname.toLowerCase() === hostname.toLowerCase(),
            ) as ExtendedDevice | undefined
            this.mappings.set(node.id, {
                hostname: dev?.hostname ?? hostname,
                mgmtIp: dev?.mgmtIp ?? mgmtIp,
                vendor: dev?.vendor ?? (node.vendor ?? ''),
                model: dev?.model ?? (node.model ?? ''),
                sshUsername: dev?.sshUsername ?? node.sshUsername,
                sshPassword: dev?.sshPassword ?? node.sshPassword,
            })
        }
        this.cdr.markForCheck()
    }

    private async _loadInventory (): Promise<void> {
        const saved = await this._api?.prefGet?.('device-inventory')
        if (Array.isArray(saved)) {
            this.discoveredDevices = saved
        }
        // Restore LLDP links discovered in previous sessions so the user can
        // re-build topology without re-running discovery after every restart.
        const savedLinks = await this._api?.prefGet?.('device-inventory-links')
        if (Array.isArray(savedLinks)) {
            this.discoveredLinks = savedLinks
        }
        // Restore exclude patterns so the user's blocklist persists.
        const savedPatterns = await this._api?.prefGet?.('discovery-exclude-patterns')
        if (typeof savedPatterns === 'string') {
            this.excludePatternsText = savedPatterns
        }
        this.cdr.markForCheck()
    }

    private _saveInventory (): void {
        // Strip the non-enumerable __diagnostics tag the discovery service
        // attaches to result arrays (it's a debug aid, not user data).
        const cleanDevices = this.discoveredDevices.map(d => ({ ...d }))
        const cleanLinks = this.discoveredLinks.map(l => ({ ...l }))
        this._api?.prefSet?.('device-inventory', cleanDevices)
        // Persist LLDP adjacencies separately — same lifecycle as devices.
        this._api?.prefSet?.('device-inventory-links', cleanLinks)
        // Persist exclude patterns
        this._api?.prefSet?.('discovery-exclude-patterns', this.excludePatternsText)
    }

    editDevice (idx: number): void { this.editingIdx = idx; this.cdr.markForCheck() }

    saveDeviceEdit (dev: ExtendedDevice, field: string, event: Event): void {
        const value = (event.target as HTMLInputElement).value
        // Look up the live entry by reference identity, NOT by filtered-list
        // index — `dev` came from `filteredDevices` which is index-shifted
        // when a search filter is active.
        const idx = this.discoveredDevices.indexOf(dev)
        if (idx >= 0) {
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

    removeDevice (dev: ExtendedDevice): void {
        // Same fix as saveDeviceEdit — locate the live entry by reference.
        // The previous index-based version deleted the wrong device whenever
        // a search filter was active because filteredDevices index ≠
        // discoveredDevices index.
        const idx = this.discoveredDevices.indexOf(dev)
        if (idx < 0) { return }
        this.discoveredDevices.splice(idx, 1)
        // Drop any LLDP links and selection-state that referenced this device
        // — otherwise stale entries pile up and re-attach to future runs.
        const host = (dev.hostname || '').toLowerCase()
        const ip   = (dev.mgmtIp   || '').toLowerCase()
        const matches = (s: string): boolean => {
            const v = (s || '').toLowerCase()
            return !!((host && v === host) || (ip && v === ip))
        }
        this.discoveredLinks = this.discoveredLinks.filter(l =>
            !matches(l.srcHost) && !matches(l.dstHost),
        )
        if (host) { this.selectedDeviceHosts.delete(host) }
        this._saveInventory()
        this.cdr.markForCheck()
    }

    clearAllDevices (): void {
        this.showClearConfirm = true
        this.cdr.markForCheck()
    }

    confirmClearAll (): void {
        this.discoveredDevices = []
        // Wipe associated LLDP adjacencies + selection too — without devices
        // they have no meaning, and stale links would re-attach unexpectedly
        // to a future discovery run.
        this.discoveredLinks = []
        this.selectedDeviceHosts.clear()
        this.lastDiscoverySummary = ''
        this._saveInventory()
        this.showClearConfirm = false
        this.cdr.markForCheck()
    }

    close (): void { this.closed.emit() }

    // Discovery form state
    showDiscoveryForm = false
    discoveryForm = { host: '', username: '', password: '' }
    discoveryError = ''
    /** Newline-separated regex patterns. Any host whose name OR mgmt IP
     *  matches any pattern is skipped during discovery — never visited,
     *  never added to inventory, never recorded as a link endpoint. Lines
     *  starting with `#` are comments; blank lines are ignored. Patterns
     *  are matched case-insensitively. Persisted across app restarts. */
    excludePatternsText = ''

    /** Persist excludePatternsText whenever the user edits it. Throttle
     *  by reusing the existing inventory-save (which already writes to
     *  prefs) — the cost is one extra prefSet of a small string. */
    onExcludePatternsChanged (): void {
        this._saveInventory()
        this.cdr.markForCheck()
    }

    /** Toggle the inline regex-syntax help below the textarea. */
    showExcludeHelp = false
    toggleExcludeHelp (): void { this.showExcludeHelp = !this.showExcludeHelp; this.cdr.markForCheck() }

    /** Preset exclude patterns. One click appends the regex to the textarea
     *  (deduped if already present). Patterns are tuned for typical lab
     *  noise — mgmt switches, Linux/server hosts, SDN controllers, etc. */
    readonly excludePresets: Array<{ label: string; pattern: string; description: string }> = [
        { label: '🛠 Mgmt switches',  pattern: '^(geoman-|oob-|mgmt-)',
          description: 'Hostnames starting with geoman-, oob-, or mgmt-' },
        { label: '🖥 Linux servers',  pattern: '(srv\\d+|host\\d+|^dc-t\\d+srv)',
          description: 'srv1, host42, dc-tNNsrv… typical compute hostnames' },
        { label: '☁ Hypervisors',    pattern: '(esxi|kvm|hyperv|vmware)',
          description: 'ESXi / KVM / Hyper-V / VMware-tagged hosts' },
        { label: '🔮 SDN controllers', pattern: '(contrail-|openstack|^cont\\.)',
          description: 'Contrail, OpenStack, etc.' },
        { label: '🧪 Lab subdomain',   pattern: '\\.lab\\.',
          description: 'Anything FQDN-suffixed with .lab.' },
        { label: '📡 Mgmt VLAN IPs',  pattern: '^(10\\.99\\.|192\\.168\\.99\\.)',
          description: 'Common mgmt subnets — adjust for your network' },
        { label: '🐧 OS-tagged',      pattern: '(linux|ubuntu|debian|centos|rhel)',
          description: 'Hostnames containing OS names' },
    ]

    /** Append a preset pattern to the textarea if it's not already there. */
    appendExcludePreset (pattern: string): void {
        const lines = (this.excludePatternsText || '').split('\n').map(s => s.trim())
        // Already present? Skip to avoid duplicates.
        if (lines.includes(pattern.trim())) { return }
        const sep = (!this.excludePatternsText || /\n$/.test(this.excludePatternsText)) ? '' : '\n'
        this.excludePatternsText = `${this.excludePatternsText}${sep}${pattern}\n`
        this._saveInventory()
        this.cdr.markForCheck()
    }

    /** Compile the textarea content into RegExp[]. Invalid lines are
     *  skipped (with a console warning) so a typo in one pattern doesn't
     *  break discovery for the other patterns. */
    private _compileExcludePatterns (): RegExp[] {
        const out: RegExp[] = []
        for (const raw of (this.excludePatternsText || '').split('\n')) {
            const line = raw.trim()
            if (!line || line.startsWith('#')) { continue }
            try {
                out.push(new RegExp(line, 'i'))
            } catch (err) {
                console.warn(`[discovery] invalid exclude pattern "${line}": ${(err as Error).message}`)
            }
        }
        return out
    }
    /** Which discovery algorithm the form's Start button runs:
     *  - 'bfs':       walk LLDP outward from the seed (expands inventory)
     *  - 'inventory': probe only the current inventory and keep only
     *                 links whose both endpoints are in inventory */
    discoveryMode: 'bfs' | 'inventory' = 'bfs'

    /** Count of inventory devices that already have per-device SSH credentials.
     *  When this equals discoveredDevices.length, the form doesn't need
     *  fallback credentials at all — we just reuse each device's own creds. */
    get devicesWithCreds (): number {
        return this.discoveredDevices.filter(d => d.sshUsername && d.sshPassword).length
    }

    /** True iff every inventory device has its own SSH credentials, so the
     *  fallback fields in the Discover form are unnecessary. */
    get allInventoryHasCreds (): boolean {
        return this.discoveredDevices.length > 0 &&
               this.devicesWithCreds === this.discoveredDevices.length
    }

    /** Opens the inline discovery form (pre-filling saved prefs) and lets the
     *  user pick a mode. Called by the single "🔍 Discover" button. */
    async startDiscovery (): Promise<void> {
        if (!this.showDiscoveryForm) {
            // Show form first, pre-fill from saved prefs.
            // If inventory exists, default to inventory-only (user's probably
            // just trying to fill in cabling, not re-walk the fabric).
            const api = this._api
            this.discoveryForm.host = await api?.prefGet?.('discovery-host') ?? ''
            this.discoveryForm.username = await api?.prefGet?.('discovery-user') ?? ''
            this.discoveryForm.password = ''
            this.discoveryMode = this.discoveredDevices.length > 0 ? 'inventory' : 'bfs'
            this.showDiscoveryForm = true
            this.discoveryError = ''
            this.cdr.markForCheck()
            return
        }

        // Route based on selected mode.
        if (this.discoveryMode === 'inventory') {
            // Inventory mode uses per-device credentials automatically.
            // Fallback credentials are only required if at least one device
            // in inventory is missing its own creds.
            const devicesMissingCreds = this.discoveredDevices.length - this.devicesWithCreds
            const needsFallback = devicesMissingCreds > 0
            if (needsFallback && (!this.discoveryForm.username || !this.discoveryForm.password)) {
                this.discoveryError =
                    `${devicesMissingCreds} of ${this.discoveredDevices.length} device(s) have no SSH ` +
                    `credentials — enter fallback username/password for those, or cancel and fill them in ` +
                    `the inventory table first.`
                this.cdr.markForCheck()
                return
            }
            if (this.discoveryForm.username) {
                this._api?.prefSet?.('discovery-user', this.discoveryForm.username)
            }
            this.showDiscoveryForm = false
            this.cdr.markForCheck()
            await this.discoverInventoryLinks()
            return
        }

        // BFS mode: host + username + password all required.
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
            // Wire backend client from inventory service if connected
            if (this.invSvc.hasBackend) {
                this.discoverySvc.setBackendClient(this.invSvc.backendClient)
            }
            // Snapshot pre-discovery counts; the streaming callbacks pre-merge
            // each wave's deltas into discoveredDevices/discoveredLinks, so we
            // need this baseline to compute "(N new)" accurately at the end.
            const preCountDevices = this.discoveredDevices.length
            const preCountLinks   = this.discoveredLinks.length
            const result = await this.discoverySvc.discoverFromSeed(
                this.discoveryForm.host, 22, this.discoveryForm.username, this.discoveryForm.password,
                {
                    maxDepth: 3,
                    concurrency: 8,
                    timeoutMs: 8000,
                    maxHosts: 500,
                    excludePatterns: this._compileExcludePatterns(),
                    // Stream deltas to inventory + canvas as each wave completes.
                    onDevices: (newDevices) => {
                        const existingHosts = new Set(this.discoveredDevices.map(d => d.hostname))
                        const fresh = newDevices.filter(d => !existingHosts.has(d.hostname))
                        if (!fresh.length) { return }
                        this.discoveredDevices = [...this.discoveredDevices, ...fresh]
                        this._saveInventory()
                        if (this.liveBuildEnabled) {
                            this.liveDiscoveryDelta.emit({
                                newDevices: fresh,
                                newLinks: [],
                            })
                        }
                        this.cdr.markForCheck()
                    },
                    onLinks: (newLinks) => {
                        const linkKey = (l: DiscoveredLink): string =>
                            [l.srcHost, l.srcInterface, l.dstHost, l.dstInterface].join('|')
                        const existing = new Set(this.discoveredLinks.map(linkKey))
                        const fresh = newLinks.filter(l => !existing.has(linkKey(l)))
                        if (!fresh.length) { return }
                        this.discoveredLinks = [...this.discoveredLinks, ...fresh]
                        // Persist after each wave so a mid-discovery cancel
                        // (or app crash) doesn't lose the links built so far.
                        this._saveInventory()
                        if (this.liveBuildEnabled) {
                            this.liveDiscoveryDelta.emit({
                                newDevices: [],
                                newLinks: fresh,
                            })
                        }
                        this.cdr.markForCheck()
                    },
                    onProgress: (info) => {
                        // Show currently-probed hosts so the user can see the
                        // BFS isn't stuck — useful for big topologies where
                        // a single wave may take ~8s waiting on SSH timeouts.
                        const sample = info.currentHosts?.length
                            ? ` · probing ${info.currentHosts.slice(0, 3).join(', ')}` +
                              (info.currentHosts.length > 3 ? ` +${info.currentHosts.length - 3}` : '')
                            : ''
                        this.lastDiscoverySummary =
                            `Discovering… processed ${info.processed}, ${info.queued} queued ` +
                            `(${(info.elapsedMs / 1000).toFixed(1)}s)${sample}`
                        this.cdr.markForCheck()
                    },
                },
            )
            // Streaming callbacks already merged each wave's deltas. The two
            // dedup-merges below are no-ops in the streaming path but stay
            // defensively in case live mode was disabled or a callback was
            // dropped — they're cheap.
            const existingHosts = new Set(this.discoveredDevices.map(d => d.hostname))
            const newDevices = result.devices.filter(d => !d.hostname || !existingHosts.has(d.hostname))
            this.discoveredDevices = [...this.discoveredDevices, ...newDevices]
            const linkKey = (l: DiscoveredLink): string =>
                [l.srcHost, l.srcInterface, l.dstHost, l.dstInterface].join('|')
            const existingLinkKeys = new Set(this.discoveredLinks.map(linkKey))
            const newLinks = result.links.filter(l => !existingLinkKeys.has(linkKey(l)))
            this.discoveredLinks = [...this.discoveredLinks, ...newLinks]

            // Use the pre-discovery snapshot so "N new" reflects this run's
            // contribution even when the canvas was already updated live.
            const newDevicesThisRun = this.discoveredDevices.length - preCountDevices
            const newLinksThisRun   = this.discoveredLinks.length   - preCountLinks
            this.lastDiscoverySummary =
                `Discovery complete: ${result.devices.length} device${result.devices.length === 1 ? '' : 's'} ` +
                `(${newDevicesThisRun} new), ${result.links.length} LLDP adjacenc${result.links.length === 1 ? 'y' : 'ies'} ` +
                `(${newLinksThisRun} new)`

            // If discovery returned 0 devices, attach the actual probe output
            // so the user can see what the device said (instead of chasing
            // silent failures in the console).
            if (result.devices.length === 0 && this.discoverySvc.lastProbeResult.length > 0) {
                const probes = this.discoverySvc.lastProbeResult
                    .map(a => `  "${a.cmd}" → ${a.ok ? `${a.chars} chars: ${a.preview.slice(0, 180)}` : `error: ${a.err}`}`)
                    .join('\n')
                this.discoveryError = `Discovery found 0 devices. Probe output from seed:\n${probes}`
            }

            console.log(`[discovery] ${this.lastDiscoverySummary}`)
            console.log('[discovery] devices:', result.devices.map(d => ({ hostname: d.hostname, mgmtIp: d.mgmtIp, vendor: d.vendor })))
            console.log('[discovery] links:', result.links)
            console.log('[discovery] lastProbeResult:', this.discoverySvc.lastProbeResult)

            this._saveInventory()
            this.autoMatch()
        } catch (err) {
            this.discoveryError = `Discovery failed: ${(err as Error).message}`
        }

        this.discovering = false
        this.cdr.markForCheck()
    }

    /**
     * Closed-inventory LLDP discovery.
     *
     * Unlike startDiscovery (which walks LLDP neighbors outward from a seed),
     * this mode probes ONLY the devices already in inventory and keeps only
     * those LLDP adjacencies where both endpoints are in inventory. Used when
     * the user has curated their device list and just wants cabling filled in.
     */
    async discoverInventoryLinks (): Promise<void> {
        if (!this.discoveredDevices.length) {
            this.discoveryError = 'Inventory is empty. Add devices first (🔍 Discover, Upload CSV, or + Add Device).'
            this.cdr.markForCheck()
            return
        }

        // Each device is probed with its own SSH creds if present; the form's
        // user/pass act as a fallback for devices missing creds. Only raise
        // the form when there's NO usable path for at least one device.
        const seedUser = this.discoveryForm.username
        const seedPass = this.discoveryForm.password
        const haveFallback = !!(seedUser && seedPass)
        const devicesWithoutCreds = this.discoveredDevices.filter(d => !d.sshUsername || !d.sshPassword)
        if (devicesWithoutCreds.length > 0 && !haveFallback) {
            // Some devices have no creds and no fallback is set — ask for one.
            this.showDiscoveryForm = true
            this.discoveryMode = 'inventory'
            this.discoveryError =
                `${devicesWithoutCreds.length} of ${this.discoveredDevices.length} device(s) have no SSH ` +
                `credentials. Enter a fallback username/password to use for those, or cancel and fill the ` +
                `creds into the inventory table first.`
            this.cdr.markForCheck()
            return
        }

        this.discovering = true
        this.discoveryError = ''
        this.cdr.markForCheck()

        try {
            if (this.invSvc.hasBackend) {
                this.discoverySvc.setBackendClient(this.invSvc.backendClient)
            }
            const result = await this.discoverySvc.discoverLinksAmongInventory(
                this.discoveredDevices.map(d => ({
                    hostname: d.hostname,
                    mgmtIp: d.mgmtIp,
                    sshUsername: d.sshUsername,
                    sshPassword: d.sshPassword,
                })),
                {
                    fallbackUsername: seedUser,
                    fallbackPassword: seedPass,
                    port: 22,
                    timeoutMs: 8000,
                    concurrency: 8,
                    excludePatterns: this._compileExcludePatterns(),
                    onProgress: (info) => {
                        this.lastDiscoverySummary =
                            `Probing inventory… ${info.processed}/${info.total} ` +
                            `(${(info.elapsedMs / 1000).toFixed(1)}s)`
                        this.cdr.markForCheck()
                    },
                    // Stream link deltas live so the canvas grows as we go.
                    // (Inventory mode doesn't add devices — they're all known —
                    // so onDevices isn't strictly needed, but we wire it for
                    // vendor/model enrichment as discoveries land.)
                    onLinks: (newLinks) => {
                        const linkKey = (l: DiscoveredLink): string =>
                            [l.srcHost, l.srcInterface, l.dstHost, l.dstInterface].join('|')
                        const existing = new Set(this.discoveredLinks.map(linkKey))
                        const fresh = newLinks.filter(l => !existing.has(linkKey(l)))
                        if (!fresh.length) { return }
                        this.discoveredLinks = [...this.discoveredLinks, ...fresh]
                        // Persist immediately so links survive cancel/crash.
                        this._saveInventory()
                        if (this.liveBuildEnabled) {
                            this.liveDiscoveryDelta.emit({ newDevices: [], newLinks: fresh })
                        }
                        this.cdr.markForCheck()
                    },
                    onDevices: (newDevices) => {
                        // Update vendor/model on existing inventory entries.
                        for (const dev of newDevices) {
                            const existing = this.discoveredDevices.find(d =>
                                d.hostname?.toLowerCase() === dev.hostname.toLowerCase() ||
                                d.mgmtIp?.toLowerCase() === dev.mgmtIp.toLowerCase(),
                            )
                            if (existing) {
                                if (!existing.vendor && dev.vendor) { existing.vendor = dev.vendor }
                                if (!existing.model && dev.model)   { existing.model  = dev.model }
                            }
                        }
                        if (this.liveBuildEnabled) {
                            this.liveDiscoveryDelta.emit({ newDevices, newLinks: [] })
                        }
                        this.cdr.markForCheck()
                    },
                },
            )

            // Merge discovered links into existing, de-duped by endpoint tuple.
            const linkKey = (l: DiscoveredLink): string =>
                [l.srcHost, l.srcInterface, l.dstHost, l.dstInterface].join('|')
            const existingLinkKeys = new Set(this.discoveredLinks.map(linkKey))
            const newLinks = result.links.filter(l => !existingLinkKeys.has(linkKey(l)))
            this.discoveredLinks = [...this.discoveredLinks, ...newLinks]

            // Fold vendor/model back onto existing inventory entries if we
            // learned them from a successful probe.
            for (const dev of result.devices) {
                const existing = this.discoveredDevices.find(d =>
                    d.hostname?.toLowerCase() === dev.hostname.toLowerCase() ||
                    d.mgmtIp?.toLowerCase() === dev.mgmtIp.toLowerCase(),
                )
                if (!existing) { continue }
                if (!existing.vendor && dev.vendor) { existing.vendor = dev.vendor }
                if (!existing.model && dev.model)   { existing.model  = dev.model }
            }

            this.lastDiscoverySummary =
                `Inventory discovery complete: probed ${this.discoveredDevices.length} device(s), ` +
                `${result.devices.length} reachable, ${result.links.length} unique link(s) ` +
                `(${newLinks.length} new)`

            console.log(`[discovery-inv] ${this.lastDiscoverySummary}`)
            console.log('[discovery-inv] links:', result.links)

            this._saveInventory()
        } catch (err) {
            this.discoveryError = `Inventory discovery failed: ${(err as Error).message}`
        }

        this.discovering = false
        this.cdr.markForCheck()
    }

    /** Abort an in-flight discovery at the next wave boundary. Called by the
     *  Cancel button shown only while `discovering === true`. */
    cancelDiscovery (): void {
        this.discoverySvc.abort()
        this.lastDiscoverySummary = (this.lastDiscoverySummary || 'Discovering…') + ' — cancelling…'
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
            this.addError = 'Hostname or management address is required'
            this.cdr.markForCheck()
            return
        }
        if (!hostname) {
            this.addError = 'Hostname cannot be only whitespace'
            this.cdr.markForCheck()
            return
        }
        // Accept IPv4, IPv6 (bracketed or bare), or DNS hostname (RFC 1123).
        if (mgmtIp && !isValidMgmtAddress(mgmtIp)) {
            this.addError = 'Management address must be IPv4, IPv6, or a valid hostname'
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
                const ext = bestMatch as ExtendedDevice
                this.mappings.set(node.id, {
                    hostname: bestMatch.hostname,
                    mgmtIp: bestMatch.mgmtIp,
                    vendor: bestMatch.vendor,
                    model: bestMatch.model,
                    sshUsername: ext.sshUsername,
                    sshPassword: ext.sshPassword,
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
                    sshUsername: (dev as ExtendedDevice).sshUsername,
                    sshPassword: (dev as ExtendedDevice).sshPassword,
                })
            }
        }
        this.cdr.markForCheck()
    }

    /** Save mappings to the topology without pushing configs */
    applyMapping (): void {
        this.mappingApplied.emit({
            mappings: new Map(this.mappings),
            push: false,
            discoveredLinks: this.discoveredLinks.length ? [...this.discoveredLinks] : undefined,
        })
        this.closed.emit()
    }

    /** Save mappings AND push startup configs to mapped devices */
    applyAndPush (): void {
        this.mappingApplied.emit({
            mappings: new Map(this.mappings),
            push: true,
            discoveredLinks: this.discoveredLinks.length ? [...this.discoveredLinks] : undefined,
        })
        this.closed.emit()
    }

    /**
     * Auto-build a topology from the discovered devices + LLDP adjacencies.
     * Skips the manual mapping step — every device becomes a node, every LLDP
     * neighbor becomes a link.
     *
     * @param replace  true = wipe current canvas first; false = merge in.
     */
    buildTopologyFromDiscovery (replace: boolean): void {
        if (!this.discoveredDevices.length) { return }

        // Filter by checkbox selection if any are selected, else use ALL.
        // Empty selection means "no explicit selection" (the default state) —
        // we treat it as "build everything" for backward compatibility.
        let devices = this.discoveredDevices
        let links = this.discoveredLinks
        if (this.selectedDeviceHosts.size > 0) {
            const sel = this.selectedDeviceHosts
            const isSel = (host: string): boolean => sel.has((host || '').toLowerCase())
            devices = this.discoveredDevices.filter(d => isSel(d.hostname))
            // Keep only links where BOTH endpoints are in the selected subset.
            // Drops cross-boundary links (selected ↔ unselected) so the new
            // topology is self-contained.
            links = this.discoveredLinks.filter(l => isSel(l.srcHost) && isSel(l.dstHost))
        }

        if (!devices.length) {
            alert('No devices selected. Tick at least one row, or clear selection to use all.')
            return
        }

        if (replace && this.topology?.nodes?.length) {
            const ok = confirm(
                `Replace the current topology with ${devices.length} discovered ` +
                `device(s) and ${links.length} LLDP link(s)?\n\n` +
                `This will delete the existing ${this.topology.nodes.length} node(s) and ` +
                `${this.topology.links.length} link(s).`,
            )
            if (!ok) { return }
        }
        this.buildFromDiscoveryRequested.emit({ devices: [...devices], links: [...links], replace })
        this.closed.emit()
    }
}
