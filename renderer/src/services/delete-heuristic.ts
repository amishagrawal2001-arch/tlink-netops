// ═══════════════════════════════════════════════════════════════════════════════
// Delete-Heuristic — derive top-of-hierarchy delete statements from set lines
//
// Used by:
//   • The per-node Push Config dialog's "⇩ Suggest Deletes" button.
//   • The Review & Replace (Bulk Replace) flow — both the initial row
//     population and the "⇩ Re-suggest" / "⇩ Re-suggest All" actions.
//
// Pure module: no Angular, no DOM — trivially unit-testable.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Top-of-hierarchy tokens for Juniper-style configs.
 *
 * Each key is a first-level container in the Juniper config tree.
 * The value is how many tokens to keep from the set line:
 *   1 = the container itself (`delete interfaces`)
 *   2 = the container + its next sub-feature (`delete protocols lldp`,
 *       `delete system ntp`)
 *
 * Everything not in this map defaults to 1 token (coarsest delete).
 */
export const JUNIPER_TOP_DEPTH: Record<string, number> = {
    // One-token containers — delete wipes the whole subtree
    'interfaces': 1,
    'routing-options': 1,
    'policy-options': 1,
    'firewall': 1,
    'forwarding-options': 1,
    'chassis': 1,
    'snmp': 1,
    'event-options': 1,
    'access': 1,
    'accounting-options': 1,
    'class-of-service': 1,
    'applications': 1,

    // Two-token containers — delete wipes one sub-feature at a time
    'protocols': 2,
    'system': 2,
    'routing-instances': 2,
    'security': 2,
    'services': 2,
    'vlans': 2,
    'bridge-domains': 2,
    'logical-systems': 2,
    'groups': 2,
    'apply-groups': 2,
}

/** Vendors that use `delete <path>` (Junos-style). */
const DELETE_KEYWORD_VENDORS = /* all non-Cisco-style */ true  // marker — default

/** Vendors that use `no <first-token>` (Cisco-style). */
const CISCO_STYLE_VENDOR_PATTERNS = ['cisco', 'arista', 'ios', 'eos', 'nxos']

export interface DeriveDeletesOptions {
    /**
     * If provided, interface names in this set are excluded from any delete
     * statement that wipes the interfaces subtree. Used to protect the
     * management interface from being dropped mid-push (which would disconnect
     * the SSH session). Keys are checked case-insensitively.
     *
     * Example: with `preserveInterfaces: new Set(['em0', 'fxp0'])`, a
     * `set interfaces em0 unit 0 family inet address 10.0.0.1/24` set line
     * that would normally produce `delete interfaces` will instead produce
     * NO delete for interfaces (we can't safely wipe the whole tree).
     */
    preserveInterfaces?: Set<string>
}

/**
 * Derive top-of-hierarchy delete statements from a config body.
 *
 * Juniper-style: `delete <container>` or `delete <container> <subfeature>`
 *   based on the hierarchy depth map.
 * Cisco-style:   `no <first-token-after-set>`.
 *
 * Returns deduped, ordered list (first occurrence wins).
 *
 * Safety: if `options.preserveInterfaces` has any entries AND any set line
 * targets an interface NOT in the preserve set, we skip emitting
 * `delete interfaces` to avoid wiping the management interface.
 *
 * @param config  raw config body — lines of `set …` / `no …` / comments
 * @param vendor  vendor name ("juniper", "cisco", "arista", etc.)
 * @param options optional safety rules
 * @returns deduped array of delete statements (empty if no set lines found)
 */
export function deriveDeletesFromConfig (
    config: string,
    vendor: string,
    options: DeriveDeletesOptions = {},
): string[] {
    const vendorLower = (vendor ?? '').toLowerCase()
    const isCiscoStyle = CISCO_STYLE_VENDOR_PATTERNS.some(v => vendorLower.includes(v))
    const keyword = isCiscoStyle ? 'no' : 'delete'
    const preserveIfaces = options.preserveInterfaces
    const hasPreserve = !!(preserveIfaces && preserveIfaces.size)

    // Normalize the preserve set to lowercase for comparison.
    const preserveLower = new Set<string>()
    if (hasPreserve) {
        for (const iface of preserveIfaces!) { preserveLower.add(iface.toLowerCase()) }
    }

    const seen = new Set<string>()
    const deletes: string[] = []

    for (const raw of config.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#') || line.startsWith('//')) { continue }
        const match = /^set\s+(.+)$/i.exec(line)
        if (!match) { continue }
        const tokens = match[1].split(/\s+/).filter(Boolean)
        if (!tokens.length) { continue }

        let deletePath: string
        if (isCiscoStyle) {
            // For Cisco `no ip route ...`, keep just the first token (top-level block).
            deletePath = tokens[0]
        } else {
            // Juniper-style: top of hierarchy based on the container map.
            const first = tokens[0].toLowerCase()
            const depth = JUNIPER_TOP_DEPTH[first] ?? 1

            // ── SAFETY RAIL: management-interface protection ───────────────
            // When the caller passed `preserveInterfaces`, we switch to
            // per-port deletes for the interfaces subtree regardless of
            // whether any specific interface is preserved. This guarantees
            // `delete interfaces` (which would drop the SSH session) is
            // never emitted when the caller signalled "I have interfaces I
            // care about keeping." Preserved interfaces get no delete at
            // all; everything else gets `delete interfaces <name>`.
            if (first === 'interfaces' && hasPreserve && tokens.length >= 2) {
                const ifaceName = tokens[1].toLowerCase()
                if (preserveLower.has(ifaceName)) {
                    continue    // preserved → no delete
                }
                deletePath = `interfaces ${tokens[1]}`
            } else {
                deletePath = tokens.slice(0, Math.min(depth, tokens.length)).join(' ')
            }
        }

        const deleteLine = `${keyword} ${deletePath}`
        if (seen.has(deleteLine)) { continue }
        seen.add(deleteLine)
        deletes.push(deleteLine)
    }

    return deletes
}

/**
 * Best-effort extraction of the management interface name(s) from a config.
 *
 * Juniper: looks for `set interfaces <name> unit 0 family inet address X` where
 *   X matches the given mgmtIp. Also always returns `em0` / `fxp0` as
 *   conservative defaults for physical QFX / MX.
 *
 * Returns a lowercase Set, suitable to pass as `options.preserveInterfaces`.
 */
export function detectMgmtInterfaces (config: string, mgmtIp?: string): Set<string> {
    const result = new Set<string>()

    // Conservative defaults: protect these even if the config doesn't set an IP
    // on them (they're the canonical Juniper mgmt / out-of-band ports).
    result.add('em0')
    result.add('em1')
    result.add('fxp0')
    result.add('mgmt')     // Nokia, generic

    const normMgmt = (mgmtIp ?? '').split('/')[0].trim()
    if (!normMgmt) { return result }

    for (const raw of config.split('\n')) {
        const line = raw.trim()
        // Juniper:  set interfaces <name> unit <u> family inet address <ip>[/<prefix>]
        const m = /^set\s+interfaces\s+(\S+)\s+unit\s+\S+\s+family\s+inet\s+address\s+(\S+)/i.exec(line)
        if (m) {
            const iface = m[1]
            const addr = m[2].split('/')[0]
            if (addr === normMgmt) { result.add(iface.toLowerCase()) }
        }
    }
    return result
}
