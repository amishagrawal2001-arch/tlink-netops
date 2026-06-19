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
    /** All known names/addresses for this device — populated during BFS so
     *  link-resolution can match against any of them (e.g. when BFS reached
     *  the device via mgmt IP but LLDP peers reference it by FQDN). */
    aliases?: string[]
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
    /** Number of hosts probed in parallel per BFS wave. Default: 8. */
    concurrency?: number
    /** Hard cap on total hosts the BFS will probe in one run. Default: 500.
     *  Prevents a runaway crawl when a campus mgmt network advertises every
     *  Linux box on LLDP. Set 0 to disable. */
    maxHosts?: number
    /** Optional progress callback fired after each wave finishes. */
    onProgress?: (info: { processed: number; queued: number; lastWaveSize: number; elapsedMs: number; currentHosts?: string[] }) => void
    /** Streamed-discovery callbacks. Fire after each wave folds in its results
     *  so the UI can render nodes/links incrementally instead of waiting for
     *  the whole BFS to finish. Both callbacks receive ONLY items new in
     *  this wave (deltas), not the cumulative totals. */
    onDevices?: (newDevices: DiscoveredDevice[]) => void
    onLinks?: (newLinks: DiscoveredLink[]) => void
    /** Regex patterns (case-insensitive) — any host whose name OR mgmt IP
     *  matches any of these is skipped during BFS. Both for visiting and
     *  for being recorded as a link endpoint. Use to drop mgmt-network
     *  noise like `geoman-*`, `*srv*`, `contrail-*` from discovery. */
    excludePatterns?: RegExp[]
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
    /** Alternate names this host is known by (e.g. LLDP sys-name when the
     *  enqueue address was the mgmt IP). Used to populate device.aliases so
     *  later link-resolution can match the device by any of these forms. */
    aliases?: string[]
}

@Injectable({ providedIn: 'root' })
export class NetworkDiscoveryService {

    private _backendClient: any = null
    setBackendClient (client: any): void { this._backendClient = client }

    /** Set true to make any in-flight BFS / inventory discovery bail at the
     *  next wave boundary. Cleared automatically at the start of each run. */
    private _abortRequested = false
    abort (): void { this._abortRequested = true }
    get isAborted (): boolean { return this._abortRequested }

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
        const timeoutMs = opts?.timeoutMs ?? 8000
        const sshPort = opts?.port ?? port
        const concurrency = Math.max(1, opts?.concurrency ?? 8)
        const maxHosts = opts?.maxHosts ?? 500
        const onProgress = opts?.onProgress
        const onDevices = opts?.onDevices
        const onLinks   = opts?.onLinks
        const excludeREs = opts?.excludePatterns ?? []
        const isExcluded = (s: string): boolean => {
            if (!s || !excludeREs.length) { return false }
            return excludeREs.some(re => re.test(s))
        }
        this._abortRequested = false   // fresh run
        const t0 = Date.now()

        const devices: DiscoveredDevice[] = []
        const links: DiscoveredLink[] = []
        const visited = new Set<string>()
        let queue: BfsEntry[] = [{ host, depth: 0 }]

        // Per-host diagnostics — surfaced at the end so users can see why a
        // device was skipped (auth failure, vendor not detected, LLDP empty…).
        const diagnostics: Array<{ host: string; depth: number; status: string; detail?: string }> = []

        // Regex that matches things that are CLEARLY interface names, not
        // hostnames. We refuse to enqueue these for BFS because they'll just
        // fail DNS and waste time.
        const looksLikeInterface = (s: string): boolean => {
            const t = s.trim()
            return /^(et|ge|xe|fe|me|fxp|em|ae|lo|mgmt|so|t1|t3|po|eth|eno|ens|enp)[-_]?\d/i.test(t) ||
                   /^(Gi|Te|Fo|Fa|Hu|Tw|Twe|Et)\d/i.test(t) ||
                   /^[a-zA-Z]+\d+\/\d+\/\d+/.test(t) ||
                   t.includes(':') && /:\d+$/.test(t)    // e.g. et-0/0/6:1
        }

        // Per-host probe — runs on a worker in parallel with peers.
        // Returns the device entry, the new links discovered, and any new
        // BFS entries to enqueue. All side-effecting collections are returned
        // (not mutated directly) so the caller can fold them in atomically.
        const probeHost = async (entry: BfsEntry): Promise<{
            host: string;
            device?: DiscoveredDevice;
            newLinks: DiscoveredLink[];
            newQueue: BfsEntry[];
            diag: { host: string; depth: number; status: string; detail?: string };
        }> => {
            const normalizedHost = entry.host.trim()
            const creds: SshCredentials = { host: normalizedHost, port: sshPort, username, password }
            const newLinks: DiscoveredLink[] = []
            const newQueue: BfsEntry[] = []

            try {
                // Step 1: detect vendor — and reuse the show-version output
                // for hardware-model parsing instead of running it again.
                const det = await this._detectVendorImpl(creds, timeoutMs)
                if (!det.vendor) {
                    const msg = `vendor not detected (show version didn't match any known pattern)`
                    console.warn(`[discovery] ${normalizedHost}: ${msg}`)
                    return { host: normalizedHost, newLinks, newQueue,
                        diag: { host: normalizedHost, depth: entry.depth, status: 'skip', detail: msg } }
                }

                const vendor = det.vendor
                // Pass username so Junos+root routes to shell-wrapped commands —
                // root SSH lands in FreeBSD shell, not Junos CLI.
                const cmds = getVendorCommands(vendor, '', creds.username)
                // Reuse the captured output if we already ran the same probe
                // command in detection. Falls back to a fresh fetch otherwise.
                const versionOutput = det.output && det.output.trim()
                    ? det.output
                    : await this._runCommand(creds, cmds.showVersion, timeoutMs)
                const parsed = parseShowVersion(vendor, versionOutput)

                // Collect every plausible name/address for this device so the
                // canvas-side hostname resolver can latch on no matter which
                // form LLDP peers use to reference it.
                //   - normalizedHost: how BFS reached this device (could be IP)
                //   - entry.aliases:  alternate names seen by upstream peers
                //                     (e.g. LLDP sys-name when we enqueued by IP)
                const aliasSet = new Set<string>()
                const addAlias = (s: string | undefined): void => {
                    if (!s) { return }
                    const v = s.trim().toLowerCase()
                    if (v) { aliasSet.add(v) }
                    const short = v.split('.')[0]
                    if (short && short !== v) { aliasSet.add(short) }
                }
                addAlias(normalizedHost)
                for (const a of (entry.aliases ?? [])) { addAlias(a) }

                const device: DiscoveredDevice = {
                    hostname: normalizedHost,
                    mgmtIp: normalizedHost,
                    vendor,
                    model: parsed.hardwareModel ?? '',
                    interfaces: [],
                    aliases: [...aliasSet],
                }

                // Step 2: LLDP neighbors
                let neighborCount = 0
                const lldpCmd = cmds.showLldpNeighbors
                if (lldpCmd) {
                    const lldpOutput = await this._runCommand(creds, lldpCmd, timeoutMs)
                    const neighbors = parseLldpNeighbors(vendor, lldpOutput)
                    neighborCount = neighbors.length

                    console.log(
                        `[discovery] ${normalizedHost} LLDP raw (vendor=${vendor}, cmd=${lldpCmd}):`,
                        '\n' + (lldpOutput ?? '').trim().slice(0, 800),
                    )
                    console.log(`[discovery] ${normalizedHost} LLDP parsed (${neighbors.length} neighbors):`, neighbors)

                    if (!neighbors.length) {
                        console.warn(`[discovery] ${normalizedHost}: LLDP returned 0 neighbors`)
                    }

                    for (const neighbor of neighbors) {
                        if (neighbor.localPort && !device.interfaces.includes(neighbor.localPort)) {
                            device.interfaces.push(neighbor.localPort)
                        }
                        if (looksLikeInterface(neighbor.neighborHostname)) {
                            console.warn(
                                `[discovery] ${normalizedHost}: dropping neighbor — hostname "${neighbor.neighborHostname}" ` +
                                `looks like an interface name (parser likely misattributed columns). ` +
                                `Full entry: ${JSON.stringify(neighbor)}`,
                            )
                            continue
                        }
                        // User-supplied exclusion patterns — drop the link AND
                        // skip enqueueing this neighbor entirely. Useful for
                        // mgmt-network noise (geoman-*, *srv*, contrail-*).
                        if (isExcluded(neighbor.neighborHostname) || isExcluded(neighbor.neighborMgmtIp ?? '')) {
                            console.log(
                                `[discovery] ${normalizedHost}: excluding neighbor "${neighbor.neighborHostname}" ` +
                                `(matched user pattern)`,
                            )
                            continue
                        }
                        newLinks.push({
                            srcHost: normalizedHost,
                            srcInterface: neighbor.localPort,
                            dstHost: neighbor.neighborHostname,
                            dstInterface: neighbor.neighborPort,
                        })
                        if (entry.depth < maxDepth) {
                            const neighborAddr = neighbor.neighborMgmtIp ?? neighbor.neighborHostname
                            if (neighborAddr && !looksLikeInterface(neighborAddr) && !isExcluded(neighborAddr)) {
                                // Carry forward the LLDP sys-name AND mgmt IP
                                // as aliases so the eventual device entry can
                                // be looked up by either form during link
                                // resolution. Deduped against the host itself.
                                const aliases: string[] = []
                                if (neighbor.neighborHostname && neighbor.neighborHostname !== neighborAddr) {
                                    aliases.push(neighbor.neighborHostname)
                                }
                                if (neighbor.neighborMgmtIp && neighbor.neighborMgmtIp !== neighborAddr) {
                                    aliases.push(neighbor.neighborMgmtIp)
                                }
                                newQueue.push({ host: neighborAddr, depth: entry.depth + 1, aliases })
                            }
                        }
                    }
                }

                console.log(
                    `[discovery] ${normalizedHost} ✓ ` +
                    `vendor=${vendor} model=${parsed.hardwareModel ?? '?'} neighbors=${neighborCount} depth=${entry.depth}`,
                )
                return {
                    host: normalizedHost, device, newLinks, newQueue,
                    diag: {
                        host: normalizedHost, depth: entry.depth, status: 'ok',
                        detail: `vendor=${vendor}, model=${parsed.hardwareModel ?? '?'}, neighbors=${neighborCount}`,
                    },
                }
            } catch (err) {
                const msg = (err as Error).message || String(err)
                console.warn(`[discovery] ${normalizedHost}: ${msg}`)
                return { host: normalizedHost, newLinks, newQueue,
                    diag: { host: normalizedHost, depth: entry.depth, status: 'fail', detail: msg } }
            }
        }

        // Drive BFS in parallel waves.
        let processed = 0
        let stoppedReason = ''
        while (queue.length > 0) {
            // Bail if user cancelled.
            if (this._abortRequested) {
                stoppedReason = 'aborted by user'
                break
            }
            // Bail if we've hit the hard host cap (prevents runaway crawl
            // when a campus mgmt network advertises every Linux box on LLDP).
            if (maxHosts > 0 && processed >= maxHosts) {
                stoppedReason = `host cap reached (${maxHosts})`
                break
            }
            // Pull up to `concurrency` unique unvisited hosts off the queue.
            const wave: BfsEntry[] = []
            while (queue.length && wave.length < concurrency) {
                const e = queue.shift()!
                const h = e.host.trim()
                if (visited.has(h)) { continue }
                // Belt-and-suspenders: skip excluded hosts even if one snuck
                // into the queue (e.g. the user-provided seed itself matched).
                if (isExcluded(h)) {
                    visited.add(h)
                    console.log(`[discovery] ${h}: skipped (matches user exclude pattern)`)
                    continue
                }
                visited.add(h)
                wave.push(e)
                // Honour the cap mid-wave too so we don't overshoot by ~7.
                if (maxHosts > 0 && processed + wave.length >= maxHosts) { break }
            }
            if (!wave.length) { continue }

            // Surface the names of the hosts in this wave so the UI can show
            // "Probing X, Y, Z…" rather than just a counter.
            try {
                onProgress?.({
                    processed, queued: queue.length, lastWaveSize: wave.length,
                    elapsedMs: Date.now() - t0,
                    currentHosts: wave.map(w => w.host),
                })
            } catch { /* never let UI cb break BFS */ }

            const results = await Promise.all(wave.map(probeHost))

            // Fold per-worker outputs into shared state and collect this
            // wave's deltas to stream out to subscribers.
            const waveDevices: DiscoveredDevice[] = []
            const waveLinks: DiscoveredLink[] = []
            for (const r of results) {
                if (r.device) { devices.push(r.device); waveDevices.push(r.device) }
                for (const l of r.newLinks) { links.push(l); waveLinks.push(l) }
                for (const q of r.newQueue) {
                    if (!visited.has(q.host)) { queue.push(q) }
                }
                diagnostics.push(r.diag)
            }
            // Stream the deltas to the UI so the canvas can grow as we go.
            // Wrapped in try/catch so a buggy callback can't break BFS.
            try { if (waveDevices.length && onDevices) { onDevices(waveDevices) } } catch { /* swallow */ }
            try { if (waveLinks.length   && onLinks)   { onLinks(waveLinks) } }   catch { /* swallow */ }

            processed += wave.length
            const elapsedMs = Date.now() - t0
            console.log(
                `[discovery] wave done — processed=${processed} queued=${queue.length} ` +
                `concurrency=${concurrency} elapsed=${(elapsedMs / 1000).toFixed(1)}s`,
            )
            try { onProgress?.({ processed, queued: queue.length, lastWaveSize: wave.length, elapsedMs }) } catch { /* never let UI cb break BFS */ }
        }
        if (stoppedReason) {
            console.warn(`[discovery] BFS stopped early: ${stoppedReason}`)
        }

        // Attach the diagnostics to the result object (non-breaking, optional field)
        ;(devices as any).__diagnostics = diagnostics
        ;(links as any).__diagnostics = diagnostics
        console.log(
            `[discovery] BFS complete — attempted ${diagnostics.length} host(s) ` +
            `in ${((Date.now() - t0) / 1000).toFixed(1)}s (concurrency=${concurrency}):`,
            diagnostics,
        )

        return { devices, links }
      } catch (err) {
        console.warn('Network discovery failed:', (err as Error).message)
        return { devices: [], links: [] }
      }
    }

    /**
     * Closed-inventory LLDP discovery.
     *
     * Probes ONLY the devices already in the inventory (no BFS walk), and
     * filters adjacencies so only links whose BOTH endpoints are in the
     * inventory are returned. Used when the user has already loaded their
     * device list and just wants to learn how those devices are cabled.
     *
     * Per-device credentials override the fallback credentials when present.
     */
    async discoverLinksAmongInventory (
        inventory: Array<{ hostname: string; mgmtIp: string; sshUsername?: string; sshPassword?: string }>,
        opts: {
            fallbackUsername?: string;
            fallbackPassword?: string;
            port?: number;
            timeoutMs?: number;
            concurrency?: number;
            /** Progress callback now reports per-cause failure counters so the
             *  UI can surface "12 of 50 auth-failed" mid-run. */
            onProgress?: (info: {
                processed: number; total: number; elapsedMs: number;
                authFailed?: number; unreachable?: number; otherFailed?: number;
            }) => void;
            /** Streamed-discovery callbacks (deltas only). */
            onDevices?: (newDevices: DiscoveredDevice[]) => void;
            onLinks?:   (newLinks: DiscoveredLink[]) => void;
            /** Same regex exclusion list as BFS discovery — skips probing
             *  matching inventory devices and drops any LLDP link with a
             *  matching endpoint. */
            excludePatterns?: RegExp[];
            /** Abort the run after this many consecutive auth-failed devices.
             *  Defaults to 5 — protects against typo'd fallback creds blasting
             *  the same wrong password against an entire fabric and locking
             *  out service accounts. Set to 0 to disable the safety. */
            authFailFastThreshold?: number;
        } = {},
    ): Promise<DiscoveryResult> {
      try {
        const timeoutMs = opts.timeoutMs ?? 8000
        const sshPort = opts.port ?? 22
        const concurrency = Math.max(1, opts.concurrency ?? 8)
        const onProgress = opts.onProgress
        const onDevices  = opts.onDevices
        const onLinks    = opts.onLinks
        const excludeREs = opts.excludePatterns ?? []
        const isExcluded = (s: string): boolean => {
            if (!s || !excludeREs.length) { return false }
            return excludeREs.some(re => re.test(s))
        }
        // Pre-filter the inventory list — don't waste an SSH attempt on
        // devices the user has explicitly excluded.
        inventory = inventory.filter(inv =>
            !isExcluded(inv.hostname) && !isExcluded(inv.mgmtIp),
        )
        const t0 = Date.now()

        // Build the "is this hostname in inventory?" matcher.
        // LLDP frequently reports short hostnames even when inventory has FQDNs
        // (and vice versa), so match on both the full string AND the first label.
        const invIndex = new Map<string, { hostname: string; mgmtIp: string }>()  // lookup key → canonical device
        const shortName = (s: string): string => (s ?? '').toLowerCase().split('.')[0]
        for (const inv of inventory) {
            const host = (inv.hostname || '').toLowerCase()
            const ip = (inv.mgmtIp || '').toLowerCase()
            const canonical = { hostname: inv.hostname, mgmtIp: inv.mgmtIp }
            if (host)                { invIndex.set(host, canonical) }
            if (host)                { invIndex.set(shortName(host), canonical) }
            if (ip)                  { invIndex.set(ip, canonical) }
        }
        const resolveInvHost = (neighborLabel: string, neighborMgmtIp: string | undefined): string | null => {
            const candidates = [neighborLabel, neighborMgmtIp, shortName(neighborLabel)]
                .filter(Boolean).map(s => (s as string).toLowerCase())
            for (const c of candidates) {
                const hit = invIndex.get(c)
                if (hit) { return hit.hostname }
            }
            return null
        }

        const devices: DiscoveredDevice[] = []
        const links: DiscoveredLink[] = []
        const diagnostics: Array<{ host: string; status: string; detail?: string; cause?: 'auth' | 'unreachable' | 'other' | 'no-creds' | 'vendor' }> = []
        const authFailFastThreshold = opts.authFailFastThreshold ?? 5
        let consecutiveAuthFails = 0
        let bailedEarly = false   // set when we abort due to repeated auth fails
        let authFailed = 0
        let unreachable = 0
        let otherFailed = 0

        // Classify a per-device failure message into the bucket the UI displays.
        // The patterns mirror _detectVendor's fatalErrRe for consistency.
        const classifyError = (msg: string): 'auth' | 'unreachable' | 'other' => {
            if (/Authentication failed|auth.*fail|Permission denied|invalid password|access denied|bad credentials/i.test(msg)) {
                return 'auth'
            }
            if (/ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|connection refused|host unreachable|network unreachable|connection timed out|client-side timeout/i.test(msg)) {
                return 'unreachable'
            }
            return 'other'
        }

        // Probe one inventory device. Credentials are per-device with fallback.
        const probeInv = async (inv: { hostname: string; mgmtIp: string; sshUsername?: string; sshPassword?: string }): Promise<{
            device?: DiscoveredDevice;
            links: DiscoveredLink[];
            diag: { host: string; status: string; detail?: string; cause?: 'auth' | 'unreachable' | 'other' | 'no-creds' | 'vendor' };
        }> => {
            const target = (inv.mgmtIp || inv.hostname || '').trim()
            const user = inv.sshUsername || opts.fallbackUsername || ''
            const pass = inv.sshPassword || opts.fallbackPassword || ''
            if (!target) {
                return { links: [], diag: { host: inv.hostname || '(blank)', status: 'skip', detail: 'no mgmt IP / hostname' } }
            }
            if (!user || !pass) {
                return { links: [], diag: { host: target, status: 'skip', detail: 'no SSH credentials' } }
            }
            const creds: SshCredentials = { host: target, port: sshPort, username: user, password: pass }

            try {
                const det = await this._detectVendorImpl(creds, timeoutMs)
                if (!det.vendor) {
                    // _detectVendor returns empty in two cases:
                    //   (a) all probes ran but none matched a known vendor → genuinely "skip"
                    //   (b) probes short-circuited on a fatal network/auth error → reclassify as "fail"
                    //       with the proper cause so the wave counters reflect reality
                    const probes = this.lastProbeResult ?? []
                    const failedProbes = probes.filter(p => !p.ok)
                    const allFailed = probes.length > 0 && failedProbes.length === probes.length
                    if (allFailed) {
                        // Pick the most common cause across the failed probes.
                        const firstErr = failedProbes[0]?.err ?? ''
                        const cause = classifyError(firstErr)
                        return { links: [], diag: { host: target, status: 'fail', detail: firstErr.slice(0, 200), cause } }
                    }
                    return { links: [], diag: { host: target, status: 'skip', detail: 'vendor not detected' } }
                }
                const cmds = getVendorCommands(det.vendor, '', creds.username)
                const versionOutput = det.output?.trim() ? det.output : await this._runCommand(creds, cmds.showVersion, timeoutMs)
                const parsed = parseShowVersion(det.vendor, versionOutput)

                const device: DiscoveredDevice = {
                    hostname: inv.hostname || target,
                    mgmtIp: inv.mgmtIp || target,
                    vendor: det.vendor,
                    model: parsed.hardwareModel ?? '',
                    interfaces: [],
                }

                const localLinks: DiscoveredLink[] = []
                if (cmds.showLldpNeighbors) {
                    const lldpOutput = await this._runCommand(creds, cmds.showLldpNeighbors, timeoutMs)
                    const neighbors = parseLldpNeighbors(det.vendor, lldpOutput)
                    for (const n of neighbors) {
                        if (n.localPort && !device.interfaces.includes(n.localPort)) {
                            device.interfaces.push(n.localPort)
                        }
                        // Filter: neighbor must be in the inventory
                        const dstInvHost = resolveInvHost(n.neighborHostname, n.neighborMgmtIp)
                        if (!dstInvHost) { continue }
                        if ((dstInvHost || '').toLowerCase() === (inv.hostname || '').toLowerCase()) { continue } // self
                        // Drop links whose neighbor end matches an exclude pattern.
                        if (isExcluded(dstInvHost) || isExcluded(n.neighborHostname) || isExcluded(n.neighborMgmtIp ?? '')) {
                            continue
                        }
                        localLinks.push({
                            srcHost: inv.hostname || target,
                            srcInterface: n.localPort,
                            dstHost: dstInvHost,
                            dstInterface: n.neighborPort,
                        })
                    }
                }
                return {
                    device, links: localLinks,
                    diag: {
                        host: target, status: 'ok',
                        detail: `vendor=${det.vendor} neighbors-in-inventory=${localLinks.length}`,
                    },
                }
            } catch (err) {
                const msg = (err as Error).message || String(err)
                const cause = classifyError(msg)
                return { links: [], diag: { host: target, status: 'fail', detail: msg, cause } }
            }
        }

        // Process inventory in parallel waves (same pattern as BFS).
        this._abortRequested = false  // fresh run
        let processed = 0
        for (let i = 0; i < inventory.length; i += concurrency) {
            if (this._abortRequested) {
                console.warn('[discovery-inv] aborted by user')
                break
            }
            const wave = inventory.slice(i, i + concurrency)
            const results = await Promise.all(wave.map(probeInv))
            const waveDevices: DiscoveredDevice[] = []
            const waveLinks: DiscoveredLink[] = []
            for (const r of results) {
                if (r.device) { devices.push(r.device); waveDevices.push(r.device) }
                for (const l of r.links) { links.push(l); waveLinks.push(l) }
                diagnostics.push(r.diag)
                // Maintain per-cause counters for the progress callback.
                if (r.diag.status === 'fail') {
                    if (r.diag.cause === 'auth')        { authFailed++;  consecutiveAuthFails++ }
                    else if (r.diag.cause === 'unreachable') { unreachable++; consecutiveAuthFails = 0 }
                    else                                 { otherFailed++; consecutiveAuthFails = 0 }
                } else if (r.diag.status === 'ok') {
                    consecutiveAuthFails = 0
                } else if (r.diag.status === 'skip' && /no SSH credentials/i.test(r.diag.detail ?? '')) {
                    // Skip-no-creds doesn't reset the auth-fail streak (it's not a successful auth either)
                    // but doesn't count toward the threshold either.
                }
            }
            try { if (waveDevices.length && onDevices) { onDevices(waveDevices) } } catch { /* swallow */ }
            try { if (waveLinks.length   && onLinks)   { onLinks(waveLinks) } }   catch { /* swallow */ }
            processed += wave.length
            const elapsedMs = Date.now() - t0
            console.log(
                `[discovery-inv] wave done — processed=${processed}/${inventory.length} ` +
                `concurrency=${concurrency} elapsed=${(elapsedMs / 1000).toFixed(1)}s ` +
                `(authFail=${authFailed} unreachable=${unreachable} other=${otherFailed})`,
            )
            try { onProgress?.({ processed, total: inventory.length, elapsedMs, authFailed, unreachable, otherFailed }) } catch { /* ignore */ }

            // Fail-fast: if N consecutive devices have failed auth, the credentials
            // are almost certainly wrong. Bail rather than blast the same bad
            // password at the rest of the fabric (risk of locking out accounts).
            if (authFailFastThreshold > 0 && consecutiveAuthFails >= authFailFastThreshold) {
                console.warn(
                    `[discovery-inv] aborting — ${consecutiveAuthFails} consecutive auth failures ` +
                    `(threshold ${authFailFastThreshold}). Check fallback credentials.`,
                )
                bailedEarly = true
                this._abortRequested = true
                break
            }
        }

        // De-dupe A↔B / B↔A so each cable counts once.
        const canonical = (l: DiscoveredLink): string => {
            const a = `${l.srcHost.toLowerCase()}|${l.srcInterface}`
            const b = `${l.dstHost.toLowerCase()}|${l.dstInterface}`
            return a < b ? `${a}::${b}` : `${b}::${a}`
        }
        const seen = new Set<string>()
        const dedupedLinks: DiscoveredLink[] = []
        for (const l of links) {
            const k = canonical(l)
            if (seen.has(k)) { continue }
            seen.add(k)
            dedupedLinks.push(l)
        }

        // Stamp diagnostics + counters on the result so the calling UI can
        // build a "12 unreachable, 8 auth-failed, 30 ok" summary line without
        // having to re-classify the messages itself.
        ;(devices as any).__diagnostics = diagnostics
        ;(dedupedLinks as any).__diagnostics = diagnostics
        const summary = {
            authFailed,
            unreachable,
            otherFailed,
            ok: devices.length,
            bailedEarly,
            bailReason: bailedEarly
                ? `Aborted after ${authFailed} auth failure(s) — credentials likely wrong`
                : undefined,
        }
        ;(devices as any).__summary = summary
        ;(dedupedLinks as any).__summary = summary
        console.log(
            `[discovery-inv] complete — probed ${processed}/${inventory.length} inventory device(s), ` +
            `${devices.length} reachable, ${dedupedLinks.length} unique inventory↔inventory links ` +
            `(authFail=${authFailed} unreachable=${unreachable} other=${otherFailed}` +
            `${bailedEarly ? ' BAILED EARLY' : ''}) in ${((Date.now() - t0) / 1000).toFixed(1)}s:`,
            diagnostics,
        )

        return { devices, links: dedupedLinks }
      } catch (err) {
        console.warn('Inventory discovery failed:', (err as Error).message)
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
    /** Last _detectVendor probe attempts — exposed for UI diagnostics. */
    lastProbeResult: Array<{ host: string; cmd: string; ok: boolean; chars: number; preview: string; err?: string }> = []

    /**
     * Detect vendor and return BOTH the matched vendor key AND the raw
     * show-version output that triggered the match — so the caller can parse
     * it for hardware model without paying for a second SSH round-trip.
     */
    private async _detectVendorWithOutput (creds: SshCredentials, timeoutMs: number): Promise<{ vendor: string; output: string }> {
        const v = await this._detectVendorImpl(creds, timeoutMs)
        return v
    }

    private async _detectVendor (creds: SshCredentials, timeoutMs: number): Promise<string> {
        const r = await this._detectVendorImpl(creds, timeoutMs)
        return r.vendor
    }

    private async _detectVendorImpl (creds: SshCredentials, timeoutMs: number): Promise<{ vendor: string; output: string }> {
        // Try common version commands until one returns useful output.
        // Includes Unix-shell wrappers because some physical devices (Juniper
        // QFX / MX with root SSH, Arista cEOS, SR Linux) drop into bash on
        // login — bare `show version` fails with "command not found" and only
        // the wrapped form works.
        const probeCommands = [
            'show version',                        // Cisco, Arista EOS CLI, Junos CLI
            'cli -c "show version"',               // Juniper from bash shell (root SSH, cRPD)
            'FastCli -p 15 -c "show version"',     // Arista cEOS from bash shell
            'sr_cli "show version"',               // Nokia SR Linux from bash
            'display version',                     // Huawei VRP
            '/system resource print',              // MikroTik RouterOS
            'get system status',                   // Fortinet FortiGate
            'show system info',                    // Palo Alto PAN-OS
        ]
        const attempts: Array<{ host: string; cmd: string; ok: boolean; chars: number; preview: string; err?: string }> = []
        // Errors where the host itself is unreachable — no point trying the
        // remaining shell variants, they'll all fail identically. Short-circuit
        // and surface a single concise warning instead of 8 duplicate lines.
        // Patterns where the FIRST probe failure means the host is fundamentally
        // unreachable / unauth — no point trying 7 more shell-variant probes
        // each costing another ~10 s. Includes our hard client-side timeout
        // wrapper so a hung backend doesn't burn ~76 s per dead host.
        const fatalErrRe = /ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|Authentication failed|auth.*fail|Host key|Permission denied|client-side timeout|backend did not return/i
        for (const cmd of probeCommands) {
            try {
                const output = await this._runCommand(creds, cmd, timeoutMs)
                const trimmed = (output ?? '').trim()
                const preview = trimmed.slice(0, 400).replace(/\s+/g, ' ')
                attempts.push({ host: creds.host, cmd, ok: true, chars: trimmed.length, preview })
                if (trimmed.length) {
                    // Skip obvious Unix-shell errors — these come from probing
                    // a vendor-specific command in a bash-only shell context
                    // (e.g. `show version` on a Junos box where SSH drops to sh).
                    if (/command not found|no such file or directory|syntax error near unexpected/i.test(trimmed)) {
                        continue
                    }
                    const vendor = detectVendorFromOutput(output)
                    if (vendor) {
                        // When detection came from a shell-wrapped probe, the
                        // rest of the flow must use the matching wrapped-variant
                        // so LLDP / load-config also succeed. Return the
                        // explicit sub-type instead of the base vendor.
                        if (cmd.startsWith('cli -c') && vendor === 'juniper') {
                            this.lastProbeResult = attempts
                            return { vendor: 'juniper-crpd', output: output ?? '' }
                        }
                        if (cmd.startsWith('FastCli') && vendor === 'arista') {
                            this.lastProbeResult = attempts
                            return { vendor: 'arista-ceos', output: output ?? '' }
                        }
                        this.lastProbeResult = attempts
                        return { vendor, output: output ?? '' }
                    }
                }
            } catch (err) {
                const msg = (err as Error).message
                attempts.push({ host: creds.host, cmd, ok: false, chars: 0, preview: '', err: msg })
                // Host is unreachable / unauth — don't waste 7 more attempts.
                if (fatalErrRe.test(msg)) {
                    this.lastProbeResult = attempts
                    const kind = /ENOTFOUND/i.test(msg) ? 'DNS lookup failed'
                        : /EHOSTUNREACH|ENETUNREACH/i.test(msg) ? 'host unreachable'
                        : /ECONNREFUSED/i.test(msg) ? 'SSH refused'
                        : /client-side timeout|backend did not return/i.test(msg) ? 'connection hung (no response within deadline)'
                        : /ETIMEDOUT/i.test(msg) ? 'connection timed out'
                        : /Authentication|auth|Permission/i.test(msg) ? 'SSH auth failed'
                        : /Host key/i.test(msg) ? 'SSH host-key mismatch'
                        : 'connection failed'
                    console.warn(`[discovery] ${creds.host}: skipped after first probe — ${kind}`)
                    return { vendor: '', output: '' }
                }
            }
        }
        // Surface the probe outputs so users can see what the device actually said.
        this.lastProbeResult = attempts
        console.error(
            `[discovery] _detectVendor(${creds.host}) — no vendor matched. Probe results:`,
            attempts,
        )
        // Also print a flat one-line-per-probe log so users with filtered consoles still see it.
        for (const a of attempts) {
            console.error(
                `[discovery] PROBE ${a.host} "${a.cmd}" ok=${a.ok} chars=${a.chars} ` +
                `${a.err ? `err="${a.err}" ` : ''}preview=${JSON.stringify(a.preview)}`,
            )
        }
        return { vendor: '', output: '' }
    }

    /**
     * Execute a single SSH command via the Electron preload API.
     */
    private async _runCommand (creds: SshCredentials, command: string, timeoutMs: number): Promise<string> {
        // Build the underlying RPC promise. The backend is supposed to honour
        // `timeoutMs`, but we've seen ssh2-driven backends silently hang during
        // auth retries when the device throttles repeated bad-password attempts.
        // Wrap with a hard client-side deadline so a stuck SSH session can
        // never block the BFS / inventory wave indefinitely. We add a small
        // grace (1.5 s) so the backend has a chance to surface its own clean
        // error first.
        const inner = this._backendClient?.isConnected
            ? this._backendClient.pollDevice(creds.host, creds.port, creds.username, creds.password, [command])
                .then((result: any) => {
                    if (!result.ok) { throw new Error(result.message ?? 'SSH command failed') }
                    const entry = result.results?.[0]
                    return entry?.stdout ?? entry?.output ?? ''
                })
            : (() => {
                const api = (window as any).netopsAPI
                if (!api?.sshRunCommands) { return Promise.reject(new Error('SSH API not available')) }
                return api.sshRunCommands({
                    host: creds.host,
                    port: creds.port,
                    username: creds.username,
                    password: creds.password,
                    timeoutMs,
                    commands: [command],
                }).then((result: any) => {
                    if (!result.ok) { throw new Error(result.message ?? 'SSH command failed') }
                    const entry = result.results?.[0]
                    return entry?.stdout ?? entry?.output ?? ''
                })
            })()

        const hardDeadlineMs = timeoutMs + 1500
        let timer: ReturnType<typeof setTimeout> | null = null
        const guard = new Promise<string>((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`client-side timeout after ${hardDeadlineMs}ms (backend did not return — likely auth retry hang)`))
            }, hardDeadlineMs)
        })

        try {
            return await Promise.race([inner, guard])
        } finally {
            if (timer) { clearTimeout(timer) }
        }
    }
}
