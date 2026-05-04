import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component,
    EventEmitter, OnInit, Output,
} from '@angular/core'
import { ComplianceService, GoldenConfigRule } from '../services/compliance.service'

/**
 * Compliance Rules Editor — first-class CRUD UI for the golden-config rules
 * that drive `Compliance Check`. Each rule is a regex pattern that must match
 * (or not match — handled in the rule's pattern itself) against a device's
 * running/startup config.
 */
@Component({
    selector: 'compliance-rules-editor',
    templateUrl: './compliance-rules-editor.component.pug',
    styleUrls: ['./compliance-rules-editor.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComplianceRulesEditorComponent implements OnInit {
    @Output() closed = new EventEmitter<void>()

    rules: GoldenConfigRule[] = []
    /** Filter typed in the search box (matches name / description / pattern). */
    filter = ''
    vendorFilter = ''      // '' = all
    severityFilter = ''    // '' = all

    /** Currently-edited rule (or null = list view). 'new' = adding. */
    editing: GoldenConfigRule | null = null
    isNew = false

    /** Form-bound draft for the rule being edited. */
    draft: GoldenConfigRule = this._blankRule()
    /** Validation messages for the form. */
    formErrors: string[] = []

    /** Quick-test panel — paste sample config and see whether the draft
     *  rule's regex matches it. */
    testText = ''
    testResult: { matched: boolean; preview: string } | null = null

    constructor (
        private svc: ComplianceService,
        private cdr: ChangeDetectorRef,
    ) {}

    async ngOnInit (): Promise<void> {
        await this.svc.loadRules()
        this.rules = [...this.svc.rules]
        this.cdr.markForCheck()
    }

    close (): void { this.closed.emit() }

    private _blankRule (): GoldenConfigRule {
        return {
            id: '',
            name: '',
            vendor: '*',
            role: '',
            pattern: '',
            severity: 'warning',
            description: '',
            enabled: true,
        }
    }

    get filteredRules (): GoldenConfigRule[] {
        const q = this.filter.toLowerCase().trim()
        return this.rules.filter(r => {
            if (this.vendorFilter && r.vendor !== this.vendorFilter)       { return false }
            if (this.severityFilter && r.severity !== this.severityFilter) { return false }
            if (!q) { return true }
            return (
                r.name.toLowerCase().includes(q) ||
                r.description.toLowerCase().includes(q) ||
                r.pattern.toLowerCase().includes(q)
            )
        })
    }

    /** Distinct vendor strings from rules — drives the filter dropdown. */
    get vendorOptions (): string[] {
        const set = new Set<string>()
        for (const r of this.rules) { set.add(r.vendor) }
        return Array.from(set).sort()
    }

    startNew (): void {
        this.draft = this._blankRule()
        this.isNew = true
        this.editing = this.draft
        this.formErrors = []
        this.testText = ''
        this.testResult = null
        this.cdr.markForCheck()
    }

    startEdit (r: GoldenConfigRule): void {
        // Deep-clone so cancel discards changes.
        this.draft = JSON.parse(JSON.stringify(r))
        this.isNew = false
        this.editing = r
        this.formErrors = []
        this.testText = ''
        this.testResult = null
        this.cdr.markForCheck()
    }

    cancelEdit (): void {
        this.editing = null
        this.isNew = false
        this.formErrors = []
        this.cdr.markForCheck()
    }

    /** Validate the draft and either add or update via the service. */
    save (): void {
        const errs: string[] = []
        const d = this.draft
        if (!d.name?.trim())     { errs.push('Name is required.') }
        if (!d.vendor?.trim())   { errs.push('Vendor is required (use * for all).') }
        if (!d.pattern?.trim())  { errs.push('Pattern is required.') }
        // Validate regex syntax up-front — better than a runtime crash later.
        try { new RegExp(d.pattern, 'm') }
        catch (e: any) { errs.push(`Invalid regex: ${e.message}`) }
        if (errs.length) { this.formErrors = errs; this.cdr.markForCheck(); return }

        if (this.isNew) {
            this.svc.addRule({
                name:        d.name.trim(),
                vendor:      d.vendor.trim(),
                role:        d.role?.trim() || undefined,
                pattern:     d.pattern,
                severity:    d.severity,
                description: d.description?.trim() || '',
                enabled:     d.enabled !== false,
            })
        } else if (this.editing) {
            this.svc.updateRule(this.editing.id, {
                name:        d.name.trim(),
                vendor:      d.vendor.trim(),
                role:        d.role?.trim() || undefined,
                pattern:     d.pattern,
                severity:    d.severity,
                description: d.description?.trim() || '',
                enabled:     d.enabled !== false,
            })
        }
        this.rules = [...this.svc.rules]
        this.editing = null
        this.isNew = false
        this.formErrors = []
        this.cdr.markForCheck()
    }

    deleteRule (r: GoldenConfigRule): void {
        if (!confirm(`Delete rule "${r.name}"? This cannot be undone.`)) { return }
        this.svc.removeRule(r.id)
        this.rules = [...this.svc.rules]
        if (this.editing?.id === r.id) { this.editing = null }
        this.cdr.markForCheck()
    }

    toggleEnabled (r: GoldenConfigRule): void {
        this.svc.toggleRule(r.id)
        this.rules = [...this.svc.rules]
        this.cdr.markForCheck()
    }

    /** Run the draft pattern against the test text and surface the first
     *  match (or "no match"). Helps the user iterate on regex before saving. */
    runTest (): void {
        if (!this.draft.pattern || !this.testText) {
            this.testResult = null
            return
        }
        try {
            const re = new RegExp(this.draft.pattern, 'm')
            const m = re.exec(this.testText)
            if (m) {
                const start = Math.max(0, m.index - 20)
                const end = Math.min(this.testText.length, m.index + m[0].length + 20)
                const ctx = this.testText.slice(start, end)
                this.testResult = { matched: true, preview: `…${ctx}…` }
            } else {
                this.testResult = { matched: false, preview: '' }
            }
        } catch (e: any) {
            this.testResult = { matched: false, preview: `regex error: ${e.message}` }
        }
        this.cdr.markForCheck()
    }
}
