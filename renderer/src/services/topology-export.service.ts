import { Injectable } from '@angular/core'
import { Topology, TopologyNode, NodeRole } from '../api/interfaces'

/** Maps vendor strings to Ansible network_os values */
const VENDOR_TO_NETWORK_OS: Record<string, string> = {
    'Juniper':  'junos',
    'juniper':  'junos',
    'cRPD':     'junos',
    'Cisco':    'ios',
    'cisco':    'ios',
    'Cisco NX-OS': 'nxos',
    'Cisco IOS-XR': 'iosxr',
    'Arista':   'eos',
    'arista':   'eos',
    'Nokia':    'srl',
    'nokia':    'srl',
    'Nokia SR Linux': 'srl',
    'SONiC':    'sonic',
    'sonic':    'sonic',
    'Cumulus':  'community.network.ce',
    'cumulus':  'community.network.ce',
}

/** Maps vendor strings to Ansible config module names */
const VENDOR_TO_CONFIG_MODULE: Record<string, string> = {
    'junos':  'junipernetworks.junos.junos_config',
    'ios':    'cisco.ios.ios_config',
    'nxos':   'cisco.nxos.nxos_config',
    'iosxr':  'cisco.iosxr.iosxr_config',
    'eos':    'arista.eos.eos_config',
    'srl':    'nokia.srlinux.config',
    'sonic':  'community.general.raw',
}

/** Maps vendor strings to Terraform provider names */
const VENDOR_TO_TF_PROVIDER: Record<string, { source: string; version: string }> = {
    'junos':  { source: 'jeremmfr/junos',       version: '~> 2.0' },
    'ios':    { source: 'CiscoDevNet/ios',       version: '~> 0.1' },
    'nxos':   { source: 'CiscoDevNet/nxos',      version: '~> 0.5' },
    'iosxr':  { source: 'CiscoDevNet/iosxr',     version: '~> 0.1' },
    'eos':    { source: 'aristanetworks/cloudeos', version: '~> 1.0' },
    'srl':    { source: 'nokia/srlinux',          version: '~> 0.4' },
}

/** Role to Ansible group name mapping */
function roleToGroup (role?: NodeRole): string {
    if (!role) { return 'ungrouped' }
    switch (role) {
        case 'spine':       return 'spines'
        case 'super-spine': return 'super_spines'
        case 'leaf':        return 'leafs'
        case 'border-leaf': return 'border_leafs'
        case 'tor':         return 'tors'
        case 'gateway':     return 'gateways'
        case 'core':        return 'core'
        case 'aggregation': return 'aggregation'
        case 'access':      return 'access'
        default:            return 'ungrouped'
    }
}

/** Strip CIDR suffix from an IP address */
function stripCidr (ip: string): string {
    return ip.split('/')[0]
}

/** Resolve vendor string to ansible network_os */
function resolveNetworkOs (node: TopologyNode): string {
    const vendor = node.vendor ?? ''
    const family = node.switchFamily ?? ''
    // Check for specific Cisco families first
    if (family === 'Nexus' || vendor.toLowerCase().includes('nx-os')) { return 'nxos' }
    if (family === 'ASR' || family === 'ISR' || vendor.toLowerCase().includes('ios-xr')) { return 'iosxr' }
    return VENDOR_TO_NETWORK_OS[vendor] ?? 'generic'
}

@Injectable({ providedIn: 'root' })
export class TopologyExportService {

    /**
     * Generate Ansible inventory YAML from topology.
     * Groups nodes by role and includes connection details.
     */
    exportAnsibleInventory (topology: Topology): string {
        const groups = new Map<string, TopologyNode[]>()

        for (const node of topology.nodes) {
            if (node.type === 'host' || node.type === 'bridge') { continue }
            const group = roleToGroup(node.role)
            if (!groups.has(group)) { groups.set(group, []) }
            groups.get(group)!.push(node)
        }

        const lines: string[] = ['---', 'all:']

        // Global vars
        lines.push('  vars:')
        lines.push('    ansible_connection: network_cli')
        lines.push('    ansible_become: true')
        lines.push('    ansible_become_method: enable')

        if (groups.size === 0) {
            lines.push('  hosts: {}')
            return lines.join('\n')
        }

        lines.push('  children:')

        const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        for (const [group, nodes] of sortedGroups) {
            lines.push(`    ${group}:`)
            lines.push('      hosts:')
            for (const node of nodes) {
                const safe = node.label.replace(/\s+/g, '_')
                lines.push(`        ${safe}:`)
                if (node.mgmtIp) {
                    lines.push(`          ansible_host: ${stripCidr(node.mgmtIp)}`)
                }
                const nos = resolveNetworkOs(node)
                if (nos !== 'generic') {
                    lines.push(`          ansible_network_os: ${nos}`)
                }
                if (node.sshUsername) {
                    lines.push(`          ansible_user: ${node.sshUsername}`)
                }
                if (node.sshPort && node.sshPort !== 22) {
                    lines.push(`          ansible_port: ${node.sshPort}`)
                }
                if (node.vendor) {
                    lines.push(`          vendor: ${node.vendor}`)
                }
                if (node.model) {
                    lines.push(`          model: ${node.model}`)
                }
            }
        }

        return lines.join('\n')
    }

    /**
     * Generate Ansible playbook YAML for pushing startup configs to devices.
     * Uses vendor-appropriate config modules.
     */
    exportAnsiblePlaybook (topology: Topology): string {
        const configNodes = topology.nodes.filter(n =>
            n.startupConfig?.trim() && n.type !== 'host' && n.type !== 'bridge',
        )

        if (!configNodes.length) {
            return '---\n# No nodes with startup configs found'
        }

        // Group by network_os for separate plays
        const byNos = new Map<string, TopologyNode[]>()
        for (const node of configNodes) {
            const nos = resolveNetworkOs(node)
            if (!byNos.has(nos)) { byNos.set(nos, []) }
            byNos.get(nos)!.push(node)
        }

        const lines: string[] = ['---']

        for (const [nos, nodes] of byNos) {
            const module = VENDOR_TO_CONFIG_MODULE[nos] ?? 'ansible.netcommon.cli_config'
            const hostList = nodes.map(n => n.label.replace(/\s+/g, '_')).join(',')

            lines.push(`- name: Deploy config to ${nos} devices`)
            lines.push(`  hosts: ${hostList}`)
            lines.push('  gather_facts: false')
            lines.push('  tasks:')

            for (const node of nodes) {
                const safe = node.label.replace(/\s+/g, '_')
                const config = node.startupConfig!.trim()
                const escapedConfig = config.replace(/"/g, '\\"')

                lines.push(`    - name: Push config to ${safe}`)
                lines.push(`      ${module}:`)
                if (nos === 'junos') {
                    lines.push('        lines:')
                    for (const line of config.split('\n')) {
                        if (line.trim()) {
                            lines.push(`          - "${line.replace(/"/g, '\\"')}"`)
                        }
                    }
                } else if (module === 'ansible.netcommon.cli_config') {
                    lines.push(`        config: |`)
                    for (const line of config.split('\n')) {
                        lines.push(`          ${line}`)
                    }
                } else {
                    lines.push('        lines:')
                    for (const line of config.split('\n')) {
                        if (line.trim()) {
                            lines.push(`          - "${line.replace(/"/g, '\\"')}"`)
                        }
                    }
                }
                lines.push(`      when: inventory_hostname == "${safe}"`)
                lines.push('')
            }
        }

        return lines.join('\n')
    }

    /**
     * Generate Terraform HCL configuration for network resources.
     * Includes provider blocks, variables, and resource definitions.
     */
    exportTerraform (topology: Topology): string {
        const networkNodes = topology.nodes.filter(n =>
            n.type !== 'host' && n.type !== 'bridge' && n.vendor,
        )

        if (!networkNodes.length) {
            return '# No network devices with vendor information found\n'
        }

        // Determine which providers are needed
        const neededProviders = new Map<string, { source: string; version: string }>()
        for (const node of networkNodes) {
            const nos = resolveNetworkOs(node)
            const prov = VENDOR_TO_TF_PROVIDER[nos]
            if (prov && !neededProviders.has(nos)) {
                neededProviders.set(nos, prov)
            }
        }

        const lines: string[] = []

        // ── Terraform block ──
        lines.push('terraform {')
        lines.push('  required_version = ">= 1.0"')
        if (neededProviders.size > 0) {
            lines.push('  required_providers {')
            for (const [nos, prov] of neededProviders) {
                lines.push(`    ${nos} = {`)
                lines.push(`      source  = "${prov.source}"`)
                lines.push(`      version = "${prov.version}"`)
                lines.push('    }')
            }
            lines.push('  }')
        }
        lines.push('}')
        lines.push('')

        // ── Variables ──
        lines.push('# ── Variables ──────────────────────────────────────────────')
        lines.push('')
        lines.push('variable "ssh_username" {')
        lines.push('  description = "Default SSH username for device access"')
        lines.push('  type        = string')
        lines.push('  default     = "admin"')
        lines.push('}')
        lines.push('')
        lines.push('variable "ssh_password" {')
        lines.push('  description = "Default SSH password for device access"')
        lines.push('  type        = string')
        lines.push('  sensitive   = true')
        lines.push('}')
        lines.push('')

        // ── Provider blocks ──
        lines.push('# ── Providers ─────────────────────────────────────────────')
        lines.push('')
        for (const [nos] of neededProviders) {
            lines.push(`provider "${nos}" {`)
            lines.push(`  # Configured per-resource via aliases or environment`)
            lines.push('}')
            lines.push('')
        }

        // ── Resource blocks per device ──
        lines.push('# ── Network Devices ───────────────────────────────────────')
        lines.push('')

        for (const node of networkNodes) {
            const nos = resolveNetworkOs(node)
            const safe = node.label.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
            const host = node.mgmtIp ? stripCidr(node.mgmtIp) : '<DEVICE_IP>'
            const user = node.sshUsername ?? 'var.ssh_username'
            const port = node.sshPort ?? 22

            lines.push(`# ${node.label} (${node.vendor ?? 'unknown'}${node.model ? ' ' + node.model : ''})`)

            switch (nos) {
                case 'junos':
                    lines.push(`resource "junos_system" "${safe}" {`)
                    lines.push(`  host     = "${host}"`)
                    lines.push(`  port     = ${port}`)
                    lines.push(`  username = ${user.startsWith('var.') ? user : `"${user}"`}`)
                    lines.push('  password = var.ssh_password')
                    lines.push(`  # sshkey_pem = file("~/.ssh/id_rsa")`)
                    lines.push('}')
                    break
                case 'nxos':
                    lines.push(`resource "nxos_rest" "${safe}" {`)
                    lines.push(`  host     = "${host}"`)
                    lines.push(`  username = ${user.startsWith('var.') ? user : `"${user}"`}`)
                    lines.push('  password = var.ssh_password')
                    lines.push('}')
                    break
                default:
                    lines.push(`resource "null_resource" "${safe}" {`)
                    lines.push('  # Generic device — configure provider-specific resource')
                    lines.push('  provisioner "local-exec" {')
                    lines.push(`    command = "echo Provisioning ${node.label} at ${host}"`)
                    lines.push('  }')
                    lines.push('}')
                    break
            }
            lines.push('')
        }

        // ── Outputs ──
        lines.push('# ── Outputs ───────────────────────────────────────────────')
        lines.push('')
        lines.push('output "device_inventory" {')
        lines.push('  description = "Network device inventory"')
        lines.push('  value = {')
        for (const node of networkNodes) {
            const safe = node.label.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
            const host = node.mgmtIp ? stripCidr(node.mgmtIp) : 'unknown'
            lines.push(`    ${safe} = "${host}"`)
        }
        lines.push('  }')
        lines.push('}')

        return lines.join('\n')
    }
}
