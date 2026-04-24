// ═══════════════════════════════════════════════════════════════════════════════
// Regression test — TopologyService.applyProtocol
//
// Bug: when `nodeIds` (scope = "selected") was provided, applyProtocol patched
// the topology with the FILTERED subset of nodes, dropping every unselected
// node from `topology.nodes`. Users reported "one of the devices was removed
// from the topology after Set Protocol".
//
// Fix: always patch back the full `topology.nodes` array (mutations already
// happened in place on the shared object references).
// ═══════════════════════════════════════════════════════════════════════════════

// Stub @angular/core — TopologyService uses only the @Injectable() decorator.
// Without this, Jest fails to transpile the ESM output of @angular/core.
jest.mock('@angular/core', () => ({
    Injectable: () => (target: any) => target,
}))

// eslint-disable-next-line import/first
import { TopologyService } from '../renderer/src/services/topology.service'
// eslint-disable-next-line import/first
import type { TopologyNode, TopologyLink } from '../renderer/src/api/interfaces'

function makeNode (id: string, label: string, role: string, type: string = 'switch'): TopologyNode {
    return {
        id,
        label,
        type: type as any,
        role: role as any,
        x: 0, y: 0,
        status: 'stopped',
        ports: [],
        mapped: false,
    } as any
}

function seedTopology (svc: TopologyService): { nodes: TopologyNode[]; links: TopologyLink[] } {
    const nodes: TopologyNode[] = [
        makeNode('n1', 'Spine-1', 'spine'),
        makeNode('n2', 'Spine-2', 'spine'),
        makeNode('n3', 'Leaf-1', 'leaf'),
        makeNode('n4', 'Leaf-2', 'leaf'),
        makeNode('n5', 'Leaf-3', 'leaf'),
        makeNode('n6', 'Server-A', 'host', 'server'),
    ]
    const links: TopologyLink[] = []
    // Access private-ish setter by reaching into the BehaviorSubject
    const subj = (svc as any)._topology$
    subj.next({
        ...subj.value,
        nodes,
        links,
    })
    return { nodes, links }
}

describe('TopologyService.applyProtocol — node preservation', () => {

    it('preserves all nodes when scope = all', () => {
        const svc = new TopologyService()
        seedTopology(svc)

        const before = svc.topology.nodes.map(n => n.id).sort()
        expect(before).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])

        svc.applyProtocol('ebgp', { spineAsnStart: 65000, leafAsnStart: 65100 })

        const after = svc.topology.nodes.map(n => n.id).sort()
        expect(after).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
        expect(svc.topology.nodes.length).toBe(6)
    })

    it('preserves all nodes when scope = selected (regression for subset-filter bug)', () => {
        const svc = new TopologyService()
        seedTopology(svc)

        // Only select Spine-1 and Leaf-1
        const selected = new Set(['n1', 'n3'])

        svc.applyProtocol('ebgp', { spineAsnStart: 65000, leafAsnStart: 65100 }, selected)

        // CRITICAL: all 6 nodes must still be present
        const after = svc.topology.nodes.map(n => n.id).sort()
        expect(after).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
        expect(svc.topology.nodes.length).toBe(6)
    })

    it('applies protocol fields only to selected nodes', () => {
        const svc = new TopologyService()
        seedTopology(svc)

        const selected = new Set(['n1', 'n3'])
        svc.applyProtocol('ebgp', { spineAsnStart: 65000, leafAsnStart: 65100 }, selected)

        const byId = new Map(svc.topology.nodes.map(n => [n.id, n]))

        // Selected nodes got ASNs
        expect(byId.get('n1')?.asn).toBeDefined()
        expect(byId.get('n3')?.asn).toBeDefined()

        // Unselected nodes were NOT modified
        expect(byId.get('n2')?.asn).toBeUndefined()
        expect(byId.get('n4')?.asn).toBeUndefined()
        expect(byId.get('n5')?.asn).toBeUndefined()
    })

    it('clears protocol fields when proto = none', () => {
        const svc = new TopologyService()
        seedTopology(svc)

        svc.applyProtocol('ebgp', { spineAsnStart: 65000, leafAsnStart: 65100 })
        expect(svc.topology.nodes.find(n => n.id === 'n1')?.asn).toBeDefined()
        expect(svc.topology.underlayProtocol).toBe('ebgp')

        svc.applyProtocol('none', {})
        expect(svc.topology.nodes.every(n => n.asn === undefined)).toBe(true)
        expect(svc.topology.underlayProtocol).toBeUndefined()
        // All nodes still present
        expect(svc.topology.nodes.length).toBe(6)
    })

    it('skips non-routing types (server/pc/host) for ASN assignment', () => {
        const svc = new TopologyService()
        seedTopology(svc)

        svc.applyProtocol('ebgp', { spineAsnStart: 65000, leafAsnStart: 65100 })

        const server = svc.topology.nodes.find(n => n.id === 'n6')
        expect(server).toBeDefined()
        expect(server?.asn).toBeUndefined()
    })

    it('returns the count of nodes actually iterated', () => {
        const svc = new TopologyService()
        seedTopology(svc)

        const allCount = svc.applyProtocol('ebgp', {})
        expect(allCount).toBe(6)

        const subsetCount = svc.applyProtocol('ebgp', {}, new Set(['n1', 'n3']))
        expect(subsetCount).toBe(2)
    })
})
