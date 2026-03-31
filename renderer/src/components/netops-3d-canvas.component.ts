import {
    AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef,
    Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy,
    Output, SimpleChanges, ViewChild,
} from '@angular/core'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Topology, TopologyNode, TopologyLink, NODE_TYPE_META, NodeType } from '../api/interfaces'
import { from2DLayout, LayoutPosition3D } from '../services/layout-helpers-3d'

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

    @Output() nodeSelected = new EventEmitter<string | null>()
    @Output() nodeDoubleClicked = new EventEmitter<string>()
    @Output() nodeAdded = new EventEmitter<{ type: string; x: number; y: number }>()
    @Output() nodeMoved = new EventEmitter<{ nodeId: string; x: number; y: number }>()

    @ViewChild('canvasContainer', { static: true }) containerRef!: ElementRef<HTMLDivElement>

    private scene!: THREE.Scene
    private camera!: THREE.PerspectiveCamera
    private renderer!: THREE.WebGLRenderer
    private controls!: OrbitControls
    private rafId = 0
    private resizeObserver?: ResizeObserver

    private nodeMeshes = new Map<string, THREE.Mesh>()
    private nodeLabels = new Map<string, THREE.Sprite>()
    private nodeStatus = new Map<string, THREE.Mesh>()
    private linkLines = new Map<string, THREE.Line>()
    private positions = new Map<string, LayoutPosition3D>()

    private raycaster = new THREE.Raycaster()
    private mouse = new THREE.Vector2()
    private _prevSelectedMesh: THREE.Mesh | null = null

    // Drag state
    private _dragging = false
    private _dragNodeId: string | null = null
    private _dragMesh: THREE.Mesh | null = null
    private _dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0) // horizontal plane
    private _dragOffset = new THREE.Vector3()
    private _mouseDownPos = new THREE.Vector2()

    // Traffic animation
    private particleGroup = new THREE.Group()
    private particleT: number[] = []

    ngAfterViewInit (): void {
        this._initScene()
        this._initControls()
        this._initLights()
        this._initResize()
        this._buildTopology()
        this._animate()
    }

    ngOnChanges (changes: SimpleChanges): void {
        if (!this.scene) { return }
        if (changes['topology']) {
            this._buildTopology()
        }
        if (changes['selectedNodeId']) {
            this._updateSelection()
        }
        if (changes['currentTheme']) {
            this.scene.background = new THREE.Color('#0a0e1a')
        }
    }

    ngOnDestroy (): void {
        cancelAnimationFrame(this.rafId)
        this.resizeObserver?.disconnect()
        this.controls?.dispose()

        // Dispose all Three.js resources
        this.nodeMeshes.forEach(m => { m.geometry.dispose(); (m.material as THREE.Material).dispose() })
        this.nodeLabels.forEach(s => { (s.material as THREE.SpriteMaterial).map?.dispose(); (s.material as THREE.Material).dispose() })
        this.nodeStatus.forEach(m => { m.geometry.dispose(); (m.material as THREE.Material).dispose() })
        this.linkLines.forEach(l => { l.geometry.dispose(); (l.material as THREE.Material).dispose() })
        this.particleGroup.children.forEach(c => {
            if (c instanceof THREE.Points) { c.geometry.dispose(); (c.material as THREE.Material).dispose() }
        })

        this.renderer?.dispose()
    }

    // ── Mouse handlers (select, drag-move, click) ──────────────────────

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
        if (event.button !== 0) { return } // left click only
        this._mouseDownPos.set(event.clientX, event.clientY)
        this._updateMouse(event)
        const intersects = this._intersectNodes()

        if (intersects.length > 0) {
            const mesh = intersects[0].object as THREE.Mesh
            const nodeId = (mesh.userData as any)?.nodeId
            if (!nodeId) { return }

            // Start drag — disable orbit controls
            this._dragging = true
            this._dragNodeId = nodeId
            this._dragMesh = mesh

            // Set drag plane at the mesh's Y height
            this._dragPlane.set(new THREE.Vector3(0, 1, 0), -mesh.position.y)

            // Compute offset between click point and mesh center
            const worldPt = new THREE.Vector3()
            this.raycaster.ray.intersectPlane(this._dragPlane, worldPt)
            this._dragOffset.subVectors(mesh.position, worldPt)

            this.controls.enabled = false
            this.nodeSelected.emit(nodeId)
        }
    }

    onMouseMove (event: MouseEvent): void {
        if (!this._dragging || !this._dragMesh || !this._dragNodeId) { return }

        const worldPt = this._getWorldPoint(event)
        if (!worldPt) { return }

        // Move mesh + label + status indicator
        const newX = worldPt.x + this._dragOffset.x
        const newZ = worldPt.z + this._dragOffset.z
        this._dragMesh.position.x = newX
        this._dragMesh.position.z = newZ

        const label = this.nodeLabels.get(this._dragNodeId)
        if (label) { label.position.x = newX; label.position.z = newZ }
        const status = this.nodeStatus.get(this._dragNodeId)
        if (status) { status.position.x = newX + 8; status.position.z = newZ }

        // Update links connected to this node
        for (const link of (this.topology?.links ?? [])) {
            if (link.sourceNodeId !== this._dragNodeId && link.targetNodeId !== this._dragNodeId) { continue }
            const line = this.linkLines.get(link.id)
            if (!line) { continue }
            const srcMesh = this.nodeMeshes.get(link.sourceNodeId)
            const tgtMesh = this.nodeMeshes.get(link.targetNodeId)
            if (!srcMesh || !tgtMesh) { continue }
            const points = [srcMesh.position.clone(), tgtMesh.position.clone()]
            line.geometry.dispose()
            line.geometry = new THREE.BufferGeometry().setFromPoints(points)
        }
    }

    onMouseUp (event: MouseEvent): void {
        if (this._dragging && this._dragNodeId && this._dragMesh) {
            // Emit move event — convert 3D back to 2D coordinates
            const SCALE = 0.5
            const newX = this._dragMesh.position.x / SCALE
            const newY = -this._dragMesh.position.z / SCALE  // flip Y back
            this.nodeMoved.emit({ nodeId: this._dragNodeId, x: newX, y: newY })
        }

        // If mouse barely moved, treat as click (select)
        if (!this._dragging) {
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

    // ── Drag-and-drop from palette (add new devices) ──────────────────

    onDragOver (event: DragEvent): void {
        event.preventDefault()
        if (event.dataTransfer) { event.dataTransfer.dropEffect = 'copy' }
    }

    onDrop (event: DragEvent): void {
        event.preventDefault()
        const type = event.dataTransfer?.getData('nodeType')
        if (!type) { return }

        // Convert drop position to 3D world coordinates on the ground plane
        this._dragPlane.set(new THREE.Vector3(0, 1, 0), 0)
        const worldPt = this._getWorldPoint(event as any)
        if (!worldPt) { return }

        // Convert 3D back to 2D canvas coordinates
        const SCALE = 0.5
        const x = worldPt.x / SCALE
        const y = -worldPt.z / SCALE  // flip Y back
        this.nodeAdded.emit({ type, x, y })
    }

    // ── Scene initialization ──────────────────────────────────────────────

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
        const ambient = new THREE.AmbientLight(0xffffff, 0.8)
        this.scene.add(ambient)

        const directional = new THREE.DirectionalLight(0xffffff, 1.0)
        directional.position.set(150, 300, 150)
        this.scene.add(directional)

        const fill = new THREE.DirectionalLight(0x6688ff, 0.5)
        fill.position.set(-150, 100, -150)
        this.scene.add(fill)

        const rim = new THREE.DirectionalLight(0xff8844, 0.2)
        rim.position.set(0, -50, 200)
        this.scene.add(rim)

        // Subtle dark grid for spatial reference
        const grid = new THREE.GridHelper(800, 40, 0x1a2040, 0x0f1525)
        grid.position.y = -60
        this.scene.add(grid)
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

    // ── Build topology (nodes + links) ────────────────────────────────────

    private _buildTopology (): void {
        if (!this.topology?.nodes) { return }

        // Compute 3D positions from 2D layout
        const pos3d = from2DLayout(this.topology.nodes)
        this.positions.clear()
        for (const p of pos3d) { this.positions.set(p.id, p) }

        // Reconcile nodes
        const currentNodeIds = new Set(this.topology.nodes.map(n => n.id))

        // Remove stale
        for (const [id, mesh] of this.nodeMeshes) {
            if (!currentNodeIds.has(id)) {
                this.scene.remove(mesh)
                mesh.geometry.dispose()
                ;(mesh.material as THREE.Material).dispose()
                this.nodeMeshes.delete(id)

                const label = this.nodeLabels.get(id)
                if (label) { this.scene.remove(label); this.nodeLabels.delete(id) }
                const status = this.nodeStatus.get(id)
                if (status) { this.scene.remove(status); this.nodeStatus.delete(id) }
            }
        }

        // Add/update nodes
        for (const node of this.topology.nodes) {
            const pos = this.positions.get(node.id)
            if (!pos) { continue }

            let mesh = this.nodeMeshes.get(node.id)
            if (!mesh) {
                mesh = this._createNodeMesh(node)
                mesh.userData = { nodeId: node.id }
                this.scene.add(mesh)
                this.nodeMeshes.set(node.id, mesh)

                // Label
                const label = this._createLabel(node.label)
                this.scene.add(label)
                this.nodeLabels.set(node.id, label)

                // Status indicator
                const statusMesh = this._createStatusMesh(node.status)
                this.scene.add(statusMesh)
                this.nodeStatus.set(node.id, statusMesh)
            }

            // Update position
            mesh.position.set(pos.x, pos.z, pos.y)  // swap y/z for Three.js (Y is up)
            const label = this.nodeLabels.get(node.id)
            if (label) { label.position.set(pos.x, pos.z + 18, pos.y) }
            const statusMesh = this.nodeStatus.get(node.id)
            if (statusMesh) {
                statusMesh.position.set(pos.x + 10, pos.z + 10, pos.y)
                const statusColor = node.status === 'running' ? 0x22c55e : node.status === 'suspended' ? 0xf59e0b : 0xef4444
                ;(statusMesh.material as THREE.MeshStandardMaterial).color.setHex(statusColor)
                ;(statusMesh.material as THREE.MeshStandardMaterial).emissive.setHex(statusColor)
            }
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
            const srcPos = this.positions.get(link.sourceNodeId)
            const tgtPos = this.positions.get(link.targetNodeId)
            if (!srcPos || !tgtPos) { continue }

            let line = this.linkLines.get(link.id)
            if (!line) {
                const geometry = new THREE.BufferGeometry()
                const material = new THREE.LineBasicMaterial({
                    color: link.linkColor || 0x4488cc,
                    transparent: true,
                    opacity: 0.7,
                    linewidth: 1,  // Note: only works on some platforms, but set anyway
                })
                line = new THREE.Line(geometry, material)
                this.scene.add(line)
                this.linkLines.set(link.id, line)
            }

            const points = [
                new THREE.Vector3(srcPos.x, srcPos.z, srcPos.y),
                new THREE.Vector3(tgtPos.x, tgtPos.z, tgtPos.y),
            ]
            line.geometry.dispose()
            line.geometry = new THREE.BufferGeometry().setFromPoints(points)
        }

        // Build traffic particles
        this._buildParticles()

        // Update selection highlight
        this._updateSelection()

        // Auto-center camera
        this._autoCenterCamera()
    }

    // ── Node mesh factory ─────────────────────────────────────────────────

    private _createNodeMesh (node: TopologyNode): THREE.Mesh {
        const meta = NODE_TYPE_META[node.type] ?? NODE_TYPE_META['router']
        const color = new THREE.Color(meta.borderColor)

        let geometry: THREE.BufferGeometry
        switch (node.type) {
            case 'router':
                geometry = new THREE.SphereGeometry(10, 24, 24)
                break
            case 'switch':
                geometry = new THREE.BoxGeometry(18, 7, 18)
                break
            case 'firewall':
                geometry = new THREE.OctahedronGeometry(12)
                break
            case 'server':
                geometry = new THREE.BoxGeometry(10, 18, 10)
                break
            case 'pc':
                geometry = new THREE.ConeGeometry(8, 14, 4)
                break
            case 'cloud':
                geometry = new THREE.IcosahedronGeometry(10)
                break
            default:
                geometry = new THREE.SphereGeometry(8, 16, 16)
        }

        const material = new THREE.MeshStandardMaterial({
            color,
            metalness: 0.2,
            roughness: 0.4,
            emissive: color,
            emissiveIntensity: 0.3,
        })

        return new THREE.Mesh(geometry, material)
    }

    private _createLabel (text: string): THREE.Sprite {
        const canvas = document.createElement('canvas')
        canvas.width = 512
        canvas.height = 128
        const ctx = canvas.getContext('2d')!

        // Background pill
        const displayText = text.length > 16 ? text.slice(0, 15) + '…' : text
        ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, sans-serif'
        const metrics = ctx.measureText(displayText)
        const textW = metrics.width + 32
        const pillX = (512 - textW) / 2
        ctx.fillStyle = 'rgba(10, 14, 26, 0.85)'
        ctx.beginPath()
        ctx.roundRect(pillX, 20, textW, 56, 14)
        ctx.fill()

        // Border
        ctx.strokeStyle = 'rgba(100, 140, 200, 0.4)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.roundRect(pillX, 20, textW, 56, 14)
        ctx.stroke()

        // Text
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
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

    // ── Selection highlight ───────────────────────────────────────────────

    private _updateSelection (): void {
        // Remove previous highlight
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

    // ── Traffic particles ─────────────────────────────────────────────────

    private _buildParticles (): void {
        // Clear existing
        while (this.particleGroup.children.length) {
            const c = this.particleGroup.children[0]
            if (c instanceof THREE.Points) { c.geometry.dispose(); (c.material as THREE.Material).dispose() }
            this.particleGroup.remove(c)
        }
        this.particleT = []

        // Create particles for each link
        for (const link of (this.topology?.links ?? [])) {
            const srcPos = this.positions.get(link.sourceNodeId)
            const tgtPos = this.positions.get(link.targetNodeId)
            if (!srcPos || !tgtPos) { continue }

            const count = 3
            const positions = new Float32Array(count * 3)
            const geometry = new THREE.BufferGeometry()
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

            const material = new THREE.PointsMaterial({
                color: 0x00e5ff,
                size: 3,
                transparent: true,
                opacity: 0.9,
                sizeAttenuation: true,
            })

            const points = new THREE.Points(geometry, material)
            points.userData = {
                src: new THREE.Vector3(srcPos.x, srcPos.z, srcPos.y),
                tgt: new THREE.Vector3(tgtPos.x, tgtPos.z, tgtPos.y),
            }
            this.particleGroup.add(points)

            // Initialize t values staggered
            for (let i = 0; i < count; i++) {
                this.particleT.push(i / count)
            }
        }
    }

    private _animateParticles (): void {
        let tIdx = 0
        for (const child of this.particleGroup.children) {
            if (!(child instanceof THREE.Points)) { continue }
            const { src, tgt } = child.userData as { src: THREE.Vector3; tgt: THREE.Vector3 }
            const posAttr = child.geometry.getAttribute('position') as THREE.BufferAttribute
            const count = posAttr.count

            for (let i = 0; i < count; i++) {
                this.particleT[tIdx] = (this.particleT[tIdx] + 0.008) % 1
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
        for (const p of this.positions.values()) {
            cx += p.x; cy += p.z; cz += p.y
        }
        const n = this.positions.size
        cx /= n; cy /= n; cz /= n

        this.controls.target.set(cx, cy, cz)
        this.camera.position.set(cx, cy + 150, cz + 300)
        this.controls.update()
    }

    // ── Animation loop ────────────────────────────────────────────────────

    private _animate = (): void => {
        this.rafId = requestAnimationFrame(this._animate)
        this.controls.update()
        this._animateParticles()
        this.renderer.render(this.scene, this.camera)
    }
}
