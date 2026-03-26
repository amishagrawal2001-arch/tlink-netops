// ═══════════════════════════════════════════════════════════════════════════════
// SNMP helpers — pure validation function tests
// ═══════════════════════════════════════════════════════════════════════════════

import { _parseSnmpPayload } from '../app/src/snmp-helpers'

describe('_parseSnmpPayload', () => {
    // ── Invalid / missing payloads ───────────────────────────────────────

    test('null returns error', () => {
        const r = _parseSnmpPayload(null)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/non-null object/)
    })

    test('undefined returns error', () => {
        const r = _parseSnmpPayload(undefined)
        expect(r.ok).toBe(false)
    })

    test('string returns error', () => {
        const r = _parseSnmpPayload('hello')
        expect(r.ok).toBe(false)
    })

    test('empty object returns error (missing version)', () => {
        const r = _parseSnmpPayload({})
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/version/)
    })

    test('invalid version returns error', () => {
        const r = _parseSnmpPayload({ version: '1' })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/version/)
    })

    // ── Host validation ──────────────────────────────────────────────────

    test('missing host returns error', () => {
        const r = _parseSnmpPayload({ version: '2c', community: 'public' })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/host/)
    })

    test('invalid IP returns error', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '999.999.999.999', community: 'public' })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/host/)
    })

    test('valid IP is accepted', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '192.168.1.1', community: 'public' })
        expect(r.ok).toBe(true)
    })

    test('valid hostname is accepted', () => {
        const r = _parseSnmpPayload({ version: '2c', host: 'router-1.lab.local', community: 'public' })
        expect(r.ok).toBe(true)
    })

    // ── Port validation ──────────────────────────────────────────────────

    test('default port is 161', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '10.0.0.1', community: 'public' })
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value.port).toBe(161)
    })

    test('custom port is accepted', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '10.0.0.1', community: 'public', port: 1161 })
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value.port).toBe(1161)
    })

    test('port 0 returns error', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '10.0.0.1', community: 'pub', port: 0 })
        expect(r.ok).toBe(false)
    })

    test('port > 65535 returns error', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '10.0.0.1', community: 'pub', port: 70000 })
        expect(r.ok).toBe(false)
    })

    // ── Timeout validation ───────────────────────────────────────────────

    test('default timeout is 5000', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '10.0.0.1', community: 'public' })
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value.timeoutMs).toBe(5000)
    })

    test('timeout below 500 returns error', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '10.0.0.1', community: 'pub', timeoutMs: 100 })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/timeout/)
    })

    // ── v2c specifics ────────────────────────────────────────────────────

    test('v2c missing community returns error', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '10.0.0.1' })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/community/)
    })

    test('v2c empty community returns error', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '10.0.0.1', community: '  ' })
        expect(r.ok).toBe(false)
    })

    test('v2c valid payload returns structured result', () => {
        const r = _parseSnmpPayload({ version: '2c', host: '10.0.0.1', community: 'public', port: 161, timeoutMs: 5000 })
        expect(r.ok).toBe(true)
        if (r.ok) {
            expect(r.value.version).toBe('2c')
            expect(r.value.host).toBe('10.0.0.1')
            expect(r.value.port).toBe(161)
            expect((r.value as any).community).toBe('public')
        }
    })

    // ── v3 specifics ─────────────────────────────────────────────────────

    test('v3 missing username returns error', () => {
        const r = _parseSnmpPayload({ version: '3', host: '10.0.0.1' })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/username/)
    })

    test('v3 noAuthNoPriv is valid', () => {
        const r = _parseSnmpPayload({ version: '3', host: '10.0.0.1', username: 'admin' })
        expect(r.ok).toBe(true)
        if (r.ok) {
            expect(r.value.version).toBe('3')
            expect((r.value as any).username).toBe('admin')
        }
    })

    test('v3 authProtocol requires password ≥ 8 chars', () => {
        const r = _parseSnmpPayload({ version: '3', host: '10.0.0.1', username: 'admin', authProtocol: 'sha', authPassword: 'short' })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/8 characters/)
    })

    test('v3 valid auth with sha', () => {
        const r = _parseSnmpPayload({
            version: '3', host: '10.0.0.1', username: 'admin',
            authProtocol: 'sha', authPassword: 'longpassword123',
        })
        expect(r.ok).toBe(true)
        if (r.ok) expect((r.value as any).authProtocol).toBe('sha')
    })

    test('v3 privProtocol requires authProtocol', () => {
        const r = _parseSnmpPayload({
            version: '3', host: '10.0.0.1', username: 'admin',
            privProtocol: 'aes', privPassword: 'longpassword123',
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/authProtocol/)
    })

    test('v3 valid authPriv payload', () => {
        const r = _parseSnmpPayload({
            version: '3', host: '10.0.0.1', username: 'admin',
            authProtocol: 'sha', authPassword: 'longpassword123',
            privProtocol: 'aes', privPassword: 'privkey12345678',
        })
        expect(r.ok).toBe(true)
        if (r.ok) {
            expect((r.value as any).authProtocol).toBe('sha')
            expect((r.value as any).privProtocol).toBe('aes')
        }
    })

    test('v3 invalid authProtocol returns error', () => {
        const r = _parseSnmpPayload({
            version: '3', host: '10.0.0.1', username: 'admin',
            authProtocol: 'sha256',
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/authProtocol/)
    })

    test('v3 invalid privProtocol returns error', () => {
        const r = _parseSnmpPayload({
            version: '3', host: '10.0.0.1', username: 'admin',
            authProtocol: 'sha', authPassword: 'longpassword123',
            privProtocol: '3des',
        })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.message).toMatch(/privProtocol/)
    })
})
