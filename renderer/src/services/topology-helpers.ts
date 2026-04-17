// ═══════════════════════════════════════════════════════════════════════════════
// Pure helper functions for IP address manipulation — no Angular dependencies.
// Extracted so they can be unit-tested with Jest without pulling in @angular/core.
// ═══════════════════════════════════════════════════════════════════════════════

export function normIp (v?: string): string {
    const raw = (v ?? '').trim()
    if (!raw) { return '' }
    return raw.split('/')[0].trim()
}

export function ipToInt (ip: string): number | null {
    const parts = ip.split('.').map(p => Number(p))
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) { return null }
    return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0
}

export function intToIp (value: number): string {
    return [
        (value >>> 24) & 255,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255,
    ].join('.')
}

// ── IPv6 helpers ────────────────────────────────────────────────────────────

export function expandIPv6 (ip: string): number[] {
    // Expand :: notation to full 8-group array of 16-bit values
    const halves = ip.split('::')
    const left = halves[0] ? halves[0].split(':').map(h => parseInt(h, 16)) : []
    const right = halves.length > 1 && halves[1] ? halves[1].split(':').map(h => parseInt(h, 16)) : []
    const fill = 8 - left.length - right.length
    return [...left, ...Array(Math.max(0, fill)).fill(0), ...right]
}

export function formatIPv6WithOffset (base: number[], offset: number): string {
    // Add offset to the last 32 bits of the address
    const parts = [...base]
    let carry = offset
    for (let i = 7; i >= 0 && carry > 0; i--) {
        const sum = parts[i] + carry
        parts[i] = sum & 0xffff
        carry = sum >>> 16
    }
    // Compress to shortest form
    const hex = parts.map(p => p.toString(16))
    // Find longest run of zeros for :: compression
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0
    for (let i = 0; i < 8; i++) {
        if (hex[i] === '0') {
            if (curStart === -1) { curStart = i; curLen = 1 } else { curLen += 1 }
            if (curLen > bestLen) { bestStart = curStart; bestLen = curLen }
        } else {
            curStart = -1; curLen = 0
        }
    }
    if (bestLen >= 2) {
        const before = hex.slice(0, bestStart).join(':')
        const after = hex.slice(bestStart + bestLen).join(':')
        return `${before}::${after}`
    }
    return hex.join(':')
}

// ── Topology service helpers ─────────────────────────────────────────────────

export function normText (v?: string): string {
    return (v ?? '').trim().toLowerCase()
}

export function keepOrIncoming (incoming?: string, fallback?: string): string | undefined {
    const v = incoming?.trim()
    return v ? v : fallback
}

/**
 * Parse CIDR for host/management IP ranges.
 * Allows prefixes 0–32 (including /31 and /32 for point-to-point and host routes).
 * Compare with parseBaseCidr which restricts to /0–/30 for subnet-based addressing.
 */
export function parseHostCidr (cidr: string): { networkStart: number; networkEnd: number } {
    const [ipRaw, prefixRaw] = cidr.trim().split('/')
    const prefix = Number(prefixRaw)
    if (!ipRaw || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error('Subnet must be valid CIDR, /0 through /32 (example: 172.16.0.0/16)')
    }

    const ip = ipToInt(ipRaw)
    if (ip === null) { throw new Error('Invalid IPv4 subnet base') }

    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    const networkStart = (ip & mask) >>> 0
    const hostCount = Math.pow(2, 32 - prefix)
    const networkEnd = networkStart + hostCount - 1
    return { networkStart, networkEnd }
}

// ── Subnet CIDR parsing ─────────────────────────────────────────────────────

export function parseBaseCidr (cidr: string): { networkStart: number; networkEnd: number } {
    const [ipRaw, prefixRaw] = cidr.trim().split('/')
    const prefix = Number(prefixRaw)
    if (!ipRaw || !Number.isInteger(prefix) || prefix < 0 || prefix > 31) {
        throw new Error('Subnet must be valid CIDR, /0 through /31 (example: 10.20.0.0/16)')
    }

    const ip = ipToInt(ipRaw)
    if (ip === null) { throw new Error('Invalid IPv4 subnet base') }

    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    const networkStart = (ip & mask) >>> 0
    const hostCount = Math.pow(2, 32 - prefix)
    const networkEnd = networkStart + hostCount - 1
    return { networkStart, networkEnd }
}
