// ═══════════════════════════════════════════════════════════════════════════════
// Syslog UDP server — receives RFC 3164 syslog messages on a configurable port.
// Default port is 1514 (not 514) to avoid requiring root/admin privileges.
// ═══════════════════════════════════════════════════════════════════════════════

import * as dgram from 'dgram'

// ── Types ────────────────────────────────────────────────────────────────────

export type SyslogSeverity =
    | 'emergency' | 'alert' | 'critical' | 'error'
    | 'warning' | 'notice' | 'informational' | 'debug'

export type SyslogFacility =
    | 'kern' | 'user' | 'mail' | 'daemon' | 'auth' | 'syslog'
    | 'lpr' | 'news' | 'uucp' | 'cron' | 'authpriv' | 'ftp'
    | 'ntp' | 'security' | 'console' | 'solaris-cron'
    | 'local0' | 'local1' | 'local2' | 'local3'
    | 'local4' | 'local5' | 'local6' | 'local7'

export interface SyslogMessage {
    facility: SyslogFacility
    severity: SyslogSeverity
    timestamp: string       // ISO 8601
    hostname: string
    message: string
    sourceIp: string
    raw: string
}

// ── Severity & Facility lookup tables ────────────────────────────────────────

const SEVERITIES: SyslogSeverity[] = [
    'emergency', 'alert', 'critical', 'error',
    'warning', 'notice', 'informational', 'debug',
]

const FACILITIES: SyslogFacility[] = [
    'kern', 'user', 'mail', 'daemon', 'auth', 'syslog',
    'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp',
    'ntp', 'security', 'console', 'solaris-cron',
    'local0', 'local1', 'local2', 'local3',
    'local4', 'local5', 'local6', 'local7',
]

// ── RFC 3164 month abbreviations ─────────────────────────────────────────────

const MONTHS: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

// ── RFC 3164 Parser ──────────────────────────────────────────────────────────

/**
 * Parse a raw syslog line into structured fields.
 *
 * Format: <PRI>TIMESTAMP HOSTNAME MESSAGE
 * Example: <134>Jan 12 10:45:33 router1 %SYS-5-CONFIG_I: Configured from console
 */
export function parseSyslogMessage (raw: string, sourceIp: string): SyslogMessage {
    let facility: SyslogFacility = 'user'
    let severity: SyslogSeverity = 'informational'
    let remaining = raw

    // 1. Extract PRI
    const priMatch = raw.match(/^<(\d{1,3})>(.*)/)
    if (priMatch) {
        const pri = Number(priMatch[1])
        const facIndex = pri >> 3
        const sevIndex = pri & 7
        facility = FACILITIES[facIndex] ?? 'user'
        severity = SEVERITIES[sevIndex] ?? 'informational'
        remaining = priMatch[2]
    }

    // 2. Extract timestamp (RFC 3164: "Jan 12 10:45:33" or "Jan  1 10:45:33")
    let timestamp = new Date().toISOString()
    let hostname = sourceIp
    let message = remaining.trim()

    const tsMatch = remaining.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(.*)/)
    if (tsMatch) {
        const month = MONTHS[tsMatch[1]]
        if (month !== undefined) {
            const day = Number(tsMatch[2])
            const hour = Number(tsMatch[3])
            const min = Number(tsMatch[4])
            const sec = Number(tsMatch[5])
            const now = new Date()
            const parsed = new Date(now.getFullYear(), month, day, hour, min, sec)
            // If parsed date is in the future, assume previous year
            if (parsed > now) { parsed.setFullYear(now.getFullYear() - 1) }
            timestamp = parsed.toISOString()
        }
        remaining = tsMatch[6]

        // 3. Extract hostname (next token before message)
        const hostMatch = remaining.match(/^(\S+)\s+(.*)/)
        if (hostMatch) {
            hostname = hostMatch[1]
            message = hostMatch[2]
        } else {
            message = remaining
        }
    }

    return { facility, severity, timestamp, hostname, message: message.trim(), sourceIp, raw }
}

// ── Server state ─────────────────────────────────────────────────────────────

let _server: dgram.Socket | null = null
let _running = false

export function isSyslogServerRunning (): boolean {
    return _running
}

export function startSyslogServer (
    port: number,
    callback: (msg: SyslogMessage) => void,
): { ok: boolean; message: string } {
    if (_running) {
        return { ok: false, message: 'Syslog server is already running' }
    }

    try {
        _server = dgram.createSocket('udp4')

        _server.on('message', (buf, rinfo) => {
            const raw = buf.toString('utf8').trim()
            if (!raw) { return }
            const msg = parseSyslogMessage(raw, rinfo.address)
            callback(msg)
        })

        _server.on('error', (err) => {
            console.error('[syslog] Server error:', err.message)
            stopSyslogServer()
        })

        _server.bind(port, () => {
            _running = true
            console.log(`[syslog] Listening on UDP port ${port}`)
        })

        _running = true
        return { ok: true, message: `Syslog server started on UDP port ${port}` }
    } catch (err) {
        return { ok: false, message: `Failed to start syslog server: ${(err as Error).message}` }
    }
}

export function stopSyslogServer (): { ok: boolean; message: string } {
    if (!_running || !_server) {
        return { ok: false, message: 'Syslog server is not running' }
    }

    try {
        _server.close()
        _server = null
        _running = false
        return { ok: true, message: 'Syslog server stopped' }
    } catch (err) {
        _server = null
        _running = false
        return { ok: false, message: `Error stopping syslog server: ${(err as Error).message}` }
    }
}
