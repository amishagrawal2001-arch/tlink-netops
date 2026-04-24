import {
    buildPingCommand, buildTracerouteCommand,
    parsePingOutput, parseTracerouteOutput, parseIperfOutput,
} from '../renderer/src/services/perf-profiler'
import { makeNode } from './fixtures'

describe('buildPingCommand', () => {
    it('produces Juniper CLI ping syntax', () => {
        const src = makeNode('s1', { vendor: 'Juniper' })
        const tgt = makeNode('t1')
        const cmd = buildPingCommand(src, tgt, '10.0.0.1', 5)
        expect(cmd).not.toBeNull()
        expect(cmd!.command).toEqual(['cli', '-c', 'ping 10.0.0.1 count 5 rapid'])
    })

    it('produces Cisco syntax', () => {
        const src = makeNode('s1', { vendor: 'Cisco' })
        const cmd = buildPingCommand(src, makeNode('t1'), '10.0.0.1', 3)
        expect(cmd!.command).toEqual(['ping', '10.0.0.1', 'count', '3'])
    })

    it('produces Arista syntax with privilege 15', () => {
        const src = makeNode('s1', { vendor: 'Arista' })
        const cmd = buildPingCommand(src, makeNode('t1'), '10.0.0.1', 4)
        expect(cmd!.command[0]).toBe('Cli')
        expect(cmd!.command[1]).toBe('-p')
        expect(cmd!.command[2]).toBe('15')
    })

    it('produces SONiC/FRR Linux ping', () => {
        const src = makeNode('s1', { vendor: 'SONiC' })
        const cmd = buildPingCommand(src, makeNode('t1'), '10.0.0.1')
        expect(cmd!.command).toEqual(['ping', '-c', '5', '10.0.0.1'])
    })

    it('falls back to generic Linux for unknown vendor', () => {
        const src = makeNode('s1', { vendor: 'UnknownVendor' })
        const cmd = buildPingCommand(src, makeNode('t1'), '10.0.0.1')
        expect(cmd!.command[0]).toBe('ping')
    })
})

describe('parsePingOutput', () => {
    it('parses Linux ping stats', () => {
        const output = `PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.
64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=0.045 ms
64 bytes from 10.0.0.1: icmp_seq=2 ttl=64 time=0.056 ms

--- 10.0.0.1 ping statistics ---
5 packets transmitted, 5 received, 0% packet loss, time 4006ms
rtt min/avg/max/mdev = 0.045/0.056/0.067/0.009 ms
`
        const stats = parsePingOutput(output)
        expect(stats).not.toBeNull()
        expect(stats!.packetsSent).toBe(5)
        expect(stats!.packetsReceived).toBe(5)
        expect(stats!.lossPercent).toBe(0)
        expect(stats!.rttAvgMs).toBe(0.056)
    })

    it('detects packet loss', () => {
        const output = `5 packets transmitted, 3 received, 40% packet loss, time 4010ms
rtt min/avg/max/mdev = 1.0/2.0/3.0/0.5 ms`
        const stats = parsePingOutput(output)
        expect(stats!.lossPercent).toBe(40)
    })
})

describe('parseTracerouteOutput', () => {
    it('extracts hops', () => {
        const output = `traceroute to 10.0.0.1 (10.0.0.1), 30 hops max
 1  10.1.0.1 (10.1.0.1)  0.123 ms  0.145 ms  0.156 ms
 2  10.2.0.1 (10.2.0.1)  1.234 ms  1.345 ms  1.456 ms
 3  10.0.0.1 (10.0.0.1)  2.345 ms  2.456 ms  2.567 ms`
        const hops = parseTracerouteOutput(output)
        expect(hops).toHaveLength(3)
        expect(hops[0]).toEqual({ hop: 1, ip: '10.1.0.1', avgMs: 0.123 })
        expect(hops[2].hop).toBe(3)
        expect(hops[2].ip).toBe('10.0.0.1')
    })
})

describe('parseIperfOutput', () => {
    it('parses Gbits/sec', () => {
        const output = '[SUM]  0.00-10.00  sec  10.5 GBytes  9.00 Gbits/sec'
        const bw = parseIperfOutput(output)
        expect(bw).toBe(9000)  // Mbps
    })

    it('parses Mbits/sec', () => {
        const output = '[  5]  0.00-10.00  sec  1.0 GBytes  850 Mbits/sec'
        const bw = parseIperfOutput(output)
        expect(bw).toBe(850)
    })

    it('returns null on no match', () => {
        const output = 'error: unable to connect'
        const bw = parseIperfOutput(output)
        expect(bw).toBeNull()
    })
})

describe('buildTracerouteCommand', () => {
    it('uses Juniper CLI syntax', () => {
        const src = makeNode('s1', { vendor: 'Juniper' })
        const cmd = buildTracerouteCommand(src, makeNode('t1'), '10.0.0.1')
        expect(cmd!.command).toEqual(['cli', '-c', 'traceroute 10.0.0.1 no-resolve'])
    })

    it('uses Linux traceroute -n for generic', () => {
        const src = makeNode('s1', { vendor: 'SONiC' })
        const cmd = buildTracerouteCommand(src, makeNode('t1'), '10.0.0.1')
        expect(cmd!.command).toEqual(['traceroute', '-n', '10.0.0.1'])
    })
})
