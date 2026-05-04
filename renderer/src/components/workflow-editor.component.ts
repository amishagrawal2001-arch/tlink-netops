import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, EventEmitter, OnInit, Output,
} from '@angular/core'
import { WorkflowService, Workflow, WorkflowStep, WorkflowResult } from '../services/workflow.service'
import { InventoryService } from '../services/inventory.service'
import { EventTrigger } from '../api/interfaces'

@Component({
    selector: 'workflow-editor',
    templateUrl: './workflow-editor.component.pug',
    styleUrls: ['./workflow-editor.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowEditorComponent implements OnInit {

    @Output() closed = new EventEmitter<void>()

    selectedWorkflow: Workflow | null = null
    showAddForm = false
    testRunning = false

    // Add workflow form
    newName = ''
    newTrigger: EventTrigger = 'alarm_raised'
    newNodeFilter = '*'
    newVendorFilter = '*'

    // Add step form (inline in the right panel)
    showAddStep = false
    newStepAction: WorkflowStep['action'] = 'log'
    newStepContinueOnError = false
    newStepMessage = ''
    newStepCommand = ''
    newStepConfigType = 'running'
    newStepUrl = ''
    newStepMethod = 'POST'
    newStepHeaders = ''
    newStepApprovalGate = ''
    newStepApprovalTimeout = 60

    readonly triggerOptions: { value: EventTrigger; label: string }[] = [
        { value: 'command_check',  label: 'Command Check' },
        { value: 'alarm_raised',   label: 'Alarm Raised' },
        { value: 'alarm_cleared',  label: 'Alarm Cleared' },
        { value: 'config_change',  label: 'Config Change' },
        { value: 'link_down',      label: 'Link Down' },
        { value: 'link_up',        label: 'Link Up' },
        { value: 'poll_complete',  label: 'Poll Complete' },
        { value: 'version_change', label: 'Version Change' },
    ]

    readonly actionOptions: { value: WorkflowStep['action']; label: string }[] = [
        { value: 'notify',        label: 'Notify' },
        { value: 'backup_config', label: 'Backup Config' },
        { value: 'run_command',   label: 'Run Command' },
        { value: 'approval',      label: 'Approval Gate (pause for operator)' },
        { value: 'webhook',       label: 'Webhook (Slack/Teams/HTTP POST)' },
        { value: 'log',           label: 'Log' },
    ]

    readonly vendorOptions = ['*', 'cisco', 'juniper', 'arista', 'nokia', 'sonic', 'huawei', 'hpe', 'dell', 'mikrotik', 'extreme']

    constructor (
        public wfSvc: WorkflowService,
        private invSvc: InventoryService,
        private cdr: ChangeDetectorRef,
    ) {}

    async ngOnInit (): Promise<void> {
        await this.wfSvc.loadWorkflows()
        this.cdr.markForCheck()
    }

    get workflows (): Workflow[] { return this.wfSvc.workflows }
    get history (): WorkflowResult[] { return this.wfSvc.history }

    // ── Workflow list ────────────────────────────────────────────────────────

    selectWorkflow (wf: Workflow): void {
        this.selectedWorkflow = wf
        this.showAddForm = false
        this.showAddStep = false
        this.cdr.markForCheck()
    }

    toggleWorkflow (id: string, event: Event): void {
        event.stopPropagation()
        this.wfSvc.toggleWorkflow(id)
        this.cdr.markForCheck()
    }

    removeWorkflow (id: string, event: Event): void {
        event.stopPropagation()
        this.wfSvc.removeWorkflow(id)
        if (this.selectedWorkflow?.id === id) { this.selectedWorkflow = null }
        this.cdr.markForCheck()
    }

    // ── Add workflow ─────────────────────────────────────────────────────────

    toggleAddForm (): void {
        this.showAddForm = !this.showAddForm
        if (this.showAddForm) { this.selectedWorkflow = null }
        this.cdr.markForCheck()
    }

    addWorkflow (): void {
        if (!this.newName.trim()) { return }
        const wf = this.wfSvc.addWorkflow({
            name: this.newName.trim(),
            trigger: this.newTrigger,
            nodeFilter: this.newNodeFilter || '*',
            vendorFilter: this.newVendorFilter || '*',
            steps: [],
            enabled: true,
        })
        this.newName = ''
        this.showAddForm = false
        this.selectedWorkflow = wf
        this.cdr.markForCheck()
    }

    // ── Step management ──────────────────────────────────────────────────────

    toggleAddStep (): void {
        this.showAddStep = !this.showAddStep
        this._resetStepForm()
        this.cdr.markForCheck()
    }

    addStep (): void {
        if (!this.selectedWorkflow) { return }

        const config: Record<string, any> = {}
        switch (this.newStepAction) {
            case 'notify':
            case 'log':
                config['message'] = this.newStepMessage || `Step: ${this.newStepAction}`
                break
            case 'backup_config':
                config['configType'] = this.newStepConfigType
                break
            case 'run_command':
                config['command'] = this.newStepCommand
                break
            case 'webhook':
                config['url'] = this.newStepUrl
                config['method'] = this.newStepMethod
                if (this.newStepHeaders.trim()) {
                    try { config['headers'] = JSON.parse(this.newStepHeaders) } catch { /* ignore */ }
                }
                break
            case 'approval':
                config['message'] = this.newStepMessage || 'Please approve this change before it proceeds.'
                if (this.newStepApprovalGate.trim()) { config['gate'] = this.newStepApprovalGate.trim() }
                config['timeoutMinutes'] = Number(this.newStepApprovalTimeout) || 0
                break
        }

        const step: WorkflowStep = {
            action: this.newStepAction,
            config,
            continueOnError: this.newStepContinueOnError,
        }

        const steps = [...this.selectedWorkflow.steps, step]
        this.wfSvc.updateWorkflow(this.selectedWorkflow.id, { steps })
        this.selectedWorkflow = { ...this.selectedWorkflow, steps }
        this.showAddStep = false
        this._resetStepForm()
        this.cdr.markForCheck()
    }

    removeStep (index: number): void {
        if (!this.selectedWorkflow) { return }
        const steps = this.selectedWorkflow.steps.filter((_, i) => i !== index)
        this.wfSvc.updateWorkflow(this.selectedWorkflow.id, { steps })
        this.selectedWorkflow = { ...this.selectedWorkflow, steps }
        this.cdr.markForCheck()
    }

    moveStep (index: number, direction: -1 | 1): void {
        if (!this.selectedWorkflow) { return }
        const steps = [...this.selectedWorkflow.steps]
        const target = index + direction
        if (target < 0 || target >= steps.length) { return }
        ;[steps[index], steps[target]] = [steps[target], steps[index]]
        this.wfSvc.updateWorkflow(this.selectedWorkflow.id, { steps })
        this.selectedWorkflow = { ...this.selectedWorkflow, steps }
        this.cdr.markForCheck()
    }

    toggleContinueOnError (index: number): void {
        if (!this.selectedWorkflow) { return }
        const steps = this.selectedWorkflow.steps.map((s, i) =>
            i === index ? { ...s, continueOnError: !s.continueOnError } : s,
        )
        this.wfSvc.updateWorkflow(this.selectedWorkflow.id, { steps })
        this.selectedWorkflow = { ...this.selectedWorkflow, steps }
        this.cdr.markForCheck()
    }

    stepConfigSummary (step: WorkflowStep): string {
        switch (step.action) {
            case 'notify':
            case 'log':
                return step.config['message'] ?? ''
            case 'backup_config':
                return step.config['configType'] ?? 'running'
            case 'run_command':
                return step.config['command'] ?? ''
            case 'webhook':
                return step.config['url'] ?? ''
            default:
                return ''
        }
    }

    // ── Test Run ─────────────────────────────────────────────────────────────

    async testRun (): Promise<void> {
        if (!this.selectedWorkflow || this.testRunning) { return }
        this.testRunning = true
        this.cdr.markForCheck()

        const mockEvent = {
            nodeId: 'test-node',
            nodeLabel: 'TestNode',
            trigger: this.selectedWorkflow.trigger,
        }

        await this.wfSvc.executeWorkflow(this.selectedWorkflow, mockEvent, this.invSvc)

        this.testRunning = false
        this.cdr.markForCheck()
    }

    // ── History ──────────────────────────────────────────────────────────────

    get recentHistory (): WorkflowResult[] {
        return this.history.slice(-10).reverse()
    }

    relativeTime (iso: string): string {
        const diff = Date.now() - new Date(iso).getTime()
        if (diff < 60000) { return 'just now' }
        if (diff < 3600000) { return `${Math.floor(diff / 60000)}m ago` }
        if (diff < 86400000) { return `${Math.floor(diff / 3600000)}h ago` }
        return `${Math.floor(diff / 86400000)}d ago`
    }

    triggerLabel (trigger: string): string {
        return this.triggerOptions.find(t => t.value === trigger)?.label ?? trigger
    }

    // ── Utilities ────────────────────────────────────────────────────────────

    close (): void { this.closed.emit() }

    private _resetStepForm (): void {
        this.newStepAction = 'log'
        this.newStepContinueOnError = false
        this.newStepMessage = ''
        this.newStepCommand = ''
        this.newStepConfigType = 'running'
        this.newStepUrl = ''
        this.newStepMethod = 'POST'
        this.newStepHeaders = ''
        this.newStepApprovalGate = ''
        this.newStepApprovalTimeout = 60
    }
}
