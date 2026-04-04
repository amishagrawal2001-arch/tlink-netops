import { Injectable } from '@angular/core'

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface ScheduledJob {
    id: string
    name: string
    schedule: string  // "5m", "1h", "6h", "24h", "daily@02:00", "weekly@sun-03:00"
    action: 'backup_all' | 'compliance_check' | 'poll_all' | 'custom_command'
    config: Record<string, any>
    enabled: boolean
    lastRun?: string
    nextRun?: string
    runCount: number
    createdAt: string
}

export interface JobResult {
    jobId: string
    ok: boolean
    message: string
    timestamp: string
}

// ── Helpers ─────────────────────────────────────────────────────────────────

let _nextId = 0
function uid (): string { return `job-${Date.now()}-${++_nextId}` }

function nowIso (): string { return new Date().toISOString() }

// ── Service ─────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class SchedulerService {

    private _jobs: ScheduledJob[] = []
    private _timer: ReturnType<typeof setInterval> | null = null
    private _api = (window as any).netopsAPI
    private _results: JobResult[] = []

    /** Callback set by the host component to actually execute actions. */
    onRunAction: ((action: string, config: Record<string, any>) => Promise<string>) | null = null

    get jobs (): ScheduledJob[] { return this._jobs }
    get results (): JobResult[] { return this._results }
    get isRunning (): boolean { return !!this._timer }

    // ── Persistence ─────────────────────────────────────────────────────────

    async loadJobs (): Promise<void> {
        try {
            const saved = await this._api?.prefGet?.('scheduled-jobs')
            if (Array.isArray(saved) && saved.length > 0) {
                this._jobs = saved
                this._jobs.forEach(j => { j.nextRun = this.computeNextRun(j) })
                return
            }
        } catch { /* ignore read errors */ }
        if (this._jobs.length === 0) { this.initDefaultJobs() }
    }

    saveJobs (): void {
        this._api?.prefSet?.('scheduled-jobs', this._jobs)
    }

    // ── CRUD ────────────────────────────────────────────────────────────────

    addJob (job: Omit<ScheduledJob, 'id' | 'createdAt' | 'runCount'>): ScheduledJob {
        const full: ScheduledJob = {
            ...job,
            id: uid(),
            createdAt: nowIso(),
            runCount: 0,
        }
        full.nextRun = this.computeNextRun(full)
        this._jobs = [...this._jobs, full]
        this.saveJobs()
        return full
    }

    updateJob (id: string, changes: Partial<ScheduledJob>): void {
        this._jobs = this._jobs.map(j => {
            if (j.id !== id) { return j }
            const updated = { ...j, ...changes }
            updated.nextRun = this.computeNextRun(updated)
            return updated
        })
        this.saveJobs()
    }

    removeJob (id: string): void {
        this._jobs = this._jobs.filter(j => j.id !== id)
        this.saveJobs()
    }

    toggleJob (id: string): void {
        this._jobs = this._jobs.map(j => j.id === id ? { ...j, enabled: !j.enabled } : j)
        this.saveJobs()
    }

    // ── Scheduler Loop ──────────────────────────────────────────────────────

    startScheduler (): void {
        if (this._timer) { return }
        this._timer = setInterval(() => this._tick(), 60_000)
        // Run an immediate tick
        this._tick()
    }

    stopScheduler (): void {
        if (this._timer) {
            clearInterval(this._timer)
            this._timer = null
        }
    }

    private async _tick (): Promise<void> {
        for (const job of this._jobs) {
            if (!job.enabled) { continue }
            if (this.isDue(job)) {
                await this.runJob(job)
            }
        }
    }

    async runJob (job: ScheduledJob): Promise<JobResult> {
        const result: JobResult = {
            jobId: job.id,
            ok: false,
            message: '',
            timestamp: nowIso(),
        }

        try {
            if (this.onRunAction) {
                result.message = await this.onRunAction(job.action, job.config)
            } else {
                result.message = `Action "${job.action}" dispatched (no handler attached)`
            }
            result.ok = true
        } catch (err: any) {
            result.message = `Error: ${err?.message ?? err}`
        }

        // Update job state
        job.lastRun = result.timestamp
        job.runCount++
        job.nextRun = this.computeNextRun(job)
        this.saveJobs()

        // Keep last 50 results
        this._results = [result, ...this._results].slice(0, 50)

        return result
    }

    // ── Schedule Parsing ────────────────────────────────────────────────────

    private isDue (job: ScheduledJob): boolean {
        const now = Date.now()
        const lastRun = job.lastRun ? new Date(job.lastRun).getTime() : 0

        // Simple interval: "5m", "15m", "1h", "6h", "12h", "24h"
        const intervalMatch = job.schedule.match(/^(\d+)(m|h)$/)
        if (intervalMatch) {
            const amount = parseInt(intervalMatch[1], 10)
            const unit = intervalMatch[2]
            const ms = unit === 'h' ? amount * 3600_000 : amount * 60_000
            return (now - lastRun) >= ms
        }

        // Daily: "daily@HH:MM"
        const dailyMatch = job.schedule.match(/^daily@(\d{2}):(\d{2})$/)
        if (dailyMatch) {
            const targetH = parseInt(dailyMatch[1], 10)
            const targetM = parseInt(dailyMatch[2], 10)
            const d = new Date()
            if (d.getHours() === targetH && d.getMinutes() === targetM) {
                // Only fire if not already run today
                if (!job.lastRun) { return true }
                const lastDate = new Date(job.lastRun)
                return lastDate.toDateString() !== d.toDateString()
            }
            return false
        }

        // Weekly: "weekly@dow-HH:MM" (e.g. "weekly@sun-03:00")
        const weeklyMatch = job.schedule.match(/^weekly@(\w{3})-(\d{2}):(\d{2})$/)
        if (weeklyMatch) {
            const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
            const targetDay = dayMap[weeklyMatch[1].toLowerCase()] ?? 0
            const targetH = parseInt(weeklyMatch[2], 10)
            const targetM = parseInt(weeklyMatch[3], 10)
            const d = new Date()
            if (d.getDay() === targetDay && d.getHours() === targetH && d.getMinutes() === targetM) {
                if (!job.lastRun) { return true }
                const lastDate = new Date(job.lastRun)
                const daysSince = Math.floor((now - lastDate.getTime()) / 86_400_000)
                return daysSince >= 1
            }
            return false
        }

        return false
    }

    private computeNextRun (job: ScheduledJob): string {
        const now = new Date()
        const lastRun = job.lastRun ? new Date(job.lastRun) : now

        // Simple interval
        const intervalMatch = job.schedule.match(/^(\d+)(m|h)$/)
        if (intervalMatch) {
            const amount = parseInt(intervalMatch[1], 10)
            const unit = intervalMatch[2]
            const ms = unit === 'h' ? amount * 3600_000 : amount * 60_000
            return new Date(lastRun.getTime() + ms).toISOString()
        }

        // Daily
        const dailyMatch = job.schedule.match(/^daily@(\d{2}):(\d{2})$/)
        if (dailyMatch) {
            const next = new Date(now)
            next.setHours(parseInt(dailyMatch[1], 10), parseInt(dailyMatch[2], 10), 0, 0)
            if (next <= now) { next.setDate(next.getDate() + 1) }
            return next.toISOString()
        }

        // Weekly
        const weeklyMatch = job.schedule.match(/^weekly@(\w{3})-(\d{2}):(\d{2})$/)
        if (weeklyMatch) {
            const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
            const targetDay = dayMap[weeklyMatch[1].toLowerCase()] ?? 0
            const targetH = parseInt(weeklyMatch[2], 10)
            const targetM = parseInt(weeklyMatch[3], 10)
            const next = new Date(now)
            next.setHours(targetH, targetM, 0, 0)
            let diff = targetDay - now.getDay()
            if (diff < 0) { diff += 7 }
            if (diff === 0 && next <= now) { diff = 7 }
            next.setDate(next.getDate() + diff)
            return next.toISOString()
        }

        return now.toISOString()
    }

    // ── Defaults ────────────────────────────────────────────────────────────

    initDefaultJobs (): void {
        if (this._jobs.length > 0) { return }
        this._jobs = [
            {
                id: uid(), name: 'Backup All Configs', schedule: '6h',
                action: 'backup_all', config: {}, enabled: true,
                runCount: 0, createdAt: nowIso(),
            },
            {
                id: uid(), name: 'Compliance Check', schedule: 'daily@02:00',
                action: 'compliance_check', config: {}, enabled: true,
                runCount: 0, createdAt: nowIso(),
            },
            {
                id: uid(), name: 'Poll All Devices', schedule: '5m',
                action: 'poll_all', config: {}, enabled: false,
                runCount: 0, createdAt: nowIso(),
            },
        ]
        this._jobs.forEach(j => { j.nextRun = this.computeNextRun(j) })
        this.saveJobs()
    }
}
