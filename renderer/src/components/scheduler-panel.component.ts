import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, OnInit, Output,
} from '@angular/core'
import { SchedulerService, ScheduledJob, JobResult } from '../services/scheduler.service'

@Component({
    selector: 'scheduler-panel',
    templateUrl: './scheduler-panel.component.pug',
    styleUrls: ['./scheduler-panel.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchedulerPanelComponent implements OnInit {

    @Output() closed = new EventEmitter<void>()

    showAddForm = false
    addError = ''

    // New job form fields
    newJob = {
        name: '',
        schedule: '1h',
        action: 'backup_all' as ScheduledJob['action'],
        config: {} as Record<string, any>,
        enabled: true,
        customCommand: '',
        nodeFilter: '*',
    }

    readonly scheduleOptions = [
        { value: '5m',  label: 'Every 5 minutes' },
        { value: '15m', label: 'Every 15 minutes' },
        { value: '1h',  label: 'Every 1 hour' },
        { value: '6h',  label: 'Every 6 hours' },
        { value: '12h', label: 'Every 12 hours' },
        { value: '24h', label: 'Every 24 hours' },
        { value: 'daily@00:00', label: 'Daily at midnight' },
        { value: 'daily@02:00', label: 'Daily at 02:00' },
        { value: 'daily@06:00', label: 'Daily at 06:00' },
        { value: 'weekly@sun-03:00', label: 'Weekly (Sun 03:00)' },
        { value: 'weekly@mon-06:00', label: 'Weekly (Mon 06:00)' },
    ]

    readonly actionOptions = [
        { value: 'backup_all',       label: 'Backup All Configs' },
        { value: 'compliance_check', label: 'Compliance Check' },
        { value: 'poll_all',         label: 'Poll All Devices' },
        { value: 'custom_command',   label: 'Custom Command' },
    ]

    constructor (
        public schedSvc: SchedulerService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit (): void {
        this.schedSvc.loadJobs().then(() => this.cdr.markForCheck())
    }

    close (): void { this.closed.emit() }

    get jobs (): ScheduledJob[] { return this.schedSvc.jobs }
    get results (): JobResult[] { return this.schedSvc.results }
    get schedulerRunning (): boolean { return this.schedSvc.isRunning }

    // ── Scheduler Control ───────────────────────────────────────────────────

    toggleScheduler (): void {
        if (this.schedSvc.isRunning) {
            this.schedSvc.stopScheduler()
        } else {
            this.schedSvc.startScheduler()
        }
        this.cdr.markForCheck()
    }

    // ── Job Actions ─────────────────────────────────────────────────────────

    toggleJob (id: string): void {
        this.schedSvc.toggleJob(id)
        this.cdr.markForCheck()
    }

    removeJob (id: string): void {
        this.schedSvc.removeJob(id)
        this.cdr.markForCheck()
    }

    async runNow (job: ScheduledJob): Promise<void> {
        await this.schedSvc.runJob(job)
        this.cdr.markForCheck()
    }

    // ── Add Form ────────────────────────────────────────────────────────────

    openAddForm (): void {
        this.showAddForm = true
        this.newJob = {
            name: '', schedule: '1h', action: 'backup_all',
            config: {}, enabled: true, customCommand: '', nodeFilter: '*',
        }
        this.addError = ''
        this.cdr.markForCheck()
    }

    cancelAdd (): void {
        this.showAddForm = false
        this.cdr.markForCheck()
    }

    confirmAdd (): void {
        const name = this.newJob.name.trim()
        if (!name) {
            this.addError = 'Job name is required'
            this.cdr.markForCheck()
            return
        }

        const config: Record<string, any> = {}
        if (this.newJob.action === 'custom_command') {
            if (!this.newJob.customCommand.trim()) {
                this.addError = 'Command is required for custom command action'
                this.cdr.markForCheck()
                return
            }
            config.command = this.newJob.customCommand.trim()
            config.nodeFilter = this.newJob.nodeFilter.trim() || '*'
        }

        this.addError = ''
        this.schedSvc.addJob({
            name,
            schedule: this.newJob.schedule,
            action: this.newJob.action,
            config,
            enabled: this.newJob.enabled,
        })
        this.showAddForm = false
        this.cdr.markForCheck()
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    formatTime (iso?: string): string {
        if (!iso) { return '--' }
        try {
            const d = new Date(iso)
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
                ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        } catch { return iso }
    }

    scheduleLabel (schedule: string): string {
        const opt = this.scheduleOptions.find(o => o.value === schedule)
        return opt?.label ?? schedule
    }

    actionLabel (action: string): string {
        const opt = this.actionOptions.find(o => o.value === action)
        return opt?.label ?? action
    }
}
