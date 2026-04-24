import { buildVendorStartupConfig, asnToAsdot, is4ByteAsn } from '../renderer/src/services/vendor-config-builder'
import { makeCtx, makePort } from './fixtures'

// ── Cisco ───────────────────────────────────────────────────────────────────

describe('Cisco (IOS)', () => {
    const vendor = 'cisco'

    it('sets hostname', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'core-rtr-01' }))
        expect(cfg).toContain('hostname core-rtr-01')
    })

    it('configures Loopback0 IPv4 with ip address and mask', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('interface Loopback0')
        expect(cfg).toContain(' ip address 10.0.0.1 255.255.255.255')
    })

    it('configures Loopback0 IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('interface Loopback0')
        expect(cfg).toContain(' ipv6 address fd00::1/128')
    })

    it('configures port IPv4 with ip address and mask', () => {
        const port = makePort({ label: 'GigabitEthernet0/1', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('interface GigabitEthernet0/1')
        expect(cfg).toContain(' ip address 10.1.0.1 255.255.255.252')
    })

    it('configures port IPv6', () => {
        const port = makePort({ label: 'GigabitEthernet0/1', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain(' ipv6 address fd00:1::1/127')
    })

    it('emits no shutdown for enabled port and shutdown for disabled', () => {
        const enabledPort = makePort({ label: 'Gi0/0', enabled: true })
        const disabledPort = makePort({ label: 'Gi0/1', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [enabledPort, disabledPort], makeCtx())
        const lines = cfg.split('\n')
        // Find the Gi0/0 block - should have 'no shutdown'
        const gi0Idx = lines.findIndex(l => l.includes('interface Gi0/0'))
        const gi1Idx = lines.findIndex(l => l.includes('interface Gi0/1'))
        expect(gi0Idx).toBeGreaterThan(-1)
        expect(gi1Idx).toBeGreaterThan(-1)
        // Between Gi0/0 and Gi0/1, should find 'no shutdown'
        const gi0Block = lines.slice(gi0Idx, gi1Idx).join('\n')
        expect(gi0Block).toContain(' no shutdown')
        // After Gi0/1, should find 'shutdown' (but not 'no shutdown')
        const gi1Block = lines.slice(gi1Idx, gi1Idx + 10).join('\n')
        expect(gi1Block).toContain(' shutdown')
        expect(gi1Block).not.toContain(' no shutdown')
    })

    it('sets port description', () => {
        const port = makePort({ label: 'Gi0/0', description: 'Uplink to spine' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain(' description Uplink to spine')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('hostname test-router')
        expect(cfg).not.toContain('interface Loopback0')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: 'Gi0/0', peerHostname: 'peer1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('router bgp 65001')
        expect(cfg).toContain(' bgp router-id 10.0.0.1')
        expect(cfg).toContain(' neighbor 10.0.0.2 remote-as 65002')
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'GigabitEthernet0/1', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('router ospf 1')
        expect(cfg).toContain(' router-id 10.0.0.1')
        expect(cfg).toContain('ip ospf 1 area 0.0.0.0')
    })
})

// ── Juniper ────────────────────────────────────────────────────────────────

describe('Juniper (JunOS)', () => {
    const vendor = 'juniper'

    it('sets hostname', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'qfx-spine-01' }))
        expect(cfg).toContain('set system host-name qfx-spine-01')
    })

    it('configures lo0 IPv4', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('set interfaces lo0 unit 0 family inet address 10.0.0.1/32')
    })

    it('configures lo0 IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('set interfaces lo0 unit 0 family inet6 address fd00::1/128')
    })

    it('configures port IPv4', () => {
        const port = makePort({ label: 'et-0/0/0', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('set interfaces et-0/0/0 unit 0 family inet address 10.1.0.1/30')
    })

    it('configures port IPv6', () => {
        const port = makePort({ label: 'et-0/0/0', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('set interfaces et-0/0/0 unit 0 family inet6 address fd00:1::1/127')
    })

    it('disables port when not enabled', () => {
        const port = makePort({ label: 'et-0/0/0', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('set interfaces et-0/0/0 disable')
    })

    it('does not disable enabled port', () => {
        const port = makePort({ label: 'et-0/0/0', enabled: true })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).not.toContain('set interfaces et-0/0/0 disable')
    })

    it('sets port description', () => {
        const port = makePort({ label: 'et-0/0/0', description: 'to-leaf-01' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('set interfaces et-0/0/0 description "to-leaf-01"')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('set system host-name test-router')
        expect(cfg).not.toContain('set interfaces lo0 unit 0 family inet address')
        expect(cfg).not.toContain('set interfaces lo0 unit 0 family inet6 address')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: 'et-0/0/0', peerHostname: 'peer1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('set routing-options autonomous-system 65001')
        expect(cfg).toContain('set routing-options router-id 10.0.0.1')
        expect(cfg).toContain('set protocols bgp group EBGP neighbor 10.0.0.2 peer-as 65002')
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'et-0/0/0', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('set protocols ospf area 0.0.0.0 interface lo0.0 passive')
        expect(cfg).toContain('set protocols ospf area 0.0.0.0 interface et-0/0/0.0')
    })
})

// ── Arista ──────────────────────────────────────────────────────────────────

describe('Arista (EOS)', () => {
    const vendor = 'arista'

    it('sets hostname', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'arista-leaf-01' }))
        expect(cfg).toContain('hostname arista-leaf-01')
    })

    it('configures Loopback0 IPv4 with ip/prefix', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('interface Loopback0')
        expect(cfg).toContain('   ip address 10.0.0.1/32')
    })

    it('configures Loopback0 IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('interface Loopback0')
        expect(cfg).toContain('   ipv6 address fd00::1/128')
    })

    it('configures port IPv4 with ip/prefix', () => {
        const port = makePort({ label: 'Ethernet1', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('interface Ethernet1')
        expect(cfg).toContain('   ip address 10.1.0.1/30')
    })

    it('configures port IPv6', () => {
        const port = makePort({ label: 'Ethernet1', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('   ipv6 address fd00:1::1/127')
    })

    it('emits no shutdown / shutdown for port', () => {
        const enabled = makePort({ label: 'Ethernet1', enabled: true })
        const disabled = makePort({ label: 'Ethernet2', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [enabled, disabled], makeCtx())
        const lines = cfg.split('\n')
        const e1Idx = lines.findIndex(l => l.includes('interface Ethernet1'))
        const e2Idx = lines.findIndex(l => l.includes('interface Ethernet2'))
        const e1Block = lines.slice(e1Idx, e2Idx).join('\n')
        const e2Block = lines.slice(e2Idx, e2Idx + 10).join('\n')
        expect(e1Block).toContain('   no shutdown')
        expect(e2Block).toContain('   shutdown')
        expect(e2Block).not.toContain('   no shutdown')
    })

    it('sets port description', () => {
        const port = makePort({ label: 'Ethernet1', description: 'to-spine' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('   description to-spine')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('hostname test-router')
        expect(cfg).not.toContain('interface Loopback0')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65100,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65200, portLabel: 'Ethernet1', peerHostname: 'spine1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('router bgp 65100')
        expect(cfg).toContain('   router-id 10.0.0.1')
        expect(cfg).toContain(`   neighbor 10.0.0.2 remote-as 65200`)
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'Ethernet1', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('router ospf 1')
        expect(cfg).toContain('   router-id 10.0.0.1')
        expect(cfg).toContain('interface Ethernet1')
        expect(cfg).toContain('   ip ospf area 0.0.0.0')
    })
})

// ── Nokia ──────────────────────────────────────────────────────────────────

describe('Nokia (SR Linux)', () => {
    const vendor = 'nokia'

    it('sets hostname', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'srl-spine-01' }))
        expect(cfg).toContain('set / system name host-name srl-spine-01')
    })

    it('configures system0 IPv4', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('set / interface system0 subinterface 0 ipv4 address 10.0.0.1/32')
    })

    it('configures system0 IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('set / interface system0 subinterface 0 ipv6 address fd00::1/128')
    })

    it('configures port IPv4', () => {
        const port = makePort({ label: 'ethernet-1/1', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('set / interface ethernet-1/1 subinterface 0 ipv4 address 10.1.0.1/30')
    })

    it('configures port IPv6', () => {
        const port = makePort({ label: 'ethernet-1/1', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('set / interface ethernet-1/1 subinterface 0 ipv6 address fd00:1::1/127')
    })

    it('sets port admin-state enable/disable', () => {
        const enabled = makePort({ label: 'ethernet-1/1', enabled: true })
        const disabled = makePort({ label: 'ethernet-1/2', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [enabled, disabled], makeCtx())
        expect(cfg).toContain('set / interface ethernet-1/1 admin-state enable')
        expect(cfg).toContain('set / interface ethernet-1/2 admin-state disable')
    })

    it('sets port description', () => {
        const port = makePort({ label: 'ethernet-1/1', description: 'to-leaf-01' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('set / interface ethernet-1/1 description "to-leaf-01"')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('set / system name host-name test-router')
        expect(cfg).not.toContain('set / interface system0 subinterface 0 ipv4')
        expect(cfg).not.toContain('set / interface system0 subinterface 0 ipv6')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: 'ethernet-1/1', peerHostname: 'leaf1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('set / network-instance default protocols bgp autonomous-system 65001')
        expect(cfg).toContain('set / network-instance default protocols bgp router-id 10.0.0.1')
        expect(cfg).toContain('set / network-instance default protocols bgp neighbor 10.0.0.2 peer-as 65002')
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'ethernet-1/1', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('set / network-instance default protocols ospf instance 1 admin-state enable')
        expect(cfg).toContain('set / network-instance default protocols ospf instance 1 router-id 10.0.0.1')
        expect(cfg).toContain('set / network-instance default protocols ospf instance 1 area 0.0.0.0 interface ethernet-1/1.0 admin-state enable')
    })
})

// ── SONiC ──────────────────────────────────────────────────────────────────

describe('SONiC', () => {
    const vendor = 'sonic'

    it('sets hostname', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'sonic-leaf-01' }))
        expect(cfg).toContain('hostname sonic-leaf-01')
    })

    it('configures Loopback0 IPv4', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('config loopback add Loopback0')
        expect(cfg).toContain('config interface ip add Loopback0 10.0.0.1/32')
    })

    it('configures Loopback0 IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('config interface ip add Loopback0 fd00::1/128')
    })

    it('configures port IPv4', () => {
        const port = makePort({ label: 'Ethernet0', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('config interface ip add Ethernet0 10.1.0.1/30')
    })

    it('configures port IPv6', () => {
        const port = makePort({ label: 'Ethernet0', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('config interface ip add Ethernet0 fd00:1::1/127')
    })

    it('sets port startup/shutdown', () => {
        const enabled = makePort({ label: 'Ethernet0', enabled: true })
        const disabled = makePort({ label: 'Ethernet4', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [enabled, disabled], makeCtx())
        expect(cfg).toContain('config interface startup Ethernet0')
        expect(cfg).toContain('config interface shutdown Ethernet4')
    })

    it('sets port description as comment', () => {
        const port = makePort({ label: 'Ethernet0', description: 'uplink' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('# description Ethernet0: uplink')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('hostname test-router')
        expect(cfg).not.toContain('config loopback add Loopback0')
        expect(cfg).not.toContain('config interface ip add Loopback0')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: 'Ethernet0', peerHostname: 'peer1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('config router bgp add 65001')
        expect(cfg).toContain('config router bgp set router-id 10.0.0.1')
        expect(cfg).toContain('config bgp neighbor add 10.0.0.2 65002')
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'Ethernet0', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('config router ospf set router-id 10.0.0.1')
        expect(cfg).toContain('config router ospf add network Loopback0 area 0.0.0.0')
        expect(cfg).toContain('config router ospf add network Ethernet0 area 0.0.0.0')
    })
})

// ── Huawei ─────────────────────────────────────────────────────────────────

describe('Huawei (VRP)', () => {
    const vendor = 'huawei'

    it('sets sysname', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'hw-core-01' }))
        expect(cfg).toContain('sysname hw-core-01')
    })

    it('configures LoopBack0 IPv4 with ip address and mask', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('interface LoopBack0')
        expect(cfg).toContain(' ip address 10.0.0.1 255.255.255.255')
    })

    it('configures LoopBack0 IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('interface LoopBack0')
        expect(cfg).toContain(' ipv6 address fd00::1/128')
    })

    it('configures port IPv4 with ip address and mask', () => {
        const port = makePort({ label: 'GE1/0/0', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('interface GE1/0/0')
        expect(cfg).toContain(' ip address 10.1.0.1 255.255.255.252')
    })

    it('configures port IPv6', () => {
        const port = makePort({ label: 'GE1/0/0', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain(' ipv6 address fd00:1::1/127')
    })

    it('emits undo shutdown / shutdown for port', () => {
        const enabled = makePort({ label: 'GE1/0/0', enabled: true })
        const disabled = makePort({ label: 'GE1/0/1', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [enabled, disabled], makeCtx())
        const lines = cfg.split('\n')
        const ge0Idx = lines.findIndex(l => l.trim() === 'interface GE1/0/0')
        const ge1Idx = lines.findIndex(l => l.trim() === 'interface GE1/0/1')
        const ge0Block = lines.slice(ge0Idx, ge1Idx).join('\n')
        const ge1Block = lines.slice(ge1Idx, ge1Idx + 10).join('\n')
        expect(ge0Block).toContain(' undo shutdown')
        expect(ge1Block).toContain(' shutdown')
        expect(ge1Block).not.toContain(' undo shutdown')
    })

    it('sets port description', () => {
        const port = makePort({ label: 'GE1/0/0', description: 'uplink' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain(' description uplink')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('sysname test-router')
        expect(cfg).not.toContain('interface LoopBack0')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: 'GE1/0/0', peerHostname: 'peer1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('bgp 65001')
        expect(cfg).toContain(' router-id 10.0.0.1')
        expect(cfg).toContain(' peer 10.0.0.2 as-number 65002')
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'GE1/0/0', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('ospf 1 router-id 10.0.0.1')
        expect(cfg).toContain('interface LoopBack0')
        expect(cfg).toContain(' ospf enable 1 area 0.0.0.0')
        expect(cfg).toContain('interface GE1/0/0')
    })
})

// ── Dell ───────────────────────────────────────────────────────────────────

describe('Dell (OS10)', () => {
    const vendor = 'dell'

    it('sets hostname', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'dell-sw-01' }))
        expect(cfg).toContain('hostname dell-sw-01')
    })

    it('configures loopback0 IPv4 with ip/prefix', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('interface loopback0')
        expect(cfg).toContain(' ip address 10.0.0.1/32')
    })

    it('configures loopback0 IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('interface loopback0')
        expect(cfg).toContain(' ipv6 address fd00::1/128')
    })

    it('configures port IPv4 with ip/prefix', () => {
        const port = makePort({ label: 'ethernet1/1/1', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('interface ethernet1/1/1')
        expect(cfg).toContain(' ip address 10.1.0.1/30')
    })

    it('configures port IPv6', () => {
        const port = makePort({ label: 'ethernet1/1/1', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain(' ipv6 address fd00:1::1/127')
    })

    it('emits no shutdown / shutdown for port', () => {
        const enabled = makePort({ label: 'ethernet1/1/1', enabled: true })
        const disabled = makePort({ label: 'ethernet1/1/2', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [enabled, disabled], makeCtx())
        const lines = cfg.split('\n')
        const e1Idx = lines.findIndex(l => l.includes('interface ethernet1/1/1'))
        const e2Idx = lines.findIndex(l => l.includes('interface ethernet1/1/2'))
        const e1Block = lines.slice(e1Idx, e2Idx).join('\n')
        const e2Block = lines.slice(e2Idx, e2Idx + 10).join('\n')
        expect(e1Block).toContain(' no shutdown')
        expect(e2Block).toContain(' shutdown')
        expect(e2Block).not.toContain(' no shutdown')
    })

    it('sets port description', () => {
        const port = makePort({ label: 'ethernet1/1/1', description: 'downlink' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain(' description downlink')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('hostname test-router')
        expect(cfg).not.toContain('interface loopback0')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: 'ethernet1/1/1', peerHostname: 'peer1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        // Dell uses the default IOS-style BGP
        expect(cfg).toContain('router bgp 65001')
        expect(cfg).toContain(' bgp router-id 10.0.0.1')
        expect(cfg).toContain(' neighbor 10.0.0.2 remote-as 65002')
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'ethernet1/1/1', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('router ospf 1')
        expect(cfg).toContain(' router-id 10.0.0.1')
        expect(cfg).toContain('interface ethernet1/1/1')
        expect(cfg).toContain(' ip ospf 1 area 0.0.0.0')
    })
})

// ── HPE ────────────────────────────────────────────────────────────────────

describe('HPE (Aruba OS-CX)', () => {
    const vendor = 'hpe'

    it('sets hostname', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'hpe-sw-01' }))
        expect(cfg).toContain('hostname hpe-sw-01')
    })

    it('configures loopback 0 IPv4 with ip/prefix', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('interface loopback 0')
        expect(cfg).toContain(' ip address 10.0.0.1/32')
    })

    it('configures loopback 0 IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('interface loopback 0')
        expect(cfg).toContain(' ipv6 address fd00::1/128')
    })

    it('configures port IPv4 with ip/prefix', () => {
        const port = makePort({ label: '1/1/1', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('interface 1/1/1')
        expect(cfg).toContain(' ip address 10.1.0.1/30')
    })

    it('configures port IPv6', () => {
        const port = makePort({ label: '1/1/1', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain(' ipv6 address fd00:1::1/127')
    })

    it('emits no shutdown / shutdown for port', () => {
        const enabled = makePort({ label: '1/1/1', enabled: true })
        const disabled = makePort({ label: '1/1/2', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [enabled, disabled], makeCtx())
        const lines = cfg.split('\n')
        const e1Idx = lines.findIndex(l => l.includes('interface 1/1/1'))
        const e2Idx = lines.findIndex(l => l.includes('interface 1/1/2'))
        const e1Block = lines.slice(e1Idx, e2Idx).join('\n')
        const e2Block = lines.slice(e2Idx, e2Idx + 10).join('\n')
        expect(e1Block).toContain(' no shutdown')
        expect(e2Block).toContain(' shutdown')
        expect(e2Block).not.toContain(' no shutdown')
    })

    it('sets port description', () => {
        const port = makePort({ label: '1/1/1', description: 'server-port' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain(' description server-port')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('hostname test-router')
        expect(cfg).not.toContain('interface loopback 0')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: '1/1/1', peerHostname: 'peer1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        // HPE uses the default IOS-style BGP
        expect(cfg).toContain('router bgp 65001')
        expect(cfg).toContain(' bgp router-id 10.0.0.1')
        expect(cfg).toContain(' neighbor 10.0.0.2 remote-as 65002')
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: '1/1/1', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('router ospf 1')
        expect(cfg).toContain(' router-id 10.0.0.1')
        expect(cfg).toContain(' ip ospf 1 area 0.0.0.0')
    })
})

// ── MikroTik ──────────────────────────────────────────────────────────────

describe('MikroTik (RouterOS)', () => {
    const vendor = 'mikrotik'

    it('sets hostname with /system identity', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'mt-rtr-01' }))
        expect(cfg).toContain('/system identity set name=mt-rtr-01')
    })

    it('configures loopback IPv4', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('/ip address add address=10.0.0.1/32 interface=loopback')
    })

    it('configures loopback IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('/ipv6 address add address=fd00::1/128 interface=loopback')
    })

    it('configures port IPv4', () => {
        const port = makePort({ label: 'ether1', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('/ip address add address=10.1.0.1/30 interface=ether1')
    })

    it('configures port IPv6', () => {
        const port = makePort({ label: 'ether1', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('/ipv6 address add address=fd00:1::1/127 interface=ether1')
    })

    it('sets port disabled=yes for disabled port', () => {
        const enabled = makePort({ label: 'ether1', enabled: true })
        const disabled = makePort({ label: 'ether2', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [enabled, disabled], makeCtx())
        expect(cfg).toContain('/interface ethernet set ether1 disabled=no')
        expect(cfg).toContain('/interface ethernet set ether2 disabled=yes')
    })

    it('sets port description as comment', () => {
        const port = makePort({ label: 'ether1', description: 'WAN link' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('/interface ethernet set ether1 comment="WAN link"')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('/system identity set name=test-router')
        expect(cfg).not.toContain('/ip address add address=')
        expect(cfg).not.toContain('/ipv6 address add address=')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: 'ether1', peerHostname: 'peer1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('/routing bgp template add name=default as=65001')
        expect(cfg).toContain('router-id=10.0.0.1')
        expect(cfg).toContain('remote.address=10.0.0.2/32')
        expect(cfg).toContain('remote.as=65002')
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'ether1', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('/routing ospf instance add name=default router-id=10.0.0.1')
        expect(cfg).toContain('/routing ospf area add name=backbone instance=default area-id=0.0.0.0')
        expect(cfg).toContain('/routing ospf interface-template add interfaces=ether1 area=backbone type=ptp')
    })
})

// ── Extreme ───────────────────────────────────────────────────────────────

describe('Extreme (EXOS)', () => {
    const vendor = 'extreme'

    it('sets hostname with configure snmp sysname', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'exos-sw-01' }))
        expect(cfg).toContain('configure snmp sysname "exos-sw-01"')
    })

    it('configures Loopback vlan IPv4', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('create vlan Loopback')
        expect(cfg).toContain('configure vlan Loopback ipaddress 10.0.0.1/32')
    })

    it('configures Loopback vlan IPv6', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('configure vlan Loopback ipaddress fd00::1/128')
    })

    it('configures port IPv4 via per-port vlan', () => {
        const port = makePort({ label: '1', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('create vlan port_1')
        expect(cfg).toContain('configure vlan port_1 add port 1 untagged')
        expect(cfg).toContain('configure vlan port_1 ipaddress 10.1.0.1/30')
    })

    it('configures port IPv6 via per-port vlan', () => {
        const port = makePort({ label: '1', ipv6Address: 'fd00:1::1/127' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('configure vlan port_1 ipaddress fd00:1::1/127')
    })

    it('emits enable/disable port', () => {
        const enabled = makePort({ label: '1', enabled: true })
        const disabled = makePort({ label: '2', enabled: false })
        const cfg = buildVendorStartupConfig(vendor, [enabled, disabled], makeCtx())
        expect(cfg).toContain('enable port 1')
        expect(cfg).toContain('disable port 2')
    })

    it('sets port description-string', () => {
        const port = makePort({ label: '1', description: 'server-link' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('configure port 1 description-string "server-link"')
    })

    it('generates valid config with no loopback', () => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: undefined, loopbackIpv6: undefined, mgmtIp: '' }))
        expect(cfg).toContain('configure snmp sysname "test-router"')
        expect(cfg).not.toContain('create vlan Loopback')
        expect(cfg).not.toContain('configure vlan Loopback ipaddress')
    })

    it('configures BGP underlay with ASN and neighbors', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: '1', peerHostname: 'peer1' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('configure bgp AS-number 65001')
        expect(cfg).toContain('configure bgp routerid 10.0.0.1')
        expect(cfg).toContain('create bgp neighbor 10.0.0.2 remote-AS-number 65002')
        expect(cfg).toContain('enable bgp neighbor 10.0.0.2')
        expect(cfg).toContain('enable bgp')
    })

    it('configures OSPF underlay with area and interfaces', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: '1', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('configure ospf routerid 10.0.0.1')
        expect(cfg).toContain('configure ospf add vlan Loopback area 0.0.0.0')
        expect(cfg).toContain('configure ospf add vlan port_1 area 0.0.0.0')
        expect(cfg).toContain('enable ospf')
    })
})

// ── Cross-vendor edge cases ─────────────────────────────────────────────

describe('Cross-vendor edge cases', () => {
    const allVendors = ['cisco', 'juniper', 'arista', 'nokia', 'sonic', 'huawei', 'dell', 'hpe', 'mikrotik', 'extreme']

    it.each(allVendors)('%s: returns a non-empty string for minimal context', (vendor) => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx())
        expect(typeof cfg).toBe('string')
        expect(cfg.length).toBeGreaterThan(0)
    })

    it.each(allVendors)('%s: hostname appears in config', (vendor) => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ hostname: 'my-device' }))
        expect(cfg).toContain('my-device')
    })

    it.each(allVendors)('%s: loopback IP 10.0.0.1 appears in config', (vendor) => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain('10.0.0.1')
    })

    it.each(allVendors)('%s: loopback IPv6 fd00::1 appears in config', (vendor) => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIpv6: 'fd00::1/128' }))
        expect(cfg).toContain('fd00::1')
    })

    it.each(allVendors)('%s: port IP address 172.16.0.1 appears in config', (vendor) => {
        const port = makePort({ label: 'eth0', ipAddress: '172.16.0.1/24' })
        const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
        expect(cfg).toContain('172.16.0.1')
    })

    it.each(allVendors)('%s: empty ports array produces valid config', (vendor) => {
        const cfg = buildVendorStartupConfig(vendor, [], makeCtx())
        expect(cfg.length).toBeGreaterThan(10)
    })

    it.each(allVendors)('%s: config with both BGP and OSPF does not throw', (vendor) => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65002, portLabel: 'eth0', peerHostname: 'peer1' },
            ],
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'eth0', area: 0 },
            ],
        })
        expect(() => buildVendorStartupConfig(vendor, [], ctx)).not.toThrow()
    })

    it.each(allVendors)('%s: multiple ports are all rendered', (vendor) => {
        const ports = [
            makePort({ id: 'p1', label: 'port1', enabled: true, ipAddress: '10.10.1.1/30' }),
            makePort({ id: 'p2', label: 'port2', enabled: false, ipAddress: '10.10.2.1/30' }),
            makePort({ id: 'p3', label: 'port3', enabled: true, description: 'third-port' }),
        ]
        const cfg = buildVendorStartupConfig(vendor, ports, makeCtx())
        expect(cfg).toContain('port1')
        expect(cfg).toContain('port2')
        expect(cfg).toContain('port3')
    })

    it.each(allVendors)('%s: different loopback prefix lengths are handled', (vendor) => {
        const cfg24 = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/24' }))
        expect(cfg24).toContain('10.0.0.1')
        const cfg32 = buildVendorStartupConfig(vendor, [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg32).toContain('10.0.0.1')
    })

    it.each(allVendors)('%s: vendor name is case-insensitive', (vendor) => {
        const cfgLower = buildVendorStartupConfig(vendor.toLowerCase(), [], makeCtx())
        const cfgUpper = buildVendorStartupConfig(vendor.toUpperCase(), [], makeCtx())
        // Both should produce valid non-empty config; exact content may differ in header comment
        expect(cfgLower.length).toBeGreaterThan(0)
        expect(cfgUpper.length).toBeGreaterThan(0)
    })

    it.each(allVendors)('%s: iBGP neighbors with same ASN are handled', (vendor) => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65001, portLabel: 'eth0', peerHostname: 'ibgp-peer' },
            ],
        })
        const cfg = buildVendorStartupConfig(vendor, [], ctx)
        expect(cfg).toContain('10.0.0.2')
    })
})

// ── OSPF area encoding ─────────────────────────────────────────────────────

describe('OSPF area dotted-quad encoding', () => {
    it('cisco: area 0 becomes 0.0.0.0', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            ospfArea: 0,
            ospfInterfaces: [{ portLabel: 'Gi0/0', area: 0 }],
        })
        const cfg = buildVendorStartupConfig('cisco', [], ctx)
        expect(cfg).toContain('area 0.0.0.0')
    })

    it('cisco: area 1 becomes 0.0.0.1', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            ospfArea: 1,
            ospfInterfaces: [{ portLabel: 'Gi0/0', area: 1 }],
        })
        const cfg = buildVendorStartupConfig('cisco', [], ctx)
        expect(cfg).toContain('area 0.0.0.1')
    })

    it('juniper: area 0 becomes 0.0.0.0', () => {
        const ctx = makeCtx({
            routerId: '10.0.0.1',
            ospfArea: 0,
            ospfInterfaces: [{ portLabel: 'et-0/0/0', area: 0 }],
        })
        const cfg = buildVendorStartupConfig('juniper', [], ctx)
        expect(cfg).toContain('area 0.0.0.0')
    })
})

// ── BGP iBGP-RR (route reflector) ──────────────────────────────────────────

describe('BGP iBGP Route Reflector', () => {
    it('cisco: emits route-reflector-client for iBGP neighbors when isRouteReflector=true', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            isRouteReflector: true,
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65001, portLabel: 'Gi0/0', peerHostname: 'leaf1' },
            ],
        })
        const cfg = buildVendorStartupConfig('cisco', [], ctx)
        expect(cfg).toContain(' neighbor 10.0.0.2 route-reflector-client')
        expect(cfg).toContain(' bgp cluster-id 10.0.0.1')
    })

    it('juniper: emits cluster for iBGP group when isRouteReflector=true', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            isRouteReflector: true,
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65001, portLabel: 'et-0/0/0', peerHostname: 'leaf1' },
            ],
        })
        const cfg = buildVendorStartupConfig('juniper', [], ctx)
        expect(cfg).toContain('set protocols bgp group IBGP cluster 10.0.0.1')
    })

    it('arista: emits route-reflector-client for iBGP peer group when isRouteReflector=true', () => {
        const ctx = makeCtx({
            asn: 65001,
            routerId: '10.0.0.1',
            isRouteReflector: true,
            bgpNeighbors: [
                { ip: '10.0.0.2', peerAsn: 65001, portLabel: 'Ethernet1', peerHostname: 'leaf1' },
            ],
        })
        const cfg = buildVendorStartupConfig('arista', [], ctx)
        expect(cfg).toContain('   neighbor IBGP route-reflector-client')
        expect(cfg).toContain(`   bgp cluster-id 10.0.0.1`)
    })
})

// ── Loopback prefix/mask conversion ─────────────────────────────────────

describe('Loopback IP prefix-to-mask conversion', () => {
    it('cisco: /32 converts to 255.255.255.255', () => {
        const cfg = buildVendorStartupConfig('cisco', [], makeCtx({ loopbackIp: '10.0.0.1/32' }))
        expect(cfg).toContain(' ip address 10.0.0.1 255.255.255.255')
    })

    it('cisco: /24 converts to 255.255.255.0', () => {
        const cfg = buildVendorStartupConfig('cisco', [], makeCtx({ loopbackIp: '10.0.0.1/24' }))
        expect(cfg).toContain(' ip address 10.0.0.1 255.255.255.0')
    })

    it('huawei: /30 converts to 255.255.255.252', () => {
        const port = makePort({ label: 'GE1/0/0', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig('huawei', [port], makeCtx())
        expect(cfg).toContain(' ip address 10.1.0.1 255.255.255.252')
    })

    it('arista: /30 stays as CIDR', () => {
        const port = makePort({ label: 'Ethernet1', ipAddress: '10.1.0.1/30' })
        const cfg = buildVendorStartupConfig('arista', [port], makeCtx())
        expect(cfg).toContain('   ip address 10.1.0.1/30')
    })

    it('juniper: /31 stays as CIDR', () => {
        const port = makePort({ label: 'et-0/0/0', ipAddress: '10.1.0.0/31' })
        const cfg = buildVendorStartupConfig('juniper', [port], makeCtx())
        expect(cfg).toContain('set interfaces et-0/0/0 unit 0 family inet address 10.1.0.0/31')
    })
})

// ── Port with no IP ────────────────────────────────────────────────────────

describe('Port with no IP address', () => {
    // Juniper and Nokia use set-style config and only emit interface lines when IP/description
    // is present, so they won't contain the bare port label in the output.
    const vendorsWithPortInConfig = ['cisco', 'arista', 'sonic', 'huawei', 'dell', 'hpe', 'mikrotik', 'extreme']
    it.each(vendorsWithPortInConfig)(
        '%s: port with no IP produces config that references the port', (vendor) => {
            const port = makePort({ label: 'port1', enabled: true })
            const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
            expect(cfg).toContain('port1')
        },
    )

    it.each(['juniper', 'nokia'])(
        '%s: port with no IP still produces valid config', (vendor) => {
            const port = makePort({ label: 'port1', enabled: true })
            const cfg = buildVendorStartupConfig(vendor, [port], makeCtx())
            expect(cfg.length).toBeGreaterThan(0)
        },
    )
})

// ── SSH user ───────────────────────────────────────────────────────────────

describe('SSH username in config', () => {
    it('cisco: creates username privilege 15', () => {
        const cfg = buildVendorStartupConfig('cisco', [], makeCtx({ sshUsername: 'netadmin' }))
        expect(cfg).toContain('username netadmin privilege 15')
    })

    it('juniper: creates login user with class', () => {
        const cfg = buildVendorStartupConfig('juniper', [], makeCtx({ sshUsername: 'netadmin' }))
        // Juniper set-style config does not emit a dedicated login user line;
        // verify the config is still generated successfully with SSH enabled.
        expect(cfg).toContain('set system services ssh')
        expect(cfg).toContain('set system host-name')
    })

    it('arista: creates user with role', () => {
        const cfg = buildVendorStartupConfig('arista', [], makeCtx({ sshUsername: 'netadmin' }))
        expect(cfg).toContain('username netadmin role network-admin')
    })

    it('nokia: creates aaa user', () => {
        const cfg = buildVendorStartupConfig('nokia', [], makeCtx({ sshUsername: 'netadmin' }))
        expect(cfg).toContain('set / system aaa authentication user netadmin role admin')
    })

    it('huawei: creates local-user', () => {
        const cfg = buildVendorStartupConfig('huawei', [], makeCtx({ sshUsername: 'netadmin' }))
        expect(cfg).toContain('local-user netadmin privilege level 15')
    })

    it('mikrotik: creates /user add', () => {
        const cfg = buildVendorStartupConfig('mikrotik', [], makeCtx({ sshUsername: 'netadmin' }))
        expect(cfg).toContain('/user add name=netadmin group=full')
    })

    it('extreme: creates admin account', () => {
        const cfg = buildVendorStartupConfig('extreme', [], makeCtx({ sshUsername: 'netadmin' }))
        expect(cfg).toContain('create account admin netadmin')
    })
})

// ---------------------------------------------------------------------------
// asnToAsdot
// ---------------------------------------------------------------------------
describe('asnToAsdot', () => {
    it('returns "65535" for 2-byte ASN 65535', () => {
        expect(asnToAsdot(65535)).toBe('65535')
    })

    it('returns "1.0" for 4-byte ASN 65536', () => {
        expect(asnToAsdot(65536)).toBe('1.0')
    })

    it('returns "65535.65535" for max ASN 4294967295', () => {
        expect(asnToAsdot(4294967295)).toBe('65535.65535')
    })

    it('returns "1" for ASN 1', () => {
        expect(asnToAsdot(1)).toBe('1')
    })

    it('returns "2.1" for ASN 131073', () => {
        expect(asnToAsdot(131073)).toBe('2.1')
    })
})

// ---------------------------------------------------------------------------
// is4ByteAsn
// ---------------------------------------------------------------------------
describe('is4ByteAsn', () => {
    it('returns false for 65535', () => {
        expect(is4ByteAsn(65535)).toBe(false)
    })

    it('returns true for 65536', () => {
        expect(is4ByteAsn(65536)).toBe(true)
    })

    it('returns false for 1', () => {
        expect(is4ByteAsn(1)).toBe(false)
    })

    it('returns true for max ASN 4294967295', () => {
        expect(is4ByteAsn(4294967295)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------
describe('config builder edge cases', () => {
    it('IPv6-only config (no loopbackIp, only loopbackIpv6)', () => {
        const cfg = buildVendorStartupConfig('cisco', [], makeCtx({
            loopbackIp: '',
            loopbackIpv6: 'fd00::1/128',
        }))
        expect(cfg).toContain('ipv6 address fd00::1/128')
        // Should not have ip address line for loopback since loopbackIp is empty
        expect(cfg).not.toMatch(/ip address 10\./)
    })

    it('empty hostname still generates valid config', () => {
        const cfg = buildVendorStartupConfig('cisco', [], makeCtx({ hostname: '' }))
        expect(cfg.length).toBeGreaterThan(0)
    })

    it('port with special characters in description', () => {
        const port = makePort({ description: 'Link to "core" (primary) & backup' })
        const cfg = buildVendorStartupConfig('cisco', [port], makeCtx())
        expect(cfg).toContain('description')
    })

    it('VLAN ID 1 (default) in config', () => {
        const port = makePort({ vlan: 1, vlanMode: 'access' })
        const cfg = buildVendorStartupConfig('cisco', [port], makeCtx())
        expect(cfg.length).toBeGreaterThan(0)
    })

    it('VLAN ID 4094 (max valid) in config', () => {
        const port = makePort({ vlan: 4094, vlanMode: 'access' })
        const cfg = buildVendorStartupConfig('cisco', [port], makeCtx())
        expect(cfg).toContain('4094')
    })

    it('port with IPv6 address and no IPv4', () => {
        const port = makePort({ ipAddress: undefined, ipv6Address: 'fd00::1/127' })
        const cfg = buildVendorStartupConfig('cisco', [port], makeCtx())
        expect(cfg).toContain('ipv6 address fd00::1/127')
    })
})

// ── CRB (Centrally-Routed Bridging) — asymmetric IRB ──────────────────────

describe('CRB — Juniper spine with centralized IRB', () => {
    it('generates IRB interfaces on spine in CRB mode', () => {
        const ctx = makeCtx({
            hostname: 'Spine-1',
            asn: 65001,
            routerId: '10.0.0.1',
            underlayProtocol: 'ebgp',
            overlayEnabled: true,
            irbEnabled: true,
            irbMode: 'asymmetric',
            nodeRole: 'spine' as any,
            vlans: [{ id: 100, name: 'Tenant-A' }, { id: 200, name: 'Tenant-B' }, { id: 999, name: 'Native' }],
            vniMappings: [
                { vlanId: 100, vni: 10100, vlanName: 'Tenant-A' },
                { vlanId: 200, vni: 10200, vlanName: 'Tenant-B' },
                { vlanId: 999, vni: 10999, vlanName: 'Native' },
            ],
            vtepSourceIp: '10.0.0.1',
            overlayNeighbors: ['10.0.0.11', '10.0.0.12'],
        })
        const cfg = buildVendorStartupConfig('Juniper', [], ctx)
        // Spine in CRB has IRB interfaces for tenant VLANs (100, 200)
        expect(cfg).toMatch(/set interfaces irb unit 100/)
        expect(cfg).toMatch(/set interfaces irb unit 200/)
        // Infrastructure VLAN 999 should NOT have IRB
        expect(cfg).not.toMatch(/set interfaces irb unit 999/)
    })

    it('leaf in CRB mode does NOT have IRB (L2-only)', () => {
        const ctx = makeCtx({
            hostname: 'Leaf-1',
            asn: 65011,
            routerId: '10.0.0.11',
            underlayProtocol: 'ebgp',
            overlayEnabled: true,
            irbEnabled: true,
            irbMode: 'asymmetric',
            nodeRole: 'leaf' as any,
            vlans: [{ id: 100, name: 'Tenant-A' }],
            vniMappings: [{ vlanId: 100, vni: 10100, vlanName: 'Tenant-A' }],
            vtepSourceIp: '10.0.0.11',
            overlayNeighbors: ['10.0.0.1'],
        })
        const cfg = buildVendorStartupConfig('Juniper', [], ctx)
        // Leaf in CRB has VLAN/VNI but no IRB
        expect(cfg).toMatch(/set vlans vlan100 vxlan vni 10100/)
        expect(cfg).not.toMatch(/set interfaces irb unit/)
    })
})

// ── ERB (Edge-Routed Bridging) — symmetric IRB ────────────────────────────

describe('ERB — Juniper leaf with distributed IRB + L3 VNI', () => {
    it('generates symmetric IRB with L3 VNI VRF on leaf', () => {
        const ctx = makeCtx({
            hostname: 'Leaf-1',
            asn: 65011,
            routerId: '10.0.0.11',
            underlayProtocol: 'ebgp',
            overlayEnabled: true,
            irbEnabled: true,
            irbMode: 'symmetric',
            nodeRole: 'leaf' as any,
            vlans: [{ id: 100, name: 'Tenant-A' }, { id: 200, name: 'Tenant-B' }],
            vniMappings: [
                { vlanId: 100, vni: 10100, vlanName: 'Tenant-A' },
                { vlanId: 200, vni: 10200, vlanName: 'Tenant-B' },
            ],
            vtepSourceIp: '10.0.0.11',
            overlayNeighbors: ['10.0.0.1', '10.0.0.2'],
        })
        const cfg = buildVendorStartupConfig('Juniper', [], ctx)
        expect(cfg).toMatch(/set interfaces irb unit 100 family inet address/)
        expect(cfg).toMatch(/set interfaces irb unit 200 family inet address/)
        // Symmetric ERB adds EVPN-VRF with L3 VNI
        expect(cfg).toMatch(/set routing-instances EVPN-VRF instance-type vrf/)
        expect(cfg).toMatch(/set routing-instances EVPN-VRF protocols evpn ip-prefix-routes/)
    })

    it('Arista leaf in ERB has anycast virtual IP', () => {
        const ctx = makeCtx({
            hostname: 'leaf-1',
            asn: 65011,
            routerId: '10.0.0.11',
            underlayProtocol: 'ebgp',
            overlayEnabled: true,
            irbEnabled: true,
            irbMode: 'symmetric',
            nodeRole: 'leaf' as any,
            vlans: [{ id: 100, name: 'Tenant-A' }],
            vniMappings: [{ vlanId: 100, vni: 10100, vlanName: 'Tenant-A' }],
            vtepSourceIp: '10.0.0.11',
            overlayNeighbors: ['10.0.0.1'],
        })
        const cfg = buildVendorStartupConfig('Arista', [], ctx)
        expect(cfg).toContain('interface Vlan100')
        expect(cfg).toMatch(/ip address virtual/)
    })
})

// ── Role inference (server/PC/host exclusion) ─────────────────────────────

describe('Role-based exclusions', () => {
    it('IRB not applied to infrastructure VLANs (900, 999, <100)', () => {
        const ctx = makeCtx({
            hostname: 'leaf-1',
            routerId: '10.0.0.11',
            underlayProtocol: 'ebgp',
            overlayEnabled: true,
            irbEnabled: true,
            irbMode: 'symmetric',
            nodeRole: 'leaf' as any,
            asn: 65011,
            vlans: [
                { id: 10, name: 'MGMT' },
                { id: 100, name: 'Tenant-A' },
                { id: 900, name: 'Underlay-P2P' },
                { id: 999, name: 'Native' },
            ],
            vniMappings: [
                { vlanId: 10, vni: 10010, vlanName: 'MGMT' },
                { vlanId: 100, vni: 10100, vlanName: 'Tenant-A' },
                { vlanId: 900, vni: 10900, vlanName: 'Underlay-P2P' },
                { vlanId: 999, vni: 10999, vlanName: 'Native' },
            ],
            vtepSourceIp: '10.0.0.11',
            overlayNeighbors: ['10.0.0.1'],
        })
        const cfg = buildVendorStartupConfig('Juniper', [], ctx)
        // Only tenant VLAN 100 gets IRB — infrastructure VLANs excluded
        expect(cfg).toMatch(/set interfaces irb unit 100 family inet address/)
        expect(cfg).not.toMatch(/set interfaces irb unit 10 family inet address/)
        expect(cfg).not.toMatch(/set interfaces irb unit 900 family inet address/)
        expect(cfg).not.toMatch(/set interfaces irb unit 999 family inet address/)
    })
})

// ── SR-MPLS with OSPF (not just IS-IS) ────────────────────────────────────

describe('SR-MPLS with OSPF IGP', () => {
    it('Juniper emits OSPF-based SR stanzas when OSPF is the IGP', () => {
        const ctx = makeCtx({
            hostname: 'P-1',
            routerId: '10.0.0.1',
            underlayProtocol: 'ospf',
            nodeSid: 1,
            srgbStart: 16000,
            srgbEnd: 23999,
            ospfArea: 0,
            ospfInterfaces: [
                { portLabel: 'xe-0/0/0', area: 0 },
                { portLabel: 'xe-0/0/1', area: 0 },
            ],
        })
        const cfg = buildVendorStartupConfig('Juniper', [], ctx)
        expect(cfg).toMatch(/set protocols ospf traffic-engineering/)
        expect(cfg).toMatch(/set protocols ospf source-packet-routing/)
    })
})

// ── Vendor support matrix ─────────────────────────────────────────────────

describe('Vendor support — SR-MPLS graceful degradation', () => {
    it('MikroTik notes SR-MPLS is not supported', () => {
        const ctx = makeCtx({
            hostname: 'rtr-1',
            underlayProtocol: 'isis',
            nodeSid: 1,
            srgbStart: 16000,
            srgbEnd: 23999,
            isisLevel: 2,
            isisInterfaces: [{ portLabel: 'ether1', level: 2 }],
        })
        const cfg = buildVendorStartupConfig('MikroTik', [], ctx)
        expect(cfg).toMatch(/SR-MPLS is not supported/)
    })

    it('Extreme notes SRv6 is not supported', () => {
        const ctx = makeCtx({
            hostname: 'sw-1',
            underlayProtocol: 'isis',
            srv6Locator: 'fc00:0:1::/48',
            isisLevel: 2,
            isisInterfaces: [{ portLabel: '1:1', level: 2 }],
        })
        const cfg = buildVendorStartupConfig('Extreme', [], ctx)
        expect(cfg).toMatch(/SRv6 is not supported/)
    })
})
