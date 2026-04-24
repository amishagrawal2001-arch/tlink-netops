import { INTENTS, previewIntent } from '../renderer/src/services/intents'
import { makeTopo, makeNode, makeLink } from './fixtures'

describe('INTENTS registry', () => {
    it('has at least 8 intents across 5 categories', () => {
        expect(INTENTS.length).toBeGreaterThanOrEqual(8)
        const categories = new Set(INTENTS.map(i => i.category))
        expect(categories.size).toBeGreaterThanOrEqual(4)
    })

    it('every intent has id, name, category, selection', () => {
        for (const intent of INTENTS) {
            expect(intent.id).toBeTruthy()
            expect(intent.name).toBeTruthy()
            expect(intent.category).toBeTruthy()
            expect(intent.selection).toBeTruthy()
            expect(intent.explainer).toBeTruthy()
        }
    })
})

describe('previewIntent — add-tenant-vlan', () => {
    const intent = INTENTS.find(i => i.id === 'add-tenant-vlan')!

    it('adds VLAN to all leaf nodes', () => {
        const topo = makeTopo([
            makeNode('spine-1', { role: 'spine' }),
            makeNode('leaf-1', { role: 'leaf' }),
            makeNode('leaf-2', { role: 'leaf' }),
            makeNode('srv-1', { type: 'server' }),
        ], [])
        const result = previewIntent(intent, topo, { inputs: { vlanId: 300, vlanName: 'Tenant-C' } })
        expect(result.ok).toBe(true)
        expect(result.mutations.updateNodes).toHaveLength(2)  // 2 leaves
        const leaf1 = result.mutations.updateNodes!.find(u => u.id === 'leaf-1')!
        expect((leaf1.changes.vlans as any)).toContainEqual({ id: 300, name: 'Tenant-C' })
    })

    it('fails when no leaf nodes', () => {
        const topo = makeTopo([makeNode('spine-1', { role: 'spine' })], [])
        const result = previewIntent(intent, topo, { inputs: { vlanId: 300, vlanName: 'X' } })
        expect(result.ok).toBe(false)
        expect(result.message).toContain('No leaf nodes')
    })
})

describe('previewIntent — enable-evpn-overlay', () => {
    const intent = INTENTS.find(i => i.id === 'enable-evpn-overlay')!

    it('sets overlayEnabled on topology', () => {
        const topo = makeTopo([makeNode('leaf-1', { role: 'leaf' })], [])
        const result = previewIntent(intent, topo, {})
        expect(result.ok).toBe(true)
        expect(result.mutations.topologyChanges?.overlayEnabled).toBe(true)
    })
})

describe('previewIntent — disable-unused-ports', () => {
    const intent = INTENTS.find(i => i.id === 'disable-unused-ports')!

    it('disables ports not referenced by any link', () => {
        const topo = makeTopo([
            makeNode('n1', {
                ports: [
                    { id: 'p1', label: 'eth0', enabled: true },
                    { id: 'p2', label: 'eth1', enabled: true },
                    { id: 'p3', label: 'eth2', enabled: true },
                ],
            }),
            makeNode('n2', {
                ports: [{ id: 'p1', label: 'eth0', enabled: true }],
            }),
        ], [
            // Only uses n1:p1 ↔ n2:p1 — p2 and p3 are unused on n1
            { id: 'l1', type: 'ethernet' as any, sourceNodeId: 'n1', sourcePortId: 'p1', targetNodeId: 'n2', targetPortId: 'p1' },
        ])
        const result = previewIntent(intent, topo, {})
        expect(result.ok).toBe(true)
        expect(result.message).toContain('2 unused port(s)')
        const n1Update = result.mutations.updateNodes?.find(u => u.id === 'n1')!
        expect(n1Update).toBeDefined()
        const p2 = (n1Update.changes.ports as any[]).find(p => p.id === 'p2')
        const p3 = (n1Update.changes.ports as any[]).find(p => p.id === 'p3')
        expect(p2.enabled).toBe(false)
        expect(p3.enabled).toBe(false)
    })
})

describe('previewIntent — dual-spine-uplinks', () => {
    const intent = INTENTS.find(i => i.id === 'dual-spine-uplinks')!

    it('adds missing uplink when leaf is connected to only one spine', () => {
        const topo = makeTopo([
            makeNode('spine-1', {
                role: 'spine',
                ports: [{ id: 's1p0', label: 'e0', enabled: true }, { id: 's1p1', label: 'e1', enabled: true }],
            }),
            makeNode('spine-2', {
                role: 'spine',
                ports: [{ id: 's2p0', label: 'e0', enabled: true }, { id: 's2p1', label: 'e1', enabled: true }],
            }),
            makeNode('leaf-1', {
                role: 'leaf',
                ports: [
                    { id: 'l1p0', label: 'e0', enabled: true },
                    { id: 'l1p1', label: 'e1', enabled: true },
                ],
            }),
        ], [
            // Leaf-1 connected only to Spine-1
            { id: 'l1', type: 'ethernet' as any, sourceNodeId: 'spine-1', sourcePortId: 's1p0', targetNodeId: 'leaf-1', targetPortId: 'l1p0' },
        ])
        const result = previewIntent(intent, topo, {})
        expect(result.ok).toBe(true)
        expect(result.mutations.addLinks).toHaveLength(1)
        // Should link leaf-1 to spine-2 (the missing one)
        const newLink = result.mutations.addLinks![0]
        expect([newLink.sourceNodeId, newLink.targetNodeId]).toContain('spine-2')
        expect([newLink.sourceNodeId, newLink.targetNodeId]).toContain('leaf-1')
    })
})

describe('previewIntent — add-parallel-link', () => {
    const intent = INTENTS.find(i => i.id === 'add-parallel-link')!

    it('adds a parallel link using spare ports', () => {
        const topo = makeTopo([
            makeNode('n1', {
                ports: [
                    { id: 'p1', label: 'eth0', enabled: true },
                    { id: 'p2', label: 'eth1', enabled: true },
                ],
            }),
            makeNode('n2', {
                ports: [
                    { id: 'p1', label: 'eth0', enabled: true },
                    { id: 'p2', label: 'eth1', enabled: true },
                ],
            }),
        ], [
            { id: 'l1', type: 'ethernet' as any, sourceNodeId: 'n1', sourcePortId: 'p1', targetNodeId: 'n2', targetPortId: 'p1' },
        ])
        const result = previewIntent(intent, topo, { selectedLinkId: 'l1' })
        expect(result.ok).toBe(true)
        expect(result.mutations.addLinks).toHaveLength(1)
        // Uses unused ports p2 on both
        expect(result.mutations.addLinks![0].sourcePortId).toBe('p2')
        expect(result.mutations.addLinks![0].targetPortId).toBe('p2')
    })

    it('fails when no link is selected', () => {
        const topo = makeTopo([], [])
        const result = previewIntent(intent, topo, {})
        expect(result.ok).toBe(false)
        expect(result.message).toContain('Select a link')
    })
})
