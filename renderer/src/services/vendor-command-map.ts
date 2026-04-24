// ═══════════════════════════════════════════════════════════════════════════════
// Vendor SSH Command Map — per-vendor CLI commands for inventory polling
// ═══════════════════════════════════════════════════════════════════════════════

export interface VendorCommands {
    showVersion: string
    showRunningConfig: string
    showStartupConfig: string
    showCpu: string
    showMemory: string
    showInterfaceBrief: string
    showAlarms?: string
    showRouteTable?: string
    showInterfaceCounters?: string
    showLldpNeighbors?: string
    showCdpNeighbors?: string
    showBgpSummary?: string
    loadConfigPreamble?: string[]
    loadConfigPostamble?: string[]
}

export const VENDOR_COMMAND_MAP: Record<string, VendorCommands> = {
    // ── Cisco IOS-XE / generic IOS ──────────────────────────────────────────
    cisco: {
        showVersion: 'show version',
        showRunningConfig: 'show running-config',
        showStartupConfig: 'show startup-config',
        showCpu: 'show processes cpu',
        showMemory: 'show memory statistics',
        showInterfaceBrief: 'show ip interface brief',
        showAlarms: 'show environment all',
        showRouteTable: 'show ip route',
        showInterfaceCounters: 'show interface counters',
        showLldpNeighbors: 'show lldp neighbors detail',
        showCdpNeighbors: 'show cdp neighbors detail',
        showBgpSummary: 'show bgp summary',
        loadConfigPreamble: ['configure terminal'],
        loadConfigPostamble: ['end', 'write memory'],
    },
    // ── Cisco NX-OS (Nexus) ─────────────────────────────────────────────────
    'cisco-nxos': {
        showVersion: 'show version',
        showRunningConfig: 'show running-config',
        showStartupConfig: 'show startup-config',
        showCpu: 'show system resources',
        showMemory: 'show system resources',
        showInterfaceBrief: 'show interface brief',
        showAlarms: 'show environment',
        showRouteTable: 'show ip route',
        showInterfaceCounters: 'show interface counters',
        showLldpNeighbors: 'show lldp neighbors detail',
        showCdpNeighbors: 'show cdp neighbors detail',
        showBgpSummary: 'show bgp summary',
        loadConfigPreamble: ['configure terminal'],
        loadConfigPostamble: ['end', 'copy running-config startup-config'],
    },
    // ── Cisco IOS-XR (ASR/NCS) ──────────────────────────────────────────────
    'cisco-iosxr': {
        showVersion: 'show version',
        showRunningConfig: 'show running-config',
        showStartupConfig: 'show running-config',
        showCpu: 'show processes cpu',
        showMemory: 'show memory summary',
        showInterfaceBrief: 'show ip interface brief',
        showAlarms: 'show alarms brief',
        showRouteTable: 'show route',
        showInterfaceCounters: 'show interface accounting',
        showLldpNeighbors: 'show lldp neighbors detail',
        showBgpSummary: 'show bgp summary',
        loadConfigPreamble: ['configure terminal'],
        loadConfigPostamble: ['commit', 'end'],
    },
    // ── Juniper (Junos / EVO) — PHYSICAL ────────────────────────────────────
    // SSH to physical QFX / MX / EX drops straight into the Junos CLI. No
    // `cli` prefix needed (it would produce "unknown command: cli").
    juniper: {
        showVersion: 'show version',
        showRunningConfig: 'show configuration | display set',
        showStartupConfig: 'show configuration | display set',
        showCpu: 'show chassis routing-engine',
        showMemory: 'show chassis routing-engine',
        showInterfaceBrief: 'show interfaces terse',
        showAlarms: 'show system alarms',
        showRouteTable: 'show route',
        showInterfaceCounters: 'show interfaces statistics',
        showLldpNeighbors: 'show lldp neighbors',
        showBgpSummary: 'show bgp summary',
        loadConfigPreamble: ['configure', 'load set terminal'],
        loadConfigPostamble: ['\x04', 'commit', 'exit', 'exit'],
    },
    // ── Juniper cRPD (containerized RIB-PE) ─────────────────────────────────
    // SSH as root on cRPD drops into Unix shell, not Junos CLI.
    // Wrap every command with `cli -c "…"` so it works from shell mode.
    'juniper-crpd': {
        showVersion: 'cli -c "show version"',
        showRunningConfig: 'cli -c "show configuration | display set"',
        showStartupConfig: 'cli -c "show configuration | display set"',
        showCpu: 'cli -c "show chassis routing-engine"',
        showMemory: 'cli -c "show chassis routing-engine"',
        showInterfaceBrief: 'cli -c "show interfaces terse"',
        showAlarms: 'cli -c "show system alarms"',
        showRouteTable: 'cli -c "show route"',
        showInterfaceCounters: 'cli -c "show interfaces statistics"',
        showLldpNeighbors: 'cli -c "show lldp neighbors"',
        showBgpSummary: 'cli -c "show bgp summary"',
        loadConfigPreamble: ['cli', 'configure', 'load set terminal'],
        loadConfigPostamble: ['\x04', 'commit', 'exit', 'exit'],
    },
    // ── Arista EOS — PHYSICAL / vEOS ────────────────────────────────────────
    // SSH drops into EOS CLI directly. No bash wrapper needed.
    arista: {
        showVersion: 'show version',
        showRunningConfig: 'show running-config',
        showStartupConfig: 'show startup-config',
        showCpu: 'show processes top once',
        showMemory: 'show version',
        showInterfaceBrief: 'show interfaces status',
        showAlarms: 'show system environment all',
        showRouteTable: 'show ip route',
        showInterfaceCounters: 'show interfaces counters',
        showLldpNeighbors: 'show lldp neighbors detail',
        showBgpSummary: 'show bgp summary',
        loadConfigPreamble: ['configure terminal'],
        loadConfigPostamble: ['end', 'write memory'],
    },
    // ── Arista cEOS (container) ─────────────────────────────────────────────
    // cEOS with bash-shell enabled drops into Linux shell.
    // Wrap every command with `FastCli -p 15 -c "…"` so it works from bash.
    'arista-ceos': {
        showVersion: 'FastCli -p 15 -c "show version"',
        showRunningConfig: 'FastCli -p 15 -c "show running-config"',
        showStartupConfig: 'FastCli -p 15 -c "show startup-config"',
        showCpu: 'FastCli -p 15 -c "show processes top once"',
        showMemory: 'FastCli -p 15 -c "show version"',
        showInterfaceBrief: 'FastCli -p 15 -c "show interfaces status"',
        showAlarms: 'FastCli -p 15 -c "show system environment all"',
        showRouteTable: 'FastCli -p 15 -c "show ip route"',
        showInterfaceCounters: 'FastCli -p 15 -c "show interfaces counters"',
        showLldpNeighbors: 'FastCli -p 15 -c "show lldp neighbors detail"',
        showBgpSummary: 'FastCli -p 15 -c "show bgp summary"',
        loadConfigPreamble: ['FastCli -p 15 -c "configure terminal"'],
        loadConfigPostamble: ['FastCli -p 15 -c "end"', 'FastCli -p 15 -c "write memory"'],
    },
    // ── Nokia SR Linux ──────────────────────────────────────────────────────
    // SSH on SR Linux may drop into bash. Wrap with `sr_cli "…"`.
    nokia: {
        showVersion: 'sr_cli "show version"',
        showRunningConfig: 'sr_cli "info flat"',
        showStartupConfig: 'sr_cli "info flat"',
        showCpu: 'sr_cli "show system cpu"',
        showMemory: 'sr_cli "show system memory"',
        showInterfaceBrief: 'sr_cli "show interface brief"',
        showAlarms: 'sr_cli "show system alarms"',
        showRouteTable: 'sr_cli "show network-instance default route-table"',
        showInterfaceCounters: 'sr_cli "show interface * statistics"',
        showLldpNeighbors: 'sr_cli "show system lldp neighbor"',
        showBgpSummary: 'sr_cli "show network-instance default protocols bgp neighbor"',
        loadConfigPreamble: ['sr_cli', 'enter candidate'],
        loadConfigPostamble: ['commit now', 'quit'],
    },
    // ── Nokia SR OS (classic SROS / 7750 / 7250 / 7950) ─────────────────────
    // Uses `configure private` for exclusive config lock — prevents concurrent
    // edits that can produce inconsistent commit results.
    'nokia-sros': {
        showVersion: 'show version',
        showRunningConfig: 'admin display-config',
        showStartupConfig: 'admin display-config',
        showCpu: 'show system cpu',
        showMemory: 'show system memory-pools',
        showInterfaceBrief: 'show port',
        showAlarms: 'show system alarms',
        showRouteTable: 'show router route-table',
        showInterfaceCounters: 'show port statistics',
        showLldpNeighbors: 'show system lldp neighbor',
        showBgpSummary: 'show router bgp summary',
        loadConfigPreamble: ['environment more false', 'configure private'],
        loadConfigPostamble: ['commit', 'exit all'],
    },
    // ── SONiC ───────────────────────────────────────────────────────────────
    // Linux-based — CLI commands are in PATH as scripts.
    sonic: {
        showVersion: 'show version',
        showRunningConfig: 'show runningconfiguration all',
        showStartupConfig: 'cat /etc/sonic/config_db.json',
        showCpu: 'show processes cpu',
        showMemory: 'free -m',
        showInterfaceBrief: 'show interfaces status',
        showAlarms: 'show system-health summary',
        showRouteTable: 'show ip route',
        showInterfaceCounters: 'show interfaces counters',
        showLldpNeighbors: 'show lldp table',
        showBgpSummary: 'show bgp summary',
        loadConfigPreamble: [],
        loadConfigPostamble: ['sudo config save -y'],
    },
    // ── Huawei VRP ──────────────────────────────────────────────────────────
    // `screen-length 0 temporary` disables pagination for the SSH session so
    // long outputs (running config, full route table) don't wait for --More--.
    huawei: {
        showVersion: 'display version',
        showRunningConfig: 'display current-configuration',
        showStartupConfig: 'display saved-configuration',
        showCpu: 'display cpu-usage',
        showMemory: 'display memory-usage',
        showInterfaceBrief: 'display interface brief',
        showAlarms: 'display alarm active',
        showRouteTable: 'display ip routing-table',
        showInterfaceCounters: 'display interface counters',
        showLldpNeighbors: 'display lldp neighbor brief',
        showBgpSummary: 'display bgp peer',
        loadConfigPreamble: ['screen-length 0 temporary', 'system-view'],
        loadConfigPostamble: ['commit', 'return', 'save', 'Y'],
    },
    // ── HPE / Aruba CX ──────────────────────────────────────────────────────
    hpe: {
        showVersion: 'show version',
        showRunningConfig: 'show running-config',
        showStartupConfig: 'show startup-config',
        showCpu: 'show cpu',
        showMemory: 'show memory',
        showInterfaceBrief: 'show interfaces brief',
        showAlarms: 'show system',
        showRouteTable: 'show ip route',
        showInterfaceCounters: 'show interface counters',
        showLldpNeighbors: 'show lldp neighbors detail',
        showBgpSummary: 'show bgp summary',
        loadConfigPreamble: ['configure terminal'],
        loadConfigPostamble: ['end', 'write memory'],
    },
    // ── Dell OS10 ───────────────────────────────────────────────────────────
    dell: {
        showVersion: 'show version',
        showRunningConfig: 'show running-configuration',
        showStartupConfig: 'show startup-configuration',
        showCpu: 'show processes cpu',
        showMemory: 'show memory',
        showInterfaceBrief: 'show interfaces status',
        showAlarms: 'show environment',
        showRouteTable: 'show ip route',
        showInterfaceCounters: 'show interface counters',
        showLldpNeighbors: 'show lldp neighbors detail',
        showBgpSummary: 'show bgp summary',
        loadConfigPreamble: ['configure terminal'],
        loadConfigPostamble: ['end', 'write memory'],
    },
    // ── MikroTik RouterOS ───────────────────────────────────────────────────
    // RouterOS has no config mode — commands apply immediately. Config is
    // persistent by default (no explicit save).
    // Note: `/ip neighbor` is MikroTik's own neighbor discovery (CDP/MNDP);
    // for LLDP specifically, `/interface lldp neighbor print detail` is the
    // right command. The table shows both sources if LLDP is enabled.
    mikrotik: {
        showVersion: '/system resource print',
        showRunningConfig: '/export',
        showStartupConfig: '/export',
        showCpu: '/system resource print',
        showMemory: '/system resource print',
        showInterfaceBrief: '/interface print brief',
        showAlarms: '/system health print',
        showRouteTable: '/ip route print',
        showInterfaceCounters: '/interface print stats',
        showLldpNeighbors: '/interface lldp neighbor print detail',
        showCdpNeighbors: '/ip neighbor print detail',
        showBgpSummary: '/routing bgp peer print status',
        loadConfigPreamble: [],
        loadConfigPostamble: [],
    },
    // ── Extreme EXOS ────────────────────────────────────────────────────────
    // EXOS has NO "configure terminal" mode — commands apply immediately at
    // the top-level prompt. `save configuration` (with 'y' to confirm) is the
    // only postamble needed. `disable clipaging session` prevents --More--.
    extreme: {
        showVersion: 'show version',
        showRunningConfig: 'show configuration',
        showStartupConfig: 'show configuration',
        showCpu: 'show cpu-monitoring',
        showMemory: 'show memory',
        showInterfaceBrief: 'show ports',
        showAlarms: 'show system',
        showRouteTable: 'show iproute',
        showInterfaceCounters: 'show ports statistics',
        showLldpNeighbors: 'show lldp neighbors detailed',
        showBgpSummary: 'show bgp neighbor',
        loadConfigPreamble: ['disable clipaging session'],
        loadConfigPostamble: ['save configuration', 'y'],
    },
    // ── Fortinet FortiGate (FortiOS) ────────────────────────────────────────
    // FortiOS uses `config <section>` / `edit <name>` / `set …` / `end` blocks.
    // `config system console` + `set output standard` disables pagination.
    fortinet: {
        showVersion: 'get system status',
        showRunningConfig: 'show full-configuration',
        showStartupConfig: 'show full-configuration',
        showCpu: 'get system performance status',
        showMemory: 'get system performance status',
        showInterfaceBrief: 'get system interface',
        showAlarms: 'diagnose system ha status',
        showRouteTable: 'get router info routing-table all',
        showInterfaceCounters: 'diagnose hardware deviceinfo nic',
        showLldpNeighbors: 'diagnose switch lldp neighbor-summary',
        showBgpSummary: 'get router info bgp summary',
        loadConfigPreamble: ['config system console', 'set output standard', 'end'],
        loadConfigPostamble: [],
    },
    // ── Palo Alto (PAN-OS) ──────────────────────────────────────────────────
    // PAN-OS has separate operational and configuration modes. `configure`
    // enters candidate config; `commit` applies; `exit` leaves config mode.
    'palo-alto': {
        showVersion: 'show system info',
        showRunningConfig: 'show config running',
        showStartupConfig: 'show config saved',
        showCpu: 'show system resources',
        showMemory: 'show system resources',
        showInterfaceBrief: 'show interface all',
        showAlarms: 'show system alarm all',
        showRouteTable: 'show routing route',
        showInterfaceCounters: 'show counter interface',
        showLldpNeighbors: 'show lldp neighbors all',
        showBgpSummary: 'show routing protocol bgp summary',
        loadConfigPreamble: ['set cli pager off', 'configure'],
        loadConfigPostamble: ['commit', 'exit'],
    },
    // ── VyOS / Vyatta ───────────────────────────────────────────────────────
    // Junos-inspired: `configure` → `set …` → `commit` → `save` → `exit`.
    // Config must be saved separately (commit doesn't persist across reboot).
    vyos: {
        showVersion: 'show version',
        showRunningConfig: 'show configuration commands',
        showStartupConfig: 'show configuration commands',
        showCpu: 'show system processes',
        showMemory: 'show system memory',
        showInterfaceBrief: 'show interfaces',
        showAlarms: 'show log',
        showRouteTable: 'show ip route',
        showInterfaceCounters: 'show interfaces counters',
        showLldpNeighbors: 'show lldp neighbors',
        showBgpSummary: 'show ip bgp summary',
        loadConfigPreamble: ['configure'],
        loadConfigPostamble: ['commit', 'save', 'exit'],
    },
}

/**
 * Resolve the vendor command map for a given vendor string.
 *
 * Supports explicit sub-types: 'cisco-nxos', 'cisco-iosxr', 'nokia-sros',
 * 'juniper-crpd', 'arista-ceos', 'palo-alto'.
 *
 * Auto-detects sub-type from model string:
 *   Cisco  → nxos (nexus/n9k/n5k/n3k) | iosxr (asr/ncs/xr) | ios (default)
 *   Juniper → juniper-crpd (crpd/container) | juniper (default = physical)
 *   Arista  → arista-ceos (ceos/container/veos) | arista (default = physical)
 *   Nokia   → nokia-sros (7750/7250/7950/sros) | nokia (default = SR Linux)
 *
 * Unknown vendors fall back to Cisco-style commands.
 *
 * @param vendor  - vendor name (e.g. "juniper", "cisco", "fortinet")
 * @param model   - optional model string (drives auto-detect; e.g., "cRPD",
 *                  "Nexus 9000", "ASR 9910", "QFX5130")
 */
export function getVendorCommands (vendor: string, model?: string): VendorCommands {
    const key = (vendor ?? '').trim().toLowerCase()
    const m = (model ?? '').toLowerCase()

    // ── Auto-detect sub-type from model BEFORE the base-vendor match so
    //    e.g. vendor="juniper" + model="cRPD" resolves to juniper-crpd, not
    //    to the physical juniper default.
    if (key === 'cisco') {
        if (m.includes('nexus') || m.includes('nxos') || m.includes('nx-os') ||
            m.includes('n9k') || m.includes('n5k') || m.includes('n3k')) {
            return VENDOR_COMMAND_MAP['cisco-nxos']
        }
        if (m.includes('asr') || m.includes('ncs') || m.includes('xr') ||
            m.includes('ios-xr') || m.includes('iosxr')) {
            return VENDOR_COMMAND_MAP['cisco-iosxr']
        }
    }
    if (key === 'juniper') {
        // Physical Juniper drops into Junos CLI on SSH — no `cli` wrapper.
        // cRPD container drops into Unix shell — needs `cli -c "…"` wrapper.
        if (m.includes('crpd') || m.includes('container')) {
            return VENDOR_COMMAND_MAP['juniper-crpd']
        }
        // Physical (QFX, MX, EX, SRX, ACX…) is the default.
    }
    if (key === 'arista') {
        // cEOS container drops into bash — needs `FastCli -p 15` wrapper.
        // Physical / vEOS drops into EOS CLI directly.
        if (m.includes('ceos') || m.includes('c-eos') || m.includes('container')) {
            return VENDOR_COMMAND_MAP['arista-ceos']
        }
    }
    if (key === 'nokia') {
        if (m.includes('sros') || m.includes('sr-os') ||
            m.includes('7750') || m.includes('7250') || m.includes('7950')) {
            return VENDOR_COMMAND_MAP['nokia-sros']
        }
        // SR Linux is the default for Nokia
    }

    // Common aliases
    if (key === 'paloalto' || key === 'pan-os' || key === 'panos') {
        return VENDOR_COMMAND_MAP['palo-alto']
    }
    if (key === 'fortigate' || key === 'fortios') {
        return VENDOR_COMMAND_MAP['fortinet']
    }

    // ── Direct match on explicit sub-type key (e.g. 'juniper-crpd') or
    //    base vendor (e.g. 'juniper', 'cisco'). Sub-type keys must come
    //    after the model-based auto-detect so the auto-detect takes
    //    precedence for bare vendor names with a telltale model hint.
    if (VENDOR_COMMAND_MAP[key]) { return VENDOR_COMMAND_MAP[key] }

    // Unknown vendor → Cisco-style default
    return VENDOR_COMMAND_MAP['cisco']
}
