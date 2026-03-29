import {
    _asPositiveInt,
    _parseSshPayload,
    _parseSshTerminalPayload,
    _connectConfig,
    SshPayload,
} from '../app/src/ipc-helpers'
import { makeSshPayload, makeSshTerminalPayload } from './fixtures'

// ---------------------------------------------------------------------------
// _asPositiveInt
// ---------------------------------------------------------------------------
describe('_asPositiveInt', () => {
    it('returns 5 for input 5', () => {
        expect(_asPositiveInt(5)).toBe(5)
    })

    it('parses string "42" to 42', () => {
        expect(_asPositiveInt('42')).toBe(42)
    })

    it('truncates float 3.7 to 3', () => {
        expect(_asPositiveInt(3.7)).toBe(3)
    })

    it('returns null for 0', () => {
        expect(_asPositiveInt(0)).toBeNull()
    })

    it('returns null for negative number', () => {
        expect(_asPositiveInt(-5)).toBeNull()
    })

    it('returns null for NaN', () => {
        expect(_asPositiveInt(NaN)).toBeNull()
    })

    it('returns null for Infinity', () => {
        expect(_asPositiveInt(Infinity)).toBeNull()
    })

    it('returns null for null', () => {
        expect(_asPositiveInt(null)).toBeNull()
    })

    it('returns null for undefined', () => {
        expect(_asPositiveInt(undefined)).toBeNull()
    })

    it('returns null for empty string', () => {
        expect(_asPositiveInt('')).toBeNull()
    })

    it('returns null for non-numeric string "abc"', () => {
        expect(_asPositiveInt('abc')).toBeNull()
    })

    it('handles very large positive number', () => {
        expect(_asPositiveInt(999999)).toBe(999999)
    })
})

// ---------------------------------------------------------------------------
// _parseSshPayload
// ---------------------------------------------------------------------------
describe('_parseSshPayload', () => {
    it('parses valid complete payload', () => {
        const result = _parseSshPayload(makeSshPayload())
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.value.host).toBe('10.0.0.1')
            expect(result.value.port).toBe(22)
            expect(result.value.username).toBe('admin')
            expect(result.value.password).toBe('secret')
            expect(result.value.timeoutMs).toBe(8000)
        }
    })

    it('returns error for missing host', () => {
        const result = _parseSshPayload(makeSshPayload({ host: '' }))
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.message).toContain('host')
    })

    it('returns error for whitespace-only host', () => {
        const result = _parseSshPayload(makeSshPayload({ host: '   ' }))
        expect(result.ok).toBe(false)
    })

    it('strips CIDR suffix from host', () => {
        const result = _parseSshPayload(makeSshPayload({ host: '10.0.0.1/24' }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.host).toBe('10.0.0.1')
    })

    it('returns error for missing username', () => {
        const result = _parseSshPayload(makeSshPayload({ username: '' }))
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.message).toContain('username')
    })

    it('returns error for missing password', () => {
        const result = _parseSshPayload(makeSshPayload({ password: '' }))
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.message).toContain('password')
    })

    it('defaults port to 22 when omitted', () => {
        const result = _parseSshPayload(makeSshPayload({ port: undefined }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.port).toBe(22)
    })

    it('accepts port 65535', () => {
        const result = _parseSshPayload(makeSshPayload({ port: 65535 }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.port).toBe(65535)
    })

    it('accepts port 1', () => {
        const result = _parseSshPayload(makeSshPayload({ port: 1 }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.port).toBe(1)
    })

    it('defaults timeout to 8000ms when omitted', () => {
        const result = _parseSshPayload(makeSshPayload({ timeoutMs: undefined }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.timeoutMs).toBe(8000)
    })

    it('clamps timeout to min 1000ms', () => {
        const result = _parseSshPayload(makeSshPayload({ timeoutMs: 100 }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.timeoutMs).toBe(1000)
    })

    it('clamps timeout to max 120000ms', () => {
        const result = _parseSshPayload(makeSshPayload({ timeoutMs: 999999 }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.timeoutMs).toBe(120000)
    })

    it('returns error for null input', () => {
        expect(_parseSshPayload(null).ok).toBe(false)
    })

    it('returns error for undefined input', () => {
        expect(_parseSshPayload(undefined).ok).toBe(false)
    })

    it('returns error for non-object input (string)', () => {
        expect(_parseSshPayload('hello').ok).toBe(false)
    })

    it('returns error for non-object input (number)', () => {
        expect(_parseSshPayload(42).ok).toBe(false)
    })

    it('trims username whitespace', () => {
        const result = _parseSshPayload(makeSshPayload({ username: '  admin  ' }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.username).toBe('admin')
    })

    it('accepts string port "22"', () => {
        const result = _parseSshPayload(makeSshPayload({ port: '22' }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.port).toBe(22)
    })
})

// ---------------------------------------------------------------------------
// _parseSshTerminalPayload
// ---------------------------------------------------------------------------
describe('_parseSshTerminalPayload', () => {
    it('parses valid payload', () => {
        const result = _parseSshTerminalPayload(makeSshTerminalPayload())
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.value.host).toBe('10.0.0.1')
            expect(result.value.port).toBe(22)
            expect(result.value.username).toBe('admin')
        }
    })

    it('returns error for missing host', () => {
        const result = _parseSshTerminalPayload(makeSshTerminalPayload({ host: '' }))
        expect(result.ok).toBe(false)
    })

    it('returns error for host with special characters', () => {
        const result = _parseSshTerminalPayload(makeSshTerminalPayload({ host: 'host;rm -rf' }))
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.message).toContain('unsupported characters')
    })

    it('accepts hostname with dots and colons', () => {
        const result = _parseSshTerminalPayload(makeSshTerminalPayload({ host: '2001:db8::1' }))
        expect(result.ok).toBe(true)
    })

    it('returns error for username with special characters', () => {
        const result = _parseSshTerminalPayload(makeSshTerminalPayload({ username: 'user;drop' }))
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.message).toContain('unsupported characters')
    })

    it('accepts username with hyphens and underscores', () => {
        const result = _parseSshTerminalPayload(makeSshTerminalPayload({ username: 'admin_user-01' }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.username).toBe('admin_user-01')
    })

    it('defaults port to 22 when omitted', () => {
        const result = _parseSshTerminalPayload(makeSshTerminalPayload({ port: undefined }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.port).toBe(22)
    })

    it('strips CIDR suffix from host', () => {
        const result = _parseSshTerminalPayload(makeSshTerminalPayload({ host: '172.16.0.1/24' }))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value.host).toBe('172.16.0.1')
    })

    it('returns error for null input', () => {
        expect(_parseSshTerminalPayload(null).ok).toBe(false)
    })

    it('returns error for missing username', () => {
        const result = _parseSshTerminalPayload(makeSshTerminalPayload({ username: '' }))
        expect(result.ok).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// _connectConfig
// ---------------------------------------------------------------------------
describe('_connectConfig', () => {
    const payload: SshPayload = {
        host: '192.168.1.1',
        port: 2222,
        username: 'root',
        password: 'toor',
        timeoutMs: 10000,
    }

    it('maps host correctly', () => {
        expect(_connectConfig(payload).host).toBe('192.168.1.1')
    })

    it('maps port correctly', () => {
        expect(_connectConfig(payload).port).toBe(2222)
    })

    it('maps username and password', () => {
        const cfg = _connectConfig(payload)
        expect(cfg.username).toBe('root')
        expect(cfg.password).toBe('toor')
    })

    it('sets readyTimeout from timeoutMs', () => {
        expect(_connectConfig(payload).readyTimeout).toBe(10000)
    })

    it('sets keepaliveInterval to 0', () => {
        expect(_connectConfig(payload).keepaliveInterval).toBe(0)
    })
})
