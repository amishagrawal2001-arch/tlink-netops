import { diffTopologies, formatDiffText } from '../renderer/src/services/topology-diff'
import { makeTopo, makeNode, makeLink } from './fixtures'

describe('diffTopologies', () => {
    it('identical topologies produce zero changes', () => {
        const t = makeTopo(
            [makeNode('n1'), makeNode('n2')],
            [makeLink('l1', 'n1', 'n2')],
        )
        const d = diffTopologies(t, t)
        expect(d.summary.nodesAdded).toBe(0)
        expect(d.summary.nodesRemoved).toBe(0)
        expect(d.summary.nodesModified).toBe(0)
        expect(d.summary.linksAdded).toBe(0)
        expect(d.summary.linksRemoved).toBe(0)
        expect(d.topologyChanges).toEqual([])
    })

    it('detects added node', () => {
        const before = makeTopo([makeNode('n1')], [])
        const after = makeTopo([makeNode('n1'), makeNode('n2')], [])
        const d = diffTopologies(before, after)
        expect(d.summary.nodesAdded).toBe(1)
        expect(d.nodes.find(n => n.id === 'n2')?.status).toBe('added')
    })

    it('detects removed node', () => {
        const before = makeTopo([makeNode('n1'), makeNode('n2')], [])
        const after = makeTopo([makeNode('n1')], [])
        const d = diffTopologies(before, after)
        expect(d.summary.nodesRemoved).toBe(1)
        expect(d.nodes.find(n => n.id === 'n2')?.status).toBe('removed')
    })

    it('detects modified node with field changes', () => {
        const before = makeTopo([makeNode('n1', { vendor: 'Juniper', asn: 65001 })], [])
        const after = makeTopo([makeNode('n1', { vendor: 'Arista', asn: 65002 })], [])
        const d = diffTopologies(before, after)
        expect(d.summary.nodesModified).toBe(1)
        const diff = d.nodes.find(n => n.id === 'n1')!
        expect(diff.status).toBe('modified')
        expect(diff.changes).toHaveLength(2)
        expect(diff.changes.find(c => c.field === 'vendor')).toEqual({
            field: 'vendor', before: 'Juniper', after: 'Arista',
        })
        expect(diff.changes.find(c => c.field === 'asn')).toEqual({
            field: 'asn', before: 65001, after: 65002,
        })
    })

    it('detects link changes', () => {
        const before = makeTopo(
            [makeNode('n1'), makeNode('n2')],
            [makeLink('l1', 'n1', 'n2')],
        )
        const after = makeTopo(
            [makeNode('n1'), makeNode('n2'), makeNode('n3')],
            [makeLink('l1', 'n1', 'n2'), makeLink('l2', 'n2', 'n3')],
        )
        const d = diffTopologies(before, after)
        expect(d.summary.linksAdded).toBe(1)
        expect(d.links.find(l => l.id === 'l2')?.status).toBe('added')
    })

    it('detects port changes', () => {
        const before = makeTopo([
            makeNode('n1', { ports: [{ id: 'p1', label: 'eth0', enabled: true, vlanMode: 'access', vlan: 100 }] }),
        ], [])
        const after = makeTopo([
            makeNode('n1', { ports: [{ id: 'p1', label: 'eth0', enabled: true, vlanMode: 'trunk', trunkNativeVlan: 999 }] }),
        ], [])
        const d = diffTopologies(before, after)
        expect(d.summary.portsChanged).toBe(1)
        const portDiff = d.ports[0]
        expect(portDiff.status).toBe('modified')
        expect(portDiff.changes.find(c => c.field === 'vlanMode')).toEqual({
            field: 'vlanMode', before: 'access', after: 'trunk',
        })
    })

    it('detects topology-level changes (underlayProtocol, overlayEnabled)', () => {
        const before = { ...makeTopo([], []), underlayProtocol: 'ebgp' as const, overlayEnabled: false }
        const after = { ...makeTopo([], []), underlayProtocol: 'isis' as const, overlayEnabled: true }
        const d = diffTopologies(before as any, after as any)
        expect(d.topologyChanges.length).toBeGreaterThanOrEqual(2)
        expect(d.topologyChanges.find(c => c.field === 'underlayProtocol')).toEqual({
            field: 'underlayProtocol', before: 'ebgp', after: 'isis',
        })
    })

    it('formatDiffText produces readable text', () => {
        const before = makeTopo([makeNode('n1', { vendor: 'Juniper' })], [])
        const after = makeTopo([
            makeNode('n1', { vendor: 'Arista' }),
            makeNode('n2', { label: 'New-Node' }),
        ], [])
        const d = diffTopologies(before, after)
        const text = formatDiffText(d)
        expect(text).toContain('Topology Diff')
        expect(text).toContain('Added nodes')
        expect(text).toContain('Modified nodes')
        expect(text).toContain('vendor')
    })
})
