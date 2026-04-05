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

export interface SnmpDiscoveryParams {
    version: '2c' | '3'
    host: string
    port?: number
    community?: string
    username?: string
    authProtocol?: 'md5' | 'sha'
    authPassword?: string
    privProtocol?: 'des' | 'aes'
    privPassword?: string
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

    private _backendClient: any = null
    setBackendClient (client: any): void { this._backendClient = client }

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
      try {
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
      } catch (err) {
        console.warn('Network discovery failed:', (err as Error).message)
        return { devices: [], links: [] }
      }
    }

    // ─── SNMP-based discovery ──────────────────────────────────────────────

    /**
     * Discover neighbors of a single device via SNMP LLDP MIB walks.
     * Returns the same DiscoveryResult format as the SSH-based BFS discovery.
     */
    async discoverViaSNMP (
        host: string,
        snmpParams: SnmpDiscoveryParams,
        opts?: { timeoutMs?: number },
    ): Promise<DiscoveryResult> {
      try {
        const api = (window as any).netopsAPI
        if (!api?.snmpWalk) {
            throw new Error('SNMP API not available')
        }

        const timeoutMs = opts?.timeoutMs ?? 5000

        // Build the base SNMP payload (shared across all walks)
        const basePayload: Record<string, unknown> = {
            version: snmpParams.version,
            host: snmpParams.host ?? host,
            port: snmpParams.port ?? 161,
            timeoutMs,
            ...(snmpParams.version === '2c'
                ? { community: snmpParams.community ?? 'public' }
                : {
                    username: snmpParams.username,
                    authProtocol: snmpParams.authProtocol,
                    authPassword: snmpParams.authPassword,
                    privProtocol: snmpParams.privProtocol,
                    privPassword: snmpParams.privPassword,
                }),
        }

        // LLDP MIB OIDs
        const OID_LLDP_REM_SYS_NAME   = '1.0.8802.1.1.2.1.4.1.1.9'
        const OID_LLDP_REM_PORT_ID    = '1.0.8802.1.1.2.1.4.1.1.7'
        const OID_LLDP_REM_MAN_ADDR   = '1.0.8802.1.1.2.1.4.2.1.4'
        const OID_SYS_NAME            = '1.3.6.1.2.1.1.5.0'
        const OID_SYS_DESCR           = '1.3.6.1.2.1.1.1.0'

        // Helper: walk a single OID subtree, return varbinds
        const walk = async (oid: string): Promise<{ oid: string; value: string }[]> => {
            const result = await api.snmpWalk({ ...basePayload, oid })
            if (!result.ok || !result.data) { return [] }
            return result.data.map((vb: { oid: string; value: string }) => ({
                oid: vb.oid,
                value: vb.value,
            }))
        }

        // Run all SNMP walks in parallel
        const [sysNameVbs, sysDescrVbs, remSysNameVbs, remPortIdVbs, remManAddrVbs] = await Promise.all([
            walk(OID_SYS_NAME),
            walk(OID_SYS_DESCR),
            walk(OID_LLDP_REM_SYS_NAME),
            walk(OID_LLDP_REM_PORT_ID),
            walk(OID_LLDP_REM_MAN_ADDR),
        ])

        // Extract local device info
        const localHostname = sysNameVbs[0]?.value ?? host
        const sysDescr = sysDescrVbs[0]?.value ?? ''
        const vendor = this._detectVendorFromSysDescr(sysDescr)

        // Build the local device entry
        const localDevice: DiscoveredDevice = {
            hostname: localHostname,
            mgmtIp: host,
            vendor,
            model: '',
            interfaces: [],
        }

        // Index remote neighbor data by the LLDP table index suffix
        // OID format: <base>.<timeMark>.<localPortNum>.<index>
        const neighborNames = new Map<string, string>()
        for (const vb of remSysNameVbs) {
            const suffix = vb.oid.slice(OID_LLDP_REM_SYS_NAME.length + 1)
            neighborNames.set(suffix, vb.value)
        }

        const neighborPorts = new Map<string, string>()
        for (const vb of remPortIdVbs) {
            const suffix = vb.oid.slice(OID_LLDP_REM_PORT_ID.length + 1)
            neighborPorts.set(suffix, vb.value)
        }

        const neighborMgmtIps = new Map<string, string>()
        for (const vb of remManAddrVbs) {
            const suffix = vb.oid.slice(OID_LLDP_REM_MAN_ADDR.length + 1)
            neighborMgmtIps.set(suffix, vb.value)
        }

        // Build discovered neighbors and links
        const devices: DiscoveredDevice[] = [localDevice]
        const links: DiscoveredLink[] = []
        const seenNeighbors = new Set<string>()

        for (const [suffix, neighborHostname] of neighborNames) {
            const remotePort = neighborPorts.get(suffix) ?? ''
            // Try to find a matching mgmt IP — the remManAddr index includes the address type,
            // so we look for any entry whose suffix starts with our index prefix
            const indexParts = suffix.split('.')
            // The LLDP index is typically <timeMark>.<localPortNum>.<index>
            const localPortNum = indexParts.length >= 2 ? indexParts[1] : ''
            let remoteMgmtIp = ''
            for (const [addrSuffix, addrValue] of neighborMgmtIps) {
                if (addrSuffix.startsWith(suffix) || addrSuffix.includes(`.${indexParts[indexParts.length - 1]}.`)) {
                    remoteMgmtIp = addrValue
                    break
                }
            }

            // Track local interface
            const localIfName = `port-${localPortNum}`
            if (localPortNum && !localDevice.interfaces.includes(localIfName)) {
                localDevice.interfaces.push(localIfName)
            }

            // Build link
            links.push({
                srcHost: localHostname,
                srcInterface: localIfName,
                dstHost: neighborHostname,
                dstInterface: remotePort,
            })

            // Add neighbor as discovered device (deduplicated)
            const neighborKey = neighborHostname || remoteMgmtIp
            if (neighborKey && !seenNeighbors.has(neighborKey)) {
                seenNeighbors.add(neighborKey)
                devices.push({
                    hostname: neighborHostname || remoteMgmtIp,
                    mgmtIp: remoteMgmtIp || neighborHostname,
                    vendor: '',
                    model: '',
                    interfaces: [remotePort].filter(Boolean),
                })
            }
        }

        return { devices, links }
      } catch (err) {
        console.warn('Network discovery failed:', (err as Error).message)
        return { devices: [], links: [] }
      }
    }

    // ─── Private helpers ────────────────────────────────────────────────────

    /**
     * Heuristic vendor detection from sysDescr (SNMP).
     */
    private _detectVendorFromSysDescr (sysDescr: string): string {
        const lower = sysDescr.toLowerCase()
        if (lower.includes('juniper') || lower.includes('junos'))   { return 'Juniper' }
        if (lower.includes('cisco') || lower.includes('ios'))       { return 'Cisco' }
        if (lower.includes('arista') || lower.includes('eos'))      { return 'Arista' }
        if (lower.includes('nokia') || lower.includes('sr os'))     { return 'Nokia' }
        if (lower.includes('huawei') || lower.includes('vrp'))      { return 'Huawei' }
        if (lower.includes('mikrotik') || lower.includes('routeros')) { return 'MikroTik' }
        if (lower.includes('linux'))                                 { return 'Linux' }
        return ''
    }

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
        if (this._backendClient?.isConnected) {
            const result = await this._backendClient.pollDevice(creds.host, creds.port, creds.username, creds.password, [command])
            if (!result.ok) {
                throw new Error(result.message ?? 'SSH command failed')
            }
            const entry = result.results?.[0]
            return entry?.stdout ?? entry?.output ?? ''
        }

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
