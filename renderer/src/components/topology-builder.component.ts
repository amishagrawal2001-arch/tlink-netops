import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, EventEmitter, Output,
} from '@angular/core'
import { TopologyService } from '../services/topology.service'
import {
    NodeRole, NODE_ROLE_META, BuilderNodeGroup, BuilderLinkRule,
    BuilderLinkPattern, BuilderIpConfig, BuilderConfig,
    PortSpeed, VENDOR_PRESETS, VENDOR_MODELS, VendorModelSpec, VlanDefinition,
    VLAN_TEMPLATES, PreviewTopology, SERVICE_PROFILES,
    ServiceProfile, ServicePortRule,
} from '../api/interfaces'

interface FreePortStub {
    nodeIdx: number
    x: number
    y: number       // node center y
    endY: number    // stub endpoint y
    vlanMode: 'access' | 'trunk'
    label: string   // e.g. "Access VLAN 100" or "Trunk"
}

interface ServicePreviewInfo {
    profileName: string
    profileIcon: string
    vlanNames: string[]
    linkTypes: ('trunk' | 'access' | 'default')[]   // one per preview link
    ruleSummaries: string[]
    freePortStubs: FreePortStub[]
}

interface UINodeGroup extends BuilderNodeGroup {
    id: number          // local sequence id for trackBy
    expanded: boolean
}

interface UILinkRule extends BuilderLinkRule {
    id: number
}

@Component({
    selector: 'topology-builder',
    templateUrl: './topology-builder.component.pug',
    styleUrls: ['./topology-builder.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TopologyBuilderComponent {

    @Output() closed = new EventEmitter<void>()

    step: 1 | 2 | 3 | 4 = 1
    private _nextId = 1

    // ── Step 4: Preview ─────────────────────────────────────────────────────
    preview: PreviewTopology | null = null
    previewViewBox = '0 0 800 400'
    servicePreview: ServicePreviewInfo | null = null

    // ── Step 1: Node groups ──────────────────────────────────────────────────

    groups: UINodeGroup[] = [
        this._defaultGroup('spine', 2),
        this._defaultGroup('leaf', 4),
    ]

    readonly roles: NodeRole[] = [
        'spine', 'leaf', 'border-leaf', 'super-spine',
        'tor', 'gateway', 'core', 'aggregation', 'access', 'custom',
    ]

    readonly roleMeta = NODE_ROLE_META

    readonly vendorOptions = ['', 'SONiC', 'Juniper', 'Arista', 'Nokia', 'Huawei', 'Dell', 'HPE', 'MikroTik', 'Extreme']

    readonly speedOptions: PortSpeed[] = [
        '10M', '100M', '1G', '2.5G', '5G', '10G', '25G', '40G', '50G', '100G', '200G', '400G', '800G',
    ]

    // ── Step 2: Link rules ───────────────────────────────────────────────────

    linkRules: UILinkRule[] = [
        { id: this._nextId++, sourceRole: 'spine', targetRole: 'leaf', pattern: 'full-mesh', linksPerPair: 1 },
    ]

    readonly patternOptions: { value: BuilderLinkPattern; label: string }[] = [
        { value: 'full-mesh',  label: 'Full Mesh' },
        { value: 'ring',       label: 'Ring' },
        { value: 'dual-homed', label: 'Dual-Homed' },
    ]

    readonly linksPerPairOptions = [1, 2, 4]

    // ── Step 3: IP config ────────────────────────────────────────────────────

    ipConfig: BuilderIpConfig = {
        mode: 'ipv4',
        ipv4Base: '10.0.0.0/16',
        ipv6Base: '2001:db8::/32',
        loopbackV4: '172.16.0.0/24',
        loopbackV6: 'fd00::/64',
        autoAssign: true,
    }

    topoName = 'Custom Topology'
    generateConfigs = true
    selectedVlanTemplate = ''
    selectedServiceProfile = ''

    // BGP underlay / EVPN-VXLAN overlay
    underlayProtocol: 'ebgp' | 'ibgp-rr' | 'none' = 'none'
    overlayEnabled = false
    spineAsnStart = 65000
    leafAsnStart = 65100
    vniBase = 10000

    // Advanced overlay options
    irbMode: 'none' | 'symmetric' | 'asymmetric' = 'none'
    irbGatewayBase = '192.168'
    macVrfEnabled = false
    oismEnabled = false

    // Telemetry
    telemetryEnabled = false
    telCollectorIp = '0.0.0.0'
    telCollectorPort = 50051
    telEncoding: 'gpb' | 'json' | 'json-ietf' = 'gpb'
    telSampleInterval = 30
    telTls = false

    // Bulk VLAN generator
    bulkVlanInput = ''
    bulkVlanPrefix = 'VLAN'
    bulkVlanRoles: string[] = ['leaf']
    bulkVlanPreview: { count: number; range: string } | null = null
    bulkVlanMacVrfType: 'shared' | 'isolated' = 'shared'

    readonly vlanTemplates = VLAN_TEMPLATES
    readonly serviceProfiles = SERVICE_PROFILES
    readonly ipModes: { value: BuilderIpConfig['mode']; label: string }[] = [
        { value: 'ipv4', label: 'IPv4 Only' },
        { value: 'ipv6', label: 'IPv6 Only' },
        { value: 'dual', label: 'Dual Stack' },
    ]

    buildError = ''

    constructor (private svc: TopologyService, private cdr: ChangeDetectorRef) {}

    // ── Navigation ───────────────────────────────────────────────────────────

    goStep (s: 1 | 2 | 3 | 4): void {
        if (s === 4 && !this.preview) { return }   // can't jump to preview without generating it
        this.step = s
        this.cdr.markForCheck()
    }

    next (): void {
        if (this.step < 3) { this.step = (this.step + 1) as 1 | 2 | 3 | 4 }
        this.cdr.markForCheck()
    }

    back (): void {
        if (this.step > 1) { this.step = (this.step - 1) as 1 | 2 | 3 | 4 }
        this.cdr.markForCheck()
    }

    close (): void { this.closed.emit() }

    // ── Step 1: Group management ─────────────────────────────────────────────

    addGroup (): void {
        // pick first role not yet used, or 'custom'
        const usedRoles = new Set(this.groups.map(g => g.role))
        const role = this.roles.find(r => !usedRoles.has(r)) ?? 'custom'
        this.groups.push(this._defaultGroup(role, 2))
        this.cdr.markForCheck()
    }

    removeGroup (g: UINodeGroup): void {
        this.groups = this.groups.filter(x => x.id !== g.id)
        // also remove link rules referencing this role if no more groups use it
        const activeRoles = new Set(this.groups.map(x => x.role))
        this.linkRules = this.linkRules.filter(
            r => activeRoles.has(r.sourceRole) && activeRoles.has(r.targetRole),
        )
        this.cdr.markForCheck()
    }

    toggleGroup (g: UINodeGroup): void {
        g.expanded = !g.expanded
        this.cdr.markForCheck()
    }

    onVendorChange (g: UINodeGroup): void {
        if (!g.vendor) { return }
        // pick the recommended model for this role from role presets
        const preset = VENDOR_PRESETS.find(p => p.vendor === g.vendor)
        const roleCfg = preset?.roles[g.role]
        if (roleCfg) { g.model = roleCfg.model }
        // always resolve speed & portCount from the authoritative model catalogue
        const models = VENDOR_MODELS[g.vendor]
        if (models && g.model) {
            const spec = models.find(m => m.model === g.model)
            if (spec) {
                g.speed = spec.speed
                g.portCount = spec.portCount
            }
        }
        this.cdr.markForCheck()
    }

    onRoleChange (g: UINodeGroup): void {
        const meta = NODE_ROLE_META[g.role]
        g.speed = g.speed ?? meta.defaultSpeed
        g.portCount = g.portCount ?? meta.defaultPortCount
        // re-apply vendor preset if vendor set
        if (g.vendor) { this.onVendorChange(g) }
        this.cdr.markForCheck()
    }

    /** Returns all models for the selected vendor from the full catalogue */
    getModelOptions (g: UINodeGroup): VendorModelSpec[] {
        if (!g.vendor) { return [] }
        return VENDOR_MODELS[g.vendor] ?? []
    }

    /** When model changes, update speed & portCount to match that model's specs */
    onModelChange (g: UINodeGroup): void {
        if (!g.vendor || !g.model) { return }
        const models = VENDOR_MODELS[g.vendor]
        if (!models) { return }
        const spec = models.find(m => m.model === g.model)
        if (spec) {
            g.speed = spec.speed
            g.portCount = spec.portCount
        }
        this.cdr.markForCheck()
    }

    // ── Step 2: Link rule management ─────────────────────────────────────────

    addLinkRule (): void {
        const activeRoles = this.activeRoles
        const src = activeRoles[0] ?? 'spine'
        const tgt = activeRoles.length > 1 ? activeRoles[1] : activeRoles[0] ?? 'leaf'
        this.linkRules.push({
            id: this._nextId++,
            sourceRole: src,
            targetRole: tgt,
            pattern: 'full-mesh',
            linksPerPair: 1,
        })
        this.cdr.markForCheck()
    }

    removeLinkRule (r: UILinkRule): void {
        this.linkRules = this.linkRules.filter(x => x.id !== r.id)
        this.cdr.markForCheck()
    }

    get activeRoles (): NodeRole[] {
        return [...new Set(this.groups.map(g => g.role))]
    }

    /** Check if any node group uses a specific vendor */
    hasVendor (vendor: string): boolean {
        return this.groups.some(g => (g.vendor ?? '').toLowerCase() === vendor.toLowerCase())
    }

    // ── Preview / summary ────────────────────────────────────────────────────

    get totalNodes (): number {
        return this.groups.reduce((s, g) => s + g.count, 0)
    }

    get estimatedLinks (): number {
        let total = 0
        for (const rule of this.linkRules) {
            const srcCount = this.groups.filter(g => g.role === rule.sourceRole).reduce((s, g) => s + g.count, 0)
            const tgtCount = this.groups.filter(g => g.role === rule.targetRole).reduce((s, g) => s + g.count, 0)
            switch (rule.pattern) {
                case 'full-mesh':
                    if (rule.sourceRole === rule.targetRole) {
                        total += (srcCount * (srcCount - 1) / 2) * rule.linksPerPair
                    } else {
                        total += srcCount * tgtCount * rule.linksPerPair
                    }
                    break
                case 'ring':
                    total += Math.max(srcCount + tgtCount, 0) * rule.linksPerPair
                    break
                case 'dual-homed':
                    total += tgtCount * Math.min(2, srcCount) * rule.linksPerPair
                    break
                case 'custom': // deprecated — falls through to full-mesh
                    if (rule.sourceRole === rule.targetRole) {
                        total += (srcCount * (srcCount - 1) / 2) * rule.linksPerPair
                    } else {
                        total += srcCount * tgtCount * rule.linksPerPair
                    }
                    break
            }
        }
        return total
    }

    get estimatedPorts (): number {
        return this.estimatedLinks * 2
    }

    get totalAvailablePorts (): number {
        return this.groups.reduce((sum, g) =>
            sum + g.count * (g.portCount ?? NODE_ROLE_META[g.role].defaultPortCount), 0)
    }

    get portCapacityWarning (): string {
        if (this.estimatedPorts <= this.totalAvailablePorts) { return '' }
        const deficit = this.estimatedPorts - this.totalAvailablePorts
        return `Port capacity exceeded: ${this.estimatedPorts} ports needed but only ${this.totalAvailablePorts} available (${deficit} short). Some links will be dropped.`
    }

    getDualHomedWarning (rule: UILinkRule): string {
        if (rule.pattern !== 'dual-homed') { return '' }
        const srcCount = this.groups
            .filter(g => g.role === rule.sourceRole)
            .reduce((s, g) => s + g.count, 0)
        if (srcCount >= 2) { return '' }
        return `Dual-homed requires \u2265 2 source nodes for redundancy. Currently only ${srcCount} source node \u2014 each target gets just ${srcCount} uplink.`
    }

    // ── Preview & Build ──────────────────────────────────────────────────────

    generatePreview (): void {
        const config = this._assembleConfig()
        if (!config) { return }
        this.preview = this.svc.computeTopologyPreview(config)
        this.servicePreview = this._computeServicePreview(config, this.preview)
        this.previewViewBox = this._computeViewBox(this.preview, this.servicePreview)
        this.step = 4
        this.cdr.markForCheck()
    }

    build (): void {
        const config = this._assembleConfig()
        if (!config) { return }

        // warn before replacing
        if (this.svc.topology.nodes.length > 0) {
            if (!confirm(`Replace current topology with "${this.topoName}"?`)) { return }
        }

        try {
            this.svc.buildCustomTopology(config)
            this.closed.emit()
        } catch (err) {
            this.buildError = (err as Error).message ?? 'Build failed'
            this.cdr.markForCheck()
        }
    }

    groupCountForRole (role: NodeRole): number {
        return this.groups.filter(g => g.role === role).reduce((s, g) => s + g.count, 0)
    }

    onServiceProfileChange (): void {
        if (!this.selectedServiceProfile) { return }
        const profile = SERVICE_PROFILES.find(p => p.id === this.selectedServiceProfile)
        if (profile) {
            this.selectedVlanTemplate = profile.vlanTemplateId
        }
        this.cdr.markForCheck()
    }

    getServiceProfileDescription (): string {
        const p = SERVICE_PROFILES.find(sp => sp.id === this.selectedServiceProfile)
        return p?.description ?? ''
    }

    trackById (_: number, item: { id: number }): number { return item.id }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** Assemble a BuilderConfig from current wizard state; returns null on validation error */
    private _assembleConfig (): BuilderConfig | null {
        this.buildError = ''

        if (!this.groups.length) {
            this.buildError = 'Add at least one node group'
            this.cdr.markForCheck()
            return null
        }

        if (!this.topoName.trim()) {
            this.buildError = 'Topology name is required'
            this.cdr.markForCheck()
            return null
        }

        // Validate ASN ranges
        if (this.underlayProtocol !== 'none') {
            if (this.spineAsnStart < 1 || this.spineAsnStart > 4294967295) {
                this.buildError = 'Spine ASN must be between 1 and 4294967295'
                this.cdr.markForCheck()
                return null
            }
            if (this.underlayProtocol === 'ebgp' && (this.leafAsnStart < 1 || this.leafAsnStart > 4294967295)) {
                this.buildError = 'Leaf ASN must be between 1 and 4294967295'
                this.cdr.markForCheck()
                return null
            }
        }
        // Validate VNI base
        if (this.overlayEnabled && (this.vniBase < 1 || this.vniBase > 16777215)) {
            this.buildError = 'VNI Base must be between 1 and 16777215'
            this.cdr.markForCheck()
            return null
        }

        let vlans: VlanDefinition[] | undefined
        if (this.selectedVlanTemplate) {
            const vt = VLAN_TEMPLATES.find(t => t.id === this.selectedVlanTemplate)
            if (vt) { vlans = vt.vlans }
        }

        const groups: BuilderNodeGroup[] = this.groups.map(g => ({
            role: g.role,
            count: g.count,
            vendor: g.vendor || undefined,
            model: g.model || undefined,
            speed: g.speed,
            portCount: g.portCount,
            vlans: vlans ?? g.vlans,
        }))

        return {
            name: this.topoName.trim(),
            groups,
            linkRules: this.linkRules.map(r => ({
                sourceRole: r.sourceRole,
                targetRole: r.targetRole,
                pattern: r.pattern,
                linksPerPair: r.linksPerPair,
            })),
            ipConfig: { ...this.ipConfig },
            vlanTemplateId: this.selectedVlanTemplate || undefined,
            serviceProfileId: this.selectedServiceProfile || undefined,
            generateConfigs: this.generateConfigs,
            underlayProtocol: this.underlayProtocol !== 'none' ? this.underlayProtocol : undefined,
            overlayEnabled: this.overlayEnabled || undefined,
            spineAsnStart: this.underlayProtocol !== 'none' ? this.spineAsnStart : undefined,
            leafAsnStart: this.underlayProtocol !== 'none' ? this.leafAsnStart : undefined,
            vniBase: this.overlayEnabled ? this.vniBase : undefined,
            // Advanced overlay
            irbEnabled: this.irbMode !== 'none' && this.overlayEnabled ? true : undefined,
            irbMode: this.irbMode !== 'none' && this.overlayEnabled ? this.irbMode as any : undefined,
            irbGatewayBase: this.irbMode !== 'none' && this.overlayEnabled ? this.irbGatewayBase : undefined,
            macVrfEnabled: this.macVrfEnabled && this.overlayEnabled ? true : undefined,
            oismEnabled: this.oismEnabled && this.overlayEnabled ? true : undefined,
            telemetryEnabled: this.telemetryEnabled || undefined,
            telemetryConfig: this.telemetryEnabled ? {
                collectorIp: this.telCollectorIp,
                collectorPort: this.telCollectorPort,
                encoding: this.telEncoding,
                tls: this.telTls,
                sampleInterval: this.telSampleInterval,
                sensorPaths: [],  // use vendor defaults
            } : undefined,
        } as any
    }

    /** Parse a VLAN range string like "100-110" or "100,200,300" into VlanDefinition[] */
    parseVlanRange (input: string): VlanDefinition[] {
        const vlans: VlanDefinition[] = []
        const parts = input.split(',').map(s => s.trim()).filter(Boolean)
        for (const part of parts) {
            if (part.includes('-')) {
                const [startStr, endStr] = part.split('-').map(s => s.trim())
                const start = parseInt(startStr, 10)
                const end = parseInt(endStr, 10)
                if (!isNaN(start) && !isNaN(end) && start >= 1 && end <= 4094 && start <= end) {
                    for (let i = start; i <= end; i++) {
                        vlans.push({ id: i, name: `${this.bulkVlanPrefix}-${i}` })
                    }
                }
            } else {
                const id = parseInt(part, 10)
                if (!isNaN(id) && id >= 1 && id <= 4094) {
                    vlans.push({ id, name: `${this.bulkVlanPrefix}-${id}` })
                }
            }
        }
        return vlans
    }

    /** Update bulk VLAN preview count */
    updateBulkVlanPreview (): void {
        if (!this.bulkVlanInput.trim()) {
            this.bulkVlanPreview = null
            return
        }
        const vlans = this.parseVlanRange(this.bulkVlanInput)
        if (vlans.length > 0) {
            const ids = vlans.map(v => v.id)
            const vniStart = (this.vniBase || 10000) + Math.min(...ids)
            const vniEnd = (this.vniBase || 10000) + Math.max(...ids)
            this.bulkVlanPreview = { count: vlans.length, range: `VNIs ${vniStart}–${vniEnd}` }
        } else {
            this.bulkVlanPreview = null
        }
        this.cdr.markForCheck()
    }

    /** Apply bulk VLANs to matching node groups */
    applyBulkVlans (): void {
        const vlans = this.parseVlanRange(this.bulkVlanInput)
        if (!vlans.length) { return }
        // When MAC-VRF is enabled, prefix VLAN names to signal the MAC-VRF type to the config generator
        // "Isolated-*" → vlan-based MAC-VRF (1 VLAN per MAC-VRF)
        // Other names → vlan-aware MAC-VRF (grouped under 1 MAC-VRF)
        if (this.macVrfEnabled && this.bulkVlanMacVrfType === 'isolated') {
            for (const v of vlans) {
                v.name = `Isolated-${this.bulkVlanPrefix}-${v.id}`
            }
        }
        for (const g of this.groups) {
            if (this.bulkVlanRoles.includes(g.role)) {
                g.vlans = [...vlans.map(v => ({ ...v }))]
            }
        }
        this.cdr.markForCheck()
    }

    /** Toggle a role in bulkVlanRoles */
    toggleBulkVlanRole (role: string): void {
        const idx = this.bulkVlanRoles.indexOf(role)
        if (idx >= 0) { this.bulkVlanRoles.splice(idx, 1) }
        else { this.bulkVlanRoles.push(role) }
    }

    /** Classify each preview link as trunk / access / default based on service profile rules */
    private _computeServicePreview (config: BuilderConfig, preview: PreviewTopology): ServicePreviewInfo | null {
        if (!config.serviceProfileId) { return null }
        const profile = SERVICE_PROFILES.find(p => p.id === config.serviceProfileId)
        if (!profile) { return null }

        const vlanTemplate = VLAN_TEMPLATES.find(t => t.id === profile.vlanTemplateId)
        const vlanNames = vlanTemplate ? vlanTemplate.vlans.map(v => `${v.id} ${v.name}`) : []

        // Role tier map (same as topology.service)
        const roleTier: Record<string, number> = {
            'super-spine': 0, spine: 1, leaf: 2, 'border-leaf': 2,
            tor: 3, access: 3, aggregation: 1, core: 0, gateway: 0, custom: 3,
        }

        // Classify each link as trunk, access, or default
        const linkTypes: ('trunk' | 'access' | 'default')[] = preview.links.map(link => {
            const srcRole = preview.nodes[link.srcIdx].role
            const tgtRole = preview.nodes[link.tgtIdx].role
            const srcTier = roleTier[srcRole] ?? 3
            const tgtTier = roleTier[tgtRole] ?? 3

            // Check each port rule to find the dominant link type
            // A link is trunk if either end's matching rule says trunk
            let hasTrunk = false
            let hasAccess = false

            for (const rule of profile.portRules) {
                // Check src side
                if (rule.roles.includes(srcRole)) {
                    const isSrcUplink = tgtTier < srcTier
                    const isSrcDownlink = tgtTier > srcTier
                    const matches = rule.scope === 'all-connected'
                        || (rule.scope === 'uplinks' && isSrcUplink)
                        || (rule.scope === 'downlinks' && isSrcDownlink)
                    if (matches) {
                        if (rule.vlanMode === 'trunk') { hasTrunk = true }
                        else { hasAccess = true }
                    }
                }
                // Check tgt side
                if (rule.roles.includes(tgtRole)) {
                    const isTgtUplink = srcTier < tgtTier
                    const isTgtDownlink = srcTier > tgtTier
                    const matches = rule.scope === 'all-connected'
                        || (rule.scope === 'uplinks' && isTgtUplink)
                        || (rule.scope === 'downlinks' && isTgtDownlink)
                    if (matches) {
                        if (rule.vlanMode === 'trunk') { hasTrunk = true }
                        else { hasAccess = true }
                    }
                }
            }

            if (hasTrunk) { return 'trunk' }
            if (hasAccess) { return 'access' }
            return 'default'
        })

        // Build human-readable rule summaries
        const ruleSummaries = profile.portRules.map(rule => {
            const rolesStr = rule.roles.map(r => NODE_ROLE_META[r]?.label ?? r).join(', ')
            const scopeLabel: Record<string, string> = {
                uplinks: 'uplinks', downlinks: 'downlinks',
                'all-connected': 'all connected', 'free-ports': 'free ports',
            }
            const modeStr = rule.vlanMode === 'trunk'
                ? `trunk (native ${rule.trunkNativeVlan ?? '—'}, allowed ${rule.trunkAllowedVlans ?? 'all'})`
                : `access VLAN ${rule.accessVlan ?? '—'}`
            return `${rolesStr} ${scopeLabel[rule.scope]}: ${modeStr}`
        })

        // Compute free-port stubs — nodes with "free-ports" rules get a downward stub
        const STUB_LENGTH = 50
        const freePortStubs: FreePortStub[] = []
        const seenNodeIdx = new Set<number>()

        for (const rule of profile.portRules) {
            if (rule.scope !== 'free-ports') { continue }
            for (let i = 0; i < preview.nodes.length; i++) {
                if (seenNodeIdx.has(i)) { continue }
                const node = preview.nodes[i]
                if (!rule.roles.includes(node.role)) { continue }
                seenNodeIdx.add(i)
                const label = rule.vlanMode === 'access'
                    ? `VLAN ${rule.accessVlan ?? '—'}`
                    : 'Trunk'
                freePortStubs.push({
                    nodeIdx: i,
                    x: node.x,
                    y: node.y,
                    endY: node.y + STUB_LENGTH,
                    vlanMode: rule.vlanMode,
                    label,
                })
            }
        }

        return {
            profileName: profile.name,
            profileIcon: profile.icon,
            vlanNames,
            linkTypes,
            ruleSummaries,
            freePortStubs,
        }
    }

    private _computeViewBox (p: PreviewTopology, svc?: ServicePreviewInfo | null): string {
        if (!p.nodes.length) { return '0 0 800 400' }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of p.nodes) {
            if (n.x < minX) { minX = n.x }
            if (n.y < minY) { minY = n.y }
            if (n.x > maxX) { maxX = n.x }
            if (n.y > maxY) { maxY = n.y }
        }
        // Extend for free-port stubs (endpoint boxes below nodes)
        if (svc?.freePortStubs.length) {
            for (const stub of svc.freePortStubs) {
                const stubBottom = stub.endY + 14  // account for server rect + label
                if (stubBottom > maxY) { maxY = stubBottom }
            }
        }
        const pad = 60
        return `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`
    }

    private _defaultGroup (role: NodeRole, count: number): UINodeGroup {
        const meta = NODE_ROLE_META[role]
        return {
            id: this._nextId++,
            role,
            count,
            speed: meta.defaultSpeed,
            portCount: meta.defaultPortCount,
            expanded: true,
        }
    }
}
