import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, EventEmitter, OnInit, Output,
} from '@angular/core'
import { InventoryService } from '../services/inventory.service'
import { TopologyService } from '../services/topology.service'
import {
    EventRule, EventTrigger, EventActionType, InventoryEvent,
} from '../api/interfaces'

@Component({
    selector: 'event-rules',
    templateUrl: './event-rules.component.pug',
    styleUrls: ['./event-rules.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EventRulesComponent implements OnInit {

    @Output() closed = new EventEmitter<void>()

    // ── Form fields ──────────────────────────────────────────────────────────
    newRuleName = ''
    newRuleTrigger: EventTrigger = 'alarm_raised'
    newRuleAction: EventActionType = 'notify'
    newRuleNodeFilter = '*'
    newRuleVendorFilter = '*'
    newRuleMessage = ''
    newRuleCommand = ''
    newRuleCheckCommand = ''
    newRuleCheckPattern = ''
    newRuleWebhookUrl = ''
    newRuleWebhookMethod = 'POST'
    newRuleWebhookHeaders = ''

    showEventLog = false

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

    readonly actionOptions: { value: EventActionType; label: string }[] = [
        { value: 'notify',        label: 'Notify' },
        { value: 'backup_config', label: 'Backup Config' },
        { value: 'run_command',   label: 'Run Command' },
        { value: 'log',           label: 'Log' },
        { value: 'webhook',       label: 'Webhook' },
    ]

    readonly vendorOptions = ['*', 'cisco', 'juniper', 'arista', 'nokia', 'sonic', 'huawei', 'hpe', 'dell', 'mikrotik', 'extreme']

    constructor (
        public invSvc: InventoryService,
        private topoSvc: TopologyService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit (): void {}

    get eventRules (): EventRule[] {
        return this.invSvc.store.eventRules
    }

    get recentEventLog (): InventoryEvent[] {
        return this.invSvc.store.eventLog.slice(-50).reverse()
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    addRule (): void {
        if (!this.newRuleName.trim()) { return }

        let webhookHeaders: Record<string, string> | undefined
        if (this.newRuleWebhookHeaders.trim()) {
            try {
                webhookHeaders = JSON.parse(this.newRuleWebhookHeaders)
            } catch { /* ignore invalid JSON */ }
        }

        this.invSvc.addEventRule({
            name: this.newRuleName.trim(),
            enabled: true,
            trigger: this.newRuleTrigger,
            nodeFilter: this.newRuleNodeFilter || '*',
            vendorFilter: this.newRuleVendorFilter || '*',
            action: this.newRuleAction,
            actionConfig: {
                message: this.newRuleMessage || undefined,
                command: this.newRuleCommand || undefined,
                checkCommand: this.newRuleCheckCommand || undefined,
                checkPattern: this.newRuleCheckPattern || undefined,
                webhookUrl: this.newRuleWebhookUrl || undefined,
                webhookMethod: this.newRuleWebhookMethod !== 'POST' ? this.newRuleWebhookMethod : undefined,
                webhookHeaders: webhookHeaders,
            },
        })

        // Reset form
        this.newRuleName = ''
        this.newRuleMessage = ''
        this.newRuleCommand = ''
        this.newRuleCheckCommand = ''
        this.newRuleCheckPattern = ''
        this.newRuleWebhookUrl = ''
        this.newRuleWebhookMethod = 'POST'
        this.newRuleWebhookHeaders = ''
        this.cdr.markForCheck()
    }

    toggleRule (ruleId: string): void {
        const rule = this.invSvc.store.eventRules.find(r => r.id === ruleId)
        if (rule) {
            this.invSvc.updateEventRule(ruleId, { enabled: !rule.enabled })
            this.cdr.markForCheck()
        }
    }

    removeRule (ruleId: string): void {
        this.invSvc.removeEventRule(ruleId)
        this.cdr.markForCheck()
    }

    getNodeLabel (nodeId: string): string {
        const topo = this.topoSvc.topology
        return topo?.nodes.find(n => n.id === nodeId)?.label ?? nodeId
    }

    relativeTime (iso: string): string {
        const diff = Date.now() - new Date(iso).getTime()
        if (diff < 60000) { return 'just now' }
        if (diff < 3600000) { return `${Math.floor(diff / 60000)}m ago` }
        if (diff < 86400000) { return `${Math.floor(diff / 3600000)}h ago` }
        return `${Math.floor(diff / 86400000)}d ago`
    }

    close (): void {
        this.closed.emit()
    }
}
