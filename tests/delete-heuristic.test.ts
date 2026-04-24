// ═══════════════════════════════════════════════════════════════════════════════
// Tests for delete-heuristic (vendor-aware top-of-hierarchy delete derivation)
// ═══════════════════════════════════════════════════════════════════════════════

import { deriveDeletesFromConfig, detectMgmtInterfaces, JUNIPER_TOP_DEPTH } from '../renderer/src/services/delete-heuristic'

describe('deriveDeletesFromConfig — Juniper-style', () => {

    it('returns empty array for empty config', () => {
        expect(deriveDeletesFromConfig('', 'juniper')).toEqual([])
    })

    it('returns empty array when there are no set lines', () => {
        const config = `
            # comments
            // more comments

            something that is not a set line
        `
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual([])
    })

    it('one-token container: interfaces → delete interfaces', () => {
        const config = 'set interfaces et-0/0/9 unit 0 family inet address 10.0.0.41/30'
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual(['delete interfaces'])
    })

    it('two-token container: protocols → delete protocols <sub>', () => {
        const config = 'set protocols lldp interface all'
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual(['delete protocols lldp'])
    })

    it('two-token container: system → delete system <sub>', () => {
        const config = 'set system ntp server 10.0.0.254'
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual(['delete system ntp'])
    })

    it('matches the user-specified canonical example', () => {
        const config = [
            'set interfaces et-0/0/9 unit 0 family inet address 10.0.0.41/30',
            'set protocols lldp interface all',
            'set system ntp server 10.0.0.254',
        ].join('\n')
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual([
            'delete interfaces',
            'delete protocols lldp',
            'delete system ntp',
        ])
    })

    it('dedupes multiple set lines under the same container', () => {
        const config = [
            'set interfaces et-0/0/1 unit 0 family inet address 1.1.1.1/30',
            'set interfaces et-0/0/2 unit 0 family inet address 2.2.2.2/30',
            'set interfaces lo0 unit 0 family inet address 9.9.9.9/32',
        ].join('\n')
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual(['delete interfaces'])
    })

    it('dedupes under two-token containers', () => {
        const config = [
            'set protocols bgp group UNDERLAY type external',
            'set protocols bgp group UNDERLAY peer-as 65100',
            'set protocols ospf area 0.0.0.0 interface et-0/0/1',
        ].join('\n')
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual([
            'delete protocols bgp',
            'delete protocols ospf',
        ])
    })

    it('preserves first-occurrence order', () => {
        const config = [
            'set system syslog file messages any info',
            'set protocols lldp interface all',
            'set system ntp server 10.0.0.254',      // should dedupe with syslog -> system
            'set interfaces em0 unit 0 family inet address 10.1.1.1/24',
        ].join('\n')
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual([
            'delete system syslog',
            'delete protocols lldp',
            'delete system ntp',
            'delete interfaces',
        ])
    })

    it('skips comment and blank lines', () => {
        const config = [
            '# a comment',
            '',
            '// another comment',
            'set system ntp server 10.0.0.254',
            '',
        ].join('\n')
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual(['delete system ntp'])
    })

    it('unknown containers default to 1-token delete', () => {
        const config = 'set unknown-thing widget 42'
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual(['delete unknown-thing'])
    })

    it('routing-options stays at depth 1', () => {
        const config = 'set routing-options router-id 1.1.1.1'
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual(['delete routing-options'])
    })

    it('depth map has no depth > 2', () => {
        for (const [k, v] of Object.entries(JUNIPER_TOP_DEPTH)) {
            expect(v).toBeGreaterThanOrEqual(1)
            expect(v).toBeLessThanOrEqual(2)
        }
    })

    it('handles trailing whitespace and mixed-case "SET"', () => {
        const config = [
            '  set system ntp server 10.0.0.254   ',
            'SET interfaces et-0/0/9 unit 0',
        ].join('\n')
        expect(deriveDeletesFromConfig(config, 'juniper')).toEqual([
            'delete system ntp',
            'delete interfaces',
        ])
    })
})

describe('deriveDeletesFromConfig — Cisco-style', () => {

    it('Cisco: uses "no" keyword + first token', () => {
        const config = [
            'interface GigabitEthernet0/0',
            'ip route 0.0.0.0 0.0.0.0 10.0.0.1',
        ].join('\n')
        // No `set ` prefix on Cisco configs → no deletes derived
        expect(deriveDeletesFromConfig(config, 'cisco')).toEqual([])
    })

    it('Cisco with "set" prefix (if someone formatted as set-style): uses "no"', () => {
        const config = [
            'set ip route 10.0.0.0 255.0.0.0 1.1.1.1',
            'set router bgp 65000',
            'set interface GigabitEthernet0/0',
        ].join('\n')
        expect(deriveDeletesFromConfig(config, 'cisco')).toEqual([
            'no ip',
            'no router',
            'no interface',
        ])
    })

    it('Arista uses "no" (Cisco-style)', () => {
        const config = 'set router bgp 65000'
        expect(deriveDeletesFromConfig(config, 'arista')).toEqual(['no router'])
    })

    it('nxos and ios variants also use "no"', () => {
        const config = 'set ip route 10.0.0.0 255.0.0.0 1.1.1.1'
        expect(deriveDeletesFromConfig(config, 'cisco-nxos')).toEqual(['no ip'])
        expect(deriveDeletesFromConfig(config, 'cisco-iosxr')).toEqual(['no ip'])
    })
})

describe('deriveDeletesFromConfig — management-interface safety rail', () => {

    const mgmtConfig = [
        'set interfaces em0 unit 0 family inet address 10.1.1.1/24',
        'set interfaces et-0/0/9 unit 0 family inet address 10.0.0.41/30',
        'set interfaces et-0/0/10 unit 0 family inet address 10.0.0.45/30',
    ].join('\n')

    it('without preserveInterfaces, emits `delete interfaces` (unsafe default)', () => {
        expect(deriveDeletesFromConfig(mgmtConfig, 'juniper')).toEqual(['delete interfaces'])
    })

    it('with preserveInterfaces = {em0}, emits per-port deletes that skip em0', () => {
        const deletes = deriveDeletesFromConfig(mgmtConfig, 'juniper', {
            preserveInterfaces: new Set(['em0']),
        })
        // em0 is preserved (no delete for it).
        // et-0/0/9 and et-0/0/10 get per-port deletes (whole-tree wipe avoided).
        expect(deletes).toEqual([
            'delete interfaces et-0/0/9',
            'delete interfaces et-0/0/10',
        ])
    })

    it('with preserveInterfaces matching ALL interfaces, emits zero interface deletes', () => {
        const deletes = deriveDeletesFromConfig(mgmtConfig, 'juniper', {
            preserveInterfaces: new Set(['em0', 'et-0/0/9', 'et-0/0/10']),
        })
        expect(deletes).toEqual([])  // all interfaces preserved, no deletes needed
    })

    it('preserveInterfaces only affects interfaces — other containers still get coarse deletes', () => {
        const config = [
            'set interfaces em0 unit 0 family inet address 10.1.1.1/24',
            'set interfaces et-0/0/9 unit 0',
            'set system ntp server 10.0.0.254',
            'set protocols bgp group UNDERLAY type external',
        ].join('\n')
        const deletes = deriveDeletesFromConfig(config, 'juniper', {
            preserveInterfaces: new Set(['em0']),
        })
        expect(deletes).toEqual([
            'delete interfaces et-0/0/9',   // per-port (em0 preserved)
            'delete system ntp',             // unaffected
            'delete protocols bgp',          // unaffected
        ])
    })

    it('empty preserveInterfaces set behaves like no protection', () => {
        const deletes = deriveDeletesFromConfig(mgmtConfig, 'juniper', {
            preserveInterfaces: new Set(),
        })
        expect(deletes).toEqual(['delete interfaces'])
    })

    it('case-insensitive interface matching', () => {
        const config = 'set interfaces EM0 unit 0 family inet address 10.1.1.1/24'
        const deletes = deriveDeletesFromConfig(config, 'juniper', {
            preserveInterfaces: new Set(['em0']),
        })
        expect(deletes).toEqual([])  // EM0 matches em0, no delete emitted
    })
})

describe('detectMgmtInterfaces', () => {

    it('always returns the canonical OOB defaults', () => {
        const result = detectMgmtInterfaces('')
        expect(result.has('em0')).toBe(true)
        expect(result.has('em1')).toBe(true)
        expect(result.has('fxp0')).toBe(true)
        expect(result.has('mgmt')).toBe(true)
    })

    it('finds the interface that matches the mgmt IP', () => {
        const config = [
            'set interfaces em0 unit 0 family inet address 10.1.1.1/24',
            'set interfaces et-0/0/9 unit 0 family inet address 10.0.0.41/30',
        ].join('\n')
        const result = detectMgmtInterfaces(config, '10.1.1.1')
        expect(result.has('em0')).toBe(true)
        expect(result.has('et-0/0/9')).toBe(false)
    })

    it('strips prefix length from mgmt IP', () => {
        const config = 'set interfaces fxp0 unit 0 family inet address 192.168.1.10/24'
        const result = detectMgmtInterfaces(config, '192.168.1.10/24')
        expect(result.has('fxp0')).toBe(true)
    })

    it('returns interface names in lowercase', () => {
        const config = 'set interfaces EM0 unit 0 family inet address 10.1.1.1/24'
        const result = detectMgmtInterfaces(config, '10.1.1.1')
        expect(result.has('em0')).toBe(true)   // normalized lowercase
    })

    it('handles empty / missing mgmtIp — still returns OOB defaults', () => {
        expect(detectMgmtInterfaces('config line', undefined).size).toBeGreaterThanOrEqual(4)
        expect(detectMgmtInterfaces('config line', '').size).toBeGreaterThanOrEqual(4)
    })
})
