import {
    ChangeDetectionStrategy, ChangeDetectorRef, Component, Input,
    OnChanges, OnDestroy, SimpleChanges,
} from '@angular/core'
import { TopologyTemplate, NODE_TYPE_META } from '../api/interfaces'

interface PreviewNode {
    cx: number
    cy: number
    r: number
    color: string
    label: string
}

interface PreviewLink {
    x1: number
    y1: number
    x2: number
    y2: number
}

@Component({
    selector: 'template-preview',
    templateUrl: './template-preview.component.pug',
    styleUrls: ['./template-preview.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatePreviewComponent implements OnChanges, OnDestroy {

    @Input() template!: TopologyTemplate

    viewBox = '0 0 300 140'
    previewNodes: PreviewNode[] = []
    previewLinks: PreviewLink[] = []
    showFlow = false

    private _flowTimer: any
    private readonly WIDTH = 300
    private readonly HEIGHT = 140
    private readonly PADDING = 14

    ngOnChanges (_changes: SimpleChanges): void {
        this.showFlow = false
        clearTimeout(this._flowTimer)
        this._computePreview()
        this._scheduleFlow()
    }

    ngOnDestroy (): void {
        clearTimeout(this._flowTimer)
    }

    nodeDelay (i: number): number {
        return i * 40
    }

    linkDelay (i: number): number {
        return this.previewNodes.length * 40 + 100 + i * 30
    }

    private _scheduleFlow (): void {
        const totalNodeTime = this.previewNodes.length * 40
        const totalLinkTime = this.previewLinks.length * 30 + 100
        this._flowTimer = setTimeout(() => {
            this.showFlow = true
            this.cdr.markForCheck()
        }, totalNodeTime + totalLinkTime + 400)
    }

    constructor (private cdr: ChangeDetectorRef) {}

    private _computePreview (): void {
        const tpl = this.template
        if (!tpl?.nodes?.length) {
            this.previewNodes = []
            this.previewLinks = []
            return
        }

        const nodes = tpl.nodes
        const nodeCount = nodes.length

        // Compute bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of nodes) {
            if (n.x < minX) { minX = n.x }
            if (n.y < minY) { minY = n.y }
            if (n.x > maxX) { maxX = n.x }
            if (n.y > maxY) { maxY = n.y }
        }

        const bboxW = maxX - minX
        const bboxH = maxY - minY

        // Handle degenerate cases
        let positions: { cx: number; cy: number }[]

        if (nodeCount === 1 || (bboxW === 0 && bboxH === 0)) {
            // Single node or all overlapping: arrange in a circle
            const centerX = this.WIDTH / 2
            const centerY = this.HEIGHT / 2
            const radius = Math.min(this.WIDTH, this.HEIGHT) / 2 - this.PADDING - 10
            positions = nodes.map((_, i) => {
                if (nodeCount === 1) {
                    return { cx: centerX, cy: centerY }
                }
                const angle = (2 * Math.PI * i) / nodeCount - Math.PI / 2
                return {
                    cx: centerX + radius * Math.cos(angle),
                    cy: centerY + radius * Math.sin(angle),
                }
            })
        } else {
            // Scale to fit viewport
            const scaleX = bboxW > 0 ? (this.WIDTH - 2 * this.PADDING) / bboxW : 1
            const scaleY = bboxH > 0 ? (this.HEIGHT - 2 * this.PADDING) / bboxH : 1
            const scale = Math.min(scaleX, scaleY)
            const offsetX = this.PADDING + ((this.WIDTH - 2 * this.PADDING) - bboxW * scale) / 2
            const offsetY = this.PADDING + ((this.HEIGHT - 2 * this.PADDING) - bboxH * scale) / 2

            positions = nodes.map(n => ({
                cx: (n.x - minX) * scale + offsetX,
                cy: (n.y - minY) * scale + offsetY,
            }))
        }

        // Node radius: scale down for dense topologies
        const r = Math.max(3, 6 - nodeCount / 10)

        // Build preview nodes
        this.previewNodes = nodes.map((n, i) => ({
            cx: positions[i].cx,
            cy: positions[i].cy,
            r,
            color: NODE_TYPE_META[n.type]?.borderColor ?? '#888',
            label: n.label.length > 5 ? n.label.slice(0, 4) : n.label,
        }))

        // Build preview links
        this.previewLinks = tpl.links
            .filter(l => l.sourceNode < nodeCount && l.targetNode < nodeCount)
            .map(l => ({
                x1: positions[l.sourceNode].cx,
                y1: positions[l.sourceNode].cy,
                x2: positions[l.targetNode].cx,
                y2: positions[l.targetNode].cy,
            }))

        this.viewBox = `0 0 ${this.WIDTH} ${this.HEIGHT}`
    }
}
