#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Tlink NetOps — License Key Generator (Node.js)
//
// Usage (CLI):
//   node generate-license.js --tier pro --expiry 2027-12-31 --customer "Acme Corp"
//   node generate-license.js --list
//   node generate-license.js --revoke TLINK-P8K2-2712-R4M9-X7C3
//
// Usage (Module):
//   const { generateKey, validateKey } = require('./generate-license')
// ─────────────────────────────────────────────────────────────────────────────
'use strict'

const fs = require('fs')
const path = require('path')

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I
const SALT = 'TLINK_SALT_2026'
const KEY_PATTERN = /^TLINK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
const LOG_FILE = path.join(__dirname, '.license-log.csv')

// ── FNV-1a based hash (matches browser LicenseService) ─────────────────────

function fnvHash (input) {
    let h = 0x811c9dc5 // FNV offset basis
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i)
        h = Math.imul(h, 0x01000193) // FNV prime
        h = h >>> 0 // keep unsigned 32-bit
    }
    // Expand to 16 hex chars by chaining
    let result = ''
    for (let round = 0; round < 4; round++) {
        h ^= (round + 1) * 0x9e3779b9
        h = Math.imul(h, 0x01000193)
        h = h >>> 0
        result += h.toString(16).padStart(4, '0').slice(-4)
    }
    return result
}

function seedChar (seed, idx) {
    const hash = fnvHash(`${seed}:${idx}`)
    const num = parseInt(hash.substring(0, 8), 16)
    return CHARSET[num % CHARSET.length]
}

function computeChecksum (seg1, seg2, seg3) {
    const payload = `${seg1}${seg2}${seg3}`
    const hash = fnvHash(`${payload}:${SALT}`)
    let result = ''
    for (let i = 0; i < 4; i++) {
        const num = parseInt(hash.substring(i * 4, i * 4 + 4), 16)
        result += CHARSET[num % CHARSET.length]
    }
    return result
}

function encodeExpiry (expiryDate) {
    // expiryDate is a string YYYY-MM-DD or a Date
    const d = typeof expiryDate === 'string' ? new Date(expiryDate + 'T00:00:00Z') : expiryDate
    const yy = String(d.getUTCFullYear()).slice(-2)
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    return `${yy}${mm}`
}

function decodeExpiry (seg2) {
    // seg2 is 4 chars: YYMM
    const yy = parseInt(seg2.substring(0, 2), 10)
    const mm = parseInt(seg2.substring(2, 4), 10)
    if (isNaN(yy) || isNaN(mm) || mm < 1 || mm > 12) return null
    const year = 2000 + yy
    // Last day of the month
    const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate()
    return new Date(Date.UTC(year, mm - 1, lastDay))
}

function decodeTier (seg1) {
    const tierChar = seg1[0]
    if (tierChar === 'P') return 'pro'
    if (tierChar === 'E') return 'enterprise'
    return null
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a deterministic license key.
 * @param {'pro'|'enterprise'} tier
 * @param {string} expiryDate — YYYY-MM-DD
 * @param {string} customer — customer name
 * @returns {string} The license key
 */
function generateKey (tier, expiryDate, customer) {
    const tierChar = tier === 'enterprise' ? 'E' : 'P'
    const seed = `${tierChar}:${expiryDate}:${customer}`

    // Segment 1: tier char + 3 deterministic chars
    const s1c1 = seedChar(`${seed}:s1`, 0)
    const s1c2 = seedChar(`${seed}:s1`, 1)
    const s1c3 = seedChar(`${seed}:s1`, 2)
    const seg1 = `${tierChar}${s1c1}${s1c2}${s1c3}`

    // Segment 2: encoded expiry YYMM
    const seg2 = encodeExpiry(expiryDate)

    // Segment 3: deterministic random
    const s3c0 = seedChar(`${seed}:s3`, 0)
    const s3c1 = seedChar(`${seed}:s3`, 1)
    const s3c2 = seedChar(`${seed}:s3`, 2)
    const s3c3 = seedChar(`${seed}:s3`, 3)
    const seg3 = `${s3c0}${s3c1}${s3c2}${s3c3}`

    // Segment 4: checksum
    const seg4 = computeChecksum(seg1, seg2, seg3)

    return `TLINK-${seg1}-${seg2}-${seg3}-${seg4}`
}

/**
 * Validate a license key offline.
 * @param {string} key
 * @returns {{ valid: boolean, tier: string|null, expiry: Date|null, expired: boolean }}
 */
function validateKey (key) {
    const result = { valid: false, tier: null, expiry: null, expired: false }

    if (!key || !KEY_PATTERN.test(key)) return result

    const parts = key.split('-')
    // parts: ['TLINK', seg1, seg2, seg3, seg4]
    if (parts.length !== 5 || parts[0] !== 'TLINK') return result

    const [, seg1, seg2, seg3, seg4] = parts

    // Verify checksum
    const expectedChecksum = computeChecksum(seg1, seg2, seg3)
    if (seg4 !== expectedChecksum) return result

    // Decode tier
    const tier = decodeTier(seg1)
    if (!tier) return result

    // Decode expiry
    const expiry = decodeExpiry(seg2)
    if (!expiry) return result

    result.valid = true
    result.tier = tier
    result.expiry = expiry
    result.expired = expiry.getTime() < Date.now()

    return result
}

// ── Log management ──────────────────────────────────────────────────────────

function ensureLog () {
    if (!fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(LOG_FILE, 'key,tier,expiry,customer,created,status\n')
    }
}

function listKeys () {
    ensureLog()
    const content = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n')
    if (content.length <= 1) {
        console.log('No license keys generated yet.')
        return
    }
    console.log('')
    console.log('  Tlink NetOps — License Keys')
    console.log('  ─────────────────────────────────────────────────────────────────')
    const header = [
        'KEY'.padEnd(30), 'TIER'.padEnd(12), 'EXPIRY'.padEnd(12), 'CUSTOMER'.padEnd(20), 'STATUS'
    ].join(' ')
    console.log(`  ${header}`)
    console.log('  ─────────────────────────────────────────────────────────────────')
    for (let i = 1; i < content.length; i++) {
        const [key, tier, expiry, customer, created, status] = content[i].split(',')
        const row = [
            (key || '').padEnd(30), (tier || '').padEnd(12), (expiry || '').padEnd(12),
            (customer || '').padEnd(20), status || ''
        ].join(' ')
        console.log(`  ${row}`)
    }
    console.log('')
}

function revokeKey (targetKey) {
    ensureLog()
    const content = fs.readFileSync(LOG_FILE, 'utf-8')
    if (!content.includes(targetKey)) {
        console.error(`ERROR: Key not found in log: ${targetKey}`)
        process.exit(1)
    }
    const updated = content.replace(
        new RegExp(`^(${targetKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},.*),active$`, 'm'),
        '$1,revoked'
    )
    fs.writeFileSync(LOG_FILE, updated)
    console.log(`Key revoked: ${targetKey}`)
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function cli () {
    const args = process.argv.slice(2)
    let tier = '', expiry = '', customer = ''
    let doList = false, revokeTarget = ''

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--tier':     tier = args[++i]; break
            case '--expiry':   expiry = args[++i]; break
            case '--customer': customer = args[++i]; break
            case '--list':     doList = true; break
            case '--revoke':   revokeTarget = args[++i]; break
            case '-h': case '--help':
                console.log('Usage:')
                console.log('  node generate-license.js --tier pro|enterprise --expiry YYYY-MM-DD --customer "Name"')
                console.log('  node generate-license.js --list')
                console.log('  node generate-license.js --revoke TLINK-XXXX-XXXX-XXXX-XXXX')
                process.exit(0)
                break
            default:
                console.error(`Unknown argument: ${args[i]}`)
                process.exit(1)
        }
    }

    if (doList) { listKeys(); return }
    if (revokeTarget) { revokeKey(revokeTarget); return }

    if (!tier || !expiry || !customer) {
        console.error('Required: --tier, --expiry, --customer (use --help for usage)')
        process.exit(1)
    }

    if (tier !== 'pro' && tier !== 'enterprise') {
        console.error(`Invalid tier: ${tier} (must be 'pro' or 'enterprise')`)
        process.exit(1)
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
        console.error(`Invalid expiry format: ${expiry} (expected YYYY-MM-DD)`)
        process.exit(1)
    }

    const key = generateKey(tier, expiry, customer)

    // Log it
    ensureLog()
    const created = new Date().toISOString()
    fs.appendFileSync(LOG_FILE, `${key},${tier},${expiry},${customer},${created},active\n`)

    console.log('')
    console.log('  Tlink NetOps — License Key Generated')
    console.log('  ─────────────────────────────────────')
    console.log(`  Key:      ${key}`)
    console.log(`  Tier:     ${tier}`)
    console.log(`  Expiry:   ${expiry}`)
    console.log(`  Customer: ${customer}`)
    console.log(`  Created:  ${created}`)
    console.log('')
}

// ── Export / Run ─────────────────────────────────────────────────────────────

module.exports = { generateKey, validateKey }

if (require.main === module) {
    cli()
}
