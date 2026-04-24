// ═══════════════════════════════════════════════════════════════════════════════
// Topology Diff Service
// Compares two topologies and produces a structured diff suitable for rendering,
// export, or audit trails.
// ═══════════════════════════════════════════════════════════════════════════════

import { Topology, TopologyNode, TopologyLink, NodePort } from '../api/interfaces'

export interface NodeDiff {
    id: string
    status: 'added' | 'removed' | 'modified' | 'unchanged'
    beforeLabel?: string
    afterLabel?: string
    /** Field-level changes — key is field name (e.g., 'vendor', 'asn', 'mgmtIp') */
    changes: Array<{ field: string; before: any; after: any }>
}

export interface LinkDiff {
    id: string
    status: 'added' | 'removed' | 'modified' | 'unchanged'
    sourceNodeId?: string
    targetNodeId?: string
    changes: Array<{ field: string; before: any; after: any }>
}

export interface PortDiff {
    nodeId: string
    portId: string
    portLabel: string
    status: 'added' | 'removed' | 'modified'
    changes: Array<{ field: string; before: any; after: any }>
}

export interface TopologyDiffResult {
    /** Overall summary counts */
    summary: {
        nodesAdded: number
        nodesRemoved: number
        nodesModified: number
        linksAdded: number
        linksRemoved: number
        linksModified: number
        portsChanged: number
    }
    /** Topology-level changes (name, underlayProtocol, overlayEnabled, etc.) */
    topologyChanges: Array<{ field: string; before: any; after: any }>
    nodes: NodeDiff[]
    links: LinkDiff[]
    ports: PortDiff[]
}

/** Fields to compare on node (scalar fields only — ports compared separately) */
const NODE_FIELDS = [
    'label', 'type', 'vendor', 'model', 'role', 'mgmtIp', 'loopbackIp', 'loopbackIpv6',
    'sshUsername', 'sshPort', 'asn', 'ospfArea', 'isisLevel', 'nodeSid', 'srgbStart', 'srgbEnd',
    'srv6Locator', 'mplsLdp', 'switchFamily', 'desc', 'description',
] as const

const LINK_FIELDS = [
    'type', 'sourceNodeId', 'sourcePortId', 'targetNodeId', 'targetPortId',
    'linkColor', 'linkStyle', 'linkLabel',
] as const

const TOPOLOGY_FIELDS = [
    'name', 'description', 'underlayProtocol', 'overlayEnabled', 'irbEnabled', 'irbMode',
    'vniBase', 'macVrfEnabled', 'oismEnabled',
] as const

const PORT_FIELDS = [
    'label', 'enabled', 'ipAddress', 'ipv6Address', 'speed', 'description',
    'vlanMode', 'vlan', 'trunkNativeVlan', 'trunkAllowedVlans',
] as const

/** Compare two objects field-by-field; return list of {field, before, after} for differences. */
function fieldChanges<T extends Record<string, any>> (
    a: T | undefined, b: T | undefined, fields: readonly string[],
): Array<{ field: string; before: any; after: any }> {
    const changes: Array<{ field: string; before: any; after: any }> = []
    for (const f of fields) {
        const av = a?.[f]
        const bv = b?.[f]
        if (av !== bv) {
            // Skip undefined → undefined (shouldn't happen but defensive)
            if (av == null && bv == null) { continue }
            changes.push({ field: f, before: av, after: bv })
        }
    }
    return changes
}

/** Compute a structured diff between two topologies. */
export function diffTopologies (before: Topology, after: Topology): TopologyDiffResult {
    const topologyChanges = fieldChanges(before as any, after as any, TOPOLOGY_FIELDS)

    // Nodes
    const beforeNodeMap = new Map(before.nodes.map(n => [n.id, n]))
    const afterNodeMap = new Map(after.nodes.map(n => [n.id, n]))
    const allNodeIds = new Set([...beforeNodeMap.keys(), ...afterNodeMap.keys()])
    const nodes: NodeDiff[] = []
    const ports: PortDiff[] = []
    let nodesAdded = 0, nodesRemoved = 0, nodesModified = 0

    for (const id of allNodeIds) {
        const b = beforeNodeMap.get(id)
        const a = afterNodeMap.get(id)
        if (!b && a) {
            nodesAdded++
            nodes.push({ id, status: 'added', afterLabel: a.label, changes: [] })
            continue
        }
        if (b && !a) {
            nodesRemoved++
            nodes.push({ id, status: 'removed', beforeLabel: b.label, changes: [] })
            continue
        }
        if (!b || !a) { continue }
        const scalarChanges = fieldChanges(b as any, a as any, NODE_FIELDS)
        const portChanges = diffPorts(id, b.ports, a.ports)
        if (scalarChanges.length || portChanges.length) {
            nodesModified++
            nodes.push({
                id, status: 'modified',
                beforeLabel: b.label, afterLabel: a.label,
                changes: scalarChanges,
            })
            ports.push(...portChanges)
        } else {
            nodes.push({ id, status: 'unchanged', beforeLabel: b.label, afterLabel: a.label, changes: [] })
        }
    }

    // Links
    const beforeLinkMap = new Map(before.links.map(l => [l.id, l]))
    const afterLinkMap = new Map(after.links.map(l => [l.id, l]))
    const allLinkIds = new Set([...beforeLinkMap.keys(), ...afterLinkMap.keys()])
    const links: LinkDiff[] = []
    let linksAdded = 0, linksRemoved = 0, linksModified = 0

    for (const id of allLinkIds) {
        const b = beforeLinkMap.get(id)
        const a = afterLinkMap.get(id)
        if (!b && a) {
            linksAdded++
            links.push({ id, status: 'added', sourceNodeId: a.sourceNodeId, targetNodeId: a.targetNodeId, changes: [] })
            continue
        }
        if (b && !a) {
            linksRemoved++
            links.push({ id, status: 'removed', sourceNodeId: b.sourceNodeId, targetNodeId: b.targetNodeId, changes: [] })
            continue
        }
        if (!b || !a) { continue }
        const changes = fieldChanges(b as any, a as any, LINK_FIELDS)
        if (changes.length) {
            linksModified++
            links.push({ id, status: 'modified', sourceNodeId: a.sourceNodeId, targetNodeId: a.targetNodeId, changes })
        } else {
            links.push({ id, status: 'unchanged', sourceNodeId: a.sourceNodeId, targetNodeId: a.targetNodeId, changes: [] })
        }
    }

    return {
        summary: {
            nodesAdded, nodesRemoved, nodesModified,
            linksAdded, linksRemoved, linksModified,
            portsChanged: ports.length,
        },
        topologyChanges,
        nodes,
        links,
        ports,
    }
}

function diffPorts (nodeId: string, before: NodePort[], after: NodePort[]): PortDiff[] {
    const beforeMap = new Map(before.map(p => [p.id, p]))
    const afterMap = new Map(after.map(p => [p.id, p]))
    const diffs: PortDiff[] = []
    const allIds = new Set([...beforeMap.keys(), ...afterMap.keys()])
    for (const id of allIds) {
        const b = beforeMap.get(id)
        const a = afterMap.get(id)
        if (!b && a) {
            diffs.push({ nodeId, portId: id, portLabel: a.label, status: 'added', changes: [] })
            continue
        }
        if (b && !a) {
            diffs.push({ nodeId, portId: id, portLabel: b.label, status: 'removed', changes: [] })
            continue
        }
        if (!b || !a) { continue }
        const changes = fieldChanges(b as any, a as any, PORT_FIELDS)
        if (changes.length) {
            diffs.push({ nodeId, portId: id, portLabel: a.label, status: 'modified', changes })
        }
    }
    return diffs
}

/** Format a diff result as plain text — useful for export and audit logs. */
export function formatDiffText (diff: TopologyDiffResult): string {
    const lines: string[] = []
    lines.push('=== Topology Diff ===')
    const s = diff.summary
    lines.push(`Summary: +${s.nodesAdded}/-${s.nodesRemoved}/~${s.nodesModified} nodes, ` +
               `+${s.linksAdded}/-${s.linksRemoved}/~${s.linksModified} links, ${s.portsChanged} port changes`)
    lines.push('')

    if (diff.topologyChanges.length) {
        lines.push('--- Topology-level changes ---')
        for (const c of diff.topologyChanges) {
            lines.push(`  ${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`)
        }
        lines.push('')
    }

    const addedNodes = diff.nodes.filter(n => n.status === 'added')
    const removedNodes = diff.nodes.filter(n => n.status === 'removed')
    const modifiedNodes = diff.nodes.filter(n => n.status === 'modified')
    if (addedNodes.length) {
        lines.push('--- Added nodes ---')
        for (const n of addedNodes) { lines.push(`  + ${n.afterLabel} (${n.id})`) }
        lines.push('')
    }
    if (removedNodes.length) {
        lines.push('--- Removed nodes ---')
        for (const n of removedNodes) { lines.push(`  - ${n.beforeLabel} (${n.id})`) }
        lines.push('')
    }
    if (modifiedNodes.length) {
        lines.push('--- Modified nodes ---')
        for (const n of modifiedNodes) {
            lines.push(`  ~ ${n.afterLabel} (${n.id})`)
            for (const c of n.changes) {
                lines.push(`      ${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`)
            }
        }
        lines.push('')
    }

    const addedLinks = diff.links.filter(l => l.status === 'added')
    const removedLinks = diff.links.filter(l => l.status === 'removed')
    const modifiedLinks = diff.links.filter(l => l.status === 'modified')
    if (addedLinks.length) {
        lines.push('--- Added links ---')
        for (const l of addedLinks) { lines.push(`  + ${l.sourceNodeId} → ${l.targetNodeId} (${l.id})`) }
        lines.push('')
    }
    if (removedLinks.length) {
        lines.push('--- Removed links ---')
        for (const l of removedLinks) { lines.push(`  - ${l.sourceNodeId} → ${l.targetNodeId} (${l.id})`) }
        lines.push('')
    }
    if (modifiedLinks.length) {
        lines.push('--- Modified links ---')
        for (const l of modifiedLinks) {
            lines.push(`  ~ ${l.sourceNodeId} → ${l.targetNodeId} (${l.id})`)
            for (const c of l.changes) {
                lines.push(`      ${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`)
            }
        }
        lines.push('')
    }

    if (diff.ports.length) {
        lines.push('--- Port changes ---')
        for (const p of diff.ports) {
            lines.push(`  ${p.status === 'added' ? '+' : p.status === 'removed' ? '-' : '~'} ${p.nodeId}:${p.portLabel}`)
            for (const c of p.changes) {
                lines.push(`      ${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`)
            }
        }
    }

    return lines.join('\n')
}
