// ═══════════════════════════════════════════════════════════════════════════════
// Pure SNMP validation/parsing helpers — no Electron dependencies.
// Extracted so they can be unit-tested with Jest without pulling in Electron.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Types ────────────────────────────────────────────────────────────────────

export interface SnmpV2cPayload {
    version: '2c'
    host: string
    port: number
    community: string
    timeoutMs: number
}

export interface SnmpV3Payload {
    version: '3'
    host: string
    port: number
    username: string
    authProtocol?: 'md5' | 'sha'
    authPassword?: string
    privProtocol?: 'des' | 'aes'
    privPassword?: string
    timeoutMs: number
}

export type SnmpPayload = SnmpV2cPayload | SnmpV3Payload

export interface SnmpVarbind {
    oid: string
    type: string
    value: string
}

export interface SnmpResult {
    ok: boolean
    message: string
    data?: SnmpVarbind[]
}

// ── Validation ───────────────────────────────────────────────────────────────

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const HOSTNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-]{0,253}[a-zA-Z0-9]$/

function isValidHost (h: string): boolean {
    if (!h) { return false }
    if (IP_RE.test(h)) {
        return h.split('.').every(p => { const n = Number(p); return n >= 0 && n <= 255 })
    }
    return HOSTNAME_RE.test(h)
}

function isValidPort (p: number): boolean {
    return Number.isInteger(p) && p >= 1 && p <= 65535
}

export function _parseSnmpPayload (raw: unknown): { ok: true; value: SnmpPayload } | { ok: false; message: string } {
    if (!raw || typeof raw !== 'object') {
        return { ok: false, message: 'SNMP payload must be a non-null object' }
    }

    const obj = raw as Record<string, unknown>

    // Version
    const version = obj.version
    if (version !== '2c' && version !== '3') {
        return { ok: false, message: 'SNMP version must be "2c" or "3"' }
    }

    // Host
    const host = typeof obj.host === 'string' ? obj.host.trim() : ''
    if (!isValidHost(host)) {
        return { ok: false, message: 'Invalid SNMP host: must be a valid IP address or hostname' }
    }

    // Port
    const port = typeof obj.port === 'number' ? obj.port : 161
    if (!isValidPort(port)) {
        return { ok: false, message: 'Invalid SNMP port: must be 1–65535' }
    }

    // Timeout
    const timeoutMs = typeof obj.timeoutMs === 'number' ? obj.timeoutMs : 5000
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60000) {
        return { ok: false, message: 'SNMP timeout must be between 500 and 60000 ms' }
    }

    if (version === '2c') {
        const community = typeof obj.community === 'string' ? obj.community.trim() : ''
        if (!community) {
            return { ok: false, message: 'SNMP v2c requires a community string' }
        }
        return { ok: true, value: { version: '2c', host, port, community, timeoutMs } }
    }

    // v3
    const username = typeof obj.username === 'string' ? obj.username.trim() : ''
    if (!username) {
        return { ok: false, message: 'SNMP v3 requires a username' }
    }

    const authProtocol = obj.authProtocol as string | undefined
    if (authProtocol !== undefined && authProtocol !== 'md5' && authProtocol !== 'sha') {
        return { ok: false, message: 'SNMP v3 authProtocol must be "md5" or "sha"' }
    }

    const authPassword = typeof obj.authPassword === 'string' ? obj.authPassword : undefined
    if (authProtocol && (!authPassword || authPassword.length < 8)) {
        return { ok: false, message: 'SNMP v3 authPassword must be at least 8 characters when authProtocol is set' }
    }

    const privProtocol = obj.privProtocol as string | undefined
    if (privProtocol !== undefined && privProtocol !== 'des' && privProtocol !== 'aes') {
        return { ok: false, message: 'SNMP v3 privProtocol must be "des" or "aes"' }
    }

    const privPassword = typeof obj.privPassword === 'string' ? obj.privPassword : undefined
    if (privProtocol && (!privPassword || privPassword.length < 8)) {
        return { ok: false, message: 'SNMP v3 privPassword must be at least 8 characters when privProtocol is set' }
    }

    if (privProtocol && !authProtocol) {
        return { ok: false, message: 'SNMP v3 privProtocol requires authProtocol to be set' }
    }

    return {
        ok: true,
        value: {
            version: '3', host, port, username, timeoutMs,
            ...(authProtocol ? { authProtocol: authProtocol as 'md5' | 'sha', authPassword } : {}),
            ...(privProtocol ? { privProtocol: privProtocol as 'des' | 'aes', privPassword } : {}),
        },
    }
}
