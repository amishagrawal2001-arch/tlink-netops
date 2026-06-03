import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable, Subject } from 'rxjs'
import {
    Topology, TopologyNode, TopologyLink,
    NodeType, NodePort, NodeStatus, DEFAULT_PORTS,
    TopologyTemplate, DeviceInventoryRecord, DeviceMappingSummary, AutoAddressSummary, AutoLoopbackSummary,
    Annotation, AnnotationType, SwitchFamily, PortSpeed,
    BuilderConfig, BuilderNodeGroup, BuilderLinkRule, NodeRole, NODE_ROLE_META,
    VLAN_TEMPLATES, VlanDefinition,
    PreviewNode, PreviewLink, PreviewTopology,
    SERVICE_PROFILES, ServiceProfile, ServicePortRule,
} from '../api/interfaces'
import { buildVendorStartupConfig, VendorConfigContext, BgpNeighbor, OspfInterface, IsisInterface } from './vendor-config-builder'
import { renderStagingConfig, mergeStaging } from './vendor-staging-builder'
import {
    normIp, ipToInt, intToIp, expandIPv6, formatIPv6WithOffset, parseBaseCidr,
    normText, keepOrIncoming, parseHostCidr,
} from './topology-helpers'

// Re-export helpers so existing consumers don't break
export {
    normIp, ipToInt, intToIp, expandIPv6, formatIPv6WithOffset, parseBaseCidr,
    normText, keepOrIncoming, parseHostCidr,
}

function uuid (): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

const HISTORY_LIMIT = 50

@Injectable()
export class TopologyService {
    private _topology$     = new BehaviorSubject<Topology>(this._empty('Untitled Topology'))
    private _selectedNode$ = new BehaviorSubject<string | null>(null)
    private _selectedLink$ = new BehaviorSubject<string | null>(null)

    private _history: Topology[] = []
    private _future: Topology[]  = []
    private _saved$ = new Subject<void>()

    get topology$ (): Observable<Topology>        { return this._topology$.asObservable() }
    get selectedNode$ (): Observable<string|null> { return this._selectedNode$.asObservable() }
    get selectedLink$ (): Observable<string|null> { return this._selectedLink$.asObservable() }
    get topology (): Topology                     { return this._topology$.value }

    get canUndo (): boolean { return this._history.length > 0 }
    get canRedo (): boolean { return this._future.length > 0 }
    get saved$ (): Observable<void> { return this._saved$.asObservable() }

    notifySaved (): void { this._saved$.next() }

    renameTopology (name: string): void { this._patch({ name }) }

    updateDescription (description: string): void { this._patch({ description }) }

    undo (): void {
        if (!this._history.length) { return }
        this._future.push(this._topology$.value)
        this._topology$.next(this._history.pop()!)
    }

    redo (): void {
        if (!this._future.length) { return }
        this._history.push(this._topology$.value)
        this._topology$.next(this._future.pop()!)
    }

    // ── Node CRUD ──────────────────────────────────────────────────────────

    addNode (type: NodeType, x: number, y: number): TopologyNode {
        const count = this.topology.nodes.filter(n => n.type === type).length
        const label = type === 'host'
            ? `Host-Port-${count + 1}`
            : type === 'bridge'
                ? `Bridge-${count + 1}`
                : `${type.charAt(0).toUpperCase() + type.slice(1)}-${count + 1}`
        const node: TopologyNode = {
            id: uuid(), type, label, x, y,
            status: 'stopped',
            ports: DEFAULT_PORTS[type].map(p => ({ ...p })),
            mapped: false,
        }
        this._patch({ nodes: [...this.topology.nodes, node] })
        return node
    }

    moveNode (id: string, x: number, y: number): void {
        this._patchNode(id, { x, y })
    }

    /** Resize a node without recording history (for continuous drag updates) */
    resizeNodeSilent (id: string, x: number, y: number, width: number, height: number): void {
        this._patchSilent({
            nodes: this.topology.nodes.map(n => n.id === id ? { ...n, x, y, width, height } : n),
        })
    }

    renameNode (id: string, label: string): void {
        this._patchNode(id, { label })
    }

    /** Update any subset of a node's top-level fields (label, description, ram, image, notes, startupConfig) */
    updateNodeConfig (id: string, changes: Partial<TopologyNode>): void {
        this._patchNode(id, changes)
    }

    /** Dry-run: compute mapping without applying changes */
    previewMapDevices (records: DeviceInventoryRecord[]): DeviceMappingSummary {
        return this._matchDeviceRecords(records)
    }

    /** Apply device mapping from CSV records */
    mapDevices (records: DeviceInventoryRecord[]): DeviceMappingSummary {
        const result = this._matchDeviceRecords(records)

        // Build update map for matched records
        const updates = new Map<string, Partial<TopologyNode>>()
        for (const det of result.matchedDetails) {
            const rec = det.record
            const node = this.topology.nodes.find(n => n.label === det.nodeLabel)
            if (!node) { continue }
            const prior = updates.get(node.id) ?? {}
            updates.set(node.id, {
                ...prior,
                mapped: true,
                mappedBy: det.matchedBy as 'hostname' | 'mgmtIp',
                mgmtIp: keepOrIncoming(rec.mgmtIp, (prior.mgmtIp as string | undefined) ?? node.mgmtIp),
                vendor: keepOrIncoming(rec.vendor, (prior.vendor as string | undefined) ?? node.vendor),
                model: keepOrIncoming(rec.model, (prior.model as string | undefined) ?? node.model),
                serialNumber: keepOrIncoming(rec.serialNumber, (prior.serialNumber as string | undefined) ?? node.serialNumber),
                sourceId: keepOrIncoming(rec.sourceId, (prior.sourceId as string | undefined) ?? node.sourceId),
            })
        }

        const nodes = this.topology.nodes.map(node => {
            const mappedNode = updates.get(node.id)
            if (mappedNode) { return { ...node, ...mappedNode } }
            if (node.mapped || node.mappedBy) { return { ...node, mapped: false, mappedBy: undefined } }
            return node
        })

        this._patch({ nodes })
        return result
    }

    private _matchDeviceRecords (records: DeviceInventoryRecord[]): DeviceMappingSummary {
        const valid = records.filter(r =>
            !!(normText(r.hostname) || normIp(r.mgmtIp) || normText(r.serialNumber) || normText(r.sourceId)),
        )

        const byLabel = new Map<string, TopologyNode>()
        const byMgmtIp = new Map<string, TopologyNode>()

        for (const node of this.topology.nodes) {
            const labelKey = normText(node.label)
            if (labelKey && !byLabel.has(labelKey)) { byLabel.set(labelKey, node) }

            const ips = [normIp(node.mgmtIp), ...node.ports.map(p => normIp(p.ipAddress))]
                .filter(Boolean)

            for (const ip of ips) {
                if (!byMgmtIp.has(ip)) { byMgmtIp.set(ip, node) }
            }
        }

        let matched = 0
        let hostnameMatches = 0
        let mgmtIpMatches = 0
        const unmatchedRecords: DeviceInventoryRecord[] = []
        const matchedDetails: { record: DeviceInventoryRecord; nodeLabel: string; matchedBy: string }[] = []

        for (const rec of valid) {
            const hostname = normText(rec.hostname)
            const mgmtIp = normIp(rec.mgmtIp)
            let node: TopologyNode | undefined
            let matchedBy: 'hostname' | 'mgmtIp' | undefined

            if (hostname) {
                node = byLabel.get(hostname)
                if (node) { matchedBy = 'hostname' }
            }
            if (!node && mgmtIp) {
                node = byMgmtIp.get(mgmtIp)
                if (node) { matchedBy = 'mgmtIp' }
            }
            if (!node || !matchedBy) {
                unmatchedRecords.push(rec)
                continue
            }

            matched += 1
            if (matchedBy === 'hostname') { hostnameMatches += 1 }
            if (matchedBy === 'mgmtIp') { mgmtIpMatches += 1 }
            matchedDetails.push({ record: rec, nodeLabel: node.label, matchedBy })
        }

        return {
            total: valid.length,
            matched,
            unmatched: Math.max(0, valid.length - matched),
            hostnameMatches,
            mgmtIpMatches,
            unmatchedRecords,
            matchedDetails,
        }
    }

    autoAddressLinks (overwrite = false, baseCidr = '10.0.0.0/8', linkPrefix = 30): AutoAddressSummary {
        const totalLinks = this.topology.links.length
        if (!totalLinks) {
            return { totalLinks: 0, addressedLinks: 0, skippedExisting: 0, skippedMissing: 0, skippedCapacity: 0 }
        }

        // Clamp prefix to valid range for link subnets (24-31)
        const prefix = Math.max(24, Math.min(31, linkPrefix))
        const subnetSize = Math.pow(2, 32 - prefix)  // IPs per subnet (e.g., /30=4, /31=2, /24=256)
        const isP2P = prefix === 31  // RFC 3021: /31 uses .0 and .1 directly

        const { networkStart, networkEnd } = parseBaseCidr(baseCidr)

        const nodes = this.topology.nodes.map(n => ({
            ...n,
            ports: n.ports.map(p => ({ ...p })),
        }))
        const nodeById = new Map(nodes.map(n => [n.id, n] as const))

        let addressedLinks = 0
        let skippedExisting = 0
        let skippedMissing = 0
        let skippedCapacity = 0

        for (const link of this.topology.links) {
            const sourceNode = nodeById.get(link.sourceNodeId)
            const targetNode = nodeById.get(link.targetNodeId)
            const sourcePort = sourceNode?.ports.find(p => p.id === link.sourcePortId)
            const targetPort = targetNode?.ports.find(p => p.id === link.targetPortId)

            if (!sourcePort || !targetPort) {
                skippedMissing += 1
                continue
            }

            // Skip L2 ports (access/trunk from service profile) — they shouldn't get L3 IPs
            if (sourcePort.vlanMode === 'access' || sourcePort.vlanMode === 'trunk'
                || targetPort.vlanMode === 'access' || targetPort.vlanMode === 'trunk') {
                skippedExisting += 1
                continue
            }

            if (!overwrite && (sourcePort.ipAddress?.trim() || targetPort.ipAddress?.trim())) {
                skippedExisting += 1
                continue
            }

            const subnetNetwork = networkStart + addressedLinks * subnetSize
            if (subnetNetwork + subnetSize - 1 > networkEnd) {
                skippedCapacity += 1
                continue
            }

            if (isP2P) {
                // /31 (RFC 3021): both addresses are usable, no network/broadcast
                sourcePort.ipAddress = `${intToIp(subnetNetwork)}/31`
                targetPort.ipAddress = `${intToIp(subnetNetwork + 1)}/31`
            } else {
                // /30, /29, /28, etc.: skip network address (.0), assign .1 and .2
                sourcePort.ipAddress = `${intToIp(subnetNetwork + 1)}/${prefix}`
                targetPort.ipAddress = `${intToIp(subnetNetwork + 2)}/${prefix}`
            }
            addressedLinks += 1
        }

        this._patch({ nodes })

        // Regenerate vendor configs so interfaces get their IP addresses
        if (addressedLinks > 0) {
            this._regenerateConfigs()
        }

        return {
            totalLinks,
            addressedLinks,
            skippedExisting,
            skippedMissing,
            skippedCapacity,
        }
    }

    autoAssignLoopbacks (overwrite = false, baseCidr = '172.16.0.0/16'): AutoLoopbackSummary {
        const totalNodes = this.topology.nodes.length
        if (!totalNodes) {
            return {
                totalNodes: 0,
                eligibleNodes: 0,
                assigned: 0,
                skippedExisting: 0,
                skippedIneligible: 0,
                skippedCapacity: 0,
            }
        }

        const { networkStart, networkEnd } = parseHostCidr(baseCidr)
        const eligibleTypes: NodeType[] = ['router', 'switch', 'firewall']

        const nodes = this.topology.nodes.map(n => ({
            ...n,
            ports: n.ports.map(p => ({ ...p })),
        }))

        const reserved = new Set<string>()
        for (const node of nodes) {
            // Reserve existing loopback + mgmt IPs so we don't assign duplicates
            const loopIp = normIp(node.loopbackIp)
            if (loopIp) { reserved.add(loopIp) }
            const mgmtIp = normIp(node.mgmtIp)
            if (mgmtIp) { reserved.add(mgmtIp) }
            for (const port of node.ports) {
                const ip = normIp(port.ipAddress)
                if (ip) { reserved.add(ip) }
            }
        }

        let eligibleNodes = 0
        let assigned = 0
        let skippedExisting = 0
        let skippedIneligible = 0
        let skippedCapacity = 0
        let cursor = networkStart + 1   // skip network address (.0)

        for (const node of nodes) {
            if (!eligibleTypes.includes(node.type)) {
                skippedIneligible += 1
                continue
            }
            eligibleNodes += 1

            const currentIp = normIp(node.loopbackIp)
            if (currentIp && !overwrite) {
                skippedExisting += 1
                continue
            }

            while (cursor <= networkEnd && reserved.has(intToIp(cursor))) {
                cursor += 1
            }
            if (cursor > networkEnd) {
                skippedCapacity += 1
                continue
            }

            const ip = intToIp(cursor)
            cursor += 1
            node.loopbackIp = `${ip}/32`
            reserved.add(ip)
            assigned += 1
        }

        this._patch({ nodes })

        // Regenerate vendor configs so Loopback0 interface and router-id reflect the new IPs
        if (assigned > 0) {
            this._regenerateConfigs()
        }

        return {
            totalNodes,
            eligibleNodes,
            assigned,
            skippedExisting,
            skippedIneligible,
            skippedCapacity,
        }
    }

    /** Update a single port's fields (ipAddress, description, enabled) */
    updatePort (nodeId: string, portId: string, changes: Partial<NodePort>): void {
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return }
        const ports = node.ports.map(p => p.id === portId ? { ...p, ...changes } : p)
        this._patchNode(nodeId, { ports })
    }

    // ── Node status ────────────────────────────────────────────────────────

    setNodeStatus (id: string, status: NodeStatus): void {
        this._patchNode(id, { status })
    }

    startNode (id: string): void  { this._patchNode(id, { status: 'running' }) }
    stopNode (id: string): void   { this._patchNode(id, { status: 'stopped' }) }
    suspendNode (id: string): void {
        const node = this.topology.nodes.find(n => n.id === id)
        // only running nodes can be suspended
        if (node?.status === 'running') { this._patchNode(id, { status: 'suspended' }) }
    }

    startAll (): void {
        this._patch({
            nodes: this.topology.nodes.map(n => ({ ...n, status: 'running' as NodeStatus })),
        })
    }

    stopAll (): void {
        this._patch({
            nodes: this.topology.nodes.map(n => ({ ...n, status: 'stopped' as NodeStatus })),
        })
    }

    get runningCount (): number { return this.topology.nodes.filter(n => n.status === 'running').length }
    get stoppedCount (): number { return this.topology.nodes.filter(n => n.status === 'stopped').length }

    removeNode (id: string): void {
        this._patch({
            nodes: this.topology.nodes.filter(n => n.id !== id),
            links: this.topology.links.filter(
                l => l.sourceNodeId !== id && l.targetNodeId !== id),
        })
        if (this._selectedNode$.value === id) { this._selectedNode$.next(null) }
    }

    selectNode (id: string | null): void {
        this._selectedNode$.next(id)
        this._selectedLink$.next(null)
    }

    getNode (id: string): TopologyNode | undefined {
        return this.topology.nodes.find(n => n.id === id)
    }

    /** Duplicate a node with an x/y offset; returns the new node's id */
    duplicateNode (source: TopologyNode, dx: number, dy: number): string {
        const id = uuid()
        const node: TopologyNode = {
            ...source,
            id,
            x: source.x + dx,
            y: source.y + dy,
            label: source.label + '-copy',
            status: 'stopped',
            ports: source.ports.map(p => ({ ...p, ipAddress: undefined })),
            mapped: false,
            mappedBy: undefined,
        }
        this._patch({ nodes: [...this.topology.nodes, node] })
        return id
    }

    // ── Link CRUD ──────────────────────────────────────────────────────────

    addLink (
        sourceNodeId: string, sourcePortId: string,
        targetNodeId: string, targetPortId: string,
    ): TopologyLink | null {
        if (sourceNodeId === targetNodeId) { return null }
        const usedPorts = new Set(
            this.topology.links.flatMap(l => [
                `${l.sourceNodeId}:${l.sourcePortId}`,
                `${l.targetNodeId}:${l.targetPortId}`,
            ]),
        )
        if (
            usedPorts.has(`${sourceNodeId}:${sourcePortId}`) ||
            usedPorts.has(`${targetNodeId}:${targetPortId}`)
        ) { return null }

        const link: TopologyLink = {
            id: uuid(), type: 'ethernet',
            sourceNodeId, sourcePortId, targetNodeId, targetPortId,
        }
        this._patch({ links: [...this.topology.links, link] })
        return link
    }

    /**
     * Add a link where one or both endpoints may be a shape (annotation) instead of a node.
     * For node endpoints, provide nodeId + portId. For shape endpoints, provide annotationId.
     */
    addShapeLink (opts: {
        sourceNodeId?: string; sourcePortId?: string; sourceAnnotationId?: string
        sourceAnchorX?: number; sourceAnchorY?: number
        targetNodeId?: string; targetPortId?: string; targetAnnotationId?: string
        targetAnchorX?: number; targetAnchorY?: number
    }): TopologyLink | null {
        const link: TopologyLink = {
            id: uuid(), type: 'ethernet',
            sourceNodeId: opts.sourceNodeId ?? '',
            sourcePortId: opts.sourcePortId ?? '',
            targetNodeId: opts.targetNodeId ?? '',
            targetPortId: opts.targetPortId ?? '',
            sourceAnnotationId: opts.sourceAnnotationId,
            targetAnnotationId: opts.targetAnnotationId,
            sourceAnchorX: opts.sourceAnchorX,
            sourceAnchorY: opts.sourceAnchorY,
            targetAnchorX: opts.targetAnchorX,
            targetAnchorY: opts.targetAnchorY,
        }
        this._patch({ links: [...this.topology.links, link] })
        return link
    }

    /** Update any subset of a link's config fields */
    updateLinkConfig (id: string, changes: Partial<TopologyLink>): void {
        this._patch({
            links: this.topology.links.map(l => l.id === id ? { ...l, ...changes } : l),
        })
    }

    removeLink (id: string): void {
        this._patch({ links: this.topology.links.filter(l => l.id !== id) })
        if (this._selectedLink$.value === id) { this._selectedLink$.next(null) }
    }

    addPort (nodeId: string, label: string): void {
        const node = this.getNode(nodeId)
        if (!node) { return }
        const id = uuid()
        const newPort: NodePort = { id, label, enabled: true }
        this._patch({
            nodes: this.topology.nodes.map(n =>
                n.id === nodeId ? { ...n, ports: [...n.ports, newPort] } : n,
            ),
        })
    }

    removePort (nodeId: string, portId: string): void {
        // Remove the port and any links that reference it
        const links = this.topology.links.filter(
            l => !(l.sourceNodeId === nodeId && l.sourcePortId === portId) &&
                 !(l.targetNodeId === nodeId && l.targetPortId === portId),
        )
        this._patch({
            nodes: this.topology.nodes.map(n =>
                n.id === nodeId ? { ...n, ports: n.ports.filter(p => p.id !== portId) } : n,
            ),
            links,
        })
    }

    patchLink (id: string, changes: Partial<TopologyLink>): void {
        this._patchSilent({
            links: this.topology.links.map(l => l.id === id ? { ...l, ...changes } : l),
        })
    }

    toggleLinkDown (id: string): void {
        this.toggleLinksDown([id])
    }

    toggleLinksDown (ids: string[]): void {
        const idSet = new Set(ids)
        // If ANY of the selected links is currently up, mark all down. Otherwise restore all.
        const anyUp = this.topology.links.some(l => idSet.has(l.id) && l.status !== 'down')
        const target: 'up' | 'down' = anyUp ? 'down' : 'up'
        this._patch({
            links: this.topology.links.map(l =>
                idSet.has(l.id) ? { ...l, status: target } : l,
            ),
        })
    }

    batchMoveNodes (updates: { id: string; x: number; y: number }[]): void {
        const map = new Map(updates.map(u => [u.id, u]))
        this._patch({
            nodes: this.topology.nodes.map(n => {
                const u = map.get(n.id)
                return u ? { ...n, x: u.x, y: u.y } : n
            }),
        })
    }

    clearTopology (): void {
        this._patch({ nodes: [], links: [], annotations: [] })
    }

    addAnnotation (x: number, y: number): Annotation {
        const ann: Annotation = { id: uuid(), x, y, text: 'Note', width: 180, height: 60 }
        this._patch({ annotations: [...(this.topology.annotations ?? []), ann] })
        return ann
    }

    addRectangle (x: number, y: number, w = 120, h = 80): Annotation {
        return this.addShape('rectangle', x, y, w, h)
    }

    addShape (type: AnnotationType, x: number, y: number, w = 120, h = 80): Annotation {
        const shape: Annotation = {
            id: uuid(), type, x, y, text: '', width: w, height: h,
            fillColor: '#0f2744',
            strokeColor: '#3b82f6',
            strokeWidth: 1.5,
            opacity: 0.85,
            cornerRadius: type === 'rectangle' ? 10 : 0,
            label: '',
        }
        this._patch({ annotations: [...(this.topology.annotations ?? []), shape] })
        return shape
    }

    addImageAnnotation (x: number, y: number, imageData: string, w: number, h: number): Annotation {
        const shape: Annotation = {
            id: uuid(), type: 'image', x, y, text: '', width: w, height: h,
            imageData,
            strokeColor: 'transparent',
            strokeWidth: 0,
            opacity: 1,
        }
        this._patch({ annotations: [...(this.topology.annotations ?? []), shape] })
        return shape
    }

    duplicateAnnotation (ann: Annotation, dx = 30, dy = 30): string {
        const clone: Annotation = { ...ann, id: uuid(), x: ann.x + dx, y: ann.y + dy }
        this._patch({ annotations: [...(this.topology.annotations ?? []), clone] })
        return clone.id
    }

    updateAnnotation (id: string, changes: Partial<Annotation>): void {
        this._patch({
            annotations: (this.topology.annotations ?? []).map(a =>
                a.id === id ? { ...a, ...changes } : a,
            ),
        })
    }

    removeAnnotation (id: string): void {
        this._patch({ annotations: (this.topology.annotations ?? []).filter(a => a.id !== id) })
    }

    selectLink (id: string | null): void {
        this._selectedLink$.next(id)
        this._selectedNode$.next(null)
    }

    getLink (id: string): TopologyLink | undefined {
        return this.topology.links.find(l => l.id === id)
    }

    /** Returns the two nodes for a link */
    linkNodes (link: TopologyLink): { source: TopologyNode | undefined; target: TopologyNode | undefined } {
        return {
            source: this.topology.nodes.find(n => n.id === link.sourceNodeId),
            target: this.topology.nodes.find(n => n.id === link.targetNodeId),
        }
    }

    // ── Topology-level ─────────────────────────────────────────────────────

    newTopology (name = 'Untitled Topology'): void {
        this._history = []; this._future = []
        this._topology$.next(this._empty(name))
        this._selectedNode$.next(null)
        this._selectedLink$.next(null)
    }

    loadTemplate (tpl: TopologyTemplate): void {
        const now = new Date().toISOString()
        const idMap: string[] = []
        let hasVendor = false

        const nodes: TopologyNode[] = tpl.nodes.map(def => {
            const id = uuid()
            idMap.push(id)

            // Use custom ports when provided, otherwise fall back to DEFAULT_PORTS
            const ports: NodePort[] = def.ports && def.ports.length > 0
                ? def.ports.map(p => ({ ...p }))
                : DEFAULT_PORTS[def.type].map(p => ({ ...p }))

            if (def.vendor) { hasVendor = true }

            const node: TopologyNode = {
                id,
                type: def.type,
                label: def.label,
                x: def.x,
                y: def.y,
                status: 'stopped',
                ports,
                mapped: false,
                vendor: def.vendor,
                model: def.model,
                switchFamily: def.switchFamily,
                mgmtIp: def.mgmtIp,
                loopbackIp: def.loopbackIp,
                loopbackIpv6: def.loopbackIpv6,
                vlans: def.vlans ? def.vlans.map(v => ({ ...v })) : undefined,
                asn: def.asn,
                role: def.role,
                ospfArea: def.ospfArea,
                isisLevel: def.isisLevel,
                nodeSid: def.nodeSid,
                srgbStart: def.srgbStart,
                srgbEnd: def.srgbEnd,
                srv6Locator: def.srv6Locator,
                mplsLdp: def.mplsLdp,
                // R2: propagate per-node template fields added in Round 2.
                description: def.description,
                image: def.image,
                // Per-node staging; deep-copied so user edits don't mutate the template.
                ...(def.staging ? { staging: JSON.parse(JSON.stringify(def.staging)) } : {}),
            } as TopologyNode

            return node
        })

        const links: TopologyLink[] = tpl.links
            .flatMap(def => {
                const sourceNodeId = idMap[def.sourceNode]
                const targetNodeId = idMap[def.targetNode]
                if (!sourceNodeId || !targetNodeId) { return [] }
                const link: TopologyLink = {
                    id: uuid(),
                    type: 'ethernet',
                    sourceNodeId,
                    sourcePortId: def.sourcePort,
                    targetNodeId,
                    targetPortId: def.targetPort,
                }
                return [link]
            })

        this._history = []; this._future = []
        this._topology$.next({
            id: uuid(),
            name: tpl.name,
            nodes,
            links,
            createdAt: now,
            updatedAt: now,
            // Propagate routing hints from template
            underlayProtocol: tpl.underlayProtocol,
            overlayEnabled: tpl.overlayEnabled,
            vniBase: tpl.vniBase,
            irbEnabled: tpl.irbEnabled,
            irbGatewayBase: tpl.irbGatewayBase,
            irbMode: tpl.irbMode,
            oismEnabled: tpl.oismEnabled,
            macVrfEnabled: tpl.macVrfEnabled,
            telemetryEnabled: tpl.telemetryEnabled,
            // R2: fabric-wide staging defaults + annotations from template.
            // Deep-copied so user edits don't mutate the template object.
            ...(tpl.staging ? { staging: JSON.parse(JSON.stringify(tpl.staging)) } : {}),
            ...(tpl.annotations?.length ? { annotations: tpl.annotations.map(a => ({ ...a })) } : {}),
            // RLI 52387: carry IP-VRF / EVPN T5 stitching definitions into the
            // live topology. Deep-cloned (nested objects/arrays) so canvas
            // edits never mutate the source template.
            ...(tpl.vrfs?.length ? { vrfs: JSON.parse(JSON.stringify(tpl.vrfs)) } : {}),
        })
        this._selectedNode$.next(null)
        this._selectedLink$.next(null)

        // Generate configs after topology is committed (topology-aware: BGP neighbors from links)
        if (hasVendor) {
            this._regenerateConfigs()
        }
    }

    rename (name: string): void { this._patch({ name }) }

    exportJSON (): string { return JSON.stringify(this.topology, null, 2) }

    importJSON (json: string): boolean {
        try {
            const t = JSON.parse(json) as Topology
            if (!Array.isArray(t.nodes) || !Array.isArray(t.links)) { return false }
            this._history = []; this._future = []
            // migrate old topologies: ensure ports have enabled field
            // Reset node statuses to 'stopped' — saved status is stale; containers may not be running
            t.nodes = t.nodes.map(n => ({
                ...n,
                status: 'stopped' as NodeStatus,
                ports: n.ports.map(p => ({ ...p, enabled: p.enabled ?? true })),
            }))
            this._topology$.next(t)
            this._selectedNode$.next(null)
            this._selectedLink$.next(null)
            return true
        } catch { return false }
    }

    freePorts (nodeId: string): NodePort[] {
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return [] }
        const used = new Set(
            this.topology.links.flatMap(l => {
                const r: string[] = []
                if (l.sourceNodeId === nodeId) { r.push(l.sourcePortId) }
                if (l.targetNodeId === nodeId) { r.push(l.targetPortId) }
                return r
            }),
        )
        return node.ports.filter(p => !used.has(p.id) && p.enabled)
    }

    // ── IPv6 auto-addressing ────────────────────────────────────────────────

    autoAddressLinksV6 (overwrite = false, basePrefix = '2001:db8::/32'): AutoAddressSummary {
        const totalLinks = this.topology.links.length
        if (!totalLinks) {
            return { totalLinks: 0, addressedLinks: 0, skippedExisting: 0, skippedMissing: 0, skippedCapacity: 0 }
        }

        const nodes = this.topology.nodes.map(n => ({
            ...n,
            ports: n.ports.map(p => ({ ...p })),
        }))
        const nodeById = new Map(nodes.map(n => [n.id, n] as const))

        let addressedLinks = 0
        let skippedExisting = 0
        let skippedMissing = 0

        // Parse base prefix for generation
        const [baseIp] = basePrefix.split('/')
        const baseParts = expandIPv6(baseIp)

        for (const link of this.topology.links) {
            const sourceNode = nodeById.get(link.sourceNodeId)
            const targetNode = nodeById.get(link.targetNodeId)
            const sourcePort = sourceNode?.ports.find(p => p.id === link.sourcePortId)
            const targetPort = targetNode?.ports.find(p => p.id === link.targetPortId)

            if (!sourcePort || !targetPort) { skippedMissing += 1; continue }
            if (!overwrite && (sourcePort.ipv6Address?.trim() || targetPort.ipv6Address?.trim())) {
                skippedExisting += 1; continue
            }

            // Each link gets a /127 subnet: base::linkIndex*2 and base::linkIndex*2+1
            const subnetIdx = addressedLinks
            const addr0 = formatIPv6WithOffset(baseParts, subnetIdx * 2)
            const addr1 = formatIPv6WithOffset(baseParts, subnetIdx * 2 + 1)

            sourcePort.ipv6Address = `${addr0}/127`
            targetPort.ipv6Address = `${addr1}/127`
            addressedLinks += 1
        }

        this._patch({ nodes })

        // Regenerate vendor configs so interfaces get their IPv6 addresses
        if (addressedLinks > 0) {
            this._regenerateConfigs()
        }

        return { totalLinks, addressedLinks, skippedExisting, skippedMissing, skippedCapacity: 0 }
    }

    autoAssignLoopbacksV6 (overwrite = false, basePrefix = 'fd00::/64'): AutoLoopbackSummary {
        const totalNodes = this.topology.nodes.length
        if (!totalNodes) {
            return { totalNodes: 0, eligibleNodes: 0, assigned: 0, skippedExisting: 0, skippedIneligible: 0, skippedCapacity: 0 }
        }

        const [baseIp] = basePrefix.split('/')
        const baseParts = expandIPv6(baseIp)
        const eligibleTypes: NodeType[] = ['router', 'switch', 'firewall']

        const nodes = this.topology.nodes.map(n => ({ ...n, ports: n.ports.map(p => ({ ...p })) }))

        let eligibleNodes = 0
        let assigned = 0
        let skippedExisting = 0
        let skippedIneligible = 0
        let cursor = 1

        for (const node of nodes) {
            if (!eligibleTypes.includes(node.type)) { skippedIneligible += 1; continue }
            eligibleNodes += 1

            if (node.loopbackIpv6?.trim() && !overwrite) { skippedExisting += 1; continue }

            node.loopbackIpv6 = `${formatIPv6WithOffset(baseParts, cursor)}/128`
            cursor += 1
            assigned += 1
        }

        this._patch({ nodes })

        // Regenerate vendor configs so Loopback0 interface and router-id reflect the new IPs
        if (assigned > 0) {
            this._regenerateConfigs()
        }

        return { totalNodes, eligibleNodes, assigned, skippedExisting, skippedIneligible, skippedCapacity: 0 }
    }

    // ── Topology Builder ─────────────────────────────────────────────────────

    /** Pure layout computation — returns positioned nodes & links without committing */
    computeTopologyPreview (config: BuilderConfig): PreviewTopology {
        const TIER_SPACING_Y = 200
        const NODE_SPACING_X = 140
        const roleTier: Record<string, number> = {
            'super-spine': 0, spine: 1, leaf: 2, 'border-leaf': 2,
            tor: 3, access: 3, aggregation: 1, core: 0, gateway: 0, custom: 3,
        }

        const sortedGroups = [...config.groups].sort(
            (a, b) => (roleTier[a.role] ?? 2) - (roleTier[b.role] ?? 2),
        )

        const nodes: PreviewNode[] = []
        const nodeIndicesByRole = new Map<NodeRole, number[]>()

        let globalTierIdx = -1
        let prevTier = -1
        for (const group of sortedGroups) {
            const tier = roleTier[group.role] ?? 2
            if (tier !== prevTier) { globalTierIdx += 1; prevTier = tier }

            const roleMeta = NODE_ROLE_META[group.role]
            const y = 80 + globalTierIdx * TIER_SPACING_Y
            const totalWidth = group.count * NODE_SPACING_X
            const startX = Math.max(80, 400 - totalWidth / 2)

            const roleIndices: number[] = nodeIndicesByRole.get(group.role) ?? []

            for (let i = 0; i < group.count; i++) {
                const idx = nodes.length
                nodes.push({
                    role: group.role,
                    label: `${roleMeta.label}-${i + 1}`,
                    x: startX + i * NODE_SPACING_X,
                    y,
                    portCount: group.portCount ?? roleMeta.defaultPortCount,
                })
                roleIndices.push(idx)
            }
            nodeIndicesByRole.set(group.role, roleIndices)
        }

        // Link pairing
        const links: PreviewLink[] = []
        const portCapacity = new Map<number, number>() // nodeIdx → max ports
        for (let ni = 0; ni < nodes.length; ni++) {
            const grp = config.groups.find(g => g.role === nodes[ni].role)
            portCapacity.set(ni, grp?.portCount ?? NODE_ROLE_META[nodes[ni].role].defaultPortCount)
        }
        const usedPorts = new Map<number, number>() // nodeIdx → used count

        for (const rule of config.linkRules) {
            const srcIndices = nodeIndicesByRole.get(rule.sourceRole) ?? []
            const tgtIndices = nodeIndicesByRole.get(rule.targetRole) ?? []
            if (!srcIndices.length || !tgtIndices.length) { continue }

            const pairs: [number, number][] = []

            switch (rule.pattern) {
                case 'custom': // deprecated — falls through to full-mesh
                case 'full-mesh':
                    if (rule.sourceRole === rule.targetRole) {
                        for (let i = 0; i < srcIndices.length; i++) {
                            for (let j = i + 1; j < srcIndices.length; j++) {
                                pairs.push([srcIndices[i], srcIndices[j]])
                            }
                        }
                    } else {
                        for (const s of srcIndices) {
                            for (const t of tgtIndices) { pairs.push([s, t]) }
                        }
                    }
                    break
                case 'ring': {
                    const ring = rule.sourceRole === rule.targetRole
                        ? srcIndices
                        : [...srcIndices, ...tgtIndices]
                    for (let i = 0; i < ring.length; i++) {
                        pairs.push([ring[i], ring[(i + 1) % ring.length]])
                    }
                    break
                }
                case 'dual-homed':
                    for (const t of tgtIndices) {
                        for (let i = 0; i < Math.min(2, srcIndices.length); i++) {
                            pairs.push([srcIndices[i], t])
                        }
                    }
                    break
            }

            for (const [si, ti] of pairs) {
                for (let li = 0; li < rule.linksPerPair; li++) {
                    const sUsed = usedPorts.get(si) ?? 0
                    const tUsed = usedPorts.get(ti) ?? 0
                    if (sUsed >= (portCapacity.get(si) ?? 0) || tUsed >= (portCapacity.get(ti) ?? 0)) { break }
                    const srcGroup = config.groups.find(g => g.role === nodes[si].role)
                    const tgtGroup = config.groups.find(g => g.role === nodes[ti].role)
                    const srcPort = this._generatePort(srcGroup?.vendor, sUsed, srcGroup?.speed ?? NODE_ROLE_META[nodes[si].role].defaultSpeed).label
                    const tgtPort = this._generatePort(tgtGroup?.vendor, tUsed, tgtGroup?.speed ?? NODE_ROLE_META[nodes[ti].role].defaultSpeed).label
                    links.push({ srcIdx: si, tgtIdx: ti, srcPort, tgtPort })
                    usedPorts.set(si, sUsed + 1)
                    usedPorts.set(ti, tUsed + 1)
                }
            }
        }

        // Populate usedPorts on each node
        for (let ni = 0; ni < nodes.length; ni++) {
            nodes[ni].usedPorts = usedPorts.get(ni) ?? 0
        }

        return { nodes, links }
    }

    // ── Vendor-specific port naming ──────────────────────────────────────────

    private _generatePort (vendor: string | undefined, portIndex: number, speed?: PortSpeed): { id: string; label: string } {
        const v = (vendor ?? '').toLowerCase()
        const p = portIndex

        switch (v) {
            case 'juniper':
                return { id: `et${p}`, label: `et-0/0/${p}` }
            case 'sonic':
                return { id: `e${p * 4}`, label: `Ethernet${p * 4}` }
            case 'arista':
                return { id: `eth${p + 1}`, label: `Ethernet${p + 1}` }
            case 'cisco': {
                const cp = this._ciscoPrefix(speed)
                return { id: `${cp.short}${p}`, label: `${cp.long}0/${p}` }
            }
            case 'nokia':
                return { id: `p1/${p + 1}`, label: `1/1/c${p + 1}` }
            case 'dell':
                return { id: `eth${p + 1}`, label: `ethernet1/1/${p + 1}` }
            case 'hpe':
                return { id: `p${p + 1}`, label: `${p + 1}` }
            case 'huawei': {
                const hp = this._huaweiPrefix(speed)
                return { id: `${hp.short}${p}`, label: `${hp.long}0/0/${p}` }
            }
            case 'mikrotik':
                return { id: `sfp${p + 1}`, label: `sfp-sfpplus${p + 1}` }
            case 'extreme':
                return { id: `p${p + 1}`, label: `${p + 1}` }
            default:
                return { id: `e${p}`, label: `e0/${p}` }
        }
    }

    private _ciscoPrefix (speed?: PortSpeed): { short: string; long: string } {
        switch (speed) {
            case '10M': case '100M': case '1G':
                return { short: 'gi', long: 'Gi' }
            case '2.5G': case '5G': case '10G':
                return { short: 'te', long: 'Te' }
            case '25G':
                return { short: 'twe', long: 'Twe' }
            case '40G':
                return { short: 'fo', long: 'Fo' }
            case '50G': case '100G':
                return { short: 'hu', long: 'Hu' }
            case '200G': case '400G': case '800G':
                return { short: 'fh', long: 'FH' }
            default:
                return { short: 'gi', long: 'Gi' }
        }
    }

    private _huaweiPrefix (speed?: PortSpeed): { short: string; long: string } {
        switch (speed) {
            case '10M': case '100M': case '1G':
                return { short: 'ge', long: 'GE' }
            case '2.5G': case '5G': case '10G':
                return { short: '10ge', long: '10GE' }
            case '25G':
                return { short: '25ge', long: '25GE' }
            case '40G':
                return { short: '40ge', long: '40GE' }
            case '50G': case '100G':
                return { short: '100ge', long: '100GE' }
            case '200G': case '400G': case '800G':
                return { short: '400ge', long: '400GE' }
            default:
                return { short: 'ge', long: 'GE' }
        }
    }

    buildCustomTopology (config: BuilderConfig): void {
        const now = new Date().toISOString()
        const preview = this.computeTopologyPreview(config)

        // Build full TopologyNode[] from preview positions
        const allNodes: TopologyNode[] = []
        const nodeIdByIdx = new Map<number, string>()

        for (let ni = 0; ni < preview.nodes.length; ni++) {
            const pn = preview.nodes[ni]
            const group = config.groups.find(g => g.role === pn.role)!
            const roleMeta = NODE_ROLE_META[pn.role]
            const portCount = group.portCount ?? roleMeta.defaultPortCount
            const speed = group.speed ?? roleMeta.defaultSpeed
            const vendor = group.vendor
            const isJuniper = vendor?.toLowerCase() === 'juniper'

            const id = uuid()
            nodeIdByIdx.set(ni, id)

            const ports: NodePort[] = []
            for (let p = 0; p < portCount; p++) {
                const { id: portId, label: portLabel } = this._generatePort(vendor, p, speed)
                ports.push({ id: portId, label: portLabel, enabled: true, speed })
            }

            allNodes.push({
                id, type: roleMeta.defaultType, label: pn.label,
                x: pn.x, y: pn.y,
                status: 'stopped', ports, mapped: false,
                vendor: group.vendor, model: group.model,
                switchFamily: isJuniper ? 'QFX' as SwitchFamily : undefined,
                vlans: group.vlans ? group.vlans.map(v => ({ ...v })) : undefined,
                role: group.role,
            })
        }

        // ── Protocol-specific auto-assignment ──
        const proto = config.underlayProtocol

        if (proto === 'ebgp') {
            // eBGP: unique ASN per node
            const spineAsnStart = config.spineAsnStart ?? 65000
            const leafAsnStart  = config.leafAsnStart ?? 65100
            let spineIdx = 0, leafIdx = 0, otherIdx = 0
            for (const node of allNodes) {
                if (node.role === 'spine' || node.role === 'super-spine') {
                    node.asn = spineAsnStart + spineIdx++
                } else if (node.role === 'leaf' || node.role === 'border-leaf' || node.role === 'tor') {
                    node.asn = leafAsnStart + leafIdx++
                } else {
                    node.asn = leafAsnStart + 200 + otherIdx++
                }
            }
        }

        if (proto === 'ibgp-rr') {
            // iBGP-RR: same ASN for all nodes + OSPF area 0 for IGP reachability
            const sharedAsn = config.spineAsnStart ?? 65000
            for (const node of allNodes) {
                node.asn = sharedAsn
                node.ospfArea = 0
            }
        }

        if (proto === 'ospf' || proto === 'ospfv3') {
            // OSPF: spines in area 0, leaves in area 0 (single-area default)
            for (const node of allNodes) {
                node.ospfArea = 0
            }
        }

        if (proto === 'isis') {
            // IS-IS: spines Level 2, leaves L1/L2
            let sidIdx = 1
            for (const node of allNodes) {
                if (node.role === 'spine' || node.role === 'super-spine') {
                    node.isisLevel = 2
                } else if (node.role === 'leaf' || node.role === 'border-leaf' || node.role === 'tor') {
                    node.isisLevel = 12 // L1/L2
                } else {
                    node.isisLevel = 2
                }
                node.nodeSid = sidIdx++
            }
        }

        // Build full TopologyLink[] from preview links
        const allLinks: TopologyLink[] = []
        const usedPorts = new Map<string, number>()

        for (const pl of preview.links) {
            const srcId = nodeIdByIdx.get(pl.srcIdx)!
            const tgtId = nodeIdByIdx.get(pl.tgtIdx)!
            const srcNode = allNodes.find(n => n.id === srcId)!
            const tgtNode = allNodes.find(n => n.id === tgtId)!

            const srcPortIdx = usedPorts.get(srcId) ?? 0
            const tgtPortIdx = usedPorts.get(tgtId) ?? 0
            if (srcPortIdx >= srcNode.ports.length || tgtPortIdx >= tgtNode.ports.length) { continue }

            allLinks.push({
                id: uuid(),
                type: 'ethernet',
                sourceNodeId: srcId,
                sourcePortId: srcNode.ports[srcPortIdx].id,
                targetNodeId: tgtId,
                targetPortId: tgtNode.ports[tgtPortIdx].id,
            })
            usedPorts.set(srcId, srcPortIdx + 1)
            usedPorts.set(tgtId, tgtPortIdx + 1)
        }

        // Commit topology
        const topo: Topology = {
            id: uuid(),
            name: config.name,
            nodes: allNodes,
            links: allLinks,
            createdAt: now,
            updatedAt: now,
            // Store BGP/EVPN config hints for _regenerateConfigs()
            underlayProtocol: config.underlayProtocol && config.underlayProtocol !== 'none'
                ? config.underlayProtocol : undefined,
            overlayEnabled: config.overlayEnabled || undefined,
            vniBase: config.vniBase,
            irbEnabled: config.irbEnabled,
            irbMode: config.irbMode,
            irbGatewayBase: config.irbGatewayBase,
            macVrfEnabled: config.macVrfEnabled,
            oismEnabled: config.oismEnabled,
            telemetryEnabled: config.telemetryEnabled,
            telemetryConfig: config.telemetryConfig,
        }

        this._history = []; this._future = []
        this._topology$.next(topo)
        this._selectedNode$.next(null)
        this._selectedLink$.next(null)

        // Auto-address after topology is set
        if (config.ipConfig.autoAssign) {
            const mode = config.ipConfig.mode
            if (mode === 'ipv4' || mode === 'dual') {
                this.autoAddressLinks(false, config.ipConfig.ipv4Base)
                this.autoAssignLoopbacks(false, config.ipConfig.loopbackV4)
            }
            if (mode === 'ipv6' || mode === 'dual') {
                this.autoAddressLinksV6(
                    mode === 'ipv6',
                    config.ipConfig.ipv6Base,
                )
                this.autoAssignLoopbacksV6(
                    mode === 'ipv6',
                    config.ipConfig.loopbackV6,
                )
            }
        }

        // Apply service profile (VLANs + port modes) before config generation
        if (config.serviceProfileId) {
            this.applyServiceProfile(config.serviceProfileId, true, false)
        }

        // Generate vendor configs (must run AFTER service profile so configs include VLANs/port modes)
        if (config.generateConfigs) {
            this._regenerateConfigs()
        }
    }

    // ── Build from network discovery (LLDP) ───────────────────────────────────

    /**
     * Build (or extend) the topology from a network-discovery result.
     * Creates one TopologyNode per discovered device and one TopologyLink per
     * LLDP adjacency. Existing nodes with matching hostnames are updated in
     * place rather than duplicated.
     *
     * @param devices Discovered devices (hostname, mgmtIp, vendor, model, interfaces).
     * @param links   LLDP adjacencies between hostnames + interface names.
     * @param opts.replace        If true, wipe the current topology first. Default: false.
     * @param opts.sshUsername    Carry these creds onto every newly-created node.
     * @param opts.sshPassword
     * @returns Summary counts.
     */
    buildFromDiscovery (
        devices: Array<{ hostname: string; mgmtIp: string; vendor: string; model: string; interfaces: string[]; aliases?: string[] }>,
        links: Array<{ srcHost: string; srcInterface: string; dstHost: string; dstInterface: string }>,
        opts: { replace?: boolean; sshUsername?: string; sshPassword?: string } = {},
    ): { nodesAdded: number; nodesUpdated: number; linksAdded: number; linksSkipped: number } {
        // Snapshot starting state
        const startNodes: TopologyNode[] = opts.replace ? [] : [...this.topology.nodes]
        const startLinks: TopologyLink[] = opts.replace ? [] : [...this.topology.links]

        // hostname/IP/short-name → node lookup table.
        //
        // LLDP frequently reports the neighbor system-name as an FQDN
        // (`spine-1.lab.example.com`), but the local node label may be the
        // short form (`spine-1`) or vice versa. Also, some LLDP variants
        // report the management IP instead of the hostname. Register every
        // plausible key for each node so cross-form lookups work.
        const byHost = new Map<string, TopologyNode>()
        const shortName = (s: string): string => (s ?? '').toLowerCase().split('.')[0]
        const registerNode = (n: TopologyNode): void => {
            const labelLower = (n.label || '').toLowerCase()
            if (labelLower && !byHost.has(labelLower)) { byHost.set(labelLower, n) }
            const sn = shortName(labelLower)
            if (sn && sn !== labelLower && !byHost.has(sn)) { byHost.set(sn, n) }
            const ip = (n.mgmtIp || '').toLowerCase()
            if (ip && !byHost.has(ip)) { byHost.set(ip, n) }
        }
        for (const n of startNodes) { registerNode(n) }

        // Heuristic role inference from hostname / model
        const inferRole = (hostname: string, model: string): NodeRole => {
            const h = (hostname || '').toLowerCase()
            const m = (model || '').toLowerCase()
            if (h.includes('super-spine') || h.includes('superspine')) { return 'super-spine' }
            if (h.includes('spine') || /(^|[-_])sp\d/.test(h))         { return 'spine' }
            if (h.includes('border-leaf') || h.includes('borderleaf')) { return 'border-leaf' }
            if (h.includes('leaf') || /(^|[-_])lf\d/.test(h))          { return 'leaf' }
            if (h.includes('tor'))                                     { return 'tor' }
            if (h.includes('core'))                                    { return 'core' }
            if (h.includes('agg'))                                     { return 'aggregation' }
            if (h.includes('access'))                                  { return 'access' }
            // Cisco-style fabric clues from model when hostname is opaque
            if (m.includes('qfx10') || m.includes('9500') || m.includes('7800')) { return 'spine' }
            if (m.includes('qfx5') || m.includes('9300') || m.includes('7300'))  { return 'leaf' }
            return 'custom'
        }

        // Maps role to (NodeType, layoutRow, displayLabel)
        const roleLayout: Record<NodeRole, { type: NodeType; row: number }> = {
            'super-spine': { type: 'router', row: 0 },
            'spine':       { type: 'router', row: 1 },
            'core':        { type: 'router', row: 1 },
            'aggregation': { type: 'switch', row: 2 },
            'border-leaf': { type: 'switch', row: 2 },
            'leaf':        { type: 'switch', row: 2 },
            'tor':         { type: 'switch', row: 3 },
            'access':      { type: 'switch', row: 3 },
            'gateway':     { type: 'router', row: 1 },
            'custom':      { type: 'switch', row: 2 },
        }

        const COL_W = 200             // horizontal spacing between nodes in a tier row
        const ROW_H = 220             // vertical spacing between tier rows (separate, non-overlapping)
        const WRAP_ROW_H = 160        // vertical offset between wrapped sub-rows of the same tier
        const MAX_COLS = 10           // wrap tier after this many nodes (more rows, less crowding)
        const X_ORIGIN = 120
        const Y_ORIGIN = 100

        // Build the in-memory node array
        const nodes: TopologyNode[] = [...startNodes]
        let nodesAdded = 0
        let nodesUpdated = 0

        // Fuzzy lookup: try the verbatim key, then short-name, then IP.
        // This is the SAME match policy used by inventory-mode discovery and
        // is what makes mixed-FQDN/short-name inventories link up correctly.
        const lookupNode = (rawKey: string): TopologyNode | undefined => {
            const k = (rawKey || '').toLowerCase()
            if (!k) { return undefined }
            return byHost.get(k) ?? byHost.get(shortName(k))
        }

        // Pass 1: create-or-update node per discovered device
        for (const dev of devices) {
            const key = (dev.hostname || dev.mgmtIp || '').toLowerCase()
            if (!key) { continue }
            // Match against verbatim, short-name, AND mgmt IP.
            const existing = lookupNode(key) ?? lookupNode(dev.mgmtIp)
            const role = inferRole(dev.hostname, dev.model)
            const meta = roleLayout[role] ?? roleLayout.custom

            if (existing) {
                // Merge: keep existing position, fill gaps in vendor/model/mgmtIp.
                const idx = nodes.findIndex(n => n.id === existing.id)
                if (idx >= 0) {
                    nodes[idx] = {
                        ...existing,
                        vendor: existing.vendor || dev.vendor,
                        model: existing.model || dev.model,
                        mgmtIp: existing.mgmtIp || dev.mgmtIp,
                        role: existing.role ?? role,
                        mapped: true,
                        mappedBy: existing.mappedBy ?? 'hostname',
                        sshUsername: existing.sshUsername || opts.sshUsername,
                        sshPassword: existing.sshPassword || opts.sshPassword,
                    }
                    nodesUpdated++
                    // Re-register so the merged version is reachable via the
                    // discovered device's keys too (e.g. existing label is
                    // "Spine-2" but discovery just confirmed it's also
                    // "spine-2.englab.juniper.net").
                    registerNode(nodes[idx])
                    if (key && !byHost.has(key)) { byHost.set(key, nodes[idx]) }
                }
            } else {
                const ports: NodePort[] = (dev.interfaces?.length
                    ? dev.interfaces
                    : DEFAULT_PORTS[meta.type].map(p => p.label)
                ).map(label => ({ id: uuid(), label, enabled: true }))

                const node: TopologyNode = {
                    id: uuid(),
                    type: meta.type,
                    label: dev.hostname || dev.mgmtIp,
                    x: 0, y: 0,                            // laid out below
                    status: 'stopped',
                    ports,
                    vendor: dev.vendor,
                    model: dev.model,
                    mgmtIp: dev.mgmtIp,
                    role,
                    mapped: true,
                    mappedBy: 'hostname',
                    sshUsername: opts.sshUsername,
                    sshPassword: opts.sshPassword,
                }
                nodes.push(node)
                registerNode(node)             // registers verbatim + short + IP
                if (key && !byHost.has(key)) { byHost.set(key, node) }
                // Register every BFS-collected alias too so links that
                // reference this device by FQDN/sys-name resolve even when
                // BFS reached it via mgmt IP (and vice versa).
                for (const alias of (dev.aliases ?? [])) {
                    const a = (alias || '').toLowerCase()
                    if (a && !byHost.has(a)) { byHost.set(a, node) }
                    const sa = shortName(a)
                    if (sa && !byHost.has(sa)) { byHost.set(sa, node) }
                }
                nodesAdded++
            }
        }

        // Pass 2: layout newly-added nodes by role row + column index.
        // Existing nodes keep their positions. Each tier row wraps at MAX_COLS
        // and every tier is centered horizontally against the widest tier —
        // so 4 spines sit centered over a row of 40 leaves, not jammed at the
        // left edge.
        const existingIds = new Set(startNodes.map(n => n.id))
        const newNodes = nodes.filter(n => !existingIds.has(n.id))

        // Group new nodes by their tier row, preserving creation order.
        const tierGroups = new Map<number, TopologyNode[]>()
        for (const n of newNodes) {
            const role = (n.role ?? 'custom') as NodeRole
            const row = (roleLayout[role] ?? roleLayout.custom).row
            if (!tierGroups.has(row)) { tierGroups.set(row, []) }
            tierGroups.get(row)!.push(n)
        }

        // Width of the widest sub-row across all tiers (after wrapping).
        // Used as the reference for centering every tier.
        let canvasCols = 0
        for (const group of tierGroups.values()) {
            canvasCols = Math.max(canvasCols, Math.min(group.length, MAX_COLS))
        }
        if (canvasCols === 0) { canvasCols = 1 }
        const canvasWidthPx = (canvasCols - 1) * COL_W

        // Position nodes row-by-row. Place each tier (possibly wrapped) and
        // advance the Y cursor by enough rows to contain it plus a tier gap.
        const sortedTiers = [...tierGroups.keys()].sort((a, b) => a - b)
        let yCursor = Y_ORIGIN
        for (const tier of sortedTiers) {
            const group = tierGroups.get(tier)!
            const subRows = Math.ceil(group.length / MAX_COLS)
            for (let i = 0; i < group.length; i++) {
                const subRow = Math.floor(i / MAX_COLS)
                const colInSubRow = i % MAX_COLS
                // Count of nodes on THIS sub-row (last sub-row may be shorter)
                const nodesOnThisSubRow = Math.min(MAX_COLS, group.length - subRow * MAX_COLS)
                const subRowWidthPx = (nodesOnThisSubRow - 1) * COL_W
                const subRowLeft = X_ORIGIN + (canvasWidthPx - subRowWidthPx) / 2
                group[i].x = subRowLeft + colInSubRow * COL_W
                group[i].y = yCursor + subRow * WRAP_ROW_H
            }
            yCursor += Math.max(1, subRows) * WRAP_ROW_H + ROW_H
        }

        // Pass 3: convert LLDP adjacencies into TopologyLinks.
        // De-dupe by canonical endpoint pair so A↔B and B↔A don't both appear.
        const newLinks: TopologyLink[] = [...startLinks]
        const usedPorts = new Set<string>()
        for (const l of newLinks) {
            usedPorts.add(`${l.sourceNodeId}|${l.sourcePortId}`)
            usedPorts.add(`${l.targetNodeId}|${l.targetPortId}`)
        }
        const linkPairSeen = new Set<string>()
        for (const l of newLinks) {
            const a = `${l.sourceNodeId}|${l.sourcePortId}`
            const b = `${l.targetNodeId}|${l.targetPortId}`
            linkPairSeen.add(a < b ? `${a}::${b}` : `${b}::${a}`)
        }

        // Find-or-create a port on a node by interface label (case-insensitive).
        // LLDP gives real iface names; if the node was pre-existing and has only
        // generic ports, we add the iface as a fresh port so the link can latch.
        // When ifaceLabel is empty (e.g. LLDP returned a description we
        // rejected), pick the first port not already bound to a link instead
        // of creating a port with a blank label.
        const findOrAddPort = (node: TopologyNode, ifaceLabel: string): NodePort => {
            // Empty label → pick first unused port; if all are used, create a
            // synthetic placeholder so the link still renders.
            if (!ifaceLabel || !ifaceLabel.trim()) {
                for (const p of node.ports) {
                    if (!usedPorts.has(`${node.id}|${p.id}`)) { return p }
                }
                const placeholder: NodePort = {
                    id: uuid(), label: `port-${node.ports.length + 1}`, enabled: true,
                }
                node.ports.push(placeholder)
                return placeholder
            }
            const target = ifaceLabel.toLowerCase()
            const targetNorm = target.replace(/[-_/]/g, '')
            // 1) exact (case-insensitive)
            for (const p of node.ports) {
                if ((p.label || '').toLowerCase() === target) { return p }
            }
            // 2) normalized (handles et-0/0/0 vs et0/0/0)
            for (const p of node.ports) {
                if ((p.label || '').toLowerCase().replace(/[-_/]/g, '') === targetNorm) { return p }
            }
            // 3) create
            const fresh: NodePort = { id: uuid(), label: ifaceLabel, enabled: true }
            node.ports.push(fresh)
            return fresh
        }

        let linksAdded = 0
        let linksSkipped = 0
        // Track which adjacencies failed to resolve so we can log a useful
        // diagnostic when 0 links land — usually means LLDP-reported
        // hostnames don't match any inventory entry.
        const unresolvedHosts = new Set<string>()
        for (const adj of links) {
            const src = lookupNode(adj.srcHost)
            const dst = lookupNode(adj.dstHost)
            if (!src || !dst || src.id === dst.id) {
                if (!src) { unresolvedHosts.add(adj.srcHost) }
                if (!dst) { unresolvedHosts.add(adj.dstHost) }
                linksSkipped++; continue
            }
            const srcPort = findOrAddPort(src, adj.srcInterface)
            const dstPort = findOrAddPort(dst, adj.dstInterface)
            const a = `${src.id}|${srcPort.id}`
            const b = `${dst.id}|${dstPort.id}`
            const pair = a < b ? `${a}::${b}` : `${b}::${a}`
            if (linkPairSeen.has(pair) || usedPorts.has(a) || usedPorts.has(b)) {
                linksSkipped++; continue
            }
            newLinks.push({
                id: uuid(),
                type: 'ethernet',
                sourceNodeId: src.id,
                sourcePortId: srcPort.id,
                targetNodeId: dst.id,
                targetPortId: dstPort.id,
            })
            linkPairSeen.add(pair)
            usedPorts.add(a); usedPorts.add(b)
            linksAdded++
        }

        // Surface a debug log when nothing linked — pinpoints unresolved
        // hostnames so the user knows why their canvas stayed empty.
        if (linksAdded === 0 && unresolvedHosts.size > 0) {
            console.warn(
                `[buildFromDiscovery] 0 links added — ${unresolvedHosts.size} LLDP hostname(s) ` +
                `did not match any node in inventory: ${[...unresolvedHosts].slice(0, 8).join(', ')}` +
                (unresolvedHosts.size > 8 ? ` …and ${unresolvedHosts.size - 8} more` : '') +
                `. Available node labels: ${[...nodes].slice(0, 8).map(n => n.label).join(', ')}`,
            )
        }

        // Commit
        this._patch({ nodes, links: newLinks })
        return { nodesAdded, nodesUpdated, linksAdded, linksSkipped }
    }

    /**
     * Re-flow ALL existing nodes into a clean layout. Supported modes:
     *   - 'hierarchical' (default) — tier rows with barycenter sort
     *   - 'grid'                   — sqrt(N) × sqrt(N) grid
     *   - 'circular'               — evenly spaced ring
     *   - 'force'                  — spring simulation (Fruchterman-Reingold)
     *
     * Useful after incremental discovery left the canvas crowded, or when
     * nodes have been added/removed and you want a clean reset.
     */
    relayoutAll (mode: 'hierarchical' | 'grid' | 'circular' | 'force' = 'hierarchical'): { moved: number } {
        const nodes = [...this.topology.nodes]
        if (!nodes.length) { return { moved: 0 } }

        let moved = 0
        const before = nodes.map(n => ({ id: n.id, x: n.x, y: n.y }))

        if (mode === 'grid')          { this._layoutGrid(nodes) }
        else if (mode === 'circular') { this._layoutCircular(nodes) }
        else if (mode === 'force')    { this._layoutForce(nodes) }
        else                          { this._layoutHierarchical(nodes) }

        // Count actually-moved nodes (some may have stayed put within rounding).
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].x !== before[i].x || nodes[i].y !== before[i].y) { moved++ }
        }

        // Replace nodes array (fresh ref so change-detection fires).
        this._patch({ nodes: [...nodes] })
        return { moved }
    }

    /** Simple grid layout: sqrt(N) cols, fixed cell size. */
    private _layoutGrid (nodes: TopologyNode[]): void {
        const COL_W = 200, ROW_H = 180, X_ORIGIN = 120, Y_ORIGIN = 100
        const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
        for (let i = 0; i < nodes.length; i++) {
            const r = Math.floor(i / cols)
            const c = i % cols
            nodes[i].x = X_ORIGIN + c * COL_W
            nodes[i].y = Y_ORIGIN + r * ROW_H
        }
    }

    /** Circular: nodes evenly spaced around a ring. Radius scales with N. */
    private _layoutCircular (nodes: TopologyNode[]): void {
        const N = nodes.length
        const radius = Math.max(200, N * 22)            // scale with node count
        const cx = 120 + radius                         // center x
        const cy = 100 + radius                         // center y
        const angleStep = (Math.PI * 2) / N
        for (let i = 0; i < N; i++) {
            const angle = -Math.PI / 2 + i * angleStep  // start at top, go clockwise
            nodes[i].x = cx + radius * Math.cos(angle)
            nodes[i].y = cy + radius * Math.sin(angle)
        }
    }

    /**
     * Force-directed layout (lightweight Fruchterman-Reingold).
     * - Every pair of nodes repels (Coulomb-like)
     * - Each link pulls its endpoints together (Hooke-like spring)
     * - Iterates with cooling temperature so the system settles
     *
     * Tuned for 10–200 nodes. Above that consider a worker; for now we
     * cap iterations so the UI thread stays responsive.
     */
    private _layoutForce (nodes: TopologyNode[]): void {
        const N = nodes.length
        if (N < 2) { return }

        // Seed positions: scatter randomly inside a square of side ~ k*sqrt(N).
        const k = 200
        const side = k * Math.sqrt(N)
        const cx = 120 + side / 2
        const cy = 100 + side / 2
        const idIdx = new Map<string, number>()
        for (let i = 0; i < N; i++) {
            idIdx.set(nodes[i].id, i)
            nodes[i].x = cx + (Math.random() - 0.5) * side
            nodes[i].y = cy + (Math.random() - 0.5) * side
        }

        // Precompute adjacency (link list for spring forces)
        const links = this.topology.links
            .map(l => [idIdx.get(l.sourceNodeId), idIdx.get(l.targetNodeId)])
            .filter((p): p is [number, number] => p[0] != null && p[1] != null)

        const ITERATIONS = Math.min(200, 100 + N * 2)
        const area = side * side
        const naturalLength = Math.sqrt(area / N)        // ideal edge length
        let temperature = side / 10                      // initial step cap

        for (let iter = 0; iter < ITERATIONS; iter++) {
            // displacement accumulator
            const dx = new Array(N).fill(0)
            const dy = new Array(N).fill(0)

            // Repulsion: every node pushes every other node away (O(N²)).
            for (let i = 0; i < N; i++) {
                for (let j = i + 1; j < N; j++) {
                    let ddx = nodes[i].x - nodes[j].x
                    let ddy = nodes[i].y - nodes[j].y
                    let dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01
                    const force = (naturalLength * naturalLength) / dist
                    ddx = (ddx / dist) * force
                    ddy = (ddy / dist) * force
                    dx[i] += ddx; dy[i] += ddy
                    dx[j] -= ddx; dy[j] -= ddy
                }
            }
            // Attraction: each link pulls endpoints together.
            for (const [a, b] of links) {
                let ddx = nodes[a].x - nodes[b].x
                let ddy = nodes[a].y - nodes[b].y
                const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01
                const force = (dist * dist) / naturalLength
                ddx = (ddx / dist) * force
                ddy = (ddy / dist) * force
                dx[a] -= ddx; dy[a] -= ddy
                dx[b] += ddx; dy[b] += ddy
            }
            // Apply, capped by current temperature (cooling schedule).
            for (let i = 0; i < N; i++) {
                const disp = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 0.01
                const capped = Math.min(disp, temperature)
                nodes[i].x += (dx[i] / disp) * capped
                nodes[i].y += (dy[i] / disp) * capped
            }
            // Linear cooling
            temperature = Math.max(0.5, temperature * (1 - iter / ITERATIONS))
        }
        // Translate so min(x,y) is at the origin offset (canvas coords are positive).
        let minX = Infinity, minY = Infinity
        for (const n of nodes) {
            if (n.x < minX) { minX = n.x }
            if (n.y < minY) { minY = n.y }
        }
        const tx = 120 - minX
        const ty = 100 - minY
        for (const n of nodes) { n.x += tx; n.y += ty }
    }

    /** Hierarchical (tier-row) layout — extracted from the previous relayoutAll. */
    private _layoutHierarchical (nodes: TopologyNode[]): void {
        if (!nodes.length) { return }

        // Same role → tier mapping the build uses. Mirrored here to keep the
        // re-layout self-contained (callers don't have to pass a config).
        const roleLayout: Record<string, { row: number }> = {
            'super-spine': { row: 0 },
            'spine':       { row: 1 },
            'core':        { row: 1 },
            'aggregation': { row: 2 },
            'border-leaf': { row: 2 },
            'leaf':        { row: 2 },
            'tor':         { row: 3 },
            'access':      { row: 3 },
            'gateway':     { row: 1 },
            'custom':      { row: 2 },
        }
        // Heuristic role inference for nodes that don't have a role tag.
        const inferRole = (n: { role?: string; label?: string; type: string; model?: string }): string => {
            if (n.role && n.role !== 'custom') { return n.role }
            const h = (n.label || '').toLowerCase()
            const m = (n.model || '').toLowerCase()
            if (h.includes('super-spine') || h.includes('superspine')) { return 'super-spine' }
            if (h.includes('spine'))                                    { return 'spine' }
            if (h.includes('border-leaf') || h.includes('borderleaf'))  { return 'border-leaf' }
            if (h.includes('leaf'))                                     { return 'leaf' }
            if (h.includes('tor'))                                      { return 'tor' }
            if (h.includes('core'))                                     { return 'core' }
            if (h.includes('agg'))                                      { return 'aggregation' }
            if (h.includes('access'))                                   { return 'access' }
            if (m.includes('qfx10') || m.includes('9500') || m.includes('7800')) { return 'spine' }
            if (m.includes('qfx5') || m.includes('9300') || m.includes('7300'))  { return 'leaf' }
            return 'custom'
        }

        const COL_W = 200
        const ROW_H = 220
        const WRAP_ROW_H = 160
        const MAX_COLS = 10
        const X_ORIGIN = 120
        const Y_ORIGIN = 100

        // Group every node by inferred tier row.
        const tierGroups = new Map<number, TopologyNode[]>()
        for (const n of nodes) {
            const role = inferRole(n)
            const row = (roleLayout[role] ?? roleLayout.custom).row
            if (!tierGroups.has(row)) { tierGroups.set(row, []) }
            tierGroups.get(row)!.push(n)
        }

        // ── Barycenter sort: minimize edge crossings between adjacent tiers ──
        //
        // For each pair of tiers (top→bottom and bottom→top), reorder the
        // lower tier's nodes by the mean column index of their connections
        // in the upper tier. Iterates a few sweeps to stabilize. This is
        // the same algorithm graphviz / dagre use for layered graph layout.
        //
        // Effect on a 4-spine 30-leaf Clos: leaves reorder so that leaves
        // connected to spine-1 cluster on the left, spine-2 next, etc —
        // dramatically cuts edge crossings without changing topology.
        const sortedTierIds = [...tierGroups.keys()].sort((a, b) => a - b)
        if (sortedTierIds.length >= 2 && this.topology.links.length > 0) {
            // node.id → adjacency set (counts duplicates, used for barycenter)
            const adjByNode = new Map<string, string[]>()
            for (const l of this.topology.links) {
                if (!adjByNode.has(l.sourceNodeId)) { adjByNode.set(l.sourceNodeId, []) }
                if (!adjByNode.has(l.targetNodeId)) { adjByNode.set(l.targetNodeId, []) }
                adjByNode.get(l.sourceNodeId)!.push(l.targetNodeId)
                adjByNode.get(l.targetNodeId)!.push(l.sourceNodeId)
            }
            const barycenter = (n: TopologyNode, peerTier: TopologyNode[]): number => {
                const peerIdx = new Map<string, number>()
                peerTier.forEach((p, i) => peerIdx.set(p.id, i))
                const adj = adjByNode.get(n.id) ?? []
                const cols = adj.map(id => peerIdx.get(id)).filter((x): x is number => x != null)
                if (!cols.length) { return Number.MAX_SAFE_INTEGER } // floats to the right
                return cols.reduce((a, b) => a + b, 0) / cols.length
            }
            // 4 sweeps: down, up, down, up — usually converges in 2.
            for (let sweep = 0; sweep < 4; sweep++) {
                const tierOrder = sweep % 2 === 0 ? sortedTierIds : [...sortedTierIds].reverse()
                for (let i = 1; i < tierOrder.length; i++) {
                    const peer = tierGroups.get(tierOrder[i - 1])!
                    const me = tierGroups.get(tierOrder[i])!
                    me.sort((a, b) => barycenter(a, peer) - barycenter(b, peer))
                }
            }
        }

        // Find widest tier (after wrapping) to center every other tier against.
        let canvasCols = 0
        for (const group of tierGroups.values()) {
            canvasCols = Math.max(canvasCols, Math.min(group.length, MAX_COLS))
        }
        if (canvasCols === 0) { canvasCols = 1 }
        const canvasWidthPx = (canvasCols - 1) * COL_W

        // Position each tier; advance Y cursor enough to clear wrapped sub-rows.
        let yCursor = Y_ORIGIN
        for (const tier of sortedTierIds) {
            const group = tierGroups.get(tier)!
            const subRows = Math.ceil(group.length / MAX_COLS)
            for (let i = 0; i < group.length; i++) {
                const subRow = Math.floor(i / MAX_COLS)
                const colInSubRow = i % MAX_COLS
                const nodesOnThisSubRow = Math.min(MAX_COLS, group.length - subRow * MAX_COLS)
                const subRowWidthPx = (nodesOnThisSubRow - 1) * COL_W
                const subRowLeft = X_ORIGIN + (canvasWidthPx - subRowWidthPx) / 2
                group[i].x = subRowLeft + colInSubRow * COL_W
                group[i].y = yCursor + subRow * WRAP_ROW_H
            }
            yCursor += Math.max(1, subRows) * WRAP_ROW_H + ROW_H
        }
        // No _patch here — the dispatcher (relayoutAll) commits and counts moves.
    }

    // ── Service Profiles ──────────────────────────────────────────────────────

    /**
     * Bulk-assign a routing protocol to topology nodes.
     * Clears previous protocol fields and sets new ones based on role.
     * @param nodeIds  If provided, only apply to these nodes; otherwise apply to all.
     * @returns Number of nodes affected.
     */
    applyProtocol (
        proto: 'none' | 'ebgp' | 'ibgp-rr' | 'ospf' | 'ospfv3' | 'isis',
        config: {
            spineAsnStart?: number; leafAsnStart?: number; ospfArea?: number; isisLevel?: 1 | 2 | 12;
            srMpls?: boolean; srv6?: boolean; srgbStart?: number; srgbEnd?: number; srv6LocatorBase?: string;
        },
        nodeIds?: Set<string>,
    ): number {
        const nodes = nodeIds?.size
            ? this.topology.nodes.filter(n => nodeIds.has(n.id))
            : this.topology.nodes

        // Infer role from label when no explicit role is set
        const role = (n: { role?: string; label: string; type: string }): string => {
            if (n.role && n.role !== 'custom') { return n.role }
            const lbl = n.label.toLowerCase()
            if (lbl.includes('super-spine')) { return 'super-spine' }
            if (lbl.includes('spine'))       { return 'spine' }
            if (lbl.includes('border-leaf') || lbl.includes('borderleaf')) { return 'border-leaf' }
            if (lbl.includes('leaf'))        { return 'leaf' }
            if (lbl.includes('tor'))         { return 'tor' }
            if (lbl.includes('core'))        { return 'core' }
            return 'custom'
        }

        // Only assign protocol fields to network devices, not servers/PCs/hosts
        const nonRoutingTypes = ['server', 'pc', 'host']

        // Clear old protocol fields on ALL nodes (including servers that may have stale ASNs)
        for (const n of nodes) {
            n.asn = undefined
            n.ospfArea = undefined
            n.isisLevel = undefined
            n.nodeSid = undefined
            n.srgbStart = undefined
            n.srgbEnd = undefined
            n.srv6Locator = undefined
        }

        if (proto === 'ebgp') {
            const spineAsnStart = config.spineAsnStart ?? 65000
            const leafAsnStart  = config.leafAsnStart ?? 65100
            let spineIdx = 0, leafIdx = 0, otherIdx = 0
            for (const n of nodes) {
                if (nonRoutingTypes.includes(n.type)) { continue }
                const r = role(n)
                if (r === 'spine' || r === 'super-spine') { n.asn = spineAsnStart + spineIdx++ }
                else if (r === 'leaf' || r === 'border-leaf' || r === 'tor') { n.asn = leafAsnStart + leafIdx++ }
                else { n.asn = (leafAsnStart) + 200 + otherIdx++ }
            }
        } else if (proto === 'ibgp-rr') {
            const sharedAsn = config.spineAsnStart ?? 65000
            for (const n of nodes) {
                if (nonRoutingTypes.includes(n.type)) { continue }
                n.asn = sharedAsn; n.ospfArea = 0
            }
        } else if (proto === 'ospf' || proto === 'ospfv3') {
            let sidIdx = 1
            for (const n of nodes) {
                if (nonRoutingTypes.includes(n.type)) { continue }
                n.ospfArea = config.ospfArea ?? 0
                // SR-MPLS with OSPF
                if (config.srMpls) {
                    n.nodeSid = sidIdx
                    n.srgbStart = config.srgbStart ?? 16000
                    n.srgbEnd = config.srgbEnd ?? 23999
                }
                // SRv6 with OSPF
                if (config.srv6) {
                    const base = config.srv6LocatorBase ?? 'fc00:0'
                    n.srv6Locator = `${base}:${sidIdx}::/48`
                }
                if (config.srMpls || config.srv6) { sidIdx++ }
            }
        } else if (proto === 'isis') {
            let sidIdx = 1
            for (const n of nodes) {
                if (nonRoutingTypes.includes(n.type)) { continue }
                const r = role(n)
                if (r === 'spine' || r === 'super-spine') { n.isisLevel = config.isisLevel ?? 2 }
                else if (r === 'leaf' || r === 'border-leaf' || r === 'tor') { n.isisLevel = 12 }
                else { n.isisLevel = config.isisLevel ?? 2 }
                // SR-MPLS (enabled when toggled on in dialog)
                if (config.srMpls) {
                    n.nodeSid = sidIdx
                    n.srgbStart = config.srgbStart ?? 16000
                    n.srgbEnd = config.srgbEnd ?? 23999
                }
                // SRv6
                if (config.srv6) {
                    const base = config.srv6LocatorBase ?? 'fc00:0'
                    n.srv6Locator = `${base}:${sidIdx}::/48`
                }
                sidIdx++
            }
        }

        const newUnderlay = proto === 'none' ? undefined : proto as any
        // IMPORTANT: `nodes` above may be a subset when nodeIds is provided
        // (scope = "selected"). We mutated those entries in place, but we must
        // still patch the FULL topology.nodes array back — otherwise _patch
        // replaces topology.nodes with the subset and drops every unselected
        // node. Use a fresh array reference so change detection fires.
        this._patch({ nodes: [...this.topology.nodes], underlayProtocol: newUnderlay })
        this._regenerateConfigs(true)
        return nodes.length
    }

    /**
     * Apply a service profile to the current topology.
     * Sets VLANs on all nodes and configures port modes based on role + link direction.
     * @param overwrite  If true, overwrites existing VLAN/port configs; otherwise skips already-configured ports.
     * @param regenConfigs  If true, regenerates vendor startup configs after applying.
     */
    applyServiceProfile (profileId: string, overwrite = false, regenConfigs = true): void {
        const profile = SERVICE_PROFILES.find(p => p.id === profileId)
        if (!profile) { return }

        const vlanTpl = VLAN_TEMPLATES.find(t => t.id === profile.vlanTemplateId)
        const vlans = vlanTpl ? vlanTpl.vlans.map(v => ({ ...v })) : []

        const topo = this.topology
        const links = topo.links

        // Propagate overlay flag from service profile to topology
        // Propagate overlay and IRB flags from service profile to topology
        if (profile.overlayEnabled != null) {
            topo.overlayEnabled = profile.overlayEnabled
        }
        if (profile.irbEnabled != null) {
            topo.irbEnabled = profile.irbEnabled
        }
        if (profile.irbMode) {
            topo.irbMode = profile.irbMode
        }

        // Role tier map for determining uplink/downlink direction
        const roleTier: Record<string, number> = {
            'super-spine': 0, spine: 1, leaf: 2, 'border-leaf': 2,
            tor: 3, access: 3, aggregation: 1, core: 0, gateway: 0, custom: 3,
        }

        // Infer role from label when no explicit role is set
        const inferRole = (node: { role?: string; label: string; type: string }): string => {
            if (node.role && node.role !== 'custom') { return node.role }
            const lbl = node.label.toLowerCase()
            if (lbl.includes('spine'))       { return 'spine' }
            if (lbl.includes('super-spine')) { return 'super-spine' }
            if (lbl.includes('border-leaf') || lbl.includes('borderleaf')) { return 'border-leaf' }
            if (lbl.includes('leaf'))        { return 'leaf' }
            if (lbl.includes('tor'))         { return 'tor' }
            if (lbl.includes('core'))        { return 'core' }
            if (lbl.includes('aggregation') || lbl.includes('agg')) { return 'aggregation' }
            if (lbl.includes('access'))      { return 'access' }
            if (lbl.includes('gateway') || lbl.includes('gw')) { return 'gateway' }
            if (node.type === 'server')      { return 'access' }
            return 'custom'
        }

        // Build port→linked-node-role index
        // portKey = `${nodeId}:${portId}` → role of the node on the other end
        const portPeer = new Map<string, NodeRole>()
        const connectedPorts = new Set<string>()

        for (const link of links) {
            const srcNode = topo.nodes.find(n => n.id === link.sourceNodeId)
            const tgtNode = topo.nodes.find(n => n.id === link.targetNodeId)
            if (!srcNode || !tgtNode) { continue }

            const srcKey = `${srcNode.id}:${link.sourcePortId}`
            const tgtKey = `${tgtNode.id}:${link.targetPortId}`

            portPeer.set(srcKey, inferRole(tgtNode) as NodeRole)
            portPeer.set(tgtKey, inferRole(srcNode) as NodeRole)
            connectedPorts.add(srcKey)
            connectedPorts.add(tgtKey)
        }

        const nodes = topo.nodes.map(node => {
            const nodeRole = inferRole(node)
            const nodeTier = roleTier[nodeRole] ?? 3

            // Apply VLANs to node
            const nodeVlans = (overwrite || !node.vlans?.length) ? vlans.map(v => ({ ...v })) : node.vlans

            // Apply port rules
            const ports = node.ports.map(port => {
                const portKey = `${node.id}:${port.id}`
                const isConnected = connectedPorts.has(portKey)
                const peerRole = portPeer.get(portKey)
                const peerTier = peerRole != null ? (roleTier[peerRole] ?? 3) : null

                // Determine this port's scope
                const isUplink = isConnected && peerTier != null && peerTier < nodeTier
                const isDownlink = isConnected && peerTier != null && peerTier > nodeTier
                const isFree = !isConnected

                // Find first matching rule for this port
                let ruleMatched = false
                for (const rule of profile.portRules) {
                    if (!rule.roles.includes(nodeRole as any)) { continue }

                    let scopeMatch = false
                    switch (rule.scope) {
                        case 'uplinks':       scopeMatch = isUplink; break
                        case 'downlinks':     scopeMatch = isDownlink; break
                        case 'all-connected': scopeMatch = isConnected; break
                        case 'free-ports':    scopeMatch = isFree; break
                    }
                    if (!scopeMatch) { continue }

                    ruleMatched = true
                    // Skip if port already configured and not overwriting
                    if (!overwrite && port.vlanMode) { break }

                    return {
                        ...port,
                        vlanMode: rule.vlanMode as 'access' | 'trunk',
                        vlan: rule.vlanMode === 'access' ? rule.accessVlan : port.vlan,
                        trunkNativeVlan: rule.vlanMode === 'trunk' ? rule.trunkNativeVlan : port.trunkNativeVlan,
                        trunkAllowedVlans: rule.vlanMode === 'trunk' ? rule.trunkAllowedVlans : port.trunkAllowedVlans,
                    }
                }

                // Fallback: if no rule matched (e.g. node role not in any rule),
                // default connected ports to trunk; free ports to access only on edge roles
                if (!ruleMatched && (overwrite || !port.vlanMode)) {
                    if (isConnected) {
                        return { ...port, vlanMode: 'trunk' as const, trunkNativeVlan: 999, trunkAllowedVlans: 'all' }
                    } else if (isFree && vlans.length) {
                        // Only assign access mode on edge/leaf roles — spines and core should leave free ports unconfigured
                        const edgeRoles = ['leaf', 'border-leaf', 'tor', 'access', 'custom']
                        if (edgeRoles.includes(nodeRole)) {
                            return { ...port, vlanMode: 'access' as const, vlan: vlans[0].id }
                        }
                    }
                }

                return port
            })

            return { ...node, vlans: nodeVlans, ports }
        })

        this._patch({ nodes })

        // Always regenerate configs after applying a service profile — VLANs and port modes changed
        this._regenerateConfigs(true)
    }

    /** Regenerate vendor startup configs for all nodes that have a vendor set.
     *  Called internally after template load / builder build / service profile apply,
     *  and can be called externally when BGP-relevant fields (ASN, role) change. */
    regenerateConfigs (force = false): void { this._regenerateConfigs(force) }

    /** Set the topology-wide Day-0 staging defaults (NTP/SNMP/LLDP/etc).
     *  Per-node overrides go on individual nodes via updateNodeConfig. */
    setStaging (staging: any /* DeviceStagingConfig */): void {
        this._patch({ staging })
        this._regenerateConfigs(true)
    }

    private _regenerateConfigs (force = false): void {
        const topo = this.topology
        const nodeMap = new Map(topo.nodes.map(n => [n.id, n]))

        // Infer role from label when no explicit role is set
        const inferRole = (node: { role?: string; label: string; type: string }): string => {
            if (node.role && node.role !== 'custom') { return node.role }
            const lbl = node.label.toLowerCase()
            if (lbl.includes('super-spine')) { return 'super-spine' }
            if (lbl.includes('spine'))       { return 'spine' }
            if (lbl.includes('border-leaf') || lbl.includes('borderleaf')) { return 'border-leaf' }
            if (lbl.includes('leaf'))        { return 'leaf' }
            if (lbl.includes('tor'))         { return 'tor' }
            if (lbl.includes('core'))        { return 'core' }
            if (lbl.includes('access'))      { return 'access' }
            return 'custom'
        }

        // ── Pre-compute per-node BGP neighbor list from links ──
        const bgpNeighborMap = new Map<string, BgpNeighbor[]>()

        const isIbgpRr = topo.underlayProtocol === 'ibgp-rr'

        for (const link of topo.links) {
            const srcNode = nodeMap.get(link.sourceNodeId)
            const tgtNode = nodeMap.get(link.targetNodeId)
            if (!srcNode || !tgtNode) { continue }

            const srcPort = srcNode.ports.find(p => p.id === link.sourcePortId)
            const tgtPort = tgtNode.ports.find(p => p.id === link.targetPortId)
            if (!srcPort?.ipAddress || !tgtPort?.ipAddress) { continue }

            const srcIp = srcPort.ipAddress.split('/')[0]
            const tgtIp = tgtPort.ipAddress.split('/')[0]

            if (srcNode.asn != null && tgtNode.asn != null) {
                // For iBGP (same ASN in ibgp-rr mode): use loopback IPs for peering
                // Never fall back to mgmtIp — it may be a hostname or OOB address
                const sameAsn = srcNode.asn === tgtNode.asn
                const useLoopback = isIbgpRr && sameAsn
                const srcLoopback = srcNode.loopbackIp?.split('/')[0]
                const tgtLoopback = tgtNode.loopbackIp?.split('/')[0]

                const neighborIpForSrc = useLoopback && tgtLoopback ? tgtLoopback : tgtIp
                const neighborIpForTgt = useLoopback && srcLoopback ? srcLoopback : srcIp

                if (!bgpNeighborMap.has(srcNode.id)) { bgpNeighborMap.set(srcNode.id, []) }
                const srcList = bgpNeighborMap.get(srcNode.id)!
                // Deduplicate iBGP neighbors (multiple links to same loopback)
                if (!srcList.some(nb => nb.ip === neighborIpForSrc)) {
                    srcList.push({
                        ip: neighborIpForSrc, peerAsn: tgtNode.asn,
                        portLabel: srcPort.label, peerHostname: tgtNode.label,
                    })
                }

                if (!bgpNeighborMap.has(tgtNode.id)) { bgpNeighborMap.set(tgtNode.id, []) }
                const tgtList = bgpNeighborMap.get(tgtNode.id)!
                if (!tgtList.some(nb => nb.ip === neighborIpForTgt)) {
                    tgtList.push({
                        ip: neighborIpForTgt, peerAsn: srcNode.asn,
                        portLabel: tgtPort.label, peerHostname: srcNode.label,
                    })
                }
            }
        }

        // ── Pre-compute overlay neighbor lists (loopback IPs by role) ──
        const spineLoopbacks: string[] = []
        const leafLoopbacks: string[] = []
        for (const node of topo.nodes) {
            const loopIp = node.loopbackIp?.split('/')[0]
            if (!loopIp || node.asn == null) { continue }
            const r = inferRole(node)
            if (r === 'spine' || r === 'super-spine') {
                spineLoopbacks.push(loopIp)
            } else if (r === 'leaf' || r === 'border-leaf' || r === 'tor') {
                leafLoopbacks.push(loopIp)
            }
        }

        // ── Pre-compute per-node OSPF interface list from links ──
        const ospfInterfaceMap = new Map<string, OspfInterface[]>()

        for (const link of topo.links) {
            const srcNode = nodeMap.get(link.sourceNodeId)
            const tgtNode = nodeMap.get(link.targetNodeId)
            if (!srcNode || !tgtNode) { continue }
            if (srcNode.ospfArea == null && tgtNode.ospfArea == null) { continue }

            const srcPort = srcNode.ports.find(p => p.id === link.sourcePortId)
            const tgtPort = tgtNode.ports.find(p => p.id === link.targetPortId)
            if (!srcPort?.ipAddress || !tgtPort?.ipAddress) { continue }

            // Link area: when crossing areas, use the non-zero area (ABR scenario)
            const srcArea = srcNode.ospfArea ?? 0
            const tgtArea = tgtNode.ospfArea ?? 0
            const linkArea = srcArea === tgtArea ? srcArea : Math.max(srcArea, tgtArea)

            if (!ospfInterfaceMap.has(srcNode.id)) { ospfInterfaceMap.set(srcNode.id, []) }
            ospfInterfaceMap.get(srcNode.id)!.push({ portLabel: srcPort.label, area: linkArea })
            if (!ospfInterfaceMap.has(tgtNode.id)) { ospfInterfaceMap.set(tgtNode.id, []) }
            ospfInterfaceMap.get(tgtNode.id)!.push({ portLabel: tgtPort.label, area: linkArea })
        }

        // ── Pre-compute per-node IS-IS interface list from links ──
        const isisInterfaceMap = new Map<string, IsisInterface[]>()

        for (const link of topo.links) {
            const srcNode = nodeMap.get(link.sourceNodeId)
            const tgtNode = nodeMap.get(link.targetNodeId)
            if (!srcNode || !tgtNode) { continue }
            if (srcNode.isisLevel == null && tgtNode.isisLevel == null) { continue }

            const srcPort = srcNode.ports.find(p => p.id === link.sourcePortId)
            const tgtPort = tgtNode.ports.find(p => p.id === link.targetPortId)
            if (!srcPort?.ipAddress || !tgtPort?.ipAddress) { continue }

            // Interface level matches the node's IS-IS level
            const srcLevel = srcNode.isisLevel ?? 2
            const tgtLevel = tgtNode.isisLevel ?? 2

            if (!isisInterfaceMap.has(srcNode.id)) { isisInterfaceMap.set(srcNode.id, []) }
            isisInterfaceMap.get(srcNode.id)!.push({ portLabel: srcPort.label, level: srcLevel as 1 | 2 | 12 })
            if (!isisInterfaceMap.has(tgtNode.id)) { isisInterfaceMap.set(tgtNode.id, []) }
            isisInterfaceMap.get(tgtNode.id)!.push({ portLabel: tgtPort.label, level: tgtLevel as 1 | 2 | 12 })
        }

        // ── Read topology-level routing hints ──
        const topoUnderlay = topo.underlayProtocol               // explicit if set by builder/template
        const topoOverlay = topo.overlayEnabled === true
        const vniBase = topo.vniBase ?? 10000

        const nodes = topo.nodes.map((n, nodeIdx) => {
            if (!n.vendor) { return n }

            const loopIp = n.loopbackIp?.split('/')[0] ?? ''
            const hasAsn = n.asn != null
            const hasVlans = (n.vlans?.length ?? 0) > 0

            // Determine underlay protocol: prefer topology-level hint, fall back to eBGP when ASN present
            const underlay = topoUnderlay ?? (hasAsn ? 'ebgp' : undefined)

            // Determine overlay: require explicit topology-level flag + ASN
            // Spines are EVPN RRs even without VLANs; leaves need VLANs for VNI mappings
            const nodeRole = inferRole(n)
            const isSpineRole = nodeRole === 'spine' || nodeRole === 'super-spine'
            const isLeafRole = nodeRole === 'leaf' || nodeRole === 'border-leaf' || nodeRole === 'tor'
            const overlay = topoOverlay && hasAsn
                ? (isSpineRole || hasVlans)
                : false

            // ERB (symmetric): spines are L3-only RRs — no VLANs, no VNI
            // CRB (asymmetric): spines are centralized gateways — need VLANs for IRB
            const isCrb = topo.irbMode === 'asymmetric'
            const stripSpineVlans = isSpineRole && topoOverlay && !isCrb
            const nodeVlans = stripSpineVlans ? [] : (n.vlans ?? [])

            const ctx: VendorConfigContext = {
                nodeType: n.type,
                hostname: n.label,
                mgmtIp: n.mgmtIp ?? '',
                loopbackIp: n.loopbackIp ?? '',
                loopbackIpv6: n.loopbackIpv6 ?? '',
                sshUsername: '',
                model: n.model ?? '',
                switchFamily: (n.switchFamily ?? '') as SwitchFamily | '',
                vlans: nodeVlans,

                // BGP underlay context
                asn: n.asn,
                routerId: loopIp || undefined,
                bgpNeighbors: bgpNeighborMap.get(n.id) ?? [],
                underlayProtocol: underlay,
                isRouteReflector: isIbgpRr && isSpineRole,

                // EVPN-VXLAN overlay context
                overlayEnabled: overlay,
                overlayNeighbors: isLeafRole ? spineLoopbacks : leafLoopbacks,
                // Spines are EVPN RRs — no VTEP/VNI; only leafs get VNI mappings
                // ERB: spines are pure RRs (no VNI, no VTEP); CRB: spines are centralized gateways (need VNI + VTEP)
                vniMappings: (isSpineRole && !isCrb)
                    ? []
                    : (nodeVlans)
                        .filter(v => v.id >= 100 && v.id < 4000)
                        .map(v => ({ vlanId: v.id, vni: vniBase + v.id, vlanName: v.name })),
                vtepSourceIp: (isSpineRole && !isCrb) ? undefined : (loopIp || undefined),
                nodeRole: nodeRole as any,
                irbEnabled: topo.irbEnabled === true,
                irbGatewayBase: topo.irbGatewayBase,
                irbMode: topo.irbMode,
                oismEnabled: topo.oismEnabled === true,
                macVrfEnabled: topo.macVrfEnabled === true,
                telemetryEnabled: n.telemetryEnabled ?? topo.telemetryEnabled === true,
                telemetryConfig: topo.telemetryConfig,

                // OSPF underlay context
                ospfInterfaces: ospfInterfaceMap.get(n.id) ?? [],
                ospfArea: n.ospfArea,

                // SR-MPLS / SRv6 / MPLS-LDP context
                nodeSid: n.nodeSid,
                srgbStart: n.srgbStart,
                srgbEnd: n.srgbEnd,
                srv6Locator: n.srv6Locator,
                mplsLdp: n.mplsLdp,
                // MPLS interfaces: from IS-IS or OSPF interface maps (for SR-MPLS)
                mplsInterfaces: (isisInterfaceMap.get(n.id) ?? ospfInterfaceMap.get(n.id) ?? []).map((i: any) => i.portLabel),

                // IS-IS underlay context
                isisInterfaces: isisInterfaceMap.get(n.id) ?? [],
                isisLevel: n.isisLevel as 1 | 2 | 12 | undefined,
                isisNet: (n.isisLevel != null && loopIp)
                    ? (() => {
                        const parts = loopIp.split('.').map(Number)
                        if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) { return undefined }
                        const padded = parts.map(p => String(p).padStart(3, '0')).join('')
                        return `49.0001.${padded.slice(0, 4)}.${padded.slice(4, 8)}.${padded.slice(8, 12)}.00`
                    })()
                    : undefined,

                // ── EVPN T5↔T5 stitching (RLI 52387) ─────────────────────
                // Pass the node's array index + the topology-level vrfs[] so
                // the Junos emitter can lower ip-vrf + interconnect stanzas.
                // The emitter filters vrfs by `memberNodes.includes(nodeIndex)`,
                // so unaffected nodes get no extra config.
                nodeIndex: nodeIdx,
                vrfs: (topo as any).vrfs,
            }

            // Skip regeneration for nodes with pulled/manual configs unless forced by explicit user action
            if (!force && (n.configSource === 'pulled' || n.configSource === 'manual')) {
                return n
            }
            // Render Day-0 staging block (NTP/SNMP/LLDP/syslog/DNS/AAA/banner)
            // — fabric-wide defaults from topology.staging, with per-node
            // overrides from n.staging applied on top. Empty string when no
            // staging is configured, so nodes without staging look identical
            // to before this feature shipped.
            const merged = mergeStaging(topo.staging, (n as any).staging)
            const stagingBlock = renderStagingConfig(n.vendor, merged)
            const fabricBody = buildVendorStartupConfig(n.vendor, n.ports, ctx)
            const startupConfig = stagingBlock
                ? `${stagingBlock}\n${fabricBody}`
                : fabricBody
            return { ...n, startupConfig, configSource: 'generated' as any }
        })
        this._patch({ nodes })
    }

    // ── Private ────────────────────────────────────────────────────────────

    private _patchNode (id: string, changes: Partial<TopologyNode>): void {
        this._patch({
            nodes: this.topology.nodes.map(n => n.id === id ? { ...n, ...changes } : n),
        })
    }

    private _patch (partial: Partial<Topology>): void {
        this._history.push(this._topology$.value)
        if (this._history.length > HISTORY_LIMIT) { this._history.shift() }
        this._future = []
        this._topology$.next({
            ...this.topology, ...partial,
            updatedAt: new Date().toISOString(),
        })
    }

    // Patch without recording a history entry (used for continuous drag updates)
    private _patchSilent (partial: Partial<Topology>): void {
        this._topology$.next({ ...this.topology, ...partial })
    }

    private _empty (name: string): Topology {
        const now = new Date().toISOString()
        return { id: uuid(), name, nodes: [], links: [], annotations: [], createdAt: now, updatedAt: now }
    }
}
