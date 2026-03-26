// ═══════════════════════════════════════════════════════════════════════════════
// Pure helper functions for inventory service — no Angular dependencies.
// Extracted so they can be unit-tested with Jest without pulling in @angular/core.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize an interface name for matching.
 * Expands common abbreviations and strips whitespace, so that e.g.
 * "Gi0/1" matches "GigabitEthernet0/1" and "et-0/0/0" matches "et-0/0/0".
 */
export function normalizeIfName (name: string): string {
    let n = name.toLowerCase().replace(/\s+/g, '')
    // Expand common Cisco-style abbreviations
    n = n.replace(/^gi(?=\d)/, 'gigabitethernet')
    n = n.replace(/^te(?=\d)/, 'tengigabitethernet')
    n = n.replace(/^fa(?=\d)/, 'fastethernet')
    n = n.replace(/^eth(?=\d)/, 'ethernet')
    n = n.replace(/^po(?=\d)/, 'port-channel')
    return n
}

/**
 * Match a polled interface name against a topology port label.
 * Uses exact comparison after normalization — avoids substring matching
 * which causes "et-0/0/1" to falsely match "et-0/0/10".
 */
export function interfaceNamesMatch (polledName: string, portLabel: string): boolean {
    const a = normalizeIfName(polledName)
    const b = normalizeIfName(portLabel)
    return a === b
}

/**
 * Glob pattern matching with `*` (any chars) and `?` (single char).
 * Case-insensitive.
 */
export function globMatch (pattern: string, value: string): boolean {
    if (!pattern || pattern === '*') { return true }
    const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$', 'i')
    return re.test(value)
}
