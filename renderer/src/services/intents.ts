// ═══════════════════════════════════════════════════════════════════════════════
// Intent-Based Configuration
// Declarative intents that translate to topology mutations.
// Example: "Make this link redundant" → adds a parallel link with different path.
// ═══════════════════════════════════════════════════════════════════════════════

import { Topology, TopologyNode, TopologyLink } from '../api/interfaces'

export type IntentCategory = 'connectivity' | 'redundancy' | 'security' | 'overlay' | 'observability'

export interface IntentDefinition {
    id: string
    name: string
    category: IntentCategory
    icon: string
    description: string
    /** Required selection for this intent: 'none' | 'single-node' | 'two-nodes' | 'link' */
    selection: 'none' | 'single-node' | 'two-nodes' | 'link'
    /** Short-form explanation shown before apply (for user confirmation) */
    explainer: string
    /** Fields user must provide (name, label, defaultValue) */
    inputs?: Array<{
        key: string
        label: string
        type: 'string' | 'number' | 'boolean' | 'select'
        default?: any
        options?: string[]
        help?: string
    }>
}

export const INTENTS: IntentDefinition[] = [
    // ── Redundancy ────────────────────────────────────────────────────────
    {
        id: 'add-parallel-link',
        name: 'Add Parallel Link',
        category: 'redundancy',
        icon: '⇄',
        description: 'Duplicate the selected link with a second physical path for active-active failover.',
        selection: 'link',
        explainer: 'Creates a parallel link between the same endpoints using new port IDs. Both endpoints must have spare ports.',
    },
    {
        id: 'dual-spine-uplinks',
        name: 'Ensure Dual Spine Uplinks',
        category: 'redundancy',
        icon: '△',
        description: 'For every leaf, guarantee it has a link to at least 2 spines (add missing links).',
        selection: 'none',
        explainer: 'Scans all leaf nodes and adds uplinks to underutilized spines where spare ports exist. Useful after topology imports.',
    },

    // ── Connectivity ──────────────────────────────────────────────────────
    {
        id: 'connect-to-mgmt',
        name: 'Connect to Management Network',
        category: 'connectivity',
        icon: '⚏',
        description: 'Attach the selected node to a management switch via OOB network.',
        selection: 'single-node',
        explainer: 'Creates a link from the node to the nearest "Mgmt-SW" node (or creates one if absent).',
    },
    {
        id: 'add-out-of-band-path',
        name: 'Add Out-of-Band Path',
        category: 'connectivity',
        icon: '◇',
        description: 'Add an OOB management path between two nodes, independent of the data plane.',
        selection: 'two-nodes',
        explainer: 'Adds a dedicated OOB management link that bypasses the production fabric.',
    },

    // ── Overlay ───────────────────────────────────────────────────────────
    {
        id: 'add-tenant-vlan',
        name: 'Add Tenant VLAN',
        category: 'overlay',
        icon: '⬡',
        description: 'Add a new tenant VLAN with VNI mapping to all leaf nodes.',
        selection: 'none',
        explainer: 'Adds the specified VLAN to every leaf node and maps it to VNI = 10000 + VLAN ID.',
        inputs: [
            { key: 'vlanId', label: 'VLAN ID', type: 'number', default: 300, help: '100-899 recommended (tenant range)' },
            { key: 'vlanName', label: 'VLAN Name', type: 'string', default: 'Tenant-C' },
        ],
    },
    {
        id: 'enable-evpn-overlay',
        name: 'Enable EVPN-VXLAN Overlay',
        category: 'overlay',
        icon: '🔷',
        description: 'Enable EVPN-VXLAN overlay on the whole fabric.',
        selection: 'none',
        explainer: 'Sets overlayEnabled=true on the topology and regenerates all configs with BGP-EVPN + VXLAN stanzas.',
    },

    // ── Security ──────────────────────────────────────────────────────────
    {
        id: 'apply-storm-control',
        name: 'Apply Storm Control',
        category: 'security',
        icon: '⚠',
        description: 'Enable broadcast/multicast storm control on all access ports.',
        selection: 'none',
        explainer: 'Adds storm-control profile (80% bandwidth, no-multicast) to every port in access mode across all leaf/access nodes.',
    },
    {
        id: 'disable-unused-ports',
        name: 'Disable Unused Ports',
        category: 'security',
        icon: '⊘',
        description: 'Shut down all ports that are not part of any link.',
        selection: 'none',
        explainer: 'Sets enabled=false on every port that is not referenced by a link, reducing attack surface.',
    },

    // ── Observability ─────────────────────────────────────────────────────
    {
        id: 'enable-grpc-telemetry',
        name: 'Enable gRPC Telemetry',
        category: 'observability',
        icon: '📡',
        description: 'Turn on streaming telemetry on all routing nodes.',
        selection: 'none',
        explainer: 'Sets telemetryEnabled=true on all routers/switches, auto-generating vendor telemetry config.',
    },
    {
        id: 'bulk-set-mgmt-prefix',
        name: 'Bulk Set Management IPs',
        category: 'observability',
        icon: '#',
        description: 'Assign sequential management IPs to all nodes from a prefix.',
        selection: 'none',
        explainer: 'Assigns mgmtIp = <prefix>.<n+10>/24 to each node sequentially, enabling SSH access.',
        inputs: [
            { key: 'prefix', label: 'Prefix (e.g. 172.20.20.)', type: 'string', default: '172.20.20.' },
        ],
    },
]

export interface IntentApplyResult {
    ok: boolean
    message: string
    affectedNodeIds: string[]
    affectedLinkIds: string[]
    /** Mutations to apply to the topology (declarative) */
    mutations: {
        addNodes?: Partial<TopologyNode>[]
        addLinks?: Partial<TopologyLink>[]
        updateNodes?: Array<{ id: string; changes: Partial<TopologyNode> }>
        removeNodeIds?: string[]
        removeLinkIds?: string[]
        topologyChanges?: Partial<Topology>
    }
}

/** Preview what an intent would do without applying (pure function — no side effects). */
export function previewIntent (
    intent: IntentDefinition,
    topo: Topology,
    context: {
        selectedNodeIds?: string[]
        selectedLinkId?: string
        inputs?: Record<string, any>
    },
): IntentApplyResult {
    const inputs = context.inputs ?? {}
    switch (intent.id) {
        case 'add-parallel-link': {
            if (!context.selectedLinkId) {
                return { ok: false, message: 'Select a link first', affectedNodeIds: [], affectedLinkIds: [], mutations: {} }
            }
            const link = topo.links.find(l => l.id === context.selectedLinkId)
            if (!link) { return { ok: false, message: 'Link not found', affectedNodeIds: [], affectedLinkIds: [], mutations: {} } }
            // Find unused ports on both endpoints
            const src = topo.nodes.find(n => n.id === link.sourceNodeId)
            const tgt = topo.nodes.find(n => n.id === link.targetNodeId)
            if (!src || !tgt) { return { ok: false, message: 'Endpoints missing', affectedNodeIds: [], affectedLinkIds: [], mutations: {} } }
            const usedPorts = new Set(topo.links.flatMap(l =>
                [`${l.sourceNodeId}:${l.sourcePortId}`, `${l.targetNodeId}:${l.targetPortId}`]
            ))
            const srcPort = src.ports.find(p => !usedPorts.has(`${src.id}:${p.id}`))
            const tgtPort = tgt.ports.find(p => !usedPorts.has(`${tgt.id}:${p.id}`))
            if (!srcPort || !tgtPort) {
                return { ok: false, message: 'No spare ports on endpoints', affectedNodeIds: [], affectedLinkIds: [], mutations: {} }
            }
            return {
                ok: true,
                message: `Will add parallel link ${src.label}:${srcPort.label} ↔ ${tgt.label}:${tgtPort.label}`,
                affectedNodeIds: [src.id, tgt.id],
                affectedLinkIds: [],
                mutations: {
                    addLinks: [{
                        type: 'ethernet' as any,
                        sourceNodeId: src.id, sourcePortId: srcPort.id,
                        targetNodeId: tgt.id, targetPortId: tgtPort.id,
                    }],
                },
            }
        }

        case 'add-tenant-vlan': {
            const vlanId = Number(inputs['vlanId'] ?? 300)
            const vlanName = String(inputs['vlanName'] ?? `Tenant-${vlanId}`)
            const leaves = topo.nodes.filter(n => n.role === 'leaf' || n.role === 'border-leaf' || n.role === 'tor')
            if (!leaves.length) {
                return { ok: false, message: 'No leaf nodes found', affectedNodeIds: [], affectedLinkIds: [], mutations: {} }
            }
            const updates = leaves.map(n => ({
                id: n.id,
                changes: { vlans: [...(n.vlans ?? []).filter(v => v.id !== vlanId), { id: vlanId, name: vlanName }] },
            }))
            return {
                ok: true,
                message: `Will add VLAN ${vlanId} (${vlanName}) to ${leaves.length} leaf node(s)`,
                affectedNodeIds: leaves.map(n => n.id),
                affectedLinkIds: [],
                mutations: { updateNodes: updates },
            }
        }

        case 'enable-evpn-overlay': {
            return {
                ok: true,
                message: `Will enable EVPN-VXLAN overlay on the topology`,
                affectedNodeIds: topo.nodes.map(n => n.id),
                affectedLinkIds: [],
                mutations: { topologyChanges: { overlayEnabled: true, vniBase: topo.vniBase ?? 10000 } },
            }
        }

        case 'apply-storm-control': {
            const candidates = topo.nodes.filter(n => n.role === 'leaf' || n.role === 'access' || n.role === 'tor')
            return {
                ok: true,
                message: `Will enable storm control on ${candidates.length} edge node(s)`,
                affectedNodeIds: candidates.map(n => n.id),
                affectedLinkIds: [],
                mutations: {},  // Storm control is emitted by config builder automatically when access VLANs present
            }
        }

        case 'disable-unused-ports': {
            const usedPorts = new Set(topo.links.flatMap(l =>
                [`${l.sourceNodeId}:${l.sourcePortId}`, `${l.targetNodeId}:${l.targetPortId}`]
            ))
            const updates: Array<{ id: string; changes: Partial<TopologyNode> }> = []
            let disabledCount = 0
            for (const n of topo.nodes) {
                const newPorts = n.ports.map(p => {
                    const key = `${n.id}:${p.id}`
                    if (!usedPorts.has(key) && p.enabled !== false) {
                        disabledCount++
                        return { ...p, enabled: false }
                    }
                    return p
                })
                if (newPorts.some((p, i) => p.enabled !== n.ports[i].enabled)) {
                    updates.push({ id: n.id, changes: { ports: newPorts } })
                }
            }
            return {
                ok: true,
                message: `Will disable ${disabledCount} unused port(s) across ${updates.length} node(s)`,
                affectedNodeIds: updates.map(u => u.id),
                affectedLinkIds: [],
                mutations: { updateNodes: updates },
            }
        }

        case 'enable-grpc-telemetry': {
            const routing = topo.nodes.filter(n => n.type === 'router' || n.type === 'switch' || n.type === 'firewall')
            const updates = routing.map(n => ({ id: n.id, changes: { telemetryEnabled: true } }))
            return {
                ok: true,
                message: `Will enable gRPC telemetry on ${routing.length} routing device(s)`,
                affectedNodeIds: routing.map(n => n.id),
                affectedLinkIds: [],
                mutations: { updateNodes: updates },
            }
        }

        case 'bulk-set-mgmt-prefix': {
            const prefix = String(inputs['prefix'] ?? '172.20.20.').trim()
            const routing = topo.nodes.filter(n => n.type === 'router' || n.type === 'switch' || n.type === 'firewall')
            const updates = routing.map((n, i) => ({ id: n.id, changes: { mgmtIp: `${prefix}${10 + i}/24` } }))
            return {
                ok: true,
                message: `Will assign ${routing.length} management IPs from ${prefix}10 onward`,
                affectedNodeIds: routing.map(n => n.id),
                affectedLinkIds: [],
                mutations: { updateNodes: updates },
            }
        }

        case 'dual-spine-uplinks': {
            const spines = topo.nodes.filter(n => n.role === 'spine' || n.role === 'super-spine')
            const leaves = topo.nodes.filter(n => n.role === 'leaf' || n.role === 'border-leaf' || n.role === 'tor')
            if (!spines.length || !leaves.length) {
                return { ok: false, message: 'Need at least 1 spine and 1 leaf', affectedNodeIds: [], affectedLinkIds: [], mutations: {} }
            }
            const newLinks: Partial<TopologyLink>[] = []
            const usedPorts = new Set(topo.links.flatMap(l =>
                [`${l.sourceNodeId}:${l.sourcePortId}`, `${l.targetNodeId}:${l.targetPortId}`]
            ))
            for (const leaf of leaves) {
                const connectedSpines = new Set(topo.links
                    .filter(l => l.sourceNodeId === leaf.id || l.targetNodeId === leaf.id)
                    .map(l => l.sourceNodeId === leaf.id ? l.targetNodeId : l.sourceNodeId)
                    .filter(id => spines.some(s => s.id === id)))
                if (connectedSpines.size >= 2) { continue }
                for (const spine of spines) {
                    if (connectedSpines.has(spine.id)) { continue }
                    if (connectedSpines.size >= 2) { break }
                    const leafPort = leaf.ports.find(p => !usedPorts.has(`${leaf.id}:${p.id}`))
                    const spinePort = spine.ports.find(p => !usedPorts.has(`${spine.id}:${p.id}`))
                    if (!leafPort || !spinePort) { continue }
                    newLinks.push({
                        type: 'ethernet' as any,
                        sourceNodeId: spine.id, sourcePortId: spinePort.id,
                        targetNodeId: leaf.id, targetPortId: leafPort.id,
                    })
                    usedPorts.add(`${leaf.id}:${leafPort.id}`)
                    usedPorts.add(`${spine.id}:${spinePort.id}`)
                    connectedSpines.add(spine.id)
                }
            }
            return {
                ok: true,
                message: `Will add ${newLinks.length} missing uplink(s)`,
                affectedNodeIds: leaves.map(n => n.id),
                affectedLinkIds: [],
                mutations: { addLinks: newLinks },
            }
        }

        case 'connect-to-mgmt':
        case 'add-out-of-band-path':
            return {
                ok: false,
                message: 'Intent not yet implemented — use Apply Service Profile: Out-of-band profile',
                affectedNodeIds: [], affectedLinkIds: [], mutations: {},
            }

        default:
            return { ok: false, message: `Unknown intent: ${intent.id}`, affectedNodeIds: [], affectedLinkIds: [], mutations: {} }
    }
}
