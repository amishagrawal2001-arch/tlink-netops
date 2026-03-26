// ═══════════════════════════════════════════════════════════════════════════════
// Standard SNMP MIB-2 OIDs + vendor-specific enterprise OIDs.
// Used by SNMP polling to know which OIDs to GET/WALK per vendor.
// ═══════════════════════════════════════════════════════════════════════════════

export interface SnmpOidSet {
    sysDescr: string
    sysName: string
    sysUpTime: string
    ifTable: string        // ifEntry OID for WALK
    ifOperStatus: string
    cpuLoad?: string       // vendor-specific CPU utilization OID
    memoryUsed?: string    // vendor-specific memory usage OID
}

// ── Standard MIB-2 OIDs ─────────────────────────────────────────────────────

const BASE: SnmpOidSet = {
    sysDescr:     '1.3.6.1.2.1.1.1.0',
    sysName:      '1.3.6.1.2.1.1.5.0',
    sysUpTime:    '1.3.6.1.2.1.1.3.0',
    ifTable:      '1.3.6.1.2.1.2.2.1',
    ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
}

// ── Vendor-specific OID extensions ──────────────────────────────────────────

export const SNMP_OIDS: Record<string, SnmpOidSet> = {
    // Cisco
    cisco: {
        ...BASE,
        cpuLoad:    '1.3.6.1.4.1.9.9.109.1.1.1.1.8.1',    // cpmCPUTotal5minRev
        memoryUsed: '1.3.6.1.4.1.9.9.48.1.1.1.5.1',        // ciscoMemoryPoolUsed
    },

    // Juniper
    juniper: {
        ...BASE,
        cpuLoad:    '1.3.6.1.4.1.2636.3.1.13.1.8.9.1.0.0', // jnxOperatingCPU
        memoryUsed: '1.3.6.1.4.1.2636.3.1.13.1.11.9.1.0.0', // jnxOperatingBuffer
    },

    // Arista
    arista: {
        ...BASE,
        cpuLoad:    '1.3.6.1.2.1.25.3.3.1.2.1',            // hrProcessorLoad
        memoryUsed: '1.3.6.1.2.1.25.2.3.1.6.1',            // hrStorageUsed
    },

    // Nokia SR-OS
    nokia: {
        ...BASE,
        cpuLoad:    '1.3.6.1.4.1.6527.3.1.2.1.1.1.1.4.1',  // tmnxChassisCPUUsage
        memoryUsed: '1.3.6.1.4.1.6527.3.1.2.1.1.1.1.12.1',  // tmnxChassisMemoryUsed
    },

    // SONiC (uses standard HOST-RESOURCES MIB)
    sonic: {
        ...BASE,
        cpuLoad:    '1.3.6.1.2.1.25.3.3.1.2.1',
        memoryUsed: '1.3.6.1.2.1.25.2.3.1.6.1',
    },

    // HPE / Aruba
    hpe: {
        ...BASE,
        cpuLoad:    '1.3.6.1.4.1.11.2.14.11.5.1.9.6.1.0',
        memoryUsed: '1.3.6.1.4.1.11.2.14.11.5.1.1.2.2.1.1.7.1',
    },

    // Huawei
    huawei: {
        ...BASE,
        cpuLoad:    '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5.67108873',
        memoryUsed: '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.7.67108873',
    },

    // Dell
    dell: {
        ...BASE,
        cpuLoad:    '1.3.6.1.4.1.674.10895.5000.2.6132.1.1.1.1.4.9.0',
        memoryUsed: '1.3.6.1.4.1.674.10895.5000.2.6132.1.1.1.1.4.1.0',
    },

    // MikroTik
    mikrotik: {
        ...BASE,
        cpuLoad:    '1.3.6.1.2.1.25.3.3.1.2.1',
        memoryUsed: '1.3.6.1.2.1.25.2.3.1.6.65536',
    },

    // Extreme Networks
    extreme: {
        ...BASE,
        cpuLoad:    '1.3.6.1.4.1.1916.1.32.1.2.0',
        memoryUsed: '1.3.6.1.4.1.1916.1.32.2.2.0',
    },
}

// ── Lookup helper ────────────────────────────────────────────────────────────

export function getSnmpOids (vendor?: string): SnmpOidSet {
    if (!vendor) { return BASE }
    const key = vendor.toLowerCase()
    return SNMP_OIDS[key] ?? BASE
}
