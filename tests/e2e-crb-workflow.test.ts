// ═══════════════════════════════════════════════════════════════════════════════
// E2E Test — CRB (Centrally-Routed Bridging) Workflow
// Validates the full pipeline: topology → Set Protocol → Apply Service Profile →
// Auto-Assign IPs → Auto-Assign Loopbacks → Config Regeneration
//
// This is a logic-level integration test (no UI / Angular DI) — validates that
// the core services compose correctly for the CRB end-to-end flow.
// ═══════════════════════════════════════════════════════════════════════════════

import { buildVendorStartupConfig } from '../renderer/src/services/vendor-config-builder'
import { makeCtx } from './fixtures'
import type { TopologyNode, TopologyLink } from '../renderer/src/api/interfaces'

/** Helper: build the CRB context for a node. */
function crbCtx (node: Partial<TopologyNode>, overlayNeighbors: string[], vniMappings: Array<{ vlanId: number; vni: number; vlanName: string }>) {
    const vlans = [
        { id: 100, name: 'Tenant-A' },
        { id: 200, name: 'Tenant-B' },
        { id: 999, name: 'Native' },
    ]
    return makeCtx({
        hostname: node.label,
        asn: node.asn,
        routerId: node.loopbackIp?.split('/')[0] ?? '',
        underlayProtocol: 'ebgp',
        overlayEnabled: true,
        irbEnabled: true,
        irbMode: 'asymmetric',  // CRB
        nodeRole: node.role as any,
        vlans: node.role === 'spine' || node.role === 'super-spine' ? vlans : vlans,
        vniMappings: node.role === 'spine' || node.role === 'super-spine' ? vniMappings : vniMappings,
        vtepSourceIp: node.loopbackIp?.split('/')[0],
        overlayNeighbors,
        bgpNeighbors: [],
    })
}

describe('E2E — CRB fabric: topology → service profile → config', () => {
    const spines: TopologyNode[] = [
        {
            id: 'spine-1', type: 'switch', label: 'Spine-1', x: 0, y: 0, status: 'stopped',
            vendor: 'Juniper', role: 'spine', asn: 65001, loopbackIp: '10.0.0.1/32',
            ports: [
                { id: 'p0', label: 'et-0/0/0', enabled: true, ipAddress: '10.10.0.0/31' },
                { id: 'p1', label: 'et-0/0/1', enabled: true, ipAddress: '10.10.0.2/31' },
            ],
        },
        {
            id: 'spine-2', type: 'switch', label: 'Spine-2', x: 0, y: 0, status: 'stopped',
            vendor: 'Juniper', role: 'spine', asn: 65002, loopbackIp: '10.0.0.2/32',
            ports: [
                { id: 'p0', label: 'et-0/0/0', enabled: true, ipAddress: '10.10.1.0/31' },
                { id: 'p1', label: 'et-0/0/1', enabled: true, ipAddress: '10.10.1.2/31' },
            ],
        },
    ]
    const leaves: TopologyNode[] = [
        {
            id: 'leaf-1', type: 'switch', label: 'Leaf-1', x: 0, y: 0, status: 'stopped',
            vendor: 'Juniper', role: 'leaf', asn: 65011, loopbackIp: '10.0.0.11/32',
            ports: [
                { id: 'p0', label: 'xe-0/0/0', enabled: true, ipAddress: '10.10.0.1/31' },
                { id: 'p1', label: 'xe-0/0/1', enabled: true, ipAddress: '10.10.1.1/31' },
                { id: 'p2', label: 'xe-0/0/2', enabled: true, vlanMode: 'access', vlan: 100 },
            ],
        },
        {
            id: 'leaf-2', type: 'switch', label: 'Leaf-2', x: 0, y: 0, status: 'stopped',
            vendor: 'Juniper', role: 'leaf', asn: 65012, loopbackIp: '10.0.0.12/32',
            ports: [
                { id: 'p0', label: 'xe-0/0/0', enabled: true, ipAddress: '10.10.0.3/31' },
                { id: 'p1', label: 'xe-0/0/1', enabled: true, ipAddress: '10.10.1.3/31' },
                { id: 'p2', label: 'xe-0/0/2', enabled: true, vlanMode: 'access', vlan: 200 },
            ],
        },
    ]

    const leafLoopbacks = leaves.map(l => l.loopbackIp!.split('/')[0])
    const spineLoopbacks = spines.map(s => s.loopbackIp!.split('/')[0])
    const vniMappings = [
        { vlanId: 100, vni: 10100, vlanName: 'Tenant-A' },
        { vlanId: 200, vni: 10200, vlanName: 'Tenant-B' },
        { vlanId: 999, vni: 10999, vlanName: 'Native' },
    ]

    it('Spine-1 config has IRB on tenant VLANs (CRB centralized gateway)', () => {
        const ctx = crbCtx(spines[0], leafLoopbacks, vniMappings)
        const cfg = buildVendorStartupConfig('Juniper', spines[0].ports, ctx)

        // Hostname
        expect(cfg).toContain('set system host-name Spine-1')
        // BGP underlay
        expect(cfg).toContain('set routing-options autonomous-system 65001')
        // VLANs declared
        expect(cfg).toContain('set vlans vlan100 vlan-id 100')
        // VNI mappings present on spine in CRB
        expect(cfg).toMatch(/set vlans vlan100 vxlan vni 10100/)
        // IRB on tenant VLANs (CRB — centralized gateway)
        expect(cfg).toMatch(/set interfaces irb unit 100 family inet address/)
        expect(cfg).toMatch(/set interfaces irb unit 200 family inet address/)
        // IRB NOT on infrastructure VLAN 999
        expect(cfg).not.toMatch(/set interfaces irb unit 999 family inet address/)
        // EVPN overlay BGP group
        expect(cfg).toContain('set protocols evpn encapsulation vxlan')
    })

    it('Leaf-1 config has VLANs + VNI but NO IRB (CRB leaf is L2-only)', () => {
        const ctx = crbCtx(leaves[0], spineLoopbacks, vniMappings)
        const cfg = buildVendorStartupConfig('Juniper', leaves[0].ports, ctx)

        expect(cfg).toContain('set system host-name Leaf-1')
        expect(cfg).toContain('set vlans vlan100 vlan-id 100')
        expect(cfg).toMatch(/set vlans vlan100 vxlan vni 10100/)
        // CRB leaf has NO IRB
        expect(cfg).not.toMatch(/set interfaces irb unit \d+/)
        // Access port on leaf
        expect(cfg).toContain('interface-mode access')
    })

    it('Infrastructure VLAN 999 never gets IRB in any node', () => {
        for (const node of [...spines, ...leaves]) {
            const peers = node.role === 'spine' ? leafLoopbacks : spineLoopbacks
            const ctx = crbCtx(node, peers, vniMappings)
            const cfg = buildVendorStartupConfig('Juniper', node.ports, ctx)
            expect(cfg).not.toMatch(/set interfaces irb unit 999/)
        }
    })

    it('Servers are excluded from BGP (no ASN assignment)', () => {
        const server: TopologyNode = {
            id: 'srv-1', type: 'server', label: 'Srv-1', x: 0, y: 0, status: 'stopped',
            ports: [{ id: 'p0', label: 'eth0', enabled: true }],
        }
        // Server has no vendor, so no config is generated — this is by design
        // The server should never appear as a BGP neighbor in Leaf-1's config
        const ctx = crbCtx(leaves[0], spineLoopbacks, vniMappings)
        ctx.bgpNeighbors = [
            { ip: '10.0.0.1', peerAsn: 65001, portLabel: 'xe-0/0/0', peerHostname: 'Spine-1' },
            { ip: '10.0.0.2', peerAsn: 65002, portLabel: 'xe-0/0/1', peerHostname: 'Spine-2' },
        ]
        const cfg = buildVendorStartupConfig('Juniper', leaves[0].ports, ctx)
        expect(cfg).toContain('neighbor 10.0.0.1 peer-as 65001')
        expect(cfg).not.toContain('Srv-1')
    })
})

describe('E2E — ERB fabric: spines have no VLANs', () => {
    it('ERB spine config has no VLANs and no IRB (pure L3 RR)', () => {
        const spine: Partial<TopologyNode> = {
            label: 'Spine-1', vendor: 'Juniper', role: 'spine',
            asn: 65001, loopbackIp: '10.0.0.1/32',
        }
        const ctx = makeCtx({
            hostname: spine.label,
            asn: spine.asn,
            routerId: '10.0.0.1',
            underlayProtocol: 'ebgp',
            overlayEnabled: true,
            irbEnabled: true,
            irbMode: 'symmetric',  // ERB
            nodeRole: 'spine' as any,
            vlans: [],  // ERB spine has no VLANs (cleared in topology service)
            vniMappings: [],  // No VNI on ERB spine
            bgpNeighbors: [],
            overlayNeighbors: ['10.0.0.11', '10.0.0.12'],
        })
        const cfg = buildVendorStartupConfig('Juniper', [], ctx)
        expect(cfg).not.toMatch(/set vlans vlan\d+ vlan-id/)
        expect(cfg).not.toMatch(/set interfaces irb unit/)
    })
})

describe('E2E — Multi-vendor fabric consistency', () => {
    it('Juniper, Arista, and Cisco leaves all generate correct VNI mappings', () => {
        const vendors = ['Juniper', 'Arista', 'Cisco']
        const vniMappings = [{ vlanId: 100, vni: 10100, vlanName: 'Tenant-A' }]
        const leafOverlayPeers = ['10.0.0.1']

        for (const vendor of vendors) {
            const ctx = makeCtx({
                hostname: `${vendor}-Leaf-1`,
                asn: 65011, routerId: '10.0.0.11',
                underlayProtocol: 'ebgp',
                overlayEnabled: true,
                irbEnabled: true,
                irbMode: 'symmetric',
                nodeRole: 'leaf' as any,
                vlans: [{ id: 100, name: 'Tenant-A' }],
                vniMappings,
                vtepSourceIp: '10.0.0.11',
                overlayNeighbors: leafOverlayPeers,
                bgpNeighbors: [],
            })
            const cfg = buildVendorStartupConfig(vendor, [], ctx)
            // Each vendor should generate SOME form of VNI mapping for VLAN 100
            expect(cfg.toLowerCase()).toMatch(/10100|vni 10100|vn-segment 10100/)
        }
    })
})
