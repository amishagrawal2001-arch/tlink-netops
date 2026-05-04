// ═════════════════════════════════════════════════════════════════════════════
// Vendor Staging Builder — translates a DeviceStagingConfig into vendor-
// specific Day-0 onboarding lines (NTP, SNMP, LLDP, syslog, DNS, AAA users,
// banner). Output is one big string of config lines, ready to be prepended
// to the per-node fabric config in _regenerateConfigs().
//
// Each section is optional: skipped when the corresponding field is undefined
// or the array is empty. Per-node overrides are merged on top of the
// topology-wide defaults BEFORE rendering — see mergeStaging().
// ═════════════════════════════════════════════════════════════════════════════

import { DeviceStagingConfig } from '../api/interfaces'

/** Shallow-deep merge: per-node overrides win over fabric-wide defaults. */
export function mergeStaging (
    fabric: DeviceStagingConfig | undefined,
    perNode: DeviceStagingConfig | undefined,
): DeviceStagingConfig {
    if (!fabric && !perNode) { return {} }
    if (!fabric) { return perNode! }
    if (!perNode) { return fabric }
    return {
        ntp:    { ...(fabric.ntp ?? {}),    ...(perNode.ntp ?? {}) },
        snmp:   { ...(fabric.snmp ?? {}),   ...(perNode.snmp ?? {}) },
        lldp:   { ...(fabric.lldp ?? {}),   ...(perNode.lldp ?? {}) },
        syslog: { ...(fabric.syslog ?? {}), ...(perNode.syslog ?? {}) },
        dns:    { ...(fabric.dns ?? {}),    ...(perNode.dns ?? {}) },
        aaa:    { ...(fabric.aaa ?? {}),    ...(perNode.aaa ?? {}) },
        banner: { ...(fabric.banner ?? {}), ...(perNode.banner ?? {}) },
    }
}

const isJunos    = (v: string): boolean => /^juniper/i.test(v)
const isCisco    = (v: string): boolean => /^cisco|^nxos|^iosxr/i.test(v)
const isArista   = (v: string): boolean => /^arista/i.test(v)
const isHpe      = (v: string): boolean => /^hpe/i.test(v)
const isDell     = (v: string): boolean => /^dell/i.test(v)
const isHuawei   = (v: string): boolean => /^huawei/i.test(v)
const isNokia    = (v: string): boolean => /^nokia/i.test(v)
const isSonic    = (v: string): boolean => /^sonic/i.test(v)
const isMikrotik = (v: string): boolean => /^mikrotik/i.test(v)
const isExtreme  = (v: string): boolean => /^extreme/i.test(v)

/**
 * Whether we have a staging renderer + push wrapper for this vendor.
 * Callers (push drivers, eligibility filters, UI) use this to skip with a
 * clear "unsupported vendor" message instead of silently emitting bad config.
 */
export function isSupportedStagingVendor (vendor: string): boolean {
    if (!vendor) { return false }
    return isJunos(vendor) || isCisco(vendor) || isArista(vendor) ||
           isHpe(vendor)   || isDell(vendor)  || isHuawei(vendor) ||
           isNokia(vendor) || isSonic(vendor) || isMikrotik(vendor) ||
           isExtreme(vendor)
}

/**
 * Render Day-0 staging config for a node.
 *
 * Returns "" when staging is empty/undefined OR when the vendor is not yet
 * supported. Callers should use `isSupportedStagingVendor()` first if they
 * want to surface "unsupported vendor" messaging — distinct from the
 * "no staging configured" case.
 */
export function renderStagingConfig (vendor: string, staging: DeviceStagingConfig): string {
    if (!staging || Object.keys(staging).length === 0) { return '' }
    if (isJunos(vendor))    { return renderJunos(staging) }
    if (isCisco(vendor) || isArista(vendor) || isDell(vendor) || isHpe(vendor)) {
        return renderIos(staging, { vendor })
    }
    if (isHuawei(vendor))   { return renderHuawei(staging) }
    if (isNokia(vendor))    { return renderNokia(staging) }
    if (isSonic(vendor))    { return renderSonic(staging) }
    if (isMikrotik(vendor)) { return renderMikrotik(staging) }
    if (isExtreme(vendor))  { return renderExtreme(staging) }
    // Unsupported vendor → render nothing, so the comment line never leaks
    // into a generated startup config or a SSH push.
    return ''
}

/**
 * Build the exact list of SSH-executable commands required to push the merged
 * staging block to a device. This is the canonical wrapping used by both:
 *   - the per-node "Push Staging" button on the node properties Staging tab
 *   - the fabric-wide "Push Day-0 Staging" Devices menu action
 *
 * `commitAfter=true` appends the vendor-appropriate save/commit step. For
 * Junos the commit is implicit in the wrapper, so commitAfter is a no-op
 * there. Returns [] when staging is empty (caller should skip the device).
 */
export function buildStagingPushCommands (
    vendor: string,
    staging: DeviceStagingConfig,
    opts: { commitAfter?: boolean } = {},
): string[] {
    const block = renderStagingConfig(vendor || '', staging)
    if (!block.trim()) { return [] }
    const lines = block.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
    const commitAfter = opts.commitAfter !== false   // default true

    if (isJunos(vendor)) {
        // configure private + each set line + commit and-quit (commit always implicit)
        const setLines = lines.map(l => l.startsWith('set ') ? l : `set ${l}`)
        return ['configure private', ...setLines, 'commit and-quit']
    }
    if (isCisco(vendor) || isArista(vendor) || isDell(vendor) || isHpe(vendor)) {
        // Cisco/Arista/Dell OS10 and HPE Comware all accept the same shape.
        // (HPE Comware uses `system-view`, but conf t works on most OS10/Aruba CX.
        //  Use `system-view` explicitly for HPE.)
        if (isHpe(vendor)) {
            const out = ['system-view', ...lines, 'quit']
            if (commitAfter) { out.push('save force') }
            return out
        }
        const out = ['configure terminal', ...lines, 'end']
        if (commitAfter) { out.push('write memory') }
        return out
    }
    if (isHuawei(vendor)) {
        const out = ['system-view', ...lines, 'quit']
        if (commitAfter) { out.push('save force') }
        return out
    }
    if (isNokia(vendor)) {
        // Classic CLI: enter candidate, body, commit
        return ['enter candidate', ...lines, 'commit']
    }
    if (isSonic(vendor)) {
        // SONiC lines are already `sudo config …` shell commands.
        const out = [...lines]
        if (commitAfter) { out.push('sudo config save -y') }
        return out
    }
    if (isExtreme(vendor)) {
        const out = [...lines]
        if (commitAfter) { out.push('save configuration') }
        return out
    }
    if (isMikrotik(vendor)) {
        return [...lines]
    }
    // Unsupported vendor → return [] so callers skip the device cleanly
    // (callers should pre-check isSupportedStagingVendor for a clear message).
    return []
}

// ─── Junos ───────────────────────────────────────────────────────────────────

function renderJunos (s: DeviceStagingConfig): string {
    const lines: string[] = []

    // NTP
    if (s.ntp?.servers?.length) {
        for (const srv of s.ntp.servers) {
            const pref = srv === s.ntp.prefer ? ' prefer' : ''
            lines.push(`set system ntp server ${srv}${pref}`)
        }
        if (s.ntp.sourceInterface) {
            lines.push(`set system ntp source-address ${s.ntp.sourceInterface}`)
        }
        if (s.ntp.timezone) {
            lines.push(`set system time-zone ${s.ntp.timezone}`)
        }
    }

    // SNMP
    if (s.snmp) {
        if (s.snmp.contact)  { lines.push(`set snmp contact "${escapeQuotes(s.snmp.contact)}"`) }
        if (s.snmp.location) { lines.push(`set snmp location "${escapeQuotes(s.snmp.location)}"`) }
        if (s.snmp.version === 'v2c' && s.snmp.community) {
            lines.push(`set snmp community ${s.snmp.community} authorization read-only`)
        }
        if (s.snmp.version === 'v3' && s.snmp.v3User) {
            lines.push(`set snmp v3 usm local-engine user ${s.snmp.v3User} authentication-${s.snmp.v3AuthProtocol ?? 'sha'} authentication-password "${s.snmp.v3AuthPassword ?? ''}"`)
            if (s.snmp.v3PrivPassword) {
                lines.push(`set snmp v3 usm local-engine user ${s.snmp.v3User} privacy-${s.snmp.v3PrivProtocol ?? 'aes'}-cfb128 privacy-password "${s.snmp.v3PrivPassword}"`)
            }
        }
        for (const t of (s.snmp.trapTargets ?? [])) {
            lines.push(`set snmp trap-group netops targets ${t}`)
        }
    }

    // LLDP
    if (s.lldp?.enabled !== false) {
        if (s.lldp?.interfaces === 'all' || !s.lldp?.interfaces) {
            lines.push('set protocols lldp interface all')
        } else {
            for (const i of s.lldp.interfaces) {
                lines.push(`set protocols lldp interface ${i}`)
            }
        }
    }

    // Syslog
    if (s.syslog?.servers?.length) {
        const sev = s.syslog.severity ?? 'info'
        for (const srv of s.syslog.servers) {
            lines.push(`set system syslog host ${srv} any ${sev}`)
        }
    }

    // DNS
    if (s.dns?.servers?.length) {
        for (const dns of s.dns.servers) {
            lines.push(`set system name-server ${dns}`)
        }
        if (s.dns.searchDomain) {
            lines.push(`set system domain-search ${s.dns.searchDomain}`)
        }
    }

    // AAA local users
    for (const u of (s.aaa?.localUsers ?? [])) {
        const cls = u.role === 'read-only' ? 'read-only' : u.role === 'operator' ? 'operator' : 'super-user'
        lines.push(`set system login user ${u.username} class ${cls}`)
        if (u.password) {
            lines.push(`set system login user ${u.username} authentication plain-text-password-value "${u.password}"`)
        }
    }
    for (const t of (s.aaa?.tacacs?.servers ?? [])) {
        lines.push(`set system tacplus-server ${t} secret "${s.aaa?.tacacs?.sharedSecret ?? ''}"`)
    }

    // Banner
    if (s.banner?.login) {
        lines.push(`set system login message "${escapeQuotes(s.banner.login)}"`)
    }
    if (s.banner?.exec) {
        lines.push(`set system login announcement "${escapeQuotes(s.banner.exec)}"`)
    }

    return lines.join('\n')
}

// ─── Cisco IOS / NX-OS / IOS-XR / Arista EOS / HPE / Dell ───────────────────

function renderIos (s: DeviceStagingConfig, opts: { vendor: string }): string {
    const lines: string[] = []
    const isXR = /iosxr/i.test(opts.vendor)

    // NTP
    if (s.ntp?.servers?.length) {
        for (const srv of s.ntp.servers) {
            const pref = srv === s.ntp.prefer ? ' prefer' : ''
            lines.push(`ntp server ${srv}${pref}`)
        }
        if (s.ntp.sourceInterface) {
            lines.push(`ntp source ${s.ntp.sourceInterface}`)
        }
        if (s.ntp.timezone) {
            lines.push(`clock timezone ${s.ntp.timezone}`)
        }
    }

    // SNMP
    if (s.snmp) {
        if (s.snmp.contact)  { lines.push(`snmp-server contact ${s.snmp.contact}`) }
        if (s.snmp.location) { lines.push(`snmp-server location ${s.snmp.location}`) }
        if (s.snmp.version === 'v2c' && s.snmp.community) {
            lines.push(`snmp-server community ${s.snmp.community} RO`)
        }
        if (s.snmp.version === 'v3' && s.snmp.v3User) {
            const auth = `auth ${s.snmp.v3AuthProtocol ?? 'sha'} ${s.snmp.v3AuthPassword ?? ''}`
            const priv = s.snmp.v3PrivPassword
                ? ` priv ${s.snmp.v3PrivProtocol ?? 'aes'} 128 ${s.snmp.v3PrivPassword}`
                : ''
            lines.push(`snmp-server user ${s.snmp.v3User} netops v3 ${auth}${priv}`)
        }
        for (const t of (s.snmp.trapTargets ?? [])) {
            const arg = s.snmp.community ? s.snmp.community : 'public'
            lines.push(`snmp-server host ${t} version 2c ${arg}`)
        }
    }

    // LLDP — global enable
    if (s.lldp?.enabled !== false) {
        lines.push(isXR ? 'lldp' : 'lldp run')
    }

    // Syslog
    if (s.syslog?.servers?.length) {
        const sev = s.syslog.severity ?? 'informational'
        for (const srv of s.syslog.servers) {
            lines.push(`logging host ${srv}`)
        }
        lines.push(`logging trap ${sev}`)
    }

    // DNS
    if (s.dns?.servers?.length) {
        for (const dns of s.dns.servers) {
            lines.push(`ip name-server ${dns}`)
        }
        if (s.dns.searchDomain) {
            lines.push(`ip domain name ${s.dns.searchDomain}`)
        }
    }

    // AAA
    for (const u of (s.aaa?.localUsers ?? [])) {
        const priv = u.role === 'read-only' ? 1 : u.role === 'operator' ? 7 : 15
        if (u.password) {
            lines.push(`username ${u.username} privilege ${priv} secret ${u.password}`)
        } else {
            lines.push(`username ${u.username} privilege ${priv}`)
        }
    }
    if (s.aaa?.tacacs?.servers?.length) {
        for (const t of s.aaa.tacacs.servers) {
            lines.push(`tacacs-server host ${t} key ${s.aaa.tacacs.sharedSecret ?? ''}`)
        }
        lines.push('aaa new-model')
        lines.push('aaa authentication login default group tacacs+ local')
    }

    // Banner
    if (s.banner?.login) {
        // Cisco-style banner with delimiter
        lines.push(`banner login ^C\n${s.banner.login}\n^C`)
    }
    if (s.banner?.exec) {
        lines.push(`banner exec ^C\n${s.banner.exec}\n^C`)
    }

    return lines.join('\n')
}

// ─── Huawei VRP ──────────────────────────────────────────────────────────────

function renderHuawei (s: DeviceStagingConfig): string {
    const lines: string[] = []

    if (s.ntp?.servers?.length) {
        for (const srv of s.ntp.servers) { lines.push(`ntp-service unicast-server ${srv}`) }
        if (s.ntp.timezone) { lines.push(`clock timezone ${s.ntp.timezone}`) }
    }
    if (s.snmp?.community) {
        lines.push(`snmp-agent community read ${s.snmp.community}`)
    }
    if (s.snmp?.contact)  { lines.push(`snmp-agent sys-info contact ${s.snmp.contact}`) }
    if (s.snmp?.location) { lines.push(`snmp-agent sys-info location ${s.snmp.location}`) }
    for (const t of (s.snmp?.trapTargets ?? [])) {
        lines.push(`snmp-agent target-host trap address udp-domain ${t} params securityname netops`)
    }
    if (s.lldp?.enabled !== false) { lines.push('lldp enable') }
    for (const srv of (s.syslog?.servers ?? [])) {
        lines.push(`info-center loghost ${srv}`)
    }
    for (const dns of (s.dns?.servers ?? [])) { lines.push(`dns server ${dns}`) }
    if (s.dns?.searchDomain) { lines.push(`dns domain ${s.dns.searchDomain}`) }
    for (const u of (s.aaa?.localUsers ?? [])) {
        if (u.password) {
            lines.push(`local-user ${u.username} password irreversible-cipher ${u.password}`)
            lines.push(`local-user ${u.username} privilege level ${u.role === 'read-only' ? 1 : 15}`)
        }
    }
    if (s.banner?.login) {
        lines.push(`header login information "${escapeQuotes(s.banner.login)}"`)
    }
    return lines.join('\n')
}

// ─── Nokia SR OS classic ────────────────────────────────────────────────────

function renderNokia (s: DeviceStagingConfig): string {
    const lines: string[] = []
    // SR OS uses `configure system …` blocks
    if (s.ntp?.servers?.length) {
        for (const srv of s.ntp.servers) { lines.push(`configure system time ntp server ${srv} prefer`) }
        if (s.ntp.timezone) { lines.push(`configure system time zone ${s.ntp.timezone}`) }
    }
    if (s.snmp?.community) {
        lines.push(`configure system snmp community "${s.snmp.community}" rwa version v2c`)
    }
    if (s.snmp?.contact)  { lines.push(`configure system contact "${s.snmp.contact}"`) }
    if (s.snmp?.location) { lines.push(`configure system location "${s.snmp.location}"`) }
    if (s.lldp?.enabled !== false) {
        lines.push('configure system lldp admin-state enable')
    }
    for (const srv of (s.syslog?.servers ?? [])) {
        lines.push(`configure log syslog 1 address ${srv}`)
    }
    for (const u of (s.aaa?.localUsers ?? [])) {
        const access = u.role === 'read-only' ? 'console' : 'console netconf'
        lines.push(`configure system security user "${u.username}" access ${access}`)
        if (u.password) {
            lines.push(`configure system security user "${u.username}" password ${u.password}`)
        }
    }
    return lines.join('\n')
}

// ─── SONiC ───────────────────────────────────────────────────────────────────

function renderSonic (s: DeviceStagingConfig): string {
    // SONiC doesn't have a single config language — staging is done through
    // a mix of `config` CLI commands, /etc files, and (for some items) FRR's
    // vtysh. We emit a sequence of `sudo …` commands.
    const lines: string[] = []

    for (const srv of (s.ntp?.servers ?? [])) {
        lines.push(`sudo config ntp add ${srv}`)
    }
    if (s.snmp?.community) {
        lines.push(`sudo config snmp community add ${s.snmp.community} ro`)
    }
    if (s.snmp?.location) {
        lines.push(`sudo config snmp location modify "${s.snmp.location}"`)
    }
    if (s.snmp?.contact) {
        lines.push(`sudo config snmp contact modify "${s.snmp.contact}"`)
    }
    // SONiC LLDP is on by default and configured via `config feature state lldp`
    if (s.lldp?.enabled !== false) {
        lines.push('sudo config feature state lldp enabled')
    }
    for (const srv of (s.syslog?.servers ?? [])) {
        lines.push(`sudo config syslog add ${srv}`)
    }
    for (const dns of (s.dns?.servers ?? [])) {
        // SONiC's DNS goes through /etc/resolv.conf — surface the recipe
        lines.push(`# Manually: echo "nameserver ${dns}" | sudo tee -a /etc/resolv.conf`)
    }
    for (const u of (s.aaa?.localUsers ?? [])) {
        // Use Linux useradd; password-set requires interactive or chpasswd
        const sudo = u.role === 'admin' || u.role == null ? ' -G sudo,admin,docker' : ''
        lines.push(`sudo useradd -m${sudo} ${u.username}`)
        if (u.password) {
            lines.push(`echo "${u.username}:${u.password}" | sudo chpasswd`)
        }
    }
    return lines.join('\n')
}

// ─── MikroTik RouterOS ───────────────────────────────────────────────────────

function renderMikrotik (s: DeviceStagingConfig): string {
    const lines: string[] = []
    if (s.ntp?.servers?.length) {
        const [primary, ...rest] = s.ntp.servers
        lines.push(`/system ntp client set enabled=yes primary-ntp=${primary}` +
            (rest[0] ? ` secondary-ntp=${rest[0]}` : ''))
    }
    if (s.ntp?.timezone) {
        lines.push(`/system clock set time-zone-name=${s.ntp.timezone}`)
    }
    if (s.snmp?.community) {
        lines.push('/snmp set enabled=yes')
        lines.push(`/snmp community set [find default=yes] name=${s.snmp.community} read-access=yes`)
    }
    if (s.snmp?.contact)  { lines.push(`/snmp set contact="${s.snmp.contact}"`) }
    if (s.snmp?.location) { lines.push(`/snmp set location="${s.snmp.location}"`) }
    // LLDP on RouterOS: /lldp settings (newer) or /interface bridge add lldp-mode
    // We assume newer (>= v7) — emit both for compatibility
    if (s.lldp?.enabled !== false) {
        lines.push('/ip neighbor discovery-settings set discover-interface-list=all protocol=lldp')
    }
    for (const srv of (s.syslog?.servers ?? [])) {
        lines.push(`/system logging action add name=netops-syslog target=remote remote=${srv}`)
        lines.push('/system logging add action=netops-syslog topics=info')
    }
    for (const dns of (s.dns?.servers ?? [])) {
        lines.push(`/ip dns set servers=${dns}`)
    }
    for (const u of (s.aaa?.localUsers ?? [])) {
        const group = u.role === 'read-only' ? 'read' : 'full'
        if (u.password) {
            lines.push(`/user add name=${u.username} group=${group} password="${u.password}"`)
        }
    }
    return lines.join('\n')
}

// ─── Extreme XOS ─────────────────────────────────────────────────────────────

function renderExtreme (s: DeviceStagingConfig): string {
    const lines: string[] = []
    for (const srv of (s.ntp?.servers ?? [])) {
        lines.push(`configure ntp server add ${srv}`)
    }
    if (s.ntp?.timezone) { lines.push(`configure timezone name-${s.ntp.timezone}`) }
    if (s.snmp?.community) {
        lines.push(`configure snmp add community readonly ${s.snmp.community}`)
    }
    if (s.snmp?.location) { lines.push(`configure snmp sysLocation "${s.snmp.location}"`) }
    if (s.snmp?.contact)  { lines.push(`configure snmp sysContact "${s.snmp.contact}"`) }
    if (s.lldp?.enabled !== false) {
        lines.push('enable lldp ports all')
    }
    for (const srv of (s.syslog?.servers ?? [])) {
        lines.push(`configure syslog add ${srv} local0`)
        lines.push(`enable syslog`)
    }
    for (const u of (s.aaa?.localUsers ?? [])) {
        const access = u.role === 'admin' || u.role == null ? 'admin' : 'user'
        lines.push(`create account ${access} ${u.username} ${u.password ?? ''}`)
    }
    return lines.join('\n')
}

function escapeQuotes (s: string): string { return s.replace(/"/g, '\\"') }
