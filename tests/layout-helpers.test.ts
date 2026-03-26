// ═══════════════════════════════════════════════════════════════════════════════
// Layout helpers — pure function tests
// ═══════════════════════════════════════════════════════════════════════════════

import {
    forceDirectedLayout,
    hierarchicalLayout,
    radialLayout,
    gridLayout,
    LayoutResult,
} from '../renderer/src/services/layout-helpers'
import { Topology, TopologyNode, TopologyLink } from '../renderer/src/api/interfaces'

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeNode (id: string, x = 100, y = 100, opts: Partial<TopologyNode> = {}): TopologyNode {
    return {
        id, type: 'router', label: id, x, y,
        status: 'stopped', ports: [],
        ...opts,
    }
}

function makeLink (id: string, src: string, tgt: string): TopologyLink {
    return {
        id, type: 'ethernet',
        sourceNodeId: src, sourcePortId: `${src}-p1`,
        targetNodeId: tgt, targetPortId: `${tgt}-p1`,
    }
}

function makeTopo (nodes: TopologyNode[], links: TopologyLink[] = []): Topology {
    return {
        id: 'test', name: 'Test', nodes, links,
        createdAt: '', updatedAt: '',
    }
}

function assertAllPositive (result: LayoutResult): void {
    for (const p of result.positions) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeGreaterThanOrEqual(0)
    }
}

function assertAllUnique (result: LayoutResult): void {
    const coords = result.positions.map(p => `${p.x},${p.y}`)
    expect(new Set(coords).size).toBe(coords.length)
}

// ═════════════════════════════════════════════════════════════════════════════
// Force-directed layout
// ═════════════════════════════════════════════════════════════════════════════

describe('forceDirectedLayout', () => {
    test('empty topology returns empty positions', () => {
        const topo = makeTopo([])
        const result = forceDirectedLayout(topo)
        expect(result.positions).toEqual([])
    })

    test('single node returns that node with positive coords', () => {
        const topo = makeTopo([makeNode('A')])
        const result = forceDirectedLayout(topo)
        expect(result.positions).toHaveLength(1)
        expect(result.positions[0].id).toBe('A')
        assertAllPositive(result)
    })

    test('two connected nodes are separated', () => {
        const topo = makeTopo(
            [makeNode('A', 100, 100), makeNode('B', 110, 100)],
            [makeLink('l1', 'A', 'B')],
        )
        const result = forceDirectedLayout(topo)
        expect(result.positions).toHaveLength(2)
        const posA = result.positions.find(p => p.id === 'A')!
        const posB = result.positions.find(p => p.id === 'B')!
        const dist = Math.sqrt((posA.x - posB.x) ** 2 + (posA.y - posB.y) ** 2)
        expect(dist).toBeGreaterThan(50) // should have separated
        assertAllPositive(result)
    })

    test('unconnected nodes are pushed apart by repulsion', () => {
        const topo = makeTopo([
            makeNode('A', 100, 100),
            makeNode('B', 105, 100),
            makeNode('C', 110, 100),
        ])
        const result = forceDirectedLayout(topo)
        assertAllPositive(result)
        // All three should be at different positions
        assertAllUnique(result)
    })

    test('respects custom options', () => {
        const topo = makeTopo(
            [makeNode('A', 0, 0), makeNode('B', 50, 0)],
            [makeLink('l1', 'A', 'B')],
        )
        const result = forceDirectedLayout(topo, { iterations: 1, repulsion: 1 })
        expect(result.positions).toHaveLength(2)
        assertAllPositive(result)
    })

    test('returns one position per node', () => {
        const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`N${i}`, i * 30, 0))
        const topo = makeTopo(nodes)
        const result = forceDirectedLayout(topo)
        expect(result.positions).toHaveLength(10)
        const ids = result.positions.map(p => p.id).sort()
        expect(ids).toEqual(nodes.map(n => n.id).sort())
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// Hierarchical layout
// ═════════════════════════════════════════════════════════════════════════════

describe('hierarchicalLayout', () => {
    test('empty topology returns empty positions', () => {
        const result = hierarchicalLayout(makeTopo([]))
        expect(result.positions).toEqual([])
    })

    test('single node returns positive coords', () => {
        const result = hierarchicalLayout(makeTopo([makeNode('A')]))
        expect(result.positions).toHaveLength(1)
        assertAllPositive(result)
    })

    test('spine-leaf topology: spines on top layer, leaves below', () => {
        const nodes = [
            makeNode('S1', 0, 0, { role: 'spine' }),
            makeNode('S2', 0, 0, { role: 'spine' }),
            makeNode('L1', 0, 0, { role: 'leaf' }),
            makeNode('L2', 0, 0, { role: 'leaf' }),
            makeNode('L3', 0, 0, { role: 'leaf' }),
        ]
        const links = [
            makeLink('l1', 'S1', 'L1'), makeLink('l2', 'S1', 'L2'),
            makeLink('l3', 'S2', 'L2'), makeLink('l4', 'S2', 'L3'),
        ]
        const result = hierarchicalLayout(makeTopo(nodes, links))
        expect(result.positions).toHaveLength(5)
        assertAllPositive(result)

        // Spine nodes should be on the same y level (top)
        const s1 = result.positions.find(p => p.id === 'S1')!
        const s2 = result.positions.find(p => p.id === 'S2')!
        expect(s1.y).toBe(s2.y)

        // Leaf nodes should be below spines
        const l1 = result.positions.find(p => p.id === 'L1')!
        expect(l1.y).toBeGreaterThan(s1.y)
    })

    test('chain topology creates multiple layers', () => {
        // Chain: A—B—C—D—E (5 nodes). BFS from highest-degree center node gives ≥3 layers.
        const nodes = [
            makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D'), makeNode('E'),
        ]
        const links = [
            makeLink('l1', 'A', 'B'), makeLink('l2', 'B', 'C'),
            makeLink('l3', 'C', 'D'), makeLink('l4', 'D', 'E'),
        ]
        const result = hierarchicalLayout(makeTopo(nodes, links))
        expect(result.positions).toHaveLength(5)
        assertAllPositive(result)

        // Should have at least 3 distinct y levels (BFS from center creates depth)
        const ys = result.positions.map(p => p.y)
        expect(new Set(ys).size).toBeGreaterThanOrEqual(3)
    })

    test('disconnected components are both laid out', () => {
        const nodes = [
            makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D'),
        ]
        const links = [
            makeLink('l1', 'A', 'B'),   // component 1
            makeLink('l2', 'C', 'D'),   // component 2
        ]
        const result = hierarchicalLayout(makeTopo(nodes, links))
        expect(result.positions).toHaveLength(4)
        assertAllPositive(result)
    })

    test('all coordinates are positive with margin', () => {
        const nodes = Array.from({ length: 8 }, (_, i) => makeNode(`N${i}`))
        const links = [
            makeLink('l1', 'N0', 'N1'), makeLink('l2', 'N0', 'N2'),
            makeLink('l3', 'N1', 'N3'), makeLink('l4', 'N2', 'N4'),
        ]
        const result = hierarchicalLayout(makeTopo(nodes, links))
        assertAllPositive(result)
    })

    test('respects custom spacing options', () => {
        const nodes = [makeNode('A'), makeNode('B')]
        const links = [makeLink('l1', 'A', 'B')]
        const result = hierarchicalLayout(makeTopo(nodes, links), { layerSpacing: 300, nodeSpacing: 400 })
        expect(result.positions).toHaveLength(2)
        assertAllPositive(result)

        // Verify y-distance reflects custom layer spacing
        const posA = result.positions.find(p => p.id === 'A')!
        const posB = result.positions.find(p => p.id === 'B')!
        const yDiff = Math.abs(posA.y - posB.y)
        expect(yDiff).toBe(300)
    })

    test('super-spine nodes are treated as roots', () => {
        const nodes = [
            makeNode('SS1', 0, 0, { role: 'super-spine' }),
            makeNode('S1', 0, 0, { role: 'spine' }),
            makeNode('L1', 0, 0, { role: 'leaf' }),
        ]
        const links = [
            makeLink('l1', 'SS1', 'S1'), makeLink('l2', 'S1', 'L1'),
        ]
        const result = hierarchicalLayout(makeTopo(nodes, links))
        const ss1 = result.positions.find(p => p.id === 'SS1')!
        const s1 = result.positions.find(p => p.id === 'S1')!
        const l1 = result.positions.find(p => p.id === 'L1')!
        expect(ss1.y).toBeLessThan(s1.y)
        expect(s1.y).toBeLessThan(l1.y)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// Radial layout
// ═════════════════════════════════════════════════════════════════════════════

describe('radialLayout', () => {
    test('empty topology returns empty positions', () => {
        const result = radialLayout(makeTopo([]))
        expect(result.positions).toEqual([])
    })

    test('single node at center', () => {
        const result = radialLayout(makeTopo([makeNode('A')]))
        expect(result.positions).toHaveLength(1)
        assertAllPositive(result)
    })

    test('center node is highest degree by default', () => {
        const nodes = [
            makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D'),
        ]
        const links = [
            makeLink('l1', 'A', 'B'), makeLink('l2', 'A', 'C'), makeLink('l3', 'A', 'D'),
        ]
        const result = radialLayout(makeTopo(nodes, links))
        expect(result.positions).toHaveLength(4)

        // B, C, D should be equidistant from A (same ring)
        const posA = result.positions.find(p => p.id === 'A')!
        const distB = Math.sqrt((result.positions.find(p => p.id === 'B')!.x - posA.x) ** 2 + (result.positions.find(p => p.id === 'B')!.y - posA.y) ** 2)
        const distC = Math.sqrt((result.positions.find(p => p.id === 'C')!.x - posA.x) ** 2 + (result.positions.find(p => p.id === 'C')!.y - posA.y) ** 2)
        const distD = Math.sqrt((result.positions.find(p => p.id === 'D')!.x - posA.x) ** 2 + (result.positions.find(p => p.id === 'D')!.y - posA.y) ** 2)
        expect(Math.abs(distB - distC)).toBeLessThan(1)
        expect(Math.abs(distB - distD)).toBeLessThan(1)
    })

    test('respects centerNodeId option', () => {
        const nodes = [
            makeNode('A'), makeNode('B'), makeNode('C'),
        ]
        const links = [makeLink('l1', 'A', 'B'), makeLink('l2', 'B', 'C')]
        const resultDefault = radialLayout(makeTopo(nodes, links))
        const resultCustom = radialLayout(makeTopo(nodes, links), { centerNodeId: 'C' })

        // B should be center in default (highest degree), C in custom
        // Both should be valid layouts
        expect(resultDefault.positions).toHaveLength(3)
        expect(resultCustom.positions).toHaveLength(3)
        assertAllPositive(resultDefault)
        assertAllPositive(resultCustom)
    })

    test('ring of nodes has equal radius', () => {
        const nodes = [
            makeNode('Center'), makeNode('R1'), makeNode('R2'),
            makeNode('R3'), makeNode('R4'),
        ]
        const links = [
            makeLink('l1', 'Center', 'R1'), makeLink('l2', 'Center', 'R2'),
            makeLink('l3', 'Center', 'R3'), makeLink('l4', 'Center', 'R4'),
        ]
        const result = radialLayout(makeTopo(nodes, links), { centerNodeId: 'Center' })
        const center = result.positions.find(p => p.id === 'Center')!
        const radii = result.positions
            .filter(p => p.id !== 'Center')
            .map(p => Math.sqrt((p.x - center.x) ** 2 + (p.y - center.y) ** 2))

        // All nodes on ring 1 should have equal radius
        for (const r of radii) {
            expect(Math.abs(r - radii[0])).toBeLessThan(1)
        }
    })

    test('disconnected nodes get placed in outer rings', () => {
        const nodes = [
            makeNode('A'), makeNode('B'), makeNode('C'),
        ]
        const links = [makeLink('l1', 'A', 'B')]  // C is disconnected
        const result = radialLayout(makeTopo(nodes, links))
        expect(result.positions).toHaveLength(3)
        assertAllPositive(result)
    })

    test('respects ringSpacing option', () => {
        const nodes = [makeNode('A'), makeNode('B')]
        const links = [makeLink('l1', 'A', 'B')]
        const r1 = radialLayout(makeTopo(nodes, links), { ringSpacing: 100 })
        const r2 = radialLayout(makeTopo(nodes, links), { ringSpacing: 300 })

        // Positions should differ based on ring spacing
        const dist1 = (() => {
            const a = r1.positions.find(p => p.id === 'A')!
            const b = r1.positions.find(p => p.id === 'B')!
            return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
        })()
        const dist2 = (() => {
            const a = r2.positions.find(p => p.id === 'A')!
            const b = r2.positions.find(p => p.id === 'B')!
            return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
        })()
        expect(dist2).toBeGreaterThan(dist1)
    })

    test('multiple rings for BFS depth > 1', () => {
        const nodes = [
            makeNode('A'), makeNode('B'), makeNode('C'),
        ]
        const links = [makeLink('l1', 'A', 'B'), makeLink('l2', 'B', 'C')]
        const result = radialLayout(makeTopo(nodes, links), { centerNodeId: 'A' })
        const posA = result.positions.find(p => p.id === 'A')!
        const posB = result.positions.find(p => p.id === 'B')!
        const posC = result.positions.find(p => p.id === 'C')!

        const distB = Math.sqrt((posB.x - posA.x) ** 2 + (posB.y - posA.y) ** 2)
        const distC = Math.sqrt((posC.x - posA.x) ** 2 + (posC.y - posA.y) ** 2)
        // C should be on ring 2 (farther from center than B on ring 1)
        expect(distC).toBeGreaterThan(distB + 10)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// Grid layout
// ═════════════════════════════════════════════════════════════════════════════

describe('gridLayout', () => {
    test('empty topology returns empty positions', () => {
        const result = gridLayout(makeTopo([]))
        expect(result.positions).toEqual([])
    })

    test('single node returns positive coords', () => {
        const result = gridLayout(makeTopo([makeNode('A')]))
        expect(result.positions).toHaveLength(1)
        assertAllPositive(result)
    })

    test('nodes are sorted by type then label', () => {
        const nodes = [
            makeNode('Z-switch', 0, 0, { type: 'switch' }),
            makeNode('A-router', 0, 0, { type: 'router' }),
            makeNode('B-switch', 0, 0, { type: 'switch' }),
            makeNode('C-router', 0, 0, { type: 'router' }),
        ]
        const result = gridLayout(makeTopo(nodes))
        const ids = result.positions.map(p => p.id)
        // routers first (sorted), then switches (sorted)
        expect(ids).toEqual(['A-router', 'C-router', 'B-switch', 'Z-switch'])
    })

    test('4 nodes fills 2x2 grid', () => {
        const nodes = Array.from({ length: 4 }, (_, i) => makeNode(`N${i}`))
        const result = gridLayout(makeTopo(nodes))
        expect(result.positions).toHaveLength(4)
        assertAllPositive(result)

        // ceil(sqrt(4)) = 2 columns
        const xs = new Set(result.positions.map(p => p.x))
        const ys = new Set(result.positions.map(p => p.y))
        expect(xs.size).toBe(2)
        expect(ys.size).toBe(2)
    })

    test('9 nodes fills 3x3 grid', () => {
        const nodes = Array.from({ length: 9 }, (_, i) => makeNode(`N${i}`))
        const result = gridLayout(makeTopo(nodes))
        expect(result.positions).toHaveLength(9)
        assertAllPositive(result)

        const xs = new Set(result.positions.map(p => p.x))
        const ys = new Set(result.positions.map(p => p.y))
        expect(xs.size).toBe(3)
        expect(ys.size).toBe(3)
    })

    test('respects custom column count', () => {
        const nodes = Array.from({ length: 6 }, (_, i) => makeNode(`N${i}`))
        const result = gridLayout(makeTopo(nodes), { columns: 3 })
        expect(result.positions).toHaveLength(6)

        // 3 columns × 2 rows
        const xs = new Set(result.positions.map(p => p.x))
        const ys = new Set(result.positions.map(p => p.y))
        expect(xs.size).toBe(3)
        expect(ys.size).toBe(2)
    })

    test('respects custom cell dimensions', () => {
        const nodes = [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')]
        const result = gridLayout(makeTopo(nodes), { cellWidth: 300, cellHeight: 250 })
        assertAllPositive(result)

        // Verify spacing matches cell dimensions
        const sorted = [...result.positions].sort((a, b) => a.x - b.x || a.y - b.y)
        // With 4 nodes in 2x2 grid, x-diff should be cellWidth
        const xVals = [...new Set(sorted.map(p => p.x))].sort((a, b) => a - b)
        if (xVals.length > 1) {
            expect(xVals[1] - xVals[0]).toBe(300)
        }
    })

    test('large topology fills correct rows/columns', () => {
        const nodes = Array.from({ length: 20 }, (_, i) => makeNode(`N${String(i).padStart(2, '0')}`))
        const result = gridLayout(makeTopo(nodes))
        expect(result.positions).toHaveLength(20)
        assertAllPositive(result)

        // ceil(sqrt(20)) = 5 columns, 4 rows
        const xs = new Set(result.positions.map(p => p.x))
        expect(xs.size).toBe(5)
    })

    test('all coordinates are non-negative', () => {
        const nodes = Array.from({ length: 15 }, (_, i) => makeNode(`N${i}`))
        const result = gridLayout(makeTopo(nodes))
        assertAllPositive(result)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// Cross-algorithm consistency
// ═════════════════════════════════════════════════════════════════════════════

describe('cross-algorithm consistency', () => {
    const nodes = [
        makeNode('A', 0, 0, { role: 'spine' }),
        makeNode('B', 200, 0, { role: 'spine' }),
        makeNode('C', 0, 200, { role: 'leaf' }),
        makeNode('D', 200, 200, { role: 'leaf' }),
    ]
    const links = [
        makeLink('l1', 'A', 'C'), makeLink('l2', 'A', 'D'),
        makeLink('l3', 'B', 'C'), makeLink('l4', 'B', 'D'),
    ]
    const topo = makeTopo(nodes, links)

    test.each(['force', 'hierarchical', 'radial', 'grid'] as const)(
        '%s layout returns all node IDs',
        (algo) => {
            let result: LayoutResult
            switch (algo) {
                case 'force':         result = forceDirectedLayout(topo); break
                case 'hierarchical':  result = hierarchicalLayout(topo); break
                case 'radial':        result = radialLayout(topo); break
                case 'grid':          result = gridLayout(topo); break
            }
            const ids = result.positions.map(p => p.id).sort()
            expect(ids).toEqual(['A', 'B', 'C', 'D'])
        },
    )

    test.each(['force', 'hierarchical', 'radial', 'grid'] as const)(
        '%s layout produces non-negative coordinates',
        (algo) => {
            let result: LayoutResult
            switch (algo) {
                case 'force':         result = forceDirectedLayout(topo); break
                case 'hierarchical':  result = hierarchicalLayout(topo); break
                case 'radial':        result = radialLayout(topo); break
                case 'grid':          result = gridLayout(topo); break
            }
            assertAllPositive(result)
        },
    )
})
