// ═══════════════════════════════════════════════════════════════════════════════
// Pure layout algorithms for topology visualization — no Angular dependencies.
// Extracted so they can be unit-tested with Jest without pulling in @angular/core.
// ═══════════════════════════════════════════════════════════════════════════════

import { Topology } from '../api/interfaces'
import { buildAdjacencyGraph } from './topology-graph-helpers'

// ── Types ────────────────────────────────────────────────────────────────────

export type LayoutAlgorithm = 'force' | 'hierarchical' | 'radial' | 'grid'

export interface LayoutPosition { id: string; x: number; y: number }
export interface LayoutResult  { positions: LayoutPosition[] }

// ── Constants ────────────────────────────────────────────────────────────────

const MARGIN = 40

// ── Utility: clamp all positions to positive with margin ─────────────────────

function clampPositive (positions: LayoutPosition[]): LayoutPosition[] {
    if (!positions.length) { return positions }
    const minX = Math.min(...positions.map(p => p.x)) - MARGIN
    const minY = Math.min(...positions.map(p => p.y)) - MARGIN
    return positions.map(p => ({
        id: p.id,
        x: Math.round(p.x - minX),
        y: Math.round(p.y - minY),
    }))
}

// ── Force-directed layout ────────────────────────────────────────────────────
//
// Identical to the original inline algorithm from netops-canvas.component.ts.
// Fruchterman-Reingold-style: pairwise repulsion + spring attraction along links.
//

export interface ForceOptions {
    repulsion?: number       // repulsion constant (default 8000)
    springK?: number         // spring stiffness (default 0.05)
    idealLength?: number     // ideal spring length (default 220)
    iterations?: number      // simulation steps (default 80)
}

export function forceDirectedLayout (topology: Topology, options?: ForceOptions): LayoutResult {
    if (!topology.nodes.length) { return { positions: [] } }

    const K_REPEL = options?.repulsion ?? 8000
    const K_SPRING = options?.springK ?? 0.05
    const IDEAL = options?.idealLength ?? 220
    const ITER = options?.iterations ?? 80

    const nodes = topology.nodes.map(n => ({ id: n.id, x: n.x, y: n.y }))
    const links = topology.links

    for (let i = 0; i < ITER; i++) {
        const forces = new Map(nodes.map(n => [n.id, { fx: 0, fy: 0 }]))

        // Pairwise repulsion
        for (let a = 0; a < nodes.length; a++) {
            for (let b = a + 1; b < nodes.length; b++) {
                const dx = nodes[b].x - nodes[a].x
                const dy = nodes[b].y - nodes[a].y
                const d2 = Math.max(1, dx * dx + dy * dy)
                const d  = Math.sqrt(d2)
                const f  = K_REPEL / d2
                const fx = f * dx / d
                const fy = f * dy / d
                forces.get(nodes[a].id)!.fx -= fx
                forces.get(nodes[a].id)!.fy -= fy
                forces.get(nodes[b].id)!.fx += fx
                forces.get(nodes[b].id)!.fy += fy
            }
        }

        // Spring attraction along links
        for (const l of links) {
            const a = nodes.find(n => n.id === l.sourceNodeId)
            const b = nodes.find(n => n.id === l.targetNodeId)
            if (!a || !b) { continue }
            const dx = b.x - a.x
            const dy = b.y - a.y
            const d  = Math.max(1, Math.sqrt(dx * dx + dy * dy))
            const f  = K_SPRING * (d - IDEAL)
            const fx = f * dx / d
            const fy = f * dy / d
            forces.get(a.id)!.fx += fx
            forces.get(a.id)!.fy += fy
            forces.get(b.id)!.fx -= fx
            forces.get(b.id)!.fy -= fy
        }

        // Damped integration
        const damp = 1 - i / ITER
        for (const n of nodes) {
            const f = forces.get(n.id)!
            n.x += f.fx * damp
            n.y += f.fy * damp
        }
    }

    return { positions: clampPositive(nodes) }
}

// ── Hierarchical layout (Sugiyama-style) ─────────────────────────────────────
//
// Layer assignment via BFS from root nodes, then barycenter heuristic
// for crossing minimization, and finally positional assignment.

export interface HierarchicalOptions {
    layerSpacing?: number    // vertical distance between layers (default 180)
    nodeSpacing?: number     // horizontal distance between nodes in a layer (default 200)
}

export function hierarchicalLayout (topology: Topology, options?: HierarchicalOptions): LayoutResult {
    if (!topology.nodes.length) { return { positions: [] } }

    const LAYER_SPACING = options?.layerSpacing ?? 180
    const NODE_SPACING  = options?.nodeSpacing ?? 200

    const adj = buildAdjacencyGraph(topology)
    const nodeIds = topology.nodes.map(n => n.id)

    // 1. Identify root candidates: prefer spine nodes, then highest-degree, then first
    const degreeMap = new Map<string, number>()
    for (const n of topology.nodes) {
        degreeMap.set(n.id, adj.get(n.id)?.length ?? 0)
    }

    // Prefer super-spines, then spines as roots for hierarchical ordering
    const superSpineNodes = topology.nodes.filter(n => n.role === 'super-spine').map(n => n.id)
    const spineNodes = superSpineNodes.length > 0
        ? superSpineNodes
        : topology.nodes.filter(n => n.role === 'spine').map(n => n.id)

    // 2. BFS layer assignment — handle disconnected components
    const layer = new Map<string, number>()
    const layers: string[][] = []

    const bfsMulti = (startIds: string[], startLayer: number): void => {
        const queue: string[] = []
        for (const sid of startIds) {
            if (!layer.has(sid)) {
                layer.set(sid, startLayer)
                queue.push(sid)
            }
        }
        let head = 0
        while (head < queue.length) {
            const cur = queue[head++]
            const curLayer = layer.get(cur)!
            for (const entry of (adj.get(cur) ?? [])) {
                if (!layer.has(entry.neighborNodeId)) {
                    layer.set(entry.neighborNodeId, curLayer + 1)
                    queue.push(entry.neighborNodeId)
                }
            }
        }
    }

    // Start BFS from spine nodes first (all at layer 0), then any remaining unvisited
    if (spineNodes.length > 0) {
        bfsMulti(spineNodes, 0)
    } else {
        // Pick highest-degree node as root
        const sorted = [...nodeIds].sort((a, b) => (degreeMap.get(b) ?? 0) - (degreeMap.get(a) ?? 0))
        bfsMulti([sorted[0]], 0)
    }

    // Handle disconnected components
    for (const nid of nodeIds) {
        if (!layer.has(nid)) { bfsMulti([nid], 0) }
    }

    // 3. Group nodes by layer
    const maxLayer = Math.max(...layer.values())
    for (let i = 0; i <= maxLayer; i++) { layers.push([]) }
    for (const nid of nodeIds) {
        layers[layer.get(nid)!].push(nid)
    }

    // 4. Barycenter heuristic for crossing minimization (2 passes: down then up)
    const barycenterSort = (layerArr: string[], refLayer: string[]): string[] => {
        if (!refLayer.length) { return layerArr }
        const bary = new Map<string, number>()
        for (const nid of layerArr) {
            const neighbors = (adj.get(nid) ?? [])
                .map(e => e.neighborNodeId)
                .filter(id => refLayer.includes(id))
            if (neighbors.length) {
                const avg = neighbors
                    .map(id => refLayer.indexOf(id))
                    .reduce((a, b) => a + b, 0) / neighbors.length
                bary.set(nid, avg)
            } else {
                bary.set(nid, layerArr.indexOf(nid))
            }
        }
        return [...layerArr].sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0))
    }

    // Down pass
    for (let i = 1; i <= maxLayer; i++) {
        layers[i] = barycenterSort(layers[i], layers[i - 1])
    }
    // Up pass
    for (let i = maxLayer - 1; i >= 0; i--) {
        layers[i] = barycenterSort(layers[i], layers[i + 1])
    }

    // 5. Assign positions: center each layer horizontally
    const positions: LayoutPosition[] = []
    const maxWidth = Math.max(...layers.map(l => l.length))

    for (let i = 0; i <= maxLayer; i++) {
        const layerNodes = layers[i]
        const layerWidth = layerNodes.length * NODE_SPACING
        const maxLayerWidth = maxWidth * NODE_SPACING
        const offsetX = (maxLayerWidth - layerWidth) / 2

        for (let j = 0; j < layerNodes.length; j++) {
            positions.push({
                id: layerNodes[j],
                x: offsetX + j * NODE_SPACING,
                y: i * LAYER_SPACING,
            })
        }
    }

    return { positions: clampPositive(positions) }
}

// ── Radial layout ────────────────────────────────────────────────────────────
//
// BFS rings from a center node. Nodes at each BFS depth are distributed
// evenly around a circle of increasing radius.

export interface RadialOptions {
    ringSpacing?: number     // distance between rings (default 180)
    centerNodeId?: string    // override the center node (default: highest-degree)
}

export function radialLayout (topology: Topology, options?: RadialOptions): LayoutResult {
    if (!topology.nodes.length) { return { positions: [] } }

    const RING_SPACING = options?.ringSpacing ?? 180

    const adj = buildAdjacencyGraph(topology)
    const nodeIds = topology.nodes.map(n => n.id)

    // Pick center node: user-specified, or highest degree
    let centerId = options?.centerNodeId
    if (!centerId || !nodeIds.includes(centerId)) {
        centerId = nodeIds.reduce((best, nid) =>
            (adj.get(nid)?.length ?? 0) > (adj.get(best)?.length ?? 0) ? nid : best
        , nodeIds[0])
    }

    // BFS to assign rings
    const ring = new Map<string, number>()
    const queue: string[] = [centerId]
    ring.set(centerId, 0)
    let head = 0
    while (head < queue.length) {
        const cur = queue[head++]
        const curRing = ring.get(cur)!
        for (const entry of (adj.get(cur) ?? [])) {
            if (!ring.has(entry.neighborNodeId)) {
                ring.set(entry.neighborNodeId, curRing + 1)
                queue.push(entry.neighborNodeId)
            }
        }
    }

    // Handle disconnected components — put them in outer rings
    let maxRing = Math.max(0, ...ring.values())
    for (const nid of nodeIds) {
        if (!ring.has(nid)) {
            maxRing++
            ring.set(nid, maxRing)
        }
    }

    // Group nodes by ring
    const rings: string[][] = []
    for (let i = 0; i <= maxRing; i++) { rings.push([]) }
    for (const nid of nodeIds) {
        rings[ring.get(nid)!].push(nid)
    }

    // Position: center node at origin, each ring evenly around its circle
    const cx = (maxRing + 1) * RING_SPACING
    const cy = (maxRing + 1) * RING_SPACING
    const positions: LayoutPosition[] = []

    for (let r = 0; r <= maxRing; r++) {
        const nodesInRing = rings[r]
        if (r === 0) {
            // Center node
            for (const nid of nodesInRing) {
                positions.push({ id: nid, x: cx, y: cy })
            }
        } else {
            const radius = r * RING_SPACING
            const angleStep = (2 * Math.PI) / nodesInRing.length
            for (let i = 0; i < nodesInRing.length; i++) {
                const angle = i * angleStep - Math.PI / 2  // start from top
                positions.push({
                    id: nodesInRing[i],
                    x: cx + radius * Math.cos(angle),
                    y: cy + radius * Math.sin(angle),
                })
            }
        }
    }

    return { positions: clampPositive(positions) }
}

// ── Grid layout ──────────────────────────────────────────────────────────────
//
// Simple column-row arrangement. Nodes are sorted by type then label, then
// arranged in a grid with ceil(sqrt(N)) columns.

export interface GridOptions {
    cellWidth?: number       // horizontal cell spacing (default 200)
    cellHeight?: number      // vertical cell spacing (default 160)
    columns?: number         // override column count (default: ceil(sqrt(N)))
}

export function gridLayout (topology: Topology, options?: GridOptions): LayoutResult {
    if (!topology.nodes.length) { return { positions: [] } }

    const CELL_W = options?.cellWidth ?? 200
    const CELL_H = options?.cellHeight ?? 160

    // Sort nodes: by type, then by label alphabetically
    const sorted = [...topology.nodes].sort((a, b) => {
        if (a.type !== b.type) { return a.type.localeCompare(b.type) }
        return a.label.localeCompare(b.label)
    })

    const count = sorted.length
    const cols = options?.columns ?? Math.ceil(Math.sqrt(count))

    const positions: LayoutPosition[] = sorted.map((n, i) => ({
        id: n.id,
        x: (i % cols) * CELL_W,
        y: Math.floor(i / cols) * CELL_H,
    }))

    return { positions: clampPositive(positions) }
}
