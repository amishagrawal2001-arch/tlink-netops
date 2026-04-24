import {
    AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef,
    Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy,
    Output, SimpleChanges, ViewChild,
} from '@angular/core'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Topology, TopologyNode, NODE_TYPE_META } from '../api/interfaces'
import {
    from2DLayout, forceDirected3D, hierarchical3D, circular3D, sphere3D, LayoutPosition3D,
} from '../services/layout-helpers-3d'

type Layout3DMode = 'from-2d' | 'hierarchical' | 'force-directed' | 'circular' | 'sphere'

/** Live data keyed by container name (empty if not polling) */
export interface Live3DData {
    cpuByNode: Map<string, number>        // node.id → CPU %
    memByNode: Map<string, number>        // node.id → Mem %
    bgpUpByNode: Map<string, { up: number; total: number }>  // node.id → BGP up/total
    alarmsByNode: Map<string, number>     // node.id → alarm count
    driftByNode: Set<string>              // set of node.ids with config drift
    srLabelsByNode: Map<string, number>   // node.id → SR-MPLS label count
    vniByNode: Map<string, number>        // node.id → active VNI count
}

@Component({
    selector: 'netops-3d-canvas',
    templateUrl: './netops-3d-canvas.component.pug',
    styleUrls: ['./netops-3d-canvas.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Netops3dCanvasComponent implements AfterViewInit, OnChanges, OnDestroy {

    @Input() topology!: Topology
    @Input() selectedNodeId: string | null = null
    @Input() currentTheme: 'dark' | 'light' = 'dark'
    @Input() liveData: Live3DData | null = null

    @Output() nodeSelected = new EventEmitter<string | null>()
    @Output() nodeDoubleClicked = new EventEmitter<string>()
    @Output() nodeContextMenu = new EventEmitter<{ nodeId: string; x: number; y: number }>()
    @Output() nodeAdded = new EventEmitter<{ type: string; x: number; y: number }>()
    @Output() nodeMoved = new EventEmitter<{ nodeId: string; x: number; y: number }>()
    @Output() linkCreated = new EventEmitter<{ sourceNodeId: string; targetNodeId: string }>()

    @ViewChild('canvasContainer', { static: true }) containerRef!: ElementRef<HTMLDivElement>

    // Current layout mode (user-switchable via toolbar)
    layoutMode: Layout3DMode = 'from-2d'

    // UI state
    hoverNodeId: string | null = null
    hoverTooltipX = 0
    hoverTooltipY = 0
    vrSupported = false
    vrActive = false

    // Path highlighting
    pathHighlightNodeIds: Set<string> = new Set()
    pathHighlightLinkIds: Set<string> = new Set()

    private scene!: THREE.Scene
    private camera!: THREE.PerspectiveCamera
    private renderer!: THREE.WebGLRenderer
    private controls!: OrbitControls
    private rafId = 0
    private resizeObserver?: ResizeObserver
    private clock = new THREE.Clock()

    private nodeMeshes = new Map<string, THREE.Mesh>()
    private nodeLabels = new Map<string, THREE.Sprite>()
    private nodeStatus = new Map<string, THREE.Mesh>()
    private nodeAlarmRings = new Map<string, THREE.Mesh>()     // pulse ring for alarms
    private nodeDriftBadges = new Map<string, THREE.Sprite>()  // drift indicator
    private nodeCpuBars = new Map<string, THREE.Group>()       // CPU/mem mini-bars
    private linkLines = new Map<string, THREE.Mesh>()          // Tube geometry for link thickness
    private positions = new Map<string, LayoutPosition3D>()
    /** Nodes the user has manually dragged — preserved across layout switches */
    private manualPositions = new Map<string, LayoutPosition3D>()
    private groundPlane?: THREE.Mesh

    private raycaster = new THREE.Raycaster()
    private mouse = new THREE.Vector2()
    private _prevSelectedMesh: THREE.Mesh | null = null

    // Drag state
    private _dragging = false
    private _dragNodeId: string | null = null
    private _dragMesh: THREE.Mesh | null = null
    private _dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    private _dragOffset = new THREE.Vector3()
    private _mouseDownPos = new THREE.Vector2()

    private _linkDragging = false
    private _linkSourceNodeId: string | null = null
    private _linkPreviewLine: THREE.Line | null = null

    // Traffic animation
    private particleGroup = new THREE.Group()
    private particleT: number[] = []

    // Keyboard fly-through state
    private _keysDown = new Set<string>()

    constructor (private cdr: ChangeDetectorRef) {}

    ngAfterViewInit (): void {
        this._initScene()
        this._initControls()
        this._initLights()
        this._initGround()
        this._initResize()
        this._buildTopology()
        this._detectVR()
        this._animate()
    }

    ngOnChanges (changes: SimpleChanges): void {
        if (!this.scene) { return }
        if (changes['topology']) {
            // Detect full topology replacement (new object identity or new name) vs incremental update
            const prev = changes['topology'].previousValue as Topology | undefined
            const curr = changes['topology'].currentValue as Topology | undefined
            const isFullReplacement = !prev
                || (curr && prev && (curr.name !== prev.name || curr.createdAt !== prev.createdAt))
            if (isFullReplacement) {
                this.manualPositions.clear()  // Drop stale manual drags on fresh topology
            }
            this._buildTopology()
        }
        if (changes['selectedNodeId']) {
            this._updateSelection()
        }
        if (changes['liveData']) {
            this._updateLiveOverlays()
        }
    }

    ngOnDestroy (): void {
        // Cancel animation loop (both RAF and XR)
        cancelAnimationFrame(this.rafId)
        if (this.renderer?.xr?.isPresenting) {
            const session = (this.renderer.xr as any).getSession?.()
            if (session) { session.end().catch(() => { /* noop */ }) }
        }
        this.renderer?.setAnimationLoop(null)
        this.resizeObserver?.disconnect()
        this.controls?.dispose()
        this.nodeMeshes.forEach(m => { m.geometry.dispose(); (m.material as THREE.Material).dispose() })
        this.nodeLabels.forEach(s => { (s.material as THREE.SpriteMaterial).map?.dispose(); (s.material as THREE.Material).dispose() })
        this.nodeStatus.forEach(m => { m.geometry.dispose(); (m.material as THREE.Material).dispose() })
        this.nodeAlarmRings.forEach(m => { m.geometry.dispose(); (m.material as THREE.Material).dispose() })
        this.nodeDriftBadges.forEach(s => { (s.material as THREE.SpriteMaterial).map?.dispose(); (s.material as THREE.Material).dispose() })
        this.nodeCpuBars.forEach(g => g.children.forEach(c => {
            if ((c as any).geometry) { (c as any).geometry.dispose() }
            if ((c as any).material) { ((c as any).material as THREE.Material).dispose() }
        }))
        this.linkLines.forEach(l => { l.geometry.dispose(); (l.material as THREE.Material).dispose() })
        this.particleGroup.children.forEach(c => {
            if (c instanceof THREE.Points) { c.geometry.dispose(); (c.material as THREE.Material).dispose() }
        })
        // Dispose ground plane
        if (this.groundPlane) {
            this.scene?.remove(this.groundPlane)
            this.groundPlane.geometry.dispose()
            ;(this.groundPlane.material as THREE.Material).dispose()
        }
        // Dispose link preview line if mid-drag
        if (this._linkPreviewLine) {
            this.scene?.remove(this._linkPreviewLine)
            this._linkPreviewLine.geometry.dispose()
            ;(this._linkPreviewLine.material as THREE.Material).dispose()
            this._linkPreviewLine = null
        }
        this.renderer?.dispose()
    }

    // ── Layout switcher (Phase 2) ──────────────────────────────────────────

    setLayout (mode: Layout3DMode): void {
        this.layoutMode = mode
        this._buildTopology()
        this.cdr.markForCheck()
    }

    /** Clear manually-dragged positions so the next layout runs freshly */
    resetManualPositions (): void {
        this.manualPositions.clear()
        this._buildTopology()
        this.cdr.markForCheck()
    }

    /** How many nodes the user has manually repositioned (shown in toolbar) */
    get manualPositionsCount (): number { return this.manualPositions.size }

    // ── Preset views (Phase 4) ─────────────────────────────────────────────

    setPresetView (preset: 'top' | 'front' | 'side' | 'iso' | 'reset'): void {
        if (!this.controls || !this.positions.size) { return }
        let cx = 0, cy = 0, cz = 0
        for (const p of this.positions.values()) { cx += p.x; cy += p.z; cz += p.y }
        const n = this.positions.size
        cx /= n; cy /= n; cz /= n
        const dist = 300
        switch (preset) {
            case 'top':   this.camera.position.set(cx, cy + dist, cz); break
            case 'front': this.camera.position.set(cx, cy + 50, cz + dist); break
            case 'side':  this.camera.position.set(cx + dist, cy + 50, cz); break
            case 'iso':   this.camera.position.set(cx + dist * 0.7, cy + dist * 0.6, cz + dist * 0.7); break
            case 'reset': this.camera.position.set(cx, cy + 150, cz + 300); break
        }
        this.controls.target.set(cx, cy, cz)
        this.controls.update()
    }

    // ── Screenshot (Phase 6) ────────────────────────────────────────────────

    captureScreenshot (): void {
        if (!this.renderer) { return }
        this.renderer.render(this.scene, this.camera)  // ensure fresh frame
        const dataUrl = this.renderer.domElement.toDataURL('image/png')
        const a = document.createElement('a')
        a.href = dataUrl
        a.download = `netops-3d-${Date.now()}.png`
        a.click()
    }

    // ── VR support (Phase 6) ────────────────────────────────────────────────

    private _detectVR (): void {
        const xr = (navigator as any).xr
        if (xr && typeof xr.isSessionSupported === 'function') {
            xr.isSessionSupported('immersive-vr').then((supported: boolean) => {
                this.vrSupported = supported
                this.cdr.markForCheck()
            }).catch(() => { this.vrSupported = false })
        }
    }

    async toggleVR (): Promise<void> {
        if (!this.vrSupported || !this.renderer) { return }
        const xr = (navigator as any).xr
        if (this.vrActive) {
            const session = (this.renderer.xr as any).getSession?.()
            if (session) { await session.end() }
            this.vrActive = false
        } else {
            try {
                this.renderer.xr.enabled = true
                const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] })
                await (this.renderer.xr as any).setSession(session)
                this.vrActive = true
                session.addEventListener('end', () => {
                    this.vrActive = false
                    this.cdr.markForCheck()
                })
            } catch (err) {
                // VR session failed
            }
        }
        this.cdr.markForCheck()
    }

    // ── Path highlighting (Phase 6) ─────────────────────────────────────────

    highlightPath (nodeIds: string[], linkIds: string[]): void {
        this.pathHighlightNodeIds = new Set(nodeIds)
        this.pathHighlightLinkIds = new Set(linkIds)
        this._updateHighlight()
    }

    clearPathHighlight (): void {
        this.pathHighlightNodeIds.clear()
        this.pathHighlightLinkIds.clear()
        this._updateHighlight()
    }

    private _updateHighlight (): void {
        // Dim non-highlighted nodes when path is active
        const hasPath = this.pathHighlightNodeIds.size > 0
        for (const [id, mesh] of this.nodeMeshes) {
            const mat = mesh.material as THREE.MeshStandardMaterial
            const isSelected = id === this.selectedNodeId
            if (!hasPath) {
                // Restore defaults
                mat.opacity = 1
                mat.transparent = false
                mat.emissiveIntensity = isSelected ? 0.7 : 0.15
            } else {
                const inPath = this.pathHighlightNodeIds.has(id)
                mat.transparent = true
                mat.opacity = inPath ? 1 : 0.2
                mat.emissiveIntensity = inPath ? 0.8 : (isSelected ? 0.5 : 0.1)
            }
        }
        for (const [id, line] of this.linkLines) {
            const mat = line.material as THREE.MeshStandardMaterial
            if (!hasPath) {
                // Restore defaults — BGP colors will be reapplied on next _updateLiveOverlays
                mat.opacity = 0.7
                mat.emissiveIntensity = 0.1
            } else {
                const inPath = this.pathHighlightLinkIds.has(id)
                mat.opacity = inPath ? 1 : 0.1
                mat.color.setHex(inPath ? 0xffeb3b : 0x4488cc)
                mat.emissiveIntensity = inPath ? 0.6 : 0
            }
        }
        // When clearing, reapply live data colors
        if (!hasPath) { this._updateLinkBgpColors() }
    }

    // ── Keyboard controls (Phase 4) ─────────────────────────────────────────

    @HostListener('window:keydown', ['$event'])
    onKeyDown (ev: KeyboardEvent): void {
        // Ignore when typing
        const target = ev.target as HTMLElement
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) { return }
        // Preset view keys
        if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey) {
            if (ev.key === '1') { this.setPresetView('top'); return }
            if (ev.key === '2') { this.setPresetView('front'); return }
            if (ev.key === '3') { this.setPresetView('side'); return }
            if (ev.key === '4') { this.setPresetView('iso'); return }
            if (ev.key === '0') { this.setPresetView('reset'); return }
        }
        // WASD + QE for fly-through
        const k = ev.key.toLowerCase()
        if (['w', 'a', 's', 'd', 'q', 'e'].includes(k)) {
            this._keysDown.add(k)
        }
    }

    @HostListener('window:keyup', ['$event'])
    onKeyUp (ev: KeyboardEvent): void {
        this._keysDown.delete(ev.key.toLowerCase())
    }

    private _applyKeyboardMovement (dt: number): void {
        if (!this._keysDown.size || !this.controls) { return }
        const speed = 150 * dt
        const forward = new THREE.Vector3()
        this.camera.getWorldDirection(forward)
        forward.y = 0
        forward.normalize()
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize()
        const move = new THREE.Vector3()
        if (this._keysDown.has('w')) { move.add(forward) }
        if (this._keysDown.has('s')) { move.sub(forward) }
        if (this._keysDown.has('d')) { move.add(right) }
        if (this._keysDown.has('a')) { move.sub(right) }
        if (this._keysDown.has('e')) { move.y += 1 }
        if (this._keysDown.has('q')) { move.y -= 1 }
        if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(speed)
            this.camera.position.add(move)
            this.controls.target.add(move)
        }
    }

    // ── Mouse handlers (select, drag-move, click, hover, context menu) ─────

    private _updateMouse (event: MouseEvent): void {
        const rect = this.containerRef.nativeElement.getBoundingClientRect()
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    }

    private _intersectNodes (): THREE.Intersection[] {
        this.raycaster.setFromCamera(this.mouse, this.camera)
        return this.raycaster.intersectObjects(Array.from(this.nodeMeshes.values()))
    }

    private _getWorldPoint (event: MouseEvent): THREE.Vector3 | null {
        this._updateMouse(event)
        this.raycaster.setFromCamera(this.mouse, this.camera)
        const target = new THREE.Vector3()
        const hit = this.raycaster.ray.intersectPlane(this._dragPlane, target)
        return hit ? target : null
    }

    onMouseDown (event: MouseEvent): void {
        if (event.button !== 0) { return }
        this._mouseDownPos.set(event.clientX, event.clientY)
        this._updateMouse(event)
        const intersects = this._intersectNodes()

        if (intersects.length > 0) {
            const mesh = intersects[0].object as THREE.Mesh
            const nodeId = (mesh.userData as any)?.nodeId
            if (!nodeId) { return }

            if (event.shiftKey) {
                this._linkDragging = true
                this._linkSourceNodeId = nodeId
                const geometry = new THREE.BufferGeometry().setFromPoints([mesh.position.clone(), mesh.position.clone()])
                const material = new THREE.LineBasicMaterial({ color: 0x00e5ff, linewidth: 1, transparent: true, opacity: 0.8 })
                this._linkPreviewLine = new THREE.Line(geometry, material)
                this.scene.add(this._linkPreviewLine)
                this.controls.enabled = false
            } else {
                this._dragging = true
                this._dragNodeId = nodeId
                this._dragMesh = mesh
                this._dragPlane.set(new THREE.Vector3(0, 1, 0), -mesh.position.y)
                const worldPt = new THREE.Vector3()
                this.raycaster.ray.intersectPlane(this._dragPlane, worldPt)
                this._dragOffset.subVectors(mesh.position, worldPt)
                this.controls.enabled = false
            }
            this.nodeSelected.emit(nodeId)
        }
    }

    onMouseMove (event: MouseEvent): void {
        // Link creation preview
        if (this._linkDragging && this._linkPreviewLine && this._linkSourceNodeId) {
            this._dragPlane.set(new THREE.Vector3(0, 1, 0), 0)
            const worldPt = this._getWorldPoint(event)
            if (worldPt) {
                const srcMesh = this.nodeMeshes.get(this._linkSourceNodeId)
                if (srcMesh) {
                    const points = [srcMesh.position.clone(), worldPt]
                    this._linkPreviewLine.geometry.dispose()
                    this._linkPreviewLine.geometry = new THREE.BufferGeometry().setFromPoints(points)
                }
            }
            return
        }

        if (this._dragging && this._dragMesh && this._dragNodeId) {
            // Hide tooltip during drag
            if (this.hoverNodeId) { this.hoverNodeId = null; this.cdr.markForCheck() }
            const worldPt = this._getWorldPoint(event)
            if (!worldPt) { return }
            const newX = worldPt.x + this._dragOffset.x
            const newZ = worldPt.z + this._dragOffset.z
            this._dragMesh.position.x = newX
            this._dragMesh.position.z = newZ

            const label = this.nodeLabels.get(this._dragNodeId)
            if (label) { label.position.x = newX; label.position.z = newZ }
            const status = this.nodeStatus.get(this._dragNodeId)
            if (status) { status.position.x = newX + 8; status.position.z = newZ }
            const ring = this.nodeAlarmRings.get(this._dragNodeId)
            if (ring) { ring.position.x = newX; ring.position.z = newZ }
            const badge = this.nodeDriftBadges.get(this._dragNodeId)
            if (badge) { badge.position.x = newX - 10; badge.position.z = newZ }
            const bars = this.nodeCpuBars.get(this._dragNodeId)
            if (bars) { bars.position.x = newX + 14; bars.position.z = newZ }

            for (const link of (this.topology?.links ?? [])) {
                if (link.sourceNodeId !== this._dragNodeId && link.targetNodeId !== this._dragNodeId) { continue }
                this._updateLinkGeometry(link.id)
            }
            return
        }

        // Hover detection (when not dragging)
        this._updateMouse(event)
        const intersects = this._intersectNodes()
        const hitId = intersects[0]?.object?.userData?.['nodeId'] ?? null
        if (hitId !== this.hoverNodeId) {
            this.hoverNodeId = hitId
            this.cdr.markForCheck()
        }
        if (hitId) {
            const rect = this.containerRef.nativeElement.getBoundingClientRect()
            const TOOLTIP_W = 300
            const TOOLTIP_H = 220
            const PAD = 16
            let tx = event.clientX - rect.left + PAD
            let ty = event.clientY - rect.top + PAD
            // Flip to the left if we'd overflow right edge
            if (tx + TOOLTIP_W > rect.width) { tx = event.clientX - rect.left - TOOLTIP_W - PAD }
            // Flip above if we'd overflow bottom edge
            if (ty + TOOLTIP_H > rect.height) { ty = event.clientY - rect.top - TOOLTIP_H - PAD }
            // Clamp to viewport
            tx = Math.max(8, Math.min(rect.width - TOOLTIP_W - 8, tx))
            ty = Math.max(8, Math.min(rect.height - TOOLTIP_H - 8, ty))
            this.hoverTooltipX = tx
            this.hoverTooltipY = ty
        }
    }

    onMouseUp (event: MouseEvent): void {
        if (this._linkDragging && this._linkSourceNodeId) {
            if (this._linkPreviewLine) {
                this.scene.remove(this._linkPreviewLine)
                this._linkPreviewLine.geometry.dispose()
                ;(this._linkPreviewLine.material as THREE.Material).dispose()
                this._linkPreviewLine = null
            }
            this._updateMouse(event)
            const intersects = this._intersectNodes()
            if (intersects.length > 0) {
                const targetNodeId = (intersects[0].object.userData as any)?.nodeId
                if (targetNodeId && targetNodeId !== this._linkSourceNodeId) {
                    this.linkCreated.emit({ sourceNodeId: this._linkSourceNodeId, targetNodeId })
                }
            }
            this._linkDragging = false
            this._linkSourceNodeId = null
            this.controls.enabled = true
            return
        }

        if (this._dragging && this._dragNodeId && this._dragMesh) {
            const SCALE = 0.5
            const newX = this._dragMesh.position.x / SCALE
            const newY = -this._dragMesh.position.z / SCALE
            // Record the manual position so it survives layout switches
            this.manualPositions.set(this._dragNodeId, {
                id: this._dragNodeId,
                x: this._dragMesh.position.x,
                y: this._dragMesh.position.z,
                z: this._dragMesh.position.y,
            })
            this.nodeMoved.emit({ nodeId: this._dragNodeId, x: newX, y: newY })
            // Trigger change detection so the "Reset" toolbar button appears
            this.cdr.markForCheck()
        }

        if (!this._dragging && !this._linkDragging) {
            const dx = event.clientX - this._mouseDownPos.x
            const dy = event.clientY - this._mouseDownPos.y
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
                this._updateMouse(event)
                const intersects = this._intersectNodes()
                if (intersects.length > 0) {
                    const nodeId = (intersects[0].object.userData as any)?.nodeId
                    if (nodeId) { this.nodeSelected.emit(nodeId) }
                } else {
                    this.nodeSelected.emit(null)
                }
            }
        }

        this._dragging = false
        this._dragNodeId = null
        this._dragMesh = null
        this.controls.enabled = true
    }

    onDblClick (event: MouseEvent): void {
        this._updateMouse(event)
        const intersects = this._intersectNodes()
        if (intersects.length > 0) {
            const nodeId = (intersects[0].object.userData as any)?.nodeId
            if (nodeId) { this.nodeDoubleClicked.emit(nodeId) }
        }
    }

    onContextMenu (event: MouseEvent): void {
        event.preventDefault()
        this._updateMouse(event)
        const intersects = this._intersectNodes()
        if (intersects.length > 0) {
            const nodeId = (intersects[0].object.userData as any)?.nodeId
            if (nodeId) {
                this.nodeContextMenu.emit({ nodeId, x: event.clientX, y: event.clientY })
            }
        }
    }

    onMouseLeave (): void {
        if (this.hoverNodeId) {
            this.hoverNodeId = null
            this.cdr.markForCheck()
        }
    }

    // ── Drag-and-drop from palette ─────────────────────────────────────────

    onDragOver (event: DragEvent): void {
        event.preventDefault()
        if (event.dataTransfer) { event.dataTransfer.dropEffect = 'copy' }
    }

    onDrop (event: DragEvent): void {
        event.preventDefault()
        const type = event.dataTransfer?.getData('nodeType')
        if (!type) { return }
        this._dragPlane.set(new THREE.Vector3(0, 1, 0), 0)
        const worldPt = this._getWorldPoint(event as any)
        if (!worldPt) { return }
        const SCALE = 0.5
        const x = worldPt.x / SCALE
        const y = -worldPt.z / SCALE
        this.nodeAdded.emit({ type, x, y })
    }

    // ── Hover tooltip data (Phase 4) ───────────────────────────────────────

    get hoverNode (): TopologyNode | undefined {
        if (!this.hoverNodeId) { return undefined }
        return this.topology?.nodes?.find(n => n.id === this.hoverNodeId)
    }

    hoverCpu (): number | null {
        if (!this.hoverNodeId || !this.liveData) { return null }
        return this.liveData.cpuByNode.get(this.hoverNodeId) ?? null
    }
    hoverMem (): number | null {
        if (!this.hoverNodeId || !this.liveData) { return null }
        return this.liveData.memByNode.get(this.hoverNodeId) ?? null
    }
    hoverBgp (): string {
        if (!this.hoverNodeId || !this.liveData) { return '—' }
        const b = this.liveData.bgpUpByNode.get(this.hoverNodeId)
        return b ? `${b.up}/${b.total}` : '—'
    }

    // ── Scene initialization ───────────────────────────────────────────────

    private _initScene (): void {
        const container = this.containerRef.nativeElement
        const w = container.clientWidth || 800
        const h = container.clientHeight || 600

        this.scene = new THREE.Scene()
        this.scene.background = new THREE.Color('#0a0e1a')
        this.scene.fog = new THREE.FogExp2('#0a0e1a', 0.0006)

        this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 5000)
        this.camera.position.set(0, 180, 320)
        this.camera.lookAt(0, 0, 0)

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
        this.renderer.setPixelRatio(window.devicePixelRatio)
        this.renderer.setSize(w, h)
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping
        this.renderer.toneMappingExposure = 1.2
        // Phase 5: Enable shadows
        this.renderer.shadowMap.enabled = true
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
        container.appendChild(this.renderer.domElement)

        this.scene.add(this.particleGroup)
    }

    private _initControls (): void {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement)
        this.controls.enableDamping = true
        this.controls.dampingFactor = 0.08
        this.controls.minDistance = 50
        this.controls.maxDistance = 2000
        this.controls.maxPolarAngle = Math.PI * 0.85
    }

    private _initLights (): void {
        const ambient = new THREE.AmbientLight(0xffffff, 0.6)
        this.scene.add(ambient)

        const directional = new THREE.DirectionalLight(0xffffff, 1.0)
        directional.position.set(150, 300, 150)
        // Phase 5: Enable shadow casting
        directional.castShadow = true
        directional.shadow.mapSize.width = 2048
        directional.shadow.mapSize.height = 2048
        directional.shadow.camera.left = -400
        directional.shadow.camera.right = 400
        directional.shadow.camera.top = 400
        directional.shadow.camera.bottom = -400
        directional.shadow.camera.near = 50
        directional.shadow.camera.far = 800
        this.scene.add(directional)

        const fill = new THREE.DirectionalLight(0x6688ff, 0.5)
        fill.position.set(-150, 100, -150)
        this.scene.add(fill)

        const rim = new THREE.DirectionalLight(0xff8844, 0.2)
        rim.position.set(0, -50, 200)
        this.scene.add(rim)

        // Subtle grid
        const grid = new THREE.GridHelper(800, 40, 0x1a2040, 0x0f1525)
        grid.position.y = -60
        this.scene.add(grid)
    }

    // Phase 5: Ground plane for shadows + visual grounding
    private _initGround (): void {
        const geometry = new THREE.PlaneGeometry(2000, 2000)
        const material = new THREE.MeshStandardMaterial({
            color: 0x0f1525, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.6,
        })
        const plane = new THREE.Mesh(geometry, material)
        plane.rotation.x = -Math.PI / 2
        plane.position.y = -60.1
        plane.receiveShadow = true
        this.scene.add(plane)
        this.groundPlane = plane
    }

    private _initResize (): void {
        this.resizeObserver = new ResizeObserver(() => {
            const container = this.containerRef.nativeElement
            const w = container.clientWidth
            const h = container.clientHeight
            if (w && h) {
                this.camera.aspect = w / h
                this.camera.updateProjectionMatrix()
                this.renderer.setSize(w, h)
            }
        })
        this.resizeObserver.observe(this.containerRef.nativeElement)
    }

    // ── Build topology (with layout mode selection) ─────────────────────────

    private _buildTopology (): void {
        if (!this.topology?.nodes) { return }

        // Compute positions based on selected layout mode
        let pos3d: LayoutPosition3D[]
        switch (this.layoutMode) {
            case 'hierarchical':
                pos3d = hierarchical3D(this.topology.nodes)
                break
            case 'force-directed':
                pos3d = forceDirected3D(this.topology.nodes, this.topology.links)
                break
            case 'circular':
                pos3d = circular3D(this.topology.nodes)
                break
            case 'sphere':
                pos3d = sphere3D(this.topology.nodes)
                break
            case 'from-2d':
            default:
                pos3d = from2DLayout(this.topology.nodes)
                break
        }
        this.positions.clear()
        for (const p of pos3d) {
            // Prefer manually-dragged position if the user has moved this node
            const manual = this.manualPositions.get(p.id)
            this.positions.set(p.id, manual ?? p)
        }
        // Drop manual positions for nodes that no longer exist
        const currentIds = new Set(this.topology.nodes.map(n => n.id))
        for (const id of this.manualPositions.keys()) {
            if (!currentIds.has(id)) { this.manualPositions.delete(id) }
        }

        // Reconcile nodes
        const currentNodeIds = new Set(this.topology.nodes.map(n => n.id))
        for (const [id, mesh] of this.nodeMeshes) {
            if (!currentNodeIds.has(id)) { this._disposeNode(id, mesh) }
        }

        for (const node of this.topology.nodes) {
            const pos = this.positions.get(node.id)
            if (!pos) { continue }
            this._ensureNodeMeshes(node)
            this._positionNode(node.id, pos)
        }

        // Reconcile links
        const currentLinkIds = new Set(this.topology.links.map(l => l.id))
        for (const [id, line] of this.linkLines) {
            if (!currentLinkIds.has(id)) {
                this.scene.remove(line)
                line.geometry.dispose()
                ;(line.material as THREE.Material).dispose()
                this.linkLines.delete(id)
            }
        }
        for (const link of this.topology.links) {
            this._ensureLink(link.id, link.sourceNodeId, link.targetNodeId, link.linkColor)
            this._updateLinkGeometry(link.id)
        }

        this._buildParticles()
        this._updateSelection()
        this._updateLiveOverlays()
        this._autoCenterCamera()
    }

    private _disposeNode (id: string, mesh: THREE.Mesh): void {
        this.scene.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose()
        this.nodeMeshes.delete(id)
        const cleanupMap = <T extends THREE.Object3D>(map: Map<string, T>, dispose?: (o: T) => void) => {
            const obj = map.get(id)
            if (obj) { this.scene.remove(obj); if (dispose) dispose(obj); map.delete(id) }
        }
        cleanupMap(this.nodeLabels, s => { const m = s.material as THREE.SpriteMaterial; m.map?.dispose(); m.dispose() })
        cleanupMap(this.nodeStatus, m => { m.geometry.dispose(); (m.material as THREE.Material).dispose() })
        cleanupMap(this.nodeAlarmRings, m => { m.geometry.dispose(); (m.material as THREE.Material).dispose() })
        cleanupMap(this.nodeDriftBadges, s => { const m = s.material as THREE.SpriteMaterial; m.map?.dispose(); m.dispose() })
        const bars = this.nodeCpuBars.get(id)
        if (bars) {
            this.scene.remove(bars)
            bars.children.forEach(c => {
                if ((c as any).geometry) { (c as any).geometry.dispose() }
                if ((c as any).material) { ((c as any).material as THREE.Material).dispose() }
            })
            this.nodeCpuBars.delete(id)
        }
    }

    private _ensureNodeMeshes (node: TopologyNode): void {
        if (!this.nodeMeshes.has(node.id)) {
            const mesh = this._createNodeMesh(node)
            mesh.userData = { nodeId: node.id }
            mesh.castShadow = true  // Phase 5: shadow casting
            mesh.receiveShadow = true
            this.scene.add(mesh)
            this.nodeMeshes.set(node.id, mesh)
        }
        if (!this.nodeLabels.has(node.id)) {
            const label = this._createLabel(node.label)
            this.scene.add(label)
            this.nodeLabels.set(node.id, label)
        }
        if (!this.nodeStatus.has(node.id)) {
            const statusMesh = this._createStatusMesh(node.status)
            this.scene.add(statusMesh)
            this.nodeStatus.set(node.id, statusMesh)
        }
    }

    private _positionNode (id: string, pos: LayoutPosition3D): void {
        const mesh = this.nodeMeshes.get(id)
        if (!mesh) { return }
        mesh.position.set(pos.x, pos.z, pos.y)
        const label = this.nodeLabels.get(id)
        if (label) { label.position.set(pos.x, pos.z + 18, pos.y) }
        const status = this.nodeStatus.get(id)
        if (status) {
            status.position.set(pos.x + 10, pos.z + 10, pos.y)
            const node = this.topology.nodes.find(n => n.id === id)
            if (node) {
                const color = node.status === 'running' ? 0x22c55e : node.status === 'suspended' ? 0xf59e0b : 0xef4444
                ;(status.material as THREE.MeshStandardMaterial).color.setHex(color)
                ;(status.material as THREE.MeshStandardMaterial).emissive.setHex(color)
            }
        }
        const ring = this.nodeAlarmRings.get(id)
        if (ring) { ring.position.set(pos.x, pos.z, pos.y) }
        const badge = this.nodeDriftBadges.get(id)
        if (badge) { badge.position.set(pos.x - 10, pos.z + 12, pos.y) }
        const bars = this.nodeCpuBars.get(id)
        if (bars) { bars.position.set(pos.x + 14, pos.z, pos.y) }
    }

    // ── Links (Phase 5: Tube geometry for visible thickness) ────────────────

    private _ensureLink (id: string, _sourceId: string, _targetId: string, color?: string): void {
        if (this.linkLines.has(id)) { return }
        // Placeholder geometry — actual geometry set in _updateLinkGeometry
        const geometry = new THREE.BufferGeometry()
        const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color || '#4488cc'),
            transparent: true,
            opacity: 0.7,
            emissive: new THREE.Color(color || '#4488cc'),
            emissiveIntensity: 0.1,
        })
        const mesh = new THREE.Mesh(geometry, material)
        mesh.userData = { linkId: id }
        this.scene.add(mesh)
        this.linkLines.set(id, mesh)
    }

    private _updateLinkGeometry (linkId: string): void {
        const link = this.topology.links.find(l => l.id === linkId)
        if (!link) { return }
        const srcMesh = this.nodeMeshes.get(link.sourceNodeId)
        const tgtMesh = this.nodeMeshes.get(link.targetNodeId)
        const lineMesh = this.linkLines.get(linkId)
        if (!srcMesh || !tgtMesh || !lineMesh) { return }

        const src = srcMesh.position
        const tgt = tgtMesh.position
        const path = new THREE.LineCurve3(src.clone(), tgt.clone())

        // Phase 5: Thicker tubes based on link role (fabric links thicker)
        const srcNode = this.topology.nodes.find(n => n.id === link.sourceNodeId)
        const tgtNode = this.topology.nodes.find(n => n.id === link.targetNodeId)
        const isFabric = (
            (srcNode?.role === 'spine' || srcNode?.role === 'super-spine') ||
            (tgtNode?.role === 'spine' || tgtNode?.role === 'super-spine')
        )
        const thickness = isFabric ? 1.2 : 0.6

        const tubeGeom = new THREE.TubeGeometry(path, 2, thickness, 6, false)
        lineMesh.geometry.dispose()
        lineMesh.geometry = tubeGeom
    }

    // ── Node factories ──────────────────────────────────────────────────────

    private _createNodeMesh (node: TopologyNode): THREE.Mesh {
        const meta = NODE_TYPE_META[node.type] ?? NODE_TYPE_META['router']
        const color = new THREE.Color(meta.borderColor)

        let geometry: THREE.BufferGeometry
        switch (node.type) {
            case 'router': geometry = new THREE.SphereGeometry(10, 24, 24); break
            case 'switch': geometry = new THREE.BoxGeometry(18, 7, 18); break
            case 'firewall': geometry = new THREE.OctahedronGeometry(12); break
            case 'server': geometry = new THREE.BoxGeometry(10, 18, 10); break
            case 'pc': geometry = new THREE.ConeGeometry(8, 14, 4); break
            case 'cloud': geometry = new THREE.IcosahedronGeometry(10); break
            default: geometry = new THREE.SphereGeometry(8, 16, 16)
        }

        const material = new THREE.MeshStandardMaterial({
            color, metalness: 0.3, roughness: 0.4,
            emissive: color, emissiveIntensity: 0.15,
        })
        return new THREE.Mesh(geometry, material)
    }

    private _createLabel (text: string): THREE.Sprite {
        const canvas = document.createElement('canvas')
        canvas.width = 512; canvas.height = 128
        const ctx = canvas.getContext('2d')!
        const displayText = text.length > 16 ? text.slice(0, 15) + '…' : text
        ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, sans-serif'
        const metrics = ctx.measureText(displayText)
        const textW = metrics.width + 32
        const pillX = (512 - textW) / 2
        ctx.fillStyle = 'rgba(10, 14, 26, 0.85)'
        ctx.beginPath(); ctx.roundRect(pillX, 20, textW, 56, 14); ctx.fill()
        ctx.strokeStyle = 'rgba(100, 140, 200, 0.4)'
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.roundRect(pillX, 20, textW, 56, 14); ctx.stroke()
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillStyle = '#ffffff'
        ctx.fillText(displayText, 256, 48)

        const texture = new THREE.CanvasTexture(canvas)
        texture.needsUpdate = true
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
        const sprite = new THREE.Sprite(material)
        sprite.scale.set(32, 8, 1)
        return sprite
    }

    private _createStatusMesh (status: string): THREE.Mesh {
        const geometry = new THREE.SphereGeometry(1.5, 8, 8)
        const color = status === 'running' ? 0x22c55e : status === 'suspended' ? 0xf59e0b : 0x666666
        const material = new THREE.MeshStandardMaterial({
            color, emissive: color, emissiveIntensity: status === 'running' ? 1.0 : 0.3,
        })
        return new THREE.Mesh(geometry, material)
    }

    // ── Live data overlays (Phase 1) ───────────────────────────────────────

    private _updateLiveOverlays (): void {
        if (!this.topology?.nodes) { return }
        for (const node of this.topology.nodes) {
            this._updateAlarmRing(node)
            this._updateDriftBadge(node)
            this._updateCpuMemBars(node)
        }
        this._updateLinkBgpColors()
    }

    private _updateAlarmRing (node: TopologyNode): void {
        const alarmCount = this.liveData?.alarmsByNode.get(node.id) ?? 0
        const existing = this.nodeAlarmRings.get(node.id)
        const pos = this.positions.get(node.id)
        if (!pos) { return }

        if (alarmCount > 0) {
            if (!existing) {
                // Torus ring around the node — pulses in animate loop (per-node phase offset)
                const geometry = new THREE.TorusGeometry(16, 0.8, 8, 32)
                const material = new THREE.MeshStandardMaterial({
                    color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 1.0,
                    transparent: true, opacity: 0.8,
                })
                const ring = new THREE.Mesh(geometry, material)
                ring.rotation.x = Math.PI / 2  // horizontal ring
                ring.position.set(pos.x, pos.z, pos.y)
                // Random phase per-node so rings don't pulse in unison
                ring.userData = { pulse: true, phase: Math.random() * Math.PI * 2 }
                this.scene.add(ring)
                this.nodeAlarmRings.set(node.id, ring)
            }
        } else if (existing) {
            this.scene.remove(existing)
            existing.geometry.dispose()
            ;(existing.material as THREE.Material).dispose()
            this.nodeAlarmRings.delete(node.id)
        }
    }

    private _updateDriftBadge (node: TopologyNode): void {
        const hasDrift = this.liveData?.driftByNode.has(node.id) ?? false
        const existing = this.nodeDriftBadges.get(node.id)
        const pos = this.positions.get(node.id)
        if (!pos) { return }

        if (hasDrift) {
            if (!existing) {
                const canvas = document.createElement('canvas')
                canvas.width = 128; canvas.height = 64
                const ctx = canvas.getContext('2d')!
                ctx.fillStyle = 'rgba(245, 158, 11, 0.9)'
                ctx.beginPath(); ctx.roundRect(0, 0, 128, 64, 10); ctx.fill()
                ctx.font = 'bold 28px sans-serif'
                ctx.fillStyle = '#fff'
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
                ctx.fillText('⚠ DRIFT', 64, 32)
                const texture = new THREE.CanvasTexture(canvas)
                const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
                const sprite = new THREE.Sprite(material)
                sprite.scale.set(10, 5, 1)
                sprite.position.set(pos.x - 10, pos.z + 12, pos.y)
                this.scene.add(sprite)
                this.nodeDriftBadges.set(node.id, sprite)
            }
        } else if (existing) {
            this.scene.remove(existing)
            ;(existing.material as THREE.SpriteMaterial).map?.dispose()
            ;(existing.material as THREE.Material).dispose()
            this.nodeDriftBadges.delete(node.id)
        }
    }

    private _updateCpuMemBars (node: TopologyNode): void {
        const cpu = this.liveData?.cpuByNode.get(node.id)
        const mem = this.liveData?.memByNode.get(node.id)
        const pos = this.positions.get(node.id)
        if (!pos) { return }

        let group = this.nodeCpuBars.get(node.id)
        if (cpu == null && mem == null) {
            if (group) {
                this.scene.remove(group)
                group.children.forEach(c => {
                    if ((c as any).geometry) { (c as any).geometry.dispose() }
                    if ((c as any).material) { ((c as any).material as THREE.Material).dispose() }
                })
                this.nodeCpuBars.delete(node.id)
            }
            return
        }

        if (!group) {
            group = new THREE.Group()
            group.position.set(pos.x + 14, pos.z, pos.y)
            this.scene.add(group)
            this.nodeCpuBars.set(node.id, group)
        }

        // Rebuild bars
        group.children.forEach(c => {
            if ((c as any).geometry) { (c as any).geometry.dispose() }
            if ((c as any).material) { ((c as any).material as THREE.Material).dispose() }
        })
        group.clear()

        const mkBar = (value: number, offsetX: number, color: number): void => {
            const height = Math.max(0.5, (value / 100) * 12)
            const geom = new THREE.BoxGeometry(1.2, height, 1.2)
            const mat = new THREE.MeshStandardMaterial({
                color, emissive: color, emissiveIntensity: 0.6, transparent: true, opacity: 0.9,
            })
            const bar = new THREE.Mesh(geom, mat)
            bar.position.set(offsetX, height / 2 - 6, 0)
            group!.add(bar)
        }

        if (cpu != null) {
            const c = cpu > 80 ? 0xef4444 : cpu > 50 ? 0xf59e0b : 0x22c55e
            mkBar(cpu, 0, c)
        }
        if (mem != null) {
            const c = mem > 80 ? 0xef4444 : mem > 50 ? 0xf59e0b : 0x00d2ff
            mkBar(mem, 2, c)
        }
    }

    private _updateLinkBgpColors (): void {
        if (!this.liveData) { return }
        for (const link of this.topology.links) {
            const mesh = this.linkLines.get(link.id)
            if (!mesh) { continue }
            const mat = mesh.material as THREE.MeshStandardMaterial
            // Color based on source + target BGP state
            const sBgp = this.liveData.bgpUpByNode.get(link.sourceNodeId)
            const tBgp = this.liveData.bgpUpByNode.get(link.targetNodeId)
            if (sBgp && tBgp) {
                const allUp = sBgp.up === sBgp.total && tBgp.up === tBgp.total
                const anyUp = sBgp.up > 0 || tBgp.up > 0
                if (allUp) {
                    mat.color.setHex(0x22c55e)     // all established = green
                    mat.emissive.setHex(0x22c55e)
                    mat.emissiveIntensity = 0.2
                } else if (anyUp) {
                    mat.color.setHex(0xf59e0b)     // partial = amber
                    mat.emissive.setHex(0xf59e0b)
                    mat.emissiveIntensity = 0.2
                } else {
                    mat.color.setHex(0xef4444)     // down = red
                    mat.emissive.setHex(0xef4444)
                    mat.emissiveIntensity = 0.15
                }
            }
        }
    }

    // ── Selection highlight ────────────────────────────────────────────────

    private _updateSelection (): void {
        if (this._prevSelectedMesh) {
            const mat = this._prevSelectedMesh.material as THREE.MeshStandardMaterial
            mat.emissiveIntensity = 0.15
            this._prevSelectedMesh = null
        }
        if (this.selectedNodeId) {
            const mesh = this.nodeMeshes.get(this.selectedNodeId)
            if (mesh) {
                const mat = mesh.material as THREE.MeshStandardMaterial
                mat.emissiveIntensity = 0.7
                this._prevSelectedMesh = mesh
            }
        }
    }

    // ── Traffic particles ───────────────────────────────────────────────────

    private _buildParticles (): void {
        while (this.particleGroup.children.length) {
            const c = this.particleGroup.children[0]
            if (c instanceof THREE.Points) { c.geometry.dispose(); (c.material as THREE.Material).dispose() }
            this.particleGroup.remove(c)
        }
        this.particleT = []
        for (const link of (this.topology?.links ?? [])) {
            const srcPos = this.positions.get(link.sourceNodeId)
            const tgtPos = this.positions.get(link.targetNodeId)
            if (!srcPos || !tgtPos) { continue }

            const count = 3
            const positions = new Float32Array(count * 3)
            const geometry = new THREE.BufferGeometry()
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
            const material = new THREE.PointsMaterial({
                color: 0x00e5ff, size: 3, transparent: true, opacity: 0.9, sizeAttenuation: true,
            })
            const points = new THREE.Points(geometry, material)
            points.userData = {
                src: new THREE.Vector3(srcPos.x, srcPos.z, srcPos.y),
                tgt: new THREE.Vector3(tgtPos.x, tgtPos.z, tgtPos.y),
                linkId: link.id,
            }
            this.particleGroup.add(points)
            for (let i = 0; i < count; i++) { this.particleT.push(i / count) }
        }
    }

    private _animateParticles (dt: number): void {
        let tIdx = 0
        for (const child of this.particleGroup.children) {
            if (!(child instanceof THREE.Points)) { continue }
            const { src, tgt } = child.userData as { src: THREE.Vector3; tgt: THREE.Vector3 }
            const posAttr = child.geometry.getAttribute('position') as THREE.BufferAttribute
            const count = posAttr.count
            const speed = 0.5 * dt  // ~0.008 per frame at 60fps
            for (let i = 0; i < count; i++) {
                this.particleT[tIdx] = (this.particleT[tIdx] + speed) % 1
                const t = this.particleT[tIdx]
                posAttr.setXYZ(i,
                    src.x + (tgt.x - src.x) * t,
                    src.y + (tgt.y - src.y) * t,
                    src.z + (tgt.z - src.z) * t,
                )
                tIdx++
            }
            posAttr.needsUpdate = true
        }
    }

    // ── Auto-center camera ────────────────────────────────────────────────

    private _autoCenterCamera (): void {
        if (!this.positions.size) { return }
        let cx = 0, cy = 0, cz = 0
        for (const p of this.positions.values()) { cx += p.x; cy += p.z; cz += p.y }
        const n = this.positions.size
        cx /= n; cy /= n; cz /= n
        this.controls.target.set(cx, cy, cz)
        this.camera.position.set(cx, cy + 150, cz + 300)
        this.controls.update()
    }

    // ── Animation loop ─────────────────────────────────────────────────────

    private _animate = (): void => {
        if (this.renderer.xr.isPresenting) {
            this.renderer.setAnimationLoop(this._animateFrame)
        } else {
            this.rafId = requestAnimationFrame(this._animate)
            this._animateFrame()
        }
    }

    private _animateFrame = (): void => {
        const dt = Math.min(0.1, this.clock.getDelta())
        this.controls.update()
        this._animateParticles(dt)
        this._applyKeyboardMovement(dt)

        // LOD — hide labels when camera is far away (Phase 3)
        const camDist = this.camera.position.distanceTo(this.controls.target)
        const labelVisible = camDist < 600
        const labelScale = Math.max(0.5, Math.min(2.0, camDist / 200))
        for (const sprite of this.nodeLabels.values()) {
            sprite.visible = labelVisible
            if (labelVisible) { sprite.scale.set(32 * labelScale, 8 * labelScale, 1) }
        }

        // Hide CPU/mem bars when far (Phase 3 LOD)
        const barsVisible = camDist < 400
        for (const bars of this.nodeCpuBars.values()) {
            bars.visible = barsVisible
        }

        // Pulse alarm rings with per-node phase offset (Phase 1)
        const t = this.clock.elapsedTime * 3
        for (const ring of this.nodeAlarmRings.values()) {
            const phase = (ring.userData as any)?.phase ?? 0
            const s = 1 + 0.15 * Math.sin(t + phase)
            ring.scale.set(s, s, 1)
            const mat = ring.material as THREE.MeshStandardMaterial
            mat.opacity = 0.5 + 0.3 * Math.sin(t + phase)
        }

        this.renderer.render(this.scene, this.camera)
    }
}
