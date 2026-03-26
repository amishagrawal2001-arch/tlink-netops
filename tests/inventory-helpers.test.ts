import {
    normalizeIfName,
    interfaceNamesMatch,
    globMatch,
} from '../renderer/src/services/inventory-helpers'

// ---------------------------------------------------------------------------
// normalizeIfName
// ---------------------------------------------------------------------------
describe('normalizeIfName', () => {
    it('expands Gi0/1 to gigabitethernet0/1', () => {
        expect(normalizeIfName('Gi0/1')).toBe('gigabitethernet0/1')
    })

    it('lowercases GigabitEthernet0/1', () => {
        expect(normalizeIfName('GigabitEthernet0/1')).toBe('gigabitethernet0/1')
    })

    it('expands Te0/1 to tengigabitethernet0/1', () => {
        expect(normalizeIfName('Te0/1')).toBe('tengigabitethernet0/1')
    })

    it('expands Fa0/1 to fastethernet0/1', () => {
        expect(normalizeIfName('Fa0/1')).toBe('fastethernet0/1')
    })

    it('expands Eth0 to ethernet0', () => {
        expect(normalizeIfName('Eth0')).toBe('ethernet0')
    })

    it('expands Po1 to port-channel1', () => {
        expect(normalizeIfName('Po1')).toBe('port-channel1')
    })

    it('passes through Juniper-style et-0/0/0 unchanged (lowercase)', () => {
        expect(normalizeIfName('et-0/0/0')).toBe('et-0/0/0')
    })

    it('strips whitespace', () => {
        expect(normalizeIfName('  Gi0/1  ')).toBe('gigabitethernet0/1')
    })

    it('handles all-uppercase GI0/1', () => {
        expect(normalizeIfName('GI0/1')).toBe('gigabitethernet0/1')
    })

    it('passes through Loopback0 (no abbreviation match)', () => {
        expect(normalizeIfName('Loopback0')).toBe('loopback0')
    })

    it('returns empty string for empty input', () => {
        expect(normalizeIfName('')).toBe('')
    })

    it('does not expand "Gift" (no digit after gi)', () => {
        expect(normalizeIfName('Gift')).toBe('gift')
    })

    it('expands Po10 to port-channel10', () => {
        expect(normalizeIfName('Po10')).toBe('port-channel10')
    })

    it('handles Te1/0/1 with subinterface', () => {
        expect(normalizeIfName('Te1/0/1')).toBe('tengigabitethernet1/0/1')
    })

    it('preserves Nokia-style ethernet-1/1', () => {
        expect(normalizeIfName('ethernet-1/1')).toBe('ethernet-1/1')
    })
})

// ---------------------------------------------------------------------------
// interfaceNamesMatch
// ---------------------------------------------------------------------------
describe('interfaceNamesMatch', () => {
    it('matches Gi0/1 with GigabitEthernet0/1', () => {
        expect(interfaceNamesMatch('Gi0/1', 'GigabitEthernet0/1')).toBe(true)
    })

    it('does NOT match et-0/0/1 with et-0/0/10 (exact comparison)', () => {
        expect(interfaceNamesMatch('et-0/0/1', 'et-0/0/10')).toBe(false)
    })

    it('matches same name with different case', () => {
        expect(interfaceNamesMatch('LOOPBACK0', 'loopback0')).toBe(true)
    })

    it('matches with extra whitespace', () => {
        expect(interfaceNamesMatch('  Gi0/1 ', 'Gi0/1')).toBe(true)
    })

    it('does NOT match completely different interfaces', () => {
        expect(interfaceNamesMatch('Gi0/1', 'Te0/1')).toBe(false)
    })

    it('matches Te0/1 with TenGigabitEthernet0/1', () => {
        expect(interfaceNamesMatch('Te0/1', 'TenGigabitEthernet0/1')).toBe(true)
    })

    it('matches Po1 with Port-Channel1', () => {
        expect(interfaceNamesMatch('Po1', 'Port-Channel1')).toBe(true)
    })

    it('matches empty strings', () => {
        expect(interfaceNamesMatch('', '')).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// globMatch
// ---------------------------------------------------------------------------
describe('globMatch', () => {
    it('empty pattern matches anything', () => {
        expect(globMatch('', 'anything')).toBe(true)
    })

    it('"*" matches anything', () => {
        expect(globMatch('*', 'GigabitEthernet0/1')).toBe(true)
    })

    it('exact string matches', () => {
        expect(globMatch('hello', 'hello')).toBe(true)
    })

    it('exact string does not match different value', () => {
        expect(globMatch('hello', 'world')).toBe(false)
    })

    it('"Gi*" matches Gi0/1', () => {
        expect(globMatch('Gi*', 'Gi0/1')).toBe(true)
    })

    it('"Gi*" matches GigabitEthernet0/1', () => {
        expect(globMatch('Gi*', 'GigabitEthernet0/1')).toBe(true)
    })

    it('"?i0/1" matches Gi0/1 (single char wildcard)', () => {
        expect(globMatch('?i0/1', 'Gi0/1')).toBe(true)
    })

    it('is case-insensitive', () => {
        expect(globMatch('HELLO', 'hello')).toBe(true)
    })

    it('"*.json" matches config.json', () => {
        expect(globMatch('*.json', 'config.json')).toBe(true)
    })

    it('"*.json" does not match config.yaml', () => {
        expect(globMatch('*.json', 'config.yaml')).toBe(false)
    })

    it('multiple wildcards: "*eth*" matches GigabitEthernet0/1', () => {
        expect(globMatch('*eth*', 'GigabitEthernet0/1')).toBe(true)
    })

    it('"test?" matches "test1" but not "test10"', () => {
        expect(globMatch('test?', 'test1')).toBe(true)
        expect(globMatch('test?', 'test10')).toBe(false)
    })
})
