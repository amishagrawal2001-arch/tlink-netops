import { CUSTOM_ELEMENTS_SCHEMA, NgModule } from '@angular/core'
import { BrowserModule } from '@angular/platform-browser'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'

import { AppShellComponent }       from './components/app-shell.component'
import { TabBarComponent }         from './components/tab-bar.component'
import { NetopsCanvasComponent }   from './components/netops-canvas.component'
import { NodePropertiesComponent } from './components/node-properties.component'
import { LinkPropertiesComponent } from './components/link-properties.component'
import { TemplatesComponent }      from './components/templates.component'
import { TemplatePreviewComponent } from './components/template-preview.component'
import { TerminalPanelComponent }   from './components/terminal-panel.component'
import { Netops3dCanvasComponent }  from './components/netops-3d-canvas.component'
import { DeviceMapperComponent }    from './components/device-mapper.component'
import { BackupHistoryComponent }   from './components/backup-history.component'
import { TopologyBuilderComponent } from './components/topology-builder.component'
import { HelpViewComponent }        from './components/help-view.component'
import { CompliancePanelComponent } from './components/compliance-panel.component'
import { EventRulesComponent }      from './components/event-rules.component'
import { AutomationDashboardComponent } from './components/automation-dashboard.component'
import { SchedulerPanelComponent }      from './components/scheduler-panel.component'
import { WorkflowEditorComponent }  from './components/workflow-editor.component'
import { ChangeManagerComponent }   from './components/change-manager.component'
import { SafeHtmlPipe }             from './pipes/safe-html.pipe'
import { TabManagerService }       from './services/tab-manager.service'
import { LicenseService }          from './services/license.service'
import { TAB_MANAGER }             from './api/tokens'

@NgModule({
    imports: [
        BrowserModule,
        FormsModule,
        NgbModule,
    ],
    declarations: [
        AppShellComponent,
        TabBarComponent,
        NetopsCanvasComponent,
        NodePropertiesComponent,
        LinkPropertiesComponent,
        TemplatesComponent,
        TemplatePreviewComponent,
        TerminalPanelComponent,
        Netops3dCanvasComponent,
        DeviceMapperComponent,
        BackupHistoryComponent,
        TopologyBuilderComponent,
        HelpViewComponent,
        CompliancePanelComponent,
        EventRulesComponent,
        AutomationDashboardComponent,
        SchedulerPanelComponent,
        WorkflowEditorComponent,
        ChangeManagerComponent,
        SafeHtmlPipe,
    ],
    providers: [
        TabManagerService,
        LicenseService,
        { provide: TAB_MANAGER, useExisting: TabManagerService },
        // TopologyService is NOT listed here — each tab creates its own instance
        // via a child injector in TabManagerService.createTab()
    ],
    bootstrap: [AppShellComponent],
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class AppModule {}
