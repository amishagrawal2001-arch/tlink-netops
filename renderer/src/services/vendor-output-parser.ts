// ═══════════════════════════════════════════════════════════════════════════════
// Vendor Output Parser — parse SSH command output per vendor
// ═══════════════════════════════════════════════════════════════════════════════

export interface ParsedVersion {
    osVersion?: string
    firmwareVersion?: string
    hardwareModel?: string
    hardwareRevision?: string
    uptime?: string
}

export interface ParsedResourceUsage {
    cpuPercent?: number         // 0–100
    memoryUsedPercent?: number  // 0–100
    memoryUsedMb?: number
    memoryTotalMb?: number
}

export interface ParsedInterfaceStatus {
    name: string
    status: 'up' | 'down' | 'admin-down' | 'unknown'
    speed?: string
    description?: string
}

export interface ParsedAlarmEntry {
    severity: 'critical' | 'major' | 'minor' | 'warning'
    message: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function firstMatch (text: string, pattern: RegExp): string | undefined {
    const m = pattern.exec(text)
    return m?.[1]?.trim()
}

function parseNumber (s: string | undefined): number | undefined {
    if (!s) { return undefined }
    const n = Number(s.replace(/,/g, ''))
    return Number.isFinite(n) ? n : undefined
}

// ─── Version Parsing ─────────────────────────────────────────────────────────

function parseCiscoVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /(?:Cisco IOS.*Version|Software.*Version)\s+(\S+)/i)
            ?? firstMatch(output, /Version\s+(\S+)/i),
        hardwareModel: firstMatch(output, /^cisco\s+(\S+)/m)
            ?? firstMatch(output, /[Hh]ardware:\s*(\S+)/),
        hardwareRevision: firstMatch(output, /[Bb]oard\s+[Rr]evision\s+(\S+)/),
        uptime: firstMatch(output, /uptime\s+is\s+(.+)/i),
    }
}

function parseJuniperVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /Junos:\s*(\S+)/i)
            ?? firstMatch(output, /JUNOS\s+.*\[(.*?)\]/i),
        hardwareModel: firstMatch(output, /Model:\s*(\S+)/i),
        hardwareRevision: firstMatch(output, /[Rr]ev\s*\.?\s*(\S+)/),
        uptime: firstMatch(output, /System booted:\s*(.+)/i),
    }
}

function parseAristaVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /Software image version:\s*(\S+)/i)
            ?? firstMatch(output, /EOS version:\s*(\S+)/i),
        hardwareModel: firstMatch(output, /(?:Arista|Hardware version:)\s*(\S+)/i),
        hardwareRevision: firstMatch(output, /Hardware version:\s*(\S+)/i),
        uptime: firstMatch(output, /Uptime:\s*(.+)/i),
    }
}

function parseNokiaVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /TiMOS-\S+\s+(\S+)/i)
            ?? firstMatch(output, /[Ss]oftware\s+[Vv]ersion\s*:\s*(\S+)/),
        hardwareModel: firstMatch(output, /[Cc]hassis\s+[Tt]ype\s*:\s*(.+)/),
        uptime: firstMatch(output, /[Ss]ystem\s+[Uu]p\s+[Tt]ime\s*:\s*(.+)/),
    }
}

function parseHuaweiVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /VRP\s+.*?Version\s+(\S+)/i)
            ?? firstMatch(output, /software.*Version\s+(\S+)/i),
        hardwareModel: firstMatch(output, /^HUAWEI\s+(\S+)/m)
            ?? firstMatch(output, /(?:Quidway)\s+(\S+)/i),
        uptime: firstMatch(output, /[Uu]ptime\s+is\s+(.+)/),
    }
}

function parseMikrotikVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /version:\s*(\S+)/i),
        hardwareModel: firstMatch(output, /board-name:\s*(\S+)/i)
            ?? firstMatch(output, /platform:\s*(\S+)/i),
        uptime: firstMatch(output, /uptime:\s*(.+)/i),
    }
}

function parseExtremeVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /(?:ExtremeXOS|EXOS)\s+version\s+(\S+)/i)
            ?? firstMatch(output, /Image\s*:\s*(\S+)/i),
        hardwareModel: firstMatch(output, /System Type:\s*(.+)/i)
            ?? firstMatch(output, /Switch\s*:\s*(.+)/i),
        uptime: firstMatch(output, /System UpTime:\s*(.+)/i),
    }
}

function parseSonicVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /SONiC Software Version:\s*(\S+)/i)
            ?? firstMatch(output, /Software Version:\s*(\S+)/i),
        hardwareModel: firstMatch(output, /HwSKU:\s*(\S+)/i)
            ?? firstMatch(output, /Platform:\s*(\S+)/i),
        uptime: firstMatch(output, /[Uu]ptime:\s*\S+\s+up\s+(.+)/),
    }
}

function parseDellVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /OS Version:\s*(\S+)/i)
            ?? firstMatch(output, /Software Version:\s*(\S+)/i)
            ?? firstMatch(output, /Version\s+(\S+)/i),
        hardwareModel: firstMatch(output, /System Type:\s*(\S+)/i)
            ?? firstMatch(output, /Platform:\s*(\S+)/i),
        uptime: firstMatch(output, /Up Time:\s*(.+)/i)
            ?? firstMatch(output, /[Uu]ptime\s+is\s+(.+)/),
    }
}

function parseHpeVersion (output: string): ParsedVersion {
    // Covers HPE Comware (display version) and ProVision/ArubaOS (show version)
    return {
        osVersion: firstMatch(output, /Comware.*Version\s+(\S+)/i)
            ?? firstMatch(output, /Software revision\s*:\s*(\S+)/i)
            ?? firstMatch(output, /Version\s+(\S+)/i),
        hardwareModel: firstMatch(output, /HPE\s+(?:Aruba\s+)?(\S+(?:\s\S+)*\s+Switch)/i)
            ?? firstMatch(output, /HPE\s+FF\s+(\S+)/i)
            ?? firstMatch(output, /System Type:\s*(.+)/i),
        uptime: firstMatch(output, /[Uu]ptime\s+is\s+(.+)/),
    }
}

function parseGenericVersion (output: string): ParsedVersion {
    return {
        osVersion: firstMatch(output, /[Vv]ersion\s+(\S+)/),
        hardwareModel: firstMatch(output, /[Mm]odel\s*:?\s*(\S+)/)
            ?? firstMatch(output, /System Type:\s*(\S+)/i)
            ?? firstMatch(output, /Platform:\s*(\S+)/i),
        uptime: firstMatch(output, /[Uu]ptime\s+(?:is\s+)?(.+)/),
    }
}

/**
 * Attempt to detect the vendor from raw command output.
 * Looks for vendor-specific keywords/signatures. Returns the vendor key
 * or empty string if unable to detect.
 */
export function detectVendorFromOutput (output: string): string {
    if (!output) { return '' }
    const t = output.toLowerCase()
    if (/cisco ios|ios-xe|nx-os|cisco nexus|cisco catalyst/i.test(output)) { return 'cisco' }
    if (/junos|juniper|jnpr|junos:/i.test(output)) { return 'juniper' }
    if (/arista|eos version|veos|ceos/i.test(output)) { return 'arista' }
    if (/timos|nokia|alcatel-lucent.*sros/i.test(output)) { return 'nokia' }
    if (/sonic software|sonic-os|hwsku/i.test(output)) { return 'sonic' }
    if (/huawei|vrp.*version|quidway/i.test(output)) { return 'huawei' }
    if (/hpe|comware|aruba.*switch|procurve/i.test(output)) { return 'hpe' }
    if (/dell.*os|dell emc|os10|ftos/i.test(output)) { return 'dell' }
    if (/mikrotik|routeros|board-name/i.test(output)) { return 'mikrotik' }
    if (/extremexos|exos|extreme networks/i.test(output)) { return 'extreme' }
    // Hostname-based hints (very loose — only if nothing else matched)
    if (t.includes('qfx') || t.includes('mx-') || t.includes('srx')) { return 'juniper' }
    return ''
}

export function parseShowVersion (vendor: string, output: string): ParsedVersion {
    const v = (vendor ?? '').trim().toLowerCase()
    switch (v) {
        case 'cisco': return parseCiscoVersion(output)
        case 'juniper': return parseJuniperVersion(output)
        case 'arista': return parseAristaVersion(output)
        case 'nokia': return parseNokiaVersion(output)
        case 'huawei': return parseHuaweiVersion(output)
        case 'mikrotik': return parseMikrotikVersion(output)
        case 'extreme': return parseExtremeVersion(output)
        case 'sonic': return parseSonicVersion(output)
        case 'dell': return parseDellVersion(output)
        case 'hpe': return parseHpeVersion(output)
        default: return parseGenericVersion(output)
    }
}

// ─── Resource Usage Parsing ──────────────────────────────────────────────────

function parseCiscoResources (cpuOutput: string, memOutput: string): ParsedResourceUsage {
    const cpuPercent = parseNumber(firstMatch(cpuOutput, /CPU utilization.*?(\d+)%/i))
        ?? parseNumber(firstMatch(cpuOutput, /five seconds:\s*(\d+)%/i))
    const totalMem = parseNumber(firstMatch(memOutput, /[Tt]otal.*?(\d[\d,]*)\s/))
    const usedMem = parseNumber(firstMatch(memOutput, /[Uu]sed.*?(\d[\d,]*)\s/))
    const totalMb = totalMem ? Math.round(totalMem / 1024 / 1024) : undefined
    const usedMb = usedMem ? Math.round(usedMem / 1024 / 1024) : undefined
    return {
        cpuPercent,
        memoryTotalMb: totalMb,
        memoryUsedMb: usedMb,
        memoryUsedPercent: (totalMb && usedMb) ? Math.round(usedMb / totalMb * 100) : undefined,
    }
}

function parseJuniperResources (reOutput: string, _memOutput: string): ParsedResourceUsage {
    const cpuPercent = parseNumber(firstMatch(reOutput, /CPU utilization\s+(\d+)\s*percent/i))
    const totalMem = parseNumber(firstMatch(reOutput, /Memory\s+utilization\s+(\d+)\s*percent/i))
    return {
        cpuPercent,
        memoryUsedPercent: totalMem,
    }
}

function parseHuaweiResources (cpuOutput: string, memOutput: string): ParsedResourceUsage {
    const cpuPercent = parseNumber(firstMatch(cpuOutput, /CPU [Uu]sage\s*:\s*(\d+)%/))
    const memPercent = parseNumber(firstMatch(memOutput, /[Mm]emory [Uu]sage\s*:\s*(\d+)%/))
    return {
        cpuPercent,
        memoryUsedPercent: memPercent,
    }
}

function parseMikrotikResources (output: string): ParsedResourceUsage {
    const cpuPercent = parseNumber(firstMatch(output, /cpu-load:\s*(\d+)/i))
    const totalMem = parseNumber(firstMatch(output, /total-memory:\s*([\d,]+)/i))
    const freeMem = parseNumber(firstMatch(output, /free-memory:\s*([\d,]+)/i))
    const totalMb = totalMem ? Math.round(totalMem / 1024 / 1024) : undefined
    const freeMb = freeMem ? Math.round(freeMem / 1024 / 1024) : undefined
    const usedMb = (totalMb && freeMb) ? totalMb - freeMb : undefined
    return {
        cpuPercent,
        memoryTotalMb: totalMb,
        memoryUsedMb: usedMb,
        memoryUsedPercent: (totalMb && usedMb) ? Math.round(usedMb / totalMb * 100) : undefined,
    }
}

function parseGenericResources (cpuOutput: string, memOutput: string): ParsedResourceUsage {
    const cpuPercent = parseNumber(firstMatch(cpuOutput, /(\d+)\s*%/))
    const memPercent = parseNumber(firstMatch(memOutput, /(\d+)\s*%/))
    return {
        cpuPercent,
        memoryUsedPercent: memPercent,
    }
}

function parseSonicResources (cpuOutput: string, memOutput: string): ParsedResourceUsage {
    const cpuPercent = parseNumber(firstMatch(cpuOutput, /(\d+)\s*%/))
    // SONiC `free -m` output:  Mem: total used free shared ...
    const totalMb = parseNumber(firstMatch(memOutput, /Mem:\s+(\d+)/))
    const usedMb = parseNumber(firstMatch(memOutput, /Mem:\s+\d+\s+(\d+)/))
    return {
        cpuPercent,
        memoryTotalMb: totalMb,
        memoryUsedMb: usedMb,
        memoryUsedPercent: (totalMb && usedMb) ? Math.round(usedMb / totalMb * 100) : undefined,
    }
}

function parseNokiaResources (cpuOutput: string, memOutput: string): ParsedResourceUsage {
    // Nokia SR OS: "show system cpu" output may include:
    //   CPU Utilization (Sample period - xx seconds):
    //     Busiest Core Utilization :   xx%
    // "show system memory" may include:
    //   Total Memory  : xxxxMB   Used Memory : xxxxMB
    const cpuPercent = parseNumber(firstMatch(cpuOutput, /[Uu]tilization\s*:?\s*(\d+)\s*%/))
        ?? parseNumber(firstMatch(cpuOutput, /(\d+)\s*%/))
    const totalMb = parseNumber(firstMatch(memOutput, /[Tt]otal\s*[Mm]emory\s*:?\s*(\d+)/))
    const usedMb = parseNumber(firstMatch(memOutput, /[Uu]sed\s*[Mm]emory\s*:?\s*(\d+)/))
    return {
        cpuPercent,
        memoryTotalMb: totalMb,
        memoryUsedMb: usedMb,
        memoryUsedPercent: (totalMb && usedMb) ? Math.round(usedMb / totalMb * 100) : undefined,
    }
}

function parseExtremeResources (cpuOutput: string, memOutput: string): ParsedResourceUsage {
    // Extreme EXOS: "show cpu-monitoring" may include:
    //   CPU Monitoring Results:   xx.x %
    //   or:  Total CPU Utilization:  xx%
    // "show memory" may include:
    //   System Memory Information
    //   Total DRAM (KB):   xxxxx
    //   Free  (KB):  xxxxx
    const cpuPercent = parseNumber(firstMatch(cpuOutput, /(\d+(?:\.\d+)?)\s*%/))
    const totalKb = parseNumber(firstMatch(memOutput, /[Tt]otal\s+\S*\s*\(KB\)\s*:?\s*(\d+)/))
    const freeKb = parseNumber(firstMatch(memOutput, /[Ff]ree\s*\(KB\)\s*:?\s*(\d+)/))
    const totalMb = totalKb ? Math.round(totalKb / 1024) : undefined
    const freeMb = freeKb ? Math.round(freeKb / 1024) : undefined
    const usedMb = (totalMb && freeMb) ? totalMb - freeMb : undefined
    return {
        cpuPercent,
        memoryTotalMb: totalMb,
        memoryUsedMb: usedMb,
        memoryUsedPercent: (totalMb && usedMb) ? Math.round(usedMb / totalMb * 100)
            : parseNumber(firstMatch(memOutput, /(\d+)\s*%/)),
    }
}

export function parseResourceUsage (vendor: string, cpuOutput: string, memOutput: string): ParsedResourceUsage {
    const v = (vendor ?? '').trim().toLowerCase()
    switch (v) {
        case 'cisco': case 'dell': case 'hpe': case 'arista':
            return parseCiscoResources(cpuOutput, memOutput)
        case 'juniper':
            return parseJuniperResources(cpuOutput, memOutput)
        case 'huawei':
            return parseHuaweiResources(cpuOutput, memOutput)
        case 'mikrotik':
            return parseMikrotikResources(cpuOutput)
        case 'sonic':
            return parseSonicResources(cpuOutput, memOutput)
        case 'nokia':
            return parseNokiaResources(cpuOutput, memOutput)
        case 'extreme':
            return parseExtremeResources(cpuOutput, memOutput)
        default:
            return parseGenericResources(cpuOutput, memOutput)
    }
}

// ─── Interface Status Parsing ────────────────────────────────────────────────

function parseCiscoInterfaces (output: string): ParsedInterfaceStatus[] {
    const results: ParsedInterfaceStatus[] = []
    // Skip virtual / internal interfaces that are normally down on a healthy device.
    // Only keep physical & port-channel interfaces that map to real topology ports.
    const CISCO_INTERNAL_RE = /^(Loopback|Lo\d|Null|Vlan|BVI|nve|Tunnel|Embedded|Voice|Async|Virtual|Cellular|Dialer|CT\d)/i
    const lines = output.split('\n')
    for (const line of lines) {
        // Full format: GigabitEthernet0/0   10.0.0.1  YES  manual  up    up
        const m = line.match(/^(\S+)\s+[\d.]+\s+\S+\s+\S+\s+(up|down|administratively\s+down)\s+(up|down)/i)
        if (m) {
            if (CISCO_INTERNAL_RE.test(m[1])) { continue }
            results.push({
                name: m[1],
                status: m[2].toLowerCase().includes('admin') ? 'admin-down'
                    : m[3].toLowerCase() === 'up' ? 'up' : 'down',
            })
            continue
        }
        // Simpler format: Interface  Status  Protocol
        const m2 = line.match(/^(\S+)\s+(up|down|admin\S*)\s+(up|down)/i)
        if (m2) {
            if (CISCO_INTERNAL_RE.test(m2[1])) { continue }
            results.push({
                name: m2[1],
                status: m2[2].toLowerCase().includes('admin') ? 'admin-down'
                    : m2[3].toLowerCase() === 'up' ? 'up' : 'down',
            })
        }
    }
    return results
}

function parseJuniperInterfaces (output: string): ParsedInterfaceStatus[] {
    const results: ParsedInterfaceStatus[] = []
    const seen = new Set<string>()
    // Juniper 'show interfaces terse' output:
    //   ge-0/0/0                up    up
    //   ge-0/0/0.0              up    up   inet     10.0.0.1/30
    //   dsc                     up    down
    //
    // We skip logical sub-interfaces (names containing '.') since they duplicate
    // the physical interface status.  We also skip well-known internal/pseudo
    // interfaces (dsc, gre, ipip, lsi, mtun, pimd, pime, tap, vtep, …) that are
    // normally down on a healthy device and would cause false alarms.
    const INTERNAL_RE = /^(bme|cbp|demux|dsc|em\d|esi|fti|gre|ipip|irb|jsrv|lc-|lo\d*|lsi|mt-|mtun|pfh|pimd|pime|pip|pp\d|ppd|ppe|rbeb|sp-|st\d|tap|vcp|vtep)\b/i
    const lines = output.split('\n')
    for (const line of lines) {
        const m = line.match(/^(\S+)\s+(up|down)\s+(up|down)/i)
        if (!m) { continue }
        const name = m[1]
        // Skip sub-interfaces (e.g. ge-0/0/0.0, et-0/0/1.16385)
        if (name.includes('.')) { continue }
        // Skip internal pseudo-interfaces
        if (INTERNAL_RE.test(name)) { continue }
        // Skip duplicates (same physical interface appearing multiple times)
        const key = name.toLowerCase()
        if (seen.has(key)) { continue }
        seen.add(key)
        const admin = m[2].toLowerCase()
        const link  = m[3].toLowerCase()
        results.push({
            name,
            status: admin === 'down' ? 'admin-down'
                  : link  === 'up'   ? 'up'
                  : 'down',
        })
    }
    return results
}

function parseGenericInterfaces (output: string): ParsedInterfaceStatus[] {
    // Generic fallback parser — filters out common virtual/internal interface names
    // to reduce false-positive "interface down" alarms.
    const GENERIC_INTERNAL_RE = /^(Loopback|Lo\d|Null|NULL|Vlan|Vlanif|Tunnel|loopback|system|bridge|Management|mgmt)/i
    const results: ParsedInterfaceStatus[] = []
    const lines = output.split('\n')
    for (const line of lines) {
        const m = line.match(/^(\S+)\s+.*(up|down|disabled)/i)
        if (m) {
            if (GENERIC_INTERNAL_RE.test(m[1])) { continue }
            // Skip sub-interfaces (e.g. ge-0/0/0.0)
            if (m[1].includes('.') && /\.\d+$/.test(m[1])) { continue }
            const raw = m[2].toLowerCase()
            results.push({
                name: m[1],
                status: raw === 'up' ? 'up' : raw === 'disabled' ? 'admin-down' : 'down',
            })
        }
    }
    return results
}

function parseAristaInterfaces (output: string): ParsedInterfaceStatus[] {
    // Arista 'show interfaces status':
    //  Port  Name  Status  Vlan  Duplex  Speed  Type
    //  Et1         connected  1  full  1000  1000BASE-T
    //  Et2         notconnect  1  auto  auto
    //  Ma1         connected  routed  a-full  a-1G  10/100/1000
    //
    // Skip Management, Loopback, Vlan, Tunnel, Peer-Ethernet (MLAG) interfaces
    // that are normally present but don't map to physical topology ports.
    const ARISTA_INTERNAL_RE = /^(Ma\d|Management|Lo\d|Loopback|Vl\d|Vlan|Vx\d|Vxlan|Tu\d|Tunnel|Peer-Ethernet)/i
    const results: ParsedInterfaceStatus[] = []
    for (const line of output.split('\n')) {
        const m = line.match(/^(\S+)\s+.*?(connected|notconnect|disabled|errdisabled|linkdown)/i)
        if (m) {
            if (ARISTA_INTERNAL_RE.test(m[1])) { continue }
            const raw = m[2].toLowerCase()
            results.push({
                name: m[1],
                status: raw === 'connected' ? 'up'
                    : raw === 'disabled' || raw === 'errdisabled' ? 'admin-down'
                    : 'down',
            })
        }
    }
    return results.length > 0 ? results : parseCiscoInterfaces(output)
}

function parseSonicInterfaces (output: string): ParsedInterfaceStatus[] {
    // SONiC 'show interfaces status':
    //  Interface  Lanes  Speed  MTU  FEC  Alias  Vlan  Oper  Admin  Type
    //  Ethernet0  25,26  25G    9100  N/A  etp1  routed  up  up  QSFP28
    const results: ParsedInterfaceStatus[] = []
    for (const line of output.split('\n')) {
        const m = line.match(/^(Ethernet\d+|PortChannel\d+)\s+.*?\s+(up|down)\s+(up|down)/i)
        if (m) {
            const admin = m[3].toLowerCase()
            const oper = m[2].toLowerCase()
            results.push({
                name: m[1],
                status: admin === 'down' ? 'admin-down' : oper === 'up' ? 'up' : 'down',
            })
        }
    }
    return results.length > 0 ? results : parseGenericInterfaces(output)
}

function parseHuaweiInterfaces (output: string): ParsedInterfaceStatus[] {
    // Huawei 'display interface brief':
    //  Interface  PHY  Protocol  InUti  OutUti  inErrors  outErrors
    //  GE0/0/1    up   up        0.01%  0.01%   0         0
    //  NULL0      up   up(s)     --     --      0         0
    //  LoopBack0  up   up(s)     --     --      0         0
    //  Vlanif10   up   up        0.01%  0.01%   0         0
    //
    // Skip NULL0, LoopBack, Vlanif, Tunnel, MEth (management Ethernet), InLoop
    // that are virtual/internal and normally down → false alarms.
    const HUAWEI_INTERNAL_RE = /^(NULL|LoopBack|Vlanif|Tunnel|MEth|InLoop|Virtual|Nve)\d*/i
    const results: ParsedInterfaceStatus[] = []
    for (const line of output.split('\n')) {
        const m = line.match(/^(\S+)\s+(up|down|\*down)\s+(up|down)/i)
        if (m) {
            if (HUAWEI_INTERNAL_RE.test(m[1])) { continue }
            results.push({
                name: m[1],
                status: m[2].includes('*') ? 'admin-down'
                    : m[3].toLowerCase() === 'up' ? 'up' : 'down',
            })
        }
    }
    return results.length > 0 ? results : parseGenericInterfaces(output)
}

function parseNokiaInterfaces (output: string): ParsedInterfaceStatus[] {
    // Nokia SROS 'show interface brief' or 'show port':
    //  Port  Admin  Link  Oper  Speed  Duplex  Description
    //  1/1/1  up    up    up    1000   full    to-spine1
    //  1/1/2  up    down  down  ----   ----    to-spine2
    //
    // Skip system, loopback, management, and router-interface entries
    const NOKIA_INTERNAL_RE = /^(system|loopback|Router|management|lo\d)/i
    const results: ParsedInterfaceStatus[] = []
    for (const line of output.split('\n')) {
        // Format 1: port-id  admin-state  link-state  ...
        const m = line.match(/^(\S+)\s+(up|down|enabled|disabled)\s+(up|down)/i)
        if (m) {
            if (NOKIA_INTERNAL_RE.test(m[1])) { continue }
            const admin = m[2].toLowerCase()
            const link  = m[3].toLowerCase()
            results.push({
                name: m[1],
                status: (admin === 'down' || admin === 'disabled') ? 'admin-down'
                    : link === 'up' ? 'up' : 'down',
            })
        }
    }
    return results.length > 0 ? results : parseGenericInterfaces(output)
}

function parseMikroTikInterfaces (output: string): ParsedInterfaceStatus[] {
    // MikroTik '/interface print brief':
    //  Flags: D - dynamic, X - disabled, R - running, S - slave
    //   #  NAME                TYPE       MTU L2MTU  ACTUAL-MTU
    //   0 R ether1             ether     1500  1598        1500
    //   1 X ether2             ether     1500  1598        1500
    //   2 R sfp1               ether     1500  1598        1500
    //
    // 'R' = running (up), 'X' = disabled (admin-down), neither = down.
    // Skip bridge, vlan, loopback, ovpn, ppp, l2tp, eoip entries
    const MIKROTIK_INTERNAL_RE = /^(bridge|vlan|loopback|ovpn|ppp|l2tp|eoip|gre|ipip|6to4)/i
    const results: ParsedInterfaceStatus[] = []
    for (const line of output.split('\n')) {
        // Match: optional-number  flags  interface-name  type
        const m = line.match(/^\s*\d+\s+([DXRS ]{1,4})\s+(\S+)\s+\S+/i)
        if (m) {
            const flags = m[1]
            const name  = m[2]
            if (MIKROTIK_INTERNAL_RE.test(name)) { continue }
            results.push({
                name,
                status: flags.includes('X') ? 'admin-down'
                    : flags.includes('R') ? 'up' : 'down',
            })
        }
    }
    return results.length > 0 ? results : parseGenericInterfaces(output)
}

function parseExtremeInterfaces (output: string): ParsedInterfaceStatus[] {
    // Extreme EXOS 'show ports':
    //  Port  Type  Status  Speed  Duplex  Flags
    //  1     G     E       1G     F       aAbBE
    //  2     G     D       ---    ---     aAb
    //  3     G     R       1G     F       aAbBE
    //
    // Status: E = enabled/active (up), D = disabled (admin-down), R = ready but no link (down),
    //         L = link present
    // Skip Management, Vlan, and virtual ports
    const EXTREME_INTERNAL_RE = /^(Mgmt|mgmt|Vlan|vlan|VR-|black-hole)/i
    const results: ParsedInterfaceStatus[] = []
    for (const line of output.split('\n')) {
        // Format: port  type  status  …
        const m = line.match(/^\s*(\S+)\s+\S+\s+([EDRL])\s/i)
        if (m) {
            if (EXTREME_INTERNAL_RE.test(m[1])) { continue }
            const st = m[2].toUpperCase()
            results.push({
                name: m[1],
                status: st === 'D' ? 'admin-down'
                    : (st === 'E' || st === 'L') ? 'up' : 'down',
            })
            continue
        }
        // Alternative verbose format: Port  Admin  Link
        const m2 = line.match(/^\s*(\S+)\s+(enabled|disabled)\s+(active|ready|down)/i)
        if (m2) {
            if (EXTREME_INTERNAL_RE.test(m2[1])) { continue }
            results.push({
                name: m2[1],
                status: m2[2].toLowerCase() === 'disabled' ? 'admin-down'
                    : m2[3].toLowerCase() === 'active' ? 'up' : 'down',
            })
        }
    }
    return results.length > 0 ? results : parseGenericInterfaces(output)
}

export function parseInterfaceStatus (vendor: string, output: string): ParsedInterfaceStatus[] {
    const v = (vendor ?? '').trim().toLowerCase()
    switch (v) {
        case 'cisco': case 'dell': case 'hpe':
            return parseCiscoInterfaces(output)
        case 'juniper':
            return parseJuniperInterfaces(output)
        case 'arista':
            return parseAristaInterfaces(output)
        case 'sonic':
            return parseSonicInterfaces(output)
        case 'huawei':
            return parseHuaweiInterfaces(output)
        case 'nokia':
            return parseNokiaInterfaces(output)
        case 'mikrotik':
            return parseMikroTikInterfaces(output)
        case 'extreme':
            return parseExtremeInterfaces(output)
        default:
            return parseGenericInterfaces(output)
    }
}

// ─── Vendor Alarm Parsing ───────────────────────────────────────────────────

/**
 * Parse vendor-specific alarm command output.
 * Juniper: `show system alarms` → date/time/severity lines
 * Huawei:  `display alarm active` → Severity/Description fields
 * Nokia:   `show system alarms` → ID/Severity/Category/Description table
 * Cisco/Arista/Dell/HPE/Extreme: `show environment` → status-based (OK/Failed/Not Present)
 * SONiC:   `show system-health summary` → status fields
 * MikroTik: `/system health print` → key/value health metrics
 * Returns empty array if no alarms or output is empty.
 */
export function parseVendorAlarms (vendor: string, output: string): ParsedAlarmEntry[] {
    if (!output || output.trim() === '' || /no\s+alarms?\s+(currently\s+)?active/i.test(output)) {
        return []
    }

    const v = (vendor ?? '').trim().toLowerCase()
    switch (v) {
        case 'juniper':  return parseJuniperAlarms(output)
        case 'huawei':   return parseHuaweiAlarms(output)
        case 'nokia':    return parseNokiaAlarms(output)
        case 'cisco':
        case 'arista':
        case 'dell':
        case 'hpe':
        case 'extreme':  return parseEnvironmentAlarms(output)
        default:         return parseGenericAlarms(output)
    }
}

function parseJuniperAlarms (output: string): ParsedAlarmEntry[] {
    const results: ParsedAlarmEntry[] = []
    const lines = output.split('\n')
    for (const line of lines) {
        // Format: <date> <time> [<timezone>]  Critical|Major|Minor  <description>
        // e.g.  2026-03-03 06:00:29 PST  Minor  BGP(47) usage requires a license
        const m = line.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\s+[A-Z]{2,5})?\s+(Critical|Major|Minor)\s+(.+)/i)
        if (m) {
            const sev = m[1].toLowerCase()
            results.push({
                severity: sev === 'critical' ? 'critical' : sev === 'major' ? 'major' : 'minor',
                message: m[2].trim(),
            })
            continue
        }
        // Alternate: just a severity + description
        const m2 = line.match(/^\s*(Major|Minor|Critical)\s+(.+)/i)
        if (m2) {
            const sev = m2[1].toLowerCase()
            results.push({
                severity: sev === 'critical' ? 'critical' : sev === 'major' ? 'major' : 'minor',
                message: m2[2].trim(),
            })
        }
    }
    return results
}

function parseHuaweiAlarms (output: string): ParsedAlarmEntry[] {
    const results: ParsedAlarmEntry[] = []
    const lines = output.split('\n')
    for (const line of lines) {
        // "Severity: Critical  Description: xxx"
        const m = line.match(/[Ss]everity\s*:\s*(Critical|Major|Minor|Warning)\s+.*?[Dd]escription\s*:\s*(.+)/i)
        if (m) {
            const sev = m[1].toLowerCase()
            results.push({
                severity: sev === 'critical' ? 'critical' : sev === 'major' ? 'major'
                    : sev === 'minor' ? 'minor' : 'warning',
                message: m[2].trim(),
            })
            continue
        }
        // Tabular: "Critical  <id>  <date>  <description>"
        const m2 = line.match(/^\s*(Critical|Major|Minor|Warning)\s+\S+\s+\S+\s+(.+)/i)
        if (m2) {
            const sev = m2[1].toLowerCase()
            results.push({
                severity: sev === 'critical' ? 'critical' : sev === 'major' ? 'major'
                    : sev === 'minor' ? 'minor' : 'warning',
                message: m2[2].trim(),
            })
        }
    }
    return results
}

/**
 * Nokia SR OS: `show system alarms`
 * Format 1 — key/value:  Severity : Critical   Description : Power supply A failure
 * Format 2 — tabular:    1  Critical  Equipment  Power supply A failure
 */
function parseNokiaAlarms (output: string): ParsedAlarmEntry[] {
    const results: ParsedAlarmEntry[] = []
    const lines = output.split('\n')
    for (const line of lines) {
        // Key-value: "Severity : Critical  ... Description : ..."
        const m = line.match(/[Ss]everity\s*:\s*(Critical|Major|Minor|Warning)\s+.*?[Dd]escription\s*:\s*(.+)/i)
        if (m) {
            results.push({ severity: mapSeverity(m[1]), message: m[2].trim() })
            continue
        }
        // Tabular: "  1  Critical  Equipment  Power supply A failure"
        const m2 = line.match(/^\s*\d+\s+(Critical|Major|Minor|Warning)\s+\S+\s+(.+)/i)
        if (m2) {
            results.push({ severity: mapSeverity(m2[1]), message: m2[2].trim() })
        }
    }
    return results
}

/**
 * Cisco / Arista / Dell / HPE / Extreme: `show environment` style output.
 * These vendors report status per component (OK, Failed, Not Present, etc.)
 * rather than using severity labels.  We detect failure keywords.
 */
function parseEnvironmentAlarms (output: string): ParsedAlarmEntry[] {
    const results: ParsedAlarmEntry[] = []
    const lines = output.split('\n')
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || /^[-=+]+$/.test(trimmed)) { continue }

        // Critical — explicit failure / fault / shutdown / error
        if (/\b(fail(ed|ure|ing)?|faulty|shutdown|err(or)?)\b/i.test(trimmed)
            && !/\bno\s+(error|fail)/i.test(trimmed)) {
            results.push({ severity: 'critical', message: trimmed })
            continue
        }

        // Major — hardware not present / absent / not installed
        if (/\b(not\s+present|absent|not\s+installed|missing|removed)\b/i.test(trimmed)) {
            results.push({ severity: 'major', message: trimmed })
            continue
        }

        // Minor — degraded / warning / abnormal / low
        if (/\b(degraded|warning|abnormal|low\s+speed)\b/i.test(trimmed)) {
            results.push({ severity: 'minor', message: trimmed })
            continue
        }
    }
    return results
}

/** Map a severity string to the canonical ParsedAlarmEntry severity. */
function mapSeverity (s: string): 'critical' | 'major' | 'minor' | 'warning' {
    switch (s.toLowerCase()) {
        case 'critical': return 'critical'
        case 'major':    return 'major'
        case 'minor':    return 'minor'
        default:         return 'warning'
    }
}

function parseGenericAlarms (output: string): ParsedAlarmEntry[] {
    const results: ParsedAlarmEntry[] = []
    const lines = output.split('\n')
    for (const line of lines) {
        const m = line.match(/(critical|major|minor|warning)\s*:?\s+(.+)/i)
        if (m) {
            const sev = m[1].toLowerCase()
            results.push({
                severity: sev === 'critical' ? 'critical' : sev === 'major' ? 'major'
                    : sev === 'minor' ? 'minor' : 'warning',
                message: m[2].trim(),
            })
        }
    }
    return results
}

// ─── Route Table Parsing ────────────────────────────────────────────────────

export interface ParsedRouteEntry {
    destination: string
    nextHop: string
    interface?: string
    protocol: string
    metric?: number
}

/**
 * Parse routing table output from various vendors.
 * Handles Cisco/Arista/SONiC `show ip route` format and similar styles.
 */
export function parseRouteTable (vendor: string, output: string): ParsedRouteEntry[] {
    const results: ParsedRouteEntry[] = []
    const lines = output.split('\n')
    const key = (vendor ?? '').trim().toLowerCase()

    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || /^[-=+*]+$/.test(trimmed) || /^Codes:/i.test(trimmed)) { continue }

        // Cisco/Arista/SONiC/HPE/Dell style:
        //   C  10.0.0.0/24 is directly connected, Ethernet0
        //   S  0.0.0.0/0 [1/0] via 192.168.1.1
        //   O  10.1.0.0/24 [110/20] via 192.168.1.1, Ethernet1
        //   B  172.16.0.0/16 [20/0] via 10.0.0.1, 00:05:12
        const mCisco = trimmed.match(
            /^([CDSOBR*>+\siLa]{1,4})\s+(\d+\.\d+\.\d+\.\d+(?:\/\d+)?)\s+(?:is\s+directly\s+connected,?\s*(\S+)?|(?:\[\d+\/(\d+)\]\s+)?via\s+([^,\s]+)(?:,\s*(\S+))?)/i,
        )
        if (mCisco) {
            const proto = mCisco[1].replace(/[*>+\s]/g, '').trim() || 'C'
            const dest = mCisco[2]
            if (mCisco[3]) {
                // Directly connected
                results.push({ destination: dest, nextHop: 'directly connected', interface: mCisco[3], protocol: proto })
            } else {
                results.push({
                    destination: dest,
                    nextHop: mCisco[5] ?? '',
                    interface: mCisco[6],
                    protocol: proto,
                    metric: mCisco[4] ? parseInt(mCisco[4], 10) : undefined,
                })
            }
            continue
        }

        // Huawei style: 10.0.0.0/24  Direct  0  0  D  Ethernet0/0/0
        const mHuawei = trimmed.match(
            /^(\d+\.\d+\.\d+\.\d+(?:\/\d+)?)\s+(\S+)\s+(\d+)\s+(\d+)\s+([A-Z]+)\s+(\S+)/,
        )
        if (mHuawei && key === 'huawei') {
            results.push({
                destination: mHuawei[1],
                nextHop: mHuawei[2] === 'Direct' ? 'directly connected' : mHuawei[2],
                protocol: mHuawei[5],
                metric: parseInt(mHuawei[4], 10),
                interface: mHuawei[6],
            })
            continue
        }

        // MikroTik style:  0  DS  0.0.0.0/0  ether1  10.0.0.1
        const mMikrotik = trimmed.match(
            /^\s*\d+\s+([A-Za-z]+)\s+(\d+\.\d+\.\d+\.\d+(?:\/\d+)?)\s+(\S+)\s+(\S+)/,
        )
        if (mMikrotik && key === 'mikrotik') {
            results.push({
                destination: mMikrotik[2],
                nextHop: mMikrotik[4],
                interface: mMikrotik[3],
                protocol: mMikrotik[1],
            })
            continue
        }
    }

    return results
}

// ─── Interface Counters Parsing ─────────────────────────────────────────────

export interface ParsedInterfaceCounters {
    rxBytes: number
    txBytes: number
    rxPackets: number
    txPackets: number
    rxErrors: number
    txErrors: number
}

/**
 * Parse interface counters output from various vendors.
 * Returns a map of interface name → counters.
 */
export function parseInterfaceCounters (vendor: string, output: string): Map<string, ParsedInterfaceCounters> {
    const results = new Map<string, ParsedInterfaceCounters>()
    const lines = output.split('\n')
    const key = (vendor ?? '').trim().toLowerCase()

    if (key === 'sonic' || key === 'arista' || key === 'cisco' || key === 'dell' || key === 'hpe') {
        // Tabular format:
        //   IFACE    STATE  RX_OK  RX_ERR  TX_OK  TX_ERR  RX_BYTES  TX_BYTES
        //   Ethernet0  U  1000  0  800  0  64000  51200
        let headerLine = -1
        let colPositions: { iface: number; rxOk: number; rxErr: number; txOk: number; txErr: number; rxBytes: number; txBytes: number } | null = null

        for (let i = 0; i < lines.length; i++) {
            const upper = lines[i].toUpperCase()
            // Find header row
            if ((upper.includes('RX_OK') || upper.includes('RX_PKTS') || upper.includes('INOCTETS') || upper.includes('IN OCTETS'))
                && (upper.includes('TX_OK') || upper.includes('TX_PKTS') || upper.includes('OUTOCTETS') || upper.includes('OUT OCTETS'))) {
                headerLine = i
                // Parse column positions from header
                const h = lines[i]
                const rxBytesIdx = Math.max(upper.indexOf('RX_BYT'), upper.indexOf('INOCTETS'), upper.indexOf('IN OCTETS'))
                const txBytesIdx = Math.max(upper.indexOf('TX_BYT'), upper.indexOf('OUTOCTETS'), upper.indexOf('OUT OCTETS'))
                const rxOkIdx = Math.max(upper.indexOf('RX_OK'), upper.indexOf('RX_PKTS'))
                const rxErrIdx = upper.indexOf('RX_ERR')
                const txOkIdx = Math.max(upper.indexOf('TX_OK'), upper.indexOf('TX_PKTS'))
                const txErrIdx = upper.indexOf('TX_ERR')

                colPositions = {
                    iface: 0,
                    rxOk: rxOkIdx >= 0 ? rxOkIdx : -1,
                    rxErr: rxErrIdx >= 0 ? rxErrIdx : -1,
                    txOk: txOkIdx >= 0 ? txOkIdx : -1,
                    txErr: txErrIdx >= 0 ? txErrIdx : -1,
                    rxBytes: rxBytesIdx >= 0 ? rxBytesIdx : -1,
                    txBytes: txBytesIdx >= 0 ? txBytesIdx : -1,
                }
                continue
            }

            if (headerLine >= 0 && i > headerLine) {
                const trimmed = lines[i].trim()
                if (!trimmed || /^[-=+]+$/.test(trimmed)) { continue }
                // Split into whitespace-delimited columns
                const cols = trimmed.split(/\s+/)
                if (cols.length < 3) { continue }

                const ifName = cols[0]
                if (!/^[A-Za-z]/.test(ifName)) { continue }

                // Try to extract numbers — positions vary, so just grab all numeric columns
                const nums = cols.slice(1).filter(c => /^\d+$/.test(c)).map(Number)
                if (nums.length >= 4) {
                    results.set(ifName, {
                        rxPackets: nums[0] ?? 0,
                        rxErrors: nums[1] ?? 0,
                        txPackets: nums[2] ?? 0,
                        txErrors: nums[3] ?? 0,
                        rxBytes: nums[4] ?? 0,
                        txBytes: nums[5] ?? 0,
                    })
                }
            }
        }
    } else {
        // Fallback: look for per-interface blocks
        //   Interface Ethernet0
        //     Input: 1000 packets, 64000 bytes, 0 errors
        //     Output: 800 packets, 51200 bytes, 0 errors
        let currentIf: string | null = null

        for (const line of lines) {
            const ifMatch = line.match(/(?:Interface|Port)\s+(\S+)/i)
            if (ifMatch) {
                currentIf = ifMatch[1]
                if (!results.has(currentIf)) {
                    results.set(currentIf, { rxBytes: 0, txBytes: 0, rxPackets: 0, txPackets: 0, rxErrors: 0, txErrors: 0 })
                }
                continue
            }

            if (currentIf) {
                const entry = results.get(currentIf)!
                const inMatch = line.match(/[Ii]nput.*?(\d+)\s*packets.*?(\d+)\s*bytes.*?(\d+)\s*errors/i)
                if (inMatch) {
                    entry.rxPackets = parseInt(inMatch[1], 10)
                    entry.rxBytes = parseInt(inMatch[2], 10)
                    entry.rxErrors = parseInt(inMatch[3], 10)
                }
                const outMatch = line.match(/[Oo]utput.*?(\d+)\s*packets.*?(\d+)\s*bytes.*?(\d+)\s*errors/i)
                if (outMatch) {
                    entry.txPackets = parseInt(outMatch[1], 10)
                    entry.txBytes = parseInt(outMatch[2], 10)
                    entry.txErrors = parseInt(outMatch[3], 10)
                }
            }
        }
    }

    return results
}
