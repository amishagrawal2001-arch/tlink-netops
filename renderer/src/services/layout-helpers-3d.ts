/**
 * 3D Layout helpers — compute z-coordinates from 2D topology positions.
 * Z is ephemeral (render-time only), not stored in the topology data model.
 */

import { TopologyNode, TopologyLink } from '../api/interfaces'

export interface LayoutPosition3D {
    id: string
    x: number
    y: number
    z: number
}

const SCALE = 0.5  // scale 2D positions down for 3D scene

/**
 * Convert existing 2D layout to 3D by assigning z based on node role/type.
 * Spine/core at z=0, leafs at z=-80, endpoints at z=-160.
 */
export function from2DLayout (nodes: TopologyNode[]): LayoutPosition3D[] {
    return nodes.map(n => {
        let z = 0
        if (n.role === 'spine' || n.role === 'super-spine' || n.role === 'core') {
            z = 40
        } else if (n.role === 'leaf' || n.role === 'border-leaf' || n.role === 'tor') {
            z = 0
        } else if (n.type === 'server' || n.type === 'pc' || n.type === 'host') {
            z = -40
        } else if (n.type === 'firewall') {
            z = 20
        } else {
            z = -20
        }
        return {
            id: n.id,
            x: n.x * SCALE,
            y: -n.y * SCALE,  // flip Y so screen-down becomes 3D-forward
            z,
        }
    })
}

/**
 * Simple 3D force-directed layout (Fruchterman-Reingold).
 * Produces balanced 3D positions from topology structure.
 */
export function forceDirected3D (
    nodes: TopologyNode[],
    links: TopologyLink[],
    options?: { iterations?: number; repulsion?: number; springK?: number; idealLength?: number },
): LayoutPosition3D[] {
    const iterations = options?.iterations ?? 60
    const repulsion = options?.repulsion ?? 6000
    const springK = options?.springK ?? 0.04
    const ideal = options?.idealLength ?? 100

    // Initialize positions randomly in 3D
    const pos = nodes.map(n => ({
        id: n.id,
        x: (Math.random() - 0.5) * 400,
        y: (Math.random() - 0.5) * 400,
        z: (Math.random() - 0.5) * 200,
    }))

    const idxMap = new Map(nodes.map((n, i) => [n.id, i]))

    for (let iter = 0; iter < iterations; iter++) {
        const damp = 1 - iter / iterations
        const forces = pos.map(() => ({ fx: 0, fy: 0, fz: 0 }))

        // Pairwise repulsion
        for (let i = 0; i < pos.length; i++) {
            for (let j = i + 1; j < pos.length; j++) {
                const dx = pos[i].x - pos[j].x
                const dy = pos[i].y - pos[j].y
                const dz = pos[i].z - pos[j].z
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
                const f = repulsion / (dist * dist)
                const fx = (dx / dist) * f
                const fy = (dy / dist) * f
                const fz = (dz / dist) * f
                forces[i].fx += fx; forces[i].fy += fy; forces[i].fz += fz
                forces[j].fx -= fx; forces[j].fy -= fy; forces[j].fz -= fz
            }
        }

        // Spring attraction along links
        for (const link of links) {
            const si = idxMap.get(link.sourceNodeId)
            const ti = idxMap.get(link.targetNodeId)
            if (si == null || ti == null) { continue }
            const dx = pos[ti].x - pos[si].x
            const dy = pos[ti].y - pos[si].y
            const dz = pos[ti].z - pos[si].z
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
            const f = springK * (dist - ideal)
            const fx = (dx / dist) * f
            const fy = (dy / dist) * f
            const fz = (dz / dist) * f
            forces[si].fx += fx; forces[si].fy += fy; forces[si].fz += fz
            forces[ti].fx -= fx; forces[ti].fy -= fy; forces[ti].fz -= fz
        }

        // Apply forces with damping
        for (let i = 0; i < pos.length; i++) {
            pos[i].x += forces[i].fx * damp
            pos[i].y += forces[i].fy * damp
            pos[i].z += forces[i].fz * damp
        }
    }

    return pos
}
