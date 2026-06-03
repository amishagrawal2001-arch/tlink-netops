import { NodePort, PortSpeed, SwitchFamily, VlanDefinition, VrfDefinition, parseVlanList } from '../api/interfaces'

// ── Helpers ─────────────────────────────────────────────────────────────────

function prefixToMask (prefix: number): string | null {
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) { return null }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return [
        (mask >>> 24) & 255,
        (mask >>> 16) & 255,
        (mask >>> 8) & 255,
        mask & 255,
    ].join('.')
}

function parseIpCidr (value?: string): { ip: string; prefix: number; mask: string } | null {
    const raw = (value ?? '').trim()
    if (!raw) { return null }

    const [ipRaw, prefixRaw] = raw.split('/')
    const ip = (ipRaw ?? '').trim()
    if (!ip) { return null }

    const parsedPrefix = prefixRaw === undefined ? 24 : Number(prefixRaw)
    if (!Number.isFinite(parsedPrefix)) { return null }
    const prefix = Math.trunc(parsedPrefix)
    const mask = prefixToMask(prefix)
    if (!mask) { return null }

    return { ip, prefix, mask }
}

function speedToLabel (speed?: PortSpeed): string | null {
    if (!speed) { return null }
    const map: Record<PortSpeed, string> = {
        '10M': '10', '100M': '100', '1G': '1000', '2.5G': '2500', '5G': '5000',
        '10G': '10000', '25G': '25000', '40G': '40000', '50G': '50000',
        '100G': '100000', '200G': '200000', '400G': '400000', '800G': '800000',
    }
    return map[speed] ?? null
}

/** Juniper JunOS speed format: 10g, 25g, 100g, 400g, 800g */
function speedToJunos (speed?: PortSpeed): string | null {
    if (!speed) { return null }
    const map: Record<PortSpeed, string> = {
        '10M': '10m', '100M': '100m', '1G': '1g', '2.5G': '2.5g', '5G': '5g',
        '10G': '10g', '25G': '25g', '40G': '40g', '50G': '50g',
        '100G': '100g', '200G': '200g', '400G': '400g', '800G': '800g',
    }
    return map[speed] ?? null
}

/** Parse a port label into base + channel index, e.g. "et-0/0/2:1" → { base: "et-0/0/2", channel: 1 } */
function parseChannelLabel (label: string): { base: string; channel: number | null } {
    const sep = label.indexOf(':')
    if (sep > 0) {
        const base = label.slice(0, sep).trim()
        const ch = Number(label.slice(sep + 1))
        return { base, channel: Number.isFinite(ch) ? Math.trunc(ch) : null }
    }
    return { base: label.trim(), channel: null }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface BgpNeighbor {
    ip: string
    peerAsn: number
    portLabel: string
    peerHostname: string
}

export interface VniMapping {
    vlanId: number
    vni: number
    vlanName: string
}

export interface OspfInterface {
    portLabel: string       // e.g. "et-0/0/0"
    area: number            // OSPF area this interface belongs to
    passive?: boolean       // passive interface (no hellos)
}

export interface IsisInterface {
    portLabel: string       // e.g. "et-0/0/0"
    level: 1 | 2 | 12      // 12 = L1/L2
    passive?: boolean
}

export interface VendorConfigContext {
    nodeType: string
    hostname: string
    mgmtIp: string              // management IP for SSH access (not used for Loopback0)
    loopbackIp?: string         // dedicated loopback IP (for Loopback0, router-id, etc.)
    loopbackIpv6?: string       // dedicated IPv6 loopback (for Loopback0 inet6, etc.)
    /** Secondary loopback (lo0.1 in Junos, Loopback1 in NX-OS). Bound to T5
     *  VRF instances + used as iRD source. See `<loopback1>` placeholder
     *  expansion in expandRdPlaceholders(). */
    loopbackIpSecondary?: string
    sshUsername: string
    model: string
    switchFamily: SwitchFamily | ''
    vlans: VlanDefinition[]

    // BGP underlay context
    asn?: number
    routerId?: string                 // loopback IP without mask
    bgpNeighbors?: BgpNeighbor[]
    underlayProtocol?: 'ebgp' | 'ibgp-rr' | 'ospf' | 'ospfv3' | 'isis' | 'none'

    // EVPN-VXLAN overlay context
    overlayEnabled?: boolean
    overlayNeighbors?: string[]       // spine loopbacks (for leaf) or leaf loopbacks (for spine)
    vniMappings?: VniMapping[]
    vtepSourceIp?: string
    nodeRole?: string
    irbEnabled?: boolean              // generate IRB interfaces for inter-VLAN routing (distributed gateway)
    irbGatewayBase?: string           // base gateway IP prefix, e.g. "192.168" → 192.168.<vlanId>.1/24
    macVrfEnabled?: boolean           // use MAC-VRF instances instead of default-switch EVI
    irbMode?: 'symmetric' | 'asymmetric'  // symmetric = L3 VNI + Type-5; asymmetric = all VLANs everywhere
    oismEnabled?: boolean                // OISM: IGMP snooping, SMET, assisted replication
    telemetryEnabled?: boolean           // gRPC/gNMI telemetry streaming
    telemetryConfig?: { collectorIp: string; collectorPort: number; encoding: string; tls: boolean; sampleInterval: number; sensorPaths: string[] }

    // iBGP route reflector context
    isRouteReflector?: boolean        // true if this node is a route reflector (spine in ibgp-rr mode)

    // OSPF underlay context
    ospfInterfaces?: OspfInterface[]
    ospfArea?: number                 // node's primary OSPF area

    // IS-IS underlay context
    isisInterfaces?: IsisInterface[]
    isisLevel?: 1 | 2 | 12           // node's IS-IS level (12 = L1/L2)
    isisNet?: string                  // IS-IS NET address (e.g. 49.0001.0100.0000.0001.00)

    // SR-MPLS context
    nodeSid?: number                  // SR-MPLS Node SID index (label = srgbStart + nodeSid)
    srgbStart?: number                // SRGB start label (default 16000)
    srgbEnd?: number                  // SRGB end label (default 23999)

    // SRv6 context
    srv6Locator?: string              // SRv6 locator prefix (e.g. fc00:0:1::/48)

    // MPLS LDP context
    mplsLdp?: boolean                 // enable MPLS LDP on this node
    mplsInterfaces?: string[]         // interfaces to enable MPLS/LDP on

    // ── EVPN T5↔T5 stitching context (RLI 52387) ─────────────────────────
    /** This node's index into the topology's `nodes[]` array. Used to look
     *  up VRF membership in `vrfs[]`: a VRF emits stanzas on this node iff
     *  `vrf.memberNodes.includes(nodeIndex)`, and emits the `interconnect`
     *  block iff `vrf.interconnectNodes?.includes(nodeIndex)`. */
    nodeIndex?: number
    /** All VRFs defined on the topology. The Junos emitter walks this list
     *  and selects entries where this node is a member. Carries the per-VRF
     *  VNI/RD/RT + optional interconnect{routingVni,vrfTarget,domainId,
     *  mapsToVrfId} block needed for T5↔T5 stitching config generation. */
    vrfs?: VrfDefinition[]
}

// ── VLAN config helpers ─────────────────────────────────────────────────────

type VlanDeclStyle = 'ios' | 'juniper' | 'sonic' | 'nokia' | 'huawei' | 'mikrotik' | 'extreme'

function emitVlanDeclarations (vlans: VlanDefinition[], style: VlanDeclStyle): string[] {
    if (!vlans.length) { return [] }
    const lines: string[] = []
    for (const v of vlans) {
        switch (style) {
            case 'ios':
                lines.push(`vlan ${v.id}`)
                lines.push(` name ${v.name}`)
                break
            case 'juniper':
                lines.push(`set vlans vlan${v.id} vlan-id ${v.id}`)
                if (v.name) { lines.push(`set vlans vlan${v.id} description "${v.name}"`) }
                break
            case 'sonic':
                lines.push(`config vlan add ${v.id}`)
                break
            case 'nokia':
                // Nokia SR Linux: no global VLAN declaration needed
                break
            case 'huawei':
                lines.push(`vlan ${v.id}`)
                lines.push(` description ${v.name}`)
                lines.push('#')
                break
            case 'mikrotik':
                lines.push(`/interface bridge vlan add bridge=bridge vlan-ids=${v.id} comment="${v.name}"`)
                break
            case 'extreme':
                lines.push(`create vlan vlan${v.id} tag ${v.id}`)
                if (v.name) { lines.push(`configure vlan vlan${v.id} description "${v.name}"`) }
                break
        }
    }
    return lines
}

function emitPortVlanConfig (port: NodePort, vendorKey: string): string[] {
    const lines: string[] = []
    const mode = port.vlanMode ?? 'access'
    const ifName = port.label.trim()

    if (mode === 'trunk') {
        const isAllowAll = port.trunkAllowedVlans?.toLowerCase() === 'all'
        switch (vendorKey) {
            case 'cisco':
            case 'arista':
            case 'dell':
                lines.push(' switchport mode trunk')
                if (port.trunkNativeVlan) { lines.push(` switchport trunk native vlan ${port.trunkNativeVlan}`) }
                if (isAllowAll) { lines.push(' switchport trunk allowed vlan all') }
                else if (port.trunkAllowedVlans) { lines.push(` switchport trunk allowed vlan ${port.trunkAllowedVlans}`) }
                break
            case 'juniper': {
                lines.push(`set interfaces ${ifName} unit 0 family ethernet-switching interface-mode trunk`)
                if (port.trunkNativeVlan) { lines.push(`set interfaces ${ifName} native-vlan-id ${port.trunkNativeVlan}`) }
                if (isAllowAll) {
                    lines.push(`set interfaces ${ifName} unit 0 family ethernet-switching vlan members all`)
                } else if (port.trunkAllowedVlans) {
                    const ids = parseVlanList(port.trunkAllowedVlans)
                    for (const id of ids) { lines.push(`set interfaces ${ifName} unit 0 family ethernet-switching vlan members vlan${id}`) }
                }
                break
            }
            case 'sonic':
                if (isAllowAll) {
                    lines.push(`config vlan member add all ${ifName} tagged`)
                } else if (port.trunkAllowedVlans) {
                    const ids = parseVlanList(port.trunkAllowedVlans)
                    for (const id of ids) { lines.push(`config vlan member add ${id} ${ifName} tagged`) }
                }
                if (port.trunkNativeVlan) { lines.push(`config vlan member add ${port.trunkNativeVlan} ${ifName} untagged`) }
                break
            case 'nokia':
                lines.push(`set / interface ${ifName} vlan-tagging true`)
                if (isAllowAll) {
                    lines.push(`set / interface ${ifName} subinterface 0 vlan encap single-tagged vlan-id any`)
                } else if (port.trunkAllowedVlans) {
                    const ids = parseVlanList(port.trunkAllowedVlans)
                    for (const id of ids) { lines.push(`set / interface ${ifName} subinterface ${id} vlan encap single-tagged vlan-id ${id}`) }
                }
                if (port.trunkNativeVlan) { lines.push(`set / interface ${ifName} subinterface 0 vlan encap untagged`) }
                break
            case 'huawei':
                lines.push(' port link-type trunk')
                if (port.trunkNativeVlan) { lines.push(` port trunk pvid vlan ${port.trunkNativeVlan}`) }
                if (isAllowAll) { lines.push(' port trunk allow-pass vlan all') }
                else if (port.trunkAllowedVlans) { lines.push(` port trunk allow-pass vlan ${port.trunkAllowedVlans.replace(/,/g, ' ').replace(/-/g, ' to ')}`) }
                break
            case 'hpe':
                lines.push(' no routing')
                lines.push(` vlan trunk native ${port.trunkNativeVlan ?? 1}`)
                if (isAllowAll) { lines.push(' vlan trunk allowed all') }
                else if (port.trunkAllowedVlans) { lines.push(` vlan trunk allowed ${port.trunkAllowedVlans}`) }
                break
            case 'mikrotik':
                if (isAllowAll) {
                    lines.push(`/interface bridge port set ${ifName} frame-types=admit-all`)
                } else if (port.trunkAllowedVlans) {
                    const ids = parseVlanList(port.trunkAllowedVlans)
                    for (const id of ids) { lines.push(`/interface bridge vlan add bridge=bridge vlan-ids=${id} tagged=${ifName}`) }
                }
                if (port.trunkNativeVlan) { lines.push(`/interface bridge vlan add bridge=bridge vlan-ids=${port.trunkNativeVlan} untagged=${ifName}`) }
                break
            case 'extreme':
                if (isAllowAll) {
                    lines.push(`configure vlan all add port ${ifName} tagged`)
                } else if (port.trunkAllowedVlans) {
                    const ids = parseVlanList(port.trunkAllowedVlans)
                    for (const id of ids) { lines.push(`configure vlan vlan${id} add port ${ifName} tagged`) }
                }
                if (port.trunkNativeVlan) { lines.push(`configure vlan vlan${port.trunkNativeVlan} add port ${ifName} untagged`) }
                break
        }
    } else {
        // Access mode
        if (port.vlan) {
            switch (vendorKey) {
                case 'cisco':
                case 'arista':
                case 'dell':
                    lines.push(' switchport mode access')
                    lines.push(` switchport access vlan ${port.vlan}`)
                    break
                case 'juniper':
                    lines.push(`set interfaces ${ifName} unit 0 family ethernet-switching interface-mode access`)
                    lines.push(`set interfaces ${ifName} unit 0 family ethernet-switching vlan members vlan${port.vlan}`)
                    break
                case 'sonic':
                    lines.push(`config vlan member add ${port.vlan} ${ifName}`)
                    break
                case 'nokia':
                    lines.push(`set / interface ${ifName} subinterface 0 vlan encap untagged`)
                    break
                case 'huawei':
                    lines.push(' port link-type access')
                    lines.push(` port default vlan ${port.vlan}`)
                    break
                case 'hpe':
                    lines.push(` vlan access ${port.vlan}`)
                    break
                case 'mikrotik':
                    lines.push(`/interface bridge vlan add bridge=bridge vlan-ids=${port.vlan} untagged=${ifName}`)
                    break
                case 'extreme':
                    lines.push(`configure vlan vlan${port.vlan} add port ${ifName} untagged`)
                    break
            }
        }
    }
    return lines
}

// ── ASN helpers (2-byte / 4-byte) ──────────────────────────────────────────

/** Convert an ASN to asdot notation (X.Y) — only meaningful for 4-byte ASNs > 65535 */
export function asnToAsdot (asn: number): string {
    if (asn <= 65535) { return String(asn) }
    return `${(asn >>> 16) & 0xFFFF}.${asn & 0xFFFF}`
}

/** True if the ASN is a 4-byte ASN (> 65535) */
export function is4ByteAsn (asn: number): boolean {
    return asn > 65535
}

// ── BGP underlay config helper ─────────────────────────────────────────────

function emitBgpUnderlay (vendorKey: string, ctx: VendorConfigContext): string[] {
    if (!ctx.asn) { return [] }
    const asn = ctx.asn
    const rid = ctx.routerId ?? ''
    const neighbors = ctx.bgpNeighbors ?? []
    const lines: string[] = []

    const is4B = is4ByteAsn(asn)
    const any4B = is4B || neighbors.some(n => is4ByteAsn(n.peerAsn))

    // Split neighbors into iBGP (same ASN) and eBGP (different ASN)
    const ibgpNeighbors = neighbors.filter(n => n.peerAsn === asn)
    const ebgpNeighbors = neighbors.filter(n => n.peerAsn !== asn)
    const isRR = ctx.isRouteReflector === true
    const hasIbgp = ibgpNeighbors.length > 0
    const hasEbgp = ebgpNeighbors.length > 0

    switch (vendorKey) {
        case 'juniper':
            lines.push('')
            lines.push('# BGP underlay')
            if (is4B) { lines.push(`# 4-byte ASN ${asn} (asdot: ${asnToAsdot(asn)})`) }
            if (rid) { lines.push(`set routing-options router-id ${rid}`) }
            lines.push(`set routing-options autonomous-system ${asn}`)
            // iBGP group (route reflector / client)
            if (hasIbgp) {
                lines.push('set protocols bgp group IBGP type internal')
                if (rid) { lines.push(`set protocols bgp group IBGP local-address ${rid}`) }
                lines.push('set protocols bgp group IBGP family inet unicast')
                lines.push('set protocols bgp group IBGP export EXPORT-LOOPBACK')
                if (isRR) {
                    lines.push(`set protocols bgp group IBGP cluster ${rid}`)
                    lines.push('set protocols bgp group IBGP vpn-apply-export')
                }
                for (const n of ibgpNeighbors) {
                    lines.push(`set protocols bgp group IBGP neighbor ${n.ip} description "${n.peerHostname}"`)
                }
            }
            // eBGP group
            if (hasEbgp) {
                lines.push('set protocols bgp group EBGP type external')
                lines.push('set protocols bgp group EBGP export EXPORT-LOOPBACK')
                for (const n of ebgpNeighbors) {
                    lines.push(`set protocols bgp group EBGP neighbor ${n.ip} peer-as ${n.peerAsn}`)
                    lines.push(`set protocols bgp group EBGP neighbor ${n.ip} description "${n.peerHostname}"`)
                }
            }
            // ECMP load balancing
            if (hasEbgp) {
                lines.push('set protocols bgp group EBGP multipath multiple-as')
            }
            if (hasIbgp) {
                lines.push('set protocols bgp group IBGP multipath')
            }
            lines.push('set routing-options forwarding-table export load-balance-policy')
            lines.push('set policy-options policy-statement load-balance-policy then load-balance per-packet')
            lines.push('set policy-options policy-statement EXPORT-LOOPBACK term 1 from protocol direct')
            if (rid) { lines.push(`set policy-options policy-statement EXPORT-LOOPBACK term 1 from route-filter ${rid}/32 exact`) }
            lines.push('set policy-options policy-statement EXPORT-LOOPBACK term 1 then accept')
            break

        case 'sonic':
            lines.push('')
            lines.push('# BGP underlay')
            if (is4B) { lines.push(`# 4-byte ASN ${asn} (asdot: ${asnToAsdot(asn)})`) }
            lines.push(`config router bgp add ${asn}`)
            if (rid) { lines.push(`config router bgp set router-id ${rid}`) }
            for (const n of ibgpNeighbors) {
                lines.push(`config bgp neighbor add ${n.ip} ${asn}`)
                lines.push(`config bgp neighbor activate ${n.ip}`)
                if (isRR) { lines.push(`config bgp neighbor set ${n.ip} route-reflector-client`) }
            }
            for (const n of ebgpNeighbors) {
                lines.push(`config bgp neighbor add ${n.ip} ${n.peerAsn}`)
                lines.push(`config bgp neighbor activate ${n.ip}`)
            }
            break

        case 'arista':
            lines.push('!')
            lines.push('! BGP underlay')
            if (is4B) { lines.push(`! 4-byte ASN ${asn} (asdot: ${asnToAsdot(asn)})`) }
            lines.push('router bgp ' + asn)
            if (rid) { lines.push(`   router-id ${rid}`) }
            // iBGP peer group
            if (hasIbgp) {
                lines.push('   neighbor IBGP peer-group')
                lines.push(`   neighbor IBGP remote-as ${asn}`)
                lines.push('   neighbor IBGP update-source Loopback0')
                lines.push('   neighbor IBGP send-community')
                if (isRR) {
                    lines.push('   neighbor IBGP route-reflector-client')
                    if (rid) { lines.push(`   bgp cluster-id ${rid}`) }
                }
                for (const n of ibgpNeighbors) {
                    lines.push(`   neighbor ${n.ip} peer group IBGP`)
                    lines.push(`   neighbor ${n.ip} description ${n.peerHostname}`)
                }
            }
            // eBGP peer group
            if (hasEbgp) {
                lines.push('   neighbor EBGP peer-group')
                lines.push('   neighbor EBGP send-community')
                for (const n of ebgpNeighbors) {
                    lines.push(`   neighbor ${n.ip} peer group EBGP`)
                    lines.push(`   neighbor ${n.ip} remote-as ${n.peerAsn}`)
                    lines.push(`   neighbor ${n.ip} description ${n.peerHostname}`)
                }
            }
            // ECMP multipath
            if (hasEbgp) { lines.push('   maximum-paths 64 ecmp 64') }
            if (hasIbgp) { lines.push('   maximum-paths 64') }
            lines.push('   address-family ipv4 unicast')
            if (hasIbgp) { lines.push('      neighbor IBGP activate') }
            if (hasEbgp) { lines.push('      neighbor EBGP activate') }
            lines.push('      redistribute connected route-map LOOPBACK')
            lines.push('!')
            lines.push('route-map LOOPBACK permit 10')
            lines.push('   match interface Loopback0')
            lines.push('!')
            break

        case 'nokia':
            lines.push('')
            lines.push('# BGP underlay')
            if (is4B) { lines.push(`# 4-byte ASN ${asn} (asdot: ${asnToAsdot(asn)})`) }
            lines.push(`set / network-instance default protocols bgp autonomous-system ${asn}`)
            if (rid) { lines.push(`set / network-instance default protocols bgp router-id ${rid}`) }
            // iBGP group
            if (hasIbgp) {
                lines.push(`set / network-instance default protocols bgp group IBGP peer-as ${asn}`)
                if (rid) { lines.push(`set / network-instance default protocols bgp group IBGP local-address ${rid}`) }
                lines.push('set / network-instance default protocols bgp group IBGP export-policy EXPORT-LOOPBACK')
                if (isRR) {
                    lines.push('set / network-instance default protocols bgp group IBGP route-reflector client true')
                    if (rid) { lines.push(`set / network-instance default protocols bgp group IBGP route-reflector cluster-id ${rid}`) }
                }
                for (const n of ibgpNeighbors) {
                    lines.push(`set / network-instance default protocols bgp neighbor ${n.ip} peer-group IBGP`)
                    lines.push(`set / network-instance default protocols bgp neighbor ${n.ip} description "${n.peerHostname}"`)
                }
            }
            // eBGP group
            if (hasEbgp) {
                lines.push('set / network-instance default protocols bgp group EBGP export-policy EXPORT-LOOPBACK')
                for (const n of ebgpNeighbors) {
                    lines.push(`set / network-instance default protocols bgp neighbor ${n.ip} peer-as ${n.peerAsn}`)
                    lines.push(`set / network-instance default protocols bgp neighbor ${n.ip} peer-group EBGP`)
                    lines.push(`set / network-instance default protocols bgp neighbor ${n.ip} description "${n.peerHostname}"`)
                }
            }
            lines.push('set / routing-policy policy EXPORT-LOOPBACK statement 10 match protocol direct')
            lines.push('set / routing-policy policy EXPORT-LOOPBACK statement 10 action policy-result accept')
            break

        case 'huawei':
            lines.push('#')
            lines.push('# BGP underlay')
            if (is4B) { lines.push(`# 4-byte ASN ${asn} (asdot: ${asnToAsdot(asn)})`) }
            lines.push(`bgp ${asn}`)
            if (rid) { lines.push(` router-id ${rid}`) }
            for (const n of ibgpNeighbors) {
                lines.push(` peer ${n.ip} as-number ${asn}`)
                lines.push(` peer ${n.ip} connect-interface LoopBack0`)
                lines.push(` peer ${n.ip} description ${n.peerHostname}`)
                if (isRR) { lines.push(` peer ${n.ip} reflect-client`) }
            }
            for (const n of ebgpNeighbors) {
                lines.push(` peer ${n.ip} as-number ${n.peerAsn}`)
                lines.push(` peer ${n.ip} description ${n.peerHostname}`)
            }
            lines.push(' #')
            lines.push(' ipv4-family unicast')
            for (const n of neighbors) {
                lines.push(`  peer ${n.ip} enable`)
            }
            if (rid) { lines.push(`  network ${rid} 255.255.255.255`) }
            lines.push('#')
            break

        case 'mikrotik':
            lines.push('')
            lines.push('# BGP underlay')
            if (is4B) { lines.push(`# 4-byte ASN ${asn} (asdot: ${asnToAsdot(asn)})`) }
            lines.push(`/routing bgp template add name=default as=${asn}${rid ? ' router-id=' + rid : ''}`)
            if (hasIbgp) {
                lines.push(`/routing bgp template add name=ibgp as=${asn}${rid ? ' router-id=' + rid : ''} address-families=ip`)
                for (const n of ibgpNeighbors) {
                    const safeName = n.peerHostname.replace(/[^a-zA-Z0-9_-]/g, '_')
                    lines.push(`/routing bgp connection add name=ibgp_${safeName} remote.address=${n.ip}/32 remote.as=${asn} template=ibgp local.role=${isRR ? 'ibgp-rr' : 'ibgp'}`)
                }
            }
            for (const n of ebgpNeighbors) {
                const safeName = n.peerHostname.replace(/[^a-zA-Z0-9_-]/g, '_')
                lines.push(`/routing bgp connection add name=ebgp_${safeName} remote.address=${n.ip}/32 remote.as=${n.peerAsn} template=default local.role=ebgp address-families=ip`)
            }
            break

        case 'extreme':
            lines.push('')
            lines.push('# BGP underlay')
            if (is4B) { lines.push(`# 4-byte ASN ${asn} (asdot: ${asnToAsdot(asn)})`) }
            lines.push(`configure bgp AS-number ${asn}`)
            if (rid) { lines.push(`configure bgp routerid ${rid}`) }
            for (const n of ibgpNeighbors) {
                lines.push(`create bgp neighbor ${n.ip} remote-AS-number ${asn}`)
                lines.push(`configure bgp neighbor ${n.ip} description "${n.peerHostname}"`)
                if (isRR) { lines.push(`configure bgp neighbor ${n.ip} route-reflector-client`) }
                lines.push(`enable bgp neighbor ${n.ip}`)
            }
            for (const n of ebgpNeighbors) {
                lines.push(`create bgp neighbor ${n.ip} remote-AS-number ${n.peerAsn}`)
                lines.push(`configure bgp neighbor ${n.ip} description "${n.peerHostname}"`)
                lines.push(`enable bgp neighbor ${n.ip}`)
            }
            lines.push('enable bgp')
            break

        default: // cisco / dell / hpe (IOS-style)
            lines.push('!')
            lines.push('! BGP underlay')
            if (is4B) { lines.push(`! 4-byte ASN ${asn} (asdot: ${asnToAsdot(asn)})`) }
            lines.push('router bgp ' + asn)
            if (rid) { lines.push(` bgp router-id ${rid}`) }
            if (isRR && rid) { lines.push(` bgp cluster-id ${rid}`) }
            // iBGP neighbors
            for (const n of ibgpNeighbors) {
                lines.push(` neighbor ${n.ip} remote-as ${asn}`)
                lines.push(` neighbor ${n.ip} update-source Loopback0`)
                lines.push(` neighbor ${n.ip} description ${n.peerHostname}`)
                if (isRR) { lines.push(` neighbor ${n.ip} route-reflector-client`) }
            }
            // eBGP neighbors
            for (const n of ebgpNeighbors) {
                lines.push(` neighbor ${n.ip} remote-as ${n.peerAsn}`)
                lines.push(` neighbor ${n.ip} description ${n.peerHostname}`)
            }
            lines.push(' address-family ipv4 unicast')
            for (const n of neighbors) {
                lines.push(`  neighbor ${n.ip} activate`)
            }
            if (rid) { lines.push(`  network ${rid} mask 255.255.255.255`) }
            lines.push(' exit-address-family')
            lines.push('!')
            break
    }

    return lines
}

// ── EVPN-VXLAN overlay config helper ───────────────────────────────────────

function emitEvpnOverlay (vendorKey: string, ctx: VendorConfigContext): string[] {
    const isSpineRR = ctx.macVrfEnabled && (ctx.nodeRole === 'spine' || ctx.nodeRole === 'super-spine')
    if (!ctx.overlayEnabled || !ctx.asn || (!ctx.vniMappings?.length && !isSpineRR)) { return [] }
    const asn = ctx.asn
    const vtep = ctx.vtepSourceIp ?? ''
    const overlayPeers = ctx.overlayNeighbors ?? []
    const mappings = ctx.vniMappings ?? []
    const lines: string[] = []

    switch (vendorKey) {
        case 'juniper': {
            const isLeaf = ctx.nodeRole === 'leaf' || ctx.nodeRole === 'border-leaf' || ctx.nodeRole === 'tor'
            const isSpine = ctx.nodeRole === 'spine' || ctx.nodeRole === 'super-spine'
            const rid = ctx.routerId ?? vtep

            if (ctx.macVrfEnabled && isLeaf) {
                // ── MAC-VRF mode: per-instance routing-instances ──────────────
                lines.push('')
                lines.push('# EVPN-VXLAN overlay (MAC-VRF)')
                lines.push('set protocols bgp group OVERLAY type internal')
                lines.push(`set protocols bgp group OVERLAY local-address ${vtep}`)
                lines.push('set protocols bgp group OVERLAY family evpn signaling')
                lines.push('set protocols bgp group OVERLAY multipath')
                lines.push('set protocols bgp group OVERLAY bfd-liveness-detection minimum-interval 350')
                lines.push('set protocols bgp group OVERLAY bfd-liveness-detection multiplier 3')
                for (const peer of overlayPeers) {
                    lines.push(`set protocols bgp group OVERLAY neighbor ${peer}`)
                }

                // Group VLANs: "Isolated" prefix → vlan-based (1 VLAN per MAC-VRF)
                // All others → vlan-aware (grouped under one MAC-VRF)
                const isolatedMappings = mappings.filter(m => {
                    const vlan = ctx.vlans.find(v => v.id === m.vlanId)
                    return vlan?.name?.toLowerCase().includes('isolated')
                })
                const sharedMappings = mappings.filter(m => {
                    const vlan = ctx.vlans.find(v => v.id === m.vlanId)
                    return !vlan?.name?.toLowerCase().includes('isolated')
                })

                // Emit vlan-based MAC-VRFs (one per isolated VLAN)
                let rdIdx = 2
                for (const m of isolatedMappings) {
                    const vlan = ctx.vlans.find(v => v.id === m.vlanId)
                    const vrfName = `macvrf-${(vlan?.name ?? `v${m.vlanId}`).toLowerCase().replace(/[^a-z0-9]/g, '-')}`
                    lines.push('')
                    lines.push(`# MAC-VRF: ${vrfName} (vlan-based, isolated)`)
                    lines.push(`set routing-instances ${vrfName} instance-type mac-vrf`)
                    lines.push(`set routing-instances ${vrfName} service-type vlan-based`)
                    lines.push(`set routing-instances ${vrfName} protocols evpn encapsulation vxlan`)
                    lines.push(`set routing-instances ${vrfName} protocols evpn extended-vni-list ${m.vni}`)
                    lines.push(`set routing-instances ${vrfName} protocols evpn default-gateway no-gateway-community`)
                    lines.push(`set routing-instances ${vrfName} vtep-source-interface lo0.0`)
                    lines.push(`set routing-instances ${vrfName} route-distinguisher ${rid}:${rdIdx}`)
                    lines.push(`set routing-instances ${vrfName} vrf-target target:1:${m.vni}`)
                    lines.push(`set routing-instances ${vrfName} vlans v${m.vlanId} vlan-id ${m.vlanId}`)
                    lines.push(`set routing-instances ${vrfName} vlans v${m.vlanId} vxlan vni ${m.vni}`)
                    rdIdx++
                }

                // Emit vlan-aware MAC-VRF (one for all shared VLANs)
                if (sharedMappings.length > 0) {
                    const vrfName = 'macvrf-shared-vlan-aware'
                    lines.push('')
                    lines.push(`# MAC-VRF: ${vrfName} (vlan-aware, grouped)`)
                    lines.push(`set routing-instances ${vrfName} instance-type mac-vrf`)
                    lines.push(`set routing-instances ${vrfName} service-type vlan-aware`)
                    lines.push(`set routing-instances ${vrfName} protocols evpn encapsulation vxlan`)
                    for (const m of sharedMappings) {
                        lines.push(`set routing-instances ${vrfName} protocols evpn extended-vni-list ${m.vni}`)
                    }
                    lines.push(`set routing-instances ${vrfName} protocols evpn default-gateway no-gateway-community`)
                    lines.push(`set routing-instances ${vrfName} vtep-source-interface lo0.0`)
                    lines.push(`set routing-instances ${vrfName} route-distinguisher ${rid}:${rdIdx}`)
                    lines.push(`set routing-instances ${vrfName} vrf-target target:1:${sharedMappings[0]?.vni ?? 50000}`)
                    for (const m of sharedMappings) {
                        lines.push(`set routing-instances ${vrfName} vlans v${m.vlanId} vlan-id ${m.vlanId}`)
                        lines.push(`set routing-instances ${vrfName} vlans v${m.vlanId} vxlan vni ${m.vni}`)
                    }

                    // IRB for shared vlan-aware MAC-VRF
                    if (ctx.irbEnabled) {
                        const gwBase = ctx.irbGatewayBase ?? '10.10'
                        lines.push('')
                        lines.push('# IRB interfaces — distributed anycast gateway (vlan-aware MAC-VRF)')
                        for (const m of sharedMappings) {
                            const gwIp = `${gwBase}.${m.vlanId}.254/24`
                            lines.push(`set interfaces irb unit ${m.vlanId} family inet address ${gwIp}`)
                            lines.push(`set interfaces irb unit ${m.vlanId} mac 00:00:5e:00:53:aa`)
                            lines.push(`set routing-instances ${vrfName} vlans v${m.vlanId} l3-interface irb.${m.vlanId}`)
                        }
                        // Type-5 VRF for inter-VLAN routing — auto-generated.
                        // Suppressed when the template defines explicit VRFs
                        // in ctx.vrfs (RLI 52387): those take precedence,
                        // emitJunosT5Vrfs emits them after this function returns.
                        if (!hasExplicitT5Vrfs(ctx)) {
                            rdIdx++
                            lines.push('')
                            lines.push('# Type-5 VRF for inter-VLAN routing')
                            lines.push('set routing-instances EVPN-VRF instance-type vrf')
                            lines.push(`set routing-instances EVPN-VRF route-distinguisher ${rid}:${rdIdx}`)
                            lines.push(`set routing-instances EVPN-VRF vrf-target target:${asn}:1`)
                            for (const m of sharedMappings) {
                                lines.push(`set routing-instances EVPN-VRF interface irb.${m.vlanId}`)
                            }
                            lines.push('set routing-instances EVPN-VRF protocols evpn ip-prefix-routes advertise direct-nexthop')
                            lines.push('set routing-instances EVPN-VRF protocols evpn ip-prefix-routes encapsulation vxlan')
                            lines.push(`set routing-instances EVPN-VRF protocols evpn ip-prefix-routes vni ${(sharedMappings[0]?.vni ?? 50000) + 9000}`)
                        }
                    }
                }
            } else if (ctx.macVrfEnabled && isSpine) {
                // ── MAC-VRF spine: iBGP route reflector only, no VTEP ──────────
                lines.push('')
                lines.push('# EVPN-VXLAN overlay (spine — iBGP route reflector)')
                lines.push('set protocols bgp group OVERLAY type internal')
                lines.push(`set protocols bgp group OVERLAY local-address ${vtep}`)
                lines.push('set protocols bgp group OVERLAY family evpn signaling')
                lines.push(`set protocols bgp group OVERLAY cluster ${rid}`)
                lines.push('set protocols bgp group OVERLAY multipath')
                lines.push('set protocols bgp group OVERLAY vpn-apply-export')
                for (const peer of overlayPeers) {
                    lines.push(`set protocols bgp group OVERLAY neighbor ${peer}`)
                }
            } else {
                // ── Default-switch mode (standard EVPN-VXLAN) ─────────────────
                lines.push('')
                lines.push('# EVPN-VXLAN overlay')
                lines.push('set protocols evpn encapsulation vxlan')
                lines.push('set protocols evpn extended-vni-list all')
                lines.push('set switch-options vtep-source-interface lo0.0')
                lines.push('set protocols bgp group OVERLAY type internal')
                lines.push(`set protocols bgp group OVERLAY local-address ${vtep}`)
                lines.push('set protocols bgp group OVERLAY family evpn signaling')
                for (const peer of overlayPeers) {
                    lines.push(`set protocols bgp group OVERLAY neighbor ${peer}`)
                }
                for (const m of mappings) {
                    lines.push(`set vlans vlan${m.vlanId} vxlan vni ${m.vni}`)
                }
                // IRB interfaces — ERB (symmetric): on leaves (distributed gateway); CRB (asymmetric): on spines only (centralized gateway)
                // Only tenant VLANs get IRB — skip infrastructure (MGMT, native, underlay: id < 100 or >= 900)
                const irbMappings = mappings.filter(m => m.vlanId >= 100 && m.vlanId < 900)
                const isAsymmetric = ctx.irbMode === 'asymmetric'
                // CRB: IRB only on spines (centralized); ERB: IRB on leaves (distributed)
                const irbOnThisNode = isAsymmetric ? isSpine : isLeaf
                if (ctx.irbEnabled && irbMappings.length && irbOnThisNode) {
                    const gwBase = ctx.irbGatewayBase ?? '192.168'
                    lines.push('')
                    const gwType = isLeaf ? 'distributed anycast' : 'centralized'
                    const routingModel = isAsymmetric ? 'asymmetric' : 'symmetric'
                    lines.push(`# IRB interfaces — ${gwType} gateway (${routingModel} IRB)`)
                    for (const m of irbMappings) {
                        const gwIp = `${gwBase}.${m.vlanId}.1/24`
                        lines.push(`set interfaces irb unit ${m.vlanId} family inet address ${gwIp}`)
                        lines.push(`set interfaces irb unit ${m.vlanId} mac 00:00:5e:00:01:01`)
                        lines.push(`set vlans vlan${m.vlanId} l3-interface irb.${m.vlanId}`)
                    }
                    // Symmetric IRB: L3 VNI + Type-5 VRF for inter-subnet routing
                    // Asymmetric IRB: no VRF needed — all VLANs on all leaves, routing at ingress only
                    // Suppress auto-EVPN-VRF when the template provides explicit T5 VRFs.
                    if (!isAsymmetric && !hasExplicitT5Vrfs(ctx)) {
                        lines.push('# Symmetric IRB — L3 VNI carries inter-subnet traffic')
                        lines.push('set routing-instances EVPN-VRF instance-type vrf')
                        lines.push(`set routing-instances EVPN-VRF route-distinguisher ${rid}:1`)
                        lines.push(`set routing-instances EVPN-VRF vrf-target target:${asn}:1`)
                        for (const m of irbMappings) {
                            lines.push(`set routing-instances EVPN-VRF interface irb.${m.vlanId}`)
                        }
                        lines.push('set routing-instances EVPN-VRF protocols evpn ip-prefix-routes advertise direct-nexthop')
                        lines.push('set routing-instances EVPN-VRF protocols evpn ip-prefix-routes encapsulation vxlan')
                        lines.push(`set routing-instances EVPN-VRF protocols evpn ip-prefix-routes vni ${(ctx.vniMappings?.[0]?.vni ?? 10000) + 9000}`)
                    } else if (isAsymmetric) {
                        lines.push('# Asymmetric IRB — inter-subnet routing at ingress leaf only')
                        lines.push('# All VLANs must be present on all leaves for return traffic bridging')
                    }
                }
                // OISM: Optimized Inter-Subnet Multicast
                if (ctx.oismEnabled && isLeaf) {
                    const suppVni = (ctx.vniMappings?.[0]?.vni ?? 10000) + 8000
                    lines.push('')
                    lines.push('# OISM — Optimized Inter-Subnet Multicast')
                    lines.push('# Supplemental bridge domain for multicast underlay')
                    lines.push(`set vlans __contrail_mc__ vlan-id 4000`)
                    lines.push(`set vlans __contrail_mc__ vxlan vni ${suppVni}`)
                    lines.push('set switch-options vrf-target auto')
                    lines.push('# IGMP snooping in EVPN')
                    lines.push('set protocols igmp-snooping vlan all')
                    lines.push('set protocols igmp-snooping vlan all proxy')
                    lines.push('# EVPN multicast — SMET Type-6 routes')
                    lines.push('set protocols evpn multicast-mode ingress-replication')
                    lines.push('set protocols evpn default-gateway no-gateway-community')
                    lines.push('# Assisted replication — AR leaf role')
                    lines.push('set switch-options vrf-target auto')
                    lines.push('set protocols evpn assisted-replication leaf')
                    // PIM sparse for underlay multicast
                    lines.push('# PIM sparse mode for underlay multicast')
                    lines.push('set protocols pim interface lo0.0')
                    for (const m of mappings) {
                        lines.push(`set protocols pim interface irb.${m.vlanId}`)
                    }
                    lines.push('set protocols pim rp static address 10.0.0.1')
                    lines.push('set protocols pim rp static address 10.0.0.2')
                }
            }
            break
        }

        case 'sonic': {
            const isSonicLeaf = ctx.nodeRole === 'leaf' || ctx.nodeRole === 'border-leaf' || ctx.nodeRole === 'tor'
            const isSonicSpine = ctx.nodeRole === 'spine' || ctx.nodeRole === 'super-spine'
            lines.push('')
            lines.push('# EVPN-VXLAN overlay')
            if (isSonicSpine) {
                // Spine: EVPN RR only — activate overlay peers, no VTEP/VNI
                for (const peer of overlayPeers) {
                    lines.push(`config bgp neighbor activate ${peer} l2vpn_evpn`)
                    lines.push(`config bgp neighbor route-reflector ${peer} l2vpn_evpn`)
                }
            } else {
                // Leaf: full VTEP + VNI + overlay
                lines.push(`config vxlan add vtep vtep1 ${vtep}`)
                lines.push('config vxlan evpn_nvo add nvo1 vtep1')
                for (const m of mappings) {
                    lines.push(`config vxlan map add vtep1 vlan ${m.vlanId} vni ${m.vni}`)
                }
                for (const peer of overlayPeers) {
                    lines.push(`config bgp neighbor activate ${peer} l2vpn_evpn`)
                }
                // IRB — ERB: on leaves; CRB: on spines
                const sonicIrbMappings = mappings.filter(m => m.vlanId >= 100 && m.vlanId < 900)
                const sonicIsAsymmetric = ctx.irbMode === 'asymmetric'
                const sonicIrbOnThisNode = sonicIsAsymmetric ? isSonicSpine : isSonicLeaf
                if (ctx.irbEnabled && sonicIrbMappings.length && sonicIrbOnThisNode) {
                    lines.push('')
                    const gwType = isSonicLeaf ? 'distributed' : 'centralized'
                    lines.push(`# IRB interfaces — ${gwType} gateway`)
                    const gwBase = ctx.irbGatewayBase || '192.168'
                    for (const m of sonicIrbMappings) {
                        lines.push(`config interface vlan add Vlan${m.vlanId}`)
                        lines.push(`config interface ip add Vlan${m.vlanId} ${gwBase}.${m.vlanId}.1/24`)
                    }
                    if (ctx.irbMode === 'symmetric' && sonicIrbMappings.length) {
                        const l3Vni = sonicIrbMappings[0].vni + 9000
                        lines.push(`config vrf add VrfTenant`)
                        lines.push(`config vxlan map add vtep1 vrf VrfTenant vni ${l3Vni}`)
                    }
                }
            }
            break
        }

        case 'arista': {
            const isAristaLeaf = ctx.nodeRole === 'leaf' || ctx.nodeRole === 'border-leaf' || ctx.nodeRole === 'tor'
            const isAristaSpine = ctx.nodeRole === 'spine' || ctx.nodeRole === 'super-spine'
            const aristaRid = ctx.routerId ?? vtep
            const isAristaSymmetric = ctx.irbMode !== 'asymmetric'
            const aristaL3Vni = (mappings[0]?.vni ?? 10000) + 9000

            lines.push('!')
            lines.push('! EVPN-VXLAN overlay')
            // Virtual-router MAC for anycast gateway (global)
            if (ctx.irbEnabled && isAristaLeaf) {
                lines.push('ip virtual-router mac-address 00:1c:73:00:00:01')
                lines.push('!')
            }
            lines.push('interface Vxlan1')
            lines.push('   vxlan source-interface Loopback1')
            lines.push('   vxlan udp-port 4789')
            for (const m of mappings) {
                lines.push(`   vxlan vlan ${m.vlanId} vni ${m.vni}`)
            }
            if (ctx.irbEnabled && isAristaSymmetric && isAristaLeaf) {
                lines.push(`   vxlan vrf TENANT-1 vni ${aristaL3Vni}`)
            }
            lines.push('!')

            // Loopback1 for VTEP (separate from Loopback0 router-id)
            if (isAristaLeaf && vtep) {
                const lo1Octets = vtep.split('.')
                const octet2 = Number(lo1Octets[2]) + 100
                lo1Octets[2] = String(Math.min(octet2, 255))
                lines.push('interface Loopback1')
                lines.push('   description VTEP-Source')
                lines.push(`   ip address ${lo1Octets.join('.')}/32`)
                lines.push('!')
            }

            lines.push('router bgp ' + asn)
            if (aristaRid) { lines.push(`   router-id ${aristaRid}`) }
            if (isAristaSpine) {
                // Spine: EVPN RR
                lines.push('   neighbor OVERLAY peer group')
                lines.push(`   neighbor OVERLAY remote-as ${asn}`)
                lines.push('   neighbor OVERLAY update-source Loopback0')
                lines.push('   neighbor OVERLAY send-community extended')
                lines.push('   neighbor OVERLAY route-reflector-client')
                for (const peer of overlayPeers) {
                    lines.push(`   neighbor ${peer} peer group OVERLAY`)
                }
                lines.push('   address-family evpn')
                lines.push('      neighbor OVERLAY activate')
            } else {
                // Leaf: EVPN client
                lines.push('   neighbor OVERLAY peer group')
                lines.push(`   neighbor OVERLAY remote-as ${asn}`)
                lines.push('   neighbor OVERLAY update-source Loopback0')
                lines.push('   neighbor OVERLAY send-community extended')
                for (const peer of overlayPeers) {
                    lines.push(`   neighbor ${peer} peer group OVERLAY`)
                }
                lines.push('   address-family evpn')
                lines.push('      neighbor OVERLAY activate')
                lines.push('!')
                for (const m of mappings) {
                    lines.push(`   vlan ${m.vlanId}`)
                    lines.push('      rd auto')
                    lines.push(`      route-target both ${asn}:${m.vni}`)
                    lines.push('      redistribute learned')
                }
                // VRF for symmetric IRB
                if (ctx.irbEnabled && isAristaSymmetric) {
                    lines.push(`   vrf TENANT-1`)
                    lines.push(`      rd ${aristaRid}:1`)
                    lines.push(`      route-target import evpn ${asn}:${aristaL3Vni}`)
                    lines.push(`      route-target export evpn ${asn}:${aristaL3Vni}`)
                    lines.push('      redistribute connected')
                }
            }
            lines.push('!')

            // IRB interfaces — ERB (symmetric): on leaves; CRB (asymmetric): on spines
            const aristaIrbMappings = mappings.filter(m => m.vlanId >= 100 && m.vlanId < 900)
            const aristaIsAsymmetric = ctx.irbMode === 'asymmetric'
            const aristaIrbOnThisNode = aristaIsAsymmetric ? isAristaSpine : isAristaLeaf
            if (ctx.irbEnabled && aristaIrbMappings.length && aristaIrbOnThisNode) {
                const gwBase = ctx.irbGatewayBase ?? '192.168'
                const gwType = isAristaLeaf ? 'distributed anycast' : 'centralized'
                lines.push(`! IRB interfaces — ${gwType} gateway`)
                for (const m of aristaIrbMappings) {
                    const gwIp = `${gwBase}.${m.vlanId}.1/24`
                    lines.push(`interface Vlan${m.vlanId}`)
                    if (isAristaSymmetric) { lines.push('   vrf TENANT-1') }
                    lines.push(`   ip address virtual ${gwIp}`)
                    lines.push('   no shutdown')
                    lines.push('!')
                }
                // VRF instance
                if (isAristaSymmetric) {
                    lines.push('vrf instance TENANT-1')
                    lines.push('!')
                }
            }
            break
        }

        case 'nokia': {
            const isNokiaLeaf = ctx.nodeRole === 'leaf' || ctx.nodeRole === 'border-leaf' || ctx.nodeRole === 'tor'
            const isNokiaSpine = ctx.nodeRole === 'spine' || ctx.nodeRole === 'super-spine'
            const nokiaRid = ctx.routerId ?? vtep

            lines.push('')
            lines.push('# EVPN-VXLAN overlay')
            lines.push('set / tunnel-interface vxlan1 vxlan-interface 0 type bridged')
            lines.push('set / tunnel-interface vxlan1 vxlan-interface 0 ingress vni 0')

            const nokiaIsAsymmetric = ctx.irbMode === 'asymmetric'
            const nokiaIrbMappings = mappings.filter(m => m.vlanId >= 100 && m.vlanId < 900)
            // CRB: VNI + IRB on spines; ERB: VNI + IRB on leaves
            const nokiaHasVni = nokiaIsAsymmetric ? (isNokiaLeaf || isNokiaSpine) : isNokiaLeaf
            const nokiaIrbOnThisNode = nokiaIsAsymmetric ? isNokiaSpine : isNokiaLeaf

            if (nokiaHasVni) {
                for (const m of mappings) {
                    lines.push(`set / network-instance vlan${m.vlanId} type mac-vrf`)
                    lines.push(`set / network-instance vlan${m.vlanId} vxlan-interface vxlan1.0`)
                    lines.push(`set / network-instance vlan${m.vlanId} protocols bgp-evpn bgp-instance 1 admin-state enable`)
                    lines.push(`set / network-instance vlan${m.vlanId} protocols bgp-evpn bgp-instance 1 vxlan-interface vxlan1.0`)
                    lines.push(`set / network-instance vlan${m.vlanId} protocols bgp-evpn bgp-instance 1 evi ${m.vlanId}`)
                    lines.push(`set / network-instance vlan${m.vlanId} protocols bgp-evpn bgp-instance 1 ecmp 2`)
                    lines.push(`set / network-instance vlan${m.vlanId} protocols bgp-evpn bgp-instance 1 vxlan-interface vxlan1.0 ingress-vni ${m.vni}`)
                }
                // IRB interfaces — ERB: on leaves; CRB: on spines
                if (ctx.irbEnabled && nokiaIrbMappings.length && nokiaIrbOnThisNode) {
                    const gwBase = ctx.irbGatewayBase ?? '192.168'
                    const gwType = isNokiaLeaf ? 'distributed anycast' : 'centralized'
                    lines.push('')
                    lines.push(`# IRB interfaces — ${gwType} gateway`)
                    lines.push('set / network-instance ip-vrf-1 type ip-vrf')
                    lines.push(`set / network-instance ip-vrf-1 protocols bgp-evpn bgp-instance 1 admin-state enable`)
                    lines.push(`set / network-instance ip-vrf-1 protocols bgp-evpn bgp-instance 1 vxlan-interface vxlan1.0`)
                    lines.push(`set / network-instance ip-vrf-1 protocols bgp-evpn bgp-instance 1 evi 1000`)
                    for (const m of nokiaIrbMappings) {
                        const gwIp = `${gwBase}.${m.vlanId}.1/24`
                        lines.push(`set / interface irb0 subinterface ${m.vlanId} ipv4 admin-state enable`)
                        lines.push(`set / interface irb0 subinterface ${m.vlanId} ipv4 address ${gwIp}`)
                        lines.push(`set / interface irb0 subinterface ${m.vlanId} anycast-gw mac 00:00:5e:00:01:01`)
                        lines.push(`set / interface irb0 subinterface ${m.vlanId} anycast-gw virtual-router-id 1`)
                        lines.push(`set / network-instance vlan${m.vlanId} interface irb0.${m.vlanId}`)
                        lines.push(`set / network-instance ip-vrf-1 interface irb0.${m.vlanId}`)
                    }
                }
            }

            // BGP overlay
            lines.push('')
            lines.push(`set / network-instance default protocols bgp group OVERLAY peer-as ${asn}`)
            lines.push(`set / network-instance default protocols bgp group OVERLAY local-address ${vtep}`)
            lines.push('set / network-instance default protocols bgp group OVERLAY afi-safi evpn admin-state enable')
            if (isNokiaSpine) {
                lines.push('set / network-instance default protocols bgp group OVERLAY route-reflector client true')
                lines.push(`set / network-instance default protocols bgp group OVERLAY route-reflector cluster-id ${nokiaRid}`)
            }
            for (const peer of overlayPeers) {
                lines.push(`set / network-instance default protocols bgp neighbor ${peer} peer-group OVERLAY`)
            }
            break
        }

        case 'huawei': {
            const isHuaweiLeaf = ctx.nodeRole === 'leaf' || ctx.nodeRole === 'border-leaf' || ctx.nodeRole === 'tor'
            const isHuaweiSpine = ctx.nodeRole === 'spine' || ctx.nodeRole === 'super-spine'
            lines.push('#')
            lines.push('# EVPN-VXLAN overlay')
            if (isHuaweiSpine) {
                // Spine: EVPN RR only — no bridge-domains, no NVE, no VNI
                lines.push(`bgp ${asn}`)
                for (const peer of overlayPeers) {
                    lines.push(` peer ${peer} as-number ${asn}`)
                    lines.push(` peer ${peer} connect-interface LoopBack0`)
                    lines.push(` peer ${peer} reflect-client`)
                }
                lines.push(' #')
                lines.push(' l2vpn-family evpn')
                for (const peer of overlayPeers) {
                    lines.push(`  peer ${peer} enable`)
                    lines.push(`  peer ${peer} reflect-client`)
                }
                lines.push('#')
            } else {
                // Leaf: full bridge-domain + NVE + VNI
                lines.push('ip vpn-instance EVPN')
                for (const m of mappings) {
                    lines.push(`bridge-domain ${m.vlanId}`)
                    lines.push(` vxlan vni ${m.vni}`)
                    lines.push(` evpn`)
                    lines.push(`  route-distinguisher auto`)
                    lines.push(`  vpn-target ${asn}:${m.vni} export-extcommunity`)
                    lines.push(`  vpn-target ${asn}:${m.vni} import-extcommunity`)
                }
                lines.push('#')
                lines.push('interface Nve1')
                lines.push(` source ${vtep}`)
                for (const m of mappings) {
                    lines.push(` vni ${m.vni} head-end peer-list protocol bgp`)
                }
                lines.push('#')
                lines.push(`bgp ${asn}`)
                for (const peer of overlayPeers) {
                    lines.push(` peer ${peer} as-number ${asn}`)
                    lines.push(` peer ${peer} connect-interface LoopBack0`)
                }
                lines.push(' #')
                lines.push(' l2vpn-family evpn')
                for (const peer of overlayPeers) {
                    lines.push(`  peer ${peer} enable`)
                }
                // IRB — ERB: on leaves; CRB: on spines
                const hwIrbMappings = mappings.filter(m => m.vlanId >= 100 && m.vlanId < 900)
                const hwIsAsymmetric = ctx.irbMode === 'asymmetric'
                const hwIrbOnThisNode = hwIsAsymmetric ? isHuaweiSpine : isHuaweiLeaf
                if (ctx.irbEnabled && hwIrbMappings.length && hwIrbOnThisNode) {
                    const gwType = isHuaweiLeaf ? 'distributed' : 'centralized'
                    lines.push('#')
                    lines.push(`# IRB interfaces — ${gwType} gateway`)
                    const gwBase = ctx.irbGatewayBase || '192.168'
                    for (const m of hwIrbMappings) {
                        lines.push(`interface Vlanif${m.vlanId}`)
                        lines.push(` ip address ${gwBase}.${m.vlanId}.1 255.255.255.0`)
                        lines.push(` vxlan anycast-gateway enable`)
                        lines.push(` arp collect host enable`)
                    }
                    if (ctx.irbMode === 'symmetric' && hwIrbMappings.length) {
                        const l3Vni = hwIrbMappings[0].vni + 9000
                        lines.push('#')
                        lines.push('ip vpn-instance TENANT')
                        lines.push(` vxlan vni ${l3Vni}`)
                    }
                }
                lines.push('#')
            }
            break
        }

        case 'mikrotik': {
            const isMtLeaf = ctx.nodeRole === 'leaf' || ctx.nodeRole === 'border-leaf' || ctx.nodeRole === 'tor'
            const isMtSpine = ctx.nodeRole === 'spine' || ctx.nodeRole === 'super-spine'
            lines.push('')
            lines.push('# EVPN-VXLAN overlay')
            if (isMtSpine) {
                // Spine: BGP EVPN RR only
                lines.push(`/routing bgp template add name=evpn as=${asn} address-families=l2vpn-evpn router-id=${vtep}`)
                for (const peer of overlayPeers) {
                    lines.push(`/routing bgp connection add name=overlay-${peer.split('.').pop()} template=evpn remote.address=${peer} local.role=ibgp-rr`)
                }
            } else {
                // Leaf: full VXLAN bridge
                lines.push(`/interface vxlan add name=vxlan1 vni=0 vteps-ip-version=ipv4`)
                for (const m of mappings) {
                    lines.push(`/interface vxlan vni add vxlan=vxlan1 vni=${m.vni}`)
                }
                lines.push('/interface bridge add name=bridge-evpn vlan-filtering=yes')
                for (const m of mappings) {
                    lines.push(`/interface bridge vlan add bridge=bridge-evpn vlan-ids=${m.vlanId} tagged=vxlan1`)
                }
                lines.push(`/routing bgp template add name=evpn as=${asn} address-families=l2vpn-evpn`)
                for (const peer of overlayPeers) {
                    lines.push(`/routing bgp connection add name=overlay_${peer.replace(/\./g, '_')} remote.address=${peer}/32 template=evpn local.role=ibgp`)
                }
            }
            break
        }

        case 'extreme': {
            const isExtLeaf = ctx.nodeRole === 'leaf' || ctx.nodeRole === 'border-leaf' || ctx.nodeRole === 'tor'
            const isExtSpine = ctx.nodeRole === 'spine' || ctx.nodeRole === 'super-spine'
            lines.push('')
            lines.push('# EVPN-VXLAN overlay')
            if (isExtSpine) {
                // Spine: EVPN RR only
                lines.push(`configure bgp router-id ${vtep}`)
                for (const peer of overlayPeers) {
                    lines.push(`create bgp neighbor ${peer} remote-AS ${asn}`)
                    lines.push(`configure bgp neighbor ${peer} route-reflector-client`)
                    lines.push(`enable bgp neighbor ${peer} capability l2vpn-EVPN`)
                }
            } else {
                // Leaf: full VXLAN virtual-network
                lines.push(`create virtual-router vr-evpn`)
                for (const m of mappings) {
                    lines.push(`create virtual-network vn${m.vni} flood-mode standard`)
                    lines.push(`configure virtual-network vn${m.vni} vxlan vni ${m.vni}`)
                    lines.push(`configure virtual-network vn${m.vni} add vlan vlan${m.vlanId}`)
                }
                if (vtep) { lines.push(`configure virtual-network global vtep source-address ${vtep}`) }
                for (const peer of overlayPeers) {
                    lines.push(`create bgp neighbor ${peer} remote-AS-number ${asn}`)
                    lines.push(`configure bgp neighbor ${peer} capability l2vpn-EVPN`)
                    lines.push(`enable bgp neighbor ${peer}`)
                }
            }
            break
        }

        default: { // cisco / dell / hpe (IOS/NX-OS style)
            const isNxLeaf = ctx.nodeRole === 'leaf' || ctx.nodeRole === 'border-leaf' || ctx.nodeRole === 'tor'
            const isNxSpine = ctx.nodeRole === 'spine' || ctx.nodeRole === 'super-spine'
            const isSymmetric = ctx.irbMode !== 'asymmetric'
            const l3Vni = (mappings[0]?.vni ?? 10000) + 9000
            const gwBase = ctx.irbGatewayBase ?? '192.168'

            lines.push('!')
            lines.push('! EVPN-VXLAN overlay')
            // VLAN-to-VNI mapping
            for (const m of mappings) {
                lines.push(`vlan ${m.vlanId}`)
                lines.push(`  vn-segment ${m.vni}`)
            }
            // L3 VNI VLAN for symmetric routing
            if (ctx.irbEnabled && isSymmetric && isNxLeaf) {
                lines.push('vlan 3000')
                lines.push('  name L3VNI-Transit')
                lines.push(`  vn-segment ${l3Vni}`)
            }
            lines.push('!')

            // NVE interface (source from loopback1 — best practice)
            lines.push('interface nve1')
            lines.push('  no shutdown')
            lines.push('  source-interface loopback1')
            lines.push('  host-reachability protocol bgp')
            for (const m of mappings) {
                lines.push(`  member vni ${m.vni}`)
                lines.push('    suppress-arp')
                lines.push('    ingress-replication protocol bgp')
            }
            if (ctx.irbEnabled && isSymmetric && isNxLeaf) {
                lines.push(`  member vni ${l3Vni} associate-vrf`)
            }
            lines.push('!')

            // IRB — ERB (symmetric): on leaves; CRB (asymmetric): on spines
            const nxIrbMappings = mappings.filter(m => m.vlanId >= 100 && m.vlanId < 900)
            const nxIsAsymmetric = ctx.irbMode === 'asymmetric'
            const nxIrbOnThisNode = nxIsAsymmetric ? isNxSpine : isNxLeaf
            if (ctx.irbEnabled && nxIrbMappings.length && nxIrbOnThisNode) {
                const gwType = isNxLeaf ? 'Distributed' : 'Centralized'
                lines.push(`! ${gwType} anycast gateway`)
                for (const m of nxIrbMappings) {
                    const gwIp = `${gwBase}.${m.vlanId}.1/24`
                    lines.push(`interface Vlan${m.vlanId}`)
                    lines.push('  no shutdown')
                    lines.push(`  ip address ${gwIp}`)
                    lines.push('  fabric forwarding mode anycast-gateway')
                    lines.push('!')
                }
                // L3 VNI SVI for symmetric routing
                if (isSymmetric) {
                    lines.push('! L3 VNI for symmetric inter-subnet routing')
                    lines.push('vrf context TENANT-1')
                    lines.push(`  vni ${l3Vni}`)
                    lines.push(`  rd auto`)
                    lines.push('  address-family ipv4 unicast')
                    lines.push('    route-target both auto')
                    lines.push('    route-target both auto evpn')
                    lines.push('!')
                    lines.push('interface Vlan3000')
                    lines.push('  no shutdown')
                    lines.push('  vrf member TENANT-1')
                    lines.push('  ip forward')
                    lines.push('  no ip redirects')
                    lines.push('!')
                    for (const m of nxIrbMappings) {
                        lines.push(`interface Vlan${m.vlanId}`)
                        lines.push('  vrf member TENANT-1')
                        lines.push('!')
                    }
                }
            }

            // BGP overlay
            lines.push(`router bgp ${asn}`)
            if (isNxSpine) {
                lines.push('  address-family l2vpn evpn')
                lines.push('    retain route-target all')
                for (const peer of overlayPeers) {
                    lines.push(`  neighbor ${peer}`)
                    lines.push(`    remote-as ${asn}`)
                    lines.push('    update-source loopback0')
                    lines.push('    address-family l2vpn evpn')
                    lines.push('      send-community extended')
                    lines.push('      route-reflector-client')
                }
            } else {
                lines.push('  address-family l2vpn evpn')
                for (const peer of overlayPeers) {
                    lines.push(`  neighbor ${peer}`)
                    lines.push(`    remote-as ${asn}`)
                    lines.push('    update-source loopback0')
                    lines.push('    address-family l2vpn evpn')
                    lines.push('      send-community extended')
                }
                // EVPN VNI config
                lines.push('  evpn')
                for (const m of mappings) {
                    lines.push(`    vni ${m.vni} l2`)
                    lines.push('      rd auto')
                    lines.push('      route-target import auto')
                    lines.push('      route-target export auto')
                }
            }
            lines.push('!')
            break
        }
    }

    return lines
}

// ── OSPF underlay ─────────────────────────────────────────────────────────

/** Format OSPF area as dotted-quad (e.g. 0→0.0.0.0, 1→0.0.0.1, 256→0.0.1.0) */
function ospfAreaDotted (area: number): string {
    return [
        (area >>> 24) & 0xFF,
        (area >>> 16) & 0xFF,
        (area >>> 8) & 0xFF,
        area & 0xFF,
    ].join('.')
}

function emitOspfUnderlay (vendorKey: string, ctx: VendorConfigContext, isV3: boolean): string[] {
    if (ctx.ospfArea == null && !ctx.ospfInterfaces?.length) { return [] }
    const rid = ctx.routerId ?? ''
    const ifaces = ctx.ospfInterfaces ?? []
    const proto = isV3 ? 'ospf3' : 'ospf'
    const lines: string[] = []

    switch (vendorKey) {
        case 'juniper':
            lines.push('')
            lines.push(`# ${isV3 ? 'OSPFv3' : 'OSPF'} underlay`)
            if (rid) { lines.push(`set routing-options router-id ${rid}`) }
            // loopback in node's own area
            if (rid) {
                const loArea = ospfAreaDotted(ctx.ospfArea ?? 0)
                lines.push(`set protocols ${proto} area ${loArea} interface lo0.0 passive`)
            }
            // group interfaces by area
            const areaMap = new Map<number, OspfInterface[]>()
            for (const iface of ifaces) {
                const list = areaMap.get(iface.area) ?? []
                list.push(iface)
                areaMap.set(iface.area, list)
            }
            for (const [area, ports] of areaMap) {
                const ad = ospfAreaDotted(area)
                for (const p of ports) {
                    const ifName = p.portLabel.replace(/\//g, '/') + '.0'
                    if (p.passive) {
                        lines.push(`set protocols ${proto} area ${ad} interface ${ifName} passive`)
                    } else {
                        lines.push(`set protocols ${proto} area ${ad} interface ${ifName}`)
                    }
                }
            }
            // export loopback into OSPF
            if (rid) {
                lines.push(`set policy-options policy-statement EXPORT-LOOPBACK term 1 from protocol direct`)
                lines.push(`set policy-options policy-statement EXPORT-LOOPBACK term 1 from route-filter ${rid}/32 exact`)
                lines.push(`set policy-options policy-statement EXPORT-LOOPBACK term 1 then accept`)
                lines.push(`set protocols ${proto} export EXPORT-LOOPBACK`)
            }
            break

        case 'arista':
            lines.push('')
            lines.push(`! ${isV3 ? 'OSPFv3' : 'OSPF'} underlay`)
            lines.push(`router ${isV3 ? 'ospfv3' : 'ospf'} 1`)
            if (rid) { lines.push(`   router-id ${rid}`) }
            lines.push('   max-lsa 12000')
            lines.push('!')
            if (rid) { lines.push(`interface Loopback0`) ; lines.push(`   ip ${isV3 ? 'ospfv3' : 'ospf'} area ${ospfAreaDotted(ctx.ospfArea ?? 0)}`) }
            for (const p of ifaces) {
                lines.push(`interface ${p.portLabel}`)
                lines.push(`   ip ${isV3 ? 'ospfv3' : 'ospf'} area ${ospfAreaDotted(p.area)}`)
                lines.push(`   ${isV3 ? 'ipv6 ospfv3' : 'ip ospf'} network point-to-point`)
            }
            break

        case 'sonic':
            lines.push('')
            lines.push(`# ${isV3 ? 'OSPFv3' : 'OSPF'} underlay`)
            if (rid) { lines.push(`config router ospf set router-id ${rid}`) }
            if (rid) { lines.push(`config router ospf add network Loopback0 area ${ospfAreaDotted(ctx.ospfArea ?? 0)}`) }
            for (const p of ifaces) {
                lines.push(`config router ospf add network ${p.portLabel} area ${ospfAreaDotted(p.area)}`)
            }
            break

        case 'nokia':
            lines.push('')
            lines.push(`# ${isV3 ? 'OSPFv3' : 'OSPF'} underlay`)
            lines.push(`set / network-instance default protocols ${isV3 ? 'ospfv3' : 'ospf'} instance 1 admin-state enable`)
            if (rid) { lines.push(`set / network-instance default protocols ${isV3 ? 'ospfv3' : 'ospf'} instance 1 router-id ${rid}`) }
            for (const p of ifaces) {
                lines.push(`set / network-instance default protocols ${isV3 ? 'ospfv3' : 'ospf'} instance 1 area ${ospfAreaDotted(p.area)} interface ${p.portLabel}.0 admin-state enable`)
            }
            if (rid) {
                lines.push(`set / network-instance default protocols ${isV3 ? 'ospfv3' : 'ospf'} instance 1 area ${ospfAreaDotted(ctx.ospfArea ?? 0)} interface system0.0 passive true`)
            }
            break

        case 'huawei':
            lines.push('#')
            lines.push(`# ${isV3 ? 'OSPFv3' : 'OSPF'} underlay`)
            lines.push(`${isV3 ? 'ospfv3' : 'ospf'} 1 router-id ${rid || '0.0.0.0'}`)
            if (rid) {
                lines.push(` area ${ospfAreaDotted(ctx.ospfArea ?? 0)}`)
                lines.push(`  network ${rid} 0.0.0.0`)
            }
            for (const p of ifaces) {
                lines.push(` area ${ospfAreaDotted(p.area)}`)
            }
            lines.push('#')
            if (rid) {
                lines.push('interface LoopBack0')
                lines.push(` ${isV3 ? 'ospfv3' : 'ospf'} enable 1 area ${ospfAreaDotted(ctx.ospfArea ?? 0)}`)
                lines.push('#')
            }
            for (const p of ifaces) {
                lines.push(`interface ${p.portLabel}`)
                lines.push(` ${isV3 ? 'ospfv3' : 'ospf'} enable 1 area ${ospfAreaDotted(p.area)}`)
                lines.push(` ospf network-type p2p`)
                lines.push('#')
            }
            break

        case 'mikrotik':
            lines.push('')
            lines.push(`# ${isV3 ? 'OSPFv3' : 'OSPF'} underlay`)
            lines.push(`/routing ospf instance add name=default${rid ? ' router-id=' + rid : ''}`)
            {
                const areaSet = new Set<number>()
                for (const p of ifaces) { areaSet.add(p.area) }
                if (ctx.ospfArea != null) { areaSet.add(ctx.ospfArea) }
                for (const area of areaSet) {
                    const aName = area === 0 ? 'backbone' : `area${area}`
                    lines.push(`/routing ospf area add name=${aName} instance=default area-id=${ospfAreaDotted(area)}`)
                }
            }
            if (rid) {
                const loAreaName = (ctx.ospfArea ?? 0) === 0 ? 'backbone' : `area${ctx.ospfArea}`
                lines.push(`/routing ospf interface-template add interfaces=loopback area=${loAreaName} passive`)
            }
            for (const p of ifaces) {
                const aName = p.area === 0 ? 'backbone' : `area${p.area}`
                lines.push(`/routing ospf interface-template add interfaces=${p.portLabel} area=${aName} type=ptp`)
            }
            break

        case 'extreme':
            lines.push('')
            lines.push(`# ${isV3 ? 'OSPFv3' : 'OSPF'} underlay`)
            if (rid) { lines.push(`configure ospf routerid ${rid}`) }
            {
                const exAreaSet = new Set<number>()
                for (const p of ifaces) { exAreaSet.add(p.area) }
                if (ctx.ospfArea != null) { exAreaSet.add(ctx.ospfArea) }
                for (const area of exAreaSet) {
                    if (area !== 0) { lines.push(`create ospf area ${ospfAreaDotted(area)}`) }
                }
            }
            if (rid) {
                lines.push(`configure ospf add vlan Loopback area ${ospfAreaDotted(ctx.ospfArea ?? 0)}`)
            }
            for (const p of ifaces) {
                lines.push(`configure ospf add vlan port_${p.portLabel.replace(/[:/]/g, '_')} area ${ospfAreaDotted(p.area)}`)
            }
            lines.push('enable ospf')
            break

        default: // cisco / dell / hpe (IOS-style)
            lines.push('!')
            lines.push(`! ${isV3 ? 'OSPFv3' : 'OSPF'} underlay`)
            lines.push(`router ${isV3 ? 'ospfv3' : 'ospf'} 1`)
            if (rid) { lines.push(` router-id ${rid}`) }
            if (rid) { lines.push(` passive-interface Loopback0`) }
            lines.push('!')
            if (rid) {
                lines.push('interface Loopback0')
                lines.push(` ip ${isV3 ? 'ospfv3 1' : 'ospf 1'} area ${ospfAreaDotted(ctx.ospfArea ?? 0)}`)
                lines.push('!')
            }
            for (const p of ifaces) {
                lines.push(`interface ${p.portLabel}`)
                lines.push(` ip ${isV3 ? 'ospfv3 1' : 'ospf 1'} area ${ospfAreaDotted(p.area)}`)
                lines.push(` ${isV3 ? 'ipv6 ospfv3' : 'ip ospf'} network point-to-point`)
            }
            lines.push('!')
            break
    }

    return lines
}

// ── IS-IS underlay ────────────────────────────────────────────────────────

/** Derive IS-IS NET address from loopback IP (e.g. 10.0.0.1 → 49.0001.0100.0000.0001.00) */
function ipToIsisNet (ip: string): string {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) { return '' }
    // Pad each octet to 3 digits, concatenate, then group as 4-char segments
    const padded = parts.map(p => String(p).padStart(3, '0')).join('')   // 12 digits
    const sysId = `${padded.slice(0, 4)}.${padded.slice(4, 8)}.${padded.slice(8, 12)}`
    return `49.0001.${sysId}.00`
}

function emitIsisUnderlay (vendorKey: string, ctx: VendorConfigContext): string[] {
    if (ctx.isisLevel == null && !ctx.isisInterfaces?.length) { return [] }
    const rid = ctx.routerId ?? ''
    const ifaces = ctx.isisInterfaces ?? []
    const nodeLevel = ctx.isisLevel ?? 2
    const net = ctx.isisNet ?? (rid ? ipToIsisNet(rid) : '')
    const lines: string[] = []

    switch (vendorKey) {
        case 'juniper':
            lines.push('')
            lines.push('# IS-IS underlay')
            if (rid) { lines.push(`set routing-options router-id ${rid}`) }
            // ISO address on loopback for IS-IS
            if (net) { lines.push(`set interfaces lo0 unit 0 family iso address ${net}`) }
            // Enable family iso on fabric interfaces (required for IS-IS adjacency)
            for (const p of ifaces) {
                lines.push(`set interfaces ${p.portLabel} unit 0 family iso`)
            }
            lines.push('set protocols isis level 2 wide-metrics-only')
            // Disable unused levels
            if (nodeLevel === 1) { lines.push('set protocols isis level 2 disable') }
            if (nodeLevel === 2) { lines.push('set protocols isis level 1 disable') }
            // loopback passive
            lines.push('set protocols isis interface lo0.0 passive')
            // fabric interfaces with BFD
            for (const p of ifaces) {
                const ifName = p.portLabel.replace(/\//g, '/') + '.0'
                lines.push(`set protocols isis interface ${ifName} point-to-point`)
                lines.push(`set protocols isis interface ${ifName} bfd-liveness-detection minimum-interval 300`)
                lines.push(`set protocols isis interface ${ifName} bfd-liveness-detection multiplier 3`)
                if (p.level === 1) {
                    lines.push(`set protocols isis interface ${ifName} level 2 disable`)
                } else if (p.level === 2) {
                    lines.push(`set protocols isis interface ${ifName} level 1 disable`)
                }
            }
            // Microloop avoidance
            lines.push('set protocols isis spf-options microloop-prevention')
            // export loopback
            if (rid) {
                lines.push(`set policy-options policy-statement EXPORT-LOOPBACK term 1 from protocol direct`)
                lines.push(`set policy-options policy-statement EXPORT-LOOPBACK term 1 from route-filter ${rid}/32 exact`)
                lines.push(`set policy-options policy-statement EXPORT-LOOPBACK term 1 then accept`)
                lines.push('set protocols isis export EXPORT-LOOPBACK')
            }
            break

        case 'arista':
            lines.push('')
            lines.push('! IS-IS underlay')
            lines.push('router isis UNDERLAY')
            if (net) { lines.push(`   net ${net}`) }
            lines.push('   is-type ' + (nodeLevel === 1 ? 'level-1' : nodeLevel === 2 ? 'level-2-only' : 'level-1-2'))
            lines.push('   address-family ipv4 unicast')
            lines.push('!')
            if (rid) { lines.push('interface Loopback0') ; lines.push('   isis enable UNDERLAY') ; lines.push('   isis passive') }
            for (const p of ifaces) {
                lines.push(`interface ${p.portLabel}`)
                lines.push('   isis enable UNDERLAY')
                lines.push('   isis network point-to-point')
            }
            break

        case 'sonic':
            lines.push('')
            lines.push('# IS-IS underlay')
            lines.push('config router isis add UNDERLAY')
            if (net) { lines.push(`config router isis set UNDERLAY net ${net}`) }
            lines.push(`config router isis set UNDERLAY is-type ${nodeLevel === 1 ? 'level-1' : nodeLevel === 2 ? 'level-2-only' : 'level-1-2'}`)
            if (rid) { lines.push('config router isis interface add UNDERLAY Loopback0') }
            for (const p of ifaces) {
                lines.push(`config router isis interface add UNDERLAY ${p.portLabel}`)
            }
            break

        case 'nokia':
            lines.push('')
            lines.push('# IS-IS underlay')
            lines.push('set / network-instance default protocols isis instance ISIS1 admin-state enable')
            if (net) { lines.push(`set / network-instance default protocols isis instance ISIS1 net [ ${net} ]`) }
            lines.push(`set / network-instance default protocols isis instance ISIS1 level-capability ${nodeLevel === 1 ? 'L1' : nodeLevel === 2 ? 'L2' : 'L1L2'}`)
            if (rid) { lines.push('set / network-instance default protocols isis instance ISIS1 interface system0.0 passive true') }
            for (const p of ifaces) {
                lines.push(`set / network-instance default protocols isis instance ISIS1 interface ${p.portLabel}.0 admin-state enable`)
                lines.push(`set / network-instance default protocols isis instance ISIS1 interface ${p.portLabel}.0 circuit-type point-to-point`)
            }
            break

        case 'huawei':
            lines.push('#')
            lines.push('# IS-IS underlay')
            lines.push('isis 1')
            if (net) { lines.push(` network-entity ${net}`) }
            lines.push(` is-level ${nodeLevel === 1 ? 'level-1' : nodeLevel === 2 ? 'level-2' : 'level-1-2'}`)
            lines.push(' cost-style wide')
            lines.push('#')
            if (rid) {
                lines.push('interface LoopBack0')
                lines.push(' isis enable 1')
                lines.push(' isis silent')
                lines.push('#')
            }
            for (const p of ifaces) {
                lines.push(`interface ${p.portLabel}`)
                lines.push(' isis enable 1')
                lines.push(' isis circuit-type p2p')
                if (p.level === 1) { lines.push(' isis circuit-level level-1') }
                else if (p.level === 2) { lines.push(' isis circuit-level level-2') }
                lines.push('#')
            }
            break

        case 'mikrotik':
            lines.push('')
            lines.push('# IS-IS underlay')
            lines.push('# Note: RouterOS IS-IS support requires routing-test package')
            lines.push(`/routing isis instance add name=default${rid ? ' router-id=' + rid : ''}`)
            if (net) { lines.push(`/routing isis instance set default net=${net}`) }
            lines.push(`/routing isis instance set default is-type=${nodeLevel === 1 ? 'level-1' : nodeLevel === 2 ? 'level-2' : 'level-1-2'}`)
            if (rid) { lines.push('/routing isis interface-template add interfaces=loopback instance=default passive') }
            for (const p of ifaces) {
                lines.push(`/routing isis interface-template add interfaces=${p.portLabel} instance=default circuit-type=p2p`)
            }
            break

        case 'extreme':
            lines.push('')
            lines.push('# IS-IS underlay')
            lines.push('create isis area ISIS1')
            if (net) { lines.push(`configure isis area ISIS1 add area-address ${net}`) }
            lines.push(`configure isis area ISIS1 is-type ${nodeLevel === 1 ? 'level-1' : nodeLevel === 2 ? 'level-2' : 'level-1-2'}`)
            lines.push('configure isis area ISIS1 system-id auto')
            lines.push('configure isis area ISIS1 wide-metric')
            if (rid) { lines.push('configure isis add vlan Loopback area ISIS1') }
            for (const p of ifaces) {
                const vlanName = `port_${p.portLabel.replace(/[:/]/g, '_')}`
                lines.push(`configure isis add vlan ${vlanName} area ISIS1`)
                lines.push(`configure isis vlan ${vlanName} circuit-type point-to-point`)
            }
            lines.push('enable isis area ISIS1')
            break

        default: // cisco / dell / hpe (IOS-style)
            lines.push('!')
            lines.push('! IS-IS underlay')
            lines.push('router isis UNDERLAY')
            if (net) { lines.push(` net ${net}`) }
            lines.push(` is-type ${nodeLevel === 1 ? 'level-1' : nodeLevel === 2 ? 'level-2-only' : 'level-1-2'}`)
            lines.push(' metric-style wide')
            if (rid) { lines.push(' passive-interface Loopback0') }
            lines.push('!')
            if (rid) {
                lines.push('interface Loopback0')
                lines.push(' ip router isis UNDERLAY')
                lines.push('!')
            }
            for (const p of ifaces) {
                lines.push(`interface ${p.portLabel}`)
                lines.push(' ip router isis UNDERLAY')
                lines.push(' isis network point-to-point')
            }
            lines.push('!')
            break
    }

    return lines
}

// ── SR-MPLS config (SRGB, Node SID, source-packet-routing under IS-IS) ────

function emitSrMpls (vendorKey: string, ctx: VendorConfigContext): string[] {
    // SR-MPLS requires nodeSid and at least one IGP interface (IS-IS or OSPF)
    const igpIfaces = ctx.isisInterfaces?.length ? ctx.isisInterfaces : (ctx.ospfInterfaces?.length ? ctx.ospfInterfaces.map(o => ({ portLabel: o.portLabel })) : [])
    if (ctx.nodeSid == null || !igpIfaces.length) { return [] }
    const sid = ctx.nodeSid
    const srgbStart = ctx.srgbStart ?? 16000
    const srgbEnd = ctx.srgbEnd ?? 23999
    const rid = ctx.routerId ?? ''
    const ifaces = igpIfaces
    const isOspfBased = !ctx.isisInterfaces?.length && !!ctx.ospfInterfaces?.length
    const lines: string[] = []

    switch (vendorKey) {
        case 'juniper': {
            const igp = isOspfBased ? 'ospf' : 'isis'
            lines.push('')
            lines.push('# SR-MPLS (SPRING)')
            lines.push(`set protocols source-packet-routing srgb start-label ${srgbStart} index-range ${srgbEnd - srgbStart + 1}`)
            lines.push(`set protocols source-packet-routing node-segment ipv4-index ${sid}`)
            lines.push(`set protocols source-packet-routing node-segment ipv6-index ${sid + 200}`)
            // Enable MPLS on IGP interfaces
            for (const p of ifaces) {
                const ifName = p.portLabel.replace(/\//g, '/') + '.0'
                lines.push(`set protocols mpls interface ${ifName}`)
            }
            lines.push('set protocols mpls interface lo0.0')
            // Enable traffic engineering + SR under IGP
            lines.push(`set protocols ${igp} traffic-engineering`)
            lines.push(`set protocols ${igp} source-packet-routing`)
            lines.push(`set protocols ${igp} source-packet-routing srgb start-label ${srgbStart} index-range ${srgbEnd - srgbStart + 1}`)
            lines.push(`set protocols ${igp} source-packet-routing node-segment ipv4-index ${sid}`)
            lines.push(`set protocols ${igp} source-packet-routing node-segment ipv6-index ${sid + 200}`)
            // TI-LFA (Topology-Independent Loop-Free Alternate)
            lines.push('# TI-LFA fast reroute with node protection')
            lines.push(`set protocols ${igp} backup-spf-options use-post-convergence-lfa maximum-labels 5`)
            lines.push(`set protocols ${igp} backup-spf-options use-source-packet-routing`)
            lines.push(`set protocols ${igp} backup-spf-options node-link-degradation`)
            for (const p of ifaces) {
                const ifName = p.portLabel.replace(/\//g, '/') + '.0'
                lines.push(`set protocols ${igp} interface ${ifName} level 2 post-convergence-lfa node-protection`)
            }
            break
        }

        case 'arista':
            lines.push('!')
            lines.push('! SR-MPLS')
            lines.push('mpls ip')
            lines.push('!')
            lines.push(`segment-routing mpls`)
            lines.push('   no shutdown')
            lines.push(`   global-block ${srgbStart} ${srgbEnd}`)
            lines.push('   !')
            lines.push(`   prefix-segment`)
            if (rid) { lines.push(`      interface Loopback0 index ${sid}`) }
            lines.push('!')
            if (isOspfBased) {
                lines.push('router ospf 1')
                lines.push('   segment-routing mpls')
                lines.push('   segment-routing prefix-segment')
            } else {
                lines.push('router isis UNDERLAY')
                lines.push('   segment-routing mpls')
                lines.push('   segment-routing prefix-segment')
            }
            break

        case 'nokia':
            lines.push('')
            lines.push('# SR-MPLS')
            lines.push(`set / network-instance default segment-routing mpls global-block label-range srgb start-label ${srgbStart} end-label ${srgbEnd}`)
            if (rid) {
                lines.push(`set / network-instance default segment-routing mpls prefix-segment prefix ${rid}/32 index ${sid} node-sid`)
            }
            if (isOspfBased) {
                lines.push('set / network-instance default protocols ospf instance OSPF1 segment-routing mpls dynamic-adjacency-sids all-interfaces')
            } else {
                lines.push('set / network-instance default protocols isis instance ISIS1 segment-routing mpls dynamic-adjacency-sids all-interfaces')
            }
            break

        case 'huawei': {
            const hwIgp = isOspfBased ? 'ospf 1' : 'isis 1'
            lines.push('#')
            lines.push('# SR-MPLS')
            lines.push('segment-routing')
            lines.push(` global-block ${srgbStart} ${srgbEnd}`)
            lines.push('#')
            lines.push(hwIgp)
            lines.push(' segment-routing mpls')
            if (rid) { lines.push(` prefix-sid index ${sid} node-flag`) }
            lines.push('#')
            // MPLS on interfaces
            for (const p of ifaces) {
                lines.push(`interface ${p.portLabel}`)
                lines.push(' mpls')
                lines.push('#')
            }
            break
        }

        case 'mikrotik':
        case 'sonic':
        case 'extreme':
            lines.push('')
            lines.push(`# SR-MPLS is not supported on ${vendorKey} in this config generator`)
            break

        default: { // cisco / dell / hpe
            const cIgp = isOspfBased ? 'router ospf 1' : 'router isis UNDERLAY'
            lines.push('!')
            lines.push('! SR-MPLS')
            lines.push('segment-routing mpls')
            lines.push(` global-block ${srgbStart} ${srgbEnd}`)
            lines.push(' !')
            lines.push(' connected-prefix-sid-map')
            if (rid) { lines.push(`  address-family ipv4`) ; lines.push(`   ${rid}/32 index ${sid} range 1`) }
            lines.push('!')
            lines.push(cIgp)
            lines.push(' address-family ipv4 unicast')
            lines.push('  segment-routing mpls')
            lines.push('!')
            break
        }
    }

    return lines
}

// ── SRv6 config (locator, SRv6 under IS-IS) ──────────────────────────────

function emitSrv6 (vendorKey: string, ctx: VendorConfigContext): string[] {
    if (!ctx.srv6Locator) { return [] }
    const locator = ctx.srv6Locator
    const igpIfaces = ctx.isisInterfaces?.length ? ctx.isisInterfaces : (ctx.ospfInterfaces ?? []).map(o => ({ portLabel: o.portLabel }))
    const isOspfBased = !ctx.isisInterfaces?.length && !!ctx.ospfInterfaces?.length
    const lines: string[] = []

    switch (vendorKey) {
        case 'juniper': {
            const igp = isOspfBased ? 'ospf' : 'isis'
            lines.push('')
            lines.push('# SRv6')
            lines.push(`set routing-options source-packet-routing srv6 locator MAIN ${locator}`)
            lines.push('set routing-options source-packet-routing srv6 locator MAIN end-sid')
            lines.push(`set protocols ${igp} source-packet-routing srv6 locator MAIN end-sid`)
            // Enable inet6 on IGP interfaces for SRv6 data plane
            for (const p of igpIfaces) {
                lines.push(`set interfaces ${p.portLabel} unit 0 family inet6`)
            }
            lines.push('set interfaces lo0 unit 0 family inet6')
            break
        }

        case 'arista':
            lines.push('!')
            lines.push('! SRv6')
            lines.push('segment-routing srv6')
            lines.push(`   locator MAIN ${locator}`)
            lines.push('!')
            if (isOspfBased) {
                lines.push('router ospf 1')
                lines.push('   segment-routing srv6')
                lines.push('   address-family ipv6 unicast')
            } else {
                lines.push('router isis UNDERLAY')
                lines.push('   segment-routing srv6')
                lines.push('   address-family ipv6 unicast')
            }
            break

        case 'nokia':
            lines.push('')
            lines.push('# SRv6')
            lines.push(`set / network-instance default segment-routing srv6 locator MAIN prefix ${locator}`)
            lines.push('set / network-instance default segment-routing srv6 locator MAIN function 1 end')
            if (isOspfBased) {
                lines.push('set / network-instance default protocols ospf instance OSPF1 segment-routing srv6 locator [ MAIN ]')
            } else {
                lines.push('set / network-instance default protocols isis instance ISIS1 segment-routing srv6 locator [ MAIN ]')
            }
            break

        case 'huawei': {
            const hwIgp = isOspfBased ? 'ospf 1' : 'isis 1'
            lines.push('#')
            lines.push('# SRv6')
            lines.push('segment-routing ipv6')
            lines.push(` encapsulation source-address ${ctx.routerId ?? '::1'}`)
            lines.push(` locator MAIN ipv6-prefix ${locator} static 64`)
            lines.push('  opcode ::1 end-dt4')
            lines.push('  opcode ::2 end-dt6')
            lines.push('#')
            lines.push(hwIgp)
            lines.push(' segment-routing ipv6 locator MAIN')
            lines.push(' ipv6 enable topology ipv6')
            for (const p of igpIfaces) {
                lines.push(` interface ${p.portLabel}`)
                lines.push('  ipv6 enable')
            }
            lines.push('#')
            break
        }

        case 'mikrotik':
        case 'sonic':
        case 'extreme':
            lines.push('')
            lines.push(`# SRv6 is not supported on ${vendorKey} in this config generator`)
            break

        default: { // cisco
            const cIgp = isOspfBased ? 'router ospf 1' : 'router isis UNDERLAY'
            lines.push('!')
            lines.push('! SRv6')
            lines.push('segment-routing srv6')
            lines.push(' locators')
            lines.push('  locator MAIN')
            lines.push(`   prefix ${locator}`)
            lines.push('!')
            lines.push(cIgp)
            lines.push(' address-family ipv6 unicast')
            lines.push('  segment-routing srv6')
            lines.push('  locator MAIN')
            lines.push('!')
            break
        }
    }

    return lines
}

// ── gRPC/gNMI Telemetry config ───────────────────────────────────────────

/** Default sensor paths per vendor */
const DEFAULT_SENSOR_PATHS: Record<string, string[]> = {
    juniper: [
        '/junos/system/linecard/interface/',
        '/junos/system/linecard/cpu/',
        '/junos/system/linecard/memory/',
        '/network-instances/network-instance/protocols/bgp/',
    ],
    cisco: [
        'sys/intf depth unbounded',
        'sys/bgp depth unbounded',
        'sys/epId-1 depth unbounded',
        'sys/procsys depth unbounded',
    ],
    arista: [
        '/interfaces/interface/state/counters',
        '/network-instances/network-instance/protocols/bgp',
        '/components/component/state',
    ],
    nokia: [
        '/interface[name=ethernet-*]/statistics',
        '/network-instance[name=default]/protocols/bgp/neighbor',
        '/platform/linecard',
    ],
}

function emitTelemetry (vendorKey: string, ctx: VendorConfigContext): string[] {
    if (!ctx.telemetryEnabled) { return [] }
    const tc = ctx.telemetryConfig
    const collectorIp = tc?.collectorIp || '0.0.0.0'
    const collectorPort = tc?.collectorPort || 50051
    const encoding = tc?.encoding || 'gpb'
    const tls = tc?.tls ?? false
    const interval = tc?.sampleInterval || 30
    const intervalMs = interval * 1000
    const paths = tc?.sensorPaths?.length ? tc.sensorPaths : (DEFAULT_SENSOR_PATHS[vendorKey] ?? [])
    const lines: string[] = []

    switch (vendorKey) {
        case 'juniper': {
            const grpcPort = collectorPort === 50051 ? 32767 : collectorPort
            lines.push('')
            lines.push('# gRPC/gNMI telemetry')
            if (tls) {
                lines.push(`set system services extension-service request-response grpc ssl port ${grpcPort}`)
            } else {
                lines.push(`set system services extension-service request-response grpc clear-text port ${grpcPort}`)
            }
            lines.push('set system services extension-service request-response grpc skip-authentication')
            lines.push('# Telemetry collector and sensors')
            lines.push(`set services analytics streaming-server telemetry-server remote-address ${collectorIp}`)
            lines.push(`set services analytics streaming-server telemetry-server remote-port ${collectorPort}`)
            lines.push(`set services analytics export-profile telemetry-export local-address 0.0.0.0`)
            lines.push(`set services analytics export-profile telemetry-export local-port ${collectorPort}`)
            lines.push(`set services analytics export-profile telemetry-export reporting-rate ${interval}`)
            lines.push(`set services analytics export-profile telemetry-export transport grpc`)
            for (let i = 0; i < paths.length; i++) {
                const name = `sensor-${i}`
                lines.push(`set services analytics sensor ${name} server-name telemetry-server`)
                lines.push(`set services analytics sensor ${name} export-name telemetry-export`)
                lines.push(`set services analytics sensor ${name} resource ${paths[i]}`)
            }
            break
        }

        case 'cisco':
            lines.push('!')
            lines.push('! gRPC/gNMI telemetry')
            lines.push('feature grpc')
            lines.push('feature telemetry')
            lines.push('!')
            lines.push('telemetry')
            lines.push('  destination-group 100')
            lines.push(`    ip address ${collectorIp} port ${collectorPort} protocol gRPC encoding ${encoding.toUpperCase()}`)
            lines.push('  sensor-group 100')
            lines.push('    data-source NX-API')
            for (const p of paths) {
                lines.push(`    path ${p}`)
            }
            lines.push('  subscription 100')
            lines.push('    dst-grp 100')
            lines.push(`    snsr-grp 100 sample-interval ${intervalMs}`)
            lines.push('!')
            lines.push('grpc')
            lines.push(`  port ${collectorPort}`)
            if (!tls) { lines.push('  no-tls') }
            break

        case 'arista':
            lines.push('!')
            lines.push('! gRPC/gNMI telemetry')
            lines.push('management api gnmi')
            lines.push('   transport grpc default')
            lines.push(`      port ${collectorPort === 50051 ? 6030 : collectorPort}`)
            if (!tls) { lines.push('      no ssl profile') }
            lines.push('   provider eos-native')
            lines.push('!')
            if (paths.length) {
                lines.push('! OpenConfig sensor paths (configure via gNMI Subscribe)')
                for (const p of paths) {
                    lines.push(`! - ${p}`)
                }
            }
            break

        case 'sonic':
            lines.push('')
            lines.push('# gNMI telemetry')
            lines.push(`# Port: ${collectorPort === 50051 ? 8080 : collectorPort}`)
            lines.push(`# Collector: ${collectorIp}:${collectorPort}`)
            lines.push(`# Interval: ${interval}s`)
            lines.push('# Configure via /etc/sonic/telemetry.conf')
            break

        case 'nokia':
            lines.push('')
            lines.push('# gRPC/gNMI telemetry')
            lines.push('set / system grpc admin-state enable')
            lines.push('set / system grpc services [ gnmi ]')
            lines.push('set / system grpc network-instance mgmt')
            if (!tls) { lines.push('set / system grpc tls-profile none') }
            lines.push('set / system grpc trace-options [ request response common ]')
            if (paths.length) {
                lines.push('# Sensor paths (subscribe via gNMI client)')
                for (const p of paths) {
                    lines.push(`# gnmi-path: ${p}`)
                }
            }
            break
    }

    return lines
}

/** Generate Telegraf/Prometheus pipeline config for all telemetry-enabled nodes */
export function generateTelemetryPipeline (nodes: { label: string; vendor?: string; loopbackIp?: string; mgmtIp?: string; telemetryEnabled?: boolean; telemetryConfig?: { collectorIp: string; collectorPort: number; encoding: string; tls: boolean; sampleInterval: number; sensorPaths: string[] } }[]): string {
    const telNodes = nodes.filter(n => n.telemetryEnabled && n.vendor)
    if (!telNodes.length) { return '' }

    const lines: string[] = []
    lines.push('# ══════════════════════════════════════════════════════════')
    lines.push('# Telegraf configuration for gNMI telemetry collection')
    lines.push('# Generated by NetOps Topology Builder')
    lines.push('# ══════════════════════════════════════════════════════════')
    lines.push('')
    lines.push('[agent]')
    lines.push('  interval = "30s"')
    lines.push('  flush_interval = "10s"')
    lines.push('')
    lines.push('# ── Output to Prometheus ─────────────────────────────────')
    lines.push('[[outputs.prometheus_client]]')
    lines.push('  listen = ":9273"')
    lines.push('  metric_version = 2')
    lines.push('')

    for (const node of telNodes) {
        const ip = (node.loopbackIp ?? node.mgmtIp ?? '').split('/')[0]
        if (!ip) { continue }
        const vendor = (node.vendor ?? '').toLowerCase()
        const tc = node.telemetryConfig
        const port = tc?.collectorPort || (vendor === 'arista' ? 6030 : vendor === 'sonic' ? 8080 : vendor === 'juniper' ? 32767 : vendor === 'nokia' ? 57400 : 50051)
        const paths = tc?.sensorPaths?.length ? tc.sensorPaths : (DEFAULT_SENSOR_PATHS[vendor] ?? [])
        const interval = tc?.sampleInterval || 30
        const tls = tc?.tls ?? false

        lines.push(`# ── ${node.label} (${node.vendor}) ──`)
        lines.push('[[inputs.gnmi]]')
        lines.push(`  addresses = ["${ip}:${port}"]`)
        lines.push(`  username = "admin"`)
        lines.push(`  password = "<SET-PASSWORD>"`)
        if (!tls) { lines.push('  enable_tls = false') }
        lines.push(`  encoding = "${tc?.encoding || 'proto'}"`)
        lines.push(`  redial = "10s"`)
        lines.push(`  [inputs.gnmi.tags]`)
        lines.push(`    device = "${node.label}"`)
        lines.push(`    vendor = "${node.vendor}"`)
        for (const p of paths) {
            lines.push('')
            lines.push(`  [[inputs.gnmi.subscription]]`)
            lines.push(`    name = "${p.split('/').pop() ?? 'metric'}"`)
            lines.push(`    origin = "openconfig"`)
            lines.push(`    path = "${p}"`)
            lines.push(`    subscription_mode = "sample"`)
            lines.push(`    sample_interval = "${interval}s"`)
        }
        lines.push('')
    }

    // Grafana dashboard hint
    lines.push('# ══════════════════════════════════════════════════════════')
    lines.push('# Grafana: Import dashboard from')
    lines.push('# https://grafana.com/grafana/dashboards/12489 (gNMI)')
    lines.push('# Prometheus datasource: http://localhost:9090')
    lines.push('# Telegraf metrics: http://localhost:9273/metrics')
    lines.push('# ══════════════════════════════════════════════════════════')

    return lines.join('\n')
}

// ── MPLS LDP config ──────────────────────────────────────────────────────

function emitMplsLdp (vendorKey: string, ctx: VendorConfigContext): string[] {
    if (!ctx.mplsLdp || !ctx.mplsInterfaces?.length) { return [] }
    const rid = ctx.routerId ?? ''
    const ifaces = ctx.mplsInterfaces
    const lines: string[] = []

    switch (vendorKey) {
        case 'juniper':
            lines.push('')
            lines.push('# MPLS / LDP')
            for (const ifName of ifaces) {
                lines.push(`set protocols mpls interface ${ifName}.0`)
                lines.push(`set protocols ldp interface ${ifName}.0`)
            }
            lines.push('set protocols mpls interface lo0.0')
            lines.push('set protocols ldp interface lo0.0')
            if (rid) { lines.push(`set protocols ldp router-id ${rid}`) }
            // RSVP for signaled LSPs
            for (const ifName of ifaces) {
                lines.push(`set protocols rsvp interface ${ifName}.0`)
            }
            break

        case 'arista':
            lines.push('!')
            lines.push('! MPLS / LDP')
            lines.push('mpls ip')
            lines.push('!')
            lines.push('mpls ldp')
            if (rid) { lines.push(`   router-id ${rid}`) }
            lines.push('   no shutdown')
            lines.push('   transport-address interface Loopback0')
            for (const ifName of ifaces) {
                lines.push(`   interface ${ifName}`)
            }
            lines.push('!')
            break

        case 'nokia':
            lines.push('')
            lines.push('# MPLS / LDP')
            lines.push('set / network-instance default protocols ldp admin-state enable')
            if (rid) { lines.push(`set / network-instance default protocols ldp discovery transport-address ${rid}`) }
            for (const ifName of ifaces) {
                lines.push(`set / network-instance default protocols ldp interface ${ifName}.0 admin-state enable`)
            }
            lines.push('set / network-instance default mpls admin-state enable')
            break

        case 'huawei':
            lines.push('#')
            lines.push('# MPLS / LDP')
            lines.push('mpls lsr-id ' + (rid || '0.0.0.0'))
            lines.push('mpls')
            lines.push(' mpls ldp')
            lines.push('#')
            for (const ifName of ifaces) {
                lines.push(`interface ${ifName}`)
                lines.push(' mpls')
                lines.push(' mpls ldp')
                lines.push('#')
            }
            break

        case 'mikrotik':
            lines.push('')
            lines.push('# MPLS / LDP')
            lines.push('/mpls ldp')
            lines.push(`set enabled=yes lsr-id=${rid || '0.0.0.0'} transport-address=${rid || '0.0.0.0'}`)
            for (const ifName of ifaces) {
                lines.push(`/mpls ldp interface add interface=${ifName}`)
            }
            break

        case 'sonic':
        case 'extreme':
            lines.push('')
            lines.push(`# MPLS LDP is not supported on ${vendorKey} in this config generator`)
            break

        default: // cisco / dell / hpe
            lines.push('!')
            lines.push('! MPLS / LDP')
            lines.push('mpls ip')
            lines.push('mpls ldp ' + (rid ? `router-id Loopback0` : ''))
            lines.push('!')
            for (const ifName of ifaces) {
                lines.push(`interface ${ifName}`)
                lines.push(' mpls ip')
            }
            lines.push('!')
            break
    }

    return lines
}

/**
 * Emit Junos `routing-instances VRF-X { ... }` stanzas from the template's
 * explicit VRF definitions (RLI 52387 — Pure T5↔T5 EVPN-VXLAN seamless
 * stitching). Walks ctx.vrfs[] and emits set commands for every VRF whose
 * memberNodes includes ctx.nodeIndex.
 *
 * For each VRF on this node:
 *   • Base routing-instance: instance-type, RD, vrf-target, ip-prefix-routes
 *     (vni, encap vxlan), routing-options multipath.
 *   • IF this node is in `interconnectNodes` (or interconnectNodes is unset
 *     and an `interconnect` block exists): emit the interconnect stanza —
 *     `protocols evpn interconnect { route-distinguisher; vrf-target; }`.
 *   • IF the VRF has a `routingVni` override on the interconnect block: emit
 *     it too. (In single-VNI deployments — see the sample-deployment template
 *     — the interconnect side re-uses the DC routing VNI, so it's omitted.)
 *
 * Returns [] when ctx.vrfs is empty, ctx.nodeIndex is undefined, or this
 * node has no VRF memberships.
 *
 * Vendors other than Junos: TODO — Cisco/Arista equivalents would emit
 * `vrf definition` + `address-family l2vpn evpn` stanzas. Left as a follow-up
 * since the templates that use vrfs[] are currently Juniper-only.
 */
/**
 * Sanitize a VRF display name for use as a Junos routing-instance name.
 * Junos allows letters/digits/hyphens/underscores. We:
 *   1. Drop everything in parentheses (UI disambiguators like "(DC1)").
 *   2. Replace illegal chars with '-'.
 *   3. Collapse runs of hyphens.
 *   4. Trim leading/trailing hyphens.
 *
 * Example: "VRF-100 (DC1)" → "VRF-100"
 *          "T5-VRF-A (interco)" → "T5-VRF-A"
 *          "  foo / bar  " → "foo-bar"
 */
function sanitizeJunosInstanceName (raw: string): string {
    return raw
        .replace(/\([^)]*\)/g, '')           // drop parenthetical
        .replace(/[^A-Za-z0-9_-]+/g, '-')    // illegal chars → '-'
        .replace(/-+/g, '-')                 // collapse hyphen runs
        .replace(/^-+|-+$/g, '')             // trim ends
}

/**
 * Substitute loopback placeholders in route-distinguisher / vrf-target
 * strings:
 *   • `<loopback>`  → primary loopback IP (lo0.0 / Loopback0)
 *   • `<loopback1>` → secondary loopback IP (lo0.1 / Loopback1) — used for
 *                     interconnect RDs in T5 stitching deployments (the iGW
 *                     uses lo0.1 as the iRD source). Falls back to primary
 *                     when secondary isn't set.
 *
 * Both forms can appear in the same string. Lets a template author write
 *   `routeDistinguisher: '<loopback>:100'`
 *   `interconnect.routeDistinguisher: '<loopback1>:110'`
 * and have each member node emit its own per-RD values.
 */
function expandRdPlaceholders (
    raw: string,
    loopbackIp?: string,
    loopbackIpSecondary?: string,
): string {
    if (!raw.includes('<loopback')) { return raw }
    const primary = (loopbackIp ?? '').split('/')[0] || '0.0.0.0'
    const secondary = (loopbackIpSecondary ?? '').split('/')[0] || primary
    return raw
        .replace(/<loopback1>/g, secondary)
        .replace(/<loopback>/g, primary)
}

function emitJunosT5Vrfs (ctx: VendorConfigContext): string[] {
    const lines: string[] = []
    const myIndex = ctx.nodeIndex
    const vrfs = ctx.vrfs
    if (myIndex === undefined || !vrfs?.length) { return lines }

    const myVrfs = vrfs.filter(v => v.memberNodes.includes(myIndex))
    if (!myVrfs.length) { return lines }

    const loopbackIp = ctx.loopbackIp
    const loopbackIpSecondary = ctx.loopbackIpSecondary
    // Emit lo0.1 interface declaration once if the node has a secondary loop-
    // back AND it's actually used by any VRF (i.e. this node has VRFs at all).
    if (loopbackIpSecondary) {
        const lo1 = loopbackIpSecondary.split('/')[0] + '/' + (loopbackIpSecondary.split('/')[1] || '32')
        lines.push('')
        lines.push('# Secondary loopback for VRF / iRD source (lo0.1)')
        lines.push(`set interfaces lo0 unit 1 family inet address ${lo1}`)
    }

    lines.push('')
    lines.push('# ── EVPN T5↔T5 VRF definitions (RLI 52387) ─────────────────────────')

    for (const v of myVrfs) {
        const safeName = sanitizeJunosInstanceName(v.name) || sanitizeJunosInstanceName(v.id)
        lines.push('')
        lines.push(`# VRF ${v.name}${v.description ? ' — ' + v.description : ''}`)
        lines.push(`set routing-instances ${safeName} instance-type ${v.instanceType}`)
        lines.push(`set routing-instances ${safeName} routing-options multipath`)
        lines.push(`set routing-instances ${safeName} route-distinguisher ${expandRdPlaceholders(v.routeDistinguisher, loopbackIp, loopbackIpSecondary)}`)
        lines.push(`set routing-instances ${safeName} vrf-target ${v.vrfTarget}`)

        // ip-prefix-routes: T5 NLRI advertisement
        lines.push(`set routing-instances ${safeName} protocols evpn ip-prefix-routes advertise direct-nexthop`)
        lines.push(`set routing-instances ${safeName} protocols evpn ip-prefix-routes encapsulation vxlan`)
        lines.push(`set routing-instances ${safeName} protocols evpn ip-prefix-routes vni ${v.routingVni}`)
        if (v.exportPolicy) {
            lines.push(`set routing-instances ${safeName} protocols evpn ip-prefix-routes export ${v.exportPolicy}`)
        }

        // Bind per-VLAN IRBs into the VRF (symmetric IRB pattern). Only emit
        // for VLANs the current node actually hosts — leaves carry the IRBs
        // for tenant VLANs, iGWs typically don't. Empty intersection → no
        // IRB bindings (matches sample-config: GW11 has VRF-100 but no
        // irb.1..4 bindings; LEAF-1 has the full set).
        const nodeVlanIds = new Set((ctx.vlans ?? []).map(vl => vl.id))
        for (const vlanId of (v.vlans ?? [])) {
            if (nodeVlanIds.has(vlanId)) {
                lines.push(`set routing-instances ${safeName} interface irb.${vlanId}`)
            }
        }

        // Bind lo0.1 to the VRF when this node has a secondary loopback —
        // matches the sample-config convention where lo0.1 lives inside the
        // tenant VRF and is advertised via t5-export.
        if (loopbackIpSecondary) {
            lines.push(`set routing-instances ${safeName} interface lo0.1`)
        }

        // Interconnect stanza — only on iGW members.
        const emitInterco = v.interconnect && (
            v.interconnectNodes
                ? v.interconnectNodes.includes(myIndex)
                : true
        )
        if (emitInterco && v.interconnect) {
            const ic = v.interconnect
            if (ic.routeDistinguisher) {
                lines.push(`set routing-instances ${safeName} protocols evpn interconnect route-distinguisher ${expandRdPlaceholders(ic.routeDistinguisher, loopbackIp, loopbackIpSecondary)}`)
            }
            if (ic.vrfTarget) {
                lines.push(`set routing-instances ${safeName} protocols evpn interconnect vrf-target ${ic.vrfTarget}`)
            }
            if (ic.routingVni !== undefined) {
                lines.push(`# interconnect-side routing VNI: ${ic.routingVni}`)
            }
            if (ic.mapsToVrfId) {
                const target = vrfs.find(x => x.id === ic.mapsToVrfId)
                if (target) {
                    lines.push(`# N:1 mapping: re-originated into ${target.name} (vni ${target.routingVni})`)
                }
            }
        }
    }

    // Aggregate domain-ids across all VRFs on this node + their interconnect
    // blocks, and emit them once at the protocols level — that's the correct
    // Junos placement for `uniform-propagation-mode`. Set dedup also handles
    // the common case where DC + DCI domain ids repeat across multiple VRFs.
    const domainIds = new Set<string>()
    for (const v of myVrfs) {
        if (v.domainId) { domainIds.add(v.domainId) }
        // Include the interconnect-side domain-id when this node is an iGW.
        const isInterco = v.interconnect && (
            v.interconnectNodes
                ? v.interconnectNodes.includes(myIndex)
                : true
        )
        if (isInterco && v.interconnect?.domainId) {
            domainIds.add(v.interconnect.domainId)
        }
    }
    if (domainIds.size > 0) {
        lines.push('')
        lines.push('# Uniform-propagation-mode domain-ids (D_PATH loop prevention)')
        for (const d of domainIds) {
            lines.push(`set protocols evpn-vpn uniform-propagation-mode domain-id ${d}`)
        }
    }

    return lines
}

/**
 * True when this node has at least one explicit VRF in ctx.vrfs[]. Used by
 * emitEvpnOverlay to suppress its auto-generated `EVPN-VRF` stanza —
 * otherwise we'd emit two VRF definitions (the auto one + the explicit
 * RLI-52387 one), producing invalid duplicate routing-instance config.
 */
function hasExplicitT5Vrfs (ctx: VendorConfigContext): boolean {
    const i = ctx.nodeIndex
    if (i === undefined || !ctx.vrfs?.length) { return false }
    return ctx.vrfs.some(v => v.memberNodes.includes(i))
}

/** Sanitize for Cisco/Arista VRF names — same rules but underscores allowed. */
function sanitizeIosInstanceName (raw: string): string {
    return raw
        .replace(/\([^)]*\)/g, '')
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
}

/**
 * Emit Cisco NX-OS `vrf context` + `interface nve1 member vni associate-vrf`
 * + `router bgp asn vrf X` stanzas for explicit T5 VRFs (RLI 52387).
 *
 * NX-OS doesn't have a direct equivalent of Junos `interconnect { ... }`.
 * EVPN T5 stitching on Nexus is typically implemented via:
 *   1. The standard per-VRF address-family ipv4/l2vpn evpn config below.
 *   2. Route-target rewriting through BGP route-maps (out of scope here —
 *      we emit a TODO comment when an interconnect block is present).
 * Modern NX-OS DCI features (border-gateway / multi-site EVPN) are a separate
 * feature stack; we note them rather than emit broken approximations.
 */
function emitCiscoT5Vrfs (ctx: VendorConfigContext): string[] {
    const lines: string[] = []
    const myIndex = ctx.nodeIndex
    const vrfs = ctx.vrfs
    if (myIndex === undefined || !vrfs?.length) { return lines }

    const myVrfs = vrfs.filter(v => v.memberNodes.includes(myIndex))
    if (!myVrfs.length) { return lines }

    const loopbackIp = ctx.loopbackIp
    const loopbackIpSecondary = ctx.loopbackIpSecondary

    if (loopbackIpSecondary) {
        const ip = loopbackIpSecondary.split('/')[0]
        const prefix = loopbackIpSecondary.split('/')[1] || '32'
        lines.push('!')
        lines.push('! Secondary loopback (Loopback1) — VRF-facing, iRD source')
        lines.push('interface Loopback1')
        lines.push(`  ip address ${ip}/${prefix}`)
        lines.push('!')
    }

    lines.push('!')
    lines.push('! ── EVPN T5↔T5 VRF definitions (RLI 52387) ─────────────────────────')

    for (const v of myVrfs) {
        const safeName = sanitizeIosInstanceName(v.name) || sanitizeIosInstanceName(v.id)
        const rd = expandRdPlaceholders(v.routeDistinguisher, loopbackIp, loopbackIpSecondary)
        // RT values: NX-OS expects `<asn>:<id>` form, but Junos `target:asn:id`
        // is the same data — strip the `target:` prefix.
        const rt = v.vrfTarget.replace(/^target:/, '')

        lines.push('!')
        lines.push(`! VRF ${v.name}${v.description ? ' — ' + v.description : ''}`)
        lines.push(`vrf context ${safeName}`)
        lines.push(`  vni ${v.routingVni}`)
        lines.push(`  rd ${rd}`)
        lines.push('  address-family ipv4 unicast')
        lines.push(`    route-target both ${rt}`)
        lines.push(`    route-target both ${rt} evpn`)
        if (v.exportPolicy) {
            lines.push(`    export map ${v.exportPolicy}`)
        }
        lines.push('!')

        // SVI bindings — only for VLANs this node hosts (symmetric IRB).
        const nodeVlanIds = new Set((ctx.vlans ?? []).map(vl => vl.id))
        for (const vlanId of (v.vlans ?? [])) {
            if (nodeVlanIds.has(vlanId)) {
                lines.push(`interface Vlan${vlanId}`)
                lines.push(`  vrf member ${safeName}`)
                lines.push('!')
            }
        }

        // VXLAN VRF binding on nve1.
        lines.push('interface nve1')
        lines.push(`  member vni ${v.routingVni} associate-vrf`)
        lines.push('!')

        // BGP per-VRF address-family.
        if (ctx.asn) {
            lines.push(`router bgp ${ctx.asn}`)
            lines.push(`  vrf ${safeName}`)
            lines.push('    address-family ipv4 unicast')
            lines.push('      advertise l2vpn evpn')
            lines.push('!')
        }

        const emitInterco = v.interconnect && (
            v.interconnectNodes ? v.interconnectNodes.includes(myIndex) : true
        )
        if (emitInterco && v.interconnect) {
            const ic = v.interconnect
            lines.push(`! Interconnect (T5↔T5 stitching) — NX-OS equivalent requires`)
            lines.push(`!   route-target rewriting via BGP route-map or multi-site EVPN`)
            lines.push(`!   border-gateway feature. Not auto-emitted; configure manually:`)
            if (ic.vrfTarget) {
                lines.push(`!     interconnect vrf-target: ${ic.vrfTarget.replace(/^target:/, '')}`)
            }
            if (ic.routeDistinguisher) {
                lines.push(`!     interconnect rd: ${expandRdPlaceholders(ic.routeDistinguisher, loopbackIp, loopbackIpSecondary)}`)
            }
            if (ic.mapsToVrfId) {
                const target = vrfs.find(x => x.id === ic.mapsToVrfId)
                if (target) {
                    lines.push(`!     maps to: ${target.name} (vni ${target.routingVni})`)
                }
            }
        }
    }
    return lines
}

/**
 * Emit Arista EOS `vrf instance` + `router bgp vrf` + `Vxlan1 vrf X vni N`
 * stanzas for explicit T5 VRFs. Same DCI-stitching caveat as Cisco — Arista's
 * T5↔T5 interconnect is via DCI gateway / route-target maps, not a single
 * config knob; we emit the standard per-VRF config and TODO the interconnect.
 */
function emitAristaT5Vrfs (ctx: VendorConfigContext): string[] {
    const lines: string[] = []
    const myIndex = ctx.nodeIndex
    const vrfs = ctx.vrfs
    if (myIndex === undefined || !vrfs?.length) { return lines }

    const myVrfs = vrfs.filter(v => v.memberNodes.includes(myIndex))
    if (!myVrfs.length) { return lines }

    const loopbackIp = ctx.loopbackIp
    const loopbackIpSecondary = ctx.loopbackIpSecondary

    if (loopbackIpSecondary) {
        const ip = loopbackIpSecondary.split('/')[0]
        const prefix = loopbackIpSecondary.split('/')[1] || '32'
        lines.push('!')
        lines.push('! Secondary loopback (Loopback1) — VRF-facing')
        lines.push('interface Loopback1')
        lines.push(`   ip address ${ip}/${prefix}`)
        lines.push('!')
    }

    lines.push('!')
    lines.push('! ── EVPN T5↔T5 VRF definitions (RLI 52387) ─────────────────────────')

    for (const v of myVrfs) {
        const safeName = sanitizeIosInstanceName(v.name) || sanitizeIosInstanceName(v.id)
        const rd = expandRdPlaceholders(v.routeDistinguisher, loopbackIp, loopbackIpSecondary)
        const rt = v.vrfTarget.replace(/^target:/, '')

        lines.push('!')
        lines.push(`! VRF ${v.name}${v.description ? ' — ' + v.description : ''}`)
        lines.push(`vrf instance ${safeName}`)
        lines.push(`   rd ${rd}`)
        lines.push(`   route-target import ${rt}`)
        lines.push(`   route-target export ${rt}`)
        lines.push('!')
        lines.push(`ip routing vrf ${safeName}`)
        lines.push('!')

        // SVI bindings (Vlan interfaces) — only for VLANs this node hosts.
        const nodeVlanIds = new Set((ctx.vlans ?? []).map(vl => vl.id))
        for (const vlanId of (v.vlans ?? [])) {
            if (nodeVlanIds.has(vlanId)) {
                lines.push(`interface Vlan${vlanId}`)
                lines.push(`   vrf ${safeName}`)
                lines.push('!')
            }
        }

        // Vxlan1 VRF→VNI binding.
        lines.push('interface Vxlan1')
        lines.push(`   vxlan vrf ${safeName} vni ${v.routingVni}`)
        lines.push('!')

        if (ctx.asn) {
            lines.push(`router bgp ${ctx.asn}`)
            lines.push(`   vrf ${safeName}`)
            lines.push(`      rd ${rd}`)
            lines.push(`      route-target import evpn ${rt}`)
            lines.push(`      route-target export evpn ${rt}`)
            if (v.exportPolicy) {
                lines.push(`      route-map ${v.exportPolicy} out`)
            }
            lines.push('!')
        }

        const emitInterco = v.interconnect && (
            v.interconnectNodes ? v.interconnectNodes.includes(myIndex) : true
        )
        if (emitInterco && v.interconnect) {
            const ic = v.interconnect
            lines.push(`! Interconnect (T5↔T5 stitching) — EOS DCI requires route-target`)
            lines.push(`!   import/export rewriting + selective leaking. Configure manually:`)
            if (ic.vrfTarget) {
                lines.push(`!     interconnect vrf-target: ${ic.vrfTarget.replace(/^target:/, '')}`)
            }
            if (ic.routeDistinguisher) {
                lines.push(`!     interconnect rd: ${expandRdPlaceholders(ic.routeDistinguisher, loopbackIp, loopbackIpSecondary)}`)
            }
            if (ic.mapsToVrfId) {
                const target = vrfs.find(x => x.id === ic.mapsToVrfId)
                if (target) {
                    lines.push(`!     maps to: ${target.name} (vni ${target.routingVni})`)
                }
            }
        }
    }
    return lines
}

export function buildVendorStartupConfig (
    vendor: string,
    ports: NodePort[],
    ctx: VendorConfigContext,
): string {
    const vendorKey = vendor.trim().toLowerCase()
    const host = ctx.hostname || 'device'
    const mgmtRaw = ctx.mgmtIp
    const mgmtHost = mgmtRaw ? mgmtRaw.split('/')[0].trim() : ''
    // Loopback IP: only use dedicated loopbackIp (don't fall back to mgmtIp — it may be a hostname)
    const loopRaw = ctx.loopbackIp?.trim() || undefined
    const loopParsed = parseIpCidr(loopRaw)
    const loopV6Raw = ctx.loopbackIpv6?.trim()
    const loopV6 = loopV6Raw ? { full: loopV6Raw, ip: loopV6Raw.split('/')[0], prefix: loopV6Raw.split('/')[1] || '128' } : null
    const sshUser = ctx.sshUsername
    const model = ctx.model
    const switchFamily = ctx.switchFamily

    // ── Juniper (JunOS set-style) ────────────────────────────────────────
    if (vendorKey === 'juniper') {
        const lines: string[] = []
        lines.push(`# ${vendor} ${ctx.nodeType} startup config`)
        if (switchFamily) { lines.push(`# switch-type ${switchFamily}`) }
        if (model) { lines.push(`# model ${model}`) }
        if (mgmtHost) { lines.push(`# management-ip ${mgmtHost}`) }
        lines.push('set system services ssh')
        lines.push(`set system host-name ${host}`)
        if (loopParsed) { lines.push(`set interfaces lo0 unit 0 family inet address ${loopParsed.ip}/${loopParsed.prefix}`) }
        if (loopV6) { lines.push(`set interfaces lo0 unit 0 family inet6 address ${loopV6.ip}/${loopV6.prefix}`) }

        // VLAN declarations (skip for MAC-VRF leaves — VLANs declared inside MAC-VRF instances)
        if (!ctx.macVrfEnabled) {
            const vlanDecls = emitVlanDeclarations(ctx.vlans, 'juniper')
            if (vlanDecls.length) { lines.push(...vlanDecls) }
        }

        // Group channelized sub-ports by base label to emit number-of-sub-ports
        const subPortCounts = new Map<string, number>()
        for (const port of ports) {
            const { base, channel } = parseChannelLabel(port.label)
            if (channel !== null && channel >= 0) {
                subPortCounts.set(base, Math.max(subPortCounts.get(base) ?? 0, channel + 1))
            }
        }

        const emittedBases = new Set<string>()
        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }

            const { base, channel } = parseChannelLabel(ifName)
            const isSubPort = channel !== null && channel > 0

            // For channelized ports, emit speed + number-of-sub-ports on the base interface once
            if (subPortCounts.has(base) && !emittedBases.has(base)) {
                emittedBases.add(base)
                const junosSpeed = speedToJunos(port.speed)
                if (junosSpeed) { lines.push(`set interfaces ${base} speed ${junosSpeed}`) }
                lines.push(`set interfaces ${base} number-of-sub-ports ${subPortCounts.get(base)}`)
            }

            const description = (port.description ?? '').trim().replace(/"/g, '')
            const parsed = parseIpCidr(port.ipAddress)
            const hasV6 = port.ipv6Address?.trim()
            const hasVlanCfg = port.vlanMode === 'trunk' || port.vlanMode === 'access'

            // Skip unconfigured ports (no IP, no description, no VLAN mode) to keep config concise
            if (!parsed && !hasV6 && !description && !hasVlanCfg && port.enabled !== false) {
                // Only emit speed for channelized sub-ports (base was handled above)
                continue
            }

            if (description) { lines.push(`set interfaces ${ifName} description "${description}"`) }
            if (parsed) {
                lines.push(`set interfaces ${ifName} unit 0 family inet address ${parsed.ip}/${parsed.prefix}`)
            }
            if (hasV6) {
                lines.push(`set interfaces ${ifName} unit 0 family inet6 address ${hasV6}`)
            }
            // Emit speed on non-channelized ports (channelized base speed is handled above)
            if (!subPortCounts.has(base) && !isSubPort) {
                const junosSpeed = speedToJunos(port.speed)
                if (junosSpeed) { lines.push(`set interfaces ${ifName} speed ${junosSpeed}`) }
            }
            // Only apply L2 ethernet-switching config to ports WITHOUT an IP address.
            if (!parsed && !hasV6) {
                lines.push(...emitPortVlanConfig(port, 'juniper'))
            }
            if (!port.enabled) { lines.push(`set interfaces ${ifName} disable`) }
        }

        // ── ESI-LAG configuration ─────────────────────────────────────────
        // Detect ESI-LAG ports by description containing "ESI" and a LAG name (e.g. "ESI ae0")
        const esiPorts = ports.filter(p => {
            const desc = (p.description ?? '').toLowerCase()
            return desc.includes('esi') && desc.includes('ae')
        })
        if (esiPorts.length > 0) {
            lines.push('')
            lines.push('# ESI-LAG (EVPN multi-homing)')
            lines.push(`set chassis aggregated-devices ethernet device-count ${esiPorts.length}`)

            // Group ESI ports by ae name
            const aeGroups = new Map<string, typeof esiPorts>()
            for (const ep of esiPorts) {
                const aeMatch = (ep.description ?? '').match(/ae(\d+)/i)
                const aeName = aeMatch ? `ae${aeMatch[1]}` : 'ae0'
                if (!aeGroups.has(aeName)) { aeGroups.set(aeName, []) }
                aeGroups.get(aeName)!.push(ep)
            }

            let esiIdx = 1
            for (const [aeName, aePorts] of aeGroups) {
                // Generate deterministic ESI from loopback + ae index
                const loopOctet = loopParsed ? loopParsed.ip.split('.').pop() : '1'
                const esiValue = `00:11:22:33:44:55:66:77:${String(loopOctet).padStart(2, '0')}:${String(esiIdx).padStart(2, '0')}`
                // Shared LACP system-id for the leaf pair (same for both leaves in a pair)
                const lacpSysId = `00:00:00:01:01:${String(esiIdx).padStart(2, '0')}`

                lines.push(`set interfaces ${aeName} esi ${esiValue}`)
                lines.push(`set interfaces ${aeName} esi all-active`)
                lines.push(`set interfaces ${aeName} aggregated-ether-options lacp active`)
                lines.push(`set interfaces ${aeName} aggregated-ether-options lacp system-id ${lacpSysId}`)

                // Move physical ports into ae bundle
                for (const ep of aePorts) {
                    const ifName = ep.label.trim()
                    lines.push(`set interfaces ${ifName} ether-options 802.3ad ${aeName}`)
                }

                // Apply VLAN config from the first member port to the ae interface
                const firstPort = aePorts[0]
                if (firstPort) {
                    const mode = firstPort.vlanMode ?? 'access'
                    if (mode === 'trunk') {
                        lines.push(`set interfaces ${aeName} unit 0 family ethernet-switching interface-mode trunk`)
                        if (firstPort.trunkNativeVlan) {
                            lines.push(`set interfaces ${aeName} native-vlan-id ${firstPort.trunkNativeVlan}`)
                        }
                        const allowed = firstPort.trunkAllowedVlans ?? ''
                        if (allowed && allowed.toLowerCase() !== 'all') {
                            for (const vid of allowed.split(',')) {
                                lines.push(`set interfaces ${aeName} unit 0 family ethernet-switching vlan members vlan${vid.trim()}`)
                            }
                        } else if (allowed.toLowerCase() === 'all') {
                            lines.push(`set interfaces ${aeName} unit 0 family ethernet-switching vlan members all`)
                        }
                    } else if (mode === 'access' && firstPort.vlan) {
                        lines.push(`set interfaces ${aeName} unit 0 family ethernet-switching interface-mode access`)
                        lines.push(`set interfaces ${aeName} unit 0 family ethernet-switching vlan members vlan${firstPort.vlan}`)
                    }
                }
                esiIdx++
            }
        }

        lines.push('')
        lines.push('# NTP, DNS, Syslog')
        lines.push('set system ntp server 10.0.0.254')
        lines.push('set system name-server 10.0.0.254')
        lines.push('set system syslog host 10.0.0.254 any info')
        lines.push('set system syslog file messages any notice')
        lines.push('set system syslog file interactive-commands interactive-commands any')

        // ── LLDP ──────────────────────────────────────────────────────────
        lines.push('')
        lines.push('# LLDP')
        lines.push('set protocols lldp interface all')
        lines.push('set protocols lldp-med interface all')

        // ── Storm control (L2 access/trunk ports) ─────────────────────────
        const hasL2Ports = ports.some(p => {
            const parsed2 = parseIpCidr(p.ipAddress)
            return !parsed2 && !p.ipv6Address?.trim() && p.enabled !== false
        })
        if (hasL2Ports) {
            lines.push('')
            lines.push('# Storm control')
            lines.push('set forwarding-options storm-control-profiles sc-default all bandwidth-percentage 80')
            lines.push('set forwarding-options storm-control-profiles sc-default all no-multicast')
            for (const port of ports) {
                const parsed2 = parseIpCidr(port.ipAddress)
                const ifName = port.label.trim()
                const hasVlanConfig = port.vlanMode === 'trunk' || port.vlanMode === 'access'
                const hasDescription = (port.description ?? '').trim().length > 0
                // Only apply storm control to L2 ports that are actually configured (have VLAN mode or a description)
                if (!parsed2 && !port.ipv6Address?.trim() && ifName && port.enabled !== false && (hasVlanConfig || hasDescription)) {
                    lines.push(`set interfaces ${ifName} unit 0 family ethernet-switching storm-control sc-default`)
                }
            }
        }

        // ── RSTP (for L2 fabrics) ─────────────────────────────────────────
        if (hasL2Ports) {
            lines.push('')
            lines.push('# RSTP')
            lines.push('set protocols rstp bridge-priority 32768')
            lines.push('set protocols rstp interface all')
        }

        // ── BFD on BGP sessions ───────────────────────────────────────────
        const hasBgp = ctx.bgpNeighbors && ctx.bgpNeighbors.length > 0
        if (hasBgp) {
            lines.push('')
            lines.push('# BFD for fast failure detection')
            const hasEbgp = ctx.bgpNeighbors!.some(n => n.peerAsn !== ctx.asn)
            const hasIbgp = ctx.bgpNeighbors!.some(n => n.peerAsn === ctx.asn)
            if (hasEbgp) {
                lines.push('set protocols bgp group EBGP bfd-liveness-detection minimum-interval 300')
                lines.push('set protocols bgp group EBGP bfd-liveness-detection multiplier 3')
            }
            if (hasIbgp) {
                lines.push('set protocols bgp group IBGP bfd-liveness-detection minimum-interval 300')
                lines.push('set protocols bgp group IBGP bfd-liveness-detection multiplier 3')
            }
        }

        // ── MTU for VXLAN underlay ────────────────────────────────────────
        if (ctx.overlayEnabled) {
            lines.push('')
            lines.push('# Jumbo MTU for VXLAN underlay')
            for (const port of ports) {
                const parsed2 = parseIpCidr(port.ipAddress)
                const hasV6 = port.ipv6Address && port.ipv6Address.trim()
                const ifName = port.label.trim()
                if ((parsed2 || hasV6) && ifName) {
                    lines.push(`set interfaces ${ifName} mtu 9216`)
                }
            }
        }

        lines.push(...emitBgpUnderlay('juniper', ctx))
        lines.push(...emitEvpnOverlay('juniper', ctx))
        // Explicit T5↔T5 VRFs (RLI 52387). Emitted AFTER emitEvpnOverlay so
        // the template-declared VRFs in ctx.vrfs[] take precedence over the
        // auto-generated EVPN-VRF stanza inside emitEvpnOverlay when both
        // are present. No-op when ctx.vrfs is empty or the current node
        // isn't a member of any VRF.
        lines.push(...emitJunosT5Vrfs(ctx))
        lines.push(...emitOspfUnderlay('juniper', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('juniper', ctx))
        lines.push(...emitSrMpls('juniper', ctx))
        lines.push(...emitSrv6('juniper', ctx))
        lines.push(...emitMplsLdp('juniper', ctx))
        lines.push(...emitTelemetry('juniper', ctx))
        // NOTE: do NOT append `commit and-quit` here. The push pipeline wraps
        // this body with `configure` + `load set terminal` preamble and
        // `\x04` + `commit` + `exit` + `exit` postamble. A trailing
        // `commit and-quit` inside the body would land inside `load set
        // terminal`, where Junos rejects it as "unknown command: commit"
        // (commit isn't a config-input keyword). The actual commit happens
        // via the postamble.
        return lines.join('\n')
    }

    // ── SONiC ────────────────────────────────────────────────────────────
    if (vendorKey === 'sonic') {
        const lines: string[] = []
        lines.push(`# ${vendor} ${ctx.nodeType} startup config`)
        if (switchFamily) { lines.push(`# platform ${switchFamily}`) }
        if (model) { lines.push(`# model ${model}`) }
        lines.push(`hostname ${host}`)
        if (mgmtHost) { lines.push(`# management-ip ${mgmtHost}`) }
        if (sshUser) { lines.push(`# ssh user: ${sshUser}`) }
        if (loopParsed) {
            lines.push('config loopback add Loopback0')
            lines.push(`config interface ip add Loopback0 ${loopParsed.ip}/${loopParsed.prefix}`)
        }
        if (loopV6) {
            if (!loopParsed) { lines.push('config loopback add Loopback0') }
            lines.push(`config interface ip add Loopback0 ${loopV6.ip}/${loopV6.prefix}`)
        }

        // VLAN declarations
        const sonicVlans = emitVlanDeclarations(ctx.vlans, 'sonic')
        if (sonicVlans.length) { lines.push(''); lines.push(...sonicVlans) }
        lines.push('')

        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            lines.push(port.enabled ? `config interface startup ${ifName}` : `config interface shutdown ${ifName}`)
            const parsed = parseIpCidr(port.ipAddress)
            if (parsed) { lines.push(`config interface ip add ${ifName} ${parsed.ip}/${parsed.prefix}`) }
            if (port.ipv6Address?.trim()) { lines.push(`config interface ip add ${ifName} ${port.ipv6Address.trim()}`) }
            const sl = speedToLabel(port.speed)
            if (sl) { lines.push(`config interface speed ${ifName} ${sl}`) }
            lines.push(...emitPortVlanConfig(port, 'sonic'))
            const description = (port.description ?? '').trim()
            if (description) { lines.push(`# description ${ifName}: ${description}`) }
        }

        lines.push(...emitBgpUnderlay('sonic', ctx))
        lines.push(...emitEvpnOverlay('sonic', ctx))
        lines.push(...emitOspfUnderlay('sonic', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('sonic', ctx))
        lines.push(...emitSrMpls('sonic', ctx))
        lines.push(...emitSrv6('sonic', ctx))
        lines.push(...emitMplsLdp('sonic', ctx))
        lines.push(...emitTelemetry('sonic', ctx))
        return lines.join('\n').trim()
    }

    // ── Arista (EOS) ────────────────────────────────────────────────────
    if (vendorKey === 'arista') {
        const lines: string[] = []
        lines.push(`! ${vendor} ${ctx.nodeType} startup config`)
        if (switchFamily) { lines.push(`! platform ${switchFamily}`) }
        if (model) { lines.push(`! model ${model}`) }
        lines.push(`hostname ${host}`)
        if (mgmtHost) { lines.push(`! management-ip ${mgmtHost}`) }
        if (sshUser) {
            lines.push(`username ${sshUser} role network-admin nopassword`)
            lines.push(`! Set password: username ${sshUser} secret <your-password>`)
        }
        lines.push('management ssh')
        lines.push('   idle-timeout 30')
        lines.push('!')

        // VLAN declarations
        const aristaVlans = emitVlanDeclarations(ctx.vlans, 'ios')
        if (aristaVlans.length) { lines.push(...aristaVlans); lines.push('!') }

        if (loopParsed || loopV6) {
            lines.push('interface Loopback0')
            if (loopParsed) { lines.push(`   ip address ${loopParsed.ip}/${loopParsed.prefix}`) }
            if (loopV6) { lines.push(`   ipv6 address ${loopV6.ip}/${loopV6.prefix}`) }
            lines.push('!')
        }

        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            lines.push(`interface ${ifName}`)
            const description = (port.description ?? '').trim()
            if (description) { lines.push(`   description ${description}`) }
            const parsed = parseIpCidr(port.ipAddress)
            if (parsed) { lines.push(`   ip address ${parsed.ip}/${parsed.prefix}`) }
            if (port.ipv6Address?.trim()) { lines.push(`   ipv6 address ${port.ipv6Address.trim()}`) }
            const sl = speedToLabel(port.speed)
            if (sl) { lines.push(`   speed forced ${sl}full`) }
            const vlanLines = emitPortVlanConfig(port, 'arista')
            lines.push(...vlanLines.map(l => l.startsWith(' ') ? `  ${l}` : `   ${l}`))
            lines.push(port.enabled ? '   no shutdown' : '   shutdown')
            lines.push('!')
        }

        lines.push(...emitBgpUnderlay('arista', ctx))
        lines.push(...emitEvpnOverlay('arista', ctx))
        // Explicit T5↔T5 VRFs (RLI 52387) — emits per-VRF Arista stanzas
        // from ctx.vrfs. No-op when ctx.vrfs is empty.
        lines.push(...emitAristaT5Vrfs(ctx))
        lines.push(...emitOspfUnderlay('arista', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('arista', ctx))
        lines.push(...emitSrMpls('arista', ctx))
        lines.push(...emitSrv6('arista', ctx))
        lines.push(...emitMplsLdp('arista', ctx))
        lines.push(...emitTelemetry('arista', ctx))
        lines.push('end')
        return lines.join('\n')
    }

    // ── Nokia (SR Linux / SR OS) ────────────────────────────────────────
    if (vendorKey === 'nokia') {
        // 7750-SR uses classic SR OS config syntax
        if (switchFamily === '7750-SR') {
            const lines: string[] = []
            lines.push(`# ${vendor} ${ctx.nodeType} startup config (SR OS)`)
            if (model) { lines.push(`# model ${model}`) }
            lines.push(`configure system name "${host}"`)
            if (mgmtHost) { lines.push(`# management-ip ${mgmtHost}`) }
            if (sshUser) {
                lines.push(`configure system security user "${sshUser}" access console ftp`)
                lines.push(`# configure system security user "${sshUser}" password <your-password>`)
            }
            lines.push('configure system security ssh server-admin-state enable')
            if (loopParsed) {
                lines.push(`configure router interface "system" address ${loopParsed.ip}/${loopParsed.prefix}`)
            }
            if (loopV6) {
                lines.push(`configure router interface "system" ipv6 address ${loopV6.ip}/${loopV6.prefix}`)
            }

            for (const port of ports) {
                const ifName = port.label.trim()
                if (!ifName) { continue }
                const description = (port.description ?? '').trim().replace(/"/g, '')
                if (description) { lines.push(`configure port ${ifName} description "${description}"`) }
                lines.push(`configure port ${ifName} admin-state ${port.enabled ? 'enable' : 'disable'}`)
                const parsed = parseIpCidr(port.ipAddress)
                if (parsed) {
                    lines.push(`configure router interface "${ifName}" address ${parsed.ip}/${parsed.prefix}`)
                    lines.push(`configure router interface "${ifName}" port ${ifName}`)
                }
                if (port.ipv6Address?.trim()) {
                    lines.push(`configure router interface "${ifName}" ipv6 address ${port.ipv6Address.trim()}`)
                }
                lines.push(...emitPortVlanConfig(port, 'nokia'))
            }

            lines.push(...emitBgpUnderlay('nokia', ctx))
            lines.push(...emitEvpnOverlay('nokia', ctx))
            lines.push(...emitOspfUnderlay('nokia', ctx, ctx.underlayProtocol === 'ospfv3'))
            lines.push(...emitIsisUnderlay('nokia', ctx))
            lines.push(...emitSrMpls('nokia', ctx))
            lines.push(...emitSrv6('nokia', ctx))
            lines.push(...emitMplsLdp('nokia', ctx))
            lines.push(...emitTelemetry('nokia', ctx))
            lines.push('admin save')
            return lines.join('\n')
        }

        // 7220-IXR / 7250-IXR — SR Linux (default Nokia path)
        const lines: string[] = []
        lines.push(`# ${vendor} ${ctx.nodeType} startup config (SR Linux)`)
        if (switchFamily) { lines.push(`# device-type ${switchFamily}`) }
        if (model) { lines.push(`# model ${model}`) }
        lines.push(`set / system name host-name ${host}`)
        if (mgmtHost) { lines.push(`# management-ip ${mgmtHost}`) }
        if (sshUser) {
            lines.push(`set / system aaa authentication user ${sshUser} role admin`)
            lines.push(`# set / system aaa authentication user ${sshUser} password <your-password>`)
        }
        if (loopParsed) {
            lines.push(`set / interface system0 subinterface 0 ipv4 address ${loopParsed.ip}/${loopParsed.prefix}`)
        }
        if (loopV6) {
            lines.push(`set / interface system0 subinterface 0 ipv6 address ${loopV6.ip}/${loopV6.prefix}`)
        }

        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            const description = (port.description ?? '').trim().replace(/"/g, '')
            if (description) { lines.push(`set / interface ${ifName} description "${description}"`) }
            lines.push(`set / interface ${ifName} admin-state ${port.enabled ? 'enable' : 'disable'}`)
            const parsed = parseIpCidr(port.ipAddress)
            if (parsed) {
                lines.push(`set / interface ${ifName} subinterface 0 ipv4 address ${parsed.ip}/${parsed.prefix}`)
            }
            if (port.ipv6Address?.trim()) {
                lines.push(`set / interface ${ifName} subinterface 0 ipv6 address ${port.ipv6Address.trim()}`)
            }
            lines.push(...emitPortVlanConfig(port, 'nokia'))
        }

        lines.push(...emitBgpUnderlay('nokia', ctx))
        lines.push(...emitEvpnOverlay('nokia', ctx))
        lines.push(...emitOspfUnderlay('nokia', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('nokia', ctx))
        lines.push(...emitSrMpls('nokia', ctx))
        lines.push(...emitSrv6('nokia', ctx))
        lines.push(...emitMplsLdp('nokia', ctx))
        lines.push(...emitTelemetry('nokia', ctx))
        lines.push('commit now')
        return lines.join('\n')
    }

    // ── Huawei (VRP) ────────────────────────────────────────────────────
    if (vendorKey === 'huawei') {
        const lines: string[] = []
        lines.push(`# ${vendor} ${ctx.nodeType} startup config`)
        if (switchFamily) { lines.push(`# device-type ${switchFamily}`) }
        if (model) { lines.push(`# model ${model}`) }
        lines.push(`sysname ${host}`)
        if (mgmtHost) { lines.push(`# management-ip ${mgmtHost}`) }
        lines.push('stelnet server enable')
        if (sshUser) {
            lines.push(`aaa`)
            lines.push(` local-user ${sshUser} privilege level 15`)
            lines.push(` local-user ${sshUser} service-type terminal ssh`)
            lines.push(` # local-user ${sshUser} password irreversible-cipher <your-password>`)
        }
        lines.push('#')

        // VLAN declarations
        const huaweiVlans = emitVlanDeclarations(ctx.vlans, 'huawei')
        if (huaweiVlans.length) { lines.push(...huaweiVlans) }

        if (loopParsed || loopV6) {
            lines.push('interface LoopBack0')
            if (loopParsed) { lines.push(` ip address ${loopParsed.ip} ${loopParsed.mask}`) }
            if (loopV6) { lines.push(` ipv6 address ${loopV6.ip}/${loopV6.prefix}`) }
            lines.push('#')
        }

        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            lines.push(`interface ${ifName}`)
            const description = (port.description ?? '').trim()
            if (description) { lines.push(` description ${description}`) }
            const parsed = parseIpCidr(port.ipAddress)
            if (parsed) { lines.push(` ip address ${parsed.ip} ${parsed.mask}`) }
            if (port.ipv6Address?.trim()) { lines.push(` ipv6 address ${port.ipv6Address.trim()}`) }
            const sl = speedToLabel(port.speed)
            if (sl && ['10', '100', '1000'].includes(sl)) { lines.push(` speed ${sl}`) }
            lines.push(...emitPortVlanConfig(port, 'huawei'))
            lines.push(port.enabled ? ' undo shutdown' : ' shutdown')
            lines.push('#')
        }

        lines.push(...emitBgpUnderlay('huawei', ctx))
        lines.push(...emitEvpnOverlay('huawei', ctx))
        lines.push(...emitOspfUnderlay('huawei', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('huawei', ctx))
        lines.push(...emitSrMpls('huawei', ctx))
        lines.push(...emitSrv6('huawei', ctx))
        lines.push(...emitMplsLdp('huawei', ctx))
        lines.push('return')
        return lines.join('\n')
    }

    // ── Dell OS10 ───────────────────────────────────────────────────────
    if (vendorKey === 'dell') {
        const lines: string[] = []
        lines.push(`! ${vendor} ${ctx.nodeType} startup config`)
        if (switchFamily) { lines.push(`! device-type ${switchFamily}`) }
        if (model) { lines.push(`! model ${model}`) }
        lines.push(`hostname ${host}`)
        if (mgmtHost) { lines.push(`! management-ip ${mgmtHost}`) }
        if (sshUser) {
            lines.push(`username ${sshUser} role sysadmin`)
            lines.push(`! Set password: username ${sshUser} password <your-password>`)
        }
        lines.push('ip ssh server enable')
        lines.push('!')

        // VLAN declarations
        const dellVlans = emitVlanDeclarations(ctx.vlans, 'ios')
        if (dellVlans.length) { lines.push(...dellVlans); lines.push('!') }

        if (loopParsed || loopV6) {
            lines.push('interface loopback0')
            if (loopParsed) { lines.push(` ip address ${loopParsed.ip}/${loopParsed.prefix}`) }
            if (loopV6) { lines.push(` ipv6 address ${loopV6.ip}/${loopV6.prefix}`) }
            lines.push(' no shutdown')
            lines.push('!')
        }

        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            lines.push(`interface ${ifName}`)
            const description = (port.description ?? '').trim()
            if (description) { lines.push(` description ${description}`) }
            const parsed = parseIpCidr(port.ipAddress)
            if (parsed) { lines.push(` ip address ${parsed.ip}/${parsed.prefix}`) }
            if (port.ipv6Address?.trim()) { lines.push(` ipv6 address ${port.ipv6Address.trim()}`) }
            const sl = speedToLabel(port.speed)
            if (sl) { lines.push(` speed ${sl}`) }
            lines.push(...emitPortVlanConfig(port, 'dell'))
            lines.push(port.enabled ? ' no shutdown' : ' shutdown')
            lines.push('!')
        }

        lines.push(...emitBgpUnderlay('dell', ctx))
        lines.push(...emitEvpnOverlay('dell', ctx))
        lines.push(...emitOspfUnderlay('dell', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('dell', ctx))
        lines.push(...emitSrMpls('dell', ctx))
        lines.push(...emitSrv6('dell', ctx))
        lines.push(...emitMplsLdp('dell', ctx))
        lines.push('end')
        return lines.join('\n')
    }

    // ── HPE (Aruba OS-CX / Comware) ───────────────────────────────────
    if (vendorKey === 'hpe') {
        // FlexNetwork uses Comware CLI syntax
        if (switchFamily === 'FlexNetwork') {
            const lines: string[] = []
            lines.push(`# ${vendor} ${ctx.nodeType} startup config (Comware)`)
            if (model) { lines.push(`# model ${model}`) }
            lines.push(`sysname ${host}`)
            if (mgmtHost) { lines.push(`# management-ip ${mgmtHost}`) }
            if (sshUser) {
                lines.push('local-user ' + sshUser + ' class manage')
                lines.push(` service-type ssh terminal`)
                lines.push(` authorization-attribute user-role network-admin`)
                lines.push(` # password simple <your-password>`)
            }
            lines.push('ssh server enable')
            lines.push('#')

            // VLAN declarations
            const comwareVlans = emitVlanDeclarations(ctx.vlans, 'huawei')
            if (comwareVlans.length) { lines.push(...comwareVlans) }

            if (loopParsed || loopV6) {
                lines.push('interface LoopBack0')
                if (loopParsed) { lines.push(` ip address ${loopParsed.ip} ${loopParsed.mask}`) }
                if (loopV6) { lines.push(` ipv6 address ${loopV6.ip}/${loopV6.prefix}`) }
                lines.push('#')
            }

            for (const port of ports) {
                const ifName = port.label.trim()
                if (!ifName) { continue }
                lines.push(`interface ${ifName}`)
                const description = (port.description ?? '').trim()
                if (description) { lines.push(` description ${description}`) }
                const parsed = parseIpCidr(port.ipAddress)
                if (parsed) { lines.push(` ip address ${parsed.ip} ${parsed.mask}`) }
                if (port.ipv6Address?.trim()) { lines.push(` ipv6 address ${port.ipv6Address.trim()}`) }
                lines.push(...emitPortVlanConfig(port, 'hpe'))
                lines.push(port.enabled ? ' undo shutdown' : ' shutdown')
                lines.push('#')
            }

            lines.push(...emitBgpUnderlay('hpe', ctx))
            lines.push(...emitEvpnOverlay('hpe', ctx))
            lines.push(...emitOspfUnderlay('hpe', ctx, ctx.underlayProtocol === 'ospfv3'))
            lines.push(...emitIsisUnderlay('hpe', ctx))
            lines.push(...emitSrMpls('hpe', ctx))
            lines.push(...emitSrv6('hpe', ctx))
            lines.push(...emitMplsLdp('hpe', ctx))
            lines.push('return')
            return lines.join('\n')
        }

        // Aruba-CX (default HPE path)
        const lines: string[] = []
        lines.push(`! ${vendor} ${ctx.nodeType} startup config (AOS-CX)`)
        if (switchFamily) { lines.push(`! device-type ${switchFamily}`) }
        if (model) { lines.push(`! model ${model}`) }
        lines.push(`hostname ${host}`)
        if (mgmtHost) { lines.push(`! management-ip ${mgmtHost}`) }
        if (sshUser) {
            lines.push(`user-group administrators`)
            lines.push(`user ${sshUser} group administrators`)
            lines.push(`! Set password for user: user ${sshUser} password <your-password>`)
        }
        lines.push('ssh server vrf default')
        lines.push('!')

        // VLAN declarations
        const hpeVlans = emitVlanDeclarations(ctx.vlans, 'ios')
        if (hpeVlans.length) { lines.push(...hpeVlans); lines.push('!') }

        if (loopParsed || loopV6) {
            lines.push('interface loopback 0')
            if (loopParsed) { lines.push(` ip address ${loopParsed.ip}/${loopParsed.prefix}`) }
            if (loopV6) { lines.push(` ipv6 address ${loopV6.ip}/${loopV6.prefix}`) }
            lines.push('!')
        }

        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            lines.push(`interface ${ifName}`)
            const description = (port.description ?? '').trim()
            if (description) { lines.push(` description ${description}`) }
            const parsed = parseIpCidr(port.ipAddress)
            if (parsed) { lines.push(` ip address ${parsed.ip}/${parsed.prefix}`) }
            if (port.ipv6Address?.trim()) { lines.push(` ipv6 address ${port.ipv6Address.trim()}`) }
            lines.push(...emitPortVlanConfig(port, 'hpe'))
            lines.push(port.enabled ? ' no shutdown' : ' shutdown')
            lines.push('!')
        }

        lines.push(...emitBgpUnderlay('hpe', ctx))
        lines.push(...emitEvpnOverlay('hpe', ctx))
        lines.push(...emitOspfUnderlay('hpe', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('hpe', ctx))
        lines.push(...emitSrMpls('hpe', ctx))
        lines.push(...emitSrv6('hpe', ctx))
        lines.push(...emitMplsLdp('hpe', ctx))
        lines.push('end')
        return lines.join('\n')
    }

    // ── MikroTik (RouterOS) ─────────────────────────────────────────────
    if (vendorKey === 'mikrotik') {
        const lines: string[] = []
        lines.push(`# ${vendor} ${ctx.nodeType} startup config`)
        if (switchFamily) { lines.push(`# device-type ${switchFamily}`) }
        if (model) { lines.push(`# model ${model}`) }
        lines.push(`/system identity set name=${host}`)
        if (mgmtHost) { lines.push(`# management-ip ${mgmtHost}`) }
        if (sshUser) {
            lines.push(`/user add name=${sshUser} group=full`)
            lines.push(`# /user set ${sshUser} password=<your-password>`)
        }
        lines.push('/ip ssh set strong-crypto=yes')
        if (loopParsed) {
            lines.push(`/ip address add address=${loopParsed.ip}/${loopParsed.prefix} interface=loopback`)
        }
        if (loopV6) {
            lines.push(`/ipv6 address add address=${loopV6.ip}/${loopV6.prefix} interface=loopback`)
        }

        // VLAN declarations
        const mtVlans = emitVlanDeclarations(ctx.vlans, 'mikrotik')
        if (mtVlans.length) { lines.push(...mtVlans) }

        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            const description = (port.description ?? '').trim()
            if (description) { lines.push(`/interface ethernet set ${ifName} comment="${description}"`) }
            lines.push(`/interface ethernet set ${ifName} disabled=${port.enabled ? 'no' : 'yes'}`)
            const parsed = parseIpCidr(port.ipAddress)
            if (parsed) { lines.push(`/ip address add address=${parsed.ip}/${parsed.prefix} interface=${ifName}`) }
            if (port.ipv6Address?.trim()) { lines.push(`/ipv6 address add address=${port.ipv6Address.trim()} interface=${ifName}`) }
            lines.push(...emitPortVlanConfig(port, 'mikrotik'))
        }

        lines.push(...emitBgpUnderlay('mikrotik', ctx))
        lines.push(...emitEvpnOverlay('mikrotik', ctx))
        lines.push(...emitOspfUnderlay('mikrotik', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('mikrotik', ctx))
        lines.push(...emitSrMpls('mikrotik', ctx))
        lines.push(...emitSrv6('mikrotik', ctx))
        lines.push(...emitMplsLdp('mikrotik', ctx))
        return lines.join('\n')
    }

    // ── Extreme (EXOS / SLX-OS) ────────────────────────────────────────
    if (vendorKey === 'extreme') {
        // SLX — SLX-OS (Brocade-derived CLI)
        if (switchFamily === 'SLX') {
            const lines: string[] = []
            lines.push(`! ${vendor} ${ctx.nodeType} startup config (SLX-OS)`)
            if (model) { lines.push(`! model ${model}`) }
            lines.push(`switch-attributes host-name ${host}`)
            if (mgmtHost) { lines.push(`! management-ip ${mgmtHost}`) }
            if (sshUser) {
                lines.push(`username ${sshUser} role admin`)
                lines.push(`! username ${sshUser} password <your-password>`)
            }
            lines.push('ssh server enable')
            lines.push('!')

            if (loopParsed || loopV6) {
                lines.push('interface Loopback 1')
                if (loopParsed) { lines.push(` ip address ${loopParsed.ip}/${loopParsed.prefix}`) }
                if (loopV6) { lines.push(` ipv6 address ${loopV6.ip}/${loopV6.prefix}`) }
                lines.push(' no shutdown')
                lines.push('!')
            }

            for (const port of ports) {
                const ifName = port.label.trim()
                if (!ifName) { continue }
                lines.push(`interface Ethernet ${ifName}`)
                const description = (port.description ?? '').trim()
                if (description) { lines.push(` description ${description}`) }
                const parsed = parseIpCidr(port.ipAddress)
                if (parsed) { lines.push(` ip address ${parsed.ip}/${parsed.prefix}`) }
                if (port.ipv6Address?.trim()) { lines.push(` ipv6 address ${port.ipv6Address.trim()}`) }
                const sl = speedToLabel(port.speed)
                if (sl) { lines.push(` speed ${sl}`) }
                lines.push(...emitPortVlanConfig(port, 'extreme'))
                lines.push(port.enabled ? ' no shutdown' : ' shutdown')
                lines.push('!')
            }

            lines.push(...emitBgpUnderlay('extreme', ctx))
            lines.push(...emitEvpnOverlay('extreme', ctx))
            lines.push(...emitOspfUnderlay('extreme', ctx, ctx.underlayProtocol === 'ospfv3'))
            lines.push(...emitIsisUnderlay('extreme', ctx))
            lines.push(...emitSrMpls('extreme', ctx))
            lines.push(...emitSrv6('extreme', ctx))
            lines.push(...emitMplsLdp('extreme', ctx))
            lines.push('end')
            return lines.join('\n')
        }

        // ExtremeSwitching / VSP — EXOS (default Extreme path)
        const lines: string[] = []
        lines.push(`# ${vendor} ${ctx.nodeType} startup config (EXOS)`)
        if (switchFamily) { lines.push(`# device-type ${switchFamily}`) }
        if (model) { lines.push(`# model ${model}`) }
        lines.push(`configure snmp sysname "${host}"`)
        if (mgmtHost) { lines.push(`# management-ip ${mgmtHost}`) }
        if (sshUser) {
            lines.push(`create account admin ${sshUser}`)
            lines.push(`# configure account ${sshUser} encrypted <your-password>`)
        }
        lines.push('enable ssh2')
        if (loopParsed) {
            lines.push(`create vlan Loopback`)
            lines.push(`configure vlan Loopback ipaddress ${loopParsed.ip}/${loopParsed.prefix}`)
        }
        if (loopV6) {
            if (!loopParsed) { lines.push('create vlan Loopback') }
            lines.push(`configure vlan Loopback ipaddress ${loopV6.ip}/${loopV6.prefix}`)
        }

        // VLAN declarations
        const exVlans = emitVlanDeclarations(ctx.vlans, 'extreme')
        if (exVlans.length) { lines.push(...exVlans) }

        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            const description = (port.description ?? '').trim()
            if (description) { lines.push(`configure port ${ifName} description-string "${description}"`) }
            lines.push(port.enabled ? `enable port ${ifName}` : `disable port ${ifName}`)
            const parsed = parseIpCidr(port.ipAddress)
            const vlanName = `port_${ifName.replace(/[:/]/g, '_')}`
            if (parsed) {
                lines.push(`create vlan ${vlanName}`)
                lines.push(`configure vlan ${vlanName} add port ${ifName} untagged`)
                lines.push(`configure vlan ${vlanName} ipaddress ${parsed.ip}/${parsed.prefix}`)
            }
            if (port.ipv6Address?.trim()) {
                if (!parsed) {
                    lines.push(`create vlan ${vlanName}`)
                    lines.push(`configure vlan ${vlanName} add port ${ifName} untagged`)
                }
                lines.push(`configure vlan ${vlanName} ipaddress ${port.ipv6Address.trim()}`)
            }
            lines.push(...emitPortVlanConfig(port, 'extreme'))
        }

        lines.push(...emitBgpUnderlay('extreme', ctx))
        lines.push(...emitEvpnOverlay('extreme', ctx))
        lines.push(...emitOspfUnderlay('extreme', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('extreme', ctx))
        lines.push(...emitSrMpls('extreme', ctx))
        lines.push(...emitSrv6('extreme', ctx))
        lines.push(...emitMplsLdp('extreme', ctx))
        return lines.join('\n')
    }

    // ── Cisco NX-OS (Nexus) ────────────────────────────────────────────
    if (vendorKey === 'cisco' && switchFamily === 'Nexus') {
        const lines: string[] = []
        lines.push(`! Cisco NX-OS ${ctx.nodeType} startup config`)
        lines.push(`! device-type Nexus`)
        if (model) { lines.push(`! model ${model}`) }
        lines.push('')
        // NX-OS features
        lines.push('feature ssh')
        lines.push('feature interface-vlan')
        lines.push('feature lldp')
        lines.push('feature lacp')
        if (ctx.bgpNeighbors?.length || ctx.overlayEnabled) {
            lines.push('feature bgp')
            lines.push('feature bfd')
        }
        if (ctx.ospfInterfaces?.length) { lines.push('feature ospf') }
        if (ctx.isisInterfaces?.length) { lines.push('feature isis') }
        if (ctx.overlayEnabled) {
            lines.push('feature nv overlay')
            lines.push('feature vn-segment-vlan-based')
            lines.push('feature fabric forwarding')
            lines.push('feature vpc')
            lines.push('nv overlay evpn')
        }
        if (ctx.nodeSid != null) { lines.push('feature mpls segment-routing') }
        lines.push('')
        // CoPP
        lines.push('copp profile strict')
        lines.push('')
        lines.push(`hostname ${host}`)
        if (mgmtHost) { lines.push(`! management-ip ${mgmtHost}`) }
        if (sshUser) {
            lines.push(`username ${sshUser} role network-admin`)
            lines.push(`! username ${sshUser} password <SET-PASSWORD>`)
        }
        lines.push('!')
        // Anycast gateway MAC (global — required for fabric forwarding mode anycast-gateway)
        if (ctx.overlayEnabled && ctx.irbEnabled) {
            lines.push('fabric forwarding anycast-gateway-mac 0000.5e00.0101')
            lines.push('!')
        }

        // VLAN declarations
        const nxVlans = emitVlanDeclarations(ctx.vlans, 'ios')
        if (nxVlans.length) { lines.push(...nxVlans); lines.push('!') }

        // Loopback0 — Router ID / BGP
        if (loopParsed || loopV6) {
            lines.push('interface loopback0')
            lines.push('  description Router-ID')
            if (loopParsed) { lines.push(`  ip address ${loopParsed.ip}/${loopParsed.prefix}`) }
            if (loopV6) { lines.push(`  ipv6 address ${loopV6.ip}/${loopV6.prefix}`) }
            lines.push('  no shutdown')
            lines.push('!')
        }
        // Loopback1 — NVE VTEP source (best practice: separate from router-id)
        if (ctx.overlayEnabled && loopParsed) {
            const lo1Octets = loopParsed.ip.split('.')
            lo1Octets[2] = String(Math.min(Number(lo1Octets[2]) + 100, 255)) // offset to avoid collision
            const lo1Ip = lo1Octets.join('.')
            lines.push('interface loopback1')
            lines.push('  description VTEP-Source')
            lines.push(`  ip address ${lo1Ip}/32`)
            lines.push('  no shutdown')
            lines.push('!')
        }

        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            lines.push(`interface ${ifName}`)
            const description = (port.description ?? '').trim()
            if (description) { lines.push(`  description ${description}`) }
            const parsed = parseIpCidr(port.ipAddress)
            if (parsed) {
                lines.push('  no switchport')
                lines.push(`  mtu 9216`)
                lines.push(`  ip address ${parsed.ip}/${parsed.prefix}`)
            }
            if (port.ipv6Address?.trim()) {
                if (!parsed) { lines.push('  no switchport') }
                lines.push('  mtu 9216')
                lines.push(`  ipv6 address ${port.ipv6Address.trim()}`)
            }
            const sl = speedToLabel(port.speed)
            if (sl) { lines.push(`  speed ${sl}`) }
            lines.push(...emitPortVlanConfig(port, 'cisco'))
            lines.push(port.enabled ? '  no shutdown' : '  shutdown')
            lines.push('!')
        }

        // BFD for BGP
        if (ctx.bgpNeighbors?.length) {
            lines.push('!')
            lines.push('! BFD for fast failure detection')
            lines.push('bfd interval 300 min_rx 300 multiplier 3')
        }

        lines.push(...emitBgpUnderlay('cisco', ctx))
        lines.push(...emitEvpnOverlay('cisco', ctx))
        lines.push(...emitOspfUnderlay('cisco', ctx, ctx.underlayProtocol === 'ospfv3'))
        lines.push(...emitIsisUnderlay('cisco', ctx))
        lines.push(...emitSrMpls('cisco', ctx))
        lines.push(...emitSrv6('cisco', ctx))
        lines.push(...emitMplsLdp('cisco', ctx))
        lines.push(...emitTelemetry('cisco', ctx))
        lines.push('end')
        return lines.join('\n')
    }

    // ── Cisco IOS-XR (ASR, NCS, XRd, XRv) ──────────────────────────────
    const isXR = vendorKey === 'cisco' && (
        switchFamily === 'ASR' ||
        /xr[dv]|ios-xr|iosxr|ncs|asr\s*9/i.test(model)
    )
    if (isXR) {
        const lines: string[] = []
        lines.push(`!! Cisco IOS-XR ${ctx.nodeType} startup config`)
        if (model) { lines.push(`!! model ${model}`) }
        lines.push('')
        lines.push(`hostname ${host}`)
        if (sshUser) {
            lines.push(`username ${sshUser}`)
            lines.push(' group root-lr')
            lines.push(' group cisco-support')
            lines.push(' secret 10 <SET-PASSWORD>')
            lines.push('!')
        }
        lines.push('line default')
        lines.push(' transport input ssh')
        lines.push('!')
        lines.push('ssh server v2')
        lines.push('ssh server vrf default')
        lines.push('!')

        // Loopback
        if (loopParsed || loopV6) {
            lines.push('interface Loopback0')
            lines.push(' description Router-ID')
            if (loopParsed) { lines.push(` ipv4 address ${loopParsed.ip} ${prefixToMask(loopParsed.prefix) ?? '255.255.255.255'}`) }
            if (loopV6) { lines.push(` ipv6 address ${loopV6.ip}/${loopV6.prefix}`) }
            lines.push(' no shutdown')
            lines.push('!')
        }

        // Interfaces
        for (const port of ports) {
            const ifName = port.label.trim()
            if (!ifName) { continue }
            const description = (port.description ?? '').trim()
            const parsed = parseIpCidr(port.ipAddress)
            const hasV6Port = port.ipv6Address?.trim()
            if (!parsed && !hasV6Port && !description) { continue }
            lines.push(`interface ${ifName}`)
            if (description) { lines.push(` description ${description}`) }
            if (parsed) {
                lines.push(` mtu 9216`)
                lines.push(` ipv4 address ${parsed.ip} ${prefixToMask(parsed.prefix) ?? '255.255.255.0'}`)
            }
            if (hasV6Port) {
                if (!parsed) { lines.push(' mtu 9216') }
                lines.push(` ipv6 address ${hasV6Port}`)
            }
            lines.push(port.enabled ? ' no shutdown' : ' shutdown')
            lines.push('!')
        }

        // BGP — IOS-XR style
        if (ctx.asn && ctx.bgpNeighbors?.length) {
            const rid = ctx.routerId ?? ''
            const neighbors = ctx.bgpNeighbors
            lines.push(`router bgp ${ctx.asn}`)
            if (rid) { lines.push(` bgp router-id ${rid}`) }
            lines.push(' bgp bestpath as-path multipath-relax')
            lines.push(' address-family ipv4 unicast')
            lines.push('  maximum-paths ebgp 64')
            if (rid) { lines.push(`  network ${rid}/32`) }
            lines.push(' !')
            if (ctx.overlayEnabled) {
                lines.push(' address-family l2vpn evpn')
                lines.push(' !')
            }
            for (const n of neighbors) {
                lines.push(` neighbor ${n.ip}`)
                lines.push(`  remote-as ${n.peerAsn}`)
                if (n.peerHostname) { lines.push(`  description ${n.peerHostname}`) }
                lines.push('  address-family ipv4 unicast')
                lines.push(`   route-policy PASS-ALL in`)
                lines.push(`   route-policy PASS-ALL out`)
                lines.push('  !')
                if (ctx.overlayEnabled) {
                    lines.push('  address-family l2vpn evpn')
                    lines.push('  !')
                }
                lines.push(' !')
            }
            lines.push('!')
            lines.push('route-policy PASS-ALL')
            lines.push('  pass')
            lines.push('end-policy')
            lines.push('!')
        }

        // IS-IS — IOS-XR style
        if (ctx.isisInterfaces?.length) {
            const rid = ctx.routerId ?? ''
            const nodeLevel = ctx.isisLevel ?? 2
            lines.push('router isis UNDERLAY')
            lines.push(' is-type ' + (nodeLevel === 1 ? 'level-1' : nodeLevel === 2 ? 'level-2-only' : 'level-1-2'))
            if (rid) {
                const net = (() => {
                    const parts = rid.split('.').map(Number)
                    if (parts.length !== 4) { return '' }
                    const padded = parts.map(p => String(p).padStart(3, '0')).join('')
                    return `49.0001.${padded.slice(0, 4)}.${padded.slice(4, 8)}.${padded.slice(8, 12)}.00`
                })()
                if (net) { lines.push(` net ${net}`) }
            }
            lines.push(' address-family ipv4 unicast')
            lines.push('  metric-style wide')
            if (ctx.nodeSid != null) {
                lines.push('  segment-routing mpls')
            }
            lines.push(' !')
            lines.push(` interface Loopback0`)
            lines.push('  passive')
            lines.push('  address-family ipv4 unicast')
            if (ctx.nodeSid != null) {
                lines.push(`   prefix-sid index ${ctx.nodeSid}`)
            }
            lines.push('  !')
            lines.push(' !')
            for (const iface of ctx.isisInterfaces) {
                lines.push(` interface ${iface.portLabel}`)
                lines.push('  point-to-point')
                lines.push('  address-family ipv4 unicast')
                lines.push('  !')
                lines.push('  bfd minimum-interval 300')
                lines.push('  bfd multiplier 3')
                lines.push(' !')
            }
            lines.push('!')
        }

        // SR-MPLS — IOS-XR style
        if (ctx.nodeSid != null) {
            const srgbStart = ctx.srgbStart ?? 16000
            const srgbEnd = ctx.srgbEnd ?? 23999
            lines.push('segment-routing')
            lines.push(' global-block ' + srgbStart + ' ' + srgbEnd)
            lines.push('!')
            // TI-LFA
            lines.push('router isis UNDERLAY')
            lines.push(' address-family ipv4 unicast')
            lines.push('  segment-routing mpls sr-prefer')
            lines.push(' !')
            for (const iface of (ctx.isisInterfaces ?? [])) {
                lines.push(` interface ${iface.portLabel}`)
                lines.push('  address-family ipv4 unicast')
                lines.push('   fast-reroute per-prefix')
                lines.push('   fast-reroute per-prefix ti-lfa')
                lines.push('  !')
                lines.push(' !')
            }
            lines.push('!')
        }

        // Telemetry
        if (ctx.telemetryEnabled) {
            const tc = ctx.telemetryConfig
            const grpcPort = tc?.collectorPort || 57400
            const tls = tc?.tls !== false
            const sampleInterval = tc?.sampleInterval || 30000
            lines.push('!')
            lines.push('!! gRPC/gNMI telemetry')
            lines.push('grpc')
            lines.push(` port ${grpcPort}`)
            if (!tls) { lines.push(' no-tls') }
            lines.push('!')
            lines.push('telemetry model-driven')
            lines.push(' sensor-group INTERFACES')
            lines.push('  sensor-path Cisco-IOS-XR-infra-statsd-oper:infra-statistics/interfaces/interface/latest/generic-counters')
            lines.push(' !')
            lines.push(' sensor-group BGP')
            lines.push('  sensor-path Cisco-IOS-XR-ipv4-bgp-oper:bgp/instances/instance/instance-active/default-vrf/neighbors/neighbor')
            lines.push(' !')
            lines.push(' subscription SUB1')
            lines.push(`  sensor-group-id INTERFACES sample-interval ${sampleInterval}`)
            lines.push(`  sensor-group-id BGP sample-interval ${sampleInterval}`)
            lines.push(' !')
            lines.push('!')
        }

        lines.push('end')
        return lines.join('\n')
    }

    // ── Cisco IOS-XE / default (also used for unrecognized vendors) ──
    const lines: string[] = []
    if (vendorKey === 'cisco') {
        lines.push(`! Cisco IOS-XE ${ctx.nodeType} startup config`)
        if (switchFamily) { lines.push(`! device-type ${switchFamily}`) }
        if (model) { lines.push(`! model ${model}`) }
    } else {
        lines.push(`! ${vendor} ${ctx.nodeType} startup config`)
    }
    lines.push(`hostname ${host}`)
    if (mgmtHost) { lines.push(`! management-ip ${mgmtHost}`) }
    if (sshUser) {
        lines.push(`username ${sshUser} privilege 15 secret <SET-PASSWORD>`)
    }
    lines.push('ip ssh version 2')
    lines.push('!')

    // VLAN declarations
    const ciscoVlans = emitVlanDeclarations(ctx.vlans, 'ios')
    if (ciscoVlans.length) { lines.push(...ciscoVlans); lines.push('!') }

    if (loopParsed || loopV6) {
        lines.push('interface Loopback0')
        if (loopParsed) { lines.push(` ip address ${loopParsed.ip} ${loopParsed.mask}`) }
        if (loopV6) { lines.push(` ipv6 address ${loopV6.ip}/${loopV6.prefix}`) }
        lines.push(' no shutdown')
        lines.push('!')
    }

    for (const port of ports) {
        const ifName = port.label.trim()
        if (!ifName) { continue }

        lines.push(`interface ${ifName}`)
        const description = (port.description ?? '').trim()
        if (description) { lines.push(` description ${description}`) }

        const parsed = parseIpCidr(port.ipAddress)
        if (parsed) {
            lines.push(` ip address ${parsed.ip} ${parsed.mask}`)
        }
        if (port.ipv6Address?.trim()) { lines.push(` ipv6 address ${port.ipv6Address.trim()}`) }

        const sl = speedToLabel(port.speed)
        if (sl && ['10', '100', '1000'].includes(sl)) { lines.push(` speed ${sl}`) }
        lines.push(...emitPortVlanConfig(port, 'cisco'))

        lines.push(port.enabled ? ' no shutdown' : ' shutdown')
        lines.push('!')
    }

    lines.push(...emitBgpUnderlay('cisco', ctx))
    lines.push(...emitEvpnOverlay('cisco', ctx))
    // Explicit T5↔T5 VRFs (RLI 52387) — Cisco NX-OS form. Emits when ctx.vrfs
    // has entries for this node. Note: NX-OS DCI interconnect requires route-
    // target rewriting via BGP route-maps; the emitter notes this in a comment.
    lines.push(...emitCiscoT5Vrfs(ctx))
    lines.push(...emitOspfUnderlay('cisco', ctx, ctx.underlayProtocol === 'ospfv3'))
    lines.push(...emitIsisUnderlay('cisco', ctx))
    lines.push(...emitSrMpls('cisco', ctx))
    lines.push(...emitSrv6('cisco', ctx))
    lines.push(...emitMplsLdp('cisco', ctx))
    lines.push(...emitTelemetry('cisco', ctx))
    lines.push('line vty 0 4')
    lines.push(' login local')
    lines.push(' transport input ssh')
    lines.push('!')
    lines.push('end')
    return lines.join('\n')
}
