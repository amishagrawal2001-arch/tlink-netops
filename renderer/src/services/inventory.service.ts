// ═══════════════════════════════════════════════════════════════════════════════
// InventoryService — polling, config backup, alarms, events, upgrade tracking
// ═══════════════════════════════════════════════════════════════════════════════

import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs'
import { TopologyService } from './topology.service'
import { getVendorCommands } from './vendor-command-map'
import {
    parseShowVersion, parseResourceUsage, parseInterfaceStatus, parseVendorAlarms,
    detectVendorFromOutput,
    ParsedVersion, ParsedResourceUsage, ParsedInterfaceStatus, ParsedAlarmEntry,
} from './vendor-output-parser'
import {
    InventoryStore, DeviceVersion, ConfigBackupEntry,
    DeviceAlarm, AlarmSeverity, AlarmCategory,
    FirmwareUpgradePlan, UpgradeStage,
    EventRule, EventTrigger, EventActionType,
    InventoryEvent, TopologyNode,
    PollInterfaceEntry, PollSyncProposal, PollSyncPortChange,
} from '../api/interfaces'
import { NetopsSshResult } from '../api/netops-api'
import { normalizeIfName, interfaceNamesMatch, globMatch } from './inventory-helpers'

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _nextId = 0
function uuid (): string { return `inv-${Date.now()}-${++_nextId}` }

function nowIso (): string { return new Date().toISOString() }

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class InventoryService implements OnDestroy {

    // ── State ────────────────────────────────────────────────────────────────
    private _store$ = new BehaviorSubject<InventoryStore>(this._emptyStore())
    private _events$ = new Subject<InventoryEvent>()
    private _pollTimer: ReturnType<typeof setInterval> | null = null
    private _subs: Subscription[] = []
    private _processingEvent = false
    private _eventQueue: InventoryEvent[] = []
    private _sidecarPath: string | null = null
    private _autoSaveTimer: ReturnType<typeof setTimeout> | null = null
    private _autoSaveDebounceMs = 2000
    private _backupTimer: any = null

    // Poll-all progress tracking
    pollAllTotal = 0
    pollAllDone = 0
    pollAllRunning = false

    get store$ (): Observable<InventoryStore> { return this._store$.asObservable() }
    get store (): InventoryStore { return this._store$.value }
    get events$ (): Observable<InventoryEvent> { return this._events$.asObservable() }

    get activeAlarms (): DeviceAlarm[] {
        return this.store.alarms.filter(a => !a.clearedAt)
    }

    get allAlarms (): DeviceAlarm[] { return this.store.alarms }

    get activeAlarmCount (): number { return this.activeAlarms.length }

    get criticalAlarmCount (): number {
        return this.activeAlarms.filter(a => a.severity === 'critical').length
    }

    get isPolling (): boolean { return this._pollTimer !== null }

    constructor (private topoSvc: TopologyService) {}

    /**
     * Set the file path for auto-saving the inventory sidecar.
     * Once set, every `_patchStore()` call will debounce-write to this path.
     */
    setSidecarPath (path: string | null): void {
        this._sidecarPath = path
    }

    get sidecarPath (): string | null { return this._sidecarPath }

    /** Reset the inventory store to a blank state (e.g. on New Topology). */
    reset (): void {
        this.stopPolling()
        this._sidecarPath = null
        this._cancelAutoSave()
        this._store$.next(this._emptyStore())
    }

    // ── Polling ──────────────────────────────────────────────────────────────

    startPolling (intervalMs?: number): void {
        this.stopPolling()
        const ms = intervalMs ?? this.store.pollIntervalMs
        if (ms <= 0) { return }
        this._patchStore({ pollIntervalMs: ms })
        // Poll immediately on enable, then repeat at interval
        this.pollAllDevices()
        this._pollTimer = setInterval(() => { this.pollAllDevices() }, ms)
    }

    stopPolling (): void {
        if (this._pollTimer) {
            clearInterval(this._pollTimer)
            this._pollTimer = null
        }
    }

    async pollDevice (nodeId: string): Promise<void> {
        const node = this.topoSvc.getNode(nodeId)
        if (!node) { return }

        const api = (window as any).netopsAPI
        if (!api?.sshRunCommands) { return }

        const host = (node.mgmtIp ?? '').split('/')[0].trim()
        const username = (node.sshUsername ?? '').trim()
        const password = node.sshPassword ?? ''
        if (!host || !username || !password) {
            this._updateDeviceVersion(nodeId, { pollError: 'Missing SSH credentials', lastPolled: nowIso() })
            return
        }

        const cmds = getVendorCommands(node.vendor ?? '')
        const commands = [cmds.showVersion, cmds.showCpu, cmds.showMemory, cmds.showInterfaceBrief]
        if (cmds.showAlarms) { commands.push(cmds.showAlarms) }

        try {
            const result = await api.sshRunCommands({
                host, port: node.sshPort ?? 22, username, password,
                timeoutMs: 15000,
                commands,
            })

            if (!result.ok) {
                this._updateDeviceVersion(nodeId, { pollError: result.message, lastPolled: nowIso() })
                this._emitEvent({ type: 'poll_complete', nodeId, timestamp: nowIso(), detail: `Error: ${result.message}` })
                return
            }

            const r = result.results as NetopsSshResult[]

            // Always use command output — network devices often return non-zero
            // exit codes on successful commands, so we rely on the parser to
            // determine if the output is valid, not on the ok flag.
            const _out = (idx: number): string => {
                const entry = r[idx]
                if (!entry) { return '' }
                const raw = entry.output ?? ''
                return raw === '(no output)' ? '' : raw
            }

            const versionOut = _out(0)
            const cpuOut = _out(1)
            const memOut = _out(2)
            const ifOut = _out(3)
            const alarmOut = cmds.showAlarms ? _out(4) : ''

            // Count commands that truly failed (no output at all)
            const emptyCount = r.filter(
                (e) => !e || !e.output || e.output === '(no output)',
            ).length

            let vendor = node.vendor ?? ''

            // Auto-detect vendor from output when vendor field is not set.
            // Combines all command outputs to maximise detection surface.
            // Re-polls once with correct vendor-specific commands after detection.
            if (!vendor) {
                const allOutput = [versionOut, cpuOut, memOut, ifOut].join('\n')
                const detected = detectVendorFromOutput(allOutput)
                if (detected) {
                    vendor = detected
                    // Persist detected vendor and re-poll with correct commands.
                    // Guard: only re-poll if vendor actually changed to prevent loops.
                    const currentVendor = this.topoSvc.getNode(nodeId)?.vendor ?? ''
                    if (currentVendor !== detected) {
                        this.topoSvc.updateNodeConfig(nodeId, { vendor: detected })
                        this._emitEvent({
                            type: 'poll_complete', nodeId, timestamp: nowIso(),
                            detail: `Auto-detected vendor: ${detected} — re-polling with correct commands`,
                        })
                        return this.pollDevice(nodeId)
                    }
                }
            }

            const parsed = parseShowVersion(vendor, versionOut)
            const resources = parseResourceUsage(vendor, cpuOut, memOut)
            const interfaces = parseInterfaceStatus(vendor, ifOut)
            const vendorAlarms = parseVendorAlarms(vendor, alarmOut)

            // Determine if the parser extracted any useful version data
            const hasVersionData = !!(parsed.osVersion || parsed.hardwareModel
                || parsed.firmwareVersion || parsed.hardwareRevision || parsed.uptime)

            const prev = this.store.deviceVersions[nodeId]
            const version: DeviceVersion = {
                osVersion: parsed.osVersion ?? prev?.osVersion,
                firmwareVersion: parsed.firmwareVersion ?? prev?.firmwareVersion,
                hardwareModel: parsed.hardwareModel ?? prev?.hardwareModel,
                hardwareRevision: parsed.hardwareRevision ?? prev?.hardwareRevision,
                uptime: parsed.uptime ?? prev?.uptime,
                cpuPercent: resources.cpuPercent,
                memoryUsedPercent: resources.memoryUsedPercent,
                lastPolled: nowIso(),
                pollError: undefined,
            }

            // Build a warning when SSH worked but no version data was extracted
            if (!hasVersionData) {
                const warnings: string[] = []
                if (emptyCount > 0) {
                    warnings.push(`${emptyCount}/${r.length} command(s) returned no output`)
                }
                if (!versionOut) {
                    warnings.push('show-version returned no output')
                } else {
                    warnings.push(`Could not parse ${vendor || 'unknown'} version output`)
                }
                version.pollError = `⚠ ${warnings.join('; ')}`
            }

            this._updateDeviceVersion(nodeId, version)

            // Store parsed interface statuses for sync proposals
            if (interfaces.length > 0) {
                const entries: PollInterfaceEntry[] = interfaces.map(i => ({
                    name: i.name,
                    status: i.status,
                    speed: i.speed,
                    description: i.description,
                }))
                this._patchStore({
                    deviceInterfaces: {
                        ...this.store.deviceInterfaces,
                        [nodeId]: entries,
                    },
                })

                // Auto-sync port enabled status from polled interface state
                // so the front-panel diagram reflects live device status.
                for (const iface of interfaces) {
                    const port = node.ports.find(p => interfaceNamesMatch(iface.name, p.label))
                    if (!port) { continue }
                    const polledEnabled = iface.status === 'up'
                    if (port.enabled !== polledEnabled) {
                        this.topoSvc.updatePort(nodeId, port.id, { enabled: polledEnabled })
                    }
                }
            }

            // Check if version changed
            if (prev?.osVersion && version.osVersion && prev.osVersion !== version.osVersion) {
                this._emitEvent({ type: 'version_change', nodeId, timestamp: nowIso(),
                    detail: `${prev.osVersion} → ${version.osVersion}` })
            }

            // Alarm detection
            this._checkAlarms(nodeId, node, parsed, resources, interfaces, vendorAlarms)

            this._emitEvent({ type: 'poll_complete', nodeId, timestamp: nowIso(),
                detail: hasVersionData
                    ? `OS: ${version.osVersion ?? 'unknown'}, CPU: ${resources.cpuPercent ?? '?'}%, Mem: ${resources.memoryUsedPercent ?? '?'}%`
                    : `No version data extracted from ${node.label}` })

            // Run command_check rules that match this node
            await this._runCommandChecks(nodeId, node)

        } catch (err) {
            this._updateDeviceVersion(nodeId, { pollError: (err as Error).message, lastPolled: nowIso() })
        }
    }

    async pollAllDevices (): Promise<void> {
        const nodes = this.topoSvc.topology.nodes.filter(n => {
            const host = (n.mgmtIp ?? '').split('/')[0].trim()
            return host && (n.sshUsername ?? '').trim() && (n.sshPassword ?? '')
        })
        if (!nodes.length) { return }

        this.pollAllTotal = nodes.length
        this.pollAllDone = 0
        this.pollAllRunning = true

        // Limit concurrency to 5
        const queue = [...nodes]
        const concurrent = 5
        const running: Promise<void>[] = []

        const runNext = async (): Promise<void> => {
            while (queue.length > 0) {
                const node = queue.shift()!
                await this.pollDevice(node.id)
                this.pollAllDone++
            }
        }

        for (let i = 0; i < Math.min(concurrent, queue.length); i++) {
            running.push(runNext())
        }
        await Promise.allSettled(running)
        this.pollAllRunning = false
        this._patchStore({ lastFullPollAt: nowIso() })
    }

    // ── Config Backup ────────────────────────────────────────────────────────

    async backupConfig (
        nodeId: string,
        configType: 'running' | 'startup',
        trigger: 'manual' | 'scheduled' | 'event',
    ): Promise<ConfigBackupEntry | null> {
        const node = this.topoSvc.getNode(nodeId)
        if (!node) { return null }

        const api = (window as any).netopsAPI
        if (!api?.sshRunCommand || !api?.fileHash) { return null }

        const host = (node.mgmtIp ?? '').split('/')[0].trim()
        const username = (node.sshUsername ?? '').trim()
        const password = node.sshPassword ?? ''
        if (!host || !username || !password) { return null }

        const cmds = getVendorCommands(node.vendor ?? '', node.model ?? '')
        const command = configType === 'running' ? cmds.showRunningConfig : cmds.showStartupConfig

        try {
            const result = await api.sshRunCommand({
                host, port: node.sshPort ?? 22, username, password,
                timeoutMs: 30000,
                command,
            })

            if (!result.ok || !result.output) { return null }

            const hashResult = await api.fileHash(result.output)
            const entry: ConfigBackupEntry = {
                id: uuid(),
                nodeId,
                timestamp: nowIso(),
                configType,
                content: result.output,
                hash: hashResult.hash,
                trigger,
            }

            // Check for config drift
            const prevBackups = this.store.configBackups
                .filter(b => b.nodeId === nodeId && b.configType === configType)
                .sort((a, b) => b.timestamp.localeCompare(a.timestamp))

            if (prevBackups.length > 0 && prevBackups[0].hash !== entry.hash) {
                this.raiseAlarm({
                    nodeId,
                    severity: 'warning',
                    category: 'config_drift',
                    message: `Config drift detected on ${node.label} (${configType})`,
                    detail: `Previous hash: ${prevBackups[0].hash.slice(0, 12)}…, New hash: ${entry.hash.slice(0, 12)}…`,
                })
                this._emitEvent({ type: 'config_change', nodeId, timestamp: nowIso(),
                    detail: `${configType} config changed` })
            }

            // Keep max 20 backups per node per type
            const otherBackups = this.store.configBackups.filter(
                b => !(b.nodeId === nodeId && b.configType === configType),
            )
            const thisTypeBackups = [entry, ...prevBackups].slice(0, 20)
            this._patchStore({ configBackups: [...otherBackups, ...thisTypeBackups] })

            return entry
        } catch {
            return null
        }
    }

    async backupAllConfigs (trigger: 'manual' | 'scheduled'): Promise<number> {
        const nodes = this.topoSvc.topology.nodes.filter(n => {
            const host = (n.mgmtIp ?? '').split('/')[0].trim()
            return host && (n.sshUsername ?? '').trim() && (n.sshPassword ?? '')
        })
        let count = 0
        for (const node of nodes) {
            const result = await this.backupConfig(node.id, 'running', trigger)
            if (result) { count++ }
        }
        return count
    }

    getBackupsForNode (nodeId: string): ConfigBackupEntry[] {
        return this.store.configBackups
            .filter(b => b.nodeId === nodeId)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    }

    diffConfigs (a: ConfigBackupEntry, b: ConfigBackupEntry): string {
        const linesA = a.content.split('\n')
        const linesB = b.content.split('\n')
        const diff: string[] = []
        const maxLen = Math.max(linesA.length, linesB.length)
        for (let i = 0; i < maxLen; i++) {
            const la = linesA[i] ?? ''
            const lb = linesB[i] ?? ''
            if (la !== lb) {
                if (la) { diff.push(`- ${la}`) }
                if (lb) { diff.push(`+ ${lb}`) }
            }
        }
        return diff.join('\n') || '(no differences)'
    }

    async exportBackup (entry: ConfigBackupEntry): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.inventoryExportConfig) { return }
        const node = this.topoSvc.getNode(entry.nodeId)
        const name = `${(node?.label ?? 'device').replace(/\s+/g, '_')}_${entry.configType}_${entry.timestamp.replace(/[:.]/g, '-')}.cfg`
        await api.inventoryExportConfig(entry.content, name)
    }

    // ── Scheduled Config Backups ──────────────────────────────────────────────

    startScheduledBackups (intervalMs: number = 3600000): void {
        this.stopScheduledBackups()
        this._backupTimer = setInterval(() => {
            this.backupAllConfigs('scheduled')
        }, intervalMs)
        // Run an initial backup immediately
        this.backupAllConfigs('scheduled')
    }

    stopScheduledBackups (): void {
        if (this._backupTimer != null) {
            clearInterval(this._backupTimer)
            this._backupTimer = null
        }
    }

    get scheduledBackupsActive (): boolean {
        return this._backupTimer != null
    }

    /**
     * Load (restore) a backed-up config onto the device via an interactive SSH shell session.
     * Sends vendor-specific preamble → config lines → postamble.
     */
    async loadConfig (nodeId: string, backupId: string): Promise<{ ok: boolean; output: string }> {
        const node = this.topoSvc.getNode(nodeId)
        if (!node) { return { ok: false, output: 'Node not found' } }

        const api = (window as any).netopsAPI
        if (!api?.sshShellSession) { return { ok: false, output: 'SSH shell session not available' } }

        const entry = this.store.configBackups.find(b => b.id === backupId)
        if (!entry) { return { ok: false, output: 'Backup entry not found' } }

        const host = (node.mgmtIp ?? '').split('/')[0].trim()
        const username = (node.sshUsername ?? '').trim()
        const password = node.sshPassword ?? ''
        if (!host || !username || !password) {
            return { ok: false, output: 'Missing SSH credentials' }
        }

        const vendorKey = (node.vendor ?? '').trim().toLowerCase()
        if (!vendorKey) {
            return { ok: false, output: 'Cannot load config — device vendor is not set. Set the vendor in node properties first.' }
        }

        const cmds = getVendorCommands(vendorKey)
        const preamble = cmds.loadConfigPreamble ?? ['configure terminal']
        const postamble = cmds.loadConfigPostamble ?? ['end', 'write memory']

        // Split config content into individual lines, filtering out empty lines
        // and common show-output headers (lines like "Building configuration..."
        // or "Current configuration : N bytes" that appear in Cisco output)
        const configLines = entry.content
            .split('\n')
            .map(l => l.trimEnd())
            .filter(l => l.length > 0)
            .filter(l => !/^Building configuration/i.test(l))
            .filter(l => !/^Current configuration\s*:/i.test(l))
            .filter(l => !/^Last configuration change/i.test(l))

        if (configLines.length === 0) {
            return { ok: false, output: 'No config lines to load (config is empty or all lines were filtered)' }
        }

        const commands = [...preamble, ...configLines, ...postamble]

        try {
            const result = await api.sshShellSession({
                host,
                port: node.sshPort ?? 22,
                username,
                password,
                timeoutMs: 60000,
                commands,
                delayMs: 300,
            })

            this._emitEvent({
                type: 'config_change',
                nodeId,
                timestamp: nowIso(),
                detail: `Config loaded from backup ${entry.configType} (${entry.timestamp})`,
            })

            return { ok: result.ok, output: result.output ?? result.message }
        } catch (err) {
            return { ok: false, output: (err as Error).message }
        }
    }

    // ── Alarm Detection ──────────────────────────────────────────────────────

    private _checkAlarms (
        nodeId: string, node: TopologyNode,
        _version: ParsedVersion,
        resources: ParsedResourceUsage,
        interfaces: ParsedInterfaceStatus[],
        vendorAlarms: ParsedAlarmEntry[] = [],
    ): void {
        // CPU check
        if (resources.cpuPercent != null && resources.cpuPercent > 80) {
            this.raiseAlarm({
                nodeId,
                severity: resources.cpuPercent > 95 ? 'critical' : 'major',
                category: 'high_cpu',
                message: `High CPU on ${node.label}: ${resources.cpuPercent}%`,
                detail: `CPU utilization at ${resources.cpuPercent}%`,
            })
        } else {
            this._autoClearAlarm(nodeId, 'high_cpu')
        }

        // Memory check
        if (resources.memoryUsedPercent != null && resources.memoryUsedPercent > 85) {
            this.raiseAlarm({
                nodeId,
                severity: resources.memoryUsedPercent > 95 ? 'critical' : 'major',
                category: 'high_memory',
                message: `High memory on ${node.label}: ${resources.memoryUsedPercent}%`,
                detail: `Memory utilization at ${resources.memoryUsedPercent}%`,
            })
        } else {
            this._autoClearAlarm(nodeId, 'high_memory')
        }

        // Interface down check — only alarm on interfaces that map to topology ports.
        // Network devices (especially Juniper) report many internal pseudo-interfaces
        // (dsc, gre, ipip, lsi, mtun, tap, etc.) that are normally down on a healthy device.
        // We only care about interfaces the user actually mapped in their topology.
        const downMappedInterfaces = interfaces.filter(i => {
            if (i.status !== 'down') { return false }
            return node.ports.some(p => interfaceNamesMatch(i.name, p.label))
        })
        if (downMappedInterfaces.length > 0) {
            this.raiseAlarm({
                nodeId,
                severity: 'warning',
                category: 'interface_down',
                message: `${downMappedInterfaces.length} interface(s) down on ${node.label}`,
                detail: downMappedInterfaces.map(i => i.name).join(', '),
            })
        } else {
            this._autoClearAlarm(nodeId, 'interface_down')
        }

        // Vendor-reported alarms (Juniper, Huawei, etc.)
        if (vendorAlarms.length > 0) {
            const worst = vendorAlarms.reduce((w, a) => {
                const rank = { critical: 4, major: 3, minor: 2, warning: 1 } as Record<string, number>
                return (rank[a.severity] ?? 0) > (rank[w.severity] ?? 0) ? a : w
            }, vendorAlarms[0])
            this.raiseAlarm({
                nodeId,
                severity: worst.severity,
                category: 'vendor_alarm',
                message: `${vendorAlarms.length} vendor alarm(s) on ${node.label}`,
                detail: vendorAlarms.map(a => `[${a.severity}] ${a.message}`).join('\n'),
            })
        } else {
            this._autoClearAlarm(nodeId, 'vendor_alarm')
        }
    }

    raiseAlarm (alarm: Omit<DeviceAlarm, 'id' | 'raisedAt' | 'acknowledged'>): void {
        // Check if a similar active alarm already exists.
        // For 'custom' category, also match on message so multiple command_check
        // rules on the same node each get their own alarm entry.
        const existing = this.store.alarms.find(a =>
            !a.clearedAt && a.nodeId === alarm.nodeId && a.category === alarm.category
            && (alarm.category !== 'custom' || a.message === alarm.message),
        )
        if (existing) {
            // Update severity/message if it changed
            if (existing.severity !== alarm.severity || existing.message !== alarm.message) {
                const alarms = this.store.alarms.map(a =>
                    a.id === existing.id
                        ? { ...a, severity: alarm.severity, message: alarm.message, detail: alarm.detail }
                        : a,
                )
                this._patchStore({ alarms })
            }
            return
        }

        const newAlarm: DeviceAlarm = {
            ...alarm,
            id: uuid(),
            raisedAt: nowIso(),
            acknowledged: false,
        }
        this._patchStore({ alarms: [...this.store.alarms, newAlarm] })
        this._emitEvent({ type: 'alarm_raised', nodeId: alarm.nodeId, timestamp: nowIso(),
            detail: `${alarm.severity}: ${alarm.message}` })
    }

    clearAlarm (alarmId: string): void {
        const alarm = this.store.alarms.find(a => a.id === alarmId)
        if (!alarm || alarm.clearedAt) { return }
        const alarms = this.store.alarms.map(a =>
            a.id === alarmId ? { ...a, clearedAt: nowIso() } : a,
        )
        this._patchStore({ alarms })
        this._emitEvent({ type: 'alarm_cleared', nodeId: alarm.nodeId, timestamp: nowIso(),
            detail: alarm.message })
    }

    acknowledgeAlarm (alarmId: string): void {
        const alarms = this.store.alarms.map(a =>
            a.id === alarmId ? { ...a, acknowledged: true } : a,
        )
        this._patchStore({ alarms })
    }

    private _autoClearAlarm (nodeId: string, category: AlarmCategory, messageContains?: string): void {
        const active = this.store.alarms.find(a =>
            !a.clearedAt && a.nodeId === nodeId && a.category === category
            && (!messageContains || a.message.includes(messageContains)),
        )
        if (active) { this.clearAlarm(active.id) }
    }

    getAlarmsForNode (nodeId: string): DeviceAlarm[] {
        return this.store.alarms.filter(a => a.nodeId === nodeId && !a.clearedAt)
    }

    nodeHasAlarm (nodeId: string): boolean {
        return this.store.alarms.some(a => a.nodeId === nodeId && !a.clearedAt)
    }

    nodeAlarmSeverity (nodeId: string): AlarmSeverity | null {
        const alarms = this.getAlarmsForNode(nodeId)
        if (!alarms.length) { return null }
        const severityOrder: AlarmSeverity[] = ['critical', 'major', 'minor', 'warning', 'info']
        for (const sev of severityOrder) {
            if (alarms.some(a => a.severity === sev)) { return sev }
        }
        return 'info'
    }

    // ── Upgrade Tracking ─────────────────────────────────────────────────────

    createUpgradePlan (nodeId: string, currentVersion: string, targetVersion: string): FirmwareUpgradePlan {
        const plan: FirmwareUpgradePlan = {
            id: uuid(),
            nodeId,
            currentVersion,
            targetVersion,
            stage: 'planned',
            createdAt: nowIso(),
            updatedAt: nowIso(),
        }
        this._patchStore({ upgradePlans: [...this.store.upgradePlans, plan] })
        return plan
    }

    updateUpgradeStage (planId: string, stage: UpgradeStage, notes?: string): void {
        const plans = this.store.upgradePlans.map(p =>
            p.id === planId ? { ...p, stage, updatedAt: nowIso(), notes: notes ?? p.notes } : p,
        )
        this._patchStore({ upgradePlans: plans })
    }

    getUpgradePlansForNode (nodeId: string): FirmwareUpgradePlan[] {
        return this.store.upgradePlans.filter(p => p.nodeId === nodeId)
    }

    async runPreCheck (planId: string): Promise<void> {
        const plan = this.store.upgradePlans.find(p => p.id === planId)
        if (!plan) { return }
        const node = this.topoSvc.getNode(plan.nodeId)
        if (!node) { return }

        const api = (window as any).netopsAPI
        if (!api?.sshRunCommand) { return }

        const host = (node.mgmtIp ?? '').split('/')[0].trim()
        const cmds = getVendorCommands(node.vendor ?? '')
        try {
            const result = await api.sshRunCommand({
                host, port: node.sshPort ?? 22,
                username: (node.sshUsername ?? '').trim(),
                password: node.sshPassword ?? '',
                timeoutMs: 15000,
                command: cmds.showVersion,
            })
            const plans = this.store.upgradePlans.map(p =>
                p.id === planId
                    ? { ...p, preCheckOutput: result.output ?? result.message, updatedAt: nowIso() }
                    : p,
            )
            this._patchStore({ upgradePlans: plans })
        } catch { /* ignore */ }
    }

    async runPostCheck (planId: string): Promise<void> {
        const plan = this.store.upgradePlans.find(p => p.id === planId)
        if (!plan) { return }
        const node = this.topoSvc.getNode(plan.nodeId)
        if (!node) { return }

        const api = (window as any).netopsAPI
        if (!api?.sshRunCommand) { return }

        const host = (node.mgmtIp ?? '').split('/')[0].trim()
        const cmds = getVendorCommands(node.vendor ?? '')
        try {
            const result = await api.sshRunCommand({
                host, port: node.sshPort ?? 22,
                username: (node.sshUsername ?? '').trim(),
                password: node.sshPassword ?? '',
                timeoutMs: 15000,
                command: cmds.showVersion,
            })
            const output = result.output ?? ''
            const parsed = parseShowVersion(node.vendor ?? '', output)
            const newVersion = parsed.osVersion ?? ''
            const stage: UpgradeStage = newVersion === plan.targetVersion ? 'completed' : 'failed'
            const plans = this.store.upgradePlans.map(p =>
                p.id === planId
                    ? { ...p, postCheckOutput: output, stage, updatedAt: nowIso() }
                    : p,
            )
            this._patchStore({ upgradePlans: plans })
        } catch { /* ignore */ }
    }

    removeUpgradePlan (planId: string): void {
        this._patchStore({
            upgradePlans: this.store.upgradePlans.filter(p => p.id !== planId),
        })
    }

    // ── Event Rules ──────────────────────────────────────────────────────────

    addEventRule (rule: Omit<EventRule, 'id' | 'createdAt'>): EventRule {
        const newRule: EventRule = {
            ...rule,
            id: uuid(),
            createdAt: nowIso(),
        }
        this._patchStore({ eventRules: [...this.store.eventRules, newRule] })
        return newRule
    }

    updateEventRule (id: string, changes: Partial<EventRule>): void {
        const rules = this.store.eventRules.map(r =>
            r.id === id ? { ...r, ...changes } : r,
        )
        this._patchStore({ eventRules: rules })
    }

    removeEventRule (id: string): void {
        this._patchStore({
            eventRules: this.store.eventRules.filter(r => r.id !== id),
        })
    }

    // ── Event System ─────────────────────────────────────────────────────────

    private _emitEvent (event: InventoryEvent): void {
        // Append to event log (keep last 500)
        const log = [...this.store.eventLog, event].slice(-500)
        this._patchStore({ eventLog: log })

        this._events$.next(event)
        this._eventQueue.push(event)
        this._processEventQueue()
    }

    private async _processEventQueue (): Promise<void> {
        if (this._processingEvent) { return }
        this._processingEvent = true

        while (this._eventQueue.length > 0) {
            const event = this._eventQueue.shift()!
            await this._evaluateRules(event)
        }

        this._processingEvent = false
    }

    private async _evaluateRules (event: InventoryEvent): Promise<void> {
        const node = this.topoSvc.getNode(event.nodeId)
        if (!node) { return }

        for (const rule of this.store.eventRules) {
            if (!rule.enabled) { continue }
            if (rule.trigger !== event.type) { continue }
            if (!globMatch(rule.nodeFilter ?? '*', node.label)) { continue }
            if (!globMatch(rule.vendorFilter ?? '*', node.vendor ?? '')) { continue }

            try {
                await this._executeAction(rule, event, node)
            } catch {
                // Action failures are logged but don't block
            }
        }
    }

    private async _executeAction (rule: EventRule, event: InventoryEvent, node: TopologyNode): Promise<void> {
        switch (rule.action) {
            case 'notify':
                this.raiseAlarm({
                    nodeId: event.nodeId,
                    severity: 'info',
                    category: 'custom',
                    message: rule.actionConfig.message ?? `Event rule "${rule.name}" triggered`,
                    detail: event.detail,
                })
                break

            case 'backup_config':
                await this.backupConfig(event.nodeId, 'running', 'event')
                break

            case 'run_command': {
                const cmd = rule.actionConfig.command
                if (!cmd) { break }
                const api = (window as any).netopsAPI
                if (!api?.sshRunCommand) { break }
                const host = (node.mgmtIp ?? '').split('/')[0].trim()
                if (!host || !node.sshUsername || !node.sshPassword) { break }
                await api.sshRunCommand({
                    host, port: node.sshPort ?? 22,
                    username: node.sshUsername.trim(),
                    password: node.sshPassword,
                    timeoutMs: 15000,
                    command: cmd,
                })
                break
            }

            case 'webhook': {
                const url = rule.actionConfig?.webhookUrl
                if (url) {
                    fetch(url, {
                        method: rule.actionConfig?.webhookMethod || 'POST',
                        headers: { 'Content-Type': 'application/json', ...(rule.actionConfig?.webhookHeaders || {}) },
                        body: JSON.stringify({ event, rule: { id: rule.id, name: rule.name }, timestamp: new Date().toISOString() }),
                    }).catch(() => {})
                }
                break
            }

            case 'log':
                // Already logged in event log by _emitEvent
                break
        }
    }

    // ── Command-Check Rules ────────────────────────────────────────────────

    /**
     * After each device poll, run all enabled `command_check` rules that match
     * this node.  For each rule:
     *   1. SSH into the device and execute `actionConfig.checkCommand`
     *   2. Match the output against `actionConfig.checkPattern` (regex)
     *   3. If matched → emit event + execute the rule's action
     *   4. If not matched → auto-clear any previous alarm from this rule
     */
    private async _runCommandChecks (nodeId: string, node: TopologyNode): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.sshRunCommand) { return }

        const host = (node.mgmtIp ?? '').split('/')[0].trim()
        if (!host || !node.sshUsername || !node.sshPassword) { return }

        const rules = this.store.eventRules.filter(r =>
            r.enabled
            && r.trigger === 'command_check'
            && r.actionConfig.checkCommand
            && r.actionConfig.checkPattern
            && globMatch(r.nodeFilter ?? '*', node.label)
            && globMatch(r.vendorFilter ?? '*', node.vendor ?? ''),
        )
        if (rules.length === 0) { return }

        for (const rule of rules) {
            try {
                const result = await api.sshRunCommand({
                    host, port: node.sshPort ?? 22,
                    username: node.sshUsername.trim(),
                    password: node.sshPassword,
                    timeoutMs: 15000,
                    command: rule.actionConfig.checkCommand!,
                })

                const output: string = result.ok ? (result.output ?? '') : ''
                let matched = false
                try {
                    const re = new RegExp(rule.actionConfig.checkPattern!, 'im')
                    matched = re.test(output)
                } catch {
                    // Invalid regex — treat as literal substring match
                    matched = output.includes(rule.actionConfig.checkPattern!)
                }

                if (matched) {
                    // Extract the matching line(s) for detail
                    let matchDetail = ''
                    try {
                        const re = new RegExp(rule.actionConfig.checkPattern!, 'im')
                        const lines = output.split('\n')
                        const hits = lines.filter(l => re.test(l))
                        matchDetail = hits.slice(0, 10).join('\n')
                    } catch { matchDetail = '' }

                    const event: InventoryEvent = {
                        type: 'command_check',
                        nodeId,
                        timestamp: nowIso(),
                        detail: `Rule "${rule.name}" matched on ${node.label}:\n${matchDetail || '(pattern matched)'}`,
                    }
                    this._emitEvent(event)

                    // For 'notify' action, raise alarm with stable message for dedup/auto-clear.
                    // Other actions go through the normal _executeAction pipeline.
                    if (rule.action === 'notify') {
                        this.raiseAlarm({
                            nodeId,
                            severity: 'warning',
                            category: 'custom',
                            message: `[Check] ${rule.name}`,
                            detail: rule.actionConfig.message
                                ? `${rule.actionConfig.message}\n${matchDetail}`
                                : matchDetail || '(pattern matched)',
                        })
                    } else {
                        await this._executeAction(rule, event, node)
                    }
                } else {
                    // Auto-clear: if this rule previously raised a notify alarm, clear it
                    this._autoClearAlarm(nodeId, 'custom', `[Check] ${rule.name}`)
                }
            } catch {
                // SSH failure for this rule — skip silently
            }
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    /** Import an InventoryStore directly (no file I/O). Used by workspace load. */
    importStore (store: InventoryStore): void {
        this._store$.next(store)
    }

    async save (filePath: string): Promise<boolean> {
        const api = (window as any).netopsAPI
        if (!api?.inventorySave) { return false }
        const json = JSON.stringify(this.store, null, 2)
        const result = await api.inventorySave(json, filePath)
        return result.ok
    }

    async load (filePath: string): Promise<boolean> {
        const api = (window as any).netopsAPI
        if (!api?.inventoryLoad) {
            console.warn('[inventory] load: no inventoryLoad API available')
            return false
        }
        try {
            const result = await api.inventoryLoad(filePath)
            if (!result.ok || !result.json) {
                console.log(`[inventory] load: file not found or empty — ${filePath}`, result.message ?? '')
                return false
            }
            const parsed = JSON.parse(result.json) as InventoryStore
            if (parsed.version !== 1) {
                console.warn(`[inventory] load: version mismatch (got ${(parsed as any).version}) — ${filePath}`)
                return false
            }
            this._store$.next(parsed)
            console.log(`[inventory] load: success — ${filePath}`)
            return true
        } catch (err) {
            console.error('[inventory] load: parse error —', filePath, err)
            return false
        }
    }

    // ── Export / Reporting ──────────────────────────────────────────────────

    exportInventoryReport (): string {
        const nodes = this.topoSvc.topology.nodes
        const report = nodes.map(n => {
            const dv = this.store.deviceVersions[n.id]
            const ifaces = this.store.deviceInterfaces[n.id] ?? []
            const alarms = this.store.alarms.filter(a => a.nodeId === n.id && !a.clearedAt)
            const backups = this.store.configBackups.filter(b => b.nodeId === n.id).length
            return {
                nodeId: n.id,
                label: n.label,
                type: n.type,
                vendor: n.vendor ?? '',
                model: n.model ?? '',
                mgmtIp: n.mgmtIp ?? '',
                osVersion: dv?.osVersion ?? '',
                firmwareVersion: dv?.firmwareVersion ?? '',
                hardwareModel: dv?.hardwareModel ?? '',
                uptime: dv?.uptime ?? '',
                lastPolled: dv?.lastPolled ?? '',
                interfaceCount: ifaces.length,
                interfacesUp: ifaces.filter(i => i.status === 'up').length,
                interfacesDown: ifaces.filter(i => i.status === 'down').length,
                activeAlarms: alarms.length,
                configBackups: backups,
            }
        })
        return JSON.stringify({ exportedAt: new Date().toISOString(), devices: report }, null, 2)
    }

    exportAlarmHistory (): string {
        const lines = ['severity,category,node,message,raisedAt,clearedAt,acknowledged']
        for (const a of this.store.alarms) {
            const node = this.topoSvc.getNode(a.nodeId)
            const label = (node?.label ?? a.nodeId).replace(/,/g, ';')
            const msg = a.message.replace(/,/g, ';')
            lines.push(`${a.severity},${a.category},${label},${msg},${a.raisedAt},${a.clearedAt ?? ''},${a.acknowledged}`)
        }
        return lines.join('\n')
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    private _emptyStore (): InventoryStore {
        return {
            version: 1,
            topologyId: '',
            deviceVersions: {},
            deviceInterfaces: {},
            configBackups: [],
            alarms: [],
            upgradePlans: [],
            eventRules: [],
            eventLog: [],
            pollIntervalMs: 300000,  // 5 min
        }
    }

    private _patchStore (partial: Partial<InventoryStore>): void {
        this._store$.next({ ...this.store, ...partial })
        this._scheduleAutoSave()
    }

    /** Debounce auto-save: writes sidecar to disk after store changes settle. */
    private _scheduleAutoSave (): void {
        if (!this._sidecarPath) { return }
        this._cancelAutoSave()
        this._autoSaveTimer = setTimeout(() => {
            this._autoSaveTimer = null
            this.save(this._sidecarPath!).catch(err => {
                console.warn('[inventory] auto-save failed:', err)
            })
        }, this._autoSaveDebounceMs)
    }

    private _cancelAutoSave (): void {
        if (this._autoSaveTimer) {
            clearTimeout(this._autoSaveTimer)
            this._autoSaveTimer = null
        }
    }

    private _updateDeviceVersion (nodeId: string, version: Partial<DeviceVersion>): void {
        const existing = this.store.deviceVersions[nodeId] ?? {}
        this._patchStore({
            deviceVersions: {
                ...this.store.deviceVersions,
                [nodeId]: { ...existing, ...version },
            },
        })
    }

    getDeviceVersion (nodeId: string): DeviceVersion | undefined {
        return this.store.deviceVersions[nodeId]
    }

    getDeviceInterfaces (nodeId: string): PollInterfaceEntry[] {
        return this.store.deviceInterfaces[nodeId] ?? []
    }

    // ── Poll Sync Proposals ──────────────────────────────────────────────

    /**
     * Compare polled data (DeviceVersion + interfaces) against the current
     * TopologyNode and produce a PollSyncProposal describing what changed.
     * Returns null when there is nothing to report.
     */
    buildSyncProposal (nodeId: string): PollSyncProposal | null {
        const node = this.topoSvc.getNode(nodeId)
        if (!node) { return null }

        const version = this.store.deviceVersions[nodeId]
        const interfaces = this.store.deviceInterfaces[nodeId] ?? []

        // ── Info fields (read-only, always shown if available) ───────────
        const infoFields: { label: string; value: string }[] = []
        if (version?.osVersion) { infoFields.push({ label: 'OS Version', value: version.osVersion }) }
        if (version?.firmwareVersion) { infoFields.push({ label: 'Firmware', value: version.firmwareVersion }) }
        if (version?.hardwareRevision) { infoFields.push({ label: 'Hardware Rev', value: version.hardwareRevision }) }
        if (version?.uptime) { infoFields.push({ label: 'Uptime', value: version.uptime }) }

        // ── Model change ─────────────────────────────────────────────────
        let modelChange: { from: string; to: string } | undefined
        const polledModel = (version?.hardwareModel ?? '').trim()
        const currentModel = (node.model ?? '').trim()
        if (polledModel && polledModel.toLowerCase() !== currentModel.toLowerCase()) {
            modelChange = { from: currentModel || '(none)', to: polledModel }
        }

        // ── Port status changes ──────────────────────────────────────────
        const portChanges: PollSyncPortChange[] = []
        for (const iface of interfaces) {
            // Match polled interface name against topology port labels using
            // exact normalised comparison (avoids substring false-positives
            // like et-0/0/1 matching et-0/0/10).
            const port = node.ports.find(p => interfaceNamesMatch(iface.name, p.label))
            if (!port) { continue }

            const polledEnabled = iface.status === 'up'
            if (port.enabled !== polledEnabled) {
                portChanges.push({
                    portId: port.id,
                    portLabel: port.label,
                    field: 'enabled',
                    from: port.enabled ? 'enabled' : 'disabled',
                    to: polledEnabled ? 'enabled' : 'disabled',
                })
            }
        }

        // Return null if nothing to report at all
        if (!modelChange && portChanges.length === 0 && infoFields.length === 0) {
            return null
        }

        return { nodeId, nodeLabel: node.label, modelChange, portChanges, infoFields }
    }

    /**
     * Apply accepted changes from a PollSyncProposal to the topology.
     * @param proposal      The full proposal
     * @param acceptedKeys  Set of change keys the user checked.
     *                      Keys: 'model' for model change, 'port:<portId>' for port changes.
     *                      If undefined, apply ALL changes.
     */
    applySyncProposal (proposal: PollSyncProposal, acceptedKeys?: Set<string>): void {
        const applyAll = !acceptedKeys

        // Model change
        if (proposal.modelChange && (applyAll || acceptedKeys!.has('model'))) {
            this.topoSvc.updateNodeConfig(proposal.nodeId, { model: proposal.modelChange.to })
        }

        // Port changes
        for (const pc of proposal.portChanges) {
            if (applyAll || acceptedKeys!.has(`port:${pc.portId}`)) {
                const newEnabled = pc.to === 'enabled'
                this.topoSvc.updatePort(proposal.nodeId, pc.portId, { enabled: newEnabled })
            }
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    ngOnDestroy (): void {
        this.stopPolling()
        this.stopScheduledBackups()
        this._cancelAutoSave()
        // Flush any pending auto-save synchronously on destroy
        if (this._sidecarPath) {
            this.save(this._sidecarPath).catch(() => {})
        }
        for (const sub of this._subs) { sub.unsubscribe() }
        this._subs = []
    }
}
