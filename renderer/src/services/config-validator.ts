// ═════════════════════════════════════════════════════════════════════════════
// Config Validator — vendor-aware static lint of staged config BEFORE SSH push.
//
// Catches the boring-but-deadly mistakes: tabs in lines (rejected by some
// CLIs), Windows line endings, non-printable characters, lines that contain
// commit/exit/wr-mem (which the push pipeline adds itself — having them in
// the body lands them inside `load set terminal` and breaks the load), and
// per-vendor anti-patterns.
//
// Returns issues grouped by severity. Warnings are surfaced as a chip on the
// Push button; errors require the user to explicitly confirm "push anyway"
// (since we never want to BLOCK — sometimes operators know better than us).
// ═════════════════════════════════════════════════════════════════════════════

export type ValidationSeverity = 'error' | 'warning' | 'info'

export interface ValidationIssue {
    severity: ValidationSeverity
    /** 1-based line number; 0 means whole-config (no specific line). */
    line: number
    message: string
    /** Optional auto-fix suggestion shown in the dialog (user copies manually). */
    suggestion?: string
}

export interface ValidationResult {
    issues: ValidationIssue[]
    errors: number
    warnings: number
    /** Convenience: a one-line summary fit for a status bar / chip label. */
    summary: string
}

/**
 * Lint a staged config against vendor-specific rules. Pure function — no
 * side effects, no logging. Callers decide how to surface the result.
 */
export function validateConfig (vendor: string, config: string): ValidationResult {
    const issues: ValidationIssue[] = []

    // Whole-config checks first
    if (!config || !config.trim()) {
        issues.push({ severity: 'error', line: 0, message: 'Configuration is empty — nothing to push' })
        return _summarize(issues)
    }

    const lines = config.split('\n')

    // ── Generic checks (apply to every vendor) ──────────────────────────────
    lines.forEach((line, i) => {
        const lineNum = i + 1

        // Tab characters — many CLIs (Junos, Cisco) don't accept tabs and will
        // reject the line silently. Source-of-truth bug we've seen real users hit.
        if (/\t/.test(line)) {
            issues.push({
                severity: 'warning',
                line: lineNum,
                message: 'Line contains tab characters — most network CLIs require spaces',
                suggestion: line.replace(/\t/g, '  '),
            })
        }

        // Trailing CR (Windows line endings). LF is fine; CRLF can confuse
        // some shell-mode pushes.
        if (line.endsWith('\r')) {
            issues.push({
                severity: 'warning',
                line: lineNum,
                message: 'Line has Windows-style CRLF ending — LF preferred for SSH push',
            })
        }

        // Non-printable characters (excluding CR which we caught above).
        // These almost always mean the file got corrupted in copy/paste.
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x08\x0E-\x1F\x7F]/.test(line)) {
            issues.push({
                severity: 'error',
                line: lineNum,
                message: 'Line contains non-printable characters (likely paste corruption)',
            })
        }

        // Suspiciously long line — most network configs have lines under
        // ~500 chars. >2000 means probable accidental concatenation.
        if (line.length > 2000) {
            issues.push({
                severity: 'warning',
                line: lineNum,
                message: `Line is unusually long (${line.length} chars) — verify it's not a runaway concatenation`,
            })
        }
    })

    // ── Vendor-specific checks ──────────────────────────────────────────────
    const v = (vendor || '').toLowerCase()
    if (/^juniper/.test(v))                            { _validateJunos(lines, issues) }
    else if (/^cisco|^nxos|^iosxr/.test(v) || /^arista/.test(v) || /^dell/.test(v)) {
        _validateIos(lines, issues, v)
    }
    else if (/^hpe/.test(v) || /^huawei/.test(v))      { _validateSystemView(lines, issues) }
    else if (/^nokia/.test(v))                          { _validateNokia(lines, issues) }
    else if (/^sonic/.test(v))                          { _validateSonic(lines, issues) }
    else if (/^extreme/.test(v))                        { _validateExtreme(lines, issues) }
    else if (/^mikrotik/.test(v))                       { _validateMikrotik(lines, issues) }
    // Unknown vendor → generic checks only, no error (don't block lab use)

    return _summarize(issues)
}

// ─── Vendor validators ──────────────────────────────────────────────────────

function _validateJunos (lines: string[], issues: ValidationIssue[]): void {
    // Patterns that, if present in the BODY, will break the load — the push
    // pipeline wraps the body with `configure / load set terminal / ... /
    // commit / exit`. A bare 'commit' inside the load triggers the
    // "unknown command: commit" error we hit in v1.4.x.
    const pipelineCommands = /^(commit|exit|quit|configure|cli\b|edit\b|run\b)/i

    lines.forEach((line, i) => {
        const trimmed = line.trim()
        const lineNum = i + 1
        if (!trimmed || trimmed.startsWith('#')) { return }

        if (pipelineCommands.test(trimmed)) {
            issues.push({
                severity: 'error',
                line: lineNum,
                message: `\`${trimmed.split(/\s+/)[0]}\` should not appear in the config body — the push pipeline adds it`,
            })
            return
        }

        // Junos config body (set-mode) lines should start with set/delete/etc.
        // Hierarchical mode (`{`/`}` blocks) is also valid but rare in pasted
        // configs; warn when neither shape matches.
        const isSetMode = /^(set\s|delete\s|deactivate\s|activate\s|annotate\s|protect\s|unprotect\s|copy\s|rename\s|replace\s)/i.test(trimmed)
        const isHierarchical = trimmed.endsWith('{') || trimmed === '}' || /^[a-z][\w-]*\s*[;{]/i.test(trimmed)
        if (!isSetMode && !isHierarchical) {
            issues.push({
                severity: 'warning',
                line: lineNum,
                message: `Line doesn't look like Junos config (no \`set\`/\`delete\` prefix and not a hierarchy block)`,
            })
        }

        // Trailing semicolon on `set` lines — Junos accepts but it's a sign
        // someone copy-pasted from `show config | display set` and forgot to
        // strip the terminator. Warn so the user notices.
        if (/^set\s.+;\s*$/.test(trimmed)) {
            issues.push({
                severity: 'info',
                line: lineNum,
                message: '`set` line has trailing semicolon — accepted but unusual',
                suggestion: trimmed.replace(/;\s*$/, ''),
            })
        }
    })
}

function _validateIos (lines: string[], issues: ValidationIssue[], vendor: string): void {
    // Patterns that the push pipeline adds itself (preamble/postamble).
    // Cisco/Arista/Dell OS10 push wraps with `configure terminal / … / end /
    // write memory`. Body containing these creates duplicate / nested
    // config-mode entries.
    const pipelineCommands = /^(configure\s+terminal|conf\s+t|end|exit\b|write\s+memory|wr\b|copy\s+running|enable\b)/i

    lines.forEach((line, i) => {
        const trimmed = line.trim()
        const lineNum = i + 1
        if (!trimmed || trimmed.startsWith('!')) { return }

        if (pipelineCommands.test(trimmed)) {
            issues.push({
                severity: 'error',
                line: lineNum,
                message: `\`${trimmed.split(/\s+/)[0]}\` should not appear in config body — push pipeline adds it`,
            })
            return
        }

        // `show` commands are read-only — they don't belong in a push body.
        // Frequent paste-from-troubleshooting-session mistake.
        if (/^show\s/i.test(trimmed)) {
            issues.push({
                severity: 'error',
                line: lineNum,
                message: '`show` command in config body — read-only commands have no effect on push',
            })
        }

        // Common typo: `no shut down` (with space) vs the correct `no shutdown`.
        if (/^\s*no\s+shut\s+down\s*$/i.test(line)) {
            issues.push({
                severity: 'error',
                line: lineNum,
                message: 'Typo: `no shut down` (with space) — should be `no shutdown` (one word)',
                suggestion: line.replace(/no\s+shut\s+down/i, 'no shutdown'),
            })
        }
    })
}

function _validateSystemView (lines: string[], issues: ValidationIssue[]): void {
    // HPE Comware / Huawei VRP — push pipeline adds `system-view / quit / save`.
    const pipelineCommands = /^(system-view|sys\b|quit\b|return\b|save\s+force|save\s*$)/i

    lines.forEach((line, i) => {
        const trimmed = line.trim()
        const lineNum = i + 1
        if (!trimmed || trimmed.startsWith('#')) { return }

        if (pipelineCommands.test(trimmed)) {
            issues.push({
                severity: 'error',
                line: lineNum,
                message: `\`${trimmed.split(/\s+/)[0]}\` should not appear in config body — push pipeline adds it`,
            })
        }
    })
}

function _validateNokia (lines: string[], issues: ValidationIssue[]): void {
    // SR OS classic — push pipeline adds `enter candidate / commit`.
    const pipelineCommands = /^(enter\s+candidate|commit\b|exit\s+all|admin\s+save)/i

    lines.forEach((line, i) => {
        const trimmed = line.trim()
        const lineNum = i + 1
        if (!trimmed || trimmed.startsWith('#')) { return }

        if (pipelineCommands.test(trimmed)) {
            issues.push({
                severity: 'error',
                line: lineNum,
                message: `\`${trimmed}\` should not appear in config body — push pipeline adds it`,
            })
        }
    })
}

function _validateSonic (lines: string[], issues: ValidationIssue[]): void {
    // SONiC config is shell commands. Each line should start with `sudo
    // config` (or be a comment / empty / a `vtysh -c` quagga command).
    lines.forEach((line, i) => {
        const trimmed = line.trim()
        const lineNum = i + 1
        if (!trimmed || trimmed.startsWith('#')) { return }

        // Save command shouldn't be in body — push pipeline adds it.
        if (/^sudo\s+config\s+save/.test(trimmed)) {
            issues.push({
                severity: 'error',
                line: lineNum,
                message: '`sudo config save` should not appear in config body — push pipeline adds it',
            })
            return
        }

        const looksValid =
            /^sudo\s+config\s/.test(trimmed) ||
            /^vtysh\s+-c/.test(trimmed) ||
            /^config\s/.test(trimmed) ||
            /^sonic-/.test(trimmed)
        if (!looksValid) {
            issues.push({
                severity: 'warning',
                line: lineNum,
                message: 'Line doesn\'t start with `sudo config` / `vtysh -c` — verify it\'s valid SONiC syntax',
            })
        }
    })
}

function _validateExtreme (lines: string[], issues: ValidationIssue[]): void {
    // Extreme XOS — push wraps with `save configuration`. Bare configure
    // commands accepted at the prompt.
    lines.forEach((line, i) => {
        const trimmed = line.trim()
        const lineNum = i + 1
        if (!trimmed || trimmed.startsWith('#')) { return }

        if (/^save\s+configuration/i.test(trimmed)) {
            issues.push({
                severity: 'error',
                line: lineNum,
                message: '`save configuration` should not appear in config body — push pipeline adds it',
            })
        }
    })
}

function _validateMikrotik (lines: string[], issues: ValidationIssue[]): void {
    // RouterOS — each line should look like a path-style command starting
    // with `/`. Comments are `#`.
    lines.forEach((line, i) => {
        const trimmed = line.trim()
        const lineNum = i + 1
        if (!trimmed || trimmed.startsWith('#')) { return }

        // RouterOS commands either start with `/path/to/cmd` or with a
        // sub-cmd verb at root. Bare words can be valid (e.g. `print`).
        // We only flag commands that LOOK like another vendor pasted in.
        if (/^(set\s|configure|enable\b|conf\s+t|system-view)/i.test(trimmed)) {
            issues.push({
                severity: 'warning',
                line: lineNum,
                message: 'Line looks like another vendor\'s syntax — verify it\'s valid RouterOS',
            })
        }
    })
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _summarize (issues: ValidationIssue[]): ValidationResult {
    const errors = issues.filter(i => i.severity === 'error').length
    const warnings = issues.filter(i => i.severity === 'warning').length
    let summary = ''
    if (errors > 0)        { summary = `${errors} error${errors === 1 ? '' : 's'}` }
    if (warnings > 0)      { summary += (summary ? ', ' : '') + `${warnings} warning${warnings === 1 ? '' : 's'}` }
    if (!summary)          { summary = issues.length === 0 ? 'No issues' : `${issues.length} info` }
    return { issues, errors, warnings, summary }
}

// ═══════════════════════════════════════════════════════════════════════════
// Post-push smoke-test commands per vendor.
// ═══════════════════════════════════════════════════════════════════════════
//
// After a successful push, run a tiny read-only command and verify SSH is
// still reachable. Catches the case where the push lands but the new config
// broke SSH access (ACL self-block, AAA misconfig, mgmt iface shut, etc.).
// The vendor-specific commands are picked to be:
//   - cheap (no per-port iteration)
//   - quick (sub-second response)
//   - present on every model in that family
//
// Returns null when the vendor isn't supported — the push pipeline skips
// post-verify in that case rather than running an unknown command.

export interface SmokeTest {
    /** The shell/CLI command to run via SSH after push. */
    command: string
    /** Regex that should match somewhere in the output if the device is
     *  alive and responding sanely. Used to catch "SSH connected but the
     *  device is in a weird state" (e.g. password prompt loop). */
    expectPattern: RegExp
    /** Human label for the push log. */
    label: string
}

export function smokeTestForVendor (vendor: string): SmokeTest | null {
    const v = (vendor || '').toLowerCase()
    if (/^juniper/.test(v)) {
        return {
            command: 'cli -c "show system uptime | no-more"',
            expectPattern: /System booted|Time Source|days,/i,
            label: 'Junos: show system uptime',
        }
    }
    if (/^cisco|^nxos|^iosxr/.test(v)) {
        return {
            command: 'show version | include uptime',
            expectPattern: /uptime is/i,
            label: 'Cisco: show version (uptime)',
        }
    }
    if (/^arista/.test(v)) {
        return {
            command: 'show version',
            expectPattern: /Arista|EOS\s+version/i,
            label: 'Arista: show version',
        }
    }
    if (/^hpe/.test(v) || /^huawei/.test(v)) {
        return {
            command: 'display version',
            expectPattern: /VRP|Comware|Software/i,
            label: 'HPE/Huawei: display version',
        }
    }
    if (/^dell/.test(v)) {
        return {
            command: 'show version | grep -i version',
            expectPattern: /version|os10/i,
            label: 'Dell OS10: show version',
        }
    }
    if (/^nokia/.test(v)) {
        return {
            command: 'show system information | match Name',
            expectPattern: /System Name|System Type/i,
            label: 'Nokia: show system information',
        }
    }
    if (/^sonic/.test(v)) {
        return {
            command: 'show version 2>/dev/null | head -5',
            expectPattern: /SONiC|Build|Platform/i,
            label: 'SONiC: show version',
        }
    }
    if (/^extreme/.test(v)) {
        return {
            command: 'show switch | include System',
            expectPattern: /System Name|System Type|UpTime/i,
            label: 'Extreme: show switch',
        }
    }
    if (/^mikrotik/.test(v)) {
        return {
            command: '/system resource print',
            expectPattern: /uptime|board-name/i,
            label: 'MikroTik: /system resource',
        }
    }
    // Unknown vendor — skip post-push smoke test (return null so caller
    // can decide whether to flag this or just proceed silently).
    return null
}
