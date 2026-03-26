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
        loadConfigPreamble: ['configure terminal'],
        loadConfigPostamble: ['commit', 'end'],
    },
    // ── Juniper (Junos / EVO) ───────────────────────────────────────────────
    // SSH as root drops into Unix shell, not Junos CLI.
    // Wrap every command with `cli -c "…"` so it works from shell mode.
    juniper: {
        showVersion: 'cli -c "show version"',
        showRunningConfig: 'cli -c "show configuration | display set"',
        showStartupConfig: 'cli -c "show configuration | display set"',
        showCpu: 'cli -c "show chassis routing-engine"',
        showMemory: 'cli -c "show chassis routing-engine"',
        showInterfaceBrief: 'cli -c "show interfaces terse"',
        showAlarms: 'cli -c "show system alarms"',
        showRouteTable: 'cli -c "show route"',
        showInterfaceCounters: 'cli -c "show interfaces statistics"',
        loadConfigPreamble: ['cli', 'configure', 'load set terminal'],
        loadConfigPostamble: ['\x04', 'commit', 'exit', 'exit'],
    },
    // ── Arista EOS ──────────────────────────────────────────────────────────
    // cEOS / vEOS with bash-shell enabled drops into Linux shell.
    // Wrap with `FastCli -p 15 -c "…"` so it works from bash.
    arista: {
        showVersion: 'FastCli -p 15 -c "show version"',
        showRunningConfig: 'FastCli -p 15 -c "show running-config"',
        showStartupConfig: 'FastCli -p 15 -c "show startup-config"',
        showCpu: 'FastCli -p 15 -c "show processes top once"',
        showMemory: 'FastCli -p 15 -c "show version"',
        showInterfaceBrief: 'FastCli -p 15 -c "show interfaces status"',
        showAlarms: 'FastCli -p 15 -c "show system environment all"',
        showRouteTable: 'FastCli -p 15 -c "show ip route"',
        showInterfaceCounters: 'FastCli -p 15 -c "show interfaces counters"',
        loadConfigPreamble: ['FastCli -p 15', 'configure terminal'],
        loadConfigPostamble: ['end', 'write memory'],
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
        loadConfigPreamble: ['sr_cli', 'enter candidate'],
        loadConfigPostamble: ['commit now', 'quit'],
    },
    // ── Nokia SR OS (classic SROS / 7750 / 7250) ───────────────────────────
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
        loadConfigPreamble: ['configure'],
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
        loadConfigPreamble: [],
        loadConfigPostamble: ['sudo config save -y'],
    },
    // ── Huawei VRP ──────────────────────────────────────────────────────────
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
        loadConfigPreamble: ['system-view'],
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
        loadConfigPreamble: ['configure terminal'],
        loadConfigPostamble: ['end', 'write memory'],
    },
    // ── MikroTik RouterOS ───────────────────────────────────────────────────
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
        loadConfigPreamble: [],
        loadConfigPostamble: [],
    },
    // ── Extreme EXOS ────────────────────────────────────────────────────────
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
        loadConfigPreamble: ['configure terminal'],
        loadConfigPostamble: ['end', 'save configuration', 'y'],
    },
}

/**
 * Resolve the vendor command map for a given vendor string.
 * Supports sub-types: 'cisco-nxos', 'cisco-iosxr', 'nokia-sros'.
 * Falls back to base vendor, then Cisco-style commands if vendor is unknown.
 *
 * @param vendor  - vendor name, optionally with switchFamily/model hint
 * @param model   - optional model string (e.g., 'Nexus 9000', 'ASR 9910', 'SRL')
 */
export function getVendorCommands (vendor: string, model?: string): VendorCommands {
    const key = (vendor ?? '').trim().toLowerCase()

    // Direct match (e.g., 'cisco-nxos', 'nokia-sros')
    if (VENDOR_COMMAND_MAP[key]) { return VENDOR_COMMAND_MAP[key] }

    // Auto-detect sub-type from model string
    const m = (model ?? '').toLowerCase()
    if (key === 'cisco') {
        if (m.includes('nexus') || m.includes('nxos') || m.includes('nx-os') || m.includes('n9k') || m.includes('n5k') || m.includes('n3k')) {
            return VENDOR_COMMAND_MAP['cisco-nxos']
        }
        if (m.includes('asr') || m.includes('ncs') || m.includes('xr') || m.includes('ios-xr') || m.includes('iosxr')) {
            return VENDOR_COMMAND_MAP['cisco-iosxr']
        }
    }
    if (key === 'nokia') {
        if (m.includes('sros') || m.includes('7750') || m.includes('7250') || m.includes('7950')) {
            return VENDOR_COMMAND_MAP['nokia-sros']
        }
        // SR Linux is the default for Nokia
    }

    // Base vendor fallback
    return VENDOR_COMMAND_MAP[key] ?? VENDOR_COMMAND_MAP['cisco']
}
