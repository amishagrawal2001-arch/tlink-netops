import {
    parseLldpNeighbors,
    parseBgpSummary,
} from '../renderer/src/services/vendor-output-parser'

// =============================================================================
// parseLldpNeighbors
// =============================================================================

describe('parseLldpNeighbors', () => {

    // ── Cisco ────────────────────────────────────────────────────────────────

    describe('Cisco — show lldp neighbors detail', () => {
        const output =
`Local Intf: Gi0/0/0
Chassis id: 0023.04ee.be01
Port Description: GigabitEthernet0/0/1
System Name: switch2.lab.local
System Description: Cisco IOS Software, Version 15.4(3)M3
Time remaining: 108 seconds
System Capabilities: B,R
Management Addresses:
    IP: 10.0.0.2
--------------------------------------------------------------
Local Intf: Gi0/0/1
Chassis id: 0023.04ee.be02
Port Description: GigabitEthernet0/0/2
System Name: switch3.lab.local
System Description: Cisco NX-OS
Time remaining: 95 seconds
System Capabilities: B,R
Management Addresses:
    IP: 10.0.0.3`
        it('parses two LLDP neighbors', () => {
            const result = parseLldpNeighbors('cisco', output)
            expect(result).toHaveLength(2)
        })

        it('extracts Local Intf correctly', () => {
            const result = parseLldpNeighbors('cisco', output)
            expect(result[0].localPort).toBe('Gi0/0/0')
            expect(result[1].localPort).toBe('Gi0/0/1')
        })

        it('extracts System Name as neighborHostname', () => {
            const result = parseLldpNeighbors('cisco', output)
            expect(result[0].neighborHostname).toBe('switch2.lab.local')
            expect(result[1].neighborHostname).toBe('switch3.lab.local')
        })

        it('extracts Port Description as neighborPort', () => {
            const result = parseLldpNeighbors('cisco', output)
            expect(result[0].neighborPort).toBe('GigabitEthernet0/0/1')
            expect(result[1].neighborPort).toBe('GigabitEthernet0/0/2')
        })

        it('extracts Management Address', () => {
            const result = parseLldpNeighbors('cisco', output)
            expect(result[0].neighborMgmtIp).toBe('10.0.0.2')
            expect(result[1].neighborMgmtIp).toBe('10.0.0.3')
        })
    })

    // ── Juniper ──────────────────────────────────────────────────────────────

    describe('Juniper — show lldp neighbors (tabular)', () => {
        const output = `
Local Interface    Parent Interface    Chassis Id          Port info       System Name
ge-0/0/0           -                   aa:bb:cc:dd:ee:01   eth0            spine1
ge-0/0/1           -                   aa:bb:cc:dd:ee:02   Ethernet1/1     spine2
`
        it('parses two neighbors from tabular output', () => {
            const result = parseLldpNeighbors('juniper', output)
            expect(result).toHaveLength(2)
        })

        it('extracts local interface', () => {
            const result = parseLldpNeighbors('juniper', output)
            expect(result[0].localPort).toBe('ge-0/0/0')
            expect(result[1].localPort).toBe('ge-0/0/1')
        })

        it('extracts neighbor hostname', () => {
            const result = parseLldpNeighbors('juniper', output)
            expect(result[0].neighborHostname).toBe('spine1')
            expect(result[1].neighborHostname).toBe('spine2')
        })

        it('extracts neighbor port info', () => {
            const result = parseLldpNeighbors('juniper', output)
            expect(result[0].neighborPort).toBe('eth0')
            expect(result[1].neighborPort).toBe('Ethernet1/1')
        })
    })

    // ── Arista JSON ──────────────────────────────────────────────────────────

    describe('Arista — JSON format', () => {
        const output = JSON.stringify({
            lldpNeighbors: {
                'Ethernet1': [
                    {
                        neighborDevice: 'leaf1.dc1',
                        neighborPort: 'Ethernet49',
                        managementAddress: '172.16.0.1',
                        systemDescription: 'Arista Networks EOS 4.28.0F',
                    },
                ],
                'Ethernet2': [
                    {
                        neighborDevice: 'leaf2.dc1',
                        neighborPort: 'Ethernet49',
                        managementAddress: '172.16.0.2',
                        systemDescription: 'Arista Networks EOS 4.28.0F',
                    },
                ],
            },
        })

        it('parses JSON with lldpNeighbors key', () => {
            const result = parseLldpNeighbors('arista', output)
            expect(result).toHaveLength(2)
        })

        it('maps local port from JSON key', () => {
            const result = parseLldpNeighbors('arista', output)
            expect(result[0].localPort).toBe('Ethernet1')
            expect(result[1].localPort).toBe('Ethernet2')
        })

        it('extracts neighbor device and port', () => {
            const result = parseLldpNeighbors('arista', output)
            expect(result[0].neighborHostname).toBe('leaf1.dc1')
            expect(result[0].neighborPort).toBe('Ethernet49')
        })

        it('extracts management address', () => {
            const result = parseLldpNeighbors('arista', output)
            expect(result[0].neighborMgmtIp).toBe('172.16.0.1')
            expect(result[1].neighborMgmtIp).toBe('172.16.0.2')
        })

        it('extracts system description', () => {
            const result = parseLldpNeighbors('arista', output)
            expect(result[0].neighborSystemDesc).toBe('Arista Networks EOS 4.28.0F')
        })

        it('handles result wrapper format', () => {
            const wrapped = JSON.stringify({
                result: [{
                    lldpNeighbors: {
                        'Ethernet3': [{
                            neighborDevice: 'spine1',
                            neighborPort: 'Ethernet1',
                        }],
                    },
                }],
            })
            const result = parseLldpNeighbors('arista', wrapped)
            expect(result).toHaveLength(1)
            expect(result[0].neighborHostname).toBe('spine1')
        })
    })

    // ── SONiC ────────────────────────────────────────────────────────────────

    describe('SONiC — show lldp table (tabular)', () => {
        const output = `
Interface       Neighbor       Neighbor-Port    Neighbor-Interface
-----------     ----------     -------------    ------------------
Ethernet0       spine1         eth0             Ethernet0
Ethernet4       spine2         eth1             Ethernet4
PortChannel1    border1        bond0            PortChannel1
`
        it('parses three SONiC LLDP neighbors', () => {
            const result = parseLldpNeighbors('sonic', output)
            expect(result).toHaveLength(3)
        })

        it('extracts Ethernet interfaces', () => {
            const result = parseLldpNeighbors('sonic', output)
            expect(result[0].localPort).toBe('Ethernet0')
            expect(result[1].localPort).toBe('Ethernet4')
        })

        it('extracts PortChannel interfaces', () => {
            const result = parseLldpNeighbors('sonic', output)
            expect(result[2].localPort).toBe('PortChannel1')
        })

        it('extracts neighbor hostname and port', () => {
            const result = parseLldpNeighbors('sonic', output)
            expect(result[0].neighborHostname).toBe('spine1')
            expect(result[0].neighborPort).toBe('Ethernet0')
        })
    })

    // ── Empty output ─────────────────────────────────────────────────────────

    describe('empty output', () => {
        it('returns empty array for empty string', () => {
            expect(parseLldpNeighbors('cisco', '')).toEqual([])
        })

        it('returns empty array for whitespace-only', () => {
            expect(parseLldpNeighbors('juniper', '   \n  \n  ')).toEqual([])
        })

        it('returns empty array for undefined vendor with empty output', () => {
            expect(parseLldpNeighbors('', '')).toEqual([])
        })
    })

    // ── Unknown vendor → generic parser ──────────────────────────────────────

    describe('unknown vendor — generic fallback', () => {
        it('falls back to block-based parsing for detail output', () => {
            const output = `
Local Intf: port1
System Name: router-a
Port Description: ge-0/0/0
10.1.1.1

Local Intf: port2
System Name: router-b
Port Description: ge-0/0/1
10.1.1.2
`
            const result = parseLldpNeighbors('unknownvendor', output)
            expect(result).toHaveLength(2)
            expect(result[0].localPort).toBe('port1')
            expect(result[0].neighborHostname).toBe('router-a')
            expect(result[0].neighborPort).toBe('ge-0/0/0')
            expect(result[0].neighborMgmtIp).toBe('10.1.1.1')
        })

        it('falls back to tabular parsing when block parsing finds nothing', () => {
            const output = `
port1    router-a    ge-0/0/0
port2    router-b    ge-0/0/1
`
            const result = parseLldpNeighbors('unknownvendor', output)
            expect(result).toHaveLength(2)
            expect(result[0].localPort).toBe('port1')
            expect(result[0].neighborHostname).toBe('router-a')
        })
    })
})

// =============================================================================
// parseBgpSummary
// =============================================================================

describe('parseBgpSummary', () => {

    // ── Cisco ────────────────────────────────────────────────────────────────

    describe('Cisco — show bgp summary', () => {
        const output = `
BGP router identifier 10.255.0.1, local AS number 65000
BGP table version is 42, main routing table version 42

Neighbor        V    AS   MsgRcvd  MsgSent  TblVer  InQ  OutQ  Up/Down   State/PfxRcd
10.0.0.1        4    65001   1842     1839       42    0     0  02:15:30  12
10.0.0.2        4    65002   9021     9018       42    0     0  5d12h     8
10.0.0.3        4    65003    512      510        0    0     0  00:01:05  Active
10.0.0.4        4    65004      0        0        0    0     0  never     Idle
`
        it('parses four BGP neighbors', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result).toHaveLength(4)
        })

        it('extracts neighbor IPs', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result[0].neighborIp).toBe('10.0.0.1')
            expect(result[1].neighborIp).toBe('10.0.0.2')
            expect(result[2].neighborIp).toBe('10.0.0.3')
            expect(result[3].neighborIp).toBe('10.0.0.4')
        })

        it('extracts ASN numbers', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result[0].asn).toBe(65001)
            expect(result[1].asn).toBe(65002)
            expect(result[2].asn).toBe(65003)
            expect(result[3].asn).toBe(65004)
        })

        it('treats numeric State/PfxRcd as Established with prefix count', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result[0].state).toBe('Established')
            expect(result[0].prefixCount).toBe(12)
            expect(result[1].state).toBe('Established')
            expect(result[1].prefixCount).toBe(8)
        })

        it('treats non-numeric State/PfxRcd as state name', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result[2].state).toBe('Active')
            expect(result[2].prefixCount).toBe(0)
        })

        it('parses Idle state correctly', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result[3].state).toBe('Idle')
            expect(result[3].prefixCount).toBe(0)
        })
    })

    // ── Juniper ──────────────────────────────────────────────────────────────

    describe('Juniper — show bgp summary', () => {
        const output = `
Groups: 2 Peers: 3 Down peers: 1
Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped...
10.0.0.1              65001       8421       8419       0       2     3:45:10 5/10/8/0
10.0.0.2              65002       3100       3098       0       0     1d2h3m  Establ
10.0.0.3              65003          0          0       0       1        12s  Active
`
        it('parses three Juniper BGP neighbors', () => {
            const result = parseBgpSummary('juniper', output)
            expect(result).toHaveLength(3)
        })

        it('extracts active/received/accepted prefix counts', () => {
            const result = parseBgpSummary('juniper', output)
            expect(result[0].state).toBe('Established')
            expect(result[0].prefixCount).toBe(5)
        })

        it('handles "Establ" truncation as Established', () => {
            const result = parseBgpSummary('juniper', output)
            expect(result[1].state).toBe('Established')
            expect(result[1].prefixCount).toBe(0)
        })

        it('parses Active state', () => {
            const result = parseBgpSummary('juniper', output)
            expect(result[2].state).toBe('Active')
            expect(result[2].prefixCount).toBe(0)
        })

        it('extracts ASN correctly', () => {
            const result = parseBgpSummary('juniper', output)
            expect(result[0].asn).toBe(65001)
            expect(result[1].asn).toBe(65002)
            expect(result[2].asn).toBe(65003)
        })
    })

    // ── Arista JSON ──────────────────────────────────────────────────────────

    describe('Arista — JSON with vrfs.default.peers', () => {
        const output = JSON.stringify({
            vrfs: {
                default: {
                    peers: {
                        '10.0.0.1': {
                            asn: 65001,
                            peerState: 'Established',
                            prefixAccepted: 15,
                        },
                        '10.0.0.2': {
                            asn: 65002,
                            peerState: 'Active',
                            prefixAccepted: 0,
                        },
                        '10.0.0.3': {
                            peerAsn: 65003,
                            state: 'Idle',
                            prefixesReceived: 0,
                        },
                    },
                },
            },
        })

        it('parses three Arista BGP peers', () => {
            const result = parseBgpSummary('arista', output)
            expect(result).toHaveLength(3)
        })

        it('extracts neighbor IPs from JSON keys', () => {
            const result = parseBgpSummary('arista', output)
            const ips = result.map(r => r.neighborIp).sort()
            expect(ips).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3'])
        })

        it('uses asn or peerAsn field', () => {
            const result = parseBgpSummary('arista', output)
            const byIp = Object.fromEntries(result.map(r => [r.neighborIp, r]))
            expect(byIp['10.0.0.1'].asn).toBe(65001)
            expect(byIp['10.0.0.3'].asn).toBe(65003)
        })

        it('uses peerState or state field', () => {
            const result = parseBgpSummary('arista', output)
            const byIp = Object.fromEntries(result.map(r => [r.neighborIp, r]))
            expect(byIp['10.0.0.1'].state).toBe('Established')
            expect(byIp['10.0.0.2'].state).toBe('Active')
            expect(byIp['10.0.0.3'].state).toBe('Idle')
        })

        it('extracts prefix counts from various field names', () => {
            const result = parseBgpSummary('arista', output)
            const byIp = Object.fromEntries(result.map(r => [r.neighborIp, r]))
            expect(byIp['10.0.0.1'].prefixCount).toBe(15)
            expect(byIp['10.0.0.2'].prefixCount).toBe(0)
        })

        it('handles result wrapper format', () => {
            const wrapped = JSON.stringify({
                result: [{
                    vrfs: {
                        default: {
                            peers: {
                                '192.168.1.1': {
                                    asn: 64512,
                                    peerState: 'Established',
                                    prefixAccepted: 3,
                                },
                            },
                        },
                    },
                }],
            })
            const result = parseBgpSummary('arista', wrapped)
            expect(result).toHaveLength(1)
            expect(result[0].neighborIp).toBe('192.168.1.1')
            expect(result[0].asn).toBe(64512)
        })
    })

    // ── SONiC / FRR ──────────────────────────────────────────────────────────

    describe('SONiC/FRR — text table (uses Cisco parser)', () => {
        const output = `
BGP router identifier 10.255.0.10, local AS number 65100
BGP table version is 18

Neighbor        V    AS   MsgRcvd  MsgSent  TblVer  InQ  OutQ  Up/Down   State/PfxRcd
10.10.0.1       4    65201   4210     4208       18    0     0  6d03h     7
10.10.0.2       4    65202    300      298       18    0     0  00:05:42  Connect
`
        it('parses SONiC BGP neighbors using Cisco-style parser', () => {
            const result = parseBgpSummary('sonic', output)
            expect(result).toHaveLength(2)
        })

        it('extracts established peer with prefix count', () => {
            const result = parseBgpSummary('sonic', output)
            expect(result[0].neighborIp).toBe('10.10.0.1')
            expect(result[0].asn).toBe(65201)
            expect(result[0].state).toBe('Established')
            expect(result[0].prefixCount).toBe(7)
        })

        it('extracts Connect state peer', () => {
            const result = parseBgpSummary('sonic', output)
            expect(result[1].neighborIp).toBe('10.10.0.2')
            expect(result[1].asn).toBe(65202)
            expect(result[1].state).toBe('Connect')
            expect(result[1].prefixCount).toBe(0)
        })
    })

    // ── Idle / Active / Connect states ───────────────────────────────────────

    describe('state parsing — Idle, Active, Connect', () => {
        const output = `
Neighbor        V    AS   MsgRcvd  MsgSent  TblVer  InQ  OutQ  Up/Down   State/PfxRcd
10.1.1.1        4    65501      0        0        0    0     0  never     Idle
10.1.1.2        4    65502      0        0        0    0     0  00:00:32  Active
10.1.1.3        4    65503      5        5        0    0     0  00:00:10  Connect
10.1.1.4        4    65504   1000     1000       10    0     0  01:30:00  0
`
        it('parses Idle state with zero prefix count', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result[0].state).toBe('Idle')
            expect(result[0].prefixCount).toBe(0)
        })

        it('parses Active state with zero prefix count', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result[1].state).toBe('Active')
            expect(result[1].prefixCount).toBe(0)
        })

        it('parses Connect state with zero prefix count', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result[2].state).toBe('Connect')
            expect(result[2].prefixCount).toBe(0)
        })

        it('treats "0" prefix count as Established with 0 prefixes', () => {
            const result = parseBgpSummary('cisco', output)
            expect(result[3].state).toBe('Established')
            expect(result[3].prefixCount).toBe(0)
        })
    })

    // ── Empty output ─────────────────────────────────────────────────────────

    describe('empty output', () => {
        it('returns empty array for empty string', () => {
            expect(parseBgpSummary('cisco', '')).toEqual([])
        })

        it('returns empty array for whitespace-only', () => {
            expect(parseBgpSummary('juniper', '   \n  \n  ')).toEqual([])
        })

        it('returns empty array for undefined vendor with empty output', () => {
            expect(parseBgpSummary('', '')).toEqual([])
        })
    })
})
