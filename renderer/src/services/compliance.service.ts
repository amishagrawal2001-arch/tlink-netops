/**
 * Golden Config Compliance — define rules (regex patterns) that every device's
 * running configuration must match, then score compliance across the topology.
 */

import { Injectable } from '@angular/core'

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface GoldenConfigRule {
    id: string
    name: string
    vendor: string          // glob pattern or '*' for all vendors
    role?: string           // glob pattern (e.g. 'spine*') — optional
    pattern: string         // regex to match against running config
    severity: 'critical' | 'major' | 'minor' | 'warning'
    description: string
    enabled: boolean
}

export interface ComplianceResult {
    nodeId: string
    nodeLabel: string
    passed: GoldenConfigRule[]
    failed: GoldenConfigRule[]
    score: number           // 0–100
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function globMatch (pattern: string, value: string): boolean {
    if (!pattern || pattern === '*') { return true }
    const re = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                      .replace(/\*/g, '.*')
                      .replace(/\?/g, '.') + '$',
        'i',
    )
    return re.test(value)
}

let _nextId = 1
function uid (): string { return `gcr_${Date.now()}_${_nextId++}` }

// ── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ComplianceService {

    private _rules: GoldenConfigRule[] = []

    /** All currently loaded rules (read-only snapshot). */
    get rules (): GoldenConfigRule[] { return this._rules }

    // ── Default Rules ────────────────────────────────────────────────────────

    /** Populate default golden-config rules for common vendors. */
    initDefaultRules (): void {
        if (this._rules.length > 0) { return }
        this._rules = [
            // All vendors
            this._mkRule('NTP Configured',     '*', 'ntp|clock server|chrony',   'critical', 'Ensure NTP is configured on every device'),
            this._mkRule('SSH Enabled',        '*', 'ssh|transport input ssh',   'critical', 'SSH must be enabled for management access'),
            this._mkRule('Logging Configured', '*', 'logging|syslog',            'major',    'Remote syslog/logging must be configured'),
            this._mkRule('SNMP No Public',     '*', '^(?!.*community\\s+public)', 'critical', 'SNMP community string must not be "public"'),

            // Juniper
            this._mkRule('Juniper Export Policy', 'juniper', 'export\\s+\\S+',    'major',   'BGP sessions should have an export policy'),
            this._mkRule('Juniper BGP Auth',      'juniper', 'authentication-key', 'minor',   'BGP authentication key recommended'),

            // Cisco
            this._mkRule('Cisco AAA',             'cisco*',  'aaa new-model',          'critical', 'AAA must be enabled'),
            this._mkRule('Cisco Enable Secret',   'cisco*',  'enable secret',          'major',    'Enable secret must be configured'),
            this._mkRule('Cisco Mgmt No Shut',    'cisco*',  'interface.*management.*no shutdown', 'minor', 'Management interface should be up'),

            // Arista
            this._mkRule('Arista Mgmt API', 'arista', 'management api http-commands|management api gnmi', 'minor', 'Management API should be enabled'),
        ]
    }

    private _mkRule (name: string, vendor: string, pattern: string, severity: GoldenConfigRule['severity'], description: string): GoldenConfigRule {
        return { id: uid(), name, vendor, pattern, severity, description, enabled: true }
    }

    // ── CRUD ─────────────────────────────────────────────────────────────────

    addRule (rule: Omit<GoldenConfigRule, 'id'>): GoldenConfigRule {
        const full: GoldenConfigRule = { ...rule, id: uid() }
        this._rules = [...this._rules, full]
        return full
    }

    updateRule (id: string, changes: Partial<GoldenConfigRule>): void {
        this._rules = this._rules.map(r => r.id === id ? { ...r, ...changes } : r)
    }

    removeRule (id: string): void {
        this._rules = this._rules.filter(r => r.id !== id)
    }

    toggleRule (id: string): void {
        this._rules = this._rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r)
    }

    // ── Compliance Check ─────────────────────────────────────────────────────

    /** Check a single node's running config against applicable enabled rules. */
    checkCompliance (
        nodeId: string,
        nodeLabel: string,
        vendor: string,
        role: string,
        runningConfig: string,
        rules?: GoldenConfigRule[],
    ): ComplianceResult {
        const applicable = (rules ?? this._rules).filter(r => {
            if (!r.enabled) { return false }
            if (!globMatch(r.vendor, vendor)) { return false }
            if (r.role && !globMatch(r.role, role)) { return false }
            return true
        })

        const passed: GoldenConfigRule[] = []
        const failed: GoldenConfigRule[] = []

        for (const rule of applicable) {
            try {
                const re = new RegExp(rule.pattern, 'im')
                if (re.test(runningConfig)) {
                    passed.push(rule)
                } else {
                    failed.push(rule)
                }
            } catch {
                // Invalid regex — treat as failed
                failed.push(rule)
            }
        }

        const total = passed.length + failed.length
        const score = total > 0 ? Math.round((passed.length / total) * 100) : 100

        return { nodeId, nodeLabel, passed, failed, score }
    }

    /**
     * Run compliance checks across all provided nodes.
     *
     * @param nodes Array of node descriptors (id, label, vendor, role, credentials).
     * @param fetchConfigFn Async function that returns the running config string for a node ID.
     */
    async checkAllCompliance (
        nodes: Array<{ id: string; label: string; vendor: string; role: string }>,
        fetchConfigFn: (nodeId: string) => Promise<string>,
    ): Promise<ComplianceResult[]> {
        const results: ComplianceResult[] = []

        for (const node of nodes) {
            try {
                const config = await fetchConfigFn(node.id)
                results.push(this.checkCompliance(node.id, node.label, node.vendor, node.role, config))
            } catch {
                // Node unreachable — score 0
                results.push({
                    nodeId: node.id,
                    nodeLabel: node.label,
                    passed: [],
                    failed: this._rules.filter(r => r.enabled && globMatch(r.vendor, node.vendor)),
                    score: 0,
                })
            }
        }

        return results
    }
}
