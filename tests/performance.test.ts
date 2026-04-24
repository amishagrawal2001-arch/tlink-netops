// ═══════════════════════════════════════════════════════════════════════════════
// Performance stress tests — synthetic large-scale topologies
// Validates that core operations stay within acceptable time bounds at 500+ nodes
// ═══════════════════════════════════════════════════════════════════════════════

import { buildVendorStartupConfig } from '../renderer/src/services/vendor-config-builder'
import {
    forceDirected3D, hierarchical3D, circular3D, sphere3D, from2DLayout,
} from '../renderer/src/services/layout-helpers-3d'
import { makeCtx } from './fixtures'
import type { TopologyNode, TopologyLink, NodeRole } from '../renderer/src/api/interfaces'

/** Build a synthetic Clos fabric with N spines × M leaves × K servers/leaf. */
function buildSyntheticClos (spines: number, leaves: number, serversPerLeaf: number): { nodes: TopologyNode[]; links: TopologyLink[] } {
    const nodes: TopologyNode[] = []
    const links: TopologyLink[] = []

    // Create spines
    for (let i = 0; i < spines; i++) {
        nodes.push({
            id: `spine-${i + 1}`,
            type: 'switch',
            label: `Spine-${i + 1}`,
            x: 100 + i * 200, y: 60,
            role: 'spine' as NodeRole,
            asn: 65000 + i,
            loopbackIp: `10.0.0.${i + 1}/32`,
            status: 'stopped',
            vendor: 'Juniper',
            ports: Array.from({ length: leaves }, (_, j) => ({
                id: `p${j}`,
                label: `et-0/0/${j}`,
                enabled: true,
                ipAddress: `10.10.${i}.${j * 2}/31`,
            })),
        })
    }

    // Create leaves + links
    for (let j = 0; j < leaves; j++) {
        const leafId = `leaf-${j + 1}`
        nodes.push({
            id: leafId,
            type: 'switch',
            label: `Leaf-${j + 1}`,
            x: 100 + j * 80, y: 280,
            role: 'leaf' as NodeRole,
            asn: 65100 + j,
            loopbackIp: `10.0.0.${100 + j}/32`,
            status: 'stopped',
            vendor: 'Juniper',
            ports: Array.from({ length: spines + serversPerLeaf }, (_, k) => ({
                id: `p${k}`,
                label: `xe-0/0/${k}`,
                enabled: true,
                ipAddress: k < spines ? `10.10.${k}.${j * 2 + 1}/31` : undefined,
            })),
        })
        // Links from each spine to this leaf
        for (let i = 0; i < spines; i++) {
            links.push({
                id: `link-s${i}-l${j}`,
                type: 'ethernet' as any,
                sourceNodeId: `spine-${i + 1}`,
                sourcePortId: `p${j}`,
                targetNodeId: leafId,
                targetPortId: `p${i}`,
            })
        }
        // Create servers attached to this leaf
        for (let s = 0; s < serversPerLeaf; s++) {
            const srvId = `srv-${j + 1}-${s + 1}`
            nodes.push({
                id: srvId,
                type: 'server',
                label: `Srv-${j + 1}-${s + 1}`,
                x: 100 + j * 80 + s * 20, y: 440,
                status: 'stopped',
                ports: [{ id: 'eth0', label: 'eth0', enabled: true }],
            })
            links.push({
                id: `link-l${j}-s${s}`,
                type: 'ethernet' as any,
                sourceNodeId: leafId,
                sourcePortId: `p${spines + s}`,
                targetNodeId: srvId,
                targetPortId: 'eth0',
            })
        }
    }

    return { nodes, links }
}

describe('Performance — 500+ node synthetic topology', () => {
    const { nodes, links } = buildSyntheticClos(4, 40, 12)  // 4 spines × 40 leaves × 12 srvs = 4 + 40 + 480 = 524 nodes

    it('builds 524-node Clos fabric under 100ms', () => {
        const t0 = Date.now()
        const result = buildSyntheticClos(4, 40, 12)
        const elapsed = Date.now() - t0
        expect(result.nodes.length).toBeGreaterThanOrEqual(500)
        expect(elapsed).toBeLessThan(100)
    })

    it('hierarchical3D layout completes under 50ms for 524 nodes', () => {
        const t0 = Date.now()
        const positions = hierarchical3D(nodes)
        const elapsed = Date.now() - t0
        expect(positions.length).toBe(nodes.length)
        expect(elapsed).toBeLessThan(50)
    })

    it('circular3D layout completes under 20ms for 524 nodes', () => {
        const t0 = Date.now()
        const positions = circular3D(nodes)
        const elapsed = Date.now() - t0
        expect(positions.length).toBe(nodes.length)
        expect(elapsed).toBeLessThan(20)
    })

    it('sphere3D layout completes under 20ms for 524 nodes', () => {
        const t0 = Date.now()
        const positions = sphere3D(nodes)
        const elapsed = Date.now() - t0
        expect(positions.length).toBe(nodes.length)
        expect(elapsed).toBeLessThan(20)
    })

    it('from2DLayout completes under 20ms for 524 nodes', () => {
        const t0 = Date.now()
        const positions = from2DLayout(nodes)
        const elapsed = Date.now() - t0
        expect(positions.length).toBe(nodes.length)
        expect(elapsed).toBeLessThan(20)
    })

    it('forceDirected3D layout completes under 5000ms for 524 nodes (O(n²))', () => {
        // Force-directed is O(n²) per iteration — expect longer
        const t0 = Date.now()
        const positions = forceDirected3D(nodes, links, { iterations: 30 })
        const elapsed = Date.now() - t0
        expect(positions.length).toBe(nodes.length)
        expect(elapsed).toBeLessThan(5000)
    })

    it('vendor config generation for all routing nodes under 2000ms', () => {
        const t0 = Date.now()
        const routingNodes = nodes.filter(n => n.vendor)
        for (const node of routingNodes) {
            buildVendorStartupConfig(node.vendor!, node.ports, makeCtx({
                hostname: node.label,
                asn: node.asn,
                routerId: node.loopbackIp?.split('/')[0],
                underlayProtocol: 'ebgp',
                overlayEnabled: true,
                bgpNeighbors: [],
            }))
        }
        const elapsed = Date.now() - t0
        expect(routingNodes.length).toBeGreaterThanOrEqual(40)
        expect(elapsed).toBeLessThan(2000)
    })
})

describe('Performance — smaller topologies (baseline)', () => {
    it('100-node topology layouts complete under 10ms each', () => {
        const { nodes } = buildSyntheticClos(2, 10, 8)  // 2 + 10 + 80 = 92 nodes
        const methods = [
            () => hierarchical3D(nodes),
            () => circular3D(nodes),
            () => sphere3D(nodes),
            () => from2DLayout(nodes),
        ]
        for (const fn of methods) {
            const t0 = Date.now()
            fn()
            expect(Date.now() - t0).toBeLessThan(10)
        }
    })
})
