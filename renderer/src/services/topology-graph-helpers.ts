// ═══════════════════════════════════════════════════════════════════════════════
// Pure graph algorithms for topology analysis — no Angular dependencies.
// Extracted so they can be unit-tested with Jest without pulling in @angular/core.
// ═══════════════════════════════════════════════════════════════════════════════

import { Topology, TrafficFlow, ComputedFlowPath } from '../api/interfaces'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AdjEntry {
    neighborNodeId: string
    linkId: string
}

export const MAX_ECMP_PATHS = 4

// ── Build undirected adjacency graph ─────────────────────────────────────────

export function buildAdjacencyGraph (
    topology: Topology,
    excludeNodeIds?: Set<string>,
    excludeLinkIds?: Set<string>,
): Map<string, AdjEntry[]> {
    const adj = new Map<string, AdjEntry[]>()

    // Ensure every non-excluded node has an entry even if it has no links.
    for (const n of topology.nodes) {
        if (excludeNodeIds?.has(n.id)) { continue }
        if (!adj.has(n.id)) { adj.set(n.id, []) }
    }

    for (const link of topology.links) {
        // Skip downed links
        if (link.status === 'down') { continue }

        // Skip explicitly excluded links
        if (excludeLinkIds?.has(link.id)) { continue }

        const src = link.sourceNodeId
        const tgt = link.targetNodeId

        // Skip if either endpoint node is excluded
        if (excludeNodeIds?.has(src) || excludeNodeIds?.has(tgt)) { continue }

        // Bidirectional
        if (!adj.has(src)) { adj.set(src, []) }
        if (!adj.has(tgt)) { adj.set(tgt, []) }

        adj.get(src)!.push({ neighborNodeId: tgt, linkId: link.id })
        adj.get(tgt)!.push({ neighborNodeId: src, linkId: link.id })
    }

    return adj
}

// ── BFS shortest paths (all equal-cost, capped) ─────────────────────────────

export function findAllShortestPaths (
    adjacency: Map<string, AdjEntry[]>,
    sourceId: string,
    destId: string,
): { nodeIds: string[]; linkIds: string[] }[] {

    if (sourceId === destId) {
        return [{ nodeIds: [sourceId], linkIds: [] }]
    }

    if (!adjacency.has(sourceId) || !adjacency.has(destId)) {
        return []
    }

    // BFS with multi-parent tracking
    // parents[nodeId] = array of { parentNodeId, viaLinkId }
    const parents = new Map<string, { parentId: string; linkId: string }[]>()
    const dist = new Map<string, number>()
    const queue: string[] = []

    dist.set(sourceId, 0)
    queue.push(sourceId)

    let destDist = -1

    let head = 0
    while (head < queue.length) {
        const cur = queue[head++]
        const d = dist.get(cur)!

        // If we've already reached dest at a shorter distance, stop
        if (destDist >= 0 && d >= destDist) { break }

        const neighbors = adjacency.get(cur) ?? []
        for (const entry of neighbors) {
            const nd = d + 1
            const existing = dist.get(entry.neighborNodeId)

            if (existing === undefined) {
                // First visit
                dist.set(entry.neighborNodeId, nd)
                parents.set(entry.neighborNodeId, [{ parentId: cur, linkId: entry.linkId }])
                queue.push(entry.neighborNodeId)

                if (entry.neighborNodeId === destId) {
                    destDist = nd
                }
            } else if (existing === nd) {
                // Same distance — add as additional parent for ECMP
                parents.get(entry.neighborNodeId)!.push({ parentId: cur, linkId: entry.linkId })
            }
            // If existing < nd, ignore (already found shorter path)
        }
    }

    if (destDist < 0) { return [] }   // Unreachable

    // Backtrack from dest to source to reconstruct all paths
    const results: { nodeIds: string[]; linkIds: string[] }[] = []

    const backtrack = (node: string, nodeAcc: string[], linkAcc: string[]): void => {
        if (results.length >= MAX_ECMP_PATHS) { return }
        if (node === sourceId) {
            results.push({
                nodeIds: [...nodeAcc, sourceId].reverse(),
                linkIds: [...linkAcc].reverse(),
            })
            return
        }
        const pList = parents.get(node) ?? []
        for (const p of pList) {
            if (results.length >= MAX_ECMP_PATHS) { return }
            backtrack(p.parentId, [...nodeAcc, node], [...linkAcc, p.linkId])
        }
    }

    backtrack(destId, [], [])
    return results
}

// ── Compute flow paths (main entry point) ────────────────────────────────────

export function computeFlowPaths (
    topology: Topology,
    flows: TrafficFlow[],
    excludeNodeIds?: Set<string>,
    excludeLinkIds?: Set<string>,
): ComputedFlowPath[] {

    const results: ComputedFlowPath[] = []
    if (!flows.length) { return results }

    // Build graph with exclusions (for failure simulation)
    const adj = buildAdjacencyGraph(topology, excludeNodeIds, excludeLinkIds)

    // Also build a clean graph (no exclusions) to detect rerouting
    const hasExclusions = (excludeNodeIds?.size ?? 0) > 0 || (excludeLinkIds?.size ?? 0) > 0
    const cleanAdj = hasExclusions
        ? buildAdjacencyGraph(topology)
        : null

    for (const flow of flows) {
        if (!flow.enabled) { continue }

        const paths = findAllShortestPaths(adj, flow.sourceNodeId, flow.destNodeId)

        if (!paths.length) {
            // No path — flow is broken
            results.push({
                flowId: flow.id,
                pathIndex: 0,
                linkIds: [],
                nodeIds: [],
                broken: true,
                rerouted: false,
            })
            continue
        }

        // Check if rerouted (path differs from clean graph)
        let rerouted = false
        if (cleanAdj) {
            const cleanPaths = findAllShortestPaths(cleanAdj, flow.sourceNodeId, flow.destNodeId)
            if (cleanPaths.length > 0) {
                // Compare first path link sets
                const cleanSet = new Set(cleanPaths[0].linkIds)
                const currentSet = new Set(paths[0].linkIds)
                rerouted = cleanSet.size !== currentSet.size ||
                    [...cleanSet].some(id => !currentSet.has(id))
            }
        }

        for (let i = 0; i < paths.length; i++) {
            results.push({
                flowId: flow.id,
                pathIndex: i,
                linkIds: paths[i].linkIds,
                nodeIds: paths[i].nodeIds,
                broken: false,
                rerouted,
            })
        }
    }

    return results
}

// ── Articulation points (Tarjan's algorithm) ─────────────────────────────────

/**
 * Find articulation points (cut vertices) using Tarjan's algorithm.
 * A node whose removal disconnects the graph is a single point of failure.
 */
export function findArticulationPoints (topology: Topology): string[] {
    const adj = buildAdjacencyGraph(topology)
    const disc = new Map<string, number>()
    const low  = new Map<string, number>()
    const parent = new Map<string, string | null>()
    const ap = new Set<string>()
    let timer = 0

    const dfs = (u: string): void => {
        disc.set(u, timer)
        low.set(u, timer)
        timer++
        let children = 0

        for (const entry of (adj.get(u) ?? [])) {
            const v = entry.neighborNodeId
            if (!disc.has(v)) {
                children++
                parent.set(v, u)
                dfs(v)
                low.set(u, Math.min(low.get(u)!, low.get(v)!))
                if (parent.get(u) === null && children > 1) { ap.add(u) }
                if (parent.get(u) !== null && low.get(v)! >= disc.get(u)!) { ap.add(u) }
            } else if (v !== parent.get(u)) {
                low.set(u, Math.min(low.get(u)!, disc.get(v)!))
            }
        }
    }

    for (const nodeId of adj.keys()) {
        if (!disc.has(nodeId)) {
            parent.set(nodeId, null)
            dfs(nodeId)
        }
    }

    return [...ap]
}
