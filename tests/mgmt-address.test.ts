// ═══════════════════════════════════════════════════════════════════════════════
// Management address validator — accepts IPv4, IPv6, and RFC 1123 hostnames
// ═══════════════════════════════════════════════════════════════════════════════

import {
    isValidMgmtAddress, isValidIPv4, isValidIPv6, isValidHostname,
} from '../renderer/src/services/address-validators'

describe('isValidIPv4', () => {
    it.each([
        '10.0.0.1', '172.16.255.254', '192.168.1.100',
        '255.255.255.255', '0.0.0.0', '8.8.8.8',
    ])('accepts %s', (ip) => expect(isValidIPv4(ip)).toBe(true))

    it.each([
        '256.0.0.1', '10.0.0', '10.0.0.1.5',
        '10.0.0.', '.10.0.0.1', '10..0.0.1', '10.0.0.1/24',
    ])('rejects %s', (ip) => expect(isValidIPv4(ip)).toBe(false))
})

describe('isValidIPv6', () => {
    it.each([
        '::', '::1', 'fd00::1', 'fe80::1', '2001:db8::1',
        '2001:db8:1:2:3:4:5:6', '[fd00::1]', 'fe80::1%eth0',
    ])('accepts %s', (ip) => expect(isValidIPv6(ip)).toBe(true))

    it.each([
        'gggg::1', '2001:db8:1:2:3:4:5:6:7',
    ])('rejects %s', (ip) => expect(isValidIPv6(ip)).toBe(false))
})

describe('isValidHostname', () => {
    it.each([
        'router-1', 'spine-01.lab.local', 'leaf1',
        'my-host.example.com', 'host123', 'r0',
    ])('accepts %s', (host) => expect(isValidHostname(host)).toBe(true))

    it.each([
        '-hostname', 'hostname-', 'host name',
        'host@domain', 'host/name', '', '   ',
    ])('rejects %s', (host) => expect(isValidHostname(host)).toBe(false))

    it('rejects label > 63 chars', () => {
        expect(isValidHostname('a'.repeat(64))).toBe(false)
    })

    it('rejects total length > 253 chars', () => {
        const veryLong = Array(10).fill('a'.repeat(30)).join('.')
        expect(isValidHostname(veryLong)).toBe(false)
    })
})

describe('isValidMgmtAddress — combined', () => {
    it('accepts an IPv4 address', () => expect(isValidMgmtAddress('10.0.0.1')).toBe(true))
    it('accepts an IPv6 address', () => expect(isValidMgmtAddress('fd00::1')).toBe(true))
    it('accepts a hostname', () => expect(isValidMgmtAddress('spine-01.lab.local')).toBe(true))
    it('rejects empty string', () => expect(isValidMgmtAddress('')).toBe(false))
    it('rejects whitespace', () => expect(isValidMgmtAddress('   ')).toBe(false))
    it('rejects garbage', () => expect(isValidMgmtAddress('not valid!@#')).toBe(false))
})
