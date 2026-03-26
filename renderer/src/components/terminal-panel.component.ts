import {
    Component, Input, Output, EventEmitter, ElementRef, ViewChild,
    ChangeDetectionStrategy, ChangeDetectorRef, OnDestroy, AfterViewInit,
    ViewEncapsulation,
} from '@angular/core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

interface TermSession {
    id: string
    label: string
    terminal: Terminal
    fitAddon: FitAddon
    ended: boolean
}

@Component({
    selector: 'terminal-panel',
    templateUrl: './terminal-panel.component.pug',
    styleUrls: ['./terminal-panel.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    encapsulation: ViewEncapsulation.None,
})
export class TerminalPanelComponent implements AfterViewInit, OnDestroy {
    @Input() visible = false
    @Output() visibleChange = new EventEmitter<boolean>()

    @ViewChild('terminalBody') terminalBodyRef!: ElementRef<HTMLDivElement>

    sessions: TermSession[] = []
    activeSessionId = ''
    panelHeight = 300

    private _api = (window as any).netopsAPI
    private _listenersAttached = false
    private _resizing = false
    private _resizeStartY = 0
    private _resizeStartH = 0

    constructor (private cdr: ChangeDetectorRef) {}

    ngAfterViewInit (): void {
        this._attachListeners()
    }

    ngOnDestroy (): void {
        this._detachListeners()
        for (const s of this.sessions) {
            s.terminal.dispose()
            try { this._api?.ptyDestroy(s.id) } catch (_) {}
        }
        this.sessions = []
    }

    // ── Public API (called by parent component) ─────────────────────────

    addSession (sessionId: string, label: string): void {
        // Don't duplicate
        if (this.sessions.find(s => s.id === sessionId)) {
            this.activeSessionId = sessionId
            this._showActiveTerminal()
            this.cdr.markForCheck()
            return
        }

        const terminal = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: "'Menlo', 'Consolas', 'DejaVu Sans Mono', monospace",
            theme: {
                background: '#1e1e2e',
                foreground: '#cdd6f4',
                cursor: '#f5e0dc',
                selectionBackground: '#45475a',
                black: '#45475a',
                red: '#f38ba8',
                green: '#a6e3a1',
                yellow: '#f9e2af',
                blue: '#89b4fa',
                magenta: '#f5c2e7',
                cyan: '#94e2d5',
                white: '#bac2de',
            },
            allowProposedApi: true,
        })

        const fitAddon = new FitAddon()
        terminal.loadAddon(fitAddon)
        terminal.loadAddon(new WebLinksAddon())

        const session: TermSession = { id: sessionId, label, terminal, fitAddon, ended: false }
        this.sessions.push(session)
        this.activeSessionId = sessionId

        // Wire input: keystrokes → PTY
        terminal.onData((data: string) => {
            if (session.ended) {
                // Any key after session ended → close the tab
                this.removeSession(sessionId)
                return
            }
            this._api?.ptyInput(sessionId, data)
        })

        this.cdr.markForCheck()

        // Attach to DOM after change detection renders the container
        setTimeout(() => this._mountTerminal(session), 0)
    }

    removeSession (sessionId: string): void {
        const idx = this.sessions.findIndex(s => s.id === sessionId)
        if (idx < 0) { return }
        const session = this.sessions[idx]
        session.terminal.dispose()
        try { this._api?.ptyDestroy(sessionId) } catch (_) {}
        this.sessions.splice(idx, 1)

        if (this.activeSessionId === sessionId) {
            this.activeSessionId = this.sessions.length ? this.sessions[Math.max(0, idx - 1)].id : ''
            this._showActiveTerminal()
        }

        if (!this.sessions.length) {
            this.visible = false
            this.visibleChange.emit(false)
        }
        this.cdr.markForCheck()
    }

    activateSession (sessionId: string): void {
        this.activeSessionId = sessionId
        this._showActiveTerminal()
        this.cdr.markForCheck()
    }

    hidePanel (): void {
        this.visible = false
        this.visibleChange.emit(false)
    }

    // ── Resize handle ───────────────────────────────────────────────────

    onResizeStart (ev: MouseEvent): void {
        ev.preventDefault()
        this._resizing = true
        this._resizeStartY = ev.clientY
        this._resizeStartH = this.panelHeight

        const onMove = (e: MouseEvent) => {
            if (!this._resizing) { return }
            const delta = this._resizeStartY - e.clientY
            this.panelHeight = Math.max(150, Math.min(800, this._resizeStartH + delta))
            this.cdr.markForCheck()
            this._fitActive()
        }

        const onUp = () => {
            this._resizing = false
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
        }

        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
    }

    // ── Internal ────────────────────────────────────────────────────────

    private _mountTerminal (session: TermSession): void {
        const container = this.terminalBodyRef?.nativeElement
        if (!container) { return }

        // Clear and mount
        session.terminal.open(container)
        session.fitAddon.fit()

        // Send initial size to PTY
        const { cols, rows } = session.fitAddon.proposeDimensions() || { cols: 80, rows: 24 }
        this._api?.ptyResize(session.id, cols, rows)

        session.terminal.focus()
    }

    private _showActiveTerminal (): void {
        const container = this.terminalBodyRef?.nativeElement
        if (!container) { return }

        // Detach all terminals, attach active one
        container.innerHTML = ''
        const session = this.sessions.find(s => s.id === this.activeSessionId)
        if (session) {
            session.terminal.open(container)
            setTimeout(() => {
                session.fitAddon.fit()
                const dims = session.fitAddon.proposeDimensions()
                if (dims) { this._api?.ptyResize(session.id, dims.cols, dims.rows) }
                session.terminal.focus()
            }, 0)
        }
    }

    private _fitActive (): void {
        const session = this.sessions.find(s => s.id === this.activeSessionId)
        if (session) {
            try {
                session.fitAddon.fit()
                const dims = session.fitAddon.proposeDimensions()
                if (dims) { this._api?.ptyResize(session.id, dims.cols, dims.rows) }
            } catch (_) {}
        }
    }

    private _attachListeners (): void {
        if (this._listenersAttached || !this._api) { return }
        this._listenersAttached = true

        this._api.onPtyData((sessionId: string, data: string) => {
            const session = this.sessions.find(s => s.id === sessionId)
            if (session) {
                session.terminal.write(data)
            }
        })

        this._api.onPtyExit((sessionId: string, _exitCode: number) => {
            const session = this.sessions.find(s => s.id === sessionId)
            if (session) {
                session.ended = true
                session.terminal.write('\r\n\x1b[90m[Session ended — press any key to close]\x1b[0m\r\n')
                this.cdr.markForCheck()
            }
        })
    }

    private _detachListeners (): void {
        if (this._api) {
            this._api.offPtyListeners()
        }
        this._listenersAttached = false
    }
}
