// ═══════════════════════════════════════════════════════════════════════════════
// Syslog server — RFC 3164 parser tests
// ═══════════════════════════════════════════════════════════════════════════════

import { parseSyslogMessage, SyslogMessage } from '../app/src/syslog-server'

describe('parseSyslogMessage', () => {
    const SOURCE_IP = '192.168.1.1'

    // ── PRI parsing ──────────────────────────────────────────────────────

    test('extracts facility and severity from PRI', () => {
        // PRI 134 = facility 16 (local0) + severity 6 (informational)
        const msg = parseSyslogMessage('<134>Jan  5 10:30:00 router1 Test message', SOURCE_IP)
        expect(msg.facility).toBe('local0')
        expect(msg.severity).toBe('informational')
    })

    test('PRI 0 = kern.emergency', () => {
        const msg = parseSyslogMessage('<0>Jan  1 00:00:00 host msg', SOURCE_IP)
        expect(msg.facility).toBe('kern')
        expect(msg.severity).toBe('emergency')
    })

    test('PRI 11 = user.critical', () => {
        // facility 1 (user) * 8 + severity 3 (error) = 11
        const msg = parseSyslogMessage('<11>Jan  1 00:00:00 host msg', SOURCE_IP)
        expect(msg.facility).toBe('user')
        expect(msg.severity).toBe('error')
    })

    test('PRI 165 = local4.notice', () => {
        // facility 20 (local4) * 8 + severity 5 (notice) = 165
        const msg = parseSyslogMessage('<165>Jan  1 00:00:00 host msg', SOURCE_IP)
        expect(msg.facility).toBe('local4')
        expect(msg.severity).toBe('notice')
    })

    test('PRI 188 = local7.warning', () => {
        // facility 23 (local7) * 8 + severity 4 (warning) = 188
        const msg = parseSyslogMessage('<188>Jan  1 00:00:00 host msg', SOURCE_IP)
        expect(msg.facility).toBe('local7')
        expect(msg.severity).toBe('warning')
    })

    // ── Missing PRI fallback ─────────────────────────────────────────────

    test('no PRI defaults to user.informational', () => {
        const msg = parseSyslogMessage('Jan  1 00:00:00 host Something happened', SOURCE_IP)
        expect(msg.facility).toBe('user')
        expect(msg.severity).toBe('informational')
    })

    // ── Timestamp parsing ────────────────────────────────────────────────

    test('parses RFC 3164 timestamp', () => {
        const msg = parseSyslogMessage('<134>Mar  9 14:30:45 router1 test', SOURCE_IP)
        expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        const d = new Date(msg.timestamp)
        expect(d.getMonth()).toBe(2)  // March = 2
        expect(d.getDate()).toBe(9)
        expect(d.getHours()).toBe(14)
        expect(d.getMinutes()).toBe(30)
        expect(d.getSeconds()).toBe(45)
    })

    test('single-digit day with double space', () => {
        const msg = parseSyslogMessage('<134>Jan  5 10:00:00 host msg', SOURCE_IP)
        const d = new Date(msg.timestamp)
        expect(d.getDate()).toBe(5)
    })

    test('double-digit day', () => {
        const msg = parseSyslogMessage('<134>Dec 25 23:59:59 host msg', SOURCE_IP)
        const d = new Date(msg.timestamp)
        expect(d.getDate()).toBe(25)
        expect(d.getMonth()).toBe(11) // December
    })

    // ── Hostname extraction ──────────────────────────────────────────────

    test('extracts hostname from message', () => {
        const msg = parseSyslogMessage('<134>Jan  1 00:00:00 my-router %SYS-5-CONFIG_I: test', SOURCE_IP)
        expect(msg.hostname).toBe('my-router')
    })

    test('falls back to sourceIp when no hostname can be parsed', () => {
        const msg = parseSyslogMessage('raw message without structure', SOURCE_IP)
        expect(msg.hostname).toBe(SOURCE_IP)
    })

    // ── Message extraction ───────────────────────────────────────────────

    test('extracts message body', () => {
        const msg = parseSyslogMessage('<134>Jan  1 12:00:00 router1 %SYS-5-CONFIG_I: Configured from console', SOURCE_IP)
        expect(msg.message).toBe('%SYS-5-CONFIG_I: Configured from console')
    })

    test('preserves source IP', () => {
        const msg = parseSyslogMessage('<134>Jan  1 00:00:00 host msg', '10.20.30.40')
        expect(msg.sourceIp).toBe('10.20.30.40')
    })

    test('preserves raw message', () => {
        const raw = '<134>Jan  1 00:00:00 host Something happened'
        const msg = parseSyslogMessage(raw, SOURCE_IP)
        expect(msg.raw).toBe(raw)
    })

    // ── Edge cases ───────────────────────────────────────────────────────

    test('empty message after PRI', () => {
        const msg = parseSyslogMessage('<134>', SOURCE_IP)
        expect(msg.facility).toBe('local0')
        expect(msg.severity).toBe('informational')
    })

    test('very long message is preserved', () => {
        const longMsg = 'A'.repeat(5000)
        const raw = `<134>Jan  1 00:00:00 host ${longMsg}`
        const msg = parseSyslogMessage(raw, SOURCE_IP)
        expect(msg.message).toBe(longMsg)
    })

    test('message with special characters', () => {
        const msg = parseSyslogMessage('<134>Jan  1 00:00:00 host BGP: peer 10.0.0.1 AS 65000 Up (prefix: 1500)', SOURCE_IP)
        expect(msg.message).toContain('BGP')
        expect(msg.message).toContain('AS 65000')
    })
})
