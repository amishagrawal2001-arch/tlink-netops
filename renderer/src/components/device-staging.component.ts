import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, OnInit, Output,
} from '@angular/core'
import { TopologyService } from '../services/topology.service'
import { DeviceStagingConfig } from '../api/interfaces'
import {
    renderStagingConfig, isSupportedStagingVendor, mergeStaging,
} from '../services/vendor-staging-builder'

/**
 * Day-0 Staging dialog — captures fabric-wide foundational config
 * (NTP, SNMP, LLDP, Syslog, DNS, AAA users, banner) once. The values
 * are merged into every node's generated startup config.
 *
 * Per-node overrides: edit a node's properties (Config tab) — that path
 * sets node.startupConfig directly with configSource='manual', which the
 * regenerator skips, preserving manual overrides.
 */
@Component({
    selector: 'device-staging',
    templateUrl: './device-staging.component.pug',
    styleUrls: ['./device-staging.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeviceStagingComponent implements OnInit {
    @Output() closed = new EventEmitter<void>()
    /** Emitted after Save & Push — caller (canvas) opens the bulk push dialog. */
    @Output() pushRequested = new EventEmitter<void>()

    /** Tabbed view inside the dialog. */
    view: 'edit' | 'preview' = 'edit'

    /** Working copy — bound via [(ngModel)]; committed on Save. */
    staging: DeviceStagingConfig = {}

    /** Inputs that don't bind cleanly via ngModel because they're arrays. */
    ntpServersText = ''
    syslogServersText = ''
    dnsServersText = ''
    snmpTrapTargetsText = ''
    tacacsServersText = ''
    /** Local users — edited as a list with add/remove. */
    localUsers: Array<{ username: string; password: string; role: 'admin' | 'read-only' | 'operator' }> = []

    constructor (
        private cdr: ChangeDetectorRef,
        private topoSvc: TopologyService,
    ) {}

    ngOnInit (): void {
        const existing = this.topoSvc.topology.staging
        if (existing) {
            // Deep-clone so cancel discards changes.
            this.staging = JSON.parse(JSON.stringify(existing))
            this.ntpServersText      = (existing.ntp?.servers ?? []).join(', ')
            this.syslogServersText   = (existing.syslog?.servers ?? []).join(', ')
            this.dnsServersText      = (existing.dns?.servers ?? []).join(', ')
            this.snmpTrapTargetsText = (existing.snmp?.trapTargets ?? []).join(', ')
            this.tacacsServersText   = (existing.aaa?.tacacs?.servers ?? []).join(', ')
            this.localUsers = (existing.aaa?.localUsers ?? []).map(u => ({
                username: u.username,
                password: u.password ?? '',
                role: (u.role ?? 'admin') as 'admin' | 'read-only' | 'operator',
            }))
        }
        // Ensure nested keys exist so [(ngModel)] can bind without 'undefined' errors.
        this.staging.ntp    = this.staging.ntp    ?? {}
        this.staging.snmp   = this.staging.snmp   ?? { version: 'v2c' }
        this.staging.lldp   = this.staging.lldp   ?? { enabled: true }
        this.staging.syslog = this.staging.syslog ?? {}
        this.staging.dns    = this.staging.dns    ?? {}
        this.staging.aaa    = this.staging.aaa    ?? {}
        // Nested under aaa — bound by `staging.aaa.tacacs.sharedSecret` in the template.
        this.staging.aaa.tacacs = this.staging.aaa.tacacs ?? {}
        this.staging.banner = this.staging.banner ?? {}
        this.cdr.markForCheck()
    }

    close (): void { this.closed.emit() }

    addUser (): void {
        this.localUsers = [...this.localUsers, { username: '', password: '', role: 'admin' }]
        this.cdr.markForCheck()
    }
    removeUser (i: number): void {
        this.localUsers = this.localUsers.filter((_, idx) => idx !== i)
        this.cdr.markForCheck()
    }

    /** Parse a comma-or-newline-separated string into a clean array. */
    private _parseList (s: string): string[] {
        return (s || '').split(/[,\n]+/).map(x => x.trim()).filter(Boolean)
    }

    /** Returns true if the section has any meaningful field set. We drop a
     *  section only when EVERY user-editable field is empty/undefined — never
     *  because one specific "primary" field (e.g. servers list) is empty. */
    private _hasAny (obj: Record<string, any> | undefined | null): boolean {
        if (!obj) { return false }
        for (const v of Object.values(obj)) {
            if (v === undefined || v === null) { continue }
            if (typeof v === 'string' && v.trim() === '') { continue }
            if (Array.isArray(v) && v.length === 0) { continue }
            if (typeof v === 'object' && !Array.isArray(v)) {
                if (this._hasAny(v)) { return true }
                continue
            }
            return true
        }
        return false
    }

    /** Build the canonical DeviceStagingConfig from the live form fields.
     *  Used by both `save()` and the live preview pane.
     *
     *  Pruning rule: keep a section if ANY of its fields is set. Don't drop
     *  the whole NTP block just because the server list is empty — that would
     *  silently lose timezone/prefer settings on save. */
    private _buildFinalStaging (): DeviceStagingConfig {
        // Translate text-buffer arrays back into clean string[].
        const ntpServers    = this._parseList(this.ntpServersText)
        const sysServers    = this._parseList(this.syslogServersText)
        const dnsServers    = this._parseList(this.dnsServersText)
        const trapTargets   = this._parseList(this.snmpTrapTargetsText)
        const tacacsServers = this._parseList(this.tacacsServersText)

        // ── NTP ────────────────────────────────────────────────────────────
        const ntp: any = { ...(this.staging.ntp ?? {}) }
        ntp.servers = ntpServers.length ? ntpServers : undefined
        const ntpFinal = this._hasAny(ntp) ? ntp : undefined

        // ── SNMP ───────────────────────────────────────────────────────────
        const snmp: any = { ...(this.staging.snmp ?? {}) }
        snmp.trapTargets = trapTargets.length ? trapTargets : undefined
        // Treat lone version='v2c' (the default) as "not configured" so we
        // don't persist an empty SNMP block when the user never touched the form.
        const snmpKeys = Object.keys(snmp).filter(k => snmp[k] !== undefined && snmp[k] !== '')
        const snmpFinal = (snmpKeys.length === 1 && snmpKeys[0] === 'version') ? undefined
                        : (this._hasAny(snmp) ? snmp : undefined)

        // ── LLDP ───────────────────────────────────────────────────────────
        // Always persist — boolean false is meaningful (explicitly disabled).
        const lldpFinal = this.staging.lldp

        // ── Syslog ─────────────────────────────────────────────────────────
        const syslog: any = { ...(this.staging.syslog ?? {}) }
        syslog.servers = sysServers.length ? sysServers : undefined
        const syslogFinal = this._hasAny(syslog) ? syslog : undefined

        // ── DNS ────────────────────────────────────────────────────────────
        const dns: any = { ...(this.staging.dns ?? {}) }
        dns.servers = dnsServers.length ? dnsServers : undefined
        const dnsFinal = this._hasAny(dns) ? dns : undefined

        // ── AAA ────────────────────────────────────────────────────────────
        const validUsers = this.localUsers.filter(u => u.username && u.username.trim())
        const tacacsBlock: any = {
            ...(this.staging.aaa?.tacacs ?? {}),
            servers: tacacsServers.length ? tacacsServers : undefined,
        }
        const tacacsFinal = this._hasAny(tacacsBlock) ? tacacsBlock : undefined
        const aaa: any = {}
        if (validUsers.length) { aaa.localUsers = validUsers }
        if (tacacsFinal)       { aaa.tacacs = tacacsFinal }
        const aaaFinal = this._hasAny(aaa) ? aaa : undefined

        // ── Banner ─────────────────────────────────────────────────────────
        const banner: any = { ...(this.staging.banner ?? {}) }
        const bannerFinal = this._hasAny(banner) ? banner : undefined

        return {
            ntp:    ntpFinal,
            snmp:   snmpFinal,
            lldp:   lldpFinal,
            syslog: syslogFinal,
            dns:    dnsFinal,
            aaa:    aaaFinal,
            banner: bannerFinal,
        }
    }

    save (): void {
        const final = this._buildFinalStaging()
        console.log('[device-staging] save:', final)
        this.topoSvc.setStaging(final)
        this.close()
    }

    /** Persist staging, then ask the parent canvas to open the bulk push
     *  dialog. The canvas listens via `(pushRequested)`. */
    saveAndPush (): void {
        const final = this._buildFinalStaging()
        console.log('[device-staging] save & push:', final)
        this.topoSvc.setStaging(final)
        this.pushRequested.emit()
        this.close()
    }

    // ── Preview pane ─────────────────────────────────────────────────────────

    /** Topology vendor breakdown for the Preview tab.
     *  Shows: { vendor, nodeCount, supported, sampleLabels } per unique vendor. */
    get vendorBreakdown (): Array<{
        vendor: string
        nodeCount: number
        supported: boolean
        sampleLabels: string[]
    }> {
        const map = new Map<string, { count: number; labels: string[] }>()
        for (const n of this.topoSvc.topology.nodes) {
            if (n.type === 'host' || n.type === 'bridge') { continue }
            const v = (n.vendor || '').toLowerCase().trim() || '(unset)'
            const entry = map.get(v) ?? { count: 0, labels: [] }
            entry.count++
            if (entry.labels.length < 3) { entry.labels.push(n.label) }
            map.set(v, entry)
        }
        return Array.from(map.entries())
            .map(([vendor, e]) => ({
                vendor,
                nodeCount: e.count,
                supported: vendor !== '(unset)' && isSupportedStagingVendor(vendor),
                sampleLabels: e.labels,
            }))
            .sort((a, b) => b.nodeCount - a.nodeCount)
    }

    /** Render the merged Day-0 block for one vendor using the live form values.
     *  Picks an example node of that vendor (so per-node overrides on that
     *  example surface in the preview). Returns "" when nothing to render. */
    renderForVendor (vendor: string): string {
        if (!isSupportedStagingVendor(vendor)) {
            return `# Vendor '${vendor}' is not yet supported by the staging builder.\n`
                + `# Supported: juniper, cisco, arista, hpe, dell, huawei, nokia, sonic, mikrotik, extreme.`
        }
        const fabric = this._buildFinalStaging()
        // Show fabric-only preview (no per-node merge) — per-node overrides
        // are previewed in the node properties Staging tab.
        const block = renderStagingConfig(vendor, fabric)
        return block.trim() || '# (no staging configured — fill in fields on the Edit tab)'
    }

    /** Quick-set the active tab. */
    setView (v: 'edit' | 'preview'): void {
        this.view = v
        this.cdr.markForCheck()
    }

    /** Lightweight helper for the template (`mergeStaging` etc. aren't directly
     *  callable from a pug expression without a reference). */
    hasAnyStaging (): boolean {
        const f = this._buildFinalStaging()
        return !!(f.ntp || f.snmp || f.syslog || f.dns || f.aaa || f.banner ||
                  (f.lldp && (f.lldp.enabled !== undefined || f.lldp.interfaces)))
    }
}
