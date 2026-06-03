import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, OnDestroy, OnInit, Output,
} from '@angular/core'
import { TopologyService } from '../services/topology.service'
import {
    TOPOLOGY_TEMPLATES, TopologyTemplate, TemplateCategory,
    DEFAULT_PORTS, TemplateNodeDef, TemplateLinkDef, NodePort,
} from '../api/interfaces'
import { buildVendorStartupConfig, VendorConfigContext, BgpNeighbor, OspfInterface, IsisInterface } from '../services/vendor-config-builder'

type FilterTab = 'all' | TemplateCategory

@Component({
    selector: 'topology-templates',
    templateUrl: './templates.component.pug',
    styleUrls: ['./templates.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesComponent implements OnInit, OnDestroy {

    @Output() closed = new EventEmitter<void>()
    @Output() switchToBuilder = new EventEmitter<void>()
    @Output() deployRequested = new EventEmitter<void>()

    readonly allTemplates = TOPOLOGY_TEMPLATES
    hovered: string | null = null
    activeFilter: FilterTab = 'all'
    searchQuery = ''

    private _hoverTimer: any
    private _api = (window as any).netopsAPI

    /** R3: User-saved templates persisted under prefs key 'user-topology-templates'.
     *  Merged with built-ins via `userAndAllTemplates`. Loaded in ngOnInit. */
    userTemplates: TopologyTemplate[] = []

    /** R3: Last 5 template IDs the user loaded, newest-first. Persisted under
     *  prefs key 'recently-used-templates'. Surfaced as a Recents strip
     *  above the main grid when no search/filter is active. */
    recentTemplateIds: string[] = []

    /** Save-as-template dialog state. */
    showSaveDialog = false
    saveDialogName = ''
    saveDialogDescription = ''
    saveDialogCategory: TemplateCategory = 'general'
    saveDialogIcon = '📐'
    saveDialogError = ''
    /** When set, the save dialog is editing an existing user template
     *  rather than capturing the current topology. */
    private _editingUserTemplateId: string | null = null

    // ── Memoization caches (R1.1 + R1.2) ────────────────────────────────────
    // The templates getter + countFor used to run the full filter pipeline on
    // every change-detection cycle — 13 invocations per render (one per tab
    // plus the visible grid), each iterating all 172 templates. Caches keyed
    // on (searchQuery, activeFilter) so the work happens once per state change.
    private _filterCacheKey = ''
    private _filteredCache: TopologyTemplate[] = []
    private _searchFilteredCache: TopologyTemplate[] = []   // search applied, no category filter
    private _countCacheKey = ''
    private _countCache: Map<FilterTab, number> = new Map()

    /** Build the searchable haystack for one template. Extended in R1.3 to
     *  include node-level model / role / switchFamily / label so that searching
     *  for a model like "QFX5120" or role like "spine-leaf" hits templates
     *  that use those only at the node level. */
    private _haystackFor (t: TopologyTemplate): string {
        const nodeBits: string[] = []
        for (const n of t.nodes) {
            if (n.vendor)       { nodeBits.push(n.vendor) }
            if (n.model)        { nodeBits.push(n.model) }
            if (n.role)         { nodeBits.push(n.role) }
            if (n.switchFamily) { nodeBits.push(n.switchFamily) }
            if (n.label)        { nodeBits.push(n.label) }
        }
        // tags joined too so a multi-category template can be searched by any tag.
        const tagBits = (t.tags ?? []).join(' ')
        // VRF metadata: name, id, RD, RT, VNI (DC + interconnect) + interco
        // domain-id. Lets an operator find a stitching template by typing
        // "70104", "T5-VRF-A", "target:1:80104", etc.
        const vrfBits: string[] = []
        for (const v of (t.vrfs ?? [])) {
            if (v.id)                vrfBits.push(v.id)
            if (v.name)              vrfBits.push(v.name)
            if (v.routeDistinguisher) vrfBits.push(v.routeDistinguisher)
            if (v.vrfTarget)         vrfBits.push(v.vrfTarget)
            if (v.routingVni)        vrfBits.push(String(v.routingVni))
            if (v.domainId)          vrfBits.push(v.domainId)
            if (v.interconnect?.routingVni) vrfBits.push(String(v.interconnect.routingVni))
            if (v.interconnect?.vrfTarget)  vrfBits.push(v.interconnect.vrfTarget)
            if (v.interconnect?.domainId)   vrfBits.push(v.interconnect.domainId)
        }
        return `${t.name} ${t.description} ${t.category} ${t.id} ${tagBits} ${nodeBits.join(' ')} ${vrfBits.join(' ')}`.toLowerCase()
    }

    constructor (
        private svc: TopologyService,
        private cdr: ChangeDetectorRef,
    ) {}

    readonly filterTabs: { id: FilterTab; label: string }[] = [
        { id: 'all',              label: 'All' },
        { id: 'general',          label: 'General' },
        { id: 'datacenter',       label: 'Datacenter' },
        { id: 'enterprise',       label: 'Enterprise' },
        { id: 'service-provider', label: 'Service Provider' },
        { id: 'dci',              label: 'DCI' },
        { id: 'ipv6',             label: 'IPv6' },
        { id: 'segment-routing',  label: 'Segment Routing' },
        { id: 'routing',          label: 'Routing' },
        { id: 'security',         label: 'Security' },
        { id: 'wan',              label: 'WAN' },
        { id: 'multi-vendor',     label: 'Multi-Vendor' },
    ]


    /** Memoized: filtered template list for the active filter + search query.
     *  Recomputes only when the (searchQuery, activeFilter) tuple changes. */
    get templates (): TopologyTemplate[] {
        const key = `${this.searchQuery.trim().toLowerCase()}|${this.activeFilter}`
        if (this._filterCacheKey === key) { return this._filteredCache }

        // Apply search first so the cache helper for countFor can reuse it.
        const q = this.searchQuery.trim().toLowerCase()
        const searchFiltered = q
            ? this.userAndAllTemplates.filter(t => this._haystackFor(t).includes(q))
            : this.userAndAllTemplates
        this._searchFilteredCache = searchFiltered

        // Then category.
        const result = this.activeFilter === 'all'
            ? searchFiltered
            : searchFiltered.filter(t => t.category === this.activeFilter || (t.tags ?? []).includes(this.activeFilter))
        this._filterCacheKey = key
        this._filteredCache = result
        // Counts depend on the same search-filtered list — invalidate.
        this._countCacheKey = ''
        return result
    }

    setFilter (f: FilterTab): void { this.activeFilter = f }

    onSearchChange (): void { /* triggers getter re-evaluation via change detection */ }

    clearSearch (): void { this.searchQuery = '' }

    /** Memoized per-tab count. Pre-computes all tabs on first call per search
     *  state so we don't iterate the full template list once per tab. */
    countFor (f: FilterTab): number {
        const searchKey = this.searchQuery.trim().toLowerCase()
        if (this._countCacheKey !== searchKey) {
            // Make sure the search-filtered cache is fresh — accessing the
            // templates getter populates _searchFilteredCache as a side-effect.
            const _ = this.templates  // eslint-disable-line @typescript-eslint/no-unused-vars
            const list = this._searchFilteredCache
            this._countCache.clear()
            this._countCache.set('all', list.length)
            for (const t of list) {
                this._countCache.set(t.category, (this._countCache.get(t.category) ?? 0) + 1)
                for (const tag of (t.tags ?? [])) {
                    // tags vs categories sit in the same FilterTab union, so
                    // a tag matching a known tab boosts that tab's count.
                    this._countCache.set(tag as FilterTab, (this._countCache.get(tag as FilterTab) ?? 0) + 1)
                }
            }
            this._countCacheKey = searchKey
        }
        return this._countCache.get(f) ?? 0
    }

    /** R3: replace-topology confirm now reports the cost — node count, link
     *  count, annotations, and how many nodes carry a manual / pulled startup
     *  config that would be discarded. */
    private _confirmReplaceMessage (newTpl: TopologyTemplate): string {
        const t = this.svc.topology
        const nodeCount = t.nodes.length
        const linkCount = t.links.length
        const annoCount = (t.annotations ?? []).length
        const manualConfigCount = t.nodes.filter(n =>
            (n as any).configSource === 'manual' || (n as any).configSource === 'pulled',
        ).length
        const bits = [
            `${nodeCount} node${nodeCount === 1 ? '' : 's'}`,
            `${linkCount} link${linkCount === 1 ? '' : 's'}`,
        ]
        if (annoCount > 0)         { bits.push(`${annoCount} annotation${annoCount === 1 ? '' : 's'}`) }
        if (manualConfigCount > 0) { bits.push(`${manualConfigCount} manual/pulled config${manualConfigCount === 1 ? '' : 's'}`) }
        return `Replace the current topology with "${newTpl.name}"?\n\n` +
               `This will discard:\n  • ${bits.join('\n  • ')}\n\n` +
               `Continue?`
    }

    load (tpl: TopologyTemplate): void {
        const hasNodes = this.svc.topology.nodes.length > 0
        if (hasNodes && !confirm(this._confirmReplaceMessage(tpl))) { return }
        this.svc.loadTemplate(tpl)
        this._trackRecent(tpl.id)
        this.closed.emit()
    }

    deployLab (tpl: TopologyTemplate, $event: Event): void {
        $event.stopPropagation()
        if (!confirm(`Deploy "${tpl.name}" as a containerlab lab? This will load the template and start deployment.`)) { return }
        this.svc.loadTemplate(tpl)
        this._trackRecent(tpl.id)
        this.closed.emit()
        this.deployRequested.emit()
    }

    // ── R3: Save / Fork / Delete user templates ─────────────────────────────

    /** Open the save dialog capturing the CURRENT canvas as a new user template.
     *  No template loaded; this snapshots whatever the user has built. */
    openSaveCurrentDialog (): void {
        if (this.svc.topology.nodes.length === 0) {
            window.alert('Nothing on the canvas to save — add at least one node first.')
            return
        }
        this._editingUserTemplateId = null
        this.saveDialogName = this.svc.topology.name || 'My Template'
        this.saveDialogDescription = this.svc.topology.description || ''
        this.saveDialogCategory = 'general'
        this.saveDialogIcon = '📐'
        this.saveDialogError = ''
        this.showSaveDialog = true
        this.cdr.markForCheck()
    }

    /** Fork: load the template, then immediately open the save dialog so the
     *  user can save edits-as-a-new template after tweaking. Implemented by
     *  loading the template and emitting `switchToBuilder` so the user lands
     *  in the builder with the forked content. The save action is then a
     *  separate explicit "Save current as template" from the Templates dialog
     *  next time they open it. */
    forkTemplate (tpl: TopologyTemplate, $event: Event): void {
        $event.stopPropagation()
        const hasNodes = this.svc.topology.nodes.length > 0
        if (hasNodes && !confirm(this._confirmReplaceMessage(tpl))) { return }
        this.svc.loadTemplate(tpl)
        this._trackRecent(tpl.id)
        // Append " (copy)" to the topology name as a hint that this is a derivative.
        try { (this.svc as any).rename?.(`${tpl.name} (copy)`) } catch { /* ignore */ }
        this.closed.emit()
        this.switchToBuilder.emit()
    }

    cancelSaveDialog (): void {
        this.showSaveDialog = false
        this._editingUserTemplateId = null
        this.saveDialogError = ''
        this.cdr.markForCheck()
    }

    confirmSaveDialog (): void {
        const name = this.saveDialogName.trim()
        if (!name) { this.saveDialogError = 'Name is required'; this.cdr.markForCheck(); return }
        // Reject duplicate user-template names so the catalog list stays
        // readable (built-ins are exempted because they can't be renamed).
        const dupe = this.userTemplates.some(t =>
            t.id !== this._editingUserTemplateId &&
            t.name.toLowerCase() === name.toLowerCase(),
        )
        if (dupe) { this.saveDialogError = `A user template named "${name}" already exists`; this.cdr.markForCheck(); return }

        const snapshot = this._buildTemplateFromTopology(name)
        if (this._editingUserTemplateId) {
            this.userTemplates = this.userTemplates.map(t =>
                t.id === this._editingUserTemplateId
                    ? { ...t, ...snapshot, id: t.id, createdAt: t.createdAt, updatedAt: new Date().toISOString() }
                    : t,
            )
        } else {
            this.userTemplates = [snapshot, ...this.userTemplates]
        }
        this._persistUserTemplates()
        this._invalidateCaches()
        this.showSaveDialog = false
        this._editingUserTemplateId = null
        this.cdr.markForCheck()
    }

    deleteUserTemplate (tpl: TopologyTemplate, $event: Event): void {
        $event.stopPropagation()
        if (!tpl.userCreated) { return }
        if (!confirm(`Delete saved template "${tpl.name}"? This cannot be undone.`)) { return }
        this.userTemplates = this.userTemplates.filter(t => t.id !== tpl.id)
        this.recentTemplateIds = this.recentTemplateIds.filter(id => id !== tpl.id)
        this._persistUserTemplates()
        this._persistRecents()
        this._invalidateCaches()
        this.cdr.markForCheck()
    }

    /** Capture the current `TopologyService.topology` as a TopologyTemplate.
     *  Strips runtime state (status, mapped, alarms) and node IDs (templates
     *  use array indices). */
    private _buildTemplateFromTopology (name: string): TopologyTemplate {
        const t = this.svc.topology
        const idIndex = new Map<string, number>()
        t.nodes.forEach((n, i) => idIndex.set(n.id, i))

        const nodeDefs: TemplateNodeDef[] = t.nodes.map(n => {
            const def: TemplateNodeDef = {
                type: n.type,
                label: n.label,
                x: n.x,
                y: n.y,
                vendor: n.vendor,
                model: n.model,
                switchFamily: n.switchFamily,
                mgmtIp: n.mgmtIp,
                loopbackIp: n.loopbackIp,
                loopbackIpv6: n.loopbackIpv6,
                vlans: n.vlans ? n.vlans.map(v => ({ ...v })) : undefined,
                ports: n.ports.map(p => ({ ...p })),
                asn: n.asn,
                role: n.role,
                ospfArea: n.ospfArea,
                isisLevel: n.isisLevel,
                nodeSid: n.nodeSid,
                srgbStart: (n as any).srgbStart,
                srgbEnd:   (n as any).srgbEnd,
                srv6Locator: (n as any).srv6Locator,
                mplsLdp: (n as any).mplsLdp,
                description: n.description,
                image: (n as any).image,
            }
            // Per-node staging override (deep-copied).
            const staging = (n as any).staging
            if (staging) { (def as any).staging = JSON.parse(JSON.stringify(staging)) }
            return def
        })

        const linkDefs: TemplateLinkDef[] = t.links.flatMap(l => {
            const s = idIndex.get(l.sourceNodeId)
            const tgt = idIndex.get(l.targetNodeId)
            if (s == null || tgt == null) { return [] }
            return [{ sourceNode: s, sourcePort: l.sourcePortId, targetNode: tgt, targetPort: l.targetPortId }]
        })

        const now = new Date().toISOString()
        const hasVendor = nodeDefs.some(n => !!n.vendor)
        const fabric = (t as any).staging
        return {
            id: `user-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
            name,
            description: this.saveDialogDescription.trim(),
            icon: this.saveDialogIcon || (hasVendor ? '🐳' : '📐'),
            category: this.saveDialogCategory,
            nodes: nodeDefs,
            links: linkDefs,
            underlayProtocol: t.underlayProtocol,
            overlayEnabled: t.overlayEnabled,
            vniBase: t.vniBase,
            irbEnabled: t.irbEnabled,
            irbGatewayBase: t.irbGatewayBase,
            irbMode: t.irbMode,
            oismEnabled: t.oismEnabled,
            macVrfEnabled: t.macVrfEnabled,
            telemetryEnabled: t.telemetryEnabled,
            kind: hasVendor ? 'container' : 'design',
            createdAt: now,
            updatedAt: now,
            userCreated: true,
            ...(fabric ? { staging: JSON.parse(JSON.stringify(fabric)) } : {}),
            ...(t.annotations?.length ? { annotations: t.annotations.map(a => ({ ...a })) } : {}),
            // Preserve VRF definitions across fork → save (RLI 52387). Deep-
            // cloned because VrfDefinition has nested arrays (memberNodes,
            // interconnectNodes) and an inline interconnect{} object — a
            // shallow .map would share those references with the live topology.
            ...((t as any).vrfs?.length ? { vrfs: JSON.parse(JSON.stringify((t as any).vrfs)) } : {}),
        }
    }

    close (): void { this.closed.emit() }

    trackById (_index: number, tpl: TopologyTemplate): string { return tpl.id }

    onHover (id: string): void {
        clearTimeout(this._hoverTimer)
        this._hoverTimer = setTimeout(() => {
            this.hovered = id
            this.cdr.markForCheck()
        }, 150)
    }

    onLeave (): void {
        clearTimeout(this._hoverTimer)
        this.hovered = null
    }

    async ngOnInit (): Promise<void> {
        // Load user templates + recents from prefs before first render so they
        // show up immediately in the catalog (no flash-of-builtins-only).
        try {
            const saved = await this._api?.prefGet?.('user-topology-templates')
            if (Array.isArray(saved)) {
                this.userTemplates = saved.map(t => ({ ...t, userCreated: true }))
            }
            const recents = await this._api?.prefGet?.('recently-used-templates')
            if (Array.isArray(recents)) {
                this.recentTemplateIds = recents.filter(x => typeof x === 'string').slice(0, 5)
            }
        } catch { /* prefs unavailable — start with empty lists */ }
        this._invalidateCaches()
        this.cdr.markForCheck()
    }

    ngOnDestroy (): void {
        clearTimeout(this._hoverTimer)
    }

    /** Built-ins + user templates, user-first so they appear at the top of
     *  the relevant category. */
    get userAndAllTemplates (): TopologyTemplate[] {
        return this.userTemplates.length
            ? [...this.userTemplates, ...this.allTemplates]
            : this.allTemplates
    }

    /** Recently used templates, oldest filtered out. Shown only on the All
     *  filter with an empty search query — so users see them as a quick-launch
     *  strip, not interleaved with active filter results. */
    get recentTemplates (): TopologyTemplate[] {
        if (this.searchQuery.trim() || this.activeFilter !== 'all') { return [] }
        const byId = new Map(this.userAndAllTemplates.map(t => [t.id, t]))
        return this.recentTemplateIds
            .map(id => byId.get(id))
            .filter((t): t is TopologyTemplate => !!t)
            .slice(0, 5)
    }

    private _persistRecents (): void {
        try { this._api?.prefSet?.('recently-used-templates', this.recentTemplateIds) } catch { /* ignore */ }
    }

    private _persistUserTemplates (): void {
        try { this._api?.prefSet?.('user-topology-templates', this.userTemplates) } catch { /* ignore */ }
    }

    private _trackRecent (id: string): void {
        this.recentTemplateIds = [id, ...this.recentTemplateIds.filter(x => x !== id)].slice(0, 5)
        this._persistRecents()
    }

    private _invalidateCaches (): void {
        this._filterCacheKey = ''
        this._countCacheKey = ''
    }

    openBuilder (): void {
        this.closed.emit()
        this.switchToBuilder.emit()
    }

    /** True when the template is a container-deployable (clab) lab.
     *  Honors the explicit `kind` field added in R1.3; falls back to the
     *  legacy hasVendorNodes heuristic for the ~170 built-in templates
     *  that pre-date the field. */
    hasVendorNodes (tpl: TopologyTemplate): boolean {
        if (tpl.kind === 'container' || tpl.kind === 'hybrid') { return true }
        if (tpl.kind === 'design') { return false }
        return tpl.nodes.some(n => !!n.vendor)
    }

    /** Short label for the card type-badge. R1.3 promotes `hybrid` to its own
     *  badge so users see it as distinct from container-only templates. */
    templateKindLabel (tpl: TopologyTemplate): string {
        if (tpl.kind === 'hybrid')                                       { return '🪢 Hybrid' }
        if (tpl.kind === 'design' || !this.hasVendorNodes(tpl))          { return '📐 Design' }
        return '🐳 Container'
    }

    /** Return the primary vendor(s) used in a template, e.g. "SONiC" or "Juniper · Arista" */
    vendorLabel (tpl: TopologyTemplate): string {
        const vendors = new Set<string>()
        for (const n of tpl.nodes) {
            if (n.vendor) { vendors.add(n.vendor) }
        }
        if (!vendors.size) { return '' }
        const arr = [...vendors]
        return arr.length <= 2 ? arr.join(' · ') : `${arr[0]} +${arr.length - 1}`
    }

    /** Generate and download all startup configs for vendor-configured nodes */
    downloadConfig (tpl: TopologyTemplate, $event: Event): void {
        $event.stopPropagation()

        const sections: string[] = []
        const divider = '!' + '='.repeat(70)

        sections.push(divider)
        sections.push(`! Template : ${tpl.name}`)
        sections.push(`! Category : ${tpl.category}`)
        sections.push(`! Nodes    : ${tpl.nodes.length}   Links: ${tpl.links.length}`)
        sections.push(divider)
        sections.push('')

        const isIbgpRr = tpl.underlayProtocol === 'ibgp-rr'
        const vniBase = tpl.vniBase ?? 10000

        // Pre-compute overlay neighbor lists (loopback IPs by role)
        const spineLoopbacks: string[] = []
        const leafLoopbacks: string[] = []
        for (const n of tpl.nodes) {
            const loopIp = n.loopbackIp?.split('/')[0] ?? ''
            if (!loopIp || n.asn == null) { continue }
            if (n.role === 'spine' || n.role === 'super-spine') {
                spineLoopbacks.push(loopIp)
            } else if (n.role === 'leaf' || n.role === 'border-leaf' || n.role === 'tor') {
                leafLoopbacks.push(loopIp)
            }
        }

        // Pre-compute per-node BGP neighbors from links (with iBGP-RR loopback peering)
        const bgpNeighborMap = new Map<number, BgpNeighbor[]>()
        for (const link of tpl.links) {
            const srcDef = tpl.nodes[link.sourceNode]
            const tgtDef = tpl.nodes[link.targetNode]
            if (!srcDef || !tgtDef) { continue }

            const srcPorts = srcDef.ports ?? DEFAULT_PORTS[srcDef.type] ?? []
            const tgtPorts = tgtDef.ports ?? DEFAULT_PORTS[tgtDef.type] ?? []
            const srcPort = srcPorts.find(p => p.id === link.sourcePort)
            const tgtPort = tgtPorts.find(p => p.id === link.targetPort)
            if (!srcPort?.ipAddress || !tgtPort?.ipAddress) { continue }

            const srcIp = srcPort.ipAddress.split('/')[0]
            const tgtIp = tgtPort.ipAddress.split('/')[0]

            if (srcDef.asn != null && tgtDef.asn != null) {
                const sameAsn = srcDef.asn === tgtDef.asn
                const useLoopback = isIbgpRr && sameAsn
                const srcLoopback = srcDef.loopbackIp?.split('/')[0]
                const tgtLoopback = tgtDef.loopbackIp?.split('/')[0]

                const neighborIpForSrc = useLoopback && tgtLoopback ? tgtLoopback : tgtIp
                const neighborIpForTgt = useLoopback && srcLoopback ? srcLoopback : srcIp

                if (!bgpNeighborMap.has(link.sourceNode)) { bgpNeighborMap.set(link.sourceNode, []) }
                const srcList = bgpNeighborMap.get(link.sourceNode)!
                if (!srcList.some(nb => nb.ip === neighborIpForSrc)) {
                    srcList.push({ ip: neighborIpForSrc, peerAsn: tgtDef.asn, portLabel: srcPort.label, peerHostname: tgtDef.label })
                }

                if (!bgpNeighborMap.has(link.targetNode)) { bgpNeighborMap.set(link.targetNode, []) }
                const tgtList = bgpNeighborMap.get(link.targetNode)!
                if (!tgtList.some(nb => nb.ip === neighborIpForTgt)) {
                    tgtList.push({ ip: neighborIpForTgt, peerAsn: srcDef.asn, portLabel: tgtPort.label, peerHostname: srcDef.label })
                }
            }
        }

        // Pre-compute per-node OSPF interface list from links
        const ospfInterfaceMap = new Map<number, OspfInterface[]>()
        for (const link of tpl.links) {
            const srcDef = tpl.nodes[link.sourceNode]
            const tgtDef = tpl.nodes[link.targetNode]
            if (!srcDef || !tgtDef) { continue }
            if (srcDef.ospfArea == null && tgtDef.ospfArea == null) { continue }

            const srcPorts = srcDef.ports ?? DEFAULT_PORTS[srcDef.type] ?? []
            const tgtPorts = tgtDef.ports ?? DEFAULT_PORTS[tgtDef.type] ?? []
            const srcPort = srcPorts.find(p => p.id === link.sourcePort)
            const tgtPort = tgtPorts.find(p => p.id === link.targetPort)
            if (!srcPort?.ipAddress || !tgtPort?.ipAddress) { continue }

            const srcArea = srcDef.ospfArea ?? 0
            const tgtArea = tgtDef.ospfArea ?? 0
            const linkArea = srcArea === tgtArea ? srcArea : Math.max(srcArea, tgtArea)

            if (!ospfInterfaceMap.has(link.sourceNode)) { ospfInterfaceMap.set(link.sourceNode, []) }
            ospfInterfaceMap.get(link.sourceNode)!.push({ portLabel: srcPort.label, area: linkArea })
            if (!ospfInterfaceMap.has(link.targetNode)) { ospfInterfaceMap.set(link.targetNode, []) }
            ospfInterfaceMap.get(link.targetNode)!.push({ portLabel: tgtPort.label, area: linkArea })
        }

        // Pre-compute per-node IS-IS interface list from links
        const isisInterfaceMap = new Map<number, IsisInterface[]>()
        for (const link of tpl.links) {
            const srcDef = tpl.nodes[link.sourceNode]
            const tgtDef = tpl.nodes[link.targetNode]
            if (!srcDef || !tgtDef) { continue }
            if (srcDef.isisLevel == null && tgtDef.isisLevel == null) { continue }

            const srcPorts = srcDef.ports ?? DEFAULT_PORTS[srcDef.type] ?? []
            const tgtPorts = tgtDef.ports ?? DEFAULT_PORTS[tgtDef.type] ?? []
            const srcPort = srcPorts.find(p => p.id === link.sourcePort)
            const tgtPort = tgtPorts.find(p => p.id === link.targetPort)
            if (!srcPort?.ipAddress || !tgtPort?.ipAddress) { continue }

            const srcLevel = srcDef.isisLevel ?? 2
            const tgtLevel = tgtDef.isisLevel ?? 2

            if (!isisInterfaceMap.has(link.sourceNode)) { isisInterfaceMap.set(link.sourceNode, []) }
            isisInterfaceMap.get(link.sourceNode)!.push({ portLabel: srcPort.label, level: srcLevel as 1 | 2 | 12 })
            if (!isisInterfaceMap.has(link.targetNode)) { isisInterfaceMap.set(link.targetNode, []) }
            isisInterfaceMap.get(link.targetNode)!.push({ portLabel: tgtPort.label, level: tgtLevel as 1 | 2 | 12 })
        }

        for (let nodeIdx = 0; nodeIdx < tpl.nodes.length; nodeIdx++) {
            const def = tpl.nodes[nodeIdx]
            if (!def.vendor) { continue }

            const ports = def.ports ?? DEFAULT_PORTS[def.type] ?? []
            const loopIp = def.loopbackIp?.split('/')[0] ?? ''
            const isSpine = def.role === 'spine' || def.role === 'super-spine'
            const hasAsn = def.asn != null
            const hasVlans = (def.vlans?.length ?? 0) > 0
            const overlay = tpl.overlayEnabled && hasAsn ? (isSpine || hasVlans) : false

            // Build IS-IS NET address from loopback IP
            let isisNet: string | undefined
            if (def.isisLevel != null && loopIp) {
                const parts = loopIp.split('.').map(Number)
                if (parts.length === 4 && parts.every(p => Number.isFinite(p))) {
                    const padded = parts.map(p => String(p).padStart(3, '0')).join('')
                    isisNet = `49.0001.${padded.slice(0, 4)}.${padded.slice(4, 8)}.${padded.slice(8, 12)}.00`
                }
            }

            const isisIfaces = isisInterfaceMap.get(nodeIdx) ?? []

            const ctx: VendorConfigContext = {
                nodeType: def.type,
                hostname: def.label,
                mgmtIp:  def.mgmtIp ?? '',
                loopbackIp: def.loopbackIp ?? '',
                loopbackIpv6: def.loopbackIpv6 ?? '',
                sshUsername: '',
                model: def.model ?? '',
                switchFamily: (def.switchFamily ?? '') as any,
                vlans: def.vlans ?? [],
                asn: def.asn,
                routerId: loopIp || undefined,
                bgpNeighbors: bgpNeighborMap.get(nodeIdx) ?? [],
                underlayProtocol: tpl.underlayProtocol,
                isRouteReflector: isIbgpRr && isSpine,
                overlayEnabled: overlay,
                overlayNeighbors: isSpine ? leafLoopbacks.filter(ip => ip !== loopIp) : spineLoopbacks.filter(ip => ip !== loopIp),
                vniMappings: isSpine
                    ? []
                    : (def.vlans ?? [])
                        .filter(v => v.id >= 100 && v.id < 4000)
                        .map(v => ({ vlanId: v.id, vni: vniBase + v.id, vlanName: v.name })),
                vtepSourceIp: isSpine ? undefined : (loopIp || undefined),
                nodeRole: def.role,
                irbEnabled: tpl.irbEnabled,
                irbGatewayBase: tpl.irbGatewayBase,
                irbMode: tpl.irbMode,
                oismEnabled: tpl.oismEnabled,
                macVrfEnabled: tpl.macVrfEnabled,
                telemetryEnabled: false,
                ospfInterfaces: ospfInterfaceMap.get(nodeIdx) ?? [],
                ospfArea: def.ospfArea,
                nodeSid: def.nodeSid,
                srgbStart: def.srgbStart,
                srgbEnd: def.srgbEnd,
                srv6Locator: def.srv6Locator,
                mplsLdp: def.mplsLdp,
                mplsInterfaces: isisIfaces.map(i => i.portLabel),
                isisInterfaces: isisIfaces,
                isisLevel: def.isisLevel as 1 | 2 | 12 | undefined,
                isisNet,
            }

            const cfg = buildVendorStartupConfig(def.vendor, ports, ctx)

            sections.push(`! --- ${def.label} (${def.model || def.vendor}) ---`)
            sections.push('')
            sections.push(cfg)
            sections.push('')
        }

        // Append troubleshooting guide
        const tsGuide = this.generateTroubleshootingGuide(tpl)
        if (tsGuide) {
            sections.push('')
            sections.push(tsGuide)
        }

        const blob = new Blob([sections.join('\n')], { type: 'text/plain' })
        const url  = URL.createObjectURL(blob)
        const a    = document.createElement('a')
        a.href     = url
        a.download = `${tpl.id}-configs.txt`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    /** Generate Juniper troubleshooting guide based on template features */
    private generateTroubleshootingGuide (tpl: TopologyTemplate): string {
        const hasJuniper = tpl.nodes.some(n => n.vendor === 'Juniper')
        if (!hasJuniper) { return '' }

        const hasBgp = tpl.nodes.some(n => n.asn)
        const hasEvpn = tpl.overlayEnabled === true
        const hasIrb = tpl.irbEnabled === true
        const hasVlans = tpl.nodes.some(n => n.vlans && n.vlans.length > 0)
        const hasMpls = tpl.nodes.some(n => n.mplsLdp === true)
        const hasOspf = tpl.underlayProtocol === 'ospf' || tpl.underlayProtocol === 'ospfv3'
        const hasIsis = tpl.underlayProtocol === 'isis'
        const hasL2Ports = tpl.nodes.some(n => {
            const ports: NodePort[] = n.ports ?? DEFAULT_PORTS[n.type] ?? []
            return ports.some(p => p.vlanMode === 'trunk' || p.vlanMode === 'access')
        })
        const hasSrx = tpl.nodes.some(n => n.switchFamily === 'SRX')
        const hasEsiLag = tpl.id.includes('esi-lag')
        const hasBorderLeaf = tpl.nodes.some(n => n.role === 'border-leaf')

        const d = '!' + '='.repeat(70)
        const lines: string[] = []

        lines.push(d)
        lines.push('! JUNIPER TROUBLESHOOTING GUIDE')
        lines.push(`! Template: ${tpl.name}`)
        lines.push(d)
        lines.push('')

        // ── 1. Basic Verification ──
        lines.push('! ── 1. BASIC SYSTEM VERIFICATION ──────────────────────────────────')
        lines.push('!')
        lines.push('! Check system health and commit status:')
        lines.push('!   show system alarms')
        lines.push('!   show chassis alarms')
        lines.push('!   show system commit')
        lines.push('!   show system uptime')
        lines.push('!   show version')
        lines.push('!')
        lines.push('! Verify configuration was applied cleanly:')
        lines.push('!   show configuration | compare rollback 1')
        lines.push('!   show system commit')
        lines.push('!')
        lines.push('! Check interface status:')
        lines.push('!   show interfaces terse')
        lines.push('!   show interfaces extensive | match "error|CRC|loss"')
        lines.push('!')
        lines.push('! Verify LLDP neighbors match expected topology:')
        lines.push('!   show lldp neighbors')
        lines.push('!')
        lines.push('! Check management VRF connectivity:')
        lines.push('!   ping routing-instance mgmt_junos 10.0.0.254')
        lines.push('!')
        lines.push('! Verify NTP sync:')
        lines.push('!   show ntp associations')
        lines.push('!   show ntp status')
        lines.push('')

        // ── 2. BGP Troubleshooting ──
        if (hasBgp) {
            lines.push('! ── 2. BGP UNDERLAY TROUBLESHOOTING ──────────────────────────────')
            lines.push('!')
            lines.push('! Step 1 — Verify all BGP sessions are Established:')
            lines.push('!   show bgp summary')
            lines.push('!   show bgp neighbor | match "Peer|State|flap"')
            lines.push('!')
            lines.push('! Step 2 — If session is not Established, check:')
            lines.push('!   show bgp neighbor <peer-ip> | match "Last error|State|hold"')
            lines.push('!   show route <peer-ip> (can you reach the peer?)')
            lines.push('!   ping <peer-ip> source <local-ip> (L3 reachability)')
            lines.push('!')
            lines.push('! Step 3 — Verify routes are being advertised/received:')
            lines.push('!   show route advertising-protocol bgp <peer-ip>')
            lines.push('!   show route receive-protocol bgp <peer-ip>')
            lines.push('!   show route protocol bgp')
            lines.push('!')
            lines.push('! Step 4 — Check ECMP multipath:')
            lines.push('!   show route <destination> detail | match "next-hop|via"')
            lines.push('!   show route forwarding-table destination <ip>')
            lines.push('!')
            lines.push('! Step 5 — Verify BFD sessions:')
            lines.push('!   show bfd session')
            lines.push('!   show bfd session detail | match "State|Interval|Multiplier"')
            lines.push('!')
            lines.push('! Step 6 — Check export policy:')
            lines.push('!   show policy EXPORT-LOOPBACK')
            lines.push('!   test policy EXPORT-LOOPBACK <prefix>')
            lines.push('!')
            lines.push('! Common BGP problems and fixes:')
            lines.push('!   - "OpenSent" state → TCP can reach peer but AS/config mismatch')
            lines.push('!   - "Active" state → TCP cannot reach peer (check interface/route)')
            lines.push('!   - "Idle" state → BGP disabled or hold timer expired too many times')
            lines.push('!   - No routes received → check export policy on remote peer')
            lines.push('!   - Flapping → check BFD timers, interface errors, MTU mismatch')
            lines.push('')
        }

        // ── 3. EVPN-VXLAN Troubleshooting ──
        if (hasEvpn) {
            lines.push('! ── 3. EVPN-VXLAN OVERLAY TROUBLESHOOTING ────────────────────────')
            lines.push('!')
            lines.push('! Step 1 — Verify EVPN overlay BGP sessions:')
            lines.push('!   show bgp summary group OVERLAY')
            lines.push('!   show bgp neighbor | match "OVERLAY|State"')
            lines.push('!')
            lines.push('! Step 2 — Check EVPN instance and database:')
            lines.push('!   show evpn instance extensive')
            lines.push('!   show evpn database')
            lines.push('!   show evpn database mac-address <mac>')
            lines.push('!   show evpn database mac-address <mac> extensive')
            lines.push('!')
            lines.push('! Step 3 — Verify VXLAN tunnels and VTEPs:')
            lines.push('!   show ethernet-switching vxlan-tunnel-end-point remote')
            lines.push('!   show ethernet-switching vxlan-tunnel-end-point source')
            lines.push('!   show ethernet-switching vxlan-tunnel-end-point remote summary')
            lines.push('!')
            lines.push('! Step 4 — Check VNI-to-VLAN mapping:')
            lines.push('!   show vlans extensive | match "vlan-id|vxlan-id|vtep"')
            lines.push('!')
            lines.push('! Step 5 — Verify MAC learning and MAC table sync:')
            lines.push('!   show ethernet-switching table')
            lines.push('!   show ethernet-switching table vlan <vlan-name>')
            lines.push('!   show ethernet-switching table extensive')
            lines.push('!   Compare tables across leaves to verify sync')
            lines.push('!')
            lines.push('! Step 6 — Verify MAC-IP bindings:')
            lines.push('!   show ethernet-switching mac-ip-table')
            lines.push('!   show bridge mac-ip-table summary')
            lines.push('!   show bridge mac-ip-table kernel differences')
            lines.push('!   (Detects l2ald vs kernel out-of-sync issues)')
            lines.push('!')
            lines.push('! Step 7 — Debug MAC/MAC-IP context history:')
            lines.push('!   show ethernet-switching context-history mac <mac-addr>')
            lines.push('!   show ethernet-switching context-history mac-ip <mac-addr>')
            lines.push('!   (Shows L2ALD state machine transitions for learning/aging)')
            lines.push('!')
            lines.push('! Step 8 — Verify VTEP source (loopback reachability):')
            lines.push('!   show switch-options')
            lines.push('!   ping <remote-vtep-loopback> source <local-loopback>')
            lines.push('!')
            lines.push('! Step 9 — EVPN route verification:')
            lines.push('!   show evpn route-type 2 (MAC/IP routes)')
            lines.push('!   show evpn route-type 3 (Inclusive Multicast)')
            lines.push('!   show evpn route-type 5 (IP Prefix routes)')
            lines.push('!   show route table <instance>.evpn.0')
            lines.push('!')
            lines.push('! Step 10 — Check DDOS protection (missing MACs in scale):')
            lines.push('!   show ddos-protection protocols vxlan')
            lines.push('!   show ddos-protection protocols arp')
            lines.push('!   show ddos-protection protocols ndpv6')
            lines.push('!   (Look for "Dropped" counters — increase bandwidth if needed)')
            lines.push('!')
            lines.push('! Step 11 — Enable EVPN tracing (for deep debug):')
            lines.push('!   set protocols evpn traceoptions file evpn.log size 50m')
            lines.push('!   set protocols evpn traceoptions flag all')
            lines.push('!   set protocols l2-learning traceoptions file l2ald.log size 50m')
            lines.push('!   set protocols l2-learning traceoptions flag all')
            lines.push('!   set protocols l2-learning traceoptions in-memory-debug')
            lines.push('!')
            lines.push('! Step 12 — Overlay ping/traceroute:')
            lines.push('!   ping overlay mac <mac> bridge-domain <bd> instance <inst>')
            lines.push('!   monitor traffic interface <uplink> matching "udp port 4789"')
            lines.push('!')
            lines.push('! Common EVPN-VXLAN problems and fixes:')
            lines.push('!   - No remote VTEPs → OVERLAY BGP session not Established')
            lines.push('!   - MACs not learned → VNI mismatch or VXLAN tunnel down')
            lines.push('!   - MAC tables out of sync → compare tables across leaves')
            lines.push('!     then check context-history for state machine issues')
            lines.push('!   - MAC-IP out of sync → show bridge mac-ip-table kernel differences')
            lines.push('!   - Missing MACs at scale → check DDOS counters, increase bandwidth')
            lines.push('!   - MTU issues → ensure underlay interfaces have mtu 9192+')
            lines.push('!   - ARP not resolving → check ARP suppression config')
            lines.push('!     show ethernet-switching instance detail | match "suppression"')
            lines.push('')
        }

        // ── 4. IRB / Inter-VLAN Routing ──
        if (hasIrb) {
            lines.push('! ── 4. IRB / INTER-VLAN ROUTING TROUBLESHOOTING ──────────────────')
            lines.push('!')
            lines.push('! Step 1 — Verify IRB interfaces are up:')
            lines.push('!   show interfaces irb terse')
            lines.push('!   show interfaces irb.100 detail')
            lines.push('!')
            lines.push('! Step 2 — Verify anycast gateway MAC is consistent:')
            lines.push('!   show interfaces irb.100 | match "Hardware|Current"')
            lines.push('!   (all leaves should show 00:00:5e:00:01:01)')
            lines.push('!')
            lines.push('! Step 3 — Check EVPN VRF routing table:')
            lines.push('!   show route table EVPN-VRF.inet.0')
            lines.push('!   show route table EVPN-VRF.evpn.0')
            lines.push('!')
            lines.push('! Step 4 — Verify Type-5 prefix routes:')
            lines.push('!   show route table EVPN-VRF.evpn.0 match-prefix "5:*"')
            lines.push('!   show evpn ip-prefix-routes')
            lines.push('!')
            lines.push('! Step 5 — Test end-to-end connectivity:')
            lines.push('!   ping routing-instance EVPN-VRF <server-ip> source <irb-ip>')
            lines.push('!')
            lines.push('! Common IRB problems:')
            lines.push('!   - Servers can ping local gateway but not remote → VRF route missing')
            lines.push('!   - Anycast MAC mismatch → servers see different GW MACs (check irb mac)')
            lines.push('!   - ARP not resolving → check VLAN membership, storm control blocking')
            lines.push('')
        }

        // ── 5. L2 / VLAN Troubleshooting ──
        if (hasL2Ports || hasVlans) {
            lines.push('! ── 5. L2 / VLAN TROUBLESHOOTING ─────────────────────────────────')
            lines.push('!')
            lines.push('! Verify VLAN membership:')
            lines.push('!   show vlans')
            lines.push('!   show vlans extensive | match "name|tag|interface"')
            lines.push('!')
            lines.push('! Check trunk port configuration:')
            lines.push('!   show ethernet-switching interface')
            lines.push('!   show ethernet-switching interface detail')
            lines.push('!')
            lines.push('! Verify MAC address table:')
            lines.push('!   show ethernet-switching table')
            lines.push('!   show ethernet-switching table interface <port>')
            lines.push('!')
            lines.push('! Check storm control:')
            lines.push('!   show forwarding-options storm-control-profiles')
            lines.push('!   show ethernet-switching storm-control interface <port>')
            lines.push('!')
            lines.push('! Check RSTP:')
            lines.push('!   show spanning-tree bridge')
            lines.push('!   show spanning-tree interface')
            lines.push('!')
            lines.push('! Common L2 problems:')
            lines.push('!   - No traffic on trunk → native VLAN mismatch')
            lines.push('!   - Broadcast storm → check storm control, STP convergence')
            lines.push('!   - MAC flapping → duplicate MACs or loop')
            lines.push('')
        }

        // ── 6. ESI-LAG / MC-LAG ──
        if (hasEsiLag) {
            lines.push('! ── 6. ESI-LAG / MULTI-HOMING TROUBLESHOOTING ────────────────────')
            lines.push('!')
            lines.push('! Step 1 — Verify ESI status and membership:')
            lines.push('!   show evpn instance extensive | match "ESI|DF|Designated"')
            lines.push('!   show evpn instance esi <esi-value> extensive')
            lines.push('!   show ethernet-switching vxlan-tunnel-end-point esi')
            lines.push('!')
            lines.push('! Step 2 — Check LAG/ae interface:')
            lines.push('!   show interfaces ae0 terse')
            lines.push('!   show interfaces ae0 extensive')
            lines.push('!   show lacp interfaces ae0')
            lines.push('!   show lacp statistics interfaces ae0')
            lines.push('!')
            lines.push('! Step 3 — Verify Designated Forwarder election:')
            lines.push('!   show evpn instance designated-forwarder')
            lines.push('!   (DF handles BUM traffic — verify correct leaf is elected)')
            lines.push('!')
            lines.push('! Step 4 — Check local bias and load balancing:')
            lines.push('!   show evpn instance esi <esi> local-bias')
            lines.push('!   show route forwarding-table family ethernet-switching')
            lines.push('!   (Verify BUM traffic is not looping back to same ESI)')
            lines.push('!')
            lines.push('! Step 5 — Verify ESI MAC learning:')
            lines.push('!   show ethernet-switching table | match "esi"')
            lines.push('!   show ethernet-switching context-history mac <mac>')
            lines.push('!   (Check if MAC moves between SH↔MH correctly)')
            lines.push('!')
            lines.push('! Step 6 — ESI link down/up recovery:')
            lines.push('!   show evpn instance esi <esi> extensive')
            lines.push('!   (After ESI member link down, verify MACs move to remote)')
            lines.push('!   (After ESI member link up, verify MACs re-learn locally)')
            lines.push('!')
            lines.push('! Step 7 — Core isolation detection:')
            lines.push('!   show evpn instance extensive | match "core-isolation"')
            lines.push('!   (If all uplinks fail, leaf should isolate to prevent blackhole)')
            lines.push('!')
            lines.push('! Common ESI-LAG problems and fixes:')
            lines.push('!   - Server only receives traffic from one leaf → DF election issue')
            lines.push('!   - LACP not forming → check system-id, ae config on both leaves')
            lines.push('!   - Split-brain → ESI value mismatch between leaf pair')
            lines.push('!   - BUM traffic loop → check local-bias, DF filtering')
            lines.push('!   - MAC move SH→MH → verify proxy MAC generation (21.3+)')
            lines.push('!   - Traffic blackhole after link down → check core isolation')
            lines.push('')
        }

        // ── 7. OSPF Troubleshooting ──
        if (hasOspf) {
            lines.push('! ── 7. OSPF UNDERLAY TROUBLESHOOTING ─────────────────────────────')
            lines.push('!')
            lines.push('! Check OSPF neighbors:')
            lines.push('!   show ospf neighbor')
            lines.push('!   show ospf neighbor extensive')
            lines.push('!')
            lines.push('! Verify OSPF interfaces:')
            lines.push('!   show ospf interface')
            lines.push('!   show ospf interface detail')
            lines.push('!')
            lines.push('! Check OSPF database:')
            lines.push('!   show ospf database')
            lines.push('!   show ospf route')
            lines.push('!')
            lines.push('! Common OSPF problems:')
            lines.push('!   - Neighbor stuck in ExStart → MTU mismatch')
            lines.push('!   - Neighbor stuck in 2-Way → DR/BDR election issue (P2P recommended)')
            lines.push('!   - Routes missing → check area configuration, stub/NSSA')
            lines.push('')
        }

        // ── 8. IS-IS Troubleshooting ──
        if (hasIsis) {
            lines.push('! ── 8. IS-IS UNDERLAY TROUBLESHOOTING ────────────────────────────')
            lines.push('!')
            lines.push('! Check IS-IS adjacencies:')
            lines.push('!   show isis adjacency')
            lines.push('!   show isis adjacency detail')
            lines.push('!')
            lines.push('! Verify IS-IS database:')
            lines.push('!   show isis database')
            lines.push('!   show isis database extensive')
            lines.push('!')
            lines.push('! Check IS-IS routes:')
            lines.push('!   show isis route')
            lines.push('!   show route protocol isis')
            lines.push('!')
            lines.push('! Common IS-IS problems:')
            lines.push('!   - No adjacency → NET address mismatch, level mismatch')
            lines.push('!   - Adjacency flapping → check hold timer, interface errors')
            lines.push('')
        }

        // ── 9. MPLS/LDP Troubleshooting ──
        if (hasMpls) {
            lines.push('! ── 9. MPLS / LDP TROUBLESHOOTING ────────────────────────────────')
            lines.push('!')
            lines.push('! Check LDP neighbors:')
            lines.push('!   show ldp neighbor')
            lines.push('!   show ldp session')
            lines.push('!')
            lines.push('! Verify MPLS interfaces:')
            lines.push('!   show mpls interface')
            lines.push('!   show mpls lsp')
            lines.push('!')
            lines.push('! Check label bindings:')
            lines.push('!   show ldp database')
            lines.push('!   show route table inet.3')
            lines.push('!   show route table mpls.0')
            lines.push('!')
            lines.push('! Verify L3VPN:')
            lines.push('!   show route table <vrf-name>.inet.0')
            lines.push('!   show bgp summary | match "vpn"')
            lines.push('!   show route advertising-protocol bgp <pe-peer> table <vrf>.inet.0')
            lines.push('!')
            lines.push('! Common MPLS/L3VPN problems:')
            lines.push('!   - LDP session not forming → loopback not reachable via IGP')
            lines.push('!   - No MPLS label → LDP database empty, check mpls interface')
            lines.push('!   - VPN routes missing → check RT import/export, BGP family vpn')
            lines.push('')
        }

        // ── 10. SRX/Firewall Troubleshooting ──
        if (hasSrx) {
            lines.push('! ── 10. SRX FIREWALL TROUBLESHOOTING ─────────────────────────────')
            lines.push('!')
            lines.push('! Check HA cluster status:')
            lines.push('!   show chassis cluster status')
            lines.push('!   show chassis cluster interfaces')
            lines.push('!   show chassis cluster control-plane statistics')
            lines.push('!')
            lines.push('! Verify security zones:')
            lines.push('!   show security zones')
            lines.push('!   show security zones-information')
            lines.push('!')
            lines.push('! Check security policies:')
            lines.push('!   show security policies')
            lines.push('!   show security policies hit-count')
            lines.push('!')
            lines.push('! Monitor active sessions:')
            lines.push('!   show security flow session')
            lines.push('!   show security flow session source-prefix <ip>')
            lines.push('!   show security flow session destination-prefix <ip>')
            lines.push('!')
            lines.push('! Check NAT:')
            lines.push('!   show security nat source rule all')
            lines.push('!   show security nat source summary')
            lines.push('!')
            lines.push('! Debug traffic flow:')
            lines.push('!   show security match-policies from-zone <zone> to-zone <zone> ...')
            lines.push('!')
            lines.push('! Common SRX problems:')
            lines.push('!   - Traffic denied → check policy from-zone/to-zone direction')
            lines.push('!   - HA failover → check fabric/control link status')
            lines.push('!   - Session timeout → check application-level gateway (ALG)')
            lines.push('')
        }

        // ── 11. Border Leaf / DCI ──
        if (hasBorderLeaf) {
            lines.push('! ── 11. BORDER LEAF / DCI TROUBLESHOOTING ────────────────────────')
            lines.push('!')
            lines.push('! Verify external BGP peering:')
            lines.push('!   show bgp summary | match "EBGP|Estab"')
            lines.push('!   show bgp neighbor <wan-peer> | match "State|Received|Advertised"')
            lines.push('!')
            lines.push('! Check route leaking between VRF and WAN:')
            lines.push('!   show route table EVPN-VRF.inet.0 protocol bgp')
            lines.push('!   show route advertising-protocol bgp <wan-peer>')
            lines.push('!')
            lines.push('! Verify traffic path:')
            lines.push('!   traceroute <external-destination> source <leaf-loopback>')
            lines.push('!')
            lines.push('! Common DCI problems:')
            lines.push('!   - External routes not in fabric → check border-leaf VRF import/export')
            lines.push('!   - Asymmetric path → check ECMP on spines toward border-leaves')
            lines.push('')
        }

        // ── Data collection for TAC ──
        lines.push('! ── COLLECT FOR JTAC / TAC SUPPORT ────────────────────────────────')
        lines.push('!')
        lines.push('! Collect the following before opening a support case:')
        lines.push('!   request support information | save /var/tmp/rsi.txt')
        lines.push('!   show log messages | last 200')
        lines.push('!   show log chassisd | last 100')
        lines.push('!   show system core-dumps')
        lines.push('!   show chassis hardware detail')
        lines.push('!   show configuration | display set | save /var/tmp/config.txt')
        lines.push('!')
        if (hasEvpn) {
            lines.push('! EVPN-specific RSI (22.2+ — captures all EVPN/VXLAN state):')
            lines.push('!   request support information evpn-vxlan | save /var/tmp/rsi-evpn.txt')
            lines.push('!   (Includes RE + PFE commands for all FPCs automatically)')
            lines.push('!')
            lines.push('! EVPN detailed data:')
            lines.push('!   show evpn database extensive | save /var/tmp/evpn-db.txt')
            lines.push('!   show ethernet-switching table | save /var/tmp/mac-table.txt')
            lines.push('!   show bridge mac-ip-table | save /var/tmp/macip-table.txt')
            lines.push('!   show bridge mac-ip-table kernel differences | save /var/tmp/macip-diff.txt')
            lines.push('!   show ethernet-switching context-history | save /var/tmp/ctx-history.txt')
            lines.push('!')
            lines.push('! Enable L2ALD in-memory tracing for scaling issues:')
            lines.push('!   set protocols l2-learning traceoptions in-memory-debug')
            lines.push('!   show ethernet-switching debug trace | save /var/tmp/l2memtrace.txt')
            lines.push('!')
            lines.push('! Check DDOS drops:')
            lines.push('!   show ddos-protection protocols vxlan | save /var/tmp/ddos-vxlan.txt')
            lines.push('!   show ddos-protection protocols arp | save /var/tmp/ddos-arp.txt')
            lines.push('!')
        }
        if (hasBgp) {
            lines.push('! BGP data:')
            lines.push('!   show bgp summary | save /var/tmp/bgp-summary.txt')
            lines.push('!   show route summary | save /var/tmp/route-summary.txt')
        }
        if (hasMpls) {
            lines.push('! MPLS data:')
            lines.push('!   request support information evpn-mpls | save /var/tmp/rsi-mpls.txt')
        }
        lines.push('!')
        lines.push('! Live core dump (for deep analysis):')
        lines.push('!   request system core-dump routing running')
        lines.push('!   request system core-dump l2ald running')
        lines.push('')
        lines.push(d)

        return lines.join('\n')
    }
}
