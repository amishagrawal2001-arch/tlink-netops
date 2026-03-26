// ─── Topology Graph Service ────────────────────────────────────────────────────
// Provides BFS-based shortest-path computation for traffic flow visualization
// and failure simulation.  Delegates to pure helper functions for testability.

import { Injectable } from '@angular/core'
import { Topology, TrafficFlow, ComputedFlowPath } from '../api/interfaces'
import {
    AdjEntry,
    buildAdjacencyGraph as _buildAdjacencyGraph,
    findAllShortestPaths as _findAllShortestPaths,
    computeFlowPaths as _computeFlowPaths,
    findArticulationPoints as _findArticulationPoints,
} from './topology-graph-helpers'

// Re-export so existing consumers don't break
export {
    buildAdjacencyGraph, findAllShortestPaths, computeFlowPaths, findArticulationPoints,
    AdjEntry, MAX_ECMP_PATHS,
} from './topology-graph-helpers'

// ── Service ─────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class TopologyGraphService {

    buildAdjacencyGraph (
        topology: Topology,
        excludeNodeIds?: Set<string>,
        excludeLinkIds?: Set<string>,
    ): Map<string, AdjEntry[]> {
        return _buildAdjacencyGraph(topology, excludeNodeIds, excludeLinkIds)
    }

    findAllShortestPaths (
        adjacency: Map<string, AdjEntry[]>,
        sourceId: string,
        destId: string,
    ): { nodeIds: string[]; linkIds: string[] }[] {
        return _findAllShortestPaths(adjacency, sourceId, destId)
    }

    computeFlowPaths (
        topology: Topology,
        flows: TrafficFlow[],
        excludeNodeIds?: Set<string>,
        excludeLinkIds?: Set<string>,
    ): ComputedFlowPath[] {
        return _computeFlowPaths(topology, flows, excludeNodeIds, excludeLinkIds)
    }

    findArticulationPoints (topology: Topology): string[] {
        return _findArticulationPoints(topology)
    }
}
