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
    /** Aggregate stats — incremented on each run. */
    successCount?: number
    failCount?: number
    createdAt: string
}

export interface JobResult {
    jobId: string
    ok: boolean
    message: string
    timestamp: string
    /** Wall-clock duration of the run in ms. */
    durationMs?: number
}

// ── Helpers ─────────────────────────────────────────────────────────────────

let _nextId = 0
function uid (): string { return `job-${Date.now()}-${++_nextId}` }

function nowIso (): string { return new Date().toISOString() }

const RESULT_PREFS_KEY = 'scheduled-job-results'
const MAX_GLOBAL_RESULTS = 200       // cap memory; per-job views slice locally
const MAX_PER_JOB_DISPLAY = 20

// ── Service ─────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class SchedulerService {

    private _jobs: ScheduledJob[] = []
    private _timer: ReturnType<typeof setInterval> | null = null
    private _api = (window as any).netopsAPI
    private _results: JobResult[] = []
    /** IDs of jobs currently executing — used by the UI to show a spinner. */
    private _runningJobIds = new Set<string>()
    private _resultsLoaded = false

    /** Callback set by the host component to actually execute actions. */
    onRunAction: ((action: string, config: Record<string, any>) => Promise<string>) | null = null

    get jobs (): ScheduledJob[] { return this._jobs }
    get results (): JobResult[] { return this._results }
    get isRunning (): boolean { return !!this._timer }

    /** Whether a specific job is currently executing. */
    isJobRunning (id: string): boolean { return this._runningJobIds.has(id) }

    /** Filter the global results array down to a single job's recent runs. */
    resultsForJob (id: string, limit = MAX_PER_JOB_DISPLAY): JobResult[] {
        return this._results
            .filter(r => r.jobId === id)
            .slice(0, limit)
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    async loadJobs (): Promise<void> {
        try {
            const saved = await this._api?.prefGet?.('scheduled-jobs')
            if (Array.isArray(saved) && saved.length > 0) {
                this._jobs = saved
                this._jobs.forEach(j => { j.nextRun = this.computeNextRun(j) })
            } else if (this._jobs.length === 0) {
                this.initDefaultJobs()
            }
        } catch { /* ignore read errors */ }

        // Lazy-load results history once.
        if (!this._resultsLoaded) {
            this._resultsLoaded = true
            try {
                const savedResults = await this._api?.prefGet?.(RESULT_PREFS_KEY)
                if (Array.isArray(savedResults)) {
                    this._results = savedResults.slice(0, MAX_GLOBAL_RESULTS)
                }
            } catch { /* ignore */ }
        }
    }

    saveJobs (): void {
        this._api?.prefSet?.('scheduled-jobs', this._jobs)
    }

    private _saveResults (): void {
        try { this._api?.prefSet?.(RESULT_PREFS_KEY, this._results) } catch { /* ignore */ }
    }

    // ── CRUD ────────────────────────────────────────────────────────────────

    addJob (job: Omit<ScheduledJob, 'id' | 'createdAt' | 'runCount'>): ScheduledJob {
        const full: ScheduledJob = {
            ...job,
            id: uid(),
            createdAt: nowIso(),
            runCount: 0,
            successCount: 0,
            failCount: 0,
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
        // Drop this job's results from the global list to avoid dangling rows.
        const before = this._results.length
        this._results = this._results.filter(r => r.jobId !== id)
        if (this._results.length !== before) { this._saveResults() }
        this.saveJobs()
    }

    toggleJob (id: string): void {
        this._jobs = this._jobs.map(j => j.id === id ? { ...j, enabled: !j.enabled } : j)
        this.saveJobs()
    }

    /** Duplicate a job so the user can build variants. The copy starts disabled
     *  to avoid two identical jobs firing simultaneously, gets a fresh id, and
     *  appends "(copy)" to the name. */
    cloneJob (id: string): ScheduledJob | null {
        const src = this._jobs.find(j => j.id === id)
        if (!src) { return null }
        const copy: ScheduledJob = {
            ...src,
            id: uid(),
            name: `${src.name} (copy)`,
            enabled: false,
            createdAt: nowIso(),
            lastRun: undefined,
            runCount: 0,
            successCount: 0,
            failCount: 0,
        }
        copy.nextRun = this.computeNextRun(copy)
        this._jobs = [...this._jobs, copy]
        this.saveJobs()
        return copy
    }

    /** Skip the next scheduled fire of a job by faking lastRun=now. The job's
     *  `runCount` is not incremented and no JobResult is appended — the user's
     *  intent is "treat the next slot as already done". */
    skipNext (id: string): void {
        this._jobs = this._jobs.map(j => {
            if (j.id !== id) { return j }
            const updated = { ...j, lastRun: nowIso() }
            updated.nextRun = this.computeNextRun(updated)
            return updated
        })
        this.saveJobs()
    }

    /** Bulk: disable every job. Useful before a maintenance window. */
    pauseAll (): number {
        let changed = 0
        this._jobs = this._jobs.map(j => {
            if (j.enabled) { changed++; return { ...j, enabled: false } }
            return j
        })
        if (changed) { this.saveJobs() }
        return changed
    }

    /** Bulk: enable every job. */
    resumeAll (): number {
        let changed = 0
        this._jobs = this._jobs.map(j => {
            if (!j.enabled) { changed++; return { ...j, enabled: true } }
            return j
        })
        if (changed) { this.saveJobs() }
        return changed
    }

    /** Wipe results history (per-job aggregates on the job itself are kept). */
    clearResults (): void {
        this._results = []
        this._saveResults()
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
        // Collect all due jobs first, then dispatch with jitter — prevents
        // a "thundering herd" when 5 jobs all fire at the top of the hour
        // and try to SSH to the same fabric simultaneously (rate limits,
        // auth lockouts, transient failures).
        const due = this._jobs.filter(j => j.enabled && this.isDue(j))
        if (!due.length) { return }
        for (let i = 0; i < due.length; i++) {
            // Jitter: 0s for the first, then 5–15s gap between subsequent
            // jobs. Keeps perceived latency low for single jobs while
            // staggering large batches so SSH doesn't get hammered.
            if (i > 0) {
                const jitterMs = 5_000 + Math.random() * 10_000
                await new Promise(r => setTimeout(r, jitterMs))
            }
            await this.runJob(due[i])
        }
    }

    async runJob (job: ScheduledJob): Promise<JobResult> {
        // Don't allow concurrent runs of the same job — a long-running backup
        // shouldn't be re-fired by an impatient user clicking "Run now" twice.
        if (this._runningJobIds.has(job.id)) {
            return {
                jobId: job.id, ok: false,
                message: 'Already running — wait for current run to finish.',
                timestamp: nowIso(),
            }
        }
        this._runningJobIds.add(job.id)

        const startedAt = Date.now()
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
        } finally {
            this._runningJobIds.delete(job.id)
        }

        result.durationMs = Date.now() - startedAt

        // Update job state — find the live record (the original `job` object
        // may be a stale reference from before an update).
        this._jobs = this._jobs.map(j => {
            if (j.id !== job.id) { return j }
            const updated = { ...j }
            updated.lastRun = result.timestamp
            updated.runCount = (updated.runCount ?? 0) + 1
            if (result.ok) { updated.successCount = (updated.successCount ?? 0) + 1 }
            else           { updated.failCount    = (updated.failCount    ?? 0) + 1 }
            updated.nextRun = this.computeNextRun(updated)
            return updated
        })
        this.saveJobs()

        // Prepend so newest is at index 0; cap at the global max.
        this._results = [result, ...this._results].slice(0, MAX_GLOBAL_RESULTS)
        this._saveResults()

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
                runCount: 0, successCount: 0, failCount: 0, createdAt: nowIso(),
            },
            {
                id: uid(), name: 'Compliance Check', schedule: 'daily@02:00',
                action: 'compliance_check', config: {}, enabled: true,
                runCount: 0, successCount: 0, failCount: 0, createdAt: nowIso(),
            },
            {
                id: uid(), name: 'Poll All Devices', schedule: '5m',
                action: 'poll_all', config: {}, enabled: false,
                runCount: 0, successCount: 0, failCount: 0, createdAt: nowIso(),
            },
        ]
        this._jobs.forEach(j => { j.nextRun = this.computeNextRun(j) })
        this.saveJobs()
    }
}
