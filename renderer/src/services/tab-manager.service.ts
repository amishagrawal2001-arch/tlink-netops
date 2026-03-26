import {
    Injectable, Injector, ComponentRef, ViewContainerRef,
} from '@angular/core'
import { BehaviorSubject, Observable, Subscription } from 'rxjs'
import { skip } from 'rxjs/operators'
import { TopologyService } from './topology.service'
import { InventoryService } from './inventory.service'
import { IS_ACTIVE_TAB } from '../api/tokens'
import { NetopsCanvasComponent } from '../components/netops-canvas.component'
import { WorkspaceFile, WorkspaceTabEntry } from '../api/interfaces'

function uuid (): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export interface TabEntry {
    id:           string
    label:        string
    isDirty:      boolean
    injector:     Injector
    componentRef: ComponentRef<NetopsCanvasComponent>
    isActive$:    BehaviorSubject<boolean>
}

@Injectable()
export class TabManagerService {

    private _tabs$         = new BehaviorSubject<TabEntry[]>([])
    private _activeTabId$  = new BehaviorSubject<string | null>(null)
    private _vcr!:           ViewContainerRef
    private _rootInjector!:  Injector
    private _tabSubs       = new Map<string, Subscription[]>()

    /** Last workspace file path — persists across tab destruction and app reloads for auto-save */
    private static readonly _WS_PATH_KEY = 'tlink_lastWorkspaceFilePath'

    get lastWorkspaceFilePath (): string | null {
        return localStorage.getItem(TabManagerService._WS_PATH_KEY) || null
    }
    set lastWorkspaceFilePath (val: string | null) {
        if (val) {
            localStorage.setItem(TabManagerService._WS_PATH_KEY, val)
        } else {
            localStorage.removeItem(TabManagerService._WS_PATH_KEY)
        }
    }

    get tabs$ (): Observable<TabEntry[]>       { return this._tabs$.asObservable() }
    get activeTabId$ (): Observable<string|null> { return this._activeTabId$.asObservable() }
    get tabs (): TabEntry[]                    { return this._tabs$.value }
    get activeTabId (): string | null          { return this._activeTabId$.value }

    // Called once by AppShellComponent after its ViewChild is ready
    init (vcr: ViewContainerRef, rootInjector: Injector): void {
        this._vcr           = vcr
        this._rootInjector  = rootInjector
    }

    // ── Tab lifecycle ─────────────────────────────────────────────────────────

    createTab (initialJson?: string): void {
        const isActive$ = new BehaviorSubject<boolean>(false)

        const tabInjector = Injector.create({
            providers: [
                { provide: TopologyService,  useClass: TopologyService },
                { provide: InventoryService, useClass: InventoryService },
                { provide: IS_ACTIVE_TAB,    useValue: isActive$ },
            ],
            parent: this._rootInjector,
        })

        const ref = this._vcr.createComponent(NetopsCanvasComponent, { injector: tabInjector })
        ref.changeDetectorRef.detectChanges()

        // Hide until activated
        ;(ref.location.nativeElement as HTMLElement).style.display = 'none'

        const svc = tabInjector.get(TopologyService)

        if (initialJson) {
            try { svc.importJSON(initialJson) } catch { /* ignore malformed */ }
        }

        const entry: TabEntry = {
            id:           uuid(),
            label:        svc.topology.name,
            isDirty:      false,
            injector:     tabInjector,
            componentRef: ref,
            isActive$,
        }

        const subs: Subscription[] = []

        // Keep label in sync with topology name
        subs.push(svc.topology$.subscribe(t => {
            entry.label = t.name
            this._tabs$.next([...this._tabs$.value])
        }))

        // Mark dirty on any topology change after initial load
        subs.push(svc.topology$.pipe(skip(1)).subscribe(() => {
            if (!entry.isDirty) {
                entry.isDirty = true
                this._tabs$.next([...this._tabs$.value])
            }
        }))

        // Clear dirty on save
        subs.push(svc.saved$.subscribe(() => {
            entry.isDirty = false
            this._tabs$.next([...this._tabs$.value])
        }))

        this._tabSubs.set(entry.id, subs)
        this._tabs$.next([...this._tabs$.value, entry])
        this.activateTab(entry.id)
    }

    activateTab (id: string): void {
        for (const tab of this._tabs$.value) {
            const el = tab.componentRef.location.nativeElement as HTMLElement
            const isThis = tab.id === id
            el.style.display = isThis ? '' : 'none'
            tab.isActive$.next(isThis)
            // Ensure OnPush component re-renders when shown
            if (isThis) { tab.componentRef.changeDetectorRef.markForCheck() }
        }
        this._activeTabId$.next(id)
        const active = this._tabs$.value.find(t => t.id === id)
        if (active) { document.title = `${active.label} — NetOps` }
    }

    closeTab (id: string, opts: { skipConfirm?: boolean } = {}): void {
        const tab = this._tabs$.value.find(t => t.id === id)
        if (!tab) { return }

        if (!opts.skipConfirm && tab.isDirty) {
            if (!confirm(`Close "${tab.label}" without saving?`)) { return }
        }

        // Tear down subscriptions
        const subs = this._tabSubs.get(id) ?? []
        subs.forEach(s => s.unsubscribe())
        this._tabSubs.delete(id)

        tab.componentRef.destroy()

        const remaining = this._tabs$.value.filter(t => t.id !== id)

        if (!remaining.length) {
            // Always keep at least one tab
            this._tabs$.next([])
            this.createTab()
            return
        }

        if (this._activeTabId$.value === id) {
            const closedIdx = this._tabs$.value.findIndex(t => t.id === id)
            const next = remaining[Math.max(0, closedIdx - 1)]
            this._tabs$.next(remaining)
            this.activateTab(next.id)
        } else {
            this._tabs$.next(remaining)
        }
    }

    renameActiveTab (label: string): void {
        const id = this._activeTabId$.value
        if (!id) { return }
        const tab = this._tabs$.value.find(t => t.id === id)
        if (!tab) { return }
        // Update the topology name in the service
        tab.injector.get(TopologyService).renameTopology(label)
    }

    // ── Tear-out to new window ────────────────────────────────────────────────

    tearOutTab (id: string): void {
        const tab = this._tabs$.value.find(t => t.id === id)
        if (!tab) { return }
        const json = tab.injector.get(TopologyService).exportJSON()
        this.closeTab(id, { skipConfirm: true })
        ;(window as any).netopsAPI?.openInNewWindow(json)
    }

    // ── Workspace (save / load all tabs) ──────────────────────────────────────

    /** Serialize every open tab (topology + inventory) into a workspace JSON string. */
    exportWorkspace (): string {
        const tabs: WorkspaceTabEntry[] = this._tabs$.value.map(tab => ({
            topology:  tab.injector.get(TopologyService).topology,
            inventory: tab.injector.get(InventoryService).store,
        }))

        const activeId = this._activeTabId$.value
        const activeIdx = this._tabs$.value.findIndex(t => t.id === activeId)

        const ws: WorkspaceFile = {
            version:        1,
            type:           'tlink-workspace',
            savedAt:        new Date().toISOString(),
            activeTabIndex: Math.max(0, activeIdx),
            tabs,
        }

        return JSON.stringify(ws, null, 2)
    }

    /** Replace all current tabs with the contents of a workspace JSON string. */
    importWorkspace (json: string): boolean {
        let ws: WorkspaceFile
        try {
            ws = JSON.parse(json) as WorkspaceFile
        } catch { return false }

        if (ws.version !== 1 || ws.type !== 'tlink-workspace') { return false }
        if (!Array.isArray(ws.tabs) || ws.tabs.length === 0) { return false }

        this._closeAllTabs()

        for (const entry of ws.tabs) {
            this.createTab(JSON.stringify(entry.topology))

            // Restore inventory data into the newly created tab
            const newTab = this._tabs$.value[this._tabs$.value.length - 1]
            if (newTab && entry.inventory) {
                newTab.injector.get(InventoryService).importStore(entry.inventory)
            }
        }

        // Activate the tab that was active when saved
        const idx = Math.min(ws.activeTabIndex ?? 0, this._tabs$.value.length - 1)
        const target = this._tabs$.value[idx]
        if (target) { this.activateTab(target.id) }

        return true
    }

    /**
     * Destroy all tabs without auto-creating a replacement.
     * Used by importWorkspace before recreating tabs from workspace data.
     */
    private _closeAllTabs (): void {
        for (const tab of this._tabs$.value) {
            const subs = this._tabSubs.get(tab.id) ?? []
            subs.forEach(s => s.unsubscribe())
            this._tabSubs.delete(tab.id)
            tab.componentRef.destroy()
        }
        this._tabs$.next([])
        this._activeTabId$.next(null)
    }
}
