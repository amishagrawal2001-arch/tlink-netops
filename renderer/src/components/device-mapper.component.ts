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
    /** Outcome of the most recent discovery probe against this device. Used by
     *  the inventory table to render a per-row SSH-status pill so the user can
     *  see at a glance which devices are reachable vs failing auth vs unreachable. */
    lastProbe?: {
        /** 'ok' = vendor detected; 'fail' = SSH/auth/timeout error; 'unknown' = never probed. */
        status: 'ok' | 'fail' | 'unknown'
        /** When status='fail', the high-level cause from the discovery service. */
        cause?: 'auth' | 'unreachable' | 'other'
        /** Short human-readable detail (first 200 chars of the error). */
        detail?: string
        /** ISO timestamp of when the probe completed. */
        at?: string
    }
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

    /** Fires when the user clicks "🧹 Clear Canvas". Canvas owner is
     *  expected to confirm + wipe nodes/links via the topology service.
     *  Distinct from buildFromDiscoveryRequested: this just resets the
     *  canvas, it does NOT auto-populate from the discovered inventory.
     *  The Device Mapper stays open afterward so the user can decide
     *  whether to then click Build Topology. */
    @Output() clearCanvasRequested = new EventEmitter<void>()

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
    /** When false, both 🔗 Build Topology and ⟳ Replace & Build skip the
     *  discovered LLDP links — devices land on the canvas as isolated nodes
     *  and the user draws the wiring themselves. Default true keeps the
     *  prior behavior. Survives discovery re-runs within a session. */
    includeLldpLinks = true
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
        this._saveInventory()    // persist the cleared state
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

        // Snapshot the doomed devices so we can cascade-purge each one through
        // mappings (the bulk filter below handles inventory + links).
        const doomed = this.discoveredDevices.filter(d =>
            sel.has(this._key(d.hostname)),
        )
        // Drop devices whose hostname is in the selection.
        this.discoveredDevices = this.discoveredDevices.filter(d =>
            !sel.has(this._key(d.hostname)),
        )
        // Drop any LLDP link that touches a selected device on either end.
        this.discoveredLinks = this.discoveredLinks.filter(l =>
            !sel.has(this._key(l.srcHost)) && !sel.has(this._key(l.dstHost)),
        )
        // Cascade through mappings using the central purge helper so the
        // Mapping tab doesn't end up with orphan rows pointing at deleted devices.
        for (const d of doomed) { this._purgeReferences(d.hostname, d.mgmtIp) }
        this._invalidateFilterCache()
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
    /** Search scope for the Mapping tab — separate from inventory search so
     *  filtering one tab doesn't surprise the other. */
    mappingSearchQuery = ''
    showClearConfirm = false
    addError = ''
    /** Toast/inline-banner for import summaries (added/skipped counts). */
    importSummary = ''
    /** When user inline-edits an mgmt IP that fails validation, store the
     *  message keyed by hostname so the UI can show a per-row error pill. */
    inlineEditErrors = new Map<string, string>()

    private _api = (window as any).netopsAPI

    /** Memoized cache for `filteredDevices` — re-derived only when the
     *  search query OR the underlying array reference / length changes.
     *  Avoids quadratic re-filtering on every change-detection cycle. */
    private _filteredCache: { key: string; result: ExtendedDevice[] } | null = null

    /** Public accessor for trackBy in the inventory `*ngFor`. Identity-stable
     *  enough for normal use; the hostname is the natural key. */
    trackByHostname (_idx: number, dev: ExtendedDevice): string {
        return (dev.hostname || '') + '|' + (dev.mgmtIp || '')
    }
    trackByNodeId (_idx: number, node: TopologyNode): string { return node.id }

    /** Lowercased hostname used as the canonical key in selection / dedup /
     *  cascades. Centralised so we never accidentally mismatch case. */
    private _key (s: string | undefined | null): string {
        return (s || '').trim().toLowerCase()
    }

    get filteredDevices (): ExtendedDevice[] {
        const key = `${this.searchQuery}|${this.discoveredDevices.length}`
        // Cheap reference check — if the array hasn't been swapped AND the
        // query hasn't changed, return the previous filter result directly.
        if (this._filteredCache && this._filteredCache.key === key) {
            return this._filteredCache.result
        }
        const q = (this.searchQuery || '').toLowerCase().trim()
        const result = q
            ? this.discoveredDevices.filter(d =>
                d.hostname.toLowerCase().includes(q)        ||
                d.mgmtIp.toLowerCase().includes(q)          ||
                (d.vendor || '').toLowerCase().includes(q)  ||
                (d.model  || '').toLowerCase().includes(q)  ||
                (d.sshUsername || '').toLowerCase().includes(q) ||
                ((d as any).serialNumber || '').toLowerCase().includes(q),
              )
            : this.discoveredDevices
        this._filteredCache = { key, result }
        return result
    }

    /** Force-invalidate the filteredDevices memo. Call whenever the
     *  underlying array is mutated in-place (push/splice). */
    private _invalidateFilterCache (): void { this._filteredCache = null }

    /** Topology-node search for the Mapping tab. */
    get filteredTopologyNodes (): TopologyNode[] {
        const q = (this.mappingSearchQuery || '').toLowerCase().trim()
        if (!q) { return this.topologyNodes }
        return this.topologyNodes.filter(n =>
            n.label.toLowerCase().includes(q) ||
            (n.vendor || '').toLowerCase().includes(q) ||
            (n.model || '').toLowerCase().includes(q) ||
            (n.role || '').toLowerCase().includes(q),
        )
    }

    /** Pre-computed Set of hostnames already claimed by other mappings.
     *  Built once per render via a getter rather than per-row in
     *  `getAvailableDevices(nodeId)`. */
    private _usedHostnamesByOtherMappings (excludeNodeId: string): Set<string> {
        const used = new Set<string>()
        for (const [id, entry] of this.mappings) {
            if (id !== excludeNodeId && entry.hostname) {
                used.add(this._key(entry.hostname))
            }
        }
        return used
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
        // Restore selection — only keep entries that still match a current
        // inventory device. Stale entries are silently dropped.
        const savedSel = await this._api?.prefGet?.('device-inventory-selection')
        if (Array.isArray(savedSel)) {
            const validHosts = new Set(this.discoveredDevices.map(d => this._key(d.hostname)))
            for (const k of savedSel) {
                const norm = this._key(k)
                if (norm && validHosts.has(norm)) { this.selectedDeviceHosts.add(norm) }
            }
        }
        this._invalidateFilterCache()
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
        // Persist selection so a user's curated subset survives reopen.
        this._api?.prefSet?.('device-inventory-selection', [...this.selectedDeviceHosts])
    }

    /** Propagate a hostname rename through every state that keys on hostname:
     *   - selection set (lowercased keys)
     *   - LLDP links (both srcHost and dstHost endpoints)
     *   - existing mappings (`MappingEntry.hostname` field)
     *  Without this cascade, renaming a device leaves orphaned references
     *  scattered across these structures. */
    private _cascadeHostnameRename (oldHostname: string, newHostname: string): void {
        const oldK = this._key(oldHostname)
        const newK = this._key(newHostname)
        if (!oldK || oldK === newK) { return }

        // Selection
        if (this.selectedDeviceHosts.has(oldK)) {
            this.selectedDeviceHosts.delete(oldK)
            this.selectedDeviceHosts.add(newK)
        }
        // Links
        for (const l of this.discoveredLinks) {
            if (this._key(l.srcHost) === oldK) { l.srcHost = newHostname }
            if (this._key(l.dstHost) === oldK) { l.dstHost = newHostname }
        }
        // Mappings
        for (const [, entry] of this.mappings) {
            if (this._key(entry.hostname) === oldK) { entry.hostname = newHostname }
        }
    }

    /** Propagate a mgmt-IP rename through mappings (the only structure that
     *  keys on IP — links use hostname; selection too). */
    private _cascadeMgmtIpRename (oldIp: string, newIp: string): void {
        if (!oldIp || oldIp === newIp) { return }
        for (const [, entry] of this.mappings) {
            if (entry.mgmtIp === oldIp) { entry.mgmtIp = newIp }
        }
    }

    /** Drop EVERY reference to the named device — selection, mappings, links.
     *  Called from `removeDevice` and `confirmClearAll`. */
    private _purgeReferences (hostname: string, mgmtIp: string): void {
        const hostK = this._key(hostname)
        const ipK   = (mgmtIp || '').toLowerCase()
        const matches = (s: string): boolean => {
            const v = (s || '').toLowerCase()
            return !!((hostK && v === hostK) || (ipK && v === ipK))
        }
        // Links — drop any link whose either endpoint matches.
        this.discoveredLinks = this.discoveredLinks.filter(l =>
            !matches(l.srcHost) && !matches(l.dstHost),
        )
        // Selection
        if (hostK) { this.selectedDeviceHosts.delete(hostK) }
        // Mappings — drop entries whose hostname / IP point at the removed device.
        const toDrop: string[] = []
        for (const [nodeId, entry] of this.mappings) {
            if (this._key(entry.hostname) === hostK || (ipK && entry.mgmtIp.toLowerCase() === ipK)) {
                toDrop.push(nodeId)
            }
        }
        for (const id of toDrop) { this.mappings.delete(id) }
    }

    editDevice (idx: number): void { this.editingIdx = idx; this.cdr.markForCheck() }

    saveDeviceEdit (dev: ExtendedDevice, field: string, event: Event): void {
        const value = (event.target as HTMLInputElement).value
        // Look up the live entry by reference identity, NOT by filtered-list
        // index — `dev` came from `filteredDevices` which is index-shifted
        // when a search filter is active.
        const idx = this.discoveredDevices.indexOf(dev)
        if (idx < 0) { return }

        const oldHost = (this.discoveredDevices[idx].hostname || '')
        const oldIp   = (this.discoveredDevices[idx].mgmtIp   || '')
        const errKey  = this._key(oldHost)

        // Validate mgmt IP edits — refuse the write if it's not a valid
        // address. Show the error per-row so the user sees it inline.
        if (field === 'mgmtIp' && value && !isValidMgmtAddress(value)) {
            this.inlineEditErrors.set(errKey, `"${value}" is not a valid IPv4 / IPv6 / hostname`)
            // Reset the input visually so the bad value doesn't persist.
            ;(event.target as HTMLInputElement).value = oldIp
            this.cdr.markForCheck()
            return
        }
        // Refuse hostname collisions — keying selection / mappings on hostname
        // means two rows with the same name silently break invariants.
        if (field === 'hostname' && value && this._key(value) !== this._key(oldHost)) {
            const collision = this.discoveredDevices.some((d, i) =>
                i !== idx && this._key(d.hostname) === this._key(value),
            )
            if (collision) {
                this.inlineEditErrors.set(errKey, `Hostname "${value}" already exists in inventory`)
                ;(event.target as HTMLInputElement).value = oldHost
                this.cdr.markForCheck()
                return
            }
        }

        // Apply the edit.
        ;(this.discoveredDevices[idx] as any)[field] = value
        this.inlineEditErrors.delete(errKey)
        this._invalidateFilterCache()

        // Cascade renames through mappings + selection + links so they don't
        // become orphaned. (Without this, a renamed device leaves stale entries
        // in mappings keyed by the old hostname; push fails with "no creds".)
        if (field === 'hostname' && value && this._key(value) !== this._key(oldHost)) {
            this._cascadeHostnameRename(oldHost, value)
        }
        if (field === 'mgmtIp' && value !== oldIp) {
            this._cascadeMgmtIpRename(oldIp, value)
        }

        this._saveInventory()
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
        // Locate the live entry by reference (filteredDevices is index-shifted
        // when a search filter is active — index lookup would target the
        // wrong row).
        const idx = this.discoveredDevices.indexOf(dev)
        if (idx < 0) { return }
        this.discoveredDevices.splice(idx, 1)
        // Cascade: drop selection / mapping / link references in one place.
        this._purgeReferences(dev.hostname, dev.mgmtIp)
        this._invalidateFilterCache()
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

    close (): void {
        // If a discovery is mid-flight, abort it — otherwise the worker keeps
        // hammering SSH against the fabric in the background even after the
        // user clicks ✕ and walks away.
        if (this.discovering) {
            console.warn('[device-mapper] dialog closed mid-discovery — aborting active run')
            try { this.discoverySvc.abort() } catch { /* swallow */ }
        }
        this.closed.emit()
    }

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

        // Honour explicit selection: when the user has checked specific rows in
        // the inventory table, probe ONLY those devices. Empty selection means
        // "no special scope" → probe every device. This lets the user iterate
        // on a subset without having to delete unrelated devices.
        const probeTargets: ExtendedDevice[] = this.selectedDeviceHosts.size > 0
            ? this.discoveredDevices.filter(d =>
                this.selectedDeviceHosts.has((d.hostname || '').toLowerCase()),
              )
            : this.discoveredDevices
        const scopeIsSelection = this.selectedDeviceHosts.size > 0
        if (scopeIsSelection && !probeTargets.length) {
            this.discoveryError =
                'Selection is non-empty but none of the selected hostnames match an inventory device. ' +
                'Clear the selection (header checkbox) to probe everything, or re-check the rows you want.'
            this.cdr.markForCheck()
            return
        }

        // Each device is probed with its own SSH creds if present; the form's
        // user/pass act as a fallback for devices missing creds. Only raise
        // the form when there's NO usable path for at least one device IN
        // THE SCOPED SUBSET — devices outside the scope are irrelevant.
        const seedUser = this.discoveryForm.username
        const seedPass = this.discoveryForm.password
        const haveFallback = !!(seedUser && seedPass)
        const devicesWithoutCreds = probeTargets.filter(d => !d.sshUsername || !d.sshPassword)
        if (devicesWithoutCreds.length > 0 && !haveFallback) {
            // Some devices have no creds and no fallback is set — ask for one.
            this.showDiscoveryForm = true
            this.discoveryMode = 'inventory'
            const scopeNote = scopeIsSelection
                ? ` (within the ${probeTargets.length} selected device(s))`
                : ''
            this.discoveryError =
                `${devicesWithoutCreds.length} of ${probeTargets.length} device(s) have no SSH ` +
                `credentials${scopeNote}. Enter a fallback username/password to use for those, or cancel and fill the ` +
                `creds into the inventory table first.`
            this.cdr.markForCheck()
            return
        }

        this.discovering = true
        this.discoveryError = ''
        this.cdr.markForCheck()
        console.log(
            `[discovery-inv] scope=${scopeIsSelection ? 'selected' : 'all'} ` +
            `targets=${probeTargets.length}/${this.discoveredDevices.length}`,
        )

        try {
            if (this.invSvc.hasBackend) {
                this.discoverySvc.setBackendClient(this.invSvc.backendClient)
            }
            const result = await this.discoverySvc.discoverLinksAmongInventory(
                probeTargets.map(d => ({
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
                        // Show per-cause fail counts mid-run so a wrong-credentials
                        // mistake becomes visible immediately, not 5 minutes later.
                        const failBreakdown = (info.authFailed || info.unreachable || info.otherFailed)
                            ? ` · auth-fail=${info.authFailed ?? 0} unreachable=${info.unreachable ?? 0} other=${info.otherFailed ?? 0}`
                            : ''
                        const scopeLabel = scopeIsSelection ? 'selection' : 'inventory'
                        this.lastDiscoverySummary =
                            `Probing ${scopeLabel}… ${info.processed}/${info.total} ` +
                            `(${(info.elapsedMs / 1000).toFixed(1)}s)${failBreakdown}`
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

            // Surface the failure breakdown stamped by the service, plus the
            // bail-early reason if discovery aborted on consecutive auth fails.
            const summary: any = (result.devices as any).__summary
            const breakdown = summary
                ? ` · auth-fail=${summary.authFailed} unreachable=${summary.unreachable} other=${summary.otherFailed}`
                : ''
            const bail = summary?.bailedEarly
                ? ` · ⚠ ${summary.bailReason}`
                : ''
            const scopeNote = scopeIsSelection
                ? ` (selection of ${probeTargets.length} from ${this.discoveredDevices.length})`
                : ''
            this.lastDiscoverySummary =
                `Inventory discovery complete: probed ${probeTargets.length} device(s)${scopeNote}, ` +
                `${result.devices.length} reachable, ${result.links.length} unique link(s) ` +
                `(${newLinks.length} new)${breakdown}${bail}`

            // Promote auth-fail / bail-early to a visible error so the user
            // sees it as a problem, not a normal "complete" message.
            if (summary?.bailedEarly) {
                this.discoveryError =
                    `Discovery aborted: ${summary.authFailed} consecutive authentication failure(s). ` +
                    `Verify the fallback username/password are correct and that any per-device credentials in the inventory aren't expired/locked. ` +
                    `Tip: try the Devices → Set SSH Credentials… dialog to refresh creds across the inventory before retrying.`
            } else if (summary && summary.authFailed > 0 && summary.ok === 0) {
                this.discoveryError =
                    `All ${summary.authFailed} reachable device(s) failed SSH authentication. ` +
                    `Check your fallback username/password.`
            }

            // ── Stamp per-device probe status onto the inventory rows so the
            //    table shows a green/red dot per device. The discovery service
            //    attaches a __diagnostics array to the result with one entry per
            //    probed inventory device — match those back to inventory rows. ──
            this._applyDiagnosticsToInventory(probeTargets, result)

            console.log(`[discovery-inv] ${this.lastDiscoverySummary}`)
            console.log('[discovery-inv] links:', result.links)

            this._saveInventory()
        } catch (err) {
            this.discoveryError = `Inventory discovery failed: ${(err as Error).message}`
        }

        this.discovering = false
        this.cdr.markForCheck()
    }

    /** Walk the discovery service's diagnostics array and stamp each entry's
     *  outcome onto the matching inventory row's `lastProbe` field. Powers
     *  the per-row SSH-status pill in the inventory table. */
    private _applyDiagnosticsToInventory (
        probed: ExtendedDevice[],
        result: any,
    ): void {
        const diagnostics = (result.devices as any).__diagnostics as Array<{
            host: string; status: string; detail?: string; cause?: string;
        }> | undefined
        if (!Array.isArray(diagnostics)) { return }

        const now = new Date().toISOString()
        // Diagnostics are keyed by `host` which is the resolved target —
        // either mgmtIp or hostname. Build a lookup by both so we can match
        // back to the inventory row.
        const byTarget = new Map<string, typeof diagnostics[0]>()
        for (const d of diagnostics) {
            const key = (d.host || '').toLowerCase()
            if (key) { byTarget.set(key, d) }
        }

        for (const dev of probed) {
            const ipKey = (dev.mgmtIp || '').toLowerCase()
            const hostKey = (dev.hostname || '').toLowerCase()
            const diag = byTarget.get(ipKey) ?? byTarget.get(hostKey)
            if (!diag) { continue }

            // Find the live inventory entry by reference and stamp the result.
            const idx = this.discoveredDevices.findIndex(d =>
                d.hostname === dev.hostname || d.mgmtIp === dev.mgmtIp,
            )
            if (idx < 0) { continue }

            const live = this.discoveredDevices[idx] as ExtendedDevice
            if (diag.status === 'ok') {
                live.lastProbe = { status: 'ok', detail: diag.detail, at: now }
            } else if (diag.status === 'fail') {
                live.lastProbe = {
                    status: 'fail',
                    cause: (diag.cause as 'auth' | 'unreachable' | 'other' | undefined) ?? 'other',
                    detail: diag.detail,
                    at: now,
                }
            } else {
                // 'skip' = no creds / no mgmtIp / vendor not detected (probes ran but matched nothing)
                live.lastProbe = {
                    status: 'fail',
                    cause: 'other',
                    detail: diag.detail ?? 'skipped',
                    at: now,
                }
            }
        }
        this._invalidateFilterCache()
    }

    /** True if any inventory device's most-recent probe was a failure.
     *  Drives the post-discovery failure summary banner. */
    get hasProbeFailures (): boolean {
        return this.discoveredDevices.some(d => (d as ExtendedDevice).lastProbe?.status === 'fail')
    }

    /** Subset of inventory whose last probe failed — for the failure banner. */
    get probeFailedDevices (): ExtendedDevice[] {
        return this.discoveredDevices.filter(d =>
            (d as ExtendedDevice).lastProbe?.status === 'fail',
        ) as ExtendedDevice[]
    }

    /** Tooltip text for a row's SSH-status pill. */
    probeTooltip (dev: ExtendedDevice): string {
        const p = dev.lastProbe
        if (!p || p.status === 'unknown') { return 'SSH status unknown — never probed' }
        if (p.status === 'ok') {
            return `SSH OK${p.at ? ` · ${this._timeAgo(p.at)}` : ''}${p.detail ? ` · ${p.detail}` : ''}`
        }
        const causeLabel = p.cause === 'auth'        ? 'Authentication failed'
                         : p.cause === 'unreachable' ? 'Host unreachable / SSH not responding'
                                                     : 'Connection failed'
        return `${causeLabel}${p.at ? ` · ${this._timeAgo(p.at)}` : ''}${p.detail ? `\n${p.detail}` : ''}`
    }

    /** Human-friendly age relative to now (e.g. "2m ago"). */
    private _timeAgo (iso: string): string {
        try {
            const ms = Date.now() - new Date(iso).getTime()
            if (ms < 60_000)        { return 'just now' }
            if (ms < 3_600_000)     { return `${Math.round(ms / 60_000)}m ago` }
            if (ms < 86_400_000)    { return `${Math.round(ms / 3_600_000)}h ago` }
            return `${Math.round(ms / 86_400_000)}d ago`
        } catch { return iso }
    }

    /** Dismiss the failure banner — clears the per-row pills (so the banner
     *  stops rendering) but preserves the inventory itself. Called from the ✕
     *  on the banner. */
    clearFailureBanner (): void {
        for (const d of this.discoveredDevices) {
            (d as ExtendedDevice).lastProbe = undefined
        }
        this._invalidateFilterCache()
        this._saveInventory()
        this.cdr.markForCheck()
    }

    /** Filter the inventory table to show only failed-probe devices.
     *  Wired to the failure banner's "Show failed only" link. */
    filterFailedOnly (): void {
        // Hostname-based filter — leverage the existing search box. We can't
        // do a multi-hostname OR via a single text query, so we use a magic
        // sentinel: typing "ssh:fail" makes filteredDevices show fails only.
        // Simpler approach: just clear search and let the user see all rows
        // tinted red (see SCSS). The banner already lists the failed names.
        // For now, scroll to the table and rely on the row tint + banner.
        this.searchQuery = ''
        this._invalidateFilterCache()
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
                const summary = file.name.endsWith('.json')
                    ? this._parseJsonDevices(content)
                    : this._parseCsvDevices(content)
                this._invalidateFilterCache()
                this._saveInventory()
                this.importSummary =
                    `Import: +${summary.added} added` +
                    (summary.skippedDup > 0 ? `, ${summary.skippedDup} skipped (duplicate of existing inventory)` : '') +
                    (summary.skippedInvalid > 0 ? `, ${summary.skippedInvalid} skipped (invalid hostname/IP)` : '')
                // Auto-match in MERGE mode so we don't blow away the user's
                // manual mappings just because they imported new devices.
                this.autoMatch('merge')
            } catch (err) {
                alert(`Failed to parse file: ${(err as Error).message}`)
            }
            this.cdr.markForCheck()
        }
        reader.readAsText(file)
        input.value = '' // reset so same file can be re-uploaded
    }

    /** Tries to add an incoming device, deduping by BOTH hostname AND mgmtIp.
     *  Returns the bucket the row landed in so the import summary can count. */
    private _ingestDevice (
        d: { hostname: string; mgmtIp: string; vendor: string; model: string;
             sshUsername: string; sshPassword: string },
        existingHosts: Set<string>,
        existingIps: Set<string>,
    ): 'added' | 'skipped-dup' | 'skipped-invalid' {
        const hostname = (d.hostname || '').trim()
        const mgmtIp   = (d.mgmtIp   || '').trim()
        // Need at least one of hostname/IP to identify the row.
        if (!hostname && !mgmtIp) { return 'skipped-invalid' }
        // Validate the IP up-front — bogus values stop downstream discovery.
        if (mgmtIp && !isValidMgmtAddress(mgmtIp)) { return 'skipped-invalid' }

        const hostK = this._key(hostname)
        const ipK   = mgmtIp.toLowerCase()
        if ((hostK && existingHosts.has(hostK)) || (ipK && existingIps.has(ipK))) {
            return 'skipped-dup'
        }
        this.discoveredDevices.push({
            hostname, mgmtIp,
            vendor: (d.vendor || '').trim(),
            model:  (d.model  || '').trim(),
            interfaces: [],
            sshUsername: d.sshUsername || '',
            sshPassword: d.sshPassword || '',
        })
        if (hostK) { existingHosts.add(hostK) }
        if (ipK)   { existingIps.add(ipK) }
        return 'added'
    }

    private _parseJsonDevices (content: string): { added: number; skippedDup: number; skippedInvalid: number } {
        const data = JSON.parse(content)
        const devices = Array.isArray(data) ? data : data.devices ?? data.hosts ?? [data]
        const existingHosts = new Set(this.discoveredDevices.map(d => this._key(d.hostname)))
        const existingIps   = new Set(this.discoveredDevices.map(d => (d.mgmtIp || '').toLowerCase()))
        let added = 0, skippedDup = 0, skippedInvalid = 0
        for (const d of devices) {
            const result = this._ingestDevice({
                hostname:    d.hostname ?? d.name ?? d.host ?? '',
                mgmtIp:      d.mgmtIp   ?? d.ip ?? d.management_ip ?? d.address ?? '',
                vendor:      d.vendor   ?? d.platform ?? d.os ?? '',
                model:       d.model    ?? d.hardware ?? '',
                sshUsername: d.sshUsername ?? d.ssh_username ?? d.username ?? '',
                sshPassword: d.sshPassword ?? d.ssh_password ?? d.password ?? '',
            }, existingHosts, existingIps)
            if (result === 'added')           { added++ }
            else if (result === 'skipped-dup') { skippedDup++ }
            else                                { skippedInvalid++ }
        }
        return { added, skippedDup, skippedInvalid }
    }

    /** RFC-4180 quote-aware CSV row splitter. Handles fields like
     *  "Spine-1, rack 5", embedded "" escapes, and bare un-quoted fields.
     *  Drops the surrounding quotes after split. */
    private _splitCsvRow (line: string): string[] {
        const out: string[] = []
        let cur = ''
        let inQuotes = false
        for (let i = 0; i < line.length; i++) {
            const ch = line[i]
            if (inQuotes) {
                if (ch === '"') {
                    if (line[i + 1] === '"') { cur += '"'; i++ }   // escaped quote
                    else                      { inQuotes = false }
                } else {
                    cur += ch
                }
            } else {
                if (ch === ',')      { out.push(cur); cur = '' }
                else if (ch === '"' && cur === '') { inQuotes = true }
                else                  { cur += ch }
            }
        }
        out.push(cur)
        return out.map(s => s.trim())
    }

    private _parseCsvDevices (content: string): { added: number; skippedDup: number; skippedInvalid: number } {
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l)
        if (lines.length < 2) { return { added: 0, skippedDup: 0, skippedInvalid: 0 } }

        // Quote-aware parse so commas inside quoted fields don't shift columns.
        const header = this._splitCsvRow(lines[0]).map(h => h.toLowerCase())
        const hostIdx = header.findIndex(h => h === 'hostname') >= 0
            ? header.findIndex(h => h === 'hostname')
            : header.findIndex(h => h.includes('hostname') || h === 'name' || h === 'host' || h === 'device_name')
        const ipIdx = header.findIndex(h => h === 'mgmtip' || h === 'mgmt_ip' || h === 'management_ip') >= 0
            ? header.findIndex(h => h === 'mgmtip' || h === 'mgmt_ip' || h === 'management_ip')
            : header.findIndex(h => h === 'ip' || h === 'address' || h === 'ip_address')
        const vendorIdx = header.findIndex(h => h === 'vendor' || h === 'platform' || h === 'manufacturer')
        const modelIdx = header.findIndex(h => h === 'model' || h === 'hardware' || h === 'device_type')
        const sshUserIdx = header.findIndex(h => h === 'sshusername' || h === 'ssh_username' || h === 'username')
        const sshPassIdx = header.findIndex(h => h === 'sshpassword' || h === 'ssh_password' || h === 'password')

        const existingHosts = new Set(this.discoveredDevices.map(d => this._key(d.hostname)))
        const existingIps   = new Set(this.discoveredDevices.map(d => (d.mgmtIp || '').toLowerCase()))
        let added = 0, skippedDup = 0, skippedInvalid = 0

        for (let i = 1; i < lines.length; i++) {
            const cols = this._splitCsvRow(lines[i])
            if (!cols.length || !cols.some(c => c)) { continue }
            const result = this._ingestDevice({
                hostname:    hostIdx    >= 0 ? cols[hostIdx]    ?? '' : cols[0] ?? '',
                mgmtIp:      ipIdx      >= 0 ? cols[ipIdx]      ?? '' : cols[1] ?? '',
                vendor:      vendorIdx  >= 0 ? cols[vendorIdx]  ?? '' : '',
                model:       modelIdx   >= 0 ? cols[modelIdx]   ?? '' : '',
                sshUsername: sshUserIdx >= 0 ? cols[sshUserIdx] ?? '' : '',
                sshPassword: sshPassIdx >= 0 ? cols[sshPassIdx] ?? '' : '',
            }, existingHosts, existingIps)
            if (result === 'added')            { added++ }
            else if (result === 'skipped-dup') { skippedDup++ }
            else                                { skippedInvalid++ }
        }
        return { added, skippedDup, skippedInvalid }
    }

    /** Dismiss the import summary banner. */
    clearImportSummary (): void { this.importSummary = ''; this.cdr.markForCheck() }

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
        this._downloadFile(csv, 'device-inventory.csv', 'text/csv')
    }

    /** JSON export — round-trips losslessly with the import path (preserves
     *  the `interfaces` array which CSV strips). */
    exportInventoryJson (): void {
        const cleaned = this.discoveredDevices.map(d => ({
            hostname: d.hostname,
            mgmtIp:   d.mgmtIp,
            vendor:   d.vendor || '',
            model:    d.model || '',
            interfaces: d.interfaces ?? [],
            sshUsername: (d as any).sshUsername || '',
            sshPassword: (d as any).sshPassword || '',
        }))
        const json = JSON.stringify({ devices: cleaned, exportedAt: new Date().toISOString() }, null, 2)
        this._downloadFile(json, 'device-inventory.json', 'application/json')
    }

    /** Returns devices not already mapped to another node (except the current
     *  node's own mapping). Case-insensitive on hostname so renames flow
     *  through correctly. */
    getAvailableDevices (nodeId: string): DiscoveredDevice[] {
        const used = this._usedHostnamesByOtherMappings(nodeId)
        return this.discoveredDevices.filter(d => !used.has(this._key(d.hostname)))
    }

    /**
     * Auto-match topology nodes to inventory devices using a hostname/vendor/
     * model heuristic. Two-pass to avoid duplicate-assignment:
     *   Pass 1 — score every (node, device) pair, sort by score descending
     *   Pass 2 — walk in order, claiming each device for at most ONE node
     *
     * Threshold raised from 30 (vendor-only) to 60 (requires either a
     * hostname overlap OR vendor+model agreement) — vendor alone is too
     * weak when the inventory has 20 Junipers and the topology has 20 Junipers.
     *
     * Confirms before clearing existing mappings unless `mode === 'merge'`,
     * which preserves manually-set mappings and only fills in the gaps.
     */
    autoMatch (mode: 'replace' | 'merge' = 'replace'): void {
        if (mode === 'replace' && this.mappings.size > 0) {
            const ok = confirm(
                `Auto-match will overwrite all ${this.mappings.size} existing mapping(s). ` +
                `Use "Auto-match (merge)" to keep them and only fill in unmapped nodes.\n\nContinue?`,
            )
            if (!ok) { return }
        }

        if (mode === 'replace') { this.mappings.clear() }

        // Score every plausible (node, device) pairing. Higher score = better.
        // Threshold = 60 means at least one of:
        //   - hostname overlap (50 partial / 100 exact)
        //   - vendor (30) + model (20) = 50 combined → still under threshold
        //   - vendor (30) + hostname-partial (50) = 80 → match
        // So vendor-alone (30) and model-alone (20) are correctly rejected.
        type Candidate = { nodeId: string; dev: DiscoveredDevice; score: number }
        const candidates: Candidate[] = []
        for (const node of this.topologyNodes) {
            // In merge mode, skip nodes that already have a mapping.
            if (mode === 'merge' && this.mappings.has(node.id)) { continue }
            const normalLabel = node.label.toLowerCase().replace(/[\s_-]/g, '')
            const nodeVendor = (node.vendor ?? '').toLowerCase()
            for (const dev of this.discoveredDevices) {
                const normalHost = dev.hostname.toLowerCase().replace(/[\s_-]/g, '')
                let score = 0
                if (normalHost === normalLabel) { score += 100 }
                else if (normalHost.includes(normalLabel) || normalLabel.includes(normalHost)) { score += 50 }
                if (nodeVendor && dev.vendor.toLowerCase().includes(nodeVendor)) { score += 30 }
                if (node.model && dev.model && dev.model.toLowerCase().includes(node.model.toLowerCase())) { score += 20 }
                if (score >= 60) { candidates.push({ nodeId: node.id, dev, score }) }
            }
        }

        // Greedy assign: highest-score pair first, claim the device, move on.
        // This way one inventory device can't be assigned to N topology nodes —
        // the runner-up node sees the dev as already-claimed and gets its
        // second-best (or no match) instead.
        candidates.sort((a, b) => b.score - a.score)
        const claimedNodes = new Set<string>()
        const claimedDevs  = new Set<string>()
        if (mode === 'merge') {
            // Pre-populate claimed sets from existing mappings so they
            // don't get re-assigned and so their devices stay claimed.
            for (const [id, entry] of this.mappings) {
                claimedNodes.add(id)
                claimedDevs.add(this._key(entry.hostname))
            }
        }

        let matched = 0
        for (const c of candidates) {
            if (claimedNodes.has(c.nodeId)) { continue }
            const devK = this._key(c.dev.hostname)
            if (claimedDevs.has(devK)) { continue }
            const ext = c.dev as ExtendedDevice
            this.mappings.set(c.nodeId, {
                hostname: c.dev.hostname,
                mgmtIp: c.dev.mgmtIp,
                vendor: c.dev.vendor,
                model: c.dev.model,
                sshUsername: ext.sshUsername,
                sshPassword: ext.sshPassword,
            })
            claimedNodes.add(c.nodeId)
            claimedDevs.add(devK)
            matched++
        }

        const totalEligible = mode === 'merge'
            ? this.topologyNodes.length - (this.mappings.size - matched)  // approximate "previously unmapped"
            : this.topologyNodes.length
        console.log(
            `[device-mapper] auto-match (${mode}): ${matched}/${totalEligible} node(s) matched`,
        )
        this.cdr.markForCheck()
    }

    /** Convenience entry point for the "Auto-match (merge)" button. */
    autoMatchMerge (): void { this.autoMatch('merge') }

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

        // "Include LLDP links" toggle — when off, devices land as isolated
        // nodes on the canvas and the user wires them up manually. Useful
        // when LLDP discovery is incomplete (some boxes don't speak it) or
        // when the user wants to design the topology from scratch using
        // the discovered devices only as starting inventory.
        if (!this.includeLldpLinks) {
            links = []
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
