import { Injectable } from '@angular/core'

export type LicenseStatus = 'trial' | 'active' | 'expired' | 'invalid'

export interface LicenseInfo {
    status: LicenseStatus
    trialDaysRemaining: number
    licenseKey: string | null
}

const STORAGE_KEY_LICENSE = 'tlink_license_key'
const STORAGE_KEY_TRIAL_START = 'tlink_trial_start'
const STORAGE_KEY_LICENSE_STATUS = 'tlink_license_status'
const TRIAL_DURATION_DAYS = 14
const KEY_PATTERN = /^TLINK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/

@Injectable({ providedIn: 'root' })
export class LicenseService {

    licenseKey: string | null = null
    licenseStatus: LicenseStatus = 'invalid'
    trialDaysRemaining = 0
    trialStartDate: number | null = null

    /** Features gated by license tier */
    private readonly proFeatures = new Set([
        'save', 'export', 'add-shapes', 'add-nodes', 'add-links',
        'edit-properties', 'templates', 'snmp', 'syslog',
    ])

    constructor () {
        this._loadFromStorage()
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** Attempt to activate a license key. Returns true if valid format. */
    activateLicense (key: string): boolean {
        const normalised = key.trim().toUpperCase()
        if (!KEY_PATTERN.test(normalised)) {
            return false
        }
        this.licenseKey = normalised
        this.licenseStatus = 'active'
        localStorage.setItem(STORAGE_KEY_LICENSE, normalised)
        localStorage.setItem(STORAGE_KEY_LICENSE_STATUS, 'active')
        return true
    }

    /** Check current license state and return it. */
    checkLicense (): LicenseStatus {
        // If an active key is stored, trust it (server validation can be added later)
        if (this.licenseKey && KEY_PATTERN.test(this.licenseKey)) {
            const stored = localStorage.getItem(STORAGE_KEY_LICENSE_STATUS)
            if (stored === 'active') {
                this.licenseStatus = 'active'
                return 'active'
            }
        }

        // Trial logic
        if (this.trialStartDate) {
            const elapsed = Date.now() - this.trialStartDate
            const daysElapsed = elapsed / (1000 * 60 * 60 * 24)
            this.trialDaysRemaining = Math.max(0, Math.ceil(TRIAL_DURATION_DAYS - daysElapsed))
            if (this.trialDaysRemaining > 0) {
                this.licenseStatus = 'trial'
                return 'trial'
            }
            this.licenseStatus = 'expired'
            return 'expired'
        }

        // No trial started, no key — show as invalid (needs activation or trial start)
        this.licenseStatus = 'invalid'
        return 'invalid'
    }

    /** Remove stored license key. */
    deactivateLicense (): void {
        this.licenseKey = null
        this.licenseStatus = 'invalid'
        localStorage.removeItem(STORAGE_KEY_LICENSE)
        localStorage.removeItem(STORAGE_KEY_LICENSE_STATUS)
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
        // Expired or invalid — block pro features
        return !this.proFeatures.has(feature)
    }

    /** Whether the app should show the blocking expired overlay. */
    get shouldBlockApp (): boolean {
        const status = this.checkLicense()
        return status === 'expired' || status === 'invalid'
    }

    /** Whether the trial banner should be shown. */
    get showTrialBanner (): boolean {
        return this.checkLicense() === 'trial'
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private _loadFromStorage (): void {
        this.licenseKey = localStorage.getItem(STORAGE_KEY_LICENSE)
        const trialStr = localStorage.getItem(STORAGE_KEY_TRIAL_START)
        if (trialStr) {
            this.trialStartDate = Number(trialStr)
        }
        this.checkLicense()
    }
}
