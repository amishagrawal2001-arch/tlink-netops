// ═══════════════════════════════════════════════════════════════════════════════
// Pure validation helpers for IPC handlers — no Electron/ssh2 runtime deps.
// Extracted so they can be unit-tested with Jest without pulling in Electron.
// ═══════════════════════════════════════════════════════════════════════════════

import type { ConnectConfig } from 'ssh2'

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface SshPayload {
    host: string
    port: number
    username: string
    password: string
    timeoutMs: number
}

export interface SshResult {
    ok: boolean
    message: string
    output?: string
}

export interface SshTerminalPayload {
    host: string
    port: number
    username: string
    password?: string    // Optional — when provided, SSH_ASKPASS is used for auth
}

export interface SshTerminalResult {
    ok: boolean
    message: string
}

// ── Validation functions ─────────────────────────────────────────────────────

export function _asPositiveInt (value: unknown): number | null {
    const num = typeof value === 'string' ? Number(value) : value
    if (typeof num !== 'number' || !Number.isFinite(num)) { return null }
    const n = Math.trunc(num)
    return n > 0 ? n : null
}

export function _parseSshPayload (raw: unknown): { ok: true; value: SshPayload } | { ok: false; message: string } {
    if (!raw || typeof raw !== 'object') { return { ok: false, message: 'Invalid SSH payload' } }
    const obj = raw as Record<string, unknown>

    const hostRaw = String(obj['host'] ?? '').trim()
    const host = hostRaw.split('/')[0].trim()
    if (!host) { return { ok: false, message: 'Management IP / host is required' } }

    const port = _asPositiveInt(obj['port']) ?? 22
    if (port < 1 || port > 65535) { return { ok: false, message: 'SSH port must be between 1 and 65535' } }

    const username = String(obj['username'] ?? '').trim()
    if (!username) { return { ok: false, message: 'SSH username is required' } }

    const password = String(obj['password'] ?? '')
    if (!password) { return { ok: false, message: 'SSH password is required' } }

    const timeoutRaw = _asPositiveInt(obj['timeoutMs']) ?? 8000
    const timeoutMs = Math.min(120000, Math.max(1000, timeoutRaw))

    return {
        ok: true,
        value: { host, port, username, password, timeoutMs },
    }
}

export function _parseSshTerminalPayload (raw: unknown): { ok: true; value: SshTerminalPayload } | { ok: false; message: string } {
    if (!raw || typeof raw !== 'object') { return { ok: false, message: 'Invalid SSH terminal payload' } }
    const obj = raw as Record<string, unknown>

    const hostRaw = String(obj['host'] ?? '').trim()
    const host = hostRaw.split('/')[0].trim()
    if (!host) { return { ok: false, message: 'Management IP / host is required' } }
    if (!/^[A-Za-z0-9._:-]+$/.test(host)) {
        return { ok: false, message: 'Host contains unsupported characters' }
    }

    const port = _asPositiveInt(obj['port']) ?? 22
    if (port < 1 || port > 65535) { return { ok: false, message: 'SSH port must be between 1 and 65535' } }

    const username = String(obj['username'] ?? '').trim()
    if (!username) { return { ok: false, message: 'SSH username is required' } }
    if (!/^[A-Za-z0-9._-]+$/.test(username)) {
        return { ok: false, message: 'SSH username contains unsupported characters' }
    }

    // Optional password (passed through to SSH_ASKPASS helper — not logged)
    const passwordRaw = obj['password']
    const password = typeof passwordRaw === 'string' && passwordRaw.length > 0 ? passwordRaw : undefined

    return { ok: true, value: { host, port, username, password } }
}

// ── Containerlab server profiles ─────────────────────────────────────────────

export interface ClabServerProfile {
    id: string
    name: string
    type: 'local' | 'ssh'
    host?: string
    port?: number
    username?: string
    password?: string
    remoteLabDir?: string
}

export interface ClabServerState {
    profiles: ClabServerProfile[]
    activeServerId: string
}

export interface ClabServerResourcesResult {
    ok: boolean
    cpu?: string
    memUsed?: string
    memTotal?: string
    diskUsed?: string
    diskTotal?: string
    containers?: number
    vms?: number
    kvm?: boolean
    message?: string
}

export interface ClabServerHeartbeatResult {
    ok: boolean
    latencyMs?: number
}

export const CLAB_SERVER_DEFAULT_STATE: ClabServerState = {
    profiles: [{ id: 'local', name: 'Local', type: 'local' }],
    activeServerId: 'local',
}

export function _connectConfig (payload: SshPayload): ConnectConfig {
    return {
        host: payload.host,
        port: payload.port,
        username: payload.username,
        password: payload.password,
        readyTimeout: payload.timeoutMs,
        keepaliveInterval: 0,
    }
}
