import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, EventEmitter, Input, Output,
} from '@angular/core'
import { TabEntry } from '../services/tab-manager.service'

@Component({
    selector: 'tab-bar',
    templateUrl: './tab-bar.component.pug',
    styleUrls: ['./tab-bar.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TabBarComponent {

    @Input() tabs: TabEntry[] | null = []
    @Input() activeId: string | null = null

    @Output() tabActivate = new EventEmitter<string>()
    @Output() tabClose    = new EventEmitter<string>()
    @Output() tabNew      = new EventEmitter<void>()
    @Output() tabRename   = new EventEmitter<{ id: string; label: string }>()
    @Output() tabTearOut  = new EventEmitter<string>()

    renamingId: string | null = null
    renameValue = ''

    constructor (private cdr: ChangeDetectorRef) {}

    trackById (_: number, t: TabEntry): string { return t.id }

    onCloseClick (ev: MouseEvent, id: string): void {
        ev.stopPropagation()
        this.tabClose.emit(id)
    }

    onDblClick (tab: TabEntry): void {
        this.renamingId = tab.id
        this.renameValue = tab.label
        this.cdr.markForCheck()
        // Focus the rename input on next tick
        setTimeout(() => {
            const el = document.querySelector<HTMLInputElement>('.tab-rename-input')
            el?.focus()
            el?.select()
        }, 0)
    }

    commitRename (): void {
        const id = this.renamingId
        if (!id) { return }
        const label = this.renameValue.trim() || 'Untitled'
        this.tabRename.emit({ id, label })
        this.renamingId = null
        this.cdr.markForCheck()
    }

    cancelRename (): void {
        this.renamingId = null
        this.cdr.markForCheck()
    }

    onMiddleClick (ev: MouseEvent, id: string): void {
        if (ev.button === 1) {
            ev.preventDefault()
            this.tabClose.emit(id)
        }
    }

    onContextMenu (ev: MouseEvent, id: string): void {
        ev.preventDefault()
        // Simple confirmation-based tear-out via context menu
        if (confirm('Open this topology in a new window?')) {
            this.tabTearOut.emit(id)
        }
    }
}
