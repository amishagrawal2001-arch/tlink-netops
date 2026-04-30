// ═════════════════════════════════════════════════════════════════════════════
// Config Diff — line-based LCS unified diff for config text comparison.
//
// Produces a flat array of hunks suitable for direct rendering:
//   { type: 'eq' | 'add' | 'del', text, aLine?, bLine? }
//
// Why LCS instead of zip-and-compare? The naive approach fails when a single
// line is inserted or deleted: every subsequent line shows as both - and +
// even though the actual content matches. LCS aligns lines correctly.
// ═════════════════════════════════════════════════════════════════════════════

export type DiffOp = 'eq' | 'add' | 'del'

export interface DiffHunk {
    type: DiffOp
    text: string
    /** 1-based line number in source A (undefined for added lines) */
    aLine?: number
    /** 1-based line number in source B (undefined for deleted lines) */
    bLine?: number
}

export interface DiffStats {
    added: number
    removed: number
    unchanged: number
}

/**
 * Compute a unified diff between two multi-line texts.
 *
 * The algorithm runs the standard dynamic-programming LCS (longest common
 * subsequence) over the two line arrays, then back-traces to emit the
 * hunks. O(m·n) time/memory which is fine for configs up to a few thousand
 * lines (caps under 5MB of text comfortably).
 */
export function diffLines (aText: string, bText: string): DiffHunk[] {
    // Normalize EOL — Windows configs sometimes have \r\n that would otherwise
    // make every line look different from a Unix-saved peer.
    const a = (aText || '').replace(/\r\n/g, '\n').split('\n')
    const b = (bText || '').replace(/\r\n/g, '\n').split('\n')
    const m = a.length
    const n = b.length

    // LCS table — lcs[i][j] = length of LCS of a[0..i) and b[0..j)
    const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) {
            lcs[i + 1][j + 1] = a[i] === b[j]
                ? lcs[i][j] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1])
        }
    }

    // Back-trace from (m, n) to (0, 0) emitting hunks. We collect in reverse
    // and flip at the end so the resulting array reads top-to-bottom.
    const hunks: DiffHunk[] = []
    let i = m, j = n
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            hunks.push({ type: 'eq', text: a[i - 1], aLine: i, bLine: j })
            i--; j--
        } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
            hunks.push({ type: 'add', text: b[j - 1], bLine: j })
            j--
        } else {
            hunks.push({ type: 'del', text: a[i - 1], aLine: i })
            i--
        }
    }
    return hunks.reverse()
}

/** Quick aggregate counts. */
export function diffStats (hunks: DiffHunk[]): DiffStats {
    let added = 0, removed = 0, unchanged = 0
    for (const h of hunks) {
        if (h.type === 'add')      { added++ }
        else if (h.type === 'del') { removed++ }
        else                        { unchanged++ }
    }
    return { added, removed, unchanged }
}

/** Render to a unified-diff text format (e.g. for clipboard copy). */
export function diffToUnifiedText (hunks: DiffHunk[]): string {
    return hunks.map(h => {
        if (h.type === 'add') { return `+ ${h.text}` }
        if (h.type === 'del') { return `- ${h.text}` }
        return `  ${h.text}`
    }).join('\n')
}

/**
 * Collapse runs of unchanged lines longer than `context` lines into hidden
 * folds, so a diff with 1000 unchanged lines and 5 changes shows just the
 * 5 changes ± context. Keeps the head and tail of each fold visible.
 *
 * Returns hunks with an inserted synthetic `{ type: 'eq', text: '… N unchanged …' }`
 * marker for each fold. The caller can render those as a button to expand.
 */
export function foldUnchanged (hunks: DiffHunk[], context = 3): DiffHunk[] {
    const out: DiffHunk[] = []
    let runStart = -1
    const flushRun = (endIdx: number): void => {
        if (runStart < 0) { return }
        const runLen = endIdx - runStart
        // Need at least 2*context+1 to be worth folding (otherwise just emit all)
        if (runLen <= 2 * context + 1) {
            for (let k = runStart; k < endIdx; k++) { out.push(hunks[k]) }
            return
        }
        // Head context
        for (let k = runStart; k < runStart + context; k++) { out.push(hunks[k]) }
        // Fold marker
        const hidden = runLen - 2 * context
        out.push({ type: 'eq', text: `… ${hidden} unchanged line${hidden === 1 ? '' : 's'} hidden …` })
        // Tail context
        for (let k = endIdx - context; k < endIdx; k++) { out.push(hunks[k]) }
    }
    for (let i = 0; i < hunks.length; i++) {
        if (hunks[i].type === 'eq') {
            if (runStart < 0) { runStart = i }
        } else {
            flushRun(i)
            runStart = -1
            out.push(hunks[i])
        }
    }
    flushRun(hunks.length)
    return out
}
