import { PollHistoryService, PollSnapshot } from '../renderer/src/services/poll-history'

// Mock localStorage for Node.js test environment
beforeAll(() => {
    const store: Record<string, string> = {}
    ;(global as any).localStorage = {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v },
        removeItem: (k: string) => { delete store[k] },
    }
})

function mkSnapshot (ts: number, overrides: Partial<PollSnapshot> = {}): PollSnapshot {
    return {
        timestamp: ts,
        containers: [],
        nodeHealth: [],
        driftNodes: [],
        ...overrides,
    }
}

describe('PollHistoryService', () => {
    it('records snapshots and reports size', () => {
        const h = new PollHistoryService(10)
        h.clear()
        h.record(mkSnapshot(1000))
        h.record(mkSnapshot(2000))
        expect(h.size).toBe(2)
    })

    it('enforces ring buffer maxSize', () => {
        const h = new PollHistoryService(3)
        h.clear()
        for (let i = 0; i < 10; i++) { h.record(mkSnapshot(i * 1000)) }
        expect(h.size).toBe(3)
        const all = h.getAll()
        expect(all[0].timestamp).toBe(7000)  // oldest of remaining
        expect(all[2].timestamp).toBe(9000)  // newest
    })

    it('getAt returns closest snapshot within tolerance', () => {
        const h = new PollHistoryService(10)
        h.clear()
        h.record(mkSnapshot(1000))
        h.record(mkSnapshot(5000))
        h.record(mkSnapshot(10000))
        expect(h.getAt(5100)?.timestamp).toBe(5000)
        expect(h.getAt(7500)?.timestamp).toBe(5000)  // closer to 5000 than 10000
        expect(h.getAt(9999999)).toBeNull()  // way outside default 60s tolerance
    })

    it('getRange returns snapshots in [start, end]', () => {
        const h = new PollHistoryService(10)
        h.clear()
        h.record(mkSnapshot(1000))
        h.record(mkSnapshot(2000))
        h.record(mkSnapshot(3000))
        h.record(mkSnapshot(4000))
        const range = h.getRange(2000, 3500)
        expect(range).toHaveLength(2)
        expect(range[0].timestamp).toBe(2000)
        expect(range[1].timestamp).toBe(3000)
    })

    it('getBounds returns first and last timestamps', () => {
        const h = new PollHistoryService(10)
        h.clear()
        expect(h.getBounds()).toBeNull()
        h.record(mkSnapshot(1000))
        h.record(mkSnapshot(5000))
        expect(h.getBounds()).toEqual({ first: 1000, last: 5000 })
    })

    it('diffSnapshots detects newly-down nodes', () => {
        const h = new PollHistoryService()
        const before = mkSnapshot(1000, {
            containers: [
                { containerName: 'leaf-1', state: 'running', bgpUp: 2, bgpTotal: 2 },
                { containerName: 'leaf-2', state: 'running', bgpUp: 2, bgpTotal: 2 },
            ],
        })
        const after = mkSnapshot(2000, {
            containers: [
                { containerName: 'leaf-1', state: 'running', bgpUp: 2, bgpTotal: 2 },
                { containerName: 'leaf-2', state: 'exited', bgpUp: 0, bgpTotal: 2 },
            ],
        })
        const diff = h.diffSnapshots(before, after)
        expect(diff.nodesNewlyDown).toEqual(['leaf-2'])
        expect(diff.nodesNewlyUp).toEqual([])
    })

    it('diffSnapshots detects BGP neighbor loss', () => {
        const h = new PollHistoryService()
        const before = mkSnapshot(1000, {
            containers: [{ containerName: 'spine-1', state: 'running', bgpUp: 4, bgpTotal: 4 }],
        })
        const after = mkSnapshot(2000, {
            containers: [{ containerName: 'spine-1', state: 'running', bgpUp: 2, bgpTotal: 4 }],
        })
        const diff = h.diffSnapshots(before, after)
        expect(diff.bgpNeighborsLost).toHaveLength(1)
        expect(diff.bgpNeighborsLost[0]).toEqual({ container: 'spine-1', before: 4, after: 2 })
    })

    it('diffSnapshots detects new drift and resolved drift', () => {
        const h = new PollHistoryService()
        const before = mkSnapshot(1000, { driftNodes: ['n1'] })
        const after = mkSnapshot(2000, { driftNodes: ['n2', 'n3'] })
        const diff = h.diffSnapshots(before, after)
        expect(diff.newDriftNodes).toEqual(['n2', 'n3'])
        expect(diff.resolvedDriftNodes).toEqual(['n1'])
    })

    it('clear removes all snapshots', () => {
        const h = new PollHistoryService()
        h.record(mkSnapshot(1000))
        h.record(mkSnapshot(2000))
        h.clear()
        expect(h.size).toBe(0)
        expect(h.getAll()).toEqual([])
    })
})
