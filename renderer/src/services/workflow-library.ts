// ═════════════════════════════════════════════════════════════════════════════
// Workflow Library — pre-built parameterized playbooks for common ops tasks.
//
// Each PlaybookTemplate declares:
//   - human metadata (name, description, category, icon)
//   - the vendors it supports (empty = vendor-agnostic)
//   - a typed parameter list the UI renders as a form
//   - a `buildSteps(params, vendor)` function that returns the WorkflowStep[]
//     to execute (typically `run_command` steps with vendor-correct syntax)
//
// The library is a plain data module — no Angular DI. Components import
// PLAYBOOKS, render the catalog, collect user input, then call the existing
// WorkflowService.executeWorkflow() with the synthesized Workflow.
// ═════════════════════════════════════════════════════════════════════════════

import { WorkflowStep } from './workflow.service'
import { TopologyNode, DeviceStagingConfig } from '../api/interfaces'
import { mergeStaging, renderStagingConfig, buildStagingPushCommands, isSupportedStagingVendor } from './vendor-staging-builder'

/** Optional context handed to buildSteps for playbooks that need to look at
 *  the target node's full record (e.g. per-node staging overrides) or the
 *  topology-wide staging defaults to merge against. Existing playbooks can
 *  ignore this argument. */
export interface BuildStepsContext {
    node?: TopologyNode
    topologyStaging?: DeviceStagingConfig
}

export type PlaybookCategory =
    | 'Interface'
    | 'VLAN'
    | 'BGP'
    | 'Maintenance'
    | 'Diagnostics'
    | 'Backup'

export interface PlaybookParam {
    name: string                    // key — keys params record passed to buildSteps
    label: string                   // form label
    type: 'text' | 'number' | 'select' | 'textarea'
    required?: boolean
    default?: any
    placeholder?: string
    help?: string
    options?: Array<{ value: any; label: string }>  // for type='select'
}

export interface PlaybookTemplate {
    id: string
    name: string
    description: string
    category: PlaybookCategory
    icon: string                    // emoji or short symbol shown in the list
    /** Vendors this playbook supports. Empty array = vendor-agnostic
     *  (treated as supports-everything for filtering purposes). */
    vendors: string[]
    /** True if the playbook makes config changes (vs read-only diagnostic).
     *  Used to surface a "destructive" warning before run. */
    destructive: boolean
    parameters: PlaybookParam[]
    /** Generate the executable steps for a given parameter set + target vendor.
     *  Should return run_command (or other) WorkflowStep entries that, when
     *  executed against a target node, accomplish the playbook's intent. */
    buildSteps: (params: Record<string, any>, vendor: string, ctx?: BuildStepsContext) => WorkflowStep[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const cmd = (command: string, continueOnError = false): WorkflowStep => ({
    action: 'run_command',
    config: { command },
    continueOnError,
})

/** Wrap a Junos config patch so it commits in one step via cli -c. */
const junosConfig = (setLines: string[]): string => {
    const body = setLines.map(l => l.startsWith('set ') ? l : `set ${l}`).join('; ')
    return `configure private; ${body}; commit and-quit`
}

/** Wrap an IOS-style config patch with conf t / end / wr mem. */
const iosConfig = (lines: string[]): string => {
    return ['configure terminal', ...lines, 'end', 'write memory'].join('\n')
}

const isJuniper  = (v: string): boolean => /^juniper/i.test(v)
const isCisco    = (v: string): boolean => /^cisco|nxos|iosxr/i.test(v)
const isArista   = (v: string): boolean => /^arista/i.test(v)
const isNokia    = (v: string): boolean => /^nokia/i.test(v)
const isHuawei   = (v: string): boolean => /^huawei/i.test(v)
const isMikrotik = (v: string): boolean => /^mikrotik/i.test(v)
const isFortinet = (v: string): boolean => /^fortinet/i.test(v)
const isSonic    = (v: string): boolean => /^sonic/i.test(v)
const isHpe      = (v: string): boolean => /^hpe/i.test(v)        // Comware
const isDell     = (v: string): boolean => /^dell/i.test(v)       // OS10
const isExtreme  = (v: string): boolean => /^extreme/i.test(v)    // EXOS

/** Generic "IOS-like" group — accepts `configure terminal / interface X /
 *  shutdown / end / write memory` style. Covers Cisco IOS/NX-OS/IOS-XR,
 *  Arista EOS, HPE Comware (close), Dell OS10. Not always identical (HPE
 *  uses `system-view` in some places, IOS-XR uses `commit`), but for
 *  bread-and-butter interface ops the Cisco template runs cleanly. */
const isIosLike  = (v: string): boolean => isCisco(v) || isArista(v) || isHpe(v) || isDell(v)

/** Huawei VRP — `system-view` + body + `quit` (+ save force). */
const huaweiConfig = (lines: string[]): string =>
    ['system-view', ...lines, 'quit', 'save force'].join('\n')

/** HPE Comware — `system-view` + body + `quit` (+ save force).
 *  Comware syntax overlaps VRP but isn't identical for a few commands. */
const hpeConfig = (lines: string[]): string =>
    ['system-view', ...lines, 'quit', 'save force'].join('\n')

/** Nokia SR OS classic CLI — `configure` mode with `commit`. */
const nokiaConfig = (lines: string[]): string =>
    ['enter candidate', ...lines, 'commit'].join('; ')

/** Extreme XOS — single-line `configure …` commands, no modal CLI. */
const exosCmd = (cmd: string): string => cmd

/** MikroTik RouterOS — already single-line; this is a marker. */
const mikrotikCmd = (cmd: string): string => cmd

// ─────────────────────────────────────────────────────────────────────────────
// Library
// ─────────────────────────────────────────────────────────────────────────────

export const PLAYBOOKS: PlaybookTemplate[] = [

    // ── Interface operations ────────────────────────────────────────────────

    {
        id: 'iface-shut',
        name: 'Shut Interface',
        description: 'Administratively disable an interface.',
        category: 'Interface',
        icon: '⏼',
        vendors: ['juniper', 'cisco', 'arista', 'nokia', 'huawei', 'hpe', 'dell', 'mikrotik', 'extreme', 'sonic'],
        destructive: true,
        parameters: [
            { name: 'iface', label: 'Interface', type: 'text', required: true,
              placeholder: 'et-0/0/5, Gi0/0/1, or Ethernet0', help: 'Vendor-correct port name' },
        ],
        buildSteps: ({ iface }, vendor) => {
            if (isJuniper(vendor)) return [cmd(junosConfig([`interfaces ${iface} disable`]))]
            if (isIosLike(vendor)) return [cmd(iosConfig([`interface ${iface}`, ' shutdown']))]
            if (isNokia(vendor))   return [cmd(`enter candidate; configure interface ${iface} admin-state disable; commit`)]
            if (isHuawei(vendor))  return [cmd(huaweiConfig([`interface ${iface}`, ' shutdown']))]
            if (isExtreme(vendor)) return [cmd(exosCmd(`disable port ${iface}`))]
            if (isMikrotik(vendor))return [cmd(`/interface set [find name="${iface}"] disabled=yes`)]
            if (isSonic(vendor))   return [cmd(`sudo config interface shutdown ${iface}`)]
            return [cmd(`# unsupported vendor ${vendor} — manual: shut ${iface}`)]
        },
    },

    {
        id: 'iface-no-shut',
        name: 'No-Shut Interface',
        description: 'Administratively re-enable an interface.',
        category: 'Interface',
        icon: '▶',
        vendors: ['juniper', 'cisco', 'arista', 'nokia', 'huawei', 'hpe', 'dell', 'mikrotik', 'extreme', 'sonic'],
        destructive: true,
        parameters: [
            { name: 'iface', label: 'Interface', type: 'text', required: true },
        ],
        buildSteps: ({ iface }, vendor) => {
            if (isJuniper(vendor)) return [cmd(junosConfig([`delete interfaces ${iface} disable`]))]
            if (isIosLike(vendor)) return [cmd(iosConfig([`interface ${iface}`, ' no shutdown']))]
            if (isNokia(vendor))   return [cmd(`enter candidate; configure interface ${iface} admin-state enable; commit`)]
            if (isHuawei(vendor))  return [cmd(huaweiConfig([`interface ${iface}`, ' undo shutdown']))]
            if (isExtreme(vendor)) return [cmd(exosCmd(`enable port ${iface}`))]
            if (isMikrotik(vendor))return [cmd(`/interface set [find name="${iface}"] disabled=no`)]
            if (isSonic(vendor))   return [cmd(`sudo config interface startup ${iface}`)]
            return [cmd(`# unsupported vendor ${vendor}`)]
        },
    },

    {
        id: 'iface-mtu',
        name: 'Set Interface MTU',
        description: 'Update the MTU on a single interface (e.g. 9216 jumbo).',
        category: 'Interface',
        icon: '↔',
        vendors: ['juniper', 'cisco', 'arista', 'nokia', 'huawei', 'hpe', 'dell', 'mikrotik', 'sonic', 'extreme'],
        destructive: true,
        parameters: [
            { name: 'iface', label: 'Interface', type: 'text', required: true },
            { name: 'mtu',   label: 'MTU bytes', type: 'number', required: true,
              default: 9216, help: 'Common values: 1500 (default), 9000, 9216 (jumbo)' },
        ],
        buildSteps: ({ iface, mtu }, vendor) => {
            const m = Number(mtu) || 9216
            if (isJuniper(vendor)) return [cmd(junosConfig([`interfaces ${iface} mtu ${m}`]))]
            if (isIosLike(vendor)) return [cmd(iosConfig([`interface ${iface}`, ` mtu ${m}`]))]
            if (isNokia(vendor))   return [cmd(`enter candidate; configure interface ${iface} mtu ${m}; commit`)]
            if (isHuawei(vendor))  return [cmd(huaweiConfig([`interface ${iface}`, ` jumboframe enable ${m}`]))]
            if (isMikrotik(vendor))return [cmd(`/interface set [find name="${iface}"] mtu=${m}`)]
            if (isSonic(vendor))   return [cmd(`sudo config interface mtu ${iface} ${m}`)]
            if (isExtreme(vendor)) {
                // EXOS jumbo is global, but per-port MTU IS settable in newer
                // versions via `configure ports X jumbo enable mtu N`. Older
                // versions just have the global setting. We emit per-port and
                // let the device reject if unsupported.
                return [cmd(`configure ports ${iface} jumbo enable mtu ${m}`)]
            }
            return [cmd(`# unsupported vendor ${vendor}`)]
        },
    },

    {
        id: 'iface-description',
        name: 'Set Interface Description',
        description: 'Update an interface description (free-text label).',
        category: 'Interface',
        icon: '✎',
        vendors: ['juniper', 'cisco', 'arista', 'nokia', 'huawei', 'hpe', 'dell', 'mikrotik', 'sonic', 'extreme'],
        destructive: true,
        parameters: [
            { name: 'iface', label: 'Interface', type: 'text', required: true },
            { name: 'desc',  label: 'Description', type: 'text', required: true,
              placeholder: 'e.g. Uplink to spine-1' },
        ],
        buildSteps: ({ iface, desc }, vendor) => {
            const d = String(desc).replace(/"/g, '\\"')
            if (isJuniper(vendor)) return [cmd(junosConfig([`interfaces ${iface} description "${d}"`]))]
            if (isIosLike(vendor)) return [cmd(iosConfig([`interface ${iface}`, ` description ${d}`]))]
            if (isNokia(vendor))   return [cmd(`enter candidate; configure interface ${iface} description "${d}"; commit`)]
            if (isHuawei(vendor))  return [cmd(huaweiConfig([`interface ${iface}`, ` description ${d}`]))]
            if (isMikrotik(vendor))return [cmd(`/interface set [find name="${iface}"] comment="${d}"`)]
            if (isSonic(vendor))   return [cmd(`sudo config interface description ${iface} "${d}"`)]
            if (isExtreme(vendor)) return [cmd(`configure ports ${iface} display-string "${d}"`)]
            return [cmd(`# unsupported vendor ${vendor}`)]
        },
    },

    {
        id: 'iface-clear-counters',
        name: 'Clear Interface Counters',
        description: 'Reset packet/byte/error counters on an interface.',
        category: 'Diagnostics',
        icon: '⟲',
        vendors: ['juniper', 'cisco', 'arista', 'huawei', 'hpe', 'dell', 'extreme', 'sonic', 'mikrotik', 'nokia'],
        destructive: false,
        parameters: [
            { name: 'iface', label: 'Interface (optional, blank = all)', type: 'text', required: false,
              placeholder: 'et-0/0/5 — leave blank to clear all' },
        ],
        buildSteps: ({ iface }, vendor) => {
            const target = iface ? String(iface) : ''
            if (isJuniper(vendor)) {
                return [cmd(target ? `clear interfaces statistics ${target}` : 'clear interfaces statistics all')]
            }
            if (isIosLike(vendor)) {
                return [cmd(target ? `clear counters ${target}` : 'clear counters')]
            }
            if (isHuawei(vendor)) {
                return [cmd(target ? `reset counters interface ${target}` : 'reset counters interface')]
            }
            if (isExtreme(vendor)) {
                return [cmd(target ? `clear counters ports ${target}` : 'clear counters ports all')]
            }
            if (isSonic(vendor)) {
                // sonic-clear is a global zero — no per-interface variant.
                // We emit the global clear regardless of `target`.
                return [cmd('sonic-clear counters')]
            }
            if (isMikrotik(vendor)) {
                return [cmd(target
                    ? `/interface reset-counters [find name="${target}"]`
                    : '/interface reset-counters-all')]
            }
            if (isNokia(vendor)) {
                return [cmd(target
                    ? `clear interface ${target} statistics`
                    : 'clear interface all statistics')]
            }
            return [cmd(`# unsupported vendor ${vendor}`)]
        },
    },

    // ── VLAN operations ─────────────────────────────────────────────────────

    {
        id: 'vlan-add',
        name: 'Add VLAN',
        description: 'Create a VLAN (with optional name) on the device.',
        category: 'VLAN',
        icon: '➕',
        vendors: ['juniper', 'cisco', 'arista', 'sonic', 'huawei', 'hpe', 'dell', 'extreme', 'mikrotik'],
        destructive: true,
        parameters: [
            { name: 'vlanId', label: 'VLAN ID', type: 'number', required: true,
              placeholder: '100', help: '1-4094' },
            { name: 'vlanName', label: 'VLAN name', type: 'text', required: false,
              placeholder: 'optional' },
            { name: 'mikrotikIface', label: 'MikroTik parent iface', type: 'text', required: false,
              default: 'bridge1',
              help: 'Required for MikroTik only — the parent bridge or interface.' },
        ],
        buildSteps: ({ vlanId, vlanName, mikrotikIface }, vendor) => {
            const id = Number(vlanId)
            const name = (vlanName || `vlan${id}`).replace(/[^A-Za-z0-9_-]/g, '_')
            if (isJuniper(vendor)) {
                return [cmd(junosConfig([`vlans ${name} vlan-id ${id}`]))]
            }
            if (isArista(vendor) || isCisco(vendor)) {
                const lines = [`vlan ${id}`]
                if (vlanName) { lines.push(` name ${name}`) }
                return [cmd(iosConfig(lines))]
            }
            if (isSonic(vendor))   return [cmd(`sudo config vlan add ${id}`)]
            if (isHuawei(vendor))  return [cmd(huaweiConfig([`vlan ${id}`]))]
            if (isHpe(vendor))     return [cmd(hpeConfig([`vlan ${id}`, vlanName ? ` name ${name}` : '']))]
            if (isDell(vendor))    return [cmd(iosConfig([`interface vlan ${id}`]))]   // OS10 creates VLAN on first reference
            if (isExtreme(vendor)) return [cmd(`create vlan ${name} tag ${id}`)]
            if (isMikrotik(vendor)) {
                const parent = mikrotikIface || 'bridge1'
                return [cmd(`/interface vlan add interface=${parent} vlan-id=${id} name=${name}`)]
            }
            return [cmd(`# unsupported vendor ${vendor}`)]
        },
    },

    {
        id: 'vlan-remove',
        name: 'Remove VLAN',
        description: 'Delete a VLAN definition from the device.',
        category: 'VLAN',
        icon: '✕',
        vendors: ['juniper', 'cisco', 'arista', 'sonic', 'huawei', 'hpe', 'dell', 'extreme', 'mikrotik'],
        destructive: true,
        parameters: [
            { name: 'vlanId', label: 'VLAN ID', type: 'number', required: true },
        ],
        buildSteps: ({ vlanId }, vendor) => {
            const id = Number(vlanId)
            if (isJuniper(vendor))  return [cmd(junosConfig([`delete vlans vlan${id}`]))]
            if (isArista(vendor) || isCisco(vendor)) return [cmd(iosConfig([`no vlan ${id}`]))]
            if (isSonic(vendor))    return [cmd(`sudo config vlan del ${id}`)]
            if (isHuawei(vendor))   return [cmd(huaweiConfig([`undo vlan ${id}`]))]
            if (isHpe(vendor))      return [cmd(hpeConfig([`undo vlan ${id}`]))]
            if (isDell(vendor))     return [cmd(iosConfig([`no interface vlan ${id}`]))]
            if (isExtreme(vendor))  return [cmd(`delete vlan vlan${id}`)]
            if (isMikrotik(vendor)) return [cmd(`/interface vlan remove [find vlan-id=${id}]`)]
            return [cmd(`# unsupported vendor ${vendor}`)]
        },
    },

    {
        id: 'vlan-add-trunk',
        name: 'Add VLAN to Trunk Port',
        description: 'Append a VLAN to an existing trunk port\'s allowed list.',
        category: 'VLAN',
        icon: '⊞',
        vendors: ['cisco', 'arista', 'sonic', 'huawei', 'hpe', 'dell', 'extreme'],
        destructive: true,
        parameters: [
            { name: 'iface',  label: 'Trunk interface', type: 'text', required: true },
            { name: 'vlanId', label: 'VLAN ID',         type: 'number', required: true },
            { name: 'tagged', label: 'Tagged?', type: 'select', required: true, default: 'tagged',
              options: [
                  { value: 'tagged',   label: 'Tagged (trunk member)' },
                  { value: 'untagged', label: 'Untagged (access)' },
              ],
              help: 'SONiC/Extreme honor this flag. Other vendors always tag on trunks.' },
        ],
        buildSteps: ({ iface, vlanId, tagged }, vendor) => {
            const id = Number(vlanId)
            const isUntagged = tagged === 'untagged'

            if (isSonic(vendor)) {
                const flag = isUntagged ? '-u ' : ''
                return [cmd(`sudo config vlan member add ${flag}${id} ${iface}`)]
            }
            if (isHuawei(vendor)) {
                return [cmd(huaweiConfig([
                    `interface ${iface}`,
                    ' port link-type trunk',
                    ` port trunk allow-pass vlan ${id}`,
                ]))]
            }
            if (isHpe(vendor)) {
                return [cmd(hpeConfig([
                    `interface ${iface}`,
                    ' port link-type trunk',
                    ` port trunk permit vlan ${id}`,
                ]))]
            }
            if (isExtreme(vendor)) {
                const tag = isUntagged ? '' : ' tagged'
                return [cmd(`configure vlan vlan${id} add ports ${iface}${tag}`)]
            }
            if (isDell(vendor)) {
                return [cmd(iosConfig([
                    `interface ${iface}`,
                    ' switchport mode trunk',
                    ` switchport trunk allowed vlan ${id}`,
                ]))]
            }
            // Cisco/Arista
            return [cmd(iosConfig([`interface ${iface}`, ` switchport trunk allowed vlan add ${id}`]))]
        },
    },

    // ── BGP operations ──────────────────────────────────────────────────────

    {
        id: 'bgp-clear-neighbor',
        name: 'Reset BGP Neighbor',
        description: 'Soft-reset a BGP neighbor session (clears routes and re-advertises).',
        category: 'BGP',
        icon: '⟳',
        vendors: ['juniper', 'cisco', 'arista', 'sonic', 'huawei', 'hpe', 'dell', 'nokia', 'mikrotik'],
        destructive: false,
        parameters: [
            { name: 'neighbor', label: 'Neighbor IP', type: 'text', required: true,
              placeholder: '10.0.0.2' },
            { name: 'mode', label: 'Reset type', type: 'select', required: true,
              default: 'soft',
              options: [
                  { value: 'soft', label: 'Soft (no session drop)' },
                  { value: 'hard', label: 'Hard (drops the session)' },
              ] },
        ],
        buildSteps: ({ neighbor, mode }, vendor) => {
            const nbr = String(neighbor)
            const soft = mode === 'soft'
            if (isJuniper(vendor)) {
                return [cmd(soft ? `clear bgp neighbor ${nbr} soft` : `clear bgp neighbor ${nbr}`)]
            }
            if (isArista(vendor) || isCisco(vendor) || isDell(vendor)) {
                return [cmd(soft ? `clear ip bgp ${nbr} soft` : `clear ip bgp ${nbr}`)]
            }
            if (isSonic(vendor)) {
                return [cmd(soft ? `vtysh -c "clear bgp ${nbr} soft"` : `vtysh -c "clear bgp ${nbr}"`)]
            }
            if (isHuawei(vendor)) {
                // Huawei: `refresh bgp` for soft, `reset bgp` for hard
                return [cmd(soft ? `refresh bgp ${nbr} import ipv4-unicast` : `reset bgp ${nbr}`)]
            }
            if (isHpe(vendor)) {
                return [cmd(soft ? `refresh bgp ${nbr} import ipv4` : `reset bgp ${nbr}`)]
            }
            if (isNokia(vendor)) {
                // SR OS classic
                return [cmd(soft
                    ? `clear router bgp neighbor ${nbr} soft-inbound`
                    : `clear router bgp neighbor ${nbr}`)]
            }
            if (isMikrotik(vendor)) {
                // RouterOS — must reference peer by name; nbr typically is the address.
                return [cmd(`/routing bgp peer reset [find remote-address=${nbr}]`)]
            }
            return [cmd(`# unsupported vendor ${vendor}`)]
        },
    },

    {
        id: 'bgp-show-summary',
        name: 'Show BGP Summary',
        description: 'Display BGP session table — read-only.',
        category: 'BGP',
        icon: '📊',
        vendors: ['juniper', 'cisco', 'arista', 'sonic', 'huawei', 'hpe', 'dell', 'nokia', 'mikrotik', 'extreme'],
        destructive: false,
        parameters: [],
        buildSteps: (_, vendor) => {
            if (isJuniper(vendor))  return [cmd('show bgp summary')]
            if (isSonic(vendor))    return [cmd('vtysh -c "show bgp summary"')]
            if (isHuawei(vendor))   return [cmd('display bgp peer')]
            if (isHpe(vendor))      return [cmd('display bgp peer ipv4')]
            if (isNokia(vendor))    return [cmd('show router bgp summary')]
            if (isMikrotik(vendor)) return [cmd('/routing bgp peer print')]
            if (isExtreme(vendor))  return [cmd('show bgp neighbor')]
            // Cisco / Arista / Dell
            return [cmd('show ip bgp summary')]
        },
    },

    // ── Diagnostics ─────────────────────────────────────────────────────────

    {
        id: 'fortinet-system-status',
        name: 'FortiGate System Status',
        description: 'Print FortiGate hardware/software status (Fortinet-specific diagnostic).',
        category: 'Diagnostics',
        icon: '🛡',
        vendors: ['fortinet'],
        destructive: false,
        parameters: [],
        buildSteps: () => [
            cmd('get system status'),
            cmd('get system performance status'),
            cmd('diagnose hardware deviceinfo nic'),
        ],
    },

    {
        id: 'show-version',
        name: 'Show Version',
        description: 'Print device hardware/software version.',
        category: 'Diagnostics',
        icon: 'ⓘ',
        vendors: [],   // vendor-agnostic — every CLI has SOMETHING
        destructive: false,
        parameters: [],
        buildSteps: (_, vendor) => {
            if (isHuawei(vendor))   return [cmd('display version')]
            if (isMikrotik(vendor)) return [cmd('/system resource print')]
            if (isFortinet(vendor)) return [cmd('get system status')]
            // Junos / Cisco / Arista / HPE / Dell / Extreme / SONiC all accept
            return [cmd('show version')]
        },
    },

    {
        id: 'show-interfaces',
        name: 'Show Interface Status',
        description: 'List interface up/down state and counters.',
        category: 'Diagnostics',
        icon: '⇅',
        vendors: [],
        destructive: false,
        parameters: [],
        buildSteps: (_, vendor) => {
            if (isJuniper(vendor))  return [cmd('show interfaces terse')]
            if (isCisco(vendor) || isArista(vendor) || isHpe(vendor) || isDell(vendor)) {
                return [cmd('show interfaces status')]
            }
            if (isHuawei(vendor))   return [cmd('display interface brief')]
            if (isExtreme(vendor))  return [cmd('show ports')]
            if (isMikrotik(vendor)) return [cmd('/interface print')]
            if (isFortinet(vendor)) return [cmd('diagnose hardware deviceinfo nic')]
            if (isSonic(vendor))    return [cmd('show interfaces status')]
            return [cmd('show interfaces')]
        },
    },

    {
        id: 'ping-from-device',
        name: 'Ping from Device',
        description: 'Run a ping from the device to a target IP.',
        category: 'Diagnostics',
        icon: '⤳',
        vendors: ['juniper', 'cisco', 'arista', 'nokia', 'huawei', 'hpe', 'dell', 'mikrotik', 'extreme', 'sonic'],
        destructive: false,
        parameters: [
            { name: 'target', label: 'Target IP/hostname', type: 'text', required: true,
              placeholder: '8.8.8.8' },
            { name: 'count',  label: 'Count', type: 'number', default: 5 },
        ],
        buildSteps: ({ target, count }, vendor) => {
            const c = Number(count) || 5
            if (isJuniper(vendor))  return [cmd(`ping ${target} count ${c} rapid`)]
            if (isHuawei(vendor))   return [cmd(`ping -c ${c} ${target}`)]
            if (isMikrotik(vendor)) return [cmd(`/ping count=${c} address=${target}`)]
            if (isExtreme(vendor))  return [cmd(`ping count ${c} ${target}`)]
            if (isSonic(vendor))    return [cmd(`ping -c ${c} ${target}`)]   // Linux ping
            // Cisco/Arista/HPE/Dell/Nokia all accept `ping … repeat N`
            return [cmd(`ping ${target} repeat ${c}`)]
        },
    },

    // ── Backup / Maintenance ────────────────────────────────────────────────

    {
        id: 'backup-now',
        name: 'Backup Running Config',
        description: 'Save a snapshot of the running configuration to the inventory backup history.',
        category: 'Backup',
        icon: '🗄',
        vendors: [],
        destructive: false,
        parameters: [],
        buildSteps: () => [{
            action: 'backup_config',
            config: { configType: 'running' },
            continueOnError: false,
        }],
    },

    {
        id: 'approval-gate',
        name: 'Approval Gate (test)',
        description: 'Pause for operator approval — useful for testing the gate dialog. In real use, prepend an approval step to any destructive playbook.',
        category: 'Maintenance',
        icon: '⏸',
        vendors: [],
        destructive: false,
        parameters: [
            { name: 'message', label: 'Approval message', type: 'text', required: true,
              default: 'Please confirm this change before it proceeds.',
              help: 'Shown to the operator in the Pending Approvals panel.' },
            { name: 'gate', label: 'Gate name', type: 'text', required: false,
              default: 'Manual Review',
              help: 'Short label categorizing the approval (e.g. "Production change").' },
            { name: 'timeoutMinutes', label: 'Auto-reject after (minutes)', type: 'number', required: false,
              default: 60,
              help: '0 = wait forever. Otherwise auto-rejects after this many minutes.' },
        ],
        buildSteps: ({ message, gate, timeoutMinutes }) => [{
            action: 'approval',
            config: { message, gate, timeoutMinutes: Number(timeoutMinutes) || 0 },
            continueOnError: false,
        }],
    },

    {
        id: 'notify-webhook',
        name: 'Notify Webhook',
        description: 'POST a JSON payload to an HTTP endpoint (Slack, Teams, custom listener).',
        category: 'Maintenance',
        icon: '📡',
        vendors: [],
        destructive: false,
        parameters: [
            { name: 'url', label: 'Webhook URL', type: 'text', required: true,
              placeholder: 'https://hooks.slack.com/services/...',
              help: 'Slack/Teams incoming webhook, or any HTTP POST endpoint.' },
            { name: 'message', label: 'Message text', type: 'text', required: true,
              default: 'Workflow ran from NetOps' },
            { name: 'method', label: 'HTTP method', type: 'select', default: 'POST',
              options: [
                  { value: 'POST', label: 'POST' },
                  { value: 'PUT',  label: 'PUT' },
              ] },
        ],
        buildSteps: ({ url, message, method }) => [{
            action: 'webhook',
            config: {
                url, method,
                payload: { text: message },     // Slack-compatible
            },
            continueOnError: true,             // notification failures shouldn't fail the workflow
        }],
    },

    {
        id: 'apply-staging-only',
        name: 'Apply Staging Only',
        description: 'Push just the Day-0 staging block (NTP, SNMP, LLDP, Syslog, DNS, AAA, Banner) — fabric protocols are NOT touched. Per-node overrides merge over fabric defaults. Useful for onboarding new devices or rolling out an SNMP/syslog change without re-pushing routing config.',
        category: 'Maintenance',
        icon: '🛠',
        vendors: ['juniper', 'cisco', 'arista', 'huawei', 'hpe', 'dell', 'sonic', 'nokia', 'extreme', 'mikrotik'],
        destructive: true,
        parameters: [
            { name: 'commitAfter', label: 'Commit/save after push', type: 'select', default: 'yes',
              options: [
                  { value: 'yes', label: 'Yes — persist to startup' },
                  { value: 'no',  label: 'No — running config only' },
              ],
              help: 'When yes, appends a vendor-appropriate write/commit step.' },
            { name: 'preview', label: 'Preview only (dry-run)', type: 'select', default: 'no',
              options: [
                  { value: 'no',  label: 'No — push for real' },
                  { value: 'yes', label: 'Yes — log lines but do not apply' },
              ],
              help: 'Dry-run renders the staging block and emits it as a `log` step instead of pushing.' },
        ],
        buildSteps: ({ commitAfter, preview }, vendor, ctx) => {
            const nodeLabel = ctx?.node?.label ?? 'node'

            // Refuse unsupported vendors up-front — distinct from "no staging configured".
            if (!isSupportedStagingVendor(vendor || '')) {
                return [{
                    action: 'log',
                    config: { message: `[apply-staging-only] ${nodeLabel}: vendor '${vendor || '(none)'}' not yet supported by the staging builder — skipping.` },
                    continueOnError: true,
                }]
            }

            // Merge fabric staging with per-node override.
            const fabric  = ctx?.topologyStaging
            const perNode = (ctx?.node as any)?.staging as DeviceStagingConfig | undefined
            const merged  = mergeStaging(fabric, perNode)

            // Dry-run mode: log the rendered block, do not push.
            if (preview === 'yes') {
                const block = renderStagingConfig(vendor || '', merged)
                if (!block.trim()) {
                    return [{
                        action: 'log',
                        config: { message: `[apply-staging-only] ${nodeLabel}: no staging configured — skipping.` },
                        continueOnError: true,
                    }]
                }
                return [{
                    action: 'log',
                    config: { message: `[apply-staging-only DRY-RUN ${nodeLabel}]\n${block}` },
                    continueOnError: true,
                }]
            }

            // Real push: use the shared command builder so this stays in lock-step
            // with the per-node "Push Staging" button and the bulk Devices menu action.
            const cmds = buildStagingPushCommands(vendor || '', merged, {
                commitAfter: commitAfter !== 'no',
            })
            if (!cmds.length) {
                return [{
                    action: 'log',
                    config: { message: `[apply-staging-only] ${nodeLabel}: no staging configured — skipping.` },
                    continueOnError: true,
                }]
            }

            // Junos commits via a single `cli -c` invocation; everything else
            // streams the wrapped command list into the device's CLI.
            if (isJuniper(vendor)) {
                const body = cmds
                    .filter(c => c !== 'configure private' && c !== 'commit and-quit')
                    .join('; ')
                return [cmd(`cli -c "configure private; ${body}; commit and-quit"`)]
            }
            return [cmd(cmds.join('\n'))]
        },
    },

    {
        id: 'commit-save',
        name: 'Save Running to Startup',
        description: 'Persist the running config so it survives reboot.',
        category: 'Maintenance',
        icon: '💾',
        vendors: ['juniper', 'cisco', 'arista', 'huawei', 'hpe', 'dell', 'sonic', 'nokia', 'extreme', 'mikrotik'],
        destructive: false,
        parameters: [],
        buildSteps: (_, vendor) => {
            if (isJuniper(vendor)) return [cmd('cli -c "configure exclusive; commit; exit"')]
            if (isArista(vendor) || isCisco(vendor) || isDell(vendor)) {
                return [cmd('write memory')]
            }
            if (isHpe(vendor))      return [cmd('save force')]    // Comware
            if (isHuawei(vendor))   return [cmd('save force')]
            if (isSonic(vendor))    return [cmd('sudo config save -y')]
            if (isNokia(vendor))    return [cmd('admin save')]
            if (isExtreme(vendor))  return [cmd('save configuration')]
            if (isMikrotik(vendor)) return [cmd('/system backup save name=netops-snapshot')]
            return [cmd(`# unsupported vendor ${vendor}`)]
        },
    },

    {
        id: 'clear-arp-host',
        name: 'Clear ARP Entry',
        description: 'Remove a single ARP entry for a host.',
        category: 'Diagnostics',
        icon: '🗑',
        vendors: ['juniper', 'cisco', 'arista', 'sonic', 'huawei', 'hpe', 'dell', 'nokia', 'extreme', 'mikrotik'],
        destructive: false,
        parameters: [
            { name: 'ip', label: 'Host IP', type: 'text', required: true },
        ],
        buildSteps: ({ ip }, vendor) => {
            if (isJuniper(vendor))  return [cmd(`clear arp hostname ${ip}`)]
            if (isSonic(vendor))    return [cmd(`sonic-clear arp ${ip}`)]
            if (isHuawei(vendor))   return [cmd(`reset arp dynamic ${ip}`)]
            if (isHpe(vendor))      return [cmd(`reset arp ip ${ip}`)]
            if (isNokia(vendor))    return [cmd(`clear router arp ${ip}`)]
            if (isExtreme(vendor))  return [cmd(`clear iparp ${ip}`)]
            if (isMikrotik(vendor)) return [cmd(`/ip arp remove [find address=${ip}]`)]
            // Cisco / Arista / Dell
            return [cmd(`clear arp-cache ${ip}`)]
        },
    },
]

// ── Catalog helpers ──────────────────────────────────────────────────────────

/** Group playbooks by category (preserves library order within each group). */
export function groupByCategory (
    list: PlaybookTemplate[] = PLAYBOOKS,
): Array<{ category: PlaybookCategory; items: PlaybookTemplate[] }> {
    const map = new Map<PlaybookCategory, PlaybookTemplate[]>()
    for (const p of list) {
        if (!map.has(p.category)) { map.set(p.category, []) }
        map.get(p.category)!.push(p)
    }
    // Stable display order
    const order: PlaybookCategory[] = ['Interface', 'VLAN', 'BGP', 'Diagnostics', 'Backup', 'Maintenance']
    return order
        .filter(c => map.has(c))
        .map(category => ({ category, items: map.get(category)! }))
}

/** Find a playbook by its id; undefined if unknown. */
export function getPlaybook (id: string): PlaybookTemplate | undefined {
    return PLAYBOOKS.find(p => p.id === id)
}

/** Filter for free-text matches across name/description/category. */
export function searchPlaybooks (q: string, list: PlaybookTemplate[] = PLAYBOOKS): PlaybookTemplate[] {
    const term = q.trim().toLowerCase()
    if (!term) { return list }
    return list.filter(p =>
        p.name.toLowerCase().includes(term) ||
        p.description.toLowerCase().includes(term) ||
        p.category.toLowerCase().includes(term) ||
        p.id.includes(term),
    )
}
