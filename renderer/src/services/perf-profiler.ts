// ═══════════════════════════════════════════════════════════════════════════════
// Performance Profiler
// Generates ping / traceroute / iperf3 commands for pairwise probes between nodes.
// Caller executes the commands via docker exec or SSH and feeds output back.
// ═══════════════════════════════════════════════════════════════════════════════

import { TopologyNode } from '../api/interfaces'

export type ProbeType = 'ping' | 'traceroute' | 'iperf3-client' | 'iperf3-server'

export interface ProbeCommand {
    probe: ProbeType
    sourceNodeId: string
    targetNodeId: string
    targetIp: string
    /** Vendor-specific command (e.g. `ping 10.0.0.1 count 5` for Juniper) */
    command: string[]
    /** Run on container (docker exec) or host */
    runMode: 'docker' | 'ssh'
    containerName?: string
}

export interface ProbeResult {
    probe: ProbeType
    sourceNodeId: string
    targetNodeId: string
    ok: boolean
    /** Ping-specific metrics */
    pingStats?: {
        packetsSent: number
        packetsReceived: number
        lossPercent: number
        rttMinMs: number
        rttAvgMs: number
        rttMaxMs: number
    }
    /** Traceroute hops */
    tracerouteHops?: Array<{ hop: number; ip: string; avgMs: number }>
    /** iperf3 bandwidth */
    iperfBandwidthMbps?: number
    rawOutput: string
}

/**
 * Build a ping command for the given vendor / container kind.
 * Returns vendor-appropriate ping syntax.
 */
export function buildPingCommand (
    source: TopologyNode, target: TopologyNode, targetIp: string, count = 5,
): ProbeCommand | null {
    const vendor = (source.vendor ?? '').toLowerCase()
    let cmd: string[]
    if (vendor.includes('juniper')) {
        cmd = ['cli', '-c', `ping ${targetIp} count ${count} rapid`]
    } else if (vendor.includes('cisco')) {
        cmd = ['ping', targetIp, 'count', String(count)]
    } else if (vendor.includes('arista')) {
        cmd = ['Cli', '-p', '15', '-c', `ping ${targetIp} repeat ${count}`]
    } else if (vendor.includes('sonic') || vendor.includes('frr')) {
        cmd = ['ping', '-c', String(count), targetIp]
    } else if (vendor.includes('nokia')) {
        cmd = ['sr_cli', '-d', `ping ${targetIp} count ${count}`]
    } else if (vendor.includes('huawei')) {
        cmd = ['ping', '-c', String(count), targetIp]
    } else {
        // Generic Linux fallback — works in most containerlab scenarios
        cmd = ['ping', '-c', String(count), targetIp]
    }
    return {
        probe: 'ping',
        sourceNodeId: source.id,
        targetNodeId: target.id,
        targetIp,
        command: cmd,
        runMode: source.mapped ? 'ssh' : 'docker',
        containerName: source.mapped ? undefined : `clab-${source.label}`.toLowerCase(),
    }
}

export function buildTracerouteCommand (
    source: TopologyNode, target: TopologyNode, targetIp: string,
): ProbeCommand | null {
    const vendor = (source.vendor ?? '').toLowerCase()
    let cmd: string[]
    if (vendor.includes('juniper')) {
        cmd = ['cli', '-c', `traceroute ${targetIp} no-resolve`]
    } else if (vendor.includes('cisco') || vendor.includes('arista')) {
        cmd = ['traceroute', targetIp]
    } else {
        // Generic Linux fallback
        cmd = ['traceroute', '-n', targetIp]
    }
    return {
        probe: 'traceroute',
        sourceNodeId: source.id,
        targetNodeId: target.id,
        targetIp,
        command: cmd,
        runMode: source.mapped ? 'ssh' : 'docker',
        containerName: source.mapped ? undefined : `clab-${source.label}`.toLowerCase(),
    }
}

/** Parse ping output (generic Linux / FRR / cRPD format) into structured metrics */
export function parsePingOutput (output: string): ProbeResult['pingStats'] | null {
    // Format: "5 packets transmitted, 5 received, 0% packet loss, time 4006ms"
    //         "rtt min/avg/max/mdev = 0.045/0.056/0.067/0.009 ms"
    const pktMatch = output.match(/(\d+)\s+packets transmitted,\s+(\d+)\s+received.*?(\d+(?:\.\d+)?)%\s*packet loss/i)
    const rttMatch = output.match(/min\/avg\/max(?:\/mdev)?\s*=\s*(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/i)
    if (!pktMatch) { return null }
    return {
        packetsSent: Number(pktMatch[1]),
        packetsReceived: Number(pktMatch[2]),
        lossPercent: Number(pktMatch[3]),
        rttMinMs: rttMatch ? Number(rttMatch[1]) : 0,
        rttAvgMs: rttMatch ? Number(rttMatch[2]) : 0,
        rttMaxMs: rttMatch ? Number(rttMatch[3]) : 0,
    }
}

/** Parse traceroute output — extracts hop list with average RTT */
export function parseTracerouteOutput (output: string): Array<{ hop: number; ip: string; avgMs: number }> {
    const hops: Array<{ hop: number; ip: string; avgMs: number }> = []
    const lines = output.split('\n')
    for (const line of lines) {
        // Format: " 1  10.0.0.1 (10.0.0.1)  0.123 ms  0.145 ms  0.156 ms"
        //         " 2  * * *"
        const m = line.match(/^\s*(\d+)\s+(\S+)(?:\s+\((\d+\.\d+\.\d+\.\d+)\))?\s+(\d+(?:\.\d+)?)\s*ms/)
        if (m) {
            const ip = m[3] ?? m[2]
            if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                hops.push({ hop: Number(m[1]), ip, avgMs: Number(m[4]) })
            }
        }
    }
    return hops
}

/** Parse iperf3 output — extract final bandwidth from summary line */
export function parseIperfOutput (output: string): number | null {
    // Format: "[SUM]  0.00-10.00  sec  10.5 GBytes  9.00 Gbits/sec"
    //         or
    //         "[  5]  0.00-10.00  sec  1.23 GBytes  1.05 Gbits/sec"
    const match = output.match(/(\d+(?:\.\d+)?)\s+(Kbits|Mbits|Gbits)\/sec/i)
    if (!match) { return null }
    const value = Number(match[1])
    const unit = match[2].toLowerCase()
    const multiplier = unit.startsWith('g') ? 1000 : unit.startsWith('m') ? 1 : 0.001
    return value * multiplier
}
