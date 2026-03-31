/**
 * Firmware Upgrade Planner — tracks device firmware versions, recommends upgrades,
 * generates maintenance windows and upgrade order based on topology role.
 */

import { Injectable } from '@angular/core'
import { TopologyNode, Topology } from '../api/interfaces'

export interface FirmwareInfo {
    nodeId: string
    nodeLabel: string
    vendor: string
    model: string
    currentVersion: string
    recommendedVersion?: string
    needsUpgrade: boolean
    upgradeOrder: number  // lower = upgrade first (leafs before spines)
    role: string
}

export interface UpgradePlan {
    name: string
    createdAt: string
    devices: FirmwareInfo[]
    phases: UpgradePhase[]
    totalDevices: number
    devicesNeedingUpgrade: number
}

export interface UpgradePhase {
    name: string
    order: number
    devices: FirmwareInfo[]
    description: string
}

// Known latest firmware versions per vendor (reference data)
const LATEST_VERSIONS: Record<string, string> = {
    'juniper': '24.4R1',
    'cisco': '17.12.1',
    'cisco-nxos': '10.4(2)',
    'cisco-iosxr': '7.11.1',
    'arista': '4.32.0F',
    'nokia': '24.10.1',
    'sonic': '202405',
    'huawei': 'V800R023C00',
    'dell': '10.5.6.3',
    'hpe': '10.13',
    'mikrotik': '7.16',
    'extreme': '32.7.1',
}

@Injectable({ providedIn: 'root' })
export class FirmwarePlannerService {

    /**
     * Analyze topology nodes and generate an upgrade plan.
     * Groups devices by role and assigns upgrade order:
     * 1. Endpoints (servers, PCs) — least impact
     * 2. Leaf switches — one at a time, traffic fails over
     * 3. Border leafs — external connectivity
     * 4. Spine switches — core, upgrade last
     */
    generateUpgradePlan (topology: Topology, deviceVersions: Record<string, { osVersion?: string }>): UpgradePlan {
        const devices: FirmwareInfo[] = []

        for (const node of topology.nodes) {
            if (!node.vendor) { continue }
            const vendorKey = node.vendor.toLowerCase()
            const version = deviceVersions[node.id]?.osVersion ?? ''
            const recommended = LATEST_VERSIONS[vendorKey] ?? ''
            const needsUpgrade = version && recommended ? !version.includes(recommended) : false

            let upgradeOrder = 3
            let role = node.role ?? node.type
            if (role === 'spine' || role === 'super-spine' || role === 'core') { upgradeOrder = 4 }
            else if (role === 'border-leaf') { upgradeOrder = 3 }
            else if (role === 'leaf' || role === 'tor') { upgradeOrder = 2 }
            else if (node.type === 'server' || node.type === 'pc' || node.type === 'host') { upgradeOrder = 1 }
            else if (node.type === 'firewall') { upgradeOrder = 3 }

            devices.push({
                nodeId: node.id,
                nodeLabel: node.label,
                vendor: node.vendor,
                model: node.model ?? '',
                currentVersion: version || 'Unknown',
                recommendedVersion: recommended || 'N/A',
                needsUpgrade,
                upgradeOrder,
                role,
            })
        }

        // Sort by upgrade order
        devices.sort((a, b) => a.upgradeOrder - b.upgradeOrder)

        // Generate phases
        const phases: UpgradePhase[] = []
        const orderGroups = new Map<number, FirmwareInfo[]>()
        for (const dev of devices.filter(d => d.needsUpgrade)) {
            const group = orderGroups.get(dev.upgradeOrder) ?? []
            group.push(dev)
            orderGroups.set(dev.upgradeOrder, group)
        }

        const phaseNames: Record<number, string> = {
            1: 'Phase 1: Endpoints',
            2: 'Phase 2: Leaf Switches',
            3: 'Phase 3: Border Leafs & Firewalls',
            4: 'Phase 4: Spine/Core (Maintenance Window)',
        }

        const phaseDescs: Record<number, string> = {
            1: 'Upgrade endpoint devices first — minimal impact, no traffic disruption',
            2: 'Upgrade leaf switches one at a time — traffic fails over to redundant paths',
            3: 'Upgrade border leafs and firewalls — brief external connectivity impact per device',
            4: 'Upgrade spine/core devices — requires maintenance window, upgrade one at a time with traffic monitoring',
        }

        for (const [order, devs] of [...orderGroups.entries()].sort((a, b) => a[0] - b[0])) {
            phases.push({
                name: phaseNames[order] ?? `Phase ${order}`,
                order,
                devices: devs,
                description: phaseDescs[order] ?? 'Upgrade devices in this group',
            })
        }

        return {
            name: `Upgrade Plan — ${topology.name || 'Untitled'}`,
            createdAt: new Date().toISOString(),
            devices,
            phases,
            totalDevices: devices.length,
            devicesNeedingUpgrade: devices.filter(d => d.needsUpgrade).length,
        }
    }

    /**
     * Export upgrade plan as a markdown report.
     */
    exportPlanAsMarkdown (plan: UpgradePlan): string {
        const lines: string[] = []
        lines.push(`# ${plan.name}`)
        lines.push(``)
        lines.push(`**Generated:** ${new Date(plan.createdAt).toLocaleString()}`)
        lines.push(`**Total Devices:** ${plan.totalDevices}`)
        lines.push(`**Needing Upgrade:** ${plan.devicesNeedingUpgrade}`)
        lines.push(``)

        lines.push(`## Summary`)
        lines.push(``)
        lines.push(`| Device | Vendor | Model | Current | Recommended | Status |`)
        lines.push(`|--------|--------|-------|---------|-------------|--------|`)
        for (const dev of plan.devices) {
            const status = dev.needsUpgrade ? '⚠️ Upgrade' : '✅ Current'
            lines.push(`| ${dev.nodeLabel} | ${dev.vendor} | ${dev.model} | ${dev.currentVersion} | ${dev.recommendedVersion} | ${status} |`)
        }
        lines.push(``)

        for (const phase of plan.phases) {
            lines.push(`## ${phase.name}`)
            lines.push(``)
            lines.push(`> ${phase.description}`)
            lines.push(``)
            for (const dev of phase.devices) {
                lines.push(`- **${dev.nodeLabel}** (${dev.vendor} ${dev.model}): ${dev.currentVersion} → ${dev.recommendedVersion}`)
            }
            lines.push(``)
        }

        lines.push(`## Pre-Upgrade Checklist`)
        lines.push(``)
        lines.push(`- [ ] Backup running configs for all devices`)
        lines.push(`- [ ] Verify redundant paths are active`)
        lines.push(`- [ ] Schedule maintenance window for spine upgrades`)
        lines.push(`- [ ] Download firmware images to staging server`)
        lines.push(`- [ ] Notify NOC team and stakeholders`)
        lines.push(`- [ ] Prepare rollback procedure`)
        lines.push(``)

        lines.push(`## Post-Upgrade Verification`)
        lines.push(``)
        lines.push(`- [ ] Verify all BGP sessions re-established`)
        lines.push(`- [ ] Check interface counters for errors`)
        lines.push(`- [ ] Run traffic tests across upgraded paths`)
        lines.push(`- [ ] Confirm firmware version on all upgraded devices`)
        lines.push(`- [ ] Save running configs after successful upgrade`)

        return lines.join('\n')
    }
}
