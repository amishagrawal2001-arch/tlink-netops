// ═════════════════════════════════════════════════════════════════════════════
// Inventory Credential Resolver
//
// Single source of truth for "what SSH user/password should we use to push to
// node X?". The resolver checks the per-node fields first (set via the Info
// tab or by Device Mapper at apply time), and falls back to the user's saved
// device inventory (the `device-inventory` user-prefs key — populated by the
// Device Mapper UI / CSV import / LLDP discovery).
//
// This way a user who imported a CSV into the inventory but never ran "Apply"
// against the topology can still push, as long as the inventory record
// matches the node by hostname or mgmtIp.
// ═════════════════════════════════════════════════════════════════════════════

import { TopologyNode } from '../api/interfaces'

/** Shape of an entry in the persisted inventory. We only depend on these
 *  fields — anything else (vendor, model, interfaces, …) is ignored here. */
export interface InventoryRecord {
    hostname: string
    mgmtIp?: string
    sshUsername?: string
    sshPassword?: string
}

export interface ResolvedSshCreds {
    username: string
    password: string
    /** Where the creds came from. 'none' when neither field could be resolved. */
    source: 'node' | 'inventory' | 'none'
    /** When source='inventory', the inventory record that matched (for logs). */
    matchedHostname?: string
}

/** Load the saved inventory from user-prefs. Returns [] when prefs are
 *  unavailable (e.g. running outside Electron) or the entry doesn't exist. */
export async function loadDeviceInventory (): Promise<InventoryRecord[]> {
    const api = (globalThis as any).netopsAPI ?? (typeof window !== 'undefined' ? (window as any).netopsAPI : undefined)
    if (!api?.prefGet) { return [] }
    try {
        const saved = await api.prefGet('device-inventory')
        return Array.isArray(saved) ? saved as InventoryRecord[] : []
    } catch {
        return []
    }
}

/**
 * Resolve SSH credentials for a node.
 *
 *   1. If node.sshUsername AND node.sshPassword are both present → use them
 *      (source='node').
 *   2. Otherwise, look up the inventory by mgmtIp (preferred) then hostname
 *      (case-insensitive). Fill in whichever side is missing on the node
 *      from the matched record (source='inventory').
 *   3. If still missing either field → source='none'.
 *
 * Returns whichever credentials we could assemble, even if partial — the
 * caller decides whether to push or fail.
 */
export function resolveSshCredentials (
    node: Pick<TopologyNode, 'label' | 'mgmtIp' | 'sshUsername' | 'sshPassword'>,
    inventory: InventoryRecord[],
): ResolvedSshCreds {
    let username = (node.sshUsername ?? '').trim()
    let password = node.sshPassword ?? ''
    let source: 'node' | 'inventory' | 'none' = 'node'
    let matchedHostname: string | undefined

    if (!username || !password) {
        // Both fields missing or one missing — try inventory fallback.
        const host = (node.mgmtIp ?? '').split('/')[0].trim().toLowerCase()
        const label = (node.label ?? '').toLowerCase()
        const match = inventory.find(d => {
            const ip = (d.mgmtIp ?? '').split('/')[0].trim().toLowerCase()
            const hn = (d.hostname ?? '').toLowerCase()
            return (host && ip && ip === host) || (label && hn && hn === label)
        })
        if (match) {
            matchedHostname = match.hostname
            if (!username && match.sshUsername) {
                username = match.sshUsername.trim()
                source = 'inventory'
            }
            if (!password && match.sshPassword) {
                password = match.sshPassword
                source = 'inventory'
            }
        }
    }

    if (!username || !password) {
        return { username, password, source: 'none', matchedHostname }
    }
    return { username, password, source, matchedHostname }
}
