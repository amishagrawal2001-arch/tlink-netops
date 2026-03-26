import {
    AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef,
    Component, Injector, ViewChild, ViewContainerRef,
} from '@angular/core'
import { TabManagerService } from '../services/tab-manager.service'
import { TopologyService } from '../services/topology.service'

@Component({
    selector: 'app-shell',
    templateUrl: './app-shell.component.pug',
    styleUrls: ['./app-shell.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppShellComponent implements AfterViewInit {

    @ViewChild('tabHost', { read: ViewContainerRef, static: true })
    tabHost!: ViewContainerRef

    /** True when window opened with ?mode=help — renders HelpViewComponent only */
    isHelpMode = false

    constructor (
        public tabMgr: TabManagerService,
        private injector: Injector,
        private cdr: ChangeDetectorRef,
    ) {
        const params = new URLSearchParams(window.location.search)
        this.isHelpMode = params.get('mode') === 'help'
    }

    ngAfterViewInit (): void {
        if (this.isHelpMode) { return }   // no tabs needed in help window

        this.tabMgr.init(this.tabHost, this.injector)

        // Defer tab creation by one macrotask so the BehaviorSubject emissions
        // from createTab() don't trigger NG0100 ExpressionChangedAfterChecked.
        setTimeout(() => {
            const params  = new URLSearchParams(window.location.search)
            const encoded = params.get('t')
            const json    = encoded ? atob(encoded) : undefined
            this.tabMgr.createTab(json)
            this.cdr.markForCheck()
        }, 0)
    }

    // ── Tab bar event handlers ────────────────────────────────────────────────

    onTabActivate (id: string): void { this.tabMgr.activateTab(id) }

    onTabClose (id: string): void { this.tabMgr.closeTab(id) }

    onTabNew (): void { this.tabMgr.createTab() }

    onTabRename (ev: { id: string; label: string }): void {
        const tab = this.tabMgr.tabs.find(t => t.id === ev.id)
        if (!tab) { return }
        tab.injector.get(TopologyService).renameTopology(ev.label)
    }

    onTabTearOut (id: string): void { this.tabMgr.tearOutTab(id) }
}
