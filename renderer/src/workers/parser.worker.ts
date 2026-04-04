// ═══════════════════════════════════════════════════════════════════════════════
// Web Worker — handles heavy vendor-output parsing off the main thread
// ═══════════════════════════════════════════════════════════════════════════════

import {
    detectVendorFromOutput,
    parseShowVersion,
    parseResourceUsage,
    parseInterfaceStatus,
    parseVendorAlarms,
    parseRouteTable,
    parseInterfaceCounters,
    parseLldpNeighbors,
    parseBgpSummary,
} from '../services/vendor-output-parser'

const parsers: Record<string, Function> = {
    detectVendorFromOutput,
    parseShowVersion,
    parseResourceUsage,
    parseInterfaceStatus,
    parseVendorAlarms,
    parseRouteTable,
    parseInterfaceCounters,
    parseLldpNeighbors,
    parseBgpSummary,
}

self.addEventListener('message', (event: MessageEvent) => {
    const { id, fn, args } = event.data
    try {
        const parser = parsers[fn]
        if (!parser) { throw new Error(`Unknown parser: ${fn}`) }
        const result = parser(...args)
        self.postMessage({ id, ok: true, data: result })
    } catch (err: any) {
        self.postMessage({ id, ok: false, error: err.message })
    }
})
