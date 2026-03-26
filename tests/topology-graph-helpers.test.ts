import {
    buildAdjacencyGraph,
    findAllShortestPaths,
    computeFlowPaths,
    findArticulationPoints,
    MAX_ECMP_PATHS,
} from '../renderer/src/services/topology-graph-helpers'
import { makeTopo, makeNode, makeLink, makeFlow } from './fixtures'

// ---------------------------------------------------------------------------
// buildAdjacencyGraph
// ---------------------------------------------------------------------------
describe('buildAdjacencyGraph', () => {
    it('returns empty map for empty topology', () => {
        const adj = buildAdjacencyGraph(makeTopo())
        expect(adj.size).toBe(0)
    })

    it('includes isolated nodes with empty adjacency lists', () => {
        const adj = buildAdjacencyGraph(makeTopo([makeNode('A'), makeNode('B')]))
        expect(adj.has('A')).toBe(true)
        expect(adj.has('B')).toBe(true)
        expect(adj.get('A')).toEqual([])
        expect(adj.get('B')).toEqual([])
    })

    it('creates bidirectional entries for a single link', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B')],
        )
        const adj = buildAdjacencyGraph(topo)
        expect(adj.get('A')).toEqual([{ neighborNodeId: 'B', linkId: 'L1' }])
        expect(adj.get('B')).toEqual([{ neighborNodeId: 'A', linkId: 'L1' }])
    })

    it('skips links with status "down"', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B', { status: 'down' })],
        )
        const adj = buildAdjacencyGraph(topo)
        expect(adj.get('A')).toEqual([])
        expect(adj.get('B')).toEqual([])
    })

    it('excludes nodes by excludeNodeIds', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [makeLink('L1', 'A', 'B'), makeLink('L2', 'B', 'C')],
        )
        const adj = buildAdjacencyGraph(topo, new Set(['B']))
        expect(adj.has('B')).toBe(false)
        expect(adj.get('A')).toEqual([])
        expect(adj.get('C')).toEqual([])
    })

    it('excludes links by excludeLinkIds', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [makeLink('L1', 'A', 'B'), makeLink('L2', 'B', 'C')],
        )
        const adj = buildAdjacencyGraph(topo, undefined, new Set(['L1']))
        expect(adj.get('A')).toEqual([])
        expect(adj.get('B')!.length).toBe(1)
        expect(adj.get('B')![0].linkId).toBe('L2')
    })

    it('handles parallel links between same nodes', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B'), makeLink('L2', 'A', 'B')],
        )
        const adj = buildAdjacencyGraph(topo)
        expect(adj.get('A')!.length).toBe(2)
        expect(adj.get('B')!.length).toBe(2)
    })

    it('handles disconnected components', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
            [makeLink('L1', 'A', 'B'), makeLink('L2', 'C', 'D')],
        )
        const adj = buildAdjacencyGraph(topo)
        expect(adj.size).toBe(4)
        expect(adj.get('A')!.map(e => e.neighborNodeId)).toEqual(['B'])
        expect(adj.get('C')!.map(e => e.neighborNodeId)).toEqual(['D'])
    })

    it('applies both node and link exclusions simultaneously', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [makeLink('L1', 'A', 'B'), makeLink('L2', 'B', 'C')],
        )
        const adj = buildAdjacencyGraph(topo, new Set(['A']), new Set(['L2']))
        expect(adj.has('A')).toBe(false)
        expect(adj.get('B')).toEqual([])
        expect(adj.get('C')).toEqual([])
    })

    it('treats undefined exclusions as no exclusion', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B')],
        )
        const adj = buildAdjacencyGraph(topo, undefined, undefined)
        expect(adj.get('A')!.length).toBe(1)
    })

    it('handles star topology (one hub, many spokes)', () => {
        const nodes = [makeNode('H'), makeNode('S1'), makeNode('S2'), makeNode('S3')]
        const links = [
            makeLink('L1', 'H', 'S1'),
            makeLink('L2', 'H', 'S2'),
            makeLink('L3', 'H', 'S3'),
        ]
        const adj = buildAdjacencyGraph(makeTopo(nodes, links))
        expect(adj.get('H')!.length).toBe(3)
        expect(adj.get('S1')!.length).toBe(1)
    })
})

// ---------------------------------------------------------------------------
// findAllShortestPaths
// ---------------------------------------------------------------------------
describe('findAllShortestPaths', () => {
    it('returns single-node path when source equals destination', () => {
        const adj = new Map([['A', []]])
        const paths = findAllShortestPaths(adj, 'A', 'A')
        expect(paths).toEqual([{ nodeIds: ['A'], linkIds: [] }])
    })

    it('returns [] when source is not in adjacency', () => {
        const adj = new Map([['B', []]])
        expect(findAllShortestPaths(adj, 'A', 'B')).toEqual([])
    })

    it('returns [] when dest is not in adjacency', () => {
        const adj = new Map([['A', []]])
        expect(findAllShortestPaths(adj, 'A', 'B')).toEqual([])
    })

    it('finds direct neighbor (1-hop path)', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B')],
        )
        const adj = buildAdjacencyGraph(topo)
        const paths = findAllShortestPaths(adj, 'A', 'B')
        expect(paths.length).toBe(1)
        expect(paths[0].nodeIds).toEqual(['A', 'B'])
        expect(paths[0].linkIds).toEqual(['L1'])
    })

    it('finds 2-hop linear path A→B→C', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [makeLink('L1', 'A', 'B'), makeLink('L2', 'B', 'C')],
        )
        const adj = buildAdjacencyGraph(topo)
        const paths = findAllShortestPaths(adj, 'A', 'C')
        expect(paths.length).toBe(1)
        expect(paths[0].nodeIds).toEqual(['A', 'B', 'C'])
        expect(paths[0].linkIds).toEqual(['L1', 'L2'])
    })

    it('finds 2 ECMP paths in diamond topology', () => {
        // A→B→D and A→C→D
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
            [
                makeLink('L1', 'A', 'B'),
                makeLink('L2', 'A', 'C'),
                makeLink('L3', 'B', 'D'),
                makeLink('L4', 'C', 'D'),
            ],
        )
        const adj = buildAdjacencyGraph(topo)
        const paths = findAllShortestPaths(adj, 'A', 'D')
        expect(paths.length).toBe(2)
        // Both paths should be 3 nodes (A, middle, D)
        for (const p of paths) {
            expect(p.nodeIds.length).toBe(3)
            expect(p.nodeIds[0]).toBe('A')
            expect(p.nodeIds[2]).toBe('D')
        }
    })

    it('returns [] for unreachable destination (disconnected)', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [makeLink('L1', 'A', 'B')],
        )
        const adj = buildAdjacencyGraph(topo)
        expect(findAllShortestPaths(adj, 'A', 'C')).toEqual([])
    })

    it('caps ECMP paths at MAX_ECMP_PATHS', () => {
        // Build a topology with many equal-cost paths: A → M1..M5 → B
        const nodes = [makeNode('A'), makeNode('B')]
        const links: ReturnType<typeof makeLink>[] = []
        for (let i = 1; i <= 6; i++) {
            nodes.push(makeNode(`M${i}`))
            links.push(makeLink(`La${i}`, 'A', `M${i}`))
            links.push(makeLink(`Lb${i}`, `M${i}`, 'B'))
        }
        const adj = buildAdjacencyGraph(makeTopo(nodes, links))
        const paths = findAllShortestPaths(adj, 'A', 'B')
        expect(paths.length).toBe(MAX_ECMP_PATHS) // capped at 4
    })

    it('finds shortest path in a 5-node chain', () => {
        const nodes = 'ABCDE'.split('').map(id => makeNode(id))
        const links = [
            makeLink('L1', 'A', 'B'),
            makeLink('L2', 'B', 'C'),
            makeLink('L3', 'C', 'D'),
            makeLink('L4', 'D', 'E'),
        ]
        const adj = buildAdjacencyGraph(makeTopo(nodes, links))
        const paths = findAllShortestPaths(adj, 'A', 'E')
        expect(paths.length).toBe(1)
        expect(paths[0].nodeIds).toEqual(['A', 'B', 'C', 'D', 'E'])
    })

    it('does not infinite-loop on cyclic graph', () => {
        // Triangle: A-B-C-A
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [
                makeLink('L1', 'A', 'B'),
                makeLink('L2', 'B', 'C'),
                makeLink('L3', 'C', 'A'),
            ],
        )
        const adj = buildAdjacencyGraph(topo)
        const paths = findAllShortestPaths(adj, 'A', 'B')
        expect(paths.length).toBeGreaterThanOrEqual(1)
        expect(paths[0].nodeIds).toEqual(['A', 'B'])
    })

    it('prefers shorter path over longer one', () => {
        // A-B direct (1 hop), A-C-B (2 hops)
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [
                makeLink('L1', 'A', 'B'),
                makeLink('L2', 'A', 'C'),
                makeLink('L3', 'C', 'B'),
            ],
        )
        const adj = buildAdjacencyGraph(topo)
        const paths = findAllShortestPaths(adj, 'A', 'B')
        // Should only return the 1-hop path
        expect(paths.length).toBe(1)
        expect(paths[0].nodeIds).toEqual(['A', 'B'])
    })

    it('nodeIds are in source-to-dest order', () => {
        const topo = makeTopo(
            [makeNode('X'), makeNode('Y'), makeNode('Z')],
            [makeLink('L1', 'X', 'Y'), makeLink('L2', 'Y', 'Z')],
        )
        const adj = buildAdjacencyGraph(topo)
        const paths = findAllShortestPaths(adj, 'X', 'Z')
        expect(paths[0].nodeIds[0]).toBe('X')
        expect(paths[0].nodeIds[paths[0].nodeIds.length - 1]).toBe('Z')
    })
})

// ---------------------------------------------------------------------------
// computeFlowPaths
// ---------------------------------------------------------------------------
describe('computeFlowPaths', () => {
    it('returns [] for empty flows array', () => {
        const topo = makeTopo([makeNode('A')], [])
        expect(computeFlowPaths(topo, [])).toEqual([])
    })

    it('returns a single valid path for a direct flow', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B')],
        )
        const flows = [makeFlow('F1', 'A', 'B')]
        const result = computeFlowPaths(topo, flows)
        expect(result.length).toBe(1)
        expect(result[0].flowId).toBe('F1')
        expect(result[0].broken).toBe(false)
        expect(result[0].rerouted).toBe(false)
        expect(result[0].nodeIds).toEqual(['A', 'B'])
    })

    it('marks flow as broken when no path exists', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [],
        )
        const flows = [makeFlow('F1', 'A', 'B')]
        const result = computeFlowPaths(topo, flows)
        expect(result.length).toBe(1)
        expect(result[0].broken).toBe(true)
        expect(result[0].rerouted).toBe(false)
    })

    it('skips disabled flows', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B')],
        )
        const flows = [makeFlow('F1', 'A', 'B', { enabled: false })]
        expect(computeFlowPaths(topo, flows)).toEqual([])
    })

    it('detects rerouting when link is excluded', () => {
        // A-B direct (L1), A-C-B alternate (L2, L3)
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [
                makeLink('L1', 'A', 'B'),
                makeLink('L2', 'A', 'C'),
                makeLink('L3', 'C', 'B'),
            ],
        )
        const flows = [makeFlow('F1', 'A', 'B')]
        const result = computeFlowPaths(topo, flows, undefined, new Set(['L1']))
        expect(result.length).toBe(1)
        expect(result[0].broken).toBe(false)
        expect(result[0].rerouted).toBe(true)
    })

    it('marks flow broken when exclusion removes all paths', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B')],
        )
        const flows = [makeFlow('F1', 'A', 'B')]
        const result = computeFlowPaths(topo, flows, undefined, new Set(['L1']))
        expect(result.length).toBe(1)
        expect(result[0].broken).toBe(true)
    })

    it('returns multiple ECMP paths with correct pathIndex', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
            [
                makeLink('L1', 'A', 'B'),
                makeLink('L2', 'A', 'C'),
                makeLink('L3', 'B', 'D'),
                makeLink('L4', 'C', 'D'),
            ],
        )
        const flows = [makeFlow('F1', 'A', 'D')]
        const result = computeFlowPaths(topo, flows)
        expect(result.length).toBe(2)
        expect(result[0].pathIndex).toBe(0)
        expect(result[1].pathIndex).toBe(1)
    })

    it('handles multiple flows independently', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [makeLink('L1', 'A', 'B'), makeLink('L2', 'B', 'C')],
        )
        const flows = [
            makeFlow('F1', 'A', 'B'),
            makeFlow('F2', 'B', 'C'),
        ]
        const result = computeFlowPaths(topo, flows)
        expect(result.length).toBe(2)
        expect(result[0].flowId).toBe('F1')
        expect(result[1].flowId).toBe('F2')
    })

    it('rerouted is false when no exclusions are set', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B')],
        )
        const flows = [makeFlow('F1', 'A', 'B')]
        const result = computeFlowPaths(topo, flows)
        expect(result[0].rerouted).toBe(false)
    })

    it('handles node exclusion breaking a flow', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [makeLink('L1', 'A', 'B'), makeLink('L2', 'B', 'C')],
        )
        const flows = [makeFlow('F1', 'A', 'C')]
        const result = computeFlowPaths(topo, flows, new Set(['B']))
        expect(result[0].broken).toBe(true)
    })

    it('reroutes via alternate node when primary path node excluded', () => {
        // A-B-D direct, A-C-D alternate
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
            [
                makeLink('L1', 'A', 'B'),
                makeLink('L2', 'B', 'D'),
                makeLink('L3', 'A', 'C'),
                makeLink('L4', 'C', 'D'),
            ],
        )
        const flows = [makeFlow('F1', 'A', 'D')]
        const result = computeFlowPaths(topo, flows, new Set(['B']))
        expect(result.length).toBe(1)
        expect(result[0].broken).toBe(false)
        expect(result[0].rerouted).toBe(true)
        expect(result[0].nodeIds).toContain('C')
    })
})

// ---------------------------------------------------------------------------
// findArticulationPoints
// ---------------------------------------------------------------------------
describe('findArticulationPoints', () => {
    it('returns [] for single node', () => {
        expect(findArticulationPoints(makeTopo([makeNode('A')]))).toEqual([])
    })

    it('returns [] for two connected nodes', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B')],
            [makeLink('L1', 'A', 'B')],
        )
        expect(findArticulationPoints(topo)).toEqual([])
    })

    it('finds interior node in chain A-B-C', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [makeLink('L1', 'A', 'B'), makeLink('L2', 'B', 'C')],
        )
        const ap = findArticulationPoints(topo)
        expect(ap).toContain('B')
        expect(ap).not.toContain('A')
        expect(ap).not.toContain('C')
    })

    it('returns [] for triangle (complete K3)', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C')],
            [
                makeLink('L1', 'A', 'B'),
                makeLink('L2', 'B', 'C'),
                makeLink('L3', 'C', 'A'),
            ],
        )
        expect(findArticulationPoints(topo)).toEqual([])
    })

    it('finds hub in star topology', () => {
        const topo = makeTopo(
            [makeNode('H'), makeNode('S1'), makeNode('S2'), makeNode('S3')],
            [
                makeLink('L1', 'H', 'S1'),
                makeLink('L2', 'H', 'S2'),
                makeLink('L3', 'H', 'S3'),
            ],
        )
        const ap = findArticulationPoints(topo)
        expect(ap).toContain('H')
        expect(ap.length).toBe(1)
    })

    it('returns [] for ring topology', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
            [
                makeLink('L1', 'A', 'B'),
                makeLink('L2', 'B', 'C'),
                makeLink('L3', 'C', 'D'),
                makeLink('L4', 'D', 'A'),
            ],
        )
        expect(findArticulationPoints(topo)).toEqual([])
    })

    it('finds bridge node connecting two triangles', () => {
        // Triangle1: A-B-C, Triangle2: D-E-F, connected via C-D
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D'), makeNode('E'), makeNode('F')],
            [
                makeLink('L1', 'A', 'B'),
                makeLink('L2', 'B', 'C'),
                makeLink('L3', 'C', 'A'),
                makeLink('L4', 'C', 'D'),
                makeLink('L5', 'D', 'E'),
                makeLink('L6', 'E', 'F'),
                makeLink('L7', 'F', 'D'),
            ],
        )
        const ap = findArticulationPoints(topo)
        expect(ap).toContain('C')
        expect(ap).toContain('D')
    })

    it('returns [] for empty topology', () => {
        expect(findArticulationPoints(makeTopo())).toEqual([])
    })

    it('returns [] for complete graph K4', () => {
        const ids = ['A', 'B', 'C', 'D']
        const nodes = ids.map(id => makeNode(id))
        const links = [
            makeLink('L1', 'A', 'B'),
            makeLink('L2', 'A', 'C'),
            makeLink('L3', 'A', 'D'),
            makeLink('L4', 'B', 'C'),
            makeLink('L5', 'B', 'D'),
            makeLink('L6', 'C', 'D'),
        ]
        expect(findArticulationPoints(makeTopo(nodes, links))).toEqual([])
    })

    it('finds all interior nodes in a long chain', () => {
        const nodes = 'ABCDE'.split('').map(id => makeNode(id))
        const links = [
            makeLink('L1', 'A', 'B'),
            makeLink('L2', 'B', 'C'),
            makeLink('L3', 'C', 'D'),
            makeLink('L4', 'D', 'E'),
        ]
        const ap = findArticulationPoints(makeTopo(nodes, links))
        expect(ap).toContain('B')
        expect(ap).toContain('C')
        expect(ap).toContain('D')
        expect(ap).not.toContain('A')
        expect(ap).not.toContain('E')
    })

    it('handles disconnected graph', () => {
        const topo = makeTopo(
            [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')],
            [makeLink('L1', 'A', 'B')],
        )
        // Disconnected — A-B and C, D isolated
        const ap = findArticulationPoints(topo)
        // No articulation points because removing any node doesn't further disconnect
        expect(ap).toEqual([])
    })
})
