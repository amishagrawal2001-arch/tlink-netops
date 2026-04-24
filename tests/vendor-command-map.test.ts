import { getVendorCommands, VENDOR_COMMAND_MAP } from '../renderer/src/services/vendor-command-map'

// ─────────────────────────────────────────────────────────────────────────────
// 1. All known vendors exist in VENDOR_COMMAND_MAP
// ─────────────────────────────────────────────────────────────────────────────
describe('VENDOR_COMMAND_MAP completeness', () => {
    const expectedVendors = [
        'cisco',
        'cisco-nxos',
        'cisco-iosxr',
        'juniper',         // physical (QFX, MX, EX…) — SSH drops to Junos CLI
        'juniper-crpd',    // container — SSH drops to Unix shell, needs `cli -c`
        'arista',          // physical / vEOS — SSH drops to EOS CLI
        'arista-ceos',     // container — SSH drops to bash, needs `FastCli -p 15`
        'nokia',
        'nokia-sros',
        'sonic',
        'huawei',
        'hpe',
        'dell',
        'mikrotik',
        'extreme',
        'fortinet',
        'palo-alto',
        'vyos',
    ]

    it.each(expectedVendors)('contains vendor "%s"', (vendor) => {
        expect(VENDOR_COMMAND_MAP).toHaveProperty(vendor)
    })

    it('contains exactly the expected set of vendors', () => {
        expect(Object.keys(VENDOR_COMMAND_MAP).sort()).toEqual(expectedVendors.sort())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. getVendorCommands('cisco') returns correct Cisco commands
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands("cisco")', () => {
    const cmds = getVendorCommands('cisco')

    it('returns showVersion = "show version"', () => {
        expect(cmds.showVersion).toBe('show version')
    })

    it('returns showRunningConfig = "show running-config"', () => {
        expect(cmds.showRunningConfig).toBe('show running-config')
    })

    it('returns showStartupConfig = "show startup-config"', () => {
        expect(cmds.showStartupConfig).toBe('show startup-config')
    })

    it('returns showInterfaceBrief = "show ip interface brief"', () => {
        expect(cmds.showInterfaceBrief).toBe('show ip interface brief')
    })

    it('returns showCpu = "show processes cpu"', () => {
        expect(cmds.showCpu).toBe('show processes cpu')
    })

    it('returns showMemory = "show memory statistics"', () => {
        expect(cmds.showMemory).toBe('show memory statistics')
    })

    it('returns the same object as VENDOR_COMMAND_MAP.cisco', () => {
        expect(cmds).toBe(VENDOR_COMMAND_MAP['cisco'])
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. getVendorCommands('juniper') — physical Junos (no cli wrapper)
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands("juniper") — physical', () => {
    const cmds = getVendorCommands('juniper')

    it('showVersion is bare (no cli wrapper)', () => {
        expect(cmds.showVersion).toBe('show version')
    })

    it('showRunningConfig uses display set', () => {
        expect(cmds.showRunningConfig).toBe('show configuration | display set')
    })

    it('showInterfaceBrief is bare', () => {
        expect(cmds.showInterfaceBrief).toBe('show interfaces terse')
    })

    it('showCpu for chassis routing-engine', () => {
        expect(cmds.showCpu).toBe('show chassis routing-engine')
    })

    it('showAlarms is bare', () => {
        expect(cmds.showAlarms).toBe('show system alarms')
    })

    it('loadConfigPreamble does NOT include "cli"', () => {
        expect(cmds.loadConfigPreamble).not.toContain('cli')
        expect(cmds.loadConfigPreamble).toContain('configure')
        expect(cmds.loadConfigPreamble).toContain('load set terminal')
    })

    it('differs from cisco commands', () => {
        const cisco = getVendorCommands('cisco')
        expect(cmds.showRunningConfig).not.toBe(cisco.showRunningConfig)
        expect(cmds.showInterfaceBrief).not.toBe(cisco.showInterfaceBrief)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3a. getVendorCommands('juniper', 'cRPD') — container (cli -c wrapper)
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands("juniper", model=cRPD) — container', () => {
    const cmds = getVendorCommands('juniper', 'cRPD')

    it('resolves to juniper-crpd variant', () => {
        expect(cmds).toBe(VENDOR_COMMAND_MAP['juniper-crpd'])
    })

    it('wraps showVersion with cli -c', () => {
        expect(cmds.showVersion).toBe('cli -c "show version"')
    })

    it('loadConfigPreamble starts with "cli"', () => {
        expect(cmds.loadConfigPreamble?.[0]).toBe('cli')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. getVendorCommands('arista') — physical EOS (no FastCli wrapper)
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands("arista") — physical', () => {
    const cmds = getVendorCommands('arista')

    it('showVersion is bare', () => {
        expect(cmds.showVersion).toBe('show version')
    })

    it('showRunningConfig is bare', () => {
        expect(cmds.showRunningConfig).toBe('show running-config')
    })

    it('showInterfaceBrief is bare', () => {
        expect(cmds.showInterfaceBrief).toBe('show interfaces status')
    })

    it('showCpu is bare', () => {
        expect(cmds.showCpu).toBe('show processes top once')
    })

    it('showRouteTable is bare', () => {
        expect(cmds.showRouteTable).toBe('show ip route')
    })

    it('showInterfaceCounters is bare', () => {
        expect(cmds.showInterfaceCounters).toBe('show interfaces counters')
    })

    it('loadConfigPreamble is "configure terminal"', () => {
        expect(cmds.loadConfigPreamble).toEqual(['configure terminal'])
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4a. getVendorCommands('arista', 'cEOS') — container (FastCli wrapper)
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands("arista", model=cEOS) — container', () => {
    const cmds = getVendorCommands('arista', 'cEOS')

    it('resolves to arista-ceos variant', () => {
        expect(cmds).toBe(VENDOR_COMMAND_MAP['arista-ceos'])
    })

    it('showVersion uses FastCli wrapper', () => {
        expect(cmds.showVersion).toMatch(/^FastCli -p 15 -c /)
    })

    it('showRunningConfig uses FastCli wrapper', () => {
        expect(cmds.showRunningConfig).toMatch(/^FastCli -p 15 -c /)
    })

    it('showInterfaceBrief uses FastCli wrapper', () => {
        expect(cmds.showInterfaceBrief).toMatch(/^FastCli -p 15 -c /)
    })

    it('showCpu uses FastCli wrapper', () => {
        expect(cmds.showCpu).toMatch(/^FastCli -p 15 -c /)
    })

    it('showRouteTable uses FastCli wrapper', () => {
        expect(cmds.showRouteTable).toMatch(/^FastCli -p 15 -c /)
    })

    it('showInterfaceCounters uses FastCli wrapper', () => {
        expect(cmds.showInterfaceCounters).toMatch(/^FastCli -p 15 -c /)
    })

    it('all commands except loadConfig use FastCli', () => {
        const stringFields = [
            'showVersion',
            'showRunningConfig',
            'showStartupConfig',
            'showCpu',
            'showMemory',
            'showInterfaceBrief',
            'showAlarms',
            'showRouteTable',
            'showInterfaceCounters',
        ] as const
        for (const field of stringFields) {
            const val = cmds[field]
            if (typeof val === 'string') {
                expect(val).toContain('FastCli')
            }
        }
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. getVendorCommands('nokia') uses Nokia-style commands
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands("nokia")', () => {
    const cmds = getVendorCommands('nokia')

    it('showRunningConfig uses sr_cli "info flat"', () => {
        expect(cmds.showRunningConfig).toBe('sr_cli "info flat"')
    })

    it('showCpu uses sr_cli "show system cpu"', () => {
        expect(cmds.showCpu).toBe('sr_cli "show system cpu"')
    })

    it('showMemory uses sr_cli "show system memory"', () => {
        expect(cmds.showMemory).toBe('sr_cli "show system memory"')
    })

    it('showInterfaceBrief uses sr_cli "show interface brief"', () => {
        expect(cmds.showInterfaceBrief).toBe('sr_cli "show interface brief"')
    })

    it('showRouteTable uses sr_cli "show network-instance default route-table"', () => {
        expect(cmds.showRouteTable).toBe('sr_cli "show network-instance default route-table"')
    })

    it('showAlarms uses sr_cli "show system alarms"', () => {
        expect(cmds.showAlarms).toBe('sr_cli "show system alarms"')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. getVendorCommands('sonic') uses SONiC-style show commands
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands("sonic")', () => {
    const cmds = getVendorCommands('sonic')

    it('showVersion uses "show version"', () => {
        expect(cmds.showVersion).toBe('show version')
    })

    it('showRunningConfig uses "show runningconfiguration all"', () => {
        expect(cmds.showRunningConfig).toBe('show runningconfiguration all')
    })

    it('showStartupConfig uses "cat /etc/sonic/config_db.json"', () => {
        expect(cmds.showStartupConfig).toBe('cat /etc/sonic/config_db.json')
    })

    it('showMemory uses "free -m" (Linux-based)', () => {
        expect(cmds.showMemory).toBe('free -m')
    })

    it('showInterfaceBrief uses "show interfaces status"', () => {
        expect(cmds.showInterfaceBrief).toBe('show interfaces status')
    })

    it('showAlarms uses "show system-health summary"', () => {
        expect(cmds.showAlarms).toBe('show system-health summary')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. getVendorCommands('huawei') uses display commands
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands("huawei")', () => {
    const cmds = getVendorCommands('huawei')

    it('showVersion uses "display version"', () => {
        expect(cmds.showVersion).toBe('display version')
    })

    it('showRunningConfig uses "display current-configuration"', () => {
        expect(cmds.showRunningConfig).toBe('display current-configuration')
    })

    it('showStartupConfig uses "display saved-configuration"', () => {
        expect(cmds.showStartupConfig).toBe('display saved-configuration')
    })

    it('showCpu uses "display cpu-usage"', () => {
        expect(cmds.showCpu).toBe('display cpu-usage')
    })

    it('showMemory uses "display memory-usage"', () => {
        expect(cmds.showMemory).toBe('display memory-usage')
    })

    it('showInterfaceBrief uses "display interface brief"', () => {
        expect(cmds.showInterfaceBrief).toBe('display interface brief')
    })

    it('all string commands start with "display"', () => {
        const displayFields = [
            'showVersion',
            'showRunningConfig',
            'showStartupConfig',
            'showCpu',
            'showMemory',
            'showInterfaceBrief',
            'showAlarms',
            'showRouteTable',
            'showInterfaceCounters',
        ] as const
        for (const field of displayFields) {
            const val = cmds[field]
            if (typeof val === 'string') {
                expect(val).toMatch(/^display /)
            }
        }
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. getVendorCommands for unknown vendor falls back to Cisco
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands with unknown vendor', () => {
    const cisco = getVendorCommands('cisco')

    it('falls back to cisco for a completely unknown vendor', () => {
        const result = getVendorCommands('unknown_vendor')
        expect(result).toBe(cisco)
    })

    it('falls back to cisco for an empty string', () => {
        const result = getVendorCommands('')
        expect(result).toBe(cisco)
    })

    it('falls back to cisco for whitespace-only input', () => {
        const result = getVendorCommands('   ')
        expect(result).toBe(cisco)
    })

    it('falls back to cisco for misspelled vendor', () => {
        const result = getVendorCommands('cisko')
        expect(result).toBe(cisco)
    })

    it('falls back to cisco for a numeric string', () => {
        const result = getVendorCommands('12345')
        expect(result).toBe(cisco)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. Case insensitivity
// ─────────────────────────────────────────────────────────────────────────────
describe('getVendorCommands case insensitivity', () => {
    it('resolves "Cisco" (capitalized) to cisco commands', () => {
        expect(getVendorCommands('Cisco')).toBe(VENDOR_COMMAND_MAP['cisco'])
    })

    it('resolves "CISCO" (uppercase) to cisco commands', () => {
        expect(getVendorCommands('CISCO')).toBe(VENDOR_COMMAND_MAP['cisco'])
    })

    it('resolves "JUNIPER" (uppercase) to juniper commands', () => {
        expect(getVendorCommands('JUNIPER')).toBe(VENDOR_COMMAND_MAP['juniper'])
    })

    it('resolves "Juniper" (capitalized) to juniper commands', () => {
        expect(getVendorCommands('Juniper')).toBe(VENDOR_COMMAND_MAP['juniper'])
    })

    it('resolves "Arista" (capitalized) to arista commands', () => {
        expect(getVendorCommands('Arista')).toBe(VENDOR_COMMAND_MAP['arista'])
    })

    it('resolves "HUAWEI" (uppercase) to huawei commands', () => {
        expect(getVendorCommands('HUAWEI')).toBe(VENDOR_COMMAND_MAP['huawei'])
    })

    it('resolves "Nokia" (capitalized) to nokia commands', () => {
        expect(getVendorCommands('Nokia')).toBe(VENDOR_COMMAND_MAP['nokia'])
    })

    it('resolves "MikroTik" (mixed case) to mikrotik commands', () => {
        expect(getVendorCommands('MikroTik')).toBe(VENDOR_COMMAND_MAP['mikrotik'])
    })

    it('handles leading/trailing whitespace', () => {
        expect(getVendorCommands('  cisco  ')).toBe(VENDOR_COMMAND_MAP['cisco'])
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. All vendors have required fields as non-empty strings
// ─────────────────────────────────────────────────────────────────────────────
describe('all vendors have required fields', () => {
    const requiredFields = [
        'showVersion',
        'showRunningConfig',
        'showStartupConfig',
        'showCpu',
        'showMemory',
        'showInterfaceBrief',
    ] as const

    const vendors = Object.keys(VENDOR_COMMAND_MAP)

    it.each(vendors)('vendor "%s" has all required fields as non-empty strings', (vendor) => {
        const cmds = VENDOR_COMMAND_MAP[vendor]
        for (const field of requiredFields) {
            expect(typeof cmds[field]).toBe('string')
            expect(cmds[field].length).toBeGreaterThan(0)
        }
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. Route table commands exist for all main vendors
// ─────────────────────────────────────────────────────────────────────────────
describe('showRouteTable is defined for all vendors', () => {
    const vendors = Object.keys(VENDOR_COMMAND_MAP)

    it.each(vendors)('vendor "%s" has a showRouteTable command', (vendor) => {
        const cmds = VENDOR_COMMAND_MAP[vendor]
        expect(cmds.showRouteTable).toBeDefined()
        expect(typeof cmds.showRouteTable).toBe('string')
        expect(cmds.showRouteTable!.length).toBeGreaterThan(0)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 12. Interface counter commands exist for all main vendors
// ─────────────────────────────────────────────────────────────────────────────
describe('showInterfaceCounters is defined for all vendors', () => {
    const vendors = Object.keys(VENDOR_COMMAND_MAP)

    it.each(vendors)('vendor "%s" has a showInterfaceCounters command', (vendor) => {
        const cmds = VENDOR_COMMAND_MAP[vendor]
        expect(cmds.showInterfaceCounters).toBeDefined()
        expect(typeof cmds.showInterfaceCounters).toBe('string')
        expect(cmds.showInterfaceCounters!.length).toBeGreaterThan(0)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 13. Config push commands (loadConfigPreamble / loadConfigPostamble)
// ─────────────────────────────────────────────────────────────────────────────
describe('config push commands', () => {
    const vendors = Object.keys(VENDOR_COMMAND_MAP)

    it.each(vendors)(
        'vendor "%s" has loadConfigPreamble defined as an array',
        (vendor) => {
            const cmds = VENDOR_COMMAND_MAP[vendor]
            expect(cmds.loadConfigPreamble).toBeDefined()
            expect(Array.isArray(cmds.loadConfigPreamble)).toBe(true)
        }
    )

    it.each(vendors)(
        'vendor "%s" has loadConfigPostamble defined as an array',
        (vendor) => {
            const cmds = VENDOR_COMMAND_MAP[vendor]
            expect(cmds.loadConfigPostamble).toBeDefined()
            expect(Array.isArray(cmds.loadConfigPostamble)).toBe(true)
        }
    )

    it('cisco loadConfigPreamble starts with "configure terminal"', () => {
        const cmds = VENDOR_COMMAND_MAP['cisco']
        expect(cmds.loadConfigPreamble).toContain('configure terminal')
    })

    it('cisco loadConfigPostamble includes "write memory"', () => {
        const cmds = VENDOR_COMMAND_MAP['cisco']
        expect(cmds.loadConfigPostamble).toContain('write memory')
    })

    it('juniper loadConfigPreamble includes "configure" and "load set terminal"', () => {
        const cmds = VENDOR_COMMAND_MAP['juniper']
        expect(cmds.loadConfigPreamble).toContain('configure')
        expect(cmds.loadConfigPreamble).toContain('load set terminal')
    })

    it('juniper loadConfigPostamble includes "commit"', () => {
        const cmds = VENDOR_COMMAND_MAP['juniper']
        expect(cmds.loadConfigPostamble).toContain('commit')
    })

    it('huawei loadConfigPreamble starts with "system-view"', () => {
        const cmds = VENDOR_COMMAND_MAP['huawei']
        expect(cmds.loadConfigPreamble).toContain('system-view')
    })

    it('huawei loadConfigPostamble includes "commit" and "save"', () => {
        const cmds = VENDOR_COMMAND_MAP['huawei']
        expect(cmds.loadConfigPostamble).toContain('commit')
        expect(cmds.loadConfigPostamble).toContain('save')
    })

    it('nokia loadConfigPreamble includes "sr_cli" and "enter candidate"', () => {
        const cmds = VENDOR_COMMAND_MAP['nokia']
        expect(cmds.loadConfigPreamble).toContain('sr_cli')
        expect(cmds.loadConfigPreamble).toContain('enter candidate')
    })

    it('nokia loadConfigPostamble includes "commit now" and "quit"', () => {
        const cmds = VENDOR_COMMAND_MAP['nokia']
        expect(cmds.loadConfigPostamble).toContain('commit now')
        expect(cmds.loadConfigPostamble).toContain('quit')
    })

    it('mikrotik loadConfigPreamble is an empty array (no config mode)', () => {
        const cmds = VENDOR_COMMAND_MAP['mikrotik']
        expect(cmds.loadConfigPreamble).toEqual([])
    })

    it('mikrotik loadConfigPostamble is an empty array (no config mode)', () => {
        const cmds = VENDOR_COMMAND_MAP['mikrotik']
        expect(cmds.loadConfigPostamble).toEqual([])
    })

    it('arista (physical) loadConfigPreamble is bare "configure terminal"', () => {
        const cmds = VENDOR_COMMAND_MAP['arista']
        expect(cmds.loadConfigPreamble).toEqual(['configure terminal'])
    })

    it('arista-ceos (container) loadConfigPreamble uses FastCli invocation', () => {
        const cmds = VENDOR_COMMAND_MAP['arista-ceos']
        expect(cmds.loadConfigPreamble).toBeDefined()
        expect(cmds.loadConfigPreamble!.some((c) => c.includes('FastCli'))).toBe(true)
    })
})
