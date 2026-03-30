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
import { TopologyBuilderComponent } from './components/topology-builder.component'
import { HelpViewComponent }        from './components/help-view.component'
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
        TopologyBuilderComponent,
        HelpViewComponent,
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
