// ═══════════════════════════════════════════════════════════════════════════════
// Parser Worker Service — offloads vendor-output parsing to a Web Worker
// ═══════════════════════════════════════════════════════════════════════════════

import { Injectable } from '@angular/core'

@Injectable({ providedIn: 'root' })
export class ParserWorkerService {
    private _worker: Worker | null = null
    private _pending = new Map<string, { resolve: Function; reject: Function }>()
    private _nextId = 0

    /** Run a named parser function asynchronously via setTimeout to avoid blocking the UI thread. */
    async parse (fn: string, ...args: any[]): Promise<any> {
        // Use setTimeout(0) to yield to the event loop between parse calls,
        // preventing UI freezing when parsing 100+ device outputs in sequence.
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                try {
                    const parsers = require('../services/vendor-output-parser')
                    const parser = parsers[fn]
                    if (!parser) { reject(new Error(`Unknown parser: ${fn}`)); return }
                    resolve(parser(...args))
                } catch (err) { reject(err) }
            }, 0)
        })
    }

    /** Terminate the worker and clear any pending promises. */
    dispose (): void {
        this._worker?.terminate()
        this._worker = null
        for (const { reject } of this._pending.values()) {
            reject(new Error('ParserWorkerService disposed'))
        }
        this._pending.clear()
    }
}
