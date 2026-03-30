import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, OnDestroy, Output,
} from '@angular/core'
import { TopologyService } from '../services/topology.service'
import {
    TOPOLOGY_TEMPLATES, TopologyTemplate, TemplateCategory,
    DEFAULT_PORTS, TemplateNodeDef, NodePort,
} from '../api/interfaces'
import { buildVendorStartupConfig, VendorConfigContext, BgpNeighbor, OspfInterface, IsisInterface } from '../services/vendor-config-builder'

type FilterTab = 'all' | TemplateCategory

@Component({
    selector: 'topology-templates',
    templateUrl: './templates.component.pug',
    styleUrls: ['./templates.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesComponent implements OnDestroy {

    @Output() closed = new EventEmitter<void>()
    @Output() switchToBuilder = new EventEmitter<void>()
    @Output() deployRequested = new EventEmitter<void>()

    readonly allTemplates = TOPOLOGY_TEMPLATES
    hovered: string | null = null
    activeFilter: FilterTab = 'all'
    searchQuery = ''

    private _hoverTimer: any

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


    get templates (): TopologyTemplate[] {
        let list = this.allTemplates
        if (this.activeFilter !== 'all') {
            list = list.filter(t => t.category === this.activeFilter)
        }
        if (this.searchQuery.trim()) {
            const q = this.searchQuery.trim().toLowerCase()
            list = list.filter(t => {
                const vendorNames = t.nodes.map(n => (n.vendor ?? '').toLowerCase()).join(' ')
                const haystack = `${t.name} ${t.description} ${t.category} ${vendorNames} ${t.id}`.toLowerCase()
                return haystack.includes(q)
            })
        }
        return list
    }

    setFilter (f: FilterTab): void { this.activeFilter = f }

    onSearchChange (): void { /* triggers getter re-evaluation via change detection */ }

    clearSearch (): void { this.searchQuery = '' }

    countFor (f: FilterTab): number {
        let list = this.allTemplates
        if (this.searchQuery.trim()) {
            const q = this.searchQuery.trim().toLowerCase()
            list = list.filter(t => {
                const vendorNames = t.nodes.map(n => (n.vendor ?? '').toLowerCase()).join(' ')
                const haystack = `${t.name} ${t.description} ${t.category} ${vendorNames} ${t.id}`.toLowerCase()
                return haystack.includes(q)
            })
        }
        if (f === 'all') { return list.length }
        return list.filter(t => t.category === f).length
    }

    load (tpl: TopologyTemplate): void {
        const hasNodes = this.svc.topology.nodes.length > 0
        if (hasNodes && !confirm(`Replace current topology with "${tpl.name}"?`)) { return }
        this.svc.loadTemplate(tpl)
        this.closed.emit()
    }

    deployLab (tpl: TopologyTemplate, $event: Event): void {
        $event.stopPropagation()
        if (!confirm(`Deploy "${tpl.name}" as a containerlab lab? This will load the template and start deployment.`)) { return }
        this.svc.loadTemplate(tpl)
        this.closed.emit()
        this.deployRequested.emit()
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

    ngOnDestroy (): void {
        clearTimeout(this._hoverTimer)
    }

    openBuilder (): void {
        this.closed.emit()
        this.switchToBuilder.emit()
    }

    /** True when at least one node in the template has a vendor set */
    hasVendorNodes (tpl: TopologyTemplate): boolean {
        return tpl.nodes.some(n => !!n.vendor)
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
