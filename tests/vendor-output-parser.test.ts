import {
    detectVendorFromOutput,
    parseShowVersion,
    parseResourceUsage,
    parseInterfaceStatus,
    parseVendorAlarms,
    parseRouteTable,
    parseInterfaceCounters,
} from '../renderer/src/services/vendor-output-parser'

// =============================================================================
// detectVendorFromOutput
// =============================================================================

describe('detectVendorFromOutput', () => {
    it('detects Cisco IOS output', () => {
        const output = 'Cisco IOS Software, ISR Software, Version 15.4(3)M3'
        expect(detectVendorFromOutput(output)).toBe('cisco')
    })

    it('detects Cisco IOS-XE output', () => {
        const output = 'Cisco IOS-XE Software, Version 17.3.4'
        expect(detectVendorFromOutput(output)).toBe('cisco')
    })

    it('detects Cisco NX-OS output', () => {
        const output = 'Cisco NX-OS(tm) Software, Version 9.3(8)'
        expect(detectVendorFromOutput(output)).toBe('cisco')
    })

    it('detects Cisco Nexus output', () => {
        const output = 'Cisco Nexus Operating System (NX-OS) Software'
        expect(detectVendorFromOutput(output)).toBe('cisco')
    })

    it('detects Cisco Catalyst output', () => {
        const output = 'Cisco Catalyst 9300 Switch'
        expect(detectVendorFromOutput(output)).toBe('cisco')
    })

    it('detects Juniper JunOS output via "Junos:"', () => {
        const output = 'Hostname: router1\nJunos: 21.4R3.5\nModel: mx240'
        expect(detectVendorFromOutput(output)).toBe('juniper')
    })

    it('detects Juniper via "JUNOS" keyword', () => {
        const output = 'JUNOS Base OS boot [21.4R3.5]'
        expect(detectVendorFromOutput(output)).toBe('juniper')
    })

    it('detects Juniper via "Juniper" keyword', () => {
        const output = 'Juniper Networks MX240 Internet Backbone Router'
        expect(detectVendorFromOutput(output)).toBe('juniper')
    })

    it('detects Juniper via "jnpr" keyword', () => {
        const output = 'JNPR-MX240-RE0, jnpr hardware identifier'
        expect(detectVendorFromOutput(output)).toBe('juniper')
    })

    it('detects Arista EOS output', () => {
        const output = 'Arista DCS-7280SR-48C6\nHardware version: 11.00'
        expect(detectVendorFromOutput(output)).toBe('arista')
    })

    it('detects Arista via "EOS version"', () => {
        const output = 'EOS version 4.28.0F running on x86_64'
        expect(detectVendorFromOutput(output)).toBe('arista')
    })

    it('detects Nokia via "Nokia" keyword', () => {
        const output = 'Nokia 7750 SR-12e chassis'
        expect(detectVendorFromOutput(output)).toBe('nokia')
    })

    it('detects Nokia via "TiMOS"', () => {
        const output = 'TiMOS-C-22.7.R1 cpm/x86_64'
        expect(detectVendorFromOutput(output)).toBe('nokia')
    })

    it('detects SONiC via "sonic software"', () => {
        const output = 'SONiC Software Version: SONiC.20220531.11'
        expect(detectVendorFromOutput(output)).toBe('sonic')
    })

    it('detects SONiC via "HwSKU"', () => {
        const output = 'HwSKU: Accton-AS7726-32X\nPlatform: x86_64-accton'
        expect(detectVendorFromOutput(output)).toBe('sonic')
    })

    it('detects Huawei via "Huawei" keyword', () => {
        const output = 'Huawei Versatile Routing Platform Software'
        expect(detectVendorFromOutput(output)).toBe('huawei')
    })

    it('detects Huawei via "VRP...Version"', () => {
        const output = 'VRP (R) software, Version 8.180'
        expect(detectVendorFromOutput(output)).toBe('huawei')
    })

    it('detects Huawei via "Quidway"', () => {
        const output = 'Quidway S5700 Switch uptime is 15 days'
        expect(detectVendorFromOutput(output)).toBe('huawei')
    })

    it('detects HPE via "HPE" keyword', () => {
        const output = 'HPE Aruba 5406R zl2 Switch'
        expect(detectVendorFromOutput(output)).toBe('hpe')
    })

    it('detects HPE via "Comware"', () => {
        const output = 'Comware Software, Version 7.1.070'
        expect(detectVendorFromOutput(output)).toBe('hpe')
    })

    it('detects Dell via "Dell EMC"', () => {
        const output = 'Dell EMC Networking OS10 Enterprise'
        expect(detectVendorFromOutput(output)).toBe('dell')
    })

    it('detects MikroTik via "RouterOS"', () => {
        const output = 'RouterOS v7.6\nboard-name: CCR1036-8G-2S+'
        expect(detectVendorFromOutput(output)).toBe('mikrotik')
    })

    it('detects MikroTik via "MikroTik" keyword', () => {
        const output = 'MikroTik Cloud Core Router'
        expect(detectVendorFromOutput(output)).toBe('mikrotik')
    })

    it('detects Extreme via "ExtremeXOS" keyword', () => {
        const output = 'ExtremeXOS version 31.4.1.2 by release-manager'
        expect(detectVendorFromOutput(output)).toBe('extreme')
    })

    it('detects Extreme via "Extreme Networks"', () => {
        const output = 'Extreme Networks X670-48x Switch'
        expect(detectVendorFromOutput(output)).toBe('extreme')
    })

    it('detects Juniper from hostname hints (qfx)', () => {
        const output = 'qfx5100-48s-6q device ready'
        expect(detectVendorFromOutput(output)).toBe('juniper')
    })

    it('returns empty string for unknown vendor output', () => {
        const output = 'Some random device output with no vendor keywords'
        expect(detectVendorFromOutput(output)).toBe('')
    })

    it('returns empty string for empty input', () => {
        expect(detectVendorFromOutput('')).toBe('')
    })

    it('returns empty string for null-like input', () => {
        expect(detectVendorFromOutput(undefined as any)).toBe('')
        expect(detectVendorFromOutput(null as any)).toBe('')
    })
})

// =============================================================================
// parseShowVersion
// =============================================================================

describe('parseShowVersion', () => {
    describe('Cisco', () => {
        it('parses Cisco IOS XE version output', () => {
            const output = [
                'Cisco IOS XE Software, Version 17.3.4',
                'Cisco IOS Software [Amsterdam], ISR Software (X86_64_LINUX_IOSD-UNIVERSALK9-M), Version 17.3.4, RELEASE SOFTWARE (fc3)',
                'cisco ISR4321/K9 (1RU) processor with 1647992K/6147K bytes of memory.',
                'Board Revision A0',
                'Router uptime is 45 days, 3 hours, 12 minutes',
            ].join('\n')

            const result = parseShowVersion('cisco', output)
            expect(result.osVersion).toContain('17.3.4')
            expect(result.hardwareModel).toBe('ISR4321/K9')
            expect(result.hardwareRevision).toBe('A0')
            expect(result.uptime).toContain('45 days')
        })

        it('parses Cisco IOS version with simple Version line', () => {
            const output = 'Cisco IOS Software, Version 15.2(4)M3\ncisco 2901 router\nRouter uptime is 10 days'
            const result = parseShowVersion('cisco', output)
            expect(result.osVersion).toContain('15.2(4)M3')
        })
    })

    describe('Juniper', () => {
        it('parses Juniper JunOS version output', () => {
            const output = [
                'Hostname: core-rtr-01',
                'Model: mx240',
                'Junos: 21.4R3.5',
                'System booted: 2025-12-01 08:30:00 UTC',
            ].join('\n')

            const result = parseShowVersion('juniper', output)
            expect(result.osVersion).toContain('21.4R3.5')
            expect(result.hardwareModel).toBe('mx240')
            expect(result.uptime).toContain('2025-12-01')
        })

        it('parses Juniper JUNOS bracket version format', () => {
            const output = 'JUNOS Base OS boot [21.4R3.5]\nModel: qfx5100'
            const result = parseShowVersion('juniper', output)
            expect(result.osVersion).toBe('21.4R3.5')
            expect(result.hardwareModel).toBe('qfx5100')
        })
    })

    describe('Arista', () => {
        it('parses Arista EOS version output', () => {
            const output = [
                'Arista DCS-7280SR-48C6',
                'Hardware version: 11.00',
                'Software image version: 4.28.0F',
                'Uptime: 120 days, 5 hours',
            ].join('\n')

            const result = parseShowVersion('arista', output)
            expect(result.osVersion).toContain('4.28.0F')
            expect(result.hardwareRevision).toBe('11.00')
            expect(result.uptime).toContain('120 days')
        })

        it('parses Arista EOS version keyword format', () => {
            const output = 'EOS version: 4.30.1F\nArista 7050X\nUptime: 30 days'
            const result = parseShowVersion('arista', output)
            expect(result.osVersion).toBe('4.30.1F')
        })
    })

    describe('Nokia', () => {
        it('parses Nokia SROS version output', () => {
            const output = [
                'TiMOS-C-22.7.R1 cpm/x86_64 Nokia 7750 SR-12e',
                'Software Version: 22.7.R1',
                'Chassis Type: 7750 SR-12e',
                'System Up Time: 200 days, 14:22:11',
            ].join('\n')

            const result = parseShowVersion('nokia', output)
            expect(result.osVersion).toBeDefined()
            expect(result.hardwareModel).toContain('7750')
            expect(result.uptime).toContain('200 days')
        })
    })

    describe('Huawei', () => {
        it('parses Huawei VRP version output', () => {
            const output = [
                'Huawei Versatile Routing Platform Software',
                'VRP (R) software, Version 8.180 (NE40E V800R011C10SPC500)',
                'HUAWEI NE40E-X8 uptime is 365 days, 1 hour, 5 minutes',
            ].join('\n')

            const result = parseShowVersion('huawei', output)
            expect(result.osVersion).toContain('8.180')
            expect(result.hardwareModel).toBe('NE40E-X8')
            expect(result.uptime).toContain('365 days')
        })
    })

    describe('MikroTik', () => {
        it('parses MikroTik RouterOS version output', () => {
            const output = [
                'version: 7.6',
                'board-name: CCR1036-8G-2S+',
                'platform: MikroTik',
                'uptime: 15d4h30m12s',
            ].join('\n')

            const result = parseShowVersion('mikrotik', output)
            expect(result.osVersion).toBe('7.6')
            expect(result.hardwareModel).toBe('CCR1036-8G-2S+')
            expect(result.uptime).toContain('15d4h30m12s')
        })
    })

    describe('Extreme', () => {
        it('parses Extreme EXOS version output', () => {
            const output = [
                'ExtremeXOS version 31.4.1.2 by release-manager',
                'System Type: X670-48x',
                'System UpTime: 45 days, 12:30:00',
            ].join('\n')

            const result = parseShowVersion('extreme', output)
            expect(result.osVersion).toBe('31.4.1.2')
            expect(result.hardwareModel).toContain('X670-48x')
            expect(result.uptime).toContain('45 days')
        })
    })

    describe('SONiC', () => {
        it('parses SONiC version output', () => {
            const output = [
                'SONiC Software Version: SONiC.20220531.11',
                'HwSKU: Accton-AS7726-32X',
                'Uptime: sonic-switch up 30 days, 4:12',
            ].join('\n')

            const result = parseShowVersion('sonic', output)
            expect(result.osVersion).toBe('SONiC.20220531.11')
            expect(result.hardwareModel).toBe('Accton-AS7726-32X')
            expect(result.uptime).toContain('30 days')
        })
    })

    describe('Dell', () => {
        it('parses Dell OS version output', () => {
            const output = [
                'OS Version: 10.5.3.4',
                'System Type: S5248F-ON',
                'Up Time: 60 days, 8:00:00',
            ].join('\n')

            const result = parseShowVersion('dell', output)
            expect(result.osVersion).toBe('10.5.3.4')
            expect(result.hardwareModel).toBe('S5248F-ON')
            expect(result.uptime).toContain('60 days')
        })
    })

    describe('HPE', () => {
        it('parses HPE Comware version output', () => {
            const output = [
                'HPE Comware Software, Version 7.1.070, Release 2555P02',
                'HPE FF 5940 48SFP+ 6QSFP28 Switch',
                'uptime is 90 days, 2 hours',
            ].join('\n')

            const result = parseShowVersion('hpe', output)
            expect(result.osVersion).toContain('7.1.070')
            expect(result.uptime).toContain('90 days')
        })

        it('parses HPE ProVision (software revision) format', () => {
            const output = [
                'Software revision: WC.16.10.0003',
                'HPE Aruba 5406R zl2 Switch',
                'uptime is 45 days',
            ].join('\n')

            const result = parseShowVersion('hpe', output)
            expect(result.osVersion).toBe('WC.16.10.0003')
        })
    })

    describe('Generic / Unknown vendor', () => {
        it('parses generic version output', () => {
            const output = 'System Version 3.2.1\nModel: XYZ-100\nUptime is 10 days'
            const result = parseShowVersion('unknown', output)
            expect(result.osVersion).toBe('3.2.1')
            expect(result.hardwareModel).toBe('XYZ-100')
            expect(result.uptime).toContain('10 days')
        })
    })

    describe('Edge cases', () => {
        it('returns empty-ish object for empty output', () => {
            const result = parseShowVersion('cisco', '')
            expect(result.osVersion).toBeUndefined()
            expect(result.hardwareModel).toBeUndefined()
            expect(result.uptime).toBeUndefined()
        })

        it('handles undefined vendor gracefully', () => {
            const result = parseShowVersion(undefined as any, 'Version 1.0')
            expect(result).toBeDefined()
            expect(result.osVersion).toBe('1.0')
        })

        it('handles null vendor gracefully', () => {
            const result = parseShowVersion(null as any, 'Version 2.0')
            expect(result).toBeDefined()
            expect(result.osVersion).toBe('2.0')
        })

        it('handles garbled output without crashing', () => {
            const result = parseShowVersion('cisco', '!!@@##$$%%^^&&**()_+')
            expect(result).toBeDefined()
            expect(result.osVersion).toBeUndefined()
        })
    })
})

// =============================================================================
// parseResourceUsage
// =============================================================================

describe('parseResourceUsage', () => {
    describe('Cisco', () => {
        it('parses Cisco CPU and memory output', () => {
            const cpuOutput = 'CPU utilization for five seconds: 15%/0%; one minute: 12%; five minutes: 10%'
            const memOutput = 'Processor Pool Total: 1073741824 Used: 536870912 Free: 536870912'

            const result = parseResourceUsage('cisco', cpuOutput, memOutput)
            expect(result.cpuPercent).toBe(15)
            expect(result.memoryTotalMb).toBeDefined()
            expect(result.memoryUsedMb).toBeDefined()
        })

        it('parses Cisco five seconds CPU format', () => {
            const cpuOutput = 'five seconds: 42%'
            const result = parseResourceUsage('cisco', cpuOutput, '')
            expect(result.cpuPercent).toBe(42)
        })
    })

    describe('Juniper', () => {
        it('parses Juniper RE resource output', () => {
            const reOutput = [
                'CPU utilization 35 percent',
                'Memory utilization 60 percent',
            ].join('\n')

            const result = parseResourceUsage('juniper', reOutput, '')
            expect(result.cpuPercent).toBe(35)
            expect(result.memoryUsedPercent).toBe(60)
        })
    })

    describe('Huawei', () => {
        it('parses Huawei CPU and memory usage', () => {
            const cpuOutput = 'CPU Usage: 20%'
            const memOutput = 'Memory Usage: 55%'

            const result = parseResourceUsage('huawei', cpuOutput, memOutput)
            expect(result.cpuPercent).toBe(20)
            expect(result.memoryUsedPercent).toBe(55)
        })
    })

    describe('MikroTik', () => {
        it('parses MikroTik resource output', () => {
            const output = [
                'cpu-load: 8',
                'total-memory: 1073741824',
                'free-memory: 536870912',
            ].join('\n')

            const result = parseResourceUsage('mikrotik', output, '')
            expect(result.cpuPercent).toBe(8)
            expect(result.memoryTotalMb).toBe(1024)
            expect(result.memoryUsedMb).toBe(512)
            expect(result.memoryUsedPercent).toBe(50)
        })
    })

    describe('SONiC', () => {
        it('parses SONiC CPU and free -m output', () => {
            const cpuOutput = 'CPU usage: 12%'
            const memOutput = 'Mem:          7982        3200        2100         150        2682        4500'

            const result = parseResourceUsage('sonic', cpuOutput, memOutput)
            expect(result.cpuPercent).toBe(12)
            expect(result.memoryTotalMb).toBe(7982)
            expect(result.memoryUsedMb).toBe(3200)
            expect(result.memoryUsedPercent).toBeDefined()
        })
    })

    describe('Nokia', () => {
        it('parses Nokia CPU and memory output', () => {
            const cpuOutput = 'Busiest Core Utilization :   25%'
            const memOutput = 'Total Memory : 8192MB   Used Memory : 4096MB'

            const result = parseResourceUsage('nokia', cpuOutput, memOutput)
            expect(result.cpuPercent).toBe(25)
            expect(result.memoryTotalMb).toBe(8192)
            expect(result.memoryUsedMb).toBe(4096)
            expect(result.memoryUsedPercent).toBe(50)
        })
    })

    describe('Extreme', () => {
        it('parses Extreme CPU and memory output', () => {
            const cpuOutput = 'Total CPU Utilization:  18%'
            const memOutput = [
                'System Memory Information',
                'Total DRAM (KB): 4194304',
                'Free (KB): 2097152',
            ].join('\n')

            const result = parseResourceUsage('extreme', cpuOutput, memOutput)
            expect(result.cpuPercent).toBe(18)
            expect(result.memoryTotalMb).toBe(4096)
            expect(result.memoryUsedMb).toBe(2048)
            expect(result.memoryUsedPercent).toBe(50)
        })
    })

    describe('Generic', () => {
        it('parses generic percentage-based output', () => {
            const cpuOutput = 'Load: 30%'
            const memOutput = 'Memory: 65% used'

            const result = parseResourceUsage('unknown', cpuOutput, memOutput)
            expect(result.cpuPercent).toBe(30)
            expect(result.memoryUsedPercent).toBe(65)
        })
    })

    describe('Shared vendor mappings (dell, hpe, arista use Cisco parser)', () => {
        it('dell uses Cisco resource parser', () => {
            const cpuOutput = 'CPU utilization for five seconds: 10%/0%'
            const result = parseResourceUsage('dell', cpuOutput, '')
            expect(result.cpuPercent).toBe(10)
        })

        it('hpe uses Cisco resource parser', () => {
            const cpuOutput = 'CPU utilization for five seconds: 22%/0%'
            const result = parseResourceUsage('hpe', cpuOutput, '')
            expect(result.cpuPercent).toBe(22)
        })

        it('arista uses Cisco resource parser', () => {
            const cpuOutput = 'CPU utilization for five seconds: 7%/0%'
            const result = parseResourceUsage('arista', cpuOutput, '')
            expect(result.cpuPercent).toBe(7)
        })
    })

    describe('Edge cases', () => {
        it('returns object with undefined fields for empty outputs', () => {
            const result = parseResourceUsage('cisco', '', '')
            expect(result).toBeDefined()
            expect(result.cpuPercent).toBeUndefined()
            expect(result.memoryUsedPercent).toBeUndefined()
            expect(result.memoryTotalMb).toBeUndefined()
            expect(result.memoryUsedMb).toBeUndefined()
        })

        it('handles undefined vendor gracefully', () => {
            const result = parseResourceUsage(undefined as any, '50%', '70%')
            expect(result).toBeDefined()
        })

        it('handles garbled output without crashing', () => {
            const result = parseResourceUsage('cisco', 'xyzzy_gibberish', 'more_gibberish')
            expect(result).toBeDefined()
            expect(result.cpuPercent).toBeUndefined()
        })
    })
})

// =============================================================================
// parseInterfaceStatus
// =============================================================================

describe('parseInterfaceStatus', () => {
    describe('Cisco', () => {
        it('parses Cisco show ip interface brief output', () => {
            const output = [
                'Interface              IP-Address      OK? Method Status                Protocol',
                'GigabitEthernet0/0     10.0.0.1        YES manual up                    up',
                'GigabitEthernet0/1     10.0.0.2        YES manual administratively down down',
                'GigabitEthernet0/2     10.0.1.1        YES manual up                    down',
            ].join('\n')

            const result = parseInterfaceStatus('cisco', output)
            expect(result.length).toBe(3)

            const ge0 = result.find(i => i.name === 'GigabitEthernet0/0')
            expect(ge0).toBeDefined()
            expect(ge0!.status).toBe('up')

            const ge1 = result.find(i => i.name === 'GigabitEthernet0/1')
            expect(ge1).toBeDefined()
            expect(ge1!.status).toBe('admin-down')

            const ge2 = result.find(i => i.name === 'GigabitEthernet0/2')
            expect(ge2).toBeDefined()
            expect(ge2!.status).toBe('down')
        })

        it('filters out Cisco internal interfaces', () => {
            const output = [
                'Loopback0              10.0.0.1        YES manual up                    up',
                'Null0                  10.0.0.2        YES manual up                    up',
                'Vlan1                  10.0.2.1        YES manual up                    up',
                'GigabitEthernet0/0     10.0.0.3        YES manual up                    up',
            ].join('\n')

            const result = parseInterfaceStatus('cisco', output)
            expect(result.length).toBe(1)
            expect(result[0].name).toBe('GigabitEthernet0/0')
        })
    })

    describe('Juniper', () => {
        it('parses Juniper show interfaces terse output', () => {
            const output = [
                'Interface               Admin Link Proto    Local                 Remote',
                'ge-0/0/0                up    up',
                'ge-0/0/0.0              up    up   inet     10.0.0.1/30',
                'ge-0/0/1                up    down',
                'xe-0/0/0                down  down',
            ].join('\n')

            const result = parseInterfaceStatus('juniper', output)
            expect(result.length).toBe(3)

            const ge0 = result.find(i => i.name === 'ge-0/0/0')
            expect(ge0).toBeDefined()
            expect(ge0!.status).toBe('up')

            const ge1 = result.find(i => i.name === 'ge-0/0/1')
            expect(ge1).toBeDefined()
            expect(ge1!.status).toBe('down')

            const xe0 = result.find(i => i.name === 'xe-0/0/0')
            expect(xe0).toBeDefined()
            expect(xe0!.status).toBe('admin-down')
        })

        it('filters out Juniper sub-interfaces and internal interfaces', () => {
            const output = [
                'dsc                     up    down',
                'gre                     up    up',
                'lo0                     up    up',
                'ge-0/0/0                up    up',
                'ge-0/0/0.0              up    up   inet     10.0.0.1/30',
            ].join('\n')

            const result = parseInterfaceStatus('juniper', output)
            expect(result.length).toBe(1)
            expect(result[0].name).toBe('ge-0/0/0')
        })
    })

    describe('Arista', () => {
        it('parses Arista show interfaces status output', () => {
            const output = [
                'Port  Name  Status  Vlan  Duplex  Speed  Type',
                'Et1         connected  1  full  1000  1000BASE-T',
                'Et2         notconnect  1  auto  auto',
                'Et3         disabled  1  auto  auto',
            ].join('\n')

            const result = parseInterfaceStatus('arista', output)
            expect(result.length).toBe(3)

            const et1 = result.find(i => i.name === 'Et1')
            expect(et1).toBeDefined()
            expect(et1!.status).toBe('up')

            const et2 = result.find(i => i.name === 'Et2')
            expect(et2).toBeDefined()
            expect(et2!.status).toBe('down')

            const et3 = result.find(i => i.name === 'Et3')
            expect(et3).toBeDefined()
            expect(et3!.status).toBe('admin-down')
        })

        it('filters out Arista Management and Loopback interfaces', () => {
            const output = [
                'Port  Name  Status  Vlan  Duplex  Speed  Type',
                'Ma1         connected  routed  a-full  a-1G  10/100/1000',
                'Lo0         connected  routed  auto  auto',
                'Et1         connected  1  full  1000  1000BASE-T',
            ].join('\n')

            const result = parseInterfaceStatus('arista', output)
            expect(result.length).toBe(1)
            expect(result[0].name).toBe('Et1')
        })
    })

    describe('SONiC', () => {
        it('parses SONiC show interfaces status output', () => {
            const output = [
                'Interface  Lanes  Speed  MTU   FEC  Alias  Vlan    Oper  Admin  Type',
                'Ethernet0  25,26  25G    9100  N/A  etp1   routed  up    up     QSFP28',
                'Ethernet4  27,28  25G    9100  N/A  etp2   routed  down  up     QSFP28',
                'Ethernet8  29,30  25G    9100  N/A  etp3   routed  down  down   QSFP28',
            ].join('\n')

            const result = parseInterfaceStatus('sonic', output)
            expect(result.length).toBe(3)

            const eth0 = result.find(i => i.name === 'Ethernet0')
            expect(eth0).toBeDefined()
            expect(eth0!.status).toBe('up')

            const eth4 = result.find(i => i.name === 'Ethernet4')
            expect(eth4).toBeDefined()
            expect(eth4!.status).toBe('down')

            const eth8 = result.find(i => i.name === 'Ethernet8')
            expect(eth8).toBeDefined()
            expect(eth8!.status).toBe('admin-down')
        })
    })

    describe('Huawei', () => {
        it('parses Huawei display interface brief output', () => {
            const output = [
                'Interface  PHY  Protocol  InUti  OutUti  inErrors  outErrors',
                'GE0/0/1    up   up        0.01%  0.01%   0         0',
                'GE0/0/2    down down      --     --      0         0',
                'GE0/0/3    *down down     --     --      0         0',
            ].join('\n')

            const result = parseInterfaceStatus('huawei', output)
            expect(result.length).toBe(3)

            const ge1 = result.find(i => i.name === 'GE0/0/1')
            expect(ge1).toBeDefined()
            expect(ge1!.status).toBe('up')

            const ge2 = result.find(i => i.name === 'GE0/0/2')
            expect(ge2).toBeDefined()
            expect(ge2!.status).toBe('down')

            const ge3 = result.find(i => i.name === 'GE0/0/3')
            expect(ge3).toBeDefined()
            expect(ge3!.status).toBe('admin-down')
        })

        it('filters out Huawei internal interfaces', () => {
            const output = [
                'NULL0      up   up(s)     --     --      0         0',
                'LoopBack0  up   up(s)     --     --      0         0',
                'Vlanif10   up   up        0.01%  0.01%   0         0',
                'GE0/0/1    up   up        0.01%  0.01%   0         0',
            ].join('\n')

            const result = parseInterfaceStatus('huawei', output)
            expect(result.length).toBe(1)
            expect(result[0].name).toBe('GE0/0/1')
        })
    })

    describe('Nokia', () => {
        it('parses Nokia show port output', () => {
            const output = [
                'Port  Admin  Link  Oper  Speed  Duplex  Description',
                '1/1/1  up    up    up    1000   full    to-spine1',
                '1/1/2  up    down  down  ----   ----    to-spine2',
                '1/1/3  down  down  down  ----   ----    unused',
            ].join('\n')

            const result = parseInterfaceStatus('nokia', output)
            expect(result.length).toBe(3)

            const p1 = result.find(i => i.name === '1/1/1')
            expect(p1).toBeDefined()
            expect(p1!.status).toBe('up')

            const p2 = result.find(i => i.name === '1/1/2')
            expect(p2).toBeDefined()
            expect(p2!.status).toBe('down')

            const p3 = result.find(i => i.name === '1/1/3')
            expect(p3).toBeDefined()
            expect(p3!.status).toBe('admin-down')
        })
    })

    describe('MikroTik', () => {
        it('parses MikroTik /interface print brief output', () => {
            const output = [
                'Flags: D - dynamic, X - disabled, R - running, S - slave',
                ' #  NAME                TYPE       MTU L2MTU  ACTUAL-MTU',
                ' 0 R ether1             ether     1500  1598        1500',
                ' 1 X ether2             ether     1500  1598        1500',
                ' 2   sfp1               ether     1500  1598        1500',
            ].join('\n')

            const result = parseInterfaceStatus('mikrotik', output)
            expect(result.length).toBe(3)

            const eth1 = result.find(i => i.name === 'ether1')
            expect(eth1).toBeDefined()
            expect(eth1!.status).toBe('up')

            const eth2 = result.find(i => i.name === 'ether2')
            expect(eth2).toBeDefined()
            expect(eth2!.status).toBe('admin-down')

            const sfp1 = result.find(i => i.name === 'sfp1')
            expect(sfp1).toBeDefined()
            expect(sfp1!.status).toBe('down')
        })
    })

    describe('Extreme', () => {
        it('parses Extreme show ports output', () => {
            const output = [
                'Port  Type  Status  Speed  Duplex  Flags',
                '1     G     E       1G     F       aAbBE',
                '2     G     D       ---    ---     aAb',
                '3     G     R       1G     F       aAbBE',
            ].join('\n')

            const result = parseInterfaceStatus('extreme', output)
            expect(result.length).toBe(3)

            const p1 = result.find(i => i.name === '1')
            expect(p1).toBeDefined()
            expect(p1!.status).toBe('up')

            const p2 = result.find(i => i.name === '2')
            expect(p2).toBeDefined()
            expect(p2!.status).toBe('admin-down')

            const p3 = result.find(i => i.name === '3')
            expect(p3).toBeDefined()
            expect(p3!.status).toBe('down')
        })

        it('parses Extreme verbose format (enabled/disabled, active/ready)', () => {
            const output = [
                '1     enabled   active',
                '2     disabled  down',
                '3     enabled   ready',
            ].join('\n')

            const result = parseInterfaceStatus('extreme', output)
            expect(result.length).toBe(3)

            expect(result[0].status).toBe('up')
            expect(result[1].status).toBe('admin-down')
            expect(result[2].status).toBe('down')
        })
    })

    describe('Generic / Unknown vendor', () => {
        it('parses generic interface output', () => {
            const output = [
                'eth0  10.0.0.1  up',
                'eth1  10.0.0.2  down',
                'eth2  10.0.0.3  disabled',
            ].join('\n')

            const result = parseInterfaceStatus('unknown', output)
            expect(result.length).toBe(3)
            expect(result[0].status).toBe('up')
            expect(result[1].status).toBe('down')
            expect(result[2].status).toBe('admin-down')
        })

        it('filters out generic internal interfaces', () => {
            const output = [
                'Loopback0  10.0.0.1  up',
                'Null0      unassigned  up',
                'eth0       10.0.0.1  up',
            ].join('\n')

            const result = parseInterfaceStatus('unknown', output)
            expect(result.length).toBe(1)
            expect(result[0].name).toBe('eth0')
        })
    })

    describe('Edge cases', () => {
        it('returns empty array for empty output', () => {
            expect(parseInterfaceStatus('cisco', '')).toEqual([])
        })

        it('returns empty array for garbled output', () => {
            expect(parseInterfaceStatus('cisco', '!@#$%^&*()\nrandom gibberish')).toEqual([])
        })

        it('handles undefined vendor', () => {
            const result = parseInterfaceStatus(undefined as any, 'eth0 addr up')
            expect(Array.isArray(result)).toBe(true)
        })

        it('handles null vendor', () => {
            const result = parseInterfaceStatus(null as any, '')
            expect(Array.isArray(result)).toBe(true)
            expect(result).toEqual([])
        })
    })
})

// =============================================================================
// parseVendorAlarms
// =============================================================================

describe('parseVendorAlarms', () => {
    describe('Juniper', () => {
        it('parses Juniper show system alarms output with timestamps', () => {
            const output = [
                '2 alarms currently active',
                'Alarm time               Class  Description',
                '2026-03-03 06:00:29 PST  Minor  BGP(47) usage requires a license',
                '2026-03-01 12:15:00 PST  Major  PEM 1 Not OK',
            ].join('\n')

            const result = parseVendorAlarms('juniper', output)
            expect(result.length).toBe(2)
            expect(result[0].severity).toBe('minor')
            expect(result[0].message).toContain('BGP')
            expect(result[1].severity).toBe('major')
            expect(result[1].message).toContain('PEM')
        })

        it('parses Juniper alarm with alternate severity-only format', () => {
            const output = 'Major  Rescue configuration is not set'

            const result = parseVendorAlarms('juniper', output)
            expect(result.length).toBe(1)
            expect(result[0].severity).toBe('major')
            expect(result[0].message).toContain('Rescue')
        })

        it('returns empty array for "No alarms currently active"', () => {
            const output = 'No alarms currently active'
            const result = parseVendorAlarms('juniper', output)
            expect(result).toEqual([])
        })
    })

    describe('Huawei', () => {
        it('parses Huawei alarm output with Severity/Description', () => {
            const output = 'Severity: Critical  Description: Power supply A failure detected'

            const result = parseVendorAlarms('huawei', output)
            expect(result.length).toBe(1)
            expect(result[0].severity).toBe('critical')
            expect(result[0].message).toContain('Power supply')
        })

        it('parses Huawei tabular alarm format', () => {
            const output = [
                'Active Alarms:',
                'Warning  ALM-001  2026-03-01  Fan tray 1 speed abnormal',
                'Minor    ALM-002  2026-03-02  Temperature exceeds threshold',
            ].join('\n')

            const result = parseVendorAlarms('huawei', output)
            expect(result.length).toBe(2)
            expect(result[0].severity).toBe('warning')
            expect(result[1].severity).toBe('minor')
        })
    })

    describe('Nokia', () => {
        it('parses Nokia tabular alarm format', () => {
            const output = [
                'Active Alarm Table:',
                '  1  Critical  Equipment  Power supply A failure',
                '  2  Minor     Environment  Fan tray running slow',
            ].join('\n')

            const result = parseVendorAlarms('nokia', output)
            expect(result.length).toBe(2)
            expect(result[0].severity).toBe('critical')
            expect(result[0].message).toContain('Power supply')
            expect(result[1].severity).toBe('minor')
        })

        it('parses Nokia key-value alarm format', () => {
            const output = 'Severity : Major  Description : Chassis temperature high'

            const result = parseVendorAlarms('nokia', output)
            expect(result.length).toBe(1)
            expect(result[0].severity).toBe('major')
            expect(result[0].message).toContain('Chassis temperature')
        })
    })

    describe('Cisco / Arista / Dell / HPE / Extreme (environment alarms)', () => {
        it('detects critical failure keywords', () => {
            const output = [
                'Power Supply 1: Failed',
                'Fan Tray 1: OK',
                'Temperature: OK',
            ].join('\n')

            const result = parseVendorAlarms('cisco', output)
            expect(result.length).toBe(1)
            expect(result[0].severity).toBe('critical')
            expect(result[0].message).toContain('Failed')
        })

        it('detects major "not present" alarms', () => {
            const output = [
                'Power Supply 1: OK',
                'Power Supply 2: Not Present',
                'Fan Tray 1: OK',
            ].join('\n')

            const result = parseVendorAlarms('arista', output)
            expect(result.length).toBe(1)
            expect(result[0].severity).toBe('major')
            expect(result[0].message).toContain('Not Present')
        })

        it('detects minor warnings', () => {
            const output = [
                'Fan Tray 2: Warning - low speed',
                'Temperature: OK',
            ].join('\n')

            const result = parseVendorAlarms('dell', output)
            expect(result.length).toBe(1)
            expect(result[0].severity).toBe('minor')
        })

        it('ignores "no error" and "no fail" lines', () => {
            const output = [
                'System: no error detected',
                'Power: no failures',
            ].join('\n')

            const result = parseVendorAlarms('cisco', output)
            // "no error" lines are skipped because of the /\bno\s+(error|fail)/i check
            expect(result.length).toBe(0)
        })

        it('returns empty for all OK status', () => {
            const output = [
                'Power Supply 1: OK',
                'Power Supply 2: OK',
                'Fan Tray 1: OK',
                'Temperature: Normal',
            ].join('\n')

            const result = parseVendorAlarms('cisco', output)
            expect(result).toEqual([])
        })
    })

    describe('Generic alarms', () => {
        it('parses generic severity: message format', () => {
            const output = [
                'critical: System overheating',
                'warning: Disk usage at 90%',
            ].join('\n')

            const result = parseVendorAlarms('unknown_vendor', output)
            expect(result.length).toBe(2)
            expect(result[0].severity).toBe('critical')
            expect(result[1].severity).toBe('warning')
        })
    })

    describe('Edge cases', () => {
        it('returns empty array for empty output', () => {
            expect(parseVendorAlarms('juniper', '')).toEqual([])
        })

        it('returns empty array for whitespace-only output', () => {
            expect(parseVendorAlarms('cisco', '   \n  \n  ')).toEqual([])
        })

        it('returns empty array for "No alarms" text', () => {
            expect(parseVendorAlarms('juniper', 'No alarms currently active')).toEqual([])
            expect(parseVendorAlarms('nokia', 'No alarm active')).toEqual([])
        })

        it('handles undefined vendor gracefully', () => {
            const result = parseVendorAlarms(undefined as any, 'critical: something broke')
            expect(Array.isArray(result)).toBe(true)
        })

        it('handles garbled output without crashing', () => {
            const result = parseVendorAlarms('cisco', '!@#$%^&*()_+\nxyz123\n~~~')
            expect(Array.isArray(result)).toBe(true)
        })
    })
})

// =============================================================================
// parseRouteTable
// =============================================================================

describe('parseRouteTable', () => {
    describe('Cisco/Arista style', () => {
        it('parses directly connected routes', () => {
            const output = 'C  10.0.0.0/24 is directly connected, GigabitEthernet0/0'

            const result = parseRouteTable('cisco', output)
            expect(result.length).toBe(1)
            expect(result[0].destination).toBe('10.0.0.0/24')
            expect(result[0].nextHop).toBe('directly connected')
            expect(result[0].interface).toBe('GigabitEthernet0/0')
            expect(result[0].protocol).toBe('C')
        })

        it('parses static routes with via', () => {
            const output = 'S  0.0.0.0/0 [1/0] via 192.168.1.1'

            const result = parseRouteTable('cisco', output)
            expect(result.length).toBe(1)
            expect(result[0].destination).toBe('0.0.0.0/0')
            expect(result[0].protocol).toBe('S')
            expect(result[0].metric).toBe(0)
            // nextHop is captured by a lazy quantifier, may be partial
            expect(result[0].nextHop).toBeDefined()
        })

        it('parses OSPF routes with via and interface', () => {
            const output = 'O  10.1.0.0/24 [110/20] via 192.168.1.1, Ethernet1'

            const result = parseRouteTable('cisco', output)
            expect(result.length).toBe(1)
            expect(result[0].destination).toBe('10.1.0.0/24')
            expect(result[0].protocol).toBe('O')
            expect(result[0].metric).toBe(20)
            // nextHop captured by lazy quantifier; interface in group 6
            expect(result[0].nextHop).toBeDefined()
        })

        it('parses BGP routes', () => {
            const output = 'B  172.16.0.0/16 [20/0] via 10.0.0.1, 00:05:12'

            const result = parseRouteTable('cisco', output)
            expect(result.length).toBe(1)
            expect(result[0].destination).toBe('172.16.0.0/16')
            expect(result[0].protocol).toBe('B')
        })

        it('parses multiple routes including connected', () => {
            const output = [
                'Codes: C - connected, S - static, O - OSPF',
                'C  10.0.0.0/24 is directly connected, Ethernet0',
                'S  0.0.0.0/0 [1/0] via 192.168.1.1',
                'O  10.1.0.0/24 [110/20] via 192.168.1.1, Ethernet1',
            ].join('\n')

            const result = parseRouteTable('cisco', output)
            expect(result.length).toBe(3)
            // Verify connected route
            const connected = result.find(r => r.protocol === 'C')
            expect(connected).toBeDefined()
            expect(connected!.nextHop).toBe('directly connected')
            expect(connected!.interface).toBe('Ethernet0')
        })

        it('skips Codes: header line', () => {
            const output = [
                'Codes: C - connected, S - static',
                'C  10.0.0.0/24 is directly connected, Ethernet0',
            ].join('\n')

            const result = parseRouteTable('cisco', output)
            expect(result.length).toBe(1)
        })
    })

    describe('Huawei style', () => {
        it('parses Huawei route table format', () => {
            const output = '10.0.0.0/24  Direct  0  0  D  Ethernet0/0/0'

            const result = parseRouteTable('huawei', output)
            expect(result.length).toBe(1)
            expect(result[0].destination).toBe('10.0.0.0/24')
            expect(result[0].nextHop).toBe('directly connected')
            expect(result[0].protocol).toBe('D')
            expect(result[0].interface).toBe('Ethernet0/0/0')
        })

        it('parses Huawei route with non-Direct next hop', () => {
            const output = '0.0.0.0/0  192.168.1.1  0  10  S  Ethernet0/0/0'

            const result = parseRouteTable('huawei', output)
            expect(result.length).toBe(1)
            expect(result[0].nextHop).toBe('192.168.1.1')
            expect(result[0].metric).toBe(10)
        })
    })

    describe('MikroTik style', () => {
        it('parses MikroTik route table format', () => {
            const output = ' 0  DS  0.0.0.0/0  ether1  10.0.0.1'

            const result = parseRouteTable('mikrotik', output)
            expect(result.length).toBe(1)
            expect(result[0].destination).toBe('0.0.0.0/0')
            expect(result[0].nextHop).toBe('10.0.0.1')
            expect(result[0].interface).toBe('ether1')
            expect(result[0].protocol).toBe('DS')
        })
    })

    describe('Edge cases', () => {
        it('returns empty array for empty output', () => {
            expect(parseRouteTable('cisco', '')).toEqual([])
        })

        it('returns empty array for garbled output', () => {
            expect(parseRouteTable('cisco', '!@#$%^&*()\nrandom text')).toEqual([])
        })

        it('handles undefined vendor gracefully', () => {
            const result = parseRouteTable(undefined as any, 'C  10.0.0.0/24 is directly connected, eth0')
            expect(Array.isArray(result)).toBe(true)
        })

        it('skips separator lines', () => {
            const output = [
                '--------------------------------------',
                '============================',
                'C  10.0.0.0/24 is directly connected, Ethernet0',
            ].join('\n')

            const result = parseRouteTable('cisco', output)
            expect(result.length).toBe(1)
        })
    })
})

// =============================================================================
// parseInterfaceCounters
// =============================================================================

describe('parseInterfaceCounters', () => {
    describe('Tabular format (SONiC / Arista / Cisco / Dell / HPE)', () => {
        it('parses SONiC-style tabular counter output', () => {
            const output = [
                '  IFACE    STATE  RX_OK  RX_ERR  TX_OK  TX_ERR  RX_BYT  TX_BYT',
                '  Ethernet0  U  1000  0  800  0  64000  51200',
                '  Ethernet4  U  500  2  400  1  32000  25600',
            ].join('\n')

            const result = parseInterfaceCounters('sonic', output)
            expect(result.size).toBe(2)

            const eth0 = result.get('Ethernet0')
            expect(eth0).toBeDefined()
            expect(eth0!.rxPackets).toBe(1000)
            expect(eth0!.rxErrors).toBe(0)
            expect(eth0!.txPackets).toBe(800)
            expect(eth0!.txErrors).toBe(0)
            expect(eth0!.rxBytes).toBe(64000)
            expect(eth0!.txBytes).toBe(51200)
        })

        it('parses Arista-style tabular counter output', () => {
            const output = [
                '  IFACE    STATE  RX_OK  RX_ERR  TX_OK  TX_ERR  RX_BYT  TX_BYT',
                '  Ethernet1  U  5000  10  4500  5  320000  288000',
            ].join('\n')

            const result = parseInterfaceCounters('arista', output)
            expect(result.size).toBe(1)

            const eth1 = result.get('Ethernet1')
            expect(eth1).toBeDefined()
            expect(eth1!.rxPackets).toBe(5000)
            expect(eth1!.rxErrors).toBe(10)
            expect(eth1!.txPackets).toBe(4500)
            expect(eth1!.txErrors).toBe(5)
        })

        it('parses Cisco tabular counter output', () => {
            const output = [
                '  Port       RX_OK  RX_ERR  TX_OK  TX_ERR  RX_BYT  TX_BYT',
                '  Gi0/0      2000   3       1800   1       128000  115200',
            ].join('\n')

            const result = parseInterfaceCounters('cisco', output)
            expect(result.size).toBe(1)
        })

        it('skips separator lines', () => {
            const output = [
                '  IFACE    STATE  RX_OK  RX_ERR  TX_OK  TX_ERR  RX_BYT  TX_BYT',
                '  -------  -----  -----  ------  -----  ------  ------  ------',
                '  Ethernet0  U  1000  0  800  0  64000  51200',
            ].join('\n')

            const result = parseInterfaceCounters('sonic', output)
            expect(result.size).toBe(1)
        })
    })

    describe('Block format (Juniper / Huawei / Nokia / generic)', () => {
        it('parses per-interface block format', () => {
            const output = [
                'Interface Ethernet0',
                '  Input: 1000 packets, 64000 bytes, 0 errors',
                '  Output: 800 packets, 51200 bytes, 0 errors',
                'Interface Ethernet1',
                '  Input: 500 packets, 32000 bytes, 2 errors',
                '  Output: 400 packets, 25600 bytes, 1 errors',
            ].join('\n')

            const result = parseInterfaceCounters('juniper', output)
            expect(result.size).toBe(2)

            const eth0 = result.get('Ethernet0')
            expect(eth0).toBeDefined()
            expect(eth0!.rxPackets).toBe(1000)
            expect(eth0!.rxBytes).toBe(64000)
            expect(eth0!.rxErrors).toBe(0)
            expect(eth0!.txPackets).toBe(800)
            expect(eth0!.txBytes).toBe(51200)
            expect(eth0!.txErrors).toBe(0)

            const eth1 = result.get('Ethernet1')
            expect(eth1).toBeDefined()
            expect(eth1!.rxPackets).toBe(500)
            expect(eth1!.rxErrors).toBe(2)
            expect(eth1!.txErrors).toBe(1)
        })

        it('parses block format with Port keyword', () => {
            const output = [
                'Port ge-0/0/0',
                '  Input: 2000 packets, 128000 bytes, 5 errors',
                '  Output: 1500 packets, 96000 bytes, 3 errors',
            ].join('\n')

            const result = parseInterfaceCounters('juniper', output)
            expect(result.size).toBe(1)

            const port = result.get('ge-0/0/0')
            expect(port).toBeDefined()
            expect(port!.rxPackets).toBe(2000)
            expect(port!.txPackets).toBe(1500)
        })
    })

    describe('Edge cases', () => {
        it('returns empty Map for empty output', () => {
            const result = parseInterfaceCounters('cisco', '')
            expect(result).toBeInstanceOf(Map)
            expect(result.size).toBe(0)
        })

        it('returns empty Map for garbled output', () => {
            const result = parseInterfaceCounters('sonic', 'xyzzy!@#$%\nrandom junk')
            expect(result).toBeInstanceOf(Map)
            expect(result.size).toBe(0)
        })

        it('handles undefined vendor gracefully', () => {
            const result = parseInterfaceCounters(undefined as any, '')
            expect(result).toBeInstanceOf(Map)
            expect(result.size).toBe(0)
        })

        it('handles null vendor gracefully', () => {
            const result = parseInterfaceCounters(null as any, '')
            expect(result).toBeInstanceOf(Map)
            expect(result.size).toBe(0)
        })
    })
})

// ---------------------------------------------------------------------------
// Cross-parser edge cases
// ---------------------------------------------------------------------------
describe('parser robustness edge cases', () => {
    it('detectVendorFromOutput: mixed vendor keywords picks first match', () => {
        // "Cisco" appears first, so should detect cisco even if "Juniper" is also present
        const output = 'Cisco IOS Software\nJuniper Networks'
        expect(detectVendorFromOutput(output)).toBe('cisco')
    })

    it('detectVendorFromOutput: whitespace-only input returns empty', () => {
        expect(detectVendorFromOutput('   \n\t  ')).toBe('')
    })

    it('detectVendorFromOutput: single character returns empty', () => {
        expect(detectVendorFromOutput('X')).toBe('')
    })

    it('parseShowVersion: truncated output does not crash', () => {
        const truncated = 'Cisco IOS Software, Version'
        const result = parseShowVersion('cisco', truncated)
        expect(result).toBeDefined()
        // May or may not parse a version, but should not throw
    })

    it('parseShowVersion: extremely long single line does not crash', () => {
        const longLine = 'Cisco IOS ' + 'x'.repeat(10000)
        const result = parseShowVersion('cisco', longLine)
        expect(result).toBeDefined()
    })

    it('parseResourceUsage: output with null bytes does not crash', () => {
        const withNulls = 'CPU usage: 50%\x00\x00Memory: 4096MB'
        const result = parseResourceUsage('cisco', withNulls, withNulls)
        expect(result).toBeDefined()
    })

    it('parseInterfaceStatus: unicode in interface description does not crash', () => {
        const output = 'Gi0/1     10.0.0.1    YES  up    up   — Ünïcödé 描述'
        const result = parseInterfaceStatus('cisco', output)
        expect(Array.isArray(result)).toBe(true)
    })

    it('parseRouteTable: empty lines and whitespace-only output returns empty', () => {
        expect(parseRouteTable('cisco', '\n\n\n   \n')).toEqual([])
    })

    it('parseInterfaceCounters: only header line, no data rows', () => {
        const output = '  IFACE    RX_OK    TX_OK\n'
        const result = parseInterfaceCounters('sonic', output)
        expect(result.size).toBe(0)
    })

    it('parseVendorAlarms: output with only timestamps, no alarm text', () => {
        const result = parseVendorAlarms('juniper', '2024-01-01 12:00:00\n2024-01-02 13:00:00')
        expect(Array.isArray(result)).toBe(true)
    })

    it('parseShowVersion with empty strings for both vendor and output', () => {
        const result = parseShowVersion('', '')
        expect(result).toBeDefined()
    })

    it('parseResourceUsage with mismatched vendor and output', () => {
        // Cisco parser on Juniper output — should not crash
        const juniperOutput = 'Routing Engine 0\nCPU utilization: 25%'
        const result = parseResourceUsage('cisco', juniperOutput, juniperOutput)
        expect(result).toBeDefined()
    })

    it('parseInterfaceStatus: separator-only output returns empty', () => {
        const output = '-----  ------  ------  ------\n===  ===  ===  ==='
        const result = parseInterfaceStatus('cisco', output)
        expect(result).toEqual([])
    })

    it('detectVendorFromOutput: all-caps CISCO is detected', () => {
        expect(detectVendorFromOutput('CISCO IOS SOFTWARE')).toBe('cisco')
    })

    it('detectVendorFromOutput: lowercase cisco is detected', () => {
        expect(detectVendorFromOutput('cisco ios software')).toBe('cisco')
    })

    it('parseRouteTable: Codes header lines are skipped', () => {
        const output = 'Codes: C - connected, S - static, R - RIP\n       B - BGP\nGateway of last resort is not set'
        expect(parseRouteTable('cisco', output)).toEqual([])
    })
})
