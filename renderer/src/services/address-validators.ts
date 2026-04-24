// ═══════════════════════════════════════════════════════════════════════════════
// Address Validators
// Shared helpers for validating management addresses (IPv4/IPv6/hostname).
// ═══════════════════════════════════════════════════════════════════════════════

/** Validate that a management address is a valid IPv4 address. */
export function isValidIPv4 (raw: string): boolean {
    const ipv4 = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/
    return ipv4.test(raw.trim())
}

/** Validate that a management address is a valid IPv6 address (bare or bracketed, zone IDs allowed). */
export function isValidIPv6 (raw: string): boolean {
    let value = raw.trim()
    if (!value) { return false }
    // Strip brackets: [fd00::1] → fd00::1
    if (value.startsWith('[') && value.endsWith(']')) { value = value.slice(1, -1) }
    // Strip zone ID: fe80::1%eth0 → fe80::1
    const percentIdx = value.indexOf('%')
    if (percentIdx !== -1) {
        const zone = value.slice(percentIdx + 1)
        if (!/^[A-Za-z0-9._-]+$/.test(zone)) { return false }
        value = value.slice(0, percentIdx)
    }
    if (value === '::' || value === '::1') { return true }

    // Split on `::` — at most one occurrence.
    const parts = value.split('::')
    if (parts.length > 2) { return false }

    const validGroup = /^[0-9A-Fa-f]{1,4}$/
    const left = parts[0] ? parts[0].split(':') : []
    const right = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : []

    // Every group must be 1-4 hex chars
    for (const g of [...left, ...right]) { if (!validGroup.test(g)) { return false } }

    if (parts.length === 1) {
        // No `::` — must have exactly 8 groups
        return left.length === 8
    }
    // With `::`, total groups must be ≤ 7 (so expansion produces ≤ 8)
    return (left.length + right.length) <= 7
}

/** Validate that a value is a valid RFC 1123 hostname. */
export function isValidHostname (raw: string): boolean {
    const value = raw.trim()
    if (!value || value.length > 253) { return false }
    const hostnamePart = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/
    const labels = value.split('.')
    return labels.every(label => hostnamePart.test(label))
}

/** Validate that a management address is either an IPv4, IPv6, or RFC 1123 hostname. */
export function isValidMgmtAddress (raw: string): boolean {
    const value = raw.trim()
    if (!value) { return false }
    return isValidIPv4(value) || isValidIPv6(value) || isValidHostname(value)
}
