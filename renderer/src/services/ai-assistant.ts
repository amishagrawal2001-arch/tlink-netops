// ═══════════════════════════════════════════════════════════════════════════════
// AI Config Assistant
// Builds well-formed prompts for LLM analysis of network configs.
// Offline-first: generates prompt text the user copies into their LLM of choice.
// (Direct API integration would require user-provided API keys — out of scope.)
// ═══════════════════════════════════════════════════════════════════════════════

import { Topology, TopologyNode } from '../api/interfaces'

export type AssistantTask = 'explain' | 'audit' | 'troubleshoot' | 'optimize' | 'translate'

export interface PromptContext {
    task: AssistantTask
    node?: TopologyNode
    topology?: Topology
    /** Optional error message or symptom the user is investigating */
    symptom?: string
    /** Optional target vendor for translation (when task === 'translate') */
    targetVendor?: string
}

/** Build a prompt for Claude / GPT / Gemini. Result is a plain-text prompt
 *  with clear instruction + config context that the user copies into their LLM. */
export function buildPrompt (ctx: PromptContext): string {
    const parts: string[] = []

    switch (ctx.task) {
        case 'explain':
            parts.push('You are a senior network engineer. Explain the following router/switch configuration line by line, identifying:')
            parts.push('1. What each protocol/feature does')
            parts.push('2. The overall design intent (e.g. "leaf in EVPN-VXLAN fabric with distributed IRB")')
            parts.push('3. Any non-obvious implications (e.g. load-balancing mode, MTU requirements)')
            parts.push('')
            parts.push('Be concise — use 2-3 sentences per section, not an exhaustive line-by-line breakdown.')
            break
        case 'audit':
            parts.push('You are a network security auditor. Review the following configuration for:')
            parts.push('1. Security issues (default passwords, open SNMP, weak ciphers, missing ACLs)')
            parts.push('2. Operational risks (single points of failure, misconfigurations, unused services)')
            parts.push('3. Compliance gaps (PCI, HIPAA, NIST 800-53 applicable controls)')
            parts.push('')
            parts.push('Output a prioritized list: Critical / High / Medium / Low with a one-line justification each.')
            break
        case 'troubleshoot':
            parts.push('You are a network troubleshooting expert. Given the configuration below and the symptom:')
            parts.push('')
            parts.push(`SYMPTOM: ${ctx.symptom ?? '(no symptom provided)'}`)
            parts.push('')
            parts.push('Identify the most likely root causes, ranked by probability, with specific debug commands to confirm each.')
            break
        case 'optimize':
            parts.push('You are a network performance engineer. Review this configuration and suggest optimizations for:')
            parts.push('1. Convergence speed (BFD, fast-reroute, tuning timers)')
            parts.push('2. Scalability (route summarization, ECMP, session grouping)')
            parts.push('3. Observability (telemetry, syslog, traps)')
            parts.push('4. Security (harden where it does not impact performance)')
            parts.push('')
            parts.push('For each suggestion, show the exact config diff (before/after).')
            break
        case 'translate':
            const target = ctx.targetVendor || 'Cisco IOS-XR'
            parts.push(`You are a multi-vendor network translator. Convert the following configuration to equivalent ${target} syntax.`)
            parts.push('Preserve the exact intent (ASN, IP addresses, interface roles, protocols).')
            parts.push('Call out any features that do not have a direct equivalent and suggest the closest alternative.')
            break
    }

    parts.push('')
    parts.push('─────────────────────────────')

    if (ctx.node) {
        parts.push(`Node: ${ctx.node.label}`)
        parts.push(`Type: ${ctx.node.type}${ctx.node.role ? ` (role: ${ctx.node.role})` : ''}`)
        if (ctx.node.vendor) { parts.push(`Vendor: ${ctx.node.vendor}${ctx.node.model ? ` ${ctx.node.model}` : ''}`) }
        if (ctx.node.asn != null) { parts.push(`ASN: ${ctx.node.asn}`) }
        if (ctx.node.loopbackIp) { parts.push(`Loopback: ${ctx.node.loopbackIp}`) }
        parts.push('─────────────────────────────')
        parts.push('')
        parts.push('```')
        parts.push(ctx.node.startupConfig || '(no config set)')
        parts.push('```')
    } else if (ctx.topology) {
        parts.push(`Topology: ${ctx.topology.name}`)
        parts.push(`Nodes: ${ctx.topology.nodes.length}, Links: ${ctx.topology.links.length}`)
        if (ctx.topology.underlayProtocol) { parts.push(`Underlay: ${ctx.topology.underlayProtocol}`) }
        if (ctx.topology.overlayEnabled) { parts.push(`Overlay: EVPN-VXLAN enabled`) }
        if (ctx.topology.irbMode) { parts.push(`IRB mode: ${ctx.topology.irbMode === 'symmetric' ? 'ERB (symmetric)' : 'CRB (asymmetric)'}`) }
        parts.push('')
        parts.push('Node summary:')
        const byRole = new Map<string, number>()
        for (const n of ctx.topology.nodes) {
            const key = n.role || n.type
            byRole.set(key, (byRole.get(key) ?? 0) + 1)
        }
        for (const [role, count] of byRole) { parts.push(`  - ${role}: ${count}`) }
    }

    parts.push('')
    parts.push('Please respond in plain text. Use markdown for structure if helpful.')
    return parts.join('\n')
}

/** Summary — what the assistant CAN and CANNOT do offline */
export const ASSISTANT_CAPABILITIES = {
    offline: [
        'Build well-formed LLM prompts from the node config + topology context',
        'Pre-populate vendor, ASN, role info so the LLM has what it needs',
        'Copy prompt to clipboard for pasting into Claude / ChatGPT / Gemini',
        'Support 5 task types: explain, audit, troubleshoot, optimize, translate',
    ],
    requiresAPIKey: [
        'Direct LLM calls (would need user-provided Anthropic / OpenAI API key)',
        'Streaming responses in-app',
        'Multi-turn conversations',
    ],
}
