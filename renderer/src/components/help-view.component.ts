import { ChangeDetectionStrategy, ChangeDetectorRef, Component } from '@angular/core'

/** Section IDs must match the template toggle calls */
const ALL_SECTIONS = [
    'getting-started', 'templates', 'topology', 'containerlab',
    'kvm', 'monitoring', 'snmp', 'syslog', 'snippets', 'workspace',
]

@Component({
    selector: 'help-view',
    templateUrl: './help-view.component.pug',
    styleUrls: ['./help-view.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelpViewComponent {
    helpSection: string | null = null
    helpSearchQuery = ''
    helpTheme: 'dark' | 'light' = 'dark'

    /** When searching, multiple sections can be open simultaneously */
    private _searchOpenSections = new Set<string>()

    /** All highlighted match elements in DOM order */
    private _matchElements: Element[] = []
    /** Current match index (0-based) */
    matchIndex = -1
    /** Total match count */
    matchCount = 0

    constructor (private cdr: ChangeDetectorRef) {
        const saved = localStorage.getItem('help-theme')
        if (saved === 'light' || saved === 'dark') { this.helpTheme = saved }
        document.documentElement.setAttribute('data-theme', this.helpTheme)
    }

    toggleTheme (): void {
        this.helpTheme = this.helpTheme === 'dark' ? 'light' : 'dark'
        localStorage.setItem('help-theme', this.helpTheme)
        document.documentElement.setAttribute('data-theme', this.helpTheme)
        this.cdr.markForCheck()
    }

    scrollToSection (id: string): void {
        if (this.helpSearchQuery) {
            this._searchOpenSections.add(id)
        } else {
            this.helpSection = id
        }
        this.cdr.markForCheck()
        setTimeout(() => {
            const scrollEl = document.querySelector('.help-view-scroll')
            const sections = scrollEl?.querySelectorAll('.help-section')
            if (!sections) { return }
            const idx = ALL_SECTIONS.indexOf(id)
            if (idx >= 0 && idx < sections.length) {
                sections[idx].scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
        }, 50)
    }

    toggleHelpSection (id: string): void {
        if (this.helpSearchQuery) {
            if (this._searchOpenSections.has(id)) {
                this._searchOpenSections.delete(id)
            } else {
                this._searchOpenSections.add(id)
            }
            this.cdr.markForCheck()
            setTimeout(() => this._injectCopyButtons(), 60)
            return
        }
        this.helpSection = this.helpSection === id ? null : id
        this.cdr.markForCheck()
        setTimeout(() => this._injectCopyButtons(), 60)
    }

    /** Inject "Copy" buttons into .help-example blocks that don't already have one */
    private _injectCopyButtons (): void {
        const examples = document.querySelectorAll('.help-example')
        for (const ex of Array.from(examples)) {
            if (ex.querySelector('.help-copy-btn')) { continue }
            const btn = document.createElement('button')
            btn.className = 'help-copy-btn'
            btn.textContent = 'Copy'
            btn.type = 'button'
            btn.addEventListener('click', (e) => {
                e.stopPropagation()
                const clone = ex.cloneNode(true) as HTMLElement
                clone.querySelector('.help-copy-btn')?.remove()
                clone.querySelector('.help-example-title')?.remove()
                const text = (clone.textContent || '').trim()
                navigator.clipboard.writeText(text).then(() => {
                    btn.textContent = 'Copied!'
                    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
                })
            })
            // Make the example position:relative and add button
            ;(ex as HTMLElement).style.position = 'relative'
            ex.appendChild(btn)
        }
    }

    isSectionOpen (id: string): boolean {
        if (this.helpSearchQuery) {
            return this._searchOpenSections.has(id)
        }
        return this.helpSection === id
    }

    /** Handle native input event */
    onSearchInput (event: Event): void {
        const value = (event.target as HTMLInputElement)?.value ?? ''
        this.onSearchChange(value)
    }

    /** Handle Enter key — jump to next match; Shift+Enter — previous */
    onSearchKeydown (event: KeyboardEvent): void {
        if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) {
                this.prevMatch()
            } else {
                this.nextMatch()
            }
        }
    }

    /** Handle search input changes */
    onSearchChange (query: string): void {
        this.helpSearchQuery = query.trim()
        this._searchOpenSections.clear()
        this._matchElements = []
        this.matchIndex = -1
        this.matchCount = 0

        if (this.helpSearchQuery) {
            for (const id of ALL_SECTIONS) {
                this._searchOpenSections.add(id)
            }
        }
        this.cdr.markForCheck()

        if (this.helpSearchQuery) {
            setTimeout(() => this._pruneAndHighlight(), 50)
        } else {
            this._clearHighlights()
        }
    }

    /** Navigate to next match */
    nextMatch (): void {
        if (this.matchCount === 0) { return }
        this.matchIndex = (this.matchIndex + 1) % this.matchCount
        this._scrollToCurrentMatch()
    }

    /** Navigate to previous match */
    prevMatch (): void {
        if (this.matchCount === 0) { return }
        this.matchIndex = (this.matchIndex - 1 + this.matchCount) % this.matchCount
        this._scrollToCurrentMatch()
    }

    /** Copy code example text to clipboard */
    copyExampleText = ''
    copyExample (ev: MouseEvent): void {
        const btn = ev.currentTarget as HTMLElement
        const example = btn.closest('.help-example')
        if (!example) { return }
        // Get all text except the copy button and the title
        const clone = example.cloneNode(true) as HTMLElement
        const copyBtn = clone.querySelector('.help-copy-btn')
        if (copyBtn) { copyBtn.remove() }
        const title = clone.querySelector('.help-example-title')
        if (title) { title.remove() }
        const text = (clone.textContent || '').trim()
        navigator.clipboard.writeText(text).then(() => {
            this.copyExampleText = 'Copied!'
            this.cdr.markForCheck()
            setTimeout(() => { this.copyExampleText = ''; this.cdr.markForCheck() }, 1500)
        })
    }

    clearSearch (): void {
        this.helpSearchQuery = ''
        this._searchOpenSections.clear()
        this._matchElements = []
        this.matchIndex = -1
        this.matchCount = 0
        this._clearHighlights()
        this.cdr.markForCheck()
    }

    /** Scroll to the current match and apply active highlight */
    private _scrollToCurrentMatch (): void {
        // Remove active class from all
        for (const el of this._matchElements) {
            el.classList.remove('help-search-highlight-active')
        }
        // Add active class to current
        const current = this._matchElements[this.matchIndex]
        if (current) {
            current.classList.add('help-search-highlight-active')
            current.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        this.cdr.markForCheck()
    }

    /** After all sections are rendered, highlight matches, prune empty sections, collect match elements */
    private _pruneAndHighlight (): void {
        const query = this.helpSearchQuery.toLowerCase()
        if (!query) { return }

        this._clearHighlights()

        const scrollEl = document.querySelector('.help-view-scroll')
        if (!scrollEl) { return }

        const sectionEls = scrollEl.querySelectorAll('.help-section')

        for (const sectionEl of Array.from(sectionEls)) {
            const titleBtn = sectionEl.querySelector('.help-section-title')
            const body = sectionEl.querySelector('.help-section-body')
            if (!body || !titleBtn) { continue }

            const titleText = (titleBtn.textContent || '').toLowerCase()
            const bodyText = (body.textContent || '').toLowerCase()

            const titleMatches = titleText.includes(query)
            const bodyMatches = bodyText.includes(query)

            if (!titleMatches && !bodyMatches) {
                const sectionId = this._getSectionId(titleBtn)
                if (sectionId) { this._searchOpenSections.delete(sectionId) }
                continue
            }

            if (bodyMatches) {
                this._highlightTextNodes(body, query)
            }
            if (titleMatches) {
                this._highlightTextNodes(titleBtn, query)
            }
        }

        // Collect all highlight elements in DOM order
        this._matchElements = Array.from(document.querySelectorAll('.help-search-highlight'))
        this.matchCount = this._matchElements.length
        this.matchIndex = this.matchCount > 0 ? 0 : -1

        this.cdr.markForCheck()

        // Scroll to first match and mark it active
        if (this.matchCount > 0) {
            setTimeout(() => this._scrollToCurrentMatch(), 100)
        }
    }

    /** Extract section id from the toggle button */
    private _getSectionId (btn: Element): string | null {
        // Try to match via Angular's rendered (click) handler text
        const onclick = btn.getAttribute('click') || ''
        for (const sid of ALL_SECTIONS) {
            if (onclick.includes(sid)) { return sid }
        }
        // Fallback: derive from button text
        const text = (btn.textContent || '').trim().toLowerCase()
        for (const id of ALL_SECTIONS) {
            if (text.includes(id.replace(/-/g, ' '))) { return id }
        }
        return null
    }

    /** Highlight all occurrences of `query` in text nodes under `root` */
    private _highlightTextNodes (root: Element, query: string): number {
        let count = 0
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const nodesToProcess: { node: Text; indices: number[] }[] = []

        let textNode: Text | null
        while ((textNode = walker.nextNode() as Text | null)) {
            const parent = textNode.parentElement
            if (!parent) { continue }
            if (parent.classList.contains('help-search-highlight')) { continue }

            const text = textNode.textContent || ''
            const lower = text.toLowerCase()
            const indices: number[] = []
            let pos = 0
            while ((pos = lower.indexOf(query, pos)) !== -1) {
                indices.push(pos)
                pos += query.length
            }
            if (indices.length > 0) {
                nodesToProcess.push({ node: textNode, indices })
                count += indices.length
            }
        }

        for (const { node, indices } of nodesToProcess.reverse()) {
            const text = node.textContent || ''
            const fragment = document.createDocumentFragment()
            let lastEnd = 0

            for (const idx of indices) {
                if (idx > lastEnd) {
                    fragment.appendChild(document.createTextNode(text.slice(lastEnd, idx)))
                }
                const mark = document.createElement('mark')
                mark.className = 'help-search-highlight'
                mark.textContent = text.slice(idx, idx + query.length)
                fragment.appendChild(mark)
                lastEnd = idx + query.length
            }
            if (lastEnd < text.length) {
                fragment.appendChild(document.createTextNode(text.slice(lastEnd)))
            }

            node.parentNode?.replaceChild(fragment, node)
        }

        return count
    }

    /** Remove all highlight marks */
    private _clearHighlights (): void {
        const marks = document.querySelectorAll('.help-search-highlight')
        for (const mark of Array.from(marks)) {
            const parent = mark.parentNode
            if (parent) {
                parent.replaceChild(document.createTextNode(mark.textContent || ''), mark)
                parent.normalize()
            }
        }
        this._matchElements = []
        this.matchIndex = -1
        this.matchCount = 0
    }
}
