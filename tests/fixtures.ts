// ═══════════════════════════════════════════════════════════════════════════════
// Shared test factory functions — used across all test suites
// ═══════════════════════════════════════════════════════════════════════════════

import {
    Topology, TopologyNode, TopologyLink, TrafficFlow,
    NodePort,
} from '../renderer/src/api/interfaces'
import { VendorConfigContext } from '../renderer/src/services/vendor-config-builder'

// ── Topology factories ──────────────────────────────────────────────────────

export function makeTopo (
    nodes: TopologyNode[] = [],
    links: TopologyLink[] = [],
): Topology {
    return {
        id: 'topo-1',
        name: 'Test Topology',
        nodes,
        links,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
    }
}

export function makeNode (id: string, overrides: Partial<TopologyNode> = {}): TopologyNode {
    return {
        id,
        type: 'router',
        label: id,
        x: 0,
        y: 0,
        status: 'running',
        ports: [],
        ...overrides,
    }
}

export function makeLink (
    id: string,
    sourceNodeId: string,
    targetNodeId: string,
    overrides: Partial<TopologyLink> = {},
): TopologyLink {
    return {
        id,
        type: 'ethernet',
        sourceNodeId,
        sourcePortId: `${id}-sp`,
        targetNodeId,
        targetPortId: `${id}-tp`,
        ...overrides,
    }
}

export function makeFlow (
    id: string,
    sourceNodeId: string,
    destNodeId: string,
    overrides: Partial<TrafficFlow> = {},
): TrafficFlow {
    return {
        id,
        name: `Flow ${id}`,
        sourceNodeId,
        destNodeId,
        color: '#00ff00',
        enabled: true,
        ...overrides,
    }
}

// ── Config builder factories ────────────────────────────────────────────────

export function makeCtx (overrides: Partial<VendorConfigContext> = {}): VendorConfigContext {
    return {
        nodeType: 'router',
        hostname: 'test-router',
        mgmtIp: '192.168.1.1/24',
        loopbackIp: '10.0.0.1/32',
        loopbackIpv6: 'fd00::1/128',
        sshUsername: 'admin',
        model: 'TestModel',
        switchFamily: '' as any,
        vlans: [],
        ...overrides,
    }
}

export function makePort (overrides: Partial<NodePort> = {}): NodePort {
    return {
        id: 'p1',
        label: 'eth0',
        enabled: true,
        ...overrides,
    }
}

// ── SSH payload factories ───────────────────────────────────────────────────

export function makeSshPayload (overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        host: '10.0.0.1',
        port: 22,
        username: 'admin',
        password: 'secret',
        timeoutMs: 8000,
        ...overrides,
    }
}

export function makeSshTerminalPayload (overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        host: '10.0.0.1',
        port: 22,
        username: 'admin',
        ...overrides,
    }
}
