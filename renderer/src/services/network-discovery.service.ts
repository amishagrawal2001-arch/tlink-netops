// ═══════════════════════════════════════════════════════════════════════════════
// Network Discovery Service — BFS-based LLDP network discovery
// ═══════════════════════════════════════════════════════════════════════════════

import { Injectable } from '@angular/core'
import { getVendorCommands } from './vendor-command-map'
import { detectVendorFromOutput, parseShowVersion, parseLldpNeighbors } from './vendor-output-parser'

export interface DiscoveredDevice {
    hostname: string
    mgmtIp: string
    vendor: string
    model: string
    interfaces: string[]
}

export interface DiscoveredLink {
    srcHost: string
    srcInterface: string
    dstHost: string
    dstInterface: string
}

export interface DiscoveryResult {
    devices: DiscoveredDevice[]
    links: DiscoveredLink[]
}

export interface DiscoveryOptions {
    maxDepth?: number
    timeoutMs?: number
    port?: number
}

interface SshCredentials {
    host: string
    port: number
    username: string
    password: string
}

interface BfsEntry {
    host: string
    depth: number
}

@Injectable({ providedIn: 'root' })
export class NetworkDiscoveryService {

    /**
     * Discover the network starting from a seed device.
     * Uses BFS over LLDP neighbors to find all reachable devices and links.
     */
    async discoverFromSeed (
        host: string,
        port: number,
        username: string,
        password: string,
        opts?: DiscoveryOptions,
    ): Promise<DiscoveryResult> {
        const maxDepth = opts?.maxDepth ?? 3
        const timeoutMs = opts?.timeoutMs ?? 15000
        const sshPort = opts?.port ?? port

        const devices: DiscoveredDevice[] = []
        const links: DiscoveredLink[] = []
        const visited = new Set<string>()
        const queue: BfsEntry[] = [{ host, depth: 0 }]

        while (queue.length > 0) {
            const entry = queue.shift()!
            const normalizedHost = entry.host.trim()

            if (visited.has(normalizedHost)) { continue }
            visited.add(normalizedHost)

            const creds: SshCredentials = {
                host: normalizedHost,
                port: sshPort,
                username,
                password,
            }

            try {
                // Step 1: Detect vendor via show version
                const vendor = await this._detectVendor(creds, timeoutMs)
                if (!vendor) { continue }

                const cmds = getVendorCommands(vendor)
                const versionOutput = await this._runCommand(creds, cmds.showVersion, timeoutMs)
                const parsed = parseShowVersion(vendor, versionOutput)

                // Step 2: Build device entry
                const device: DiscoveredDevice = {
                    hostname: parsed.hardwareModel
                        ? `${normalizedHost}`
                        : normalizedHost,
                    mgmtIp: normalizedHost,
                    vendor,
                    model: parsed.hardwareModel ?? '',
                    interfaces: [],
                }

                // Step 3: Run LLDP neighbor command
                const lldpCmd = cmds.showLldpNeighbors
                if (lldpCmd) {
                    const lldpOutput = await this._runCommand(creds, lldpCmd, timeoutMs)
                    const neighbors = parseLldpNeighbors(vendor, lldpOutput)

                    for (const neighbor of neighbors) {
                        // Track interfaces
                        if (neighbor.localPort && !device.interfaces.includes(neighbor.localPort)) {
                            device.interfaces.push(neighbor.localPort)
                        }

                        // Build link
                        links.push({
                            srcHost: normalizedHost,
                            srcInterface: neighbor.localPort,
                            dstHost: neighbor.neighborHostname,
                            dstInterface: neighbor.neighborPort,
                        })

                        // Enqueue neighbor for BFS if within depth and has a reachable address
                        if (entry.depth < maxDepth) {
                            const neighborAddr = neighbor.neighborMgmtIp ?? neighbor.neighborHostname
                            if (neighborAddr && !visited.has(neighborAddr)) {
                                queue.push({ host: neighborAddr, depth: entry.depth + 1 })
                            }
                        }
                    }
                }

                devices.push(device)
            } catch {
                // SSH or parse failure for this host — skip and continue BFS
                continue
            }
        }

        return { devices, links }
    }

    // ─── Private helpers ────────────────────────────────────────────────────

    /**
     * Detect vendor by running `show version` (or equivalent) and inspecting output.
     */
    private async _detectVendor (creds: SshCredentials, timeoutMs: number): Promise<string> {
        // Try common version commands until one returns useful output
        const probeCommands = ['show version', 'display version', '/system resource print']
        for (const cmd of probeCommands) {
            try {
                const output = await this._runCommand(creds, cmd, timeoutMs)
                if (output && output.trim()) {
                    const vendor = detectVendorFromOutput(output)
                    if (vendor) { return vendor }
                }
            } catch {
                // Try next command
            }
        }
        return ''
    }

    /**
     * Execute a single SSH command via the Electron preload API.
     */
    private async _runCommand (creds: SshCredentials, command: string, timeoutMs: number): Promise<string> {
        const api = (window as any).netopsAPI
        if (!api?.sshRunCommands) {
            throw new Error('SSH API not available')
        }

        const result = await api.sshRunCommands({
            host: creds.host,
            port: creds.port,
            username: creds.username,
            password: creds.password,
            timeoutMs,
            commands: [command],
        })

        if (!result.ok) {
            throw new Error(result.message ?? 'SSH command failed')
        }

        const entry = result.results?.[0]
        return entry?.stdout ?? entry?.output ?? ''
    }
}
