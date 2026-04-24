import { buildPrompt, ASSISTANT_CAPABILITIES } from '../renderer/src/services/ai-assistant'
import { makeTopo, makeNode } from './fixtures'

describe('buildPrompt', () => {
    it('explain task — produces prompt with node config', () => {
        const node = makeNode('n1', {
            label: 'Leaf-1', vendor: 'Juniper', asn: 65011,
            loopbackIp: '10.0.0.11/32', role: 'leaf',
            startupConfig: 'set system host-name Leaf-1\nset routing-options autonomous-system 65011',
        })
        const prompt = buildPrompt({ task: 'explain', node })
        expect(prompt).toContain('senior network engineer')
        expect(prompt).toContain('Juniper')
        expect(prompt).toContain('ASN: 65011')
        expect(prompt).toContain('set system host-name Leaf-1')
    })

    it('audit task — instructs security review', () => {
        const node = makeNode('n1', { startupConfig: 'service password 7 abc' })
        const prompt = buildPrompt({ task: 'audit', node })
        expect(prompt).toContain('security auditor')
        expect(prompt).toMatch(/Security issues|Critical/i)
    })

    it('troubleshoot task — includes symptom', () => {
        const node = makeNode('n1', { startupConfig: 'bgp 65001' })
        const prompt = buildPrompt({
            task: 'troubleshoot', node,
            symptom: 'BGP sessions flapping every 30 seconds',
        })
        expect(prompt).toContain('troubleshooting expert')
        expect(prompt).toContain('BGP sessions flapping')
    })

    it('optimize task — asks for config diffs', () => {
        const node = makeNode('n1', { startupConfig: 'router ospf 1' })
        const prompt = buildPrompt({ task: 'optimize', node })
        expect(prompt).toContain('performance engineer')
        expect(prompt).toContain('diff')
    })

    it('translate task — targets Cisco IOS-XR by default', () => {
        const node = makeNode('n1', {
            vendor: 'Juniper',
            startupConfig: 'set routing-options autonomous-system 65001',
        })
        const prompt = buildPrompt({ task: 'translate', node })
        expect(prompt).toContain('Cisco IOS-XR')
    })

    it('translate task — supports custom targetVendor', () => {
        const node = makeNode('n1', { vendor: 'Juniper' })
        const prompt = buildPrompt({ task: 'translate', node, targetVendor: 'Arista EOS' })
        expect(prompt).toContain('Arista EOS')
    })

    it('topology-scope prompt includes summary of node roles', () => {
        const topo = makeTopo([
            makeNode('s1', { role: 'spine' }),
            makeNode('s2', { role: 'spine' }),
            makeNode('l1', { role: 'leaf' }),
            makeNode('l2', { role: 'leaf' }),
            makeNode('l3', { role: 'leaf' }),
        ], [])
        topo.underlayProtocol = 'ebgp'
        topo.overlayEnabled = true
        topo.irbMode = 'symmetric'
        const prompt = buildPrompt({ task: 'audit', topology: topo })
        expect(prompt).toContain('spine: 2')
        expect(prompt).toContain('leaf: 3')
        expect(prompt).toContain('ebgp')
        expect(prompt).toContain('EVPN-VXLAN')
        expect(prompt).toContain('ERB')
    })

    it('missing config still produces valid prompt', () => {
        const node = makeNode('n1', { startupConfig: undefined })
        const prompt = buildPrompt({ task: 'explain', node })
        expect(prompt).toContain('no config set')
    })
})

describe('ASSISTANT_CAPABILITIES', () => {
    it('documents what works offline vs requires API key', () => {
        expect(ASSISTANT_CAPABILITIES.offline.length).toBeGreaterThan(0)
        expect(ASSISTANT_CAPABILITIES.requiresAPIKey.length).toBeGreaterThan(0)
    })
})
