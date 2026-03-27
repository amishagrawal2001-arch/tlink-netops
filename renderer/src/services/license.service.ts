import { Injectable } from '@angular/core'

export type LicenseStatus = 'trial' | 'active' | 'expired' | 'invalid'
export type LicenseTier = 'trial' | 'pro' | 'enterprise'
export type LicenseSource = 'server' | 'local'

export interface LicenseInfo {
    status: LicenseStatus
    trialDaysRemaining: number
    licenseKey: string | null
    tier: LicenseTier
    expiry: Date | null
    source: LicenseSource | null
}

export interface KeyValidation {
    valid: boolean
    tier: 'pro' | 'enterprise' | null
    expiry: Date | null
    expired: boolean
}

export interface ServerActivationResponse {
    valid: boolean
    tier: string
    expiry: string
    customer: string
    message: string
}

const STORAGE_KEY_LICENSE = 'tlink_license_key'
const STORAGE_KEY_TRIAL_START = 'tlink_trial_start'
const STORAGE_KEY_LICENSE_STATUS = 'tlink_license_status'
const STORAGE_KEY_LICENSE_TIER = 'tlink_license_tier'
const STORAGE_KEY_LICENSE_EXPIRY = 'tlink_license_expiry'
const STORAGE_KEY_LICENSE_SOURCE = 'tlink_license_source'
const STORAGE_KEY_LICENSE_CUSTOMER = 'tlink_license_customer'
const TRIAL_DURATION_DAYS = 14

/** Old 5-segment format: TLINK-XXXX-YYMM-XXXX-CCCC */
const KEY_PATTERN_5 = /^TLINK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
/** New 6-segment format: TLINK-APP-TXXX-YYMM-XXXX-CCCC */
const KEY_PATTERN_6 = /^TLINK-[A-Z0-9]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const OLD_SALT = 'TLINK_SALT_2026'

/** Default salt for server-issued keys; override via setServerKeySalt() */
const DEFAULT_SERVER_KEY_SALT = 'tlink-key-salt-change-in-production'

const HEARTBEAT_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

@Injectable({ providedIn: 'root' })
export class LicenseService {

    licenseKey: string | null = null
    licenseStatus: LicenseStatus = 'invalid'
    trialDaysRemaining = 0
    trialStartDate: number | null = null
    licenseTier: LicenseTier = 'trial'
    licenseExpiry: Date | null = null
    licenseSource: LicenseSource | null = null
    licenseCustomer: string | null = null

    /** Configurable license server URL — loaded from localStorage or defaults */
    licenseServerUrl = localStorage.getItem('tlink-license-server-url') || 'http://localhost:4000'

    /** Salt used by the license server for 6-segment key checksums */
    private _serverKeySalt = DEFAULT_SERVER_KEY_SALT

    /** Warning message from heartbeat failures */
    heartbeatWarning: string | null = null

    private _heartbeatTimer: ReturnType<typeof setInterval> | null = null

    /** Features gated by license tier */
    private readonly proFeatures = new Set([
        'save', 'export', 'add-shapes', 'add-nodes', 'add-links',
        'edit-properties', 'templates', 'snmp', 'syslog',
    ])

    constructor () {
        this._loadFromStorage()
        this._startHeartbeat()
    }

    /** Allow configuring the server key salt at runtime */
    setServerKeySalt (salt: string): void {
        this._serverKeySalt = salt
    }

    // ── Key Format Detection ────────────────────────────────────────────────

    /** Returns the number of segments in the key (5 or 6), or 0 if unrecognised */
    private _detectKeyFormat (key: string): 5 | 6 | 0 {
        if (KEY_PATTERN_6.test(key)) return 6
        if (KEY_PATTERN_5.test(key)) return 5
        return 0
    }

    // ── Old 5-segment checksum (local keys) ─────────────────────────────────

    /**
     * FNV-1a hash expanded to 16 hex chars (original local implementation).
     */
    private _simpleHash (input: string): string {
        let h = 0x811c9dc5
        for (let i = 0; i < input.length; i++) {
            h ^= input.charCodeAt(i)
            h = Math.imul(h, 0x01000193)
            h = h >>> 0
        }
        let result = ''
        for (let round = 0; round < 4; round++) {
            h ^= (round + 1) * 0x9e3779b9
            h = Math.imul(h, 0x01000193)
            h = h >>> 0
            result += h.toString(16).padStart(4, '0').slice(-4)
        }
        return result
    }

    private _computeChecksumOld (seg1: string, seg2: string, seg3: string): string {
        const payload = `${seg1}${seg2}${seg3}`
        const hash = this._simpleHash(`${payload}:${OLD_SALT}`)
        let result = ''
        for (let i = 0; i < 4; i++) {
            const num = parseInt(hash.substring(i * 4, i * 4 + 4), 16)
            result += CHARSET[num % CHARSET.length]
        }
        return result
    }

    // ── New 6-segment checksum (server keys) ────────────────────────────────

    /**
     * FNV-1a hash matching the license server's crypto.js fnv1a()
     */
    private _fnv1a (str: string): number {
        let hash = 0x811c9dc5
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i)
            hash = (hash * 0x01000193) >>> 0
        }
        return hash
    }

    /**
     * Convert hash to charset characters, matching the server's hashToChars()
     */
    private _hashToChars (hash: number, len: number): string {
        let result = ''
        let h = hash
        for (let i = 0; i < len; i++) {
            result += CHARSET[h % CHARSET.length]
            h = Math.floor(h / CHARSET.length) || (h + 7)
        }
        return result
    }

    /**
     * Compute checksum for 6-segment keys, matching the server's computeChecksum().
     * segments are joined with '-' and salt is appended after '-'.
     */
    private _computeChecksumServer (segments: string[], salt: string): string {
        const input = segments.join('-') + '-' + salt
        const h = this._fnv1a(input)
        return this._hashToChars(h, 4)
    }

    // ── Tier / Expiry decoding ──────────────────────────────────────────────

    private _decodeTier (tierChar: string): 'pro' | 'enterprise' | null {
        if (tierChar === 'P') return 'pro'
        if (tierChar === 'E') return 'enterprise'
        return null
    }

    private _decodeExpiry (yymm: string): Date | null {
        const yy = parseInt(yymm.substring(0, 2), 10)
        const mm = parseInt(yymm.substring(2, 4), 10)
        if (isNaN(yy) || isNaN(mm) || mm < 1 || mm > 12) return null
        const year = 2000 + yy
        const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate()
        return new Date(Date.UTC(year, mm - 1, lastDay))
    }

    // ── Validate Key (supports both formats) ────────────────────────────────

    /**
     * Validate a license key offline.
     * Supports both old 5-segment and new 6-segment formats.
     */
    validateKey (key: string): KeyValidation {
        const result: KeyValidation = { valid: false, tier: null, expiry: null, expired: false }
        if (!key) return result

        const format = this._detectKeyFormat(key)
        if (format === 0) return result

        const parts = key.split('-')

        if (format === 5) {
            return this._validateKey5(parts)
        }
        return this._validateKey6(parts)
    }

    /** Validate old 5-segment key: TLINK-XXXX-YYMM-XXXX-CCCC */
    private _validateKey5 (parts: string[]): KeyValidation {
        const result: KeyValidation = { valid: false, tier: null, expiry: null, expired: false }
        if (parts.length !== 5 || parts[0] !== 'TLINK') return result

        const [, seg1, seg2, seg3, seg4] = parts

        const expected = this._computeChecksumOld(seg1, seg2, seg3)
        if (seg4 !== expected) return result

        const tier = this._decodeTier(seg1[0])
        if (!tier) return result

        const expiry = this._decodeExpiry(seg2)
        if (!expiry) return result

        result.valid = true
        result.tier = tier
        result.expiry = expiry
        result.expired = expiry.getTime() < Date.now()
        return result
    }

    /** Validate new 6-segment key: TLINK-APP-TSEG-YYMM-RAND-CHECKSUM */
    private _validateKey6 (parts: string[]): KeyValidation {
        const result: KeyValidation = { valid: false, tier: null, expiry: null, expired: false }
        if (parts.length !== 6 || parts[0] !== 'TLINK') return result

        const [prefix, appCode, tierSeg, yymm, rand, checksum] = parts

        const expected = this._computeChecksumServer(
            [prefix, appCode, tierSeg, yymm, rand],
            this._serverKeySalt,
        )
        if (checksum !== expected) return result

        const tier = this._decodeTier(tierSeg[0])
        if (!tier) return result

        const expiry = this._decodeExpiry(yymm)
        if (!expiry) return result

        result.valid = true
        result.tier = tier
        result.expiry = expiry
        result.expired = expiry.getTime() < Date.now()
        return result
    }

    // ── Server Communication ────────────────────────────────────────────────

    /** Try to activate via the license server. Returns null if server unreachable. */
    private async _serverActivate (key: string): Promise<ServerActivationResponse | null> {
        try {
            const response = await fetch(`${this.licenseServerUrl}/api/license/activate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key,
                    machineId: this.getMachineId(),
                    appCode: 'NO',
                    appVersion: this._getAppVersion(),
                    os: this._getOS(),
                }),
            })

            if (!response.ok) {
                const errBody = await response.json().catch(() => ({ error: 'Unknown error' }))
                // Server responded but rejected the key
                return { valid: false, tier: '', expiry: '', customer: '', message: errBody.error || 'Activation failed' }
            }

            return await response.json() as ServerActivationResponse
        } catch {
            // Server unreachable (network error, offline, etc.)
            return null
        }
    }

    /** Send a heartbeat to the license server */
    private async _serverHeartbeat (): Promise<void> {
        if (!this.licenseKey) return

        try {
            const response = await fetch(`${this.licenseServerUrl}/api/license/heartbeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key: this.licenseKey,
                    machineId: this.getMachineId(),
                }),
            })

            if (response.ok) {
                const data = await response.json()
                if (!data.valid) {
                    this.heartbeatWarning = 'License server reports this license is no longer valid. Please contact support.'
                } else {
                    this.heartbeatWarning = null
                }
            }
        } catch {
            // Server unreachable during heartbeat — don't block, just leave existing state
        }
    }

    private _startHeartbeat (): void {
        if (this._heartbeatTimer) return
        this._heartbeatTimer = setInterval(() => {
            if (this.licenseStatus === 'active' && this.licenseSource === 'server') {
                this._serverHeartbeat()
            }
        }, HEARTBEAT_INTERVAL_MS)
    }

    private _getAppVersion (): string {
        try {
            // Try to get version from Electron
            return (window as any).electronAPI?.getAppVersion?.() || '1.0.0'
        } catch {
            return '1.0.0'
        }
    }

    private _getOS (): string {
        if (typeof navigator !== 'undefined') {
            const ua = navigator.userAgent.toLowerCase()
            if (ua.includes('win')) return 'windows'
            if (ua.includes('mac')) return 'macos'
            if (ua.includes('linux')) return 'linux'
        }
        return 'unknown'
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Attempt to activate a license key.
     * For 6-segment keys: tries server validation first, falls back to local.
     * For 5-segment keys: local validation only.
     * Returns a promise with { success, message }.
     */
    async activateLicense (key: string): Promise<{ success: boolean; message: string }> {
        const normalised = key.trim().toUpperCase()
        const format = this._detectKeyFormat(normalised)

        if (format === 0) {
            return { success: false, message: 'Invalid key format' }
        }

        if (format === 6) {
            // New 6-segment key: try server first
            const serverResult = await this._serverActivate(normalised)

            if (serverResult !== null) {
                // Server was reachable
                if (serverResult.valid) {
                    this._applyActivation(normalised, serverResult.tier as LicenseTier, serverResult.expiry, 'server', serverResult.customer)
                    return { success: true, message: serverResult.message || 'License activated via server' }
                }
                return { success: false, message: serverResult.message || 'Server rejected the license key' }
            }

            // Server unreachable — fall back to local validation
            const localResult = this._activateLocal(normalised)
            if (localResult) {
                return { success: true, message: 'License activated locally (server offline)' }
            }
            return { success: false, message: 'Server unreachable and local validation failed' }
        }

        // Old 5-segment key: local validation only
        const localResult = this._activateLocal(normalised)
        if (localResult) {
            return { success: true, message: 'License activated' }
        }
        return { success: false, message: 'Invalid or expired license key' }
    }

    /**
     * Synchronous activation for backward compatibility.
     * Only performs local validation. For server validation use activateLicense().
     */
    activateLicenseSync (key: string): boolean {
        const normalised = key.trim().toUpperCase()
        return this._activateLocal(normalised)
    }

    private _activateLocal (normalised: string): boolean {
        const validation = this.validateKey(normalised)
        if (!validation.valid || validation.expired) return false

        this._applyActivation(normalised, validation.tier!, null, 'local')
        return true
    }

    private _applyActivation (
        key: string,
        tier: LicenseTier | string,
        expiry: string | null,
        source: LicenseSource,
        customer?: string,
    ): void {
        this.licenseKey = key
        this.licenseStatus = 'active'
        this.licenseTier = (tier === 'pro' || tier === 'enterprise') ? tier : 'pro'
        this.licenseSource = source
        this.licenseCustomer = customer || null

        if (expiry) {
            this.licenseExpiry = new Date(expiry)
        } else {
            // Fall back to key-encoded expiry
            const validation = this.validateKey(key)
            this.licenseExpiry = validation.expiry
        }

        localStorage.setItem(STORAGE_KEY_LICENSE, key)
        localStorage.setItem(STORAGE_KEY_LICENSE_STATUS, 'active')
        localStorage.setItem(STORAGE_KEY_LICENSE_TIER, this.licenseTier)
        localStorage.setItem(STORAGE_KEY_LICENSE_SOURCE, source)
        if (this.licenseExpiry) {
            localStorage.setItem(STORAGE_KEY_LICENSE_EXPIRY, this.licenseExpiry.toISOString())
        }
        if (this.licenseCustomer) {
            localStorage.setItem(STORAGE_KEY_LICENSE_CUSTOMER, this.licenseCustomer)
        }
    }

    /** Check current license state and return it. */
    checkLicense (): LicenseStatus {
        // If an active key is stored, validate it fully
        if (this.licenseKey) {
            const format = this._detectKeyFormat(this.licenseKey)
            if (format > 0) {
                const stored = localStorage.getItem(STORAGE_KEY_LICENSE_STATUS)
                if (stored === 'active') {
                    const validation = this.validateKey(this.licenseKey)
                    if (validation.valid && !validation.expired) {
                        this.licenseStatus = 'active'
                        this.licenseTier = validation.tier!
                        this.licenseExpiry = validation.expiry
                        return 'active'
                    }
                    if (validation.valid && validation.expired) {
                        this.licenseStatus = 'expired'
                        this.licenseTier = validation.tier!
                        this.licenseExpiry = validation.expiry
                        localStorage.setItem(STORAGE_KEY_LICENSE_STATUS, 'expired')
                        return 'expired'
                    }
                    // For server-validated keys that may not pass local checksum,
                    // trust the stored status if source is 'server'
                    if (this.licenseSource === 'server') {
                        if (this.licenseExpiry && this.licenseExpiry.getTime() < Date.now()) {
                            this.licenseStatus = 'expired'
                            localStorage.setItem(STORAGE_KEY_LICENSE_STATUS, 'expired')
                            return 'expired'
                        }
                        this.licenseStatus = 'active'
                        return 'active'
                    }
                }
            }
        }

        // Trial logic
        if (this.trialStartDate) {
            const elapsed = Date.now() - this.trialStartDate
            const daysElapsed = elapsed / (1000 * 60 * 60 * 24)
            this.trialDaysRemaining = Math.max(0, Math.ceil(TRIAL_DURATION_DAYS - daysElapsed))
            this.licenseTier = 'trial'
            this.licenseExpiry = null
            if (this.trialDaysRemaining > 0) {
                this.licenseStatus = 'trial'
                return 'trial'
            }
            this.licenseStatus = 'expired'
            return 'expired'
        }

        // No trial started, no key
        this.licenseStatus = 'invalid'
        this.licenseTier = 'trial'
        this.licenseExpiry = null
        return 'invalid'
    }

    /** Remove stored license key. */
    deactivateLicense (): void {
        this.licenseKey = null
        this.licenseStatus = 'invalid'
        this.licenseTier = 'trial'
        this.licenseExpiry = null
        this.licenseSource = null
        this.licenseCustomer = null
        this.heartbeatWarning = null
        localStorage.removeItem(STORAGE_KEY_LICENSE)
        localStorage.removeItem(STORAGE_KEY_LICENSE_STATUS)
        localStorage.removeItem(STORAGE_KEY_LICENSE_TIER)
        localStorage.removeItem(STORAGE_KEY_LICENSE_EXPIRY)
        localStorage.removeItem(STORAGE_KEY_LICENSE_SOURCE)
        localStorage.removeItem(STORAGE_KEY_LICENSE_CUSTOMER)
    }

    /** Start the 14-day free trial. */
    startTrial (): void {
        if (!this.trialStartDate) {
            this.trialStartDate = Date.now()
            localStorage.setItem(STORAGE_KEY_TRIAL_START, String(this.trialStartDate))
        }
        this.checkLicense()
    }

    /** Whether the trial has been started (even if expired). */
    get trialStarted (): boolean {
        return this.trialStartDate !== null
    }

    /**
     * Check whether a feature is available under the current license.
     * During trial or with an active license, all features are available.
     * When expired, only read-only viewing is allowed.
     */
    isFeatureAvailable (feature: string): boolean {
        const status = this.checkLicense()
        if (status === 'active' || status === 'trial') {
            return true
        }
        return !this.proFeatures.has(feature)
    }

    /** Whether the app should show the blocking expired overlay. */
    get shouldBlockApp (): boolean {
        const status = this.checkLicense()
        return status === 'expired' || status === 'invalid'
    }

    /** Whether the trial banner should be shown. */
    get showTrialBanner (): boolean {
        const status = this.checkLicense()
        return status === 'trial'
    }

    /** Whether the license (non-trial) banner should be shown. */
    get showLicenseBanner (): boolean {
        return this.licenseStatus === 'active'
    }

    /** Get tier display name */
    get tierDisplayName (): string {
        switch (this.licenseTier) {
            case 'pro': return 'Pro'
            case 'enterprise': return 'Enterprise'
            default: return 'Trial'
        }
    }

    /** Get formatted expiry date */
    get formattedExpiry (): string {
        if (!this.licenseExpiry) return ''
        return this.licenseExpiry.toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
        })
    }

    /** Get masked key for display */
    get maskedKey (): string {
        if (!this.licenseKey) return ''
        const parts = this.licenseKey.split('-')
        if (parts.length === 5) {
            return `${parts[0]}-${parts[1]}-****-****-****`
        }
        if (parts.length === 6) {
            return `${parts[0]}-${parts[1]}-${parts[2]}-****-****-****`
        }
        return ''
    }

    /** Generate a simple machine ID for hardware fingerprinting */
    getMachineId (): string {
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
        const screen = typeof window !== 'undefined'
            ? `${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}`
            : '0x0x0'
        const raw = `${ua}|${screen}`
        let h = 0x811c9dc5
        for (let i = 0; i < raw.length; i++) {
            h ^= raw.charCodeAt(i)
            h = Math.imul(h, 0x01000193)
            h = h >>> 0
        }
        return h.toString(16).toUpperCase().padStart(8, '0')
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private _loadFromStorage (): void {
        this.licenseKey = localStorage.getItem(STORAGE_KEY_LICENSE)
        const trialStr = localStorage.getItem(STORAGE_KEY_TRIAL_START)
        if (trialStr) {
            this.trialStartDate = Number(trialStr)
        }
        const savedTier = localStorage.getItem(STORAGE_KEY_LICENSE_TIER) as LicenseTier | null
        if (savedTier) this.licenseTier = savedTier
        const savedExpiry = localStorage.getItem(STORAGE_KEY_LICENSE_EXPIRY)
        if (savedExpiry) this.licenseExpiry = new Date(savedExpiry)
        const savedSource = localStorage.getItem(STORAGE_KEY_LICENSE_SOURCE) as LicenseSource | null
        if (savedSource) this.licenseSource = savedSource
        const savedCustomer = localStorage.getItem(STORAGE_KEY_LICENSE_CUSTOMER)
        if (savedCustomer) this.licenseCustomer = savedCustomer

        this.checkLicense()
    }
}
