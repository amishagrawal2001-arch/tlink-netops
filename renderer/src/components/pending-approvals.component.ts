import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, Output, OnInit, OnDestroy,
} from '@angular/core'
import { WorkflowService, PendingApproval, ResolvedApproval } from '../services/workflow.service'

/**
 * Pending Approvals — modal listing every workflow currently paused at an
 * `approval` step. Each row has Approve / Reject buttons that resolve the
 * gate and let the workflow continue (or abort).
 *
 * Designed for the two-person rule: the operator who started the workflow
 * picks targets and parameters; a second operator (or themselves, for less
 * critical changes) opens this panel and approves the change.
 */
@Component({
    selector: 'pending-approvals',
    templateUrl: './pending-approvals.component.pug',
    styleUrls: ['./pending-approvals.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PendingApprovalsComponent implements OnInit, OnDestroy {
    @Output() closed = new EventEmitter<void>()

    pending: PendingApproval[] = []
    showHistory = false
    private _unsub?: () => void

    /** Read-only audit log of past gates (last 50). */
    get history (): ResolvedApproval[] { return this.wfSvc.approvalHistory }
    toggleHistory (): void { this.showHistory = !this.showHistory; this.cdr.markForCheck() }

    constructor (
        private cdr: ChangeDetectorRef,
        private wfSvc: WorkflowService,
    ) {}

    ngOnInit (): void {
        this._unsub = this.wfSvc.onApprovalsChange((list) => {
            this.pending = list
            this.cdr.markForCheck()
        })
    }

    ngOnDestroy (): void {
        this._unsub?.()
    }

    approve (id: string): void {
        this.wfSvc.resolveApproval(id, 'approve')
    }

    reject (id: string): void {
        this.wfSvc.resolveApproval(id, 'reject')
    }

    /** Emergency drain — resolves every pending approval with reject. Used
     *  when a stale workflow has been paused for too long or the user wants
     *  to clear the queue before app shutdown. */
    rejectAll (): void {
        if (!this.pending.length) { return }
        const n = this.pending.length
        if (!window.confirm(`Reject all ${n} pending approval(s)? Their workflows will halt.`)) { return }
        this.wfSvc.rejectAllApprovals('user clicked Reject all')
    }

    close (): void { this.closed.emit() }

    /** Friendly relative time for the requestedAt timestamp. */
    relativeTime (iso: string): string {
        const ms = Date.now() - new Date(iso).getTime()
        const s = Math.floor(ms / 1000)
        if (s < 60) { return `${s}s ago` }
        const m = Math.floor(s / 60)
        if (m < 60) { return `${m}m ago` }
        const h = Math.floor(m / 60)
        return `${h}h ${m % 60}m ago`
    }
}
