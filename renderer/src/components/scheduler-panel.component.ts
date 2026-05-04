import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, OnInit, OnDestroy, Output,
} from '@angular/core'
import { SchedulerService, ScheduledJob, JobResult } from '../services/scheduler.service'

type FormMode = 'add' | 'edit' | 'closed'

@Component({
    selector: 'scheduler-panel',
    templateUrl: './scheduler-panel.component.pug',
    styleUrls: ['./scheduler-panel.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchedulerPanelComponent implements OnInit, OnDestroy {

    @Output() closed = new EventEmitter<void>()

    formMode: FormMode = 'closed'
    /** When formMode='edit', the id of the job being edited (so we can call updateJob). */
    editingId: string | null = null
    addError = ''

    /** Search/filter state for the jobs table. */
    searchQuery = ''
    statusFilter: 'all' | 'enabled' | 'disabled' | 'failing' = 'all'

    /** Per-row expansion for the inline history panel. */
    expandedJobIds = new Set<string>()

    /** Form fields for add/edit. */
    formJob = this._blankFormJob()

    readonly scheduleOptions = [
        { value: '5m',  label: 'Every 5 minutes' },
        { value: '15m', label: 'Every 15 minutes' },
        { value: '30m', label: 'Every 30 minutes' },
        { value: '1h',  label: 'Every 1 hour' },
        { value: '2h',  label: 'Every 2 hours' },
        { value: '6h',  label: 'Every 6 hours' },
        { value: '12h', label: 'Every 12 hours' },
        { value: '24h', label: 'Every 24 hours' },
        { value: 'daily@00:00', label: 'Daily at midnight' },
        { value: 'daily@02:00', label: 'Daily at 02:00' },
        { value: 'daily@06:00', label: 'Daily at 06:00' },
        { value: 'daily@18:00', label: 'Daily at 18:00' },
        { value: 'weekly@sun-03:00', label: 'Weekly (Sun 03:00)' },
        { value: 'weekly@mon-06:00', label: 'Weekly (Mon 06:00)' },
        { value: 'weekly@fri-18:00', label: 'Weekly (Fri 18:00)' },
    ]

    readonly actionOptions = [
        { value: 'backup_all',       label: 'Backup All Configs' },
        { value: 'compliance_check', label: 'Compliance Check' },
        { value: 'poll_all',         label: 'Poll All Devices' },
        { value: 'custom_command',   label: 'Custom Command' },
    ]

    /** Self-tick to refresh "in 12m" / "2m ago" relative times in the table. */
    private _refreshTimer: ReturnType<typeof setInterval> | null = null

    constructor (
        public schedSvc: SchedulerService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit (): void {
        this.schedSvc.loadJobs().then(() => this.cdr.markForCheck())
        // Re-render every 30 s so "in 12m" / "2m ago" stay accurate.
        this._refreshTimer = setInterval(() => this.cdr.markForCheck(), 30_000)
    }

    ngOnDestroy (): void {
        if (this._refreshTimer) { clearInterval(this._refreshTimer) }
    }

    close (): void { this.closed.emit() }

    // ── Filtered jobs ───────────────────────────────────────────────────────

    get filteredJobs (): ScheduledJob[] {
        const q = this.searchQuery.toLowerCase().trim()
        return this.schedSvc.jobs.filter(j => {
            if (this.statusFilter === 'enabled'  && !j.enabled) { return false }
            if (this.statusFilter === 'disabled' &&  j.enabled) { return false }
            if (this.statusFilter === 'failing'  && (j.failCount ?? 0) === 0) { return false }
            if (!q) { return true }
            return (
                j.name.toLowerCase().includes(q) ||
                j.action.toLowerCase().includes(q) ||
                this.scheduleLabel(j.schedule).toLowerCase().includes(q)
            )
        })
    }

    get jobs (): ScheduledJob[] { return this.schedSvc.jobs }
    get results (): JobResult[] { return this.schedSvc.results }
    get schedulerRunning (): boolean { return this.schedSvc.isRunning }
    isJobRunning (id: string): boolean { return this.schedSvc.isJobRunning(id) }

    /** Aggregate counters for the toolbar status strip. */
    get summaryCounts () {
        const all = this.schedSvc.jobs
        return {
            total:    all.length,
            enabled:  all.filter(j => j.enabled).length,
            disabled: all.filter(j => !j.enabled).length,
            running:  all.filter(j => this.isJobRunning(j.id)).length,
            failing:  all.filter(j => (j.failCount ?? 0) > 0).length,
        }
    }

    // ── Scheduler control ───────────────────────────────────────────────────

    toggleScheduler (): void {
        if (this.schedSvc.isRunning) { this.schedSvc.stopScheduler() }
        else                          { this.schedSvc.startScheduler() }
        this.cdr.markForCheck()
    }

    pauseAll (): void {
        const n = this.schedSvc.pauseAll()
        if (n) { console.log(`[scheduler] paused ${n} job(s)`) }
        this.cdr.markForCheck()
    }
    resumeAll (): void {
        const n = this.schedSvc.resumeAll()
        if (n) { console.log(`[scheduler] resumed ${n} job(s)`) }
        this.cdr.markForCheck()
    }

    // ── Job actions ─────────────────────────────────────────────────────────

    toggleJob (id: string): void {
        this.schedSvc.toggleJob(id)
        this.cdr.markForCheck()
    }

    removeJob (id: string): void {
        const job = this.schedSvc.jobs.find(j => j.id === id)
        if (job && !confirm(`Delete job "${job.name}"? Its history will also be cleared.`)) { return }
        this.schedSvc.removeJob(id)
        this.expandedJobIds.delete(id)
        this.cdr.markForCheck()
    }

    cloneJob (id: string): void {
        const copy = this.schedSvc.cloneJob(id)
        if (copy) {
            // Auto-expand the new copy so the user sees it landed.
            this.expandedJobIds.add(copy.id)
        }
        this.cdr.markForCheck()
    }

    skipNext (id: string): void {
        const job = this.schedSvc.jobs.find(j => j.id === id)
        if (!job) { return }
        if (!confirm(`Skip the next scheduled run of "${job.name}"? The next run will be ${this._scheduleHuman(job.schedule)} after now.`)) { return }
        this.schedSvc.skipNext(id)
        this.cdr.markForCheck()
    }

    async runNow (job: ScheduledJob): Promise<void> {
        await this.schedSvc.runJob(job)
        this.cdr.markForCheck()
    }

    // ── Form (shared add/edit) ──────────────────────────────────────────────

    private _blankFormJob () {
        return {
            name: '',
            schedule: '1h',
            action: 'backup_all' as ScheduledJob['action'],
            enabled: true,
            customCommand: '',
            nodeFilter: '*',
        }
    }

    openAddForm (): void {
        this.formJob = this._blankFormJob()
        this.formMode = 'add'
        this.editingId = null
        this.addError = ''
        this.cdr.markForCheck()
    }

    openEditForm (job: ScheduledJob): void {
        this.formJob = {
            name:          job.name,
            schedule:      job.schedule,
            action:        job.action,
            enabled:       job.enabled,
            customCommand: (job.config?.command as string) ?? '',
            nodeFilter:    (job.config?.nodeFilter as string) ?? '*',
        }
        this.formMode = 'edit'
        this.editingId = job.id
        this.addError = ''
        this.cdr.markForCheck()
    }

    cancelForm (): void {
        this.formMode = 'closed'
        this.editingId = null
        this.cdr.markForCheck()
    }

    confirmForm (): void {
        const name = this.formJob.name.trim()
        if (!name) { this.addError = 'Job name is required'; this.cdr.markForCheck(); return }

        const config: Record<string, any> = {}
        if (this.formJob.action === 'custom_command') {
            if (!this.formJob.customCommand.trim()) {
                this.addError = 'Command is required for custom command action'
                this.cdr.markForCheck()
                return
            }
            config.command = this.formJob.customCommand.trim()
            config.nodeFilter = this.formJob.nodeFilter.trim() || '*'
        }

        this.addError = ''
        if (this.formMode === 'edit' && this.editingId) {
            this.schedSvc.updateJob(this.editingId, {
                name,
                schedule: this.formJob.schedule,
                action:   this.formJob.action,
                config,
                enabled:  this.formJob.enabled,
            })
        } else {
            this.schedSvc.addJob({
                name,
                schedule: this.formJob.schedule,
                action:   this.formJob.action,
                config,
                enabled:  this.formJob.enabled,
            })
        }
        this.formMode = 'closed'
        this.editingId = null
        this.cdr.markForCheck()
    }

    // ── History row expansion ───────────────────────────────────────────────

    toggleHistory (id: string): void {
        if (this.expandedJobIds.has(id)) { this.expandedJobIds.delete(id) }
        else                              { this.expandedJobIds.add(id) }
        this.cdr.markForCheck()
    }
    isExpanded (id: string): boolean { return this.expandedJobIds.has(id) }

    historyFor (id: string): JobResult[] { return this.schedSvc.resultsForJob(id, 10) }

    // ── Helpers ─────────────────────────────────────────────────────────────

    formatTime (iso?: string): string {
        if (!iso) { return '—' }
        try {
            const d = new Date(iso)
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
                ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        } catch { return iso }
    }

    /** "in 12m", "in 2h", "overdue", "5m ago", etc. */
    formatRelative (iso?: string, kind: 'next' | 'past' = 'next'): string {
        if (!iso) { return '—' }
        try {
            const ms = new Date(iso).getTime() - Date.now()
            if (kind === 'next') {
                if (ms < -60_000)      { return 'overdue' }
                if (ms < 60_000)       { return 'in <1m' }
                if (ms < 3_600_000)    { return `in ${Math.round(ms / 60_000)}m` }
                if (ms < 86_400_000)   { return `in ${Math.round(ms / 3_600_000)}h` }
                return `in ${Math.round(ms / 86_400_000)}d`
            } else {
                const past = -ms
                if (past < 60_000)     { return 'just now' }
                if (past < 3_600_000)  { return `${Math.round(past / 60_000)}m ago` }
                if (past < 86_400_000) { return `${Math.round(past / 3_600_000)}h ago` }
                return `${Math.round(past / 86_400_000)}d ago`
            }
        } catch { return iso }
    }

    formatDuration (ms?: number): string {
        if (!ms || ms < 0) { return '—' }
        if (ms < 1000)     { return `${ms}ms` }
        if (ms < 60_000)   { return `${(ms / 1000).toFixed(1)}s` }
        return `${(ms / 60_000).toFixed(1)}m`
    }

    scheduleLabel (schedule: string): string {
        const opt = this.scheduleOptions.find(o => o.value === schedule)
        return opt?.label ?? schedule
    }

    actionLabel (action: string): string {
        const opt = this.actionOptions.find(o => o.value === action)
        return opt?.label ?? action
    }

    /** Plain English for the skipNext confirm dialog ("1 hour", "Daily 02:00"). */
    private _scheduleHuman (schedule: string): string {
        const m = schedule.match(/^(\d+)([mh])$/)
        if (m) { return `${m[1]} ${m[2] === 'h' ? 'hour' : 'minute'}${m[1] === '1' ? '' : 's'}` }
        if (schedule.startsWith('daily@'))  { return `the next daily slot (${schedule.slice(6)})` }
        if (schedule.startsWith('weekly@')) { return `the next weekly slot (${schedule.slice(7)})` }
        return schedule
    }

    clearAllResults (): void {
        if (!confirm('Clear all job execution history?')) { return }
        this.schedSvc.clearResults()
        this.cdr.markForCheck()
    }
}
