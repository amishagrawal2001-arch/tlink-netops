import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, ElementRef, HostListener,
    Inject, OnDestroy, OnInit, ViewChild,
} from '@angular/core'
import { BehaviorSubject, Subscription } from 'rxjs'
import { TopologyService } from '../services/topology.service'
import { InventoryService } from '../services/inventory.service'
import { IS_ACTIVE_TAB, TAB_MANAGER } from '../api/tokens'
import {
    Topology, TopologyNode, TopologyLink,
    NodeType, NodePort, DeviceInventoryRecord, Annotation,
    NODE_TYPE_META, NODE_W, NODE_H, AutoLoopbackSummary,
    SERVICE_PROFILES, DEFAULT_PORTS,
    TopologyTemplate, TemplateNodeDef, TemplateLinkDef, TemplateCategory,
    DeviceVersion, DeviceAlarm, AlarmSeverity,
    PollSyncProposal, ConfigBackupEntry,
    BgpNeighborEntry,
    TrafficFlow, ComputedFlowPath,
} from '../api/interfaces'
import { asnToAsdot, is4ByteAsn, generateTelemetryPipeline } from '../services/vendor-config-builder'
import { TopologyGraphService } from '../services/topology-graph.service'
import { getVendorCommands } from '../services/vendor-command-map'
import { parseRouteTable, parseInterfaceCounters, ParsedRouteEntry, ParsedInterfaceCounters } from '../services/vendor-output-parser'
import { LayoutAlgorithm, forceDirectedLayout, hierarchicalLayout, radialLayout, gridLayout } from '../services/layout-helpers'
import { LicenseService } from '../services/license.service'
import { TopologyExportService } from '../services/topology-export.service'

interface PendingLink { sourceNodeId: string; sourcePortId: string; sourceAnnotationId?: string; anchorX?: number; anchorY?: number }
interface PortPickerOption { port: NodePort; available: boolean; displayLabel?: string }

let _nextInstanceId = 0

@Component({
    selector: 'netops-canvas',
    templateUrl: './netops-canvas.component.pug',
    styleUrls: ['./netops-canvas.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NetopsCanvasComponent implements OnInit, OnDestroy {

    @ViewChild('svgCanvas', { static: true }) svgRef!: ElementRef<SVGSVGElement>
    @ViewChild('terminalPanel') terminalPanelRef: any
    // Terminal opens in a separate window — no embedded panel needed

    /** Unique instance ID for SVG pattern/filter IDs to avoid cross-tab conflicts */
    readonly uid = `c${_nextInstanceId++}`

    topology!: Topology
    selectedNodeId: string | null = null
    selectedLinkId: string | null = null
    selectedNodeIds = new Set<string>()
    selectedLinkIds = new Set<string>()

    // viewport
    vpX = 0; vpY = 0; vpScale = 1
    readonly minScale = 0.1
    readonly maxScale = 4
    showMinimap = true
    viewMode: '2d' | '3d' = '2d'

    // ── Digital Twin state ─────────────────────────────────────────────────
    digitalTwinActive = false
    twinNodeHealth = new Map<string, { cpu: number; mem: number; alarms: number }>()
    twinConfigDrift = new Map<string, { hasDrift: boolean; addedCount: number; removedCount: number; addedLines: string[]; removedLines: string[] }>()
    showDriftViewer = false
    driftViewerNodeId = ''
    driftViewerNodeLabel = ''
    twinActiveAlarms = new Map<string, Array<{ severity: string; message: string }>>()
    showTwinDashboard = false
    showDeviceMapper = false
    showMappedDevicesPanel = false
    showBackupHistory = false
    discoveredDevicesList: Array<{ hostname: string; mgmtIp: string; vendor: string; model: string; interfaces: string[] }> = []
    private _twinPollTimer: any = null

    showAlarmOverlay = false
    showGrid = true
    gridSize: 'small' | 'medium' | 'large' = 'medium'
    private _panning = false
    private _panMoved = false
    private _ignoreNextBgClick = false

    // node drag
    _dragNode: TopologyNode | null = null
    private _dragOX = 0; private _dragOY = 0

    // link drawing
    pendingLink: PendingLink | null = null
    pendingMouse = { x: 0, y: 0 }

    // port picker
    portPickerCtx: string | null = null   // "src:<nodeId>" | "tgt:<nodeId>"
    portPickerPorts: PortPickerOption[] = []
    portPickerX = 0; portPickerY = 0
    portPickerNodeType: string = ''   // 'host' | 'bridge' | '' for normal nodes
    portPickerLoading = false
    // Cache for host interfaces / bridge lists (keyed by serverId)
    private _hostIfaceCache = new Map<string, { ts: number; ifaces: Array<{ name: string; state: string }> }>()
    private _bridgeListCache = new Map<string, { ts: number; bridges: Array<{ name: string; type: string; state: string }> }>()
    private readonly _CACHE_TTL = 30_000  // 30 seconds

    // context menu
    ctxNodeId: string | null = null
    ctxX = 0; ctxY = 0

    /** Position a context menu within the SVG bounds. Repositions after render if needed. */
    private _ctxPos (ev: MouseEvent, menuW = 180, menuH = 320): { x: number; y: number } {
        const svgR = this.svgRef.nativeElement.getBoundingClientRect()
        let x = ev.clientX - svgR.left + 8
        let y = ev.clientY - svgR.top
        // Clamp so menu stays within the visible area
        if (x + menuW > svgR.width) { x = svgR.width - menuW - 4 }
        if (y + menuH > svgR.height) { y = svgR.height - menuH - 4 }
        if (x < 4) { x = 4 }
        if (y < 4) { y = 4 }
        // Post-render adjustment: measure actual menu and reposition if overflowing
        setTimeout(() => {
            const menu = document.querySelector('.ctx-menu:not([style*="display: none"])') as HTMLElement
            if (!menu) { return }
            const menuRect = menu.getBoundingClientRect()
            if (menuRect.bottom > svgR.bottom) {
                const newY = svgR.height - menuRect.height - 4
                menu.style.top = Math.max(4, newY) + 'px'
            }
            if (menuRect.right > svgR.right) {
                const newX = svgR.width - menuRect.width - 4
                menu.style.left = Math.max(4, newX) + 'px'
            }
        }, 0)
        return { x, y }
    }

    // troubleshoot dialog
    tsDialogVisible = false
    tsNodeLabel = ''
    tsSections: { title: string; open: boolean; commands: { command: string; description?: string }[] }[] = []

    // inline rename
    renamingId: string | null = null
    renamingLabel = ''

    // status bar
    statusMsg = 'Ready'
    importError = ''
    deviceMapError = ''

    // device import report / preview dialog
    showDeviceImportReport = false
    deviceImportResult: import('../api/interfaces').DeviceMappingSummary | null = null
    deviceImportPreview = false   // true = preview (dry-run), false = result (already applied)
    private _pendingDeviceRecords: import('../api/interfaces').DeviceInventoryRecord[] = []

    // clipboard
    private _clipboard: TopologyNode[] = []
    private _shapeClipboard: Annotation[] = []

    // search
    searchQuery = ''
    showSearch = false

    // templates & builder overlays
    showTemplates = false
    showBuilder = false

    // menu bar
    openMenu: string | null = null
    showIpLabels = true
    showInterfaceLabels = true
    autoIpBaseCidr = '10.0.0.0/8'
    autoLoopbackBaseCidr = '172.16.0.0/16'
    showAutoIpDialog = false
    autoIpInput = this.autoIpBaseCidr
    autoIpOverwriteExisting = false
    autoIpHasExisting = false
    autoIpDialogError = ''

    // IPv6 auto-address dialog
    autoIpv6BaseCidr = '2001:db8::/32'
    autoLoopbackV6BaseCidr = 'fd00::/64'
    showAutoIpv6Dialog = false
    autoIpv6Input = this.autoIpv6BaseCidr
    autoIpv6OverwriteExisting = false
    autoIpv6HasExisting = false
    autoIpv6DialogError = ''
    autoIpv6Mode: 'links' | 'loopbacks' = 'links'

    // containerlab export / deploy dialog
    showClabDialog = false
    clabImageInput = 'netreplica/docker-sonic-vs:latest'
    clabMgmtSubnet = ''
    clabDialogError = ''
    clabLabDir = ''
    clabDeploying = false
    clabDeployed = false
    autoConfigPushEnabled = true  // auto-push startup configs after deploy + interface enable
    showTerminalPanel = false    // embedded terminal panel visibility
    clabJuniperMode: 'crpd' | 'vm' | 'ask' = 'ask'  // how to map Juniper models to clab kinds
    clabPostDeployMsg = ''   // floating banner message shown after deploy until lab status appears
    clabFilePath: string | null = null
    clabInspecting = false
    private _clabInspectTimer: ReturnType<typeof setTimeout> | null = null
    private _clabEnableTimer: ReturnType<typeof setTimeout> | null = null
    clabContainers: Array<{ name: string; state: string; ipv4Address: string; ipv6Address: string; kind: string; image: string }> = []
    showClabStatusDialog = false
    // Packet capture
    showCaptureDialog = false
    captureId = ''
    captureLines: string[] = []
    captureActive = false
    captureLinkId = ''
    // Topology diff
    showTopoDiff = false
    topoDiffLines: Array<{ type: 'same' | 'add' | 'remove'; text: string }> = []
    // Lab snapshots
    showSnapshotDialog = false
    snapshotName = ''
    snapshotCreating = false
    snapshotList: Array<{ image: string; size: string; created: string }> = []
    // File browser
    showFileBrowser = false
    fileBrowserPath = '/'
    fileBrowserItems: Array<{ name: string; isDir: boolean; size: number }> = []
    fileBrowserLoading = false
    fileBrowserFileContent = ''
    fileBrowserViewingFile = ''
    // Monitoring dashboard
    showDashboard = false
    dashboardAlarmSort: 'severity' | 'time' = 'time'
    // Live status polling
    livePollingActive = false
    livePollingInterval = 10_000
    private _livePollTimer: ReturnType<typeof setInterval> | null = null
    private _livePollRunning = false
    liveBgpState = new Map<string, BgpNeighborEntry[]>()
    liveSummary = { nodesUp: 0, nodesTotal: 0, bgpUp: 0, bgpTotal: 0 }
    showLivePanel = false
    // prereq state
    clabPrereqChecked = false
    clabDockerOk = false
    clabDockerInstalled = false
    clabDockerMsg = ''
    clabClabOk = false
    clabClabMsg = ''
    clabStartingDocker = false
    clabInstallingClab = false
    // Docker image status
    clabImages: Array<{ name: string; available: boolean; size: string; pulling: boolean; error: string; arch: string; archMismatch: boolean; alternativeTags?: string[] }> = []
    clabImagesChecked = false
    availableDockerImages: string[] = []
    clabHostArch = ''
    clabVendorInfo: { hasSonic: boolean; sonicCount: number; totalCount: number; vendorSummary: string } | null = null
    clabWarnings: string[] = []
    // Pre-deploy validation
    clabValidating = false
    clabValidationErrors: string[] = []
    clabValidationWarnings: string[] = []
    clabValidationDone = false
    showValidationDetails = false
    // Detect running lab dialog
    showDetectLabDialog = false
    detectLabScanning = false
    detectedLabs: Array<{ labName: string; topoFile: string; containers: Array<{ name: string; state: string; ipv4Address: string; ipv6Address: string; kind: string; image: string }> }> = []
    detectedLabsServer: { id: string; name: string; type: string; host?: string } | null = null

    // Containerlab server management
    clabServers: Array<{ id: string; name: string; type: 'local' | 'ssh'; host?: string; port?: number; username?: string; password?: string; remoteLabDir?: string }> = []
    clabActiveServerId = 'local'
    showClabServerSettings = false
    editingServer: { id: string; name: string; type: 'local' | 'ssh'; host: string; port: number; username: string; password: string; remoteLabDir: string } | null = null
    clabServerTesting = false
    clabServerTestResult: { ok: boolean; message: string; ssh?: boolean; docker?: boolean; clab?: boolean; kvm?: boolean } | null = null
    // YAML preview in Containerlab dialog
    showClabYamlPreview = false
    clabYamlPreviewContent = ''

    // Server connection indicator
    serverConnectionStatus: 'connected' | 'disconnected' | 'local' = 'local'
    private _heartbeatTimer: ReturnType<typeof setInterval> | null = null

    // Server Manager dialog
    showServerManager = false
    serverManagerResources: Record<string, { cpu: string; mem: string; disk: string; containers: number; vms: number; kvm: boolean; status: 'connected' | 'disconnected' | 'checking' }> = {}
    serverResourceHistory: Record<string, number[]> = {}
    private _serverResourceTimer: ReturnType<typeof setInterval> | null = null

    // Docker Image Manager
    showImageManager = false
    allDockerImages: Array<{ name: string; id: string; size: string; created: string; arch: string; archMismatch: boolean }> = []
    imageSortField: 'name' | 'size' | 'arch' | 'created' = 'name'
    imageSortDir: 'asc' | 'desc' = 'asc'
    imageManagerSelected = new Set<string>()
    dockerDiskUsage: Array<{ type: string; count: string; size: string; reclaimable: string }> = []
    imageManagerLoading = false
    imageManagerHostArch = ''
    imageTagSource = ''
    imageTagTarget = ''
    imageManagerError = ''
    imagePullName = ''
    dockerSearchTerm = ''
    dockerSearchResults: Array<{ name: string; description: string; stars: number; official: boolean }> = []
    dockerSearching = false
    imagePulling = false
    imagePullError = ''
    dockerProgressMsg = ''
    readonly imageRepoHints: Array<{ label: string; image: string }> = [
        // Network OS
        { label: 'SONiC-VS',       image: 'netreplica/docker-sonic-vs:latest' },
        { label: 'cRPD',           image: 'crpd:latest' },
        { label: 'Nokia SR Linux', image: 'ghcr.io/nokia/srlinux:latest' },
        { label: 'Cisco XRd',     image: 'ios-xr/xrd-control-plane:latest' },
        { label: 'Arista cEOS',   image: 'ceos:latest' },
        { label: 'FRR',           image: 'quay.io/frrouting/frr:latest' },
        { label: 'OpenWrt',       image: 'openwrt/rootfs:latest' },
        { label: 'VyOS',          image: 'vyos/vyos:current' },
        // Linux
        { label: 'Alpine',        image: 'alpine:latest' },
        { label: 'Ubuntu',        image: 'ubuntu:24.04' },
        { label: 'Debian',        image: 'debian:bookworm-slim' },
        { label: 'Rocky Linux',   image: 'rockylinux:9-minimal' },
        { label: 'Fedora',        image: 'fedora:latest' },
        { label: 'Alma Linux',    image: 'almalinux:9-minimal' },
        // Tools
        { label: 'Nginx',         image: 'nginx:alpine' },
        { label: 'iPerf3',        image: 'networkstatic/iperf3:latest' },
        { label: 'Traceroute',    image: 'nicolaka/netshoot:latest' },
    ]

    // vrnetlab Image Builder
    showVrnetlabBuilder = false
    vrnetlabVendors: Array<{ id: string; label: string; extensions: string[] }> = []
    vrnetlabVendor = ''
    vrnetlabImagePath = ''
    vrnetlabBuilding = false
    vrnetlabBuildError = ''

    // VM Manager (libvirt/virsh)
    showVmManager = false
    vmList: Array<{ id: string; name: string; state: string }> = []
    vmManagerLoading = false
    vmManagerError = ''
    showVmCreateForm = false
    vmCreateName = ''
    vmCreateCpu = 2
    vmCreateMemory = 2048
    vmCreateDiskPath = ''
    vmCreateBridge = 'virbr0'
    vmCreating = false
    vmSnapshotTarget = ''
    vmSnapshots: Array<{ name: string; created: string; state: string }> = []
    vmDeleteConfirm = ''  // VM name pending delete confirmation
    vmDeleteStorage = false
    // Disk image library
    vmDiskImages: Array<{ name: string; size: string; path: string }> = []
    vmDiskImagesLoading = false
    vmDiskImagesLoaded = false
    vmUploadingImage = false
    vmUploadError = ''

    // Bridge Manager
    showBridgeManager = false
    bridgeList: Array<{ name: string; type: 'linux' | 'libvirt' | 'ovs'; state: string; subnet?: string; mode?: string; interfaces: string[] }> = []
    bridgeManagerLoading = false
    bridgeManagerError = ''
    showBridgeCreateForm = false
    bridgeCreateType: 'libvirt' | 'linux' | 'ovs' = 'libvirt'
    bridgeCreateName = ''
    bridgeCreateMode = 'nat'
    bridgeCreateSubnet = ''
    bridgeCreateDhcp = true
    bridgeCreateDhcpStart = ''
    bridgeCreateDhcpEnd = ''
    bridgeCreateIpAddress = ''
    bridgeCreateVxlanRemote = ''
    bridgeCreateVni = 100
    bridgeCreating = false

    // VXLAN Tunnel Setup
    showVxlanDialog = false
    vxlanBridgeName = ''
    vxlanRemoteIp = ''
    vxlanVni = 100
    vxlanMethod: 'linux' | 'ovs' = 'linux'
    vxlanCreating = false
    vxlanError = ''

    // service profile dialog
    showServiceDialog = false
    serviceProfileId = ''
    serviceOverwrite = false
    serviceRegenConfigs = true
    readonly serviceProfiles = SERVICE_PROFILES

    // service endpoint stubs on canvas (free ports with configured vlanMode)
    nodeStubMap = new Map<string, { mode: 'access' | 'trunk'; label: string; count: number }>()

    // VLAN view overlay — color-coded links and VLAN labels
    showVlanView = false

    // BGP view overlay — ASN badges, color-coded links (eBGP/iBGP)
    showBgpView = false

    // Inventory management panels
    showInventoryPanel = false
    showAlarmPanel = false
    showEventRulesDialog = false
    showUpgradesDialog = false
    showCompliancePanel = false
    showEventRulesPanel = false
    showAutomationDashboard = false
    showWorkflowEditor = false
    showSchedulerPanel = false
    showChangeManager = false
    showBackendSettings = false
    backendUrl = 'http://localhost:4000'
    backendConnecting = false
    showConfigViewer = false
    configViewerContent = ''
    configViewerTitle = ''

    // poll-sync review dialog (for poll-all flow)
    showPollSyncDialog = false
    pollSyncProposals: PollSyncProposal[] = []
    pollSyncChecked: Record<string, Record<string, boolean>> = {}  // nodeId → changeKey → checked
    pollSyncExpanded: Record<string, boolean> = {}                 // nodeId → expanded

    // link mode (click-click and drag-to-connect)
    linkModeActive = false
    private _linkDragSourceId: string | null = null  // drag-to-connect source node
    private _shapeDragSourceId: string | null = null  // drag-to-connect source shape
    private _shapeDragAnchor: { x: number; y: number } | null = null  // anchor fractions (0–1)

    // link style: curved (default) or straight
    linkStyleCurved = true
    toggleLinkStyle (): void { this.linkStyleCurved = !this.linkStyleCurved; this.cdr.markForCheck() }

    // link bend drag handle
    private _dragLinkId: string | null = null
    private _dragLinkPerpX = 0   // perpendicular unit vector at drag start
    private _dragLinkPerpY = 0

    // link context menu
    ctxLinkId: string | null = null
    ctxLinkX = 0; ctxLinkY = 0

    // IPAM panel
    showIpam = false

    // Traffic flow visualization
    showTrafficFlowView = false
    showTrafficFlowPanel = false
    trafficFlows: TrafficFlow[] = []
    computedFlowPaths: ComputedFlowPath[] = []
    flowEditingId: string | null = null
    flowFormSource = ''
    flowFormDest = ''
    flowFormProtocol: 'TCP' | 'UDP' | 'ICMP' | 'Any' = 'Any'
    flowFormPort: number | null = null
    flowFormColor = '#3b82f6'
    flowFormName = ''

    // Failure simulation (design-time, does not affect link.status)
    private _simulatedFailedNodes = new Set<string>()
    private _simulatedFailedLinks = new Set<string>()

    // Health summary widget
    showHealthWidget = false

    // Bulk credential dialog
    showBulkCredDialog = false
    bulkCredVendor = ''
    bulkCredUsername = ''
    bulkCredPassword = ''
    bulkCredMgmtPrefix = ''

    // Route table view
    showRouteView = false
    liveRouteTable = new Map<string, ParsedRouteEntry[]>()
    routeFetching = false

    // Interface counters
    showCounterView = false
    liveInterfaceCounters = new Map<string, Map<string, ParsedInterfaceCounters>>()
    counterFetching = false

    // Dark / light theme toggle
    currentTheme: 'dark' | 'light' = 'dark'

    // Layout algorithm selection
    layoutAlgorithm: LayoutAlgorithm = 'force'

    // Syslog panel
    showSyslogPanel = false
    syslogMessages: { facility: string; severity: string; timestamp: string; hostname: string; message: string; sourceIp: string }[] = []
    syslogSeverityFilter: string = 'all'
    syslogRunning = false
    showSyslogVendorHints = false
    syslogTargetIp = '< this-host-ip >'
    private _syslogListenerActive = false

    // IPv6 labels
    showIpv6Labels = false

    // Help window (opened as separate Electron BrowserWindow via IPC)

    // annotations drag
    private _dragAnnotation: Annotation | null = null
    private _dragAnnOX = 0; private _dragAnnOY = 0
    editingAnnotationId: string | null = null
    editingAnnotationText = ''

    // link hover state
    hoveredLinkId: string | null = null

    // ── Snap guides (Figma-style alignment) ──────────────────────────────────
    snapGuides: Array<{ type: 'h' | 'v'; pos: number; from: number; to: number }> = []
    snapDistanceMarkers: Array<{ x: number; y: number; dist: number; horizontal: boolean }> = []
    private readonly _snapTolerance = 5
    dragGhostOrigin: { x: number; y: number } | null = null
    dragCoords: { x: number; y: number } | null = null

    // ── Undo/Redo toast notifications ────────────────────────────────────────
    toastMessage = ''
    toastVisible = false
    private _toastTimer: ReturnType<typeof setTimeout> | null = null

    // keyboard shortcuts overlay
    showShortcutsOverlay = false

    // ── Onboarding / Help system ─────────────────────────────────────────────
    showWelcomeDialog = false
    welcomeDontShowAgain = false
    showTour = false
    tourStep = 0
    showHelpPanel = false
    helpSearchQuery = ''
    helpActiveSection = 'getting-started'
    helpScrolledDown = false
    helpNoResultsSuggestions = ['getting started', 'links', 'shortcuts', 'templates', 'export']

    private _tourDemoIds: string[] = []
    tourDemoConnectors: Array<{ x: number; y: number }> = []

    readonly tourSteps: Array<{ selector: string; title: string; description: string; position: 'top' | 'bottom' | 'left' | 'right'; demo?: boolean | string }> = [
        { selector: '.netops-palette', title: 'Device Palette', description: 'Drag devices and shapes onto the canvas to build your network topology. Use the filter box to quickly find specific device types.', position: 'right' },
        { selector: '.netops-svg', title: 'Canvas', description: 'This is your workspace. Right-click anywhere on the canvas to access the context menu for adding shapes, notes, and images.', position: 'bottom' },
        { selector: '.netops-svg', title: 'Connect Shapes', description: 'Hover over a device edge to see a green dot. Drag from it to another device to create a link between them.', position: 'bottom', demo: true },
        { selector: '.netops-svg', title: 'Link Styling', description: 'Right-click any link to change its color, dash pattern, arrow style, and line weight.', position: 'bottom', demo: 'styling' },
        { selector: '.netops-svg', title: 'Link Labels', description: 'Double-click any link to add a text label. Click an existing label to edit it, or drag to reposition.', position: 'bottom', demo: 'labels' },
        { selector: '.netops-svg', title: 'Templates', description: 'Load pre-built topology templates instantly. Templates include Flowchart, 3-Tier Network, Cloud Architecture, and more. Click a template in the palette to apply it.', position: 'bottom', demo: 'template' },
        { selector: '.netops-svg', title: 'Build Custom Topology', description: 'Combine shapes, devices, links, labels, and images to build your own custom network diagram. Use snap guides for precise alignment.', position: 'bottom', demo: 'custom' },
        { selector: '.zoom-controls', title: 'Zoom Controls', description: 'Use these controls to zoom in/out, reset to 100%, or fit all elements in view. You can also scroll to zoom.', position: 'top' },
        { selector: '.canvas-minimap', title: 'Minimap', description: 'The minimap shows an overview of your entire topology. Click on it to navigate quickly.', position: 'top' },
        { selector: '.topbar-actions', title: 'Export & Tools', description: 'Save, undo/redo, toggle link mode, switch themes, and export your topology as SVG or PNG.', position: 'bottom' },
        { selector: '.topbar-actions', title: 'Keyboard Shortcuts', description: 'Press ? at any time to see all available keyboard shortcuts, or check the Help panel for the full list.', position: 'bottom' },
    ]

    readonly helpSections: Array<{ id: string; title: string; icon: string; content: string; subsections?: Array<{ title: string; content: string; _open?: boolean }> }> = [
        {
            id: 'whats-new', title: "What's New", icon: '✦', content: `
<div class="help-whats-new-cards">
  <div class="help-new-card"><span class="help-new-badge">New</span> <strong>Traffic Flow Visualization</strong> — Simulate and visualize traffic paths across your topology</div>
  <div class="help-new-card"><span class="help-new-badge">New</span> <strong>BGP Neighbor Table</strong> — View and manage BGP peering sessions per device</div>
  <div class="help-new-card"><span class="help-new-badge">New</span> <strong>Config Backup & Diff</strong> — Snapshot and compare device configurations over time</div>
</div>`
        },
        {
            id: 'common-tasks', title: 'Common Tasks', icon: '⚡', content: `
<div class="help-quickref">
  <div class="help-quickref-item"><span class="help-qr-icon">➕</span><div><strong>Add a device</strong><br><span class="help-muted">Drag from palette onto canvas</span></div></div>
  <div class="help-quickref-item"><span class="help-qr-icon">🔗</span><div><strong>Connect devices</strong><br><span class="help-muted">Hover edge → drag green dot</span></div></div>
  <div class="help-quickref-item"><span class="help-qr-icon">🏷</span><div><strong>Add a label</strong><br><span class="help-muted">Double-click any link</span></div></div>
  <div class="help-quickref-item"><span class="help-qr-icon">💾</span><div><strong>Save topology</strong><br><span class="help-muted"><kbd>Ctrl</kbd>+<kbd>S</kbd></span></div></div>
  <div class="help-quickref-item"><span class="help-qr-icon">📤</span><div><strong>Export image</strong><br><span class="help-muted">File → Export as PNG/SVG</span></div></div>
  <div class="help-quickref-item"><span class="help-qr-icon">📋</span><div><strong>Load a template</strong><br><span class="help-muted">File → Templates</span></div></div>
</div>`
        },
        {
            id: 'getting-started', title: 'Getting Started', icon: '🚀', content: `
<ol class="help-steps">
  <li><strong>Drag devices</strong> from the left palette onto the canvas</li>
  <li><strong>Connect them</strong> by hovering over a device edge and dragging the green dot to another device</li>
  <li><strong>Right-click</strong> the canvas or devices for context menus with more options</li>
  <li><strong>Style your links</strong> — right-click any link to change color, dashes, arrows</li>
  <li><strong>Save your work</strong> with <kbd>Ctrl</kbd>+<kbd>S</kbd></li>
</ol>
<div class="help-tryit">💡 <strong>Try it:</strong> Drag a Router from the palette and drop it on the canvas!</div>`,
            subsections: [
                { title: 'Canvas Navigation', content: `
<ul class="help-list">
  <li><strong>Pan</strong> — Click and drag the canvas background</li>
  <li><strong>Zoom</strong> — Scroll wheel or <kbd>Ctrl</kbd>+scroll</li>
  <li><strong>Fit to view</strong> — Click the fit button in zoom controls or press <kbd>Ctrl</kbd>+<kbd>0</kbd></li>
  <li><strong>Minimap</strong> — Click on the minimap to jump to that area</li>
</ul>` },
                { title: 'Selection', content: `
<ul class="help-list">
  <li><strong>Select one</strong> — Click on any device or link</li>
  <li><strong>Multi-select</strong> — Hold <kbd>Shift</kbd> and click additional items</li>
  <li><strong>Select all</strong> — <kbd>Ctrl</kbd>+<kbd>A</kbd></li>
  <li><strong>Deselect</strong> — Press <kbd>Escape</kbd> or click empty canvas</li>
</ul>` },
            ]
        },
        {
            id: 'shapes-drawing', title: 'Shapes & Drawing', icon: '⬡', content: `
<p class="help-desc">The palette on the left contains network devices and annotation shapes.</p>
<h4 class="help-h4">Network Devices</h4>
<p class="help-desc">Routers, switches, firewalls, servers, PCs, and more. Drag any device onto the canvas to place it.</p>
<h4 class="help-h4">Annotation Shapes</h4>
<p class="help-desc">Rectangles, circles, diamonds, stars, hexagons, clouds, arrows, and lines for diagrams.</p>
<div class="help-tryit">💡 <strong>Try it:</strong> Right-click the canvas → "Add Shape" to insert shapes directly!</div>`,
            subsections: [
                { title: 'Shape Operations', content: `
<ul class="help-list">
  <li><strong>Resize</strong> — Drag the corner handles of a selected shape</li>
  <li><strong>Recolor</strong> — Right-click a shape to change fill and border color</li>
  <li><strong>Layer order</strong> — Right-click → Bring to Front / Send to Back</li>
  <li><strong>Copy/Paste</strong> — <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd></li>
</ul>` },
            ]
        },
        {
            id: 'links-connections', title: 'Links & Connections', icon: '⤢', content: `
<ol class="help-steps">
  <li>Hover over a device edge until you see a <strong style="color: var(--success)">green connection dot</strong></li>
  <li>Click and drag from the dot to another device</li>
  <li>Release on the target device to create the link</li>
</ol>
<div class="help-svg-diagram">
  <svg viewBox="0 0 240 60" width="240" height="60">
    <rect x="10" y="15" width="60" height="30" rx="4" fill="var(--bg-hover)" stroke="var(--accent)" stroke-width="1.5"/>
    <text x="40" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-family="system-ui">Router A</text>
    <circle cx="70" cy="30" r="5" fill="#22c55e" stroke="#16a34a" stroke-width="1"/>
    <line x1="75" y1="30" x2="165" y2="30" stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 3"/>
    <polygon points="162,25 172,30 162,35" fill="var(--accent)"/>
    <rect x="170" y="15" width="60" height="30" rx="4" fill="var(--bg-hover)" stroke="var(--accent)" stroke-width="1.5"/>
    <text x="200" y="35" text-anchor="middle" fill="var(--text)" font-size="10" font-family="system-ui">Router B</text>
  </svg>
</div>
<p class="help-desc"><strong>Link Mode:</strong> Press <kbd>L</kbd> to enable rapid link creation mode — click source, then click target.</p>
<div class="help-tryit">💡 <strong>Try it:</strong> Add two routers and connect them with a link!</div>`
        },
        {
            id: 'labels-text', title: 'Labels & Text', icon: '✎', content: `
<ol class="help-steps">
  <li><strong>Double-click</strong> any link to add a text label</li>
  <li>Click an existing label to <strong>edit</strong> its text</li>
  <li>Drag labels to <strong>reposition</strong> them along the link</li>
</ol>
<div class="help-svg-diagram">
  <svg viewBox="0 0 240 60" width="240" height="60">
    <rect x="5" y="18" width="50" height="24" rx="3" fill="var(--bg-hover)" stroke="var(--border)" stroke-width="1"/>
    <text x="30" y="34" text-anchor="middle" fill="var(--text)" font-size="9" font-family="system-ui">SW-1</text>
    <line x1="55" y1="30" x2="185" y2="30" stroke="var(--accent)" stroke-width="1.5"/>
    <rect x="90" y="12" width="60" height="18" rx="3" fill="var(--accent-12)" stroke="var(--accent)" stroke-width="1"/>
    <text x="120" y="25" text-anchor="middle" fill="var(--accent-bright)" font-size="9" font-family="system-ui">10.0.0.1/30</text>
    <rect x="90" y="34" width="60" height="14" rx="2" fill="none" stroke="var(--text-muted)" stroke-width="0.5" stroke-dasharray="2 2"/>
    <text x="120" y="44" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-family="system-ui">eth0 ↔ eth1</text>
    <rect x="185" y="18" width="50" height="24" rx="3" fill="var(--bg-hover)" stroke="var(--border)" stroke-width="1"/>
    <text x="210" y="34" text-anchor="middle" fill="var(--text)" font-size="9" font-family="system-ui">SW-2</text>
  </svg>
</div>
<p class="help-desc">Toggle IP and interface labels from the <strong>View</strong> menu.</p>`
        },
        {
            id: 'styling-colors', title: 'Styling & Colors', icon: '🎨', content: `
<p class="help-desc">Right-click a link to access styling options:</p>
<ul class="help-list">
  <li>🎨 <strong>Colors</strong> — Choose from preset colors or use custom hex</li>
  <li>┄ <strong>Dash patterns</strong> — Solid, dashed, or dotted lines</li>
  <li>→ <strong>Arrows</strong> — None, forward, reverse, or bidirectional</li>
  <li>━ <strong>Line weight</strong> — Thin, normal, or thick</li>
</ul>
<div class="help-svg-diagram">
  <svg viewBox="0 0 240 80" width="240" height="80">
    <line x1="20" y1="15" x2="220" y2="15" stroke="#3b82f6" stroke-width="2"/>
    <text x="120" y="12" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-family="system-ui">Solid blue</text>
    <line x1="20" y1="35" x2="220" y2="35" stroke="#ef4444" stroke-width="2" stroke-dasharray="8 4"/>
    <text x="120" y="32" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-family="system-ui">Dashed red</text>
    <line x1="20" y1="55" x2="220" y2="55" stroke="#22c55e" stroke-width="3"/>
    <polygon points="217,50 227,55 217,60" fill="#22c55e"/>
    <text x="120" y="52" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-family="system-ui">Thick green + arrow</text>
    <line x1="20" y1="75" x2="220" y2="75" stroke="#a855f7" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="120" y="72" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-family="system-ui">Dotted purple</text>
  </svg>
</div>
<p class="help-desc">Use the <strong>theme toggle</strong> in the toolbar to switch between dark and light modes.</p>`
        },
        {
            id: 'templates', title: 'Templates', icon: '▤', content: `
<p class="help-desc">Load pre-built network topology templates instantly:</p>
<div class="help-template-chips">
  <span class="help-chip">↔ Point-to-Point</span>
  <span class="help-chip">✦ Hub & Spoke</span>
  <span class="help-chip">△ Three-Tier LAN</span>
  <span class="help-chip">○ Ring</span>
  <span class="help-chip">◆ Full Mesh</span>
  <span class="help-chip">🛡 DMZ / Perimeter</span>
  <span class="help-chip">🏗 Spine-Leaf</span>
  <span class="help-chip">☸ K8s Fabric</span>
</div>
<p class="help-desc">Access templates from <strong>File → Templates</strong> or the Templates section in the palette.</p>
<div class="help-tryit">💡 <strong>Try it:</strong> Click "Load Template" below to try a pre-built topology!</div>`
        },
        {
            id: 'import-export', title: 'Import & Export', icon: '⤓', content: `
<h4 class="help-h4">Export Formats</h4>
<ul class="help-list">
  <li>📐 <strong>SVG</strong> — Scalable vector graphics (best for documentation)</li>
  <li>🖼 <strong>PNG</strong> — Raster image (best for presentations)</li>
  <li>📄 <strong>JSON</strong> — Topology data (best for sharing/backup)</li>
</ul>
<h4 class="help-h4">Import</h4>
<ul class="help-list">
  <li>Use <strong>File → Open</strong> or <kbd>Ctrl</kbd>+<kbd>O</kbd> to load a topology JSON</li>
  <li><strong>Drag & drop</strong> images (PNG, JPG, SVG, GIF) onto the canvas to embed them</li>
  <li><strong>Drag & drop</strong> a <code>.json</code> file onto the canvas to import a topology</li>
</ul>`
        },
        {
            id: 'keyboard-shortcuts', title: 'Keyboard Shortcuts', icon: '⌨', content: `
<div class="help-shortcut-grid">
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>Ctrl</kbd>+<kbd>S</kbd></span><span>Save topology</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>Ctrl</kbd>+<kbd>O</kbd></span><span>Open topology</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>Ctrl</kbd>+<kbd>Z</kbd></span><span>Undo</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></span><span>Redo</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd></span><span>Copy / Paste</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>Ctrl</kbd>+<kbd>A</kbd></span><span>Select all</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>Ctrl</kbd>+<kbd>F</kbd></span><span>Search</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>Delete</kbd></span><span>Remove selected</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>L</kbd></span><span>Toggle Link Mode</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>Escape</kbd></span><span>Cancel / Deselect</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>?</kbd></span><span>Shortcuts panel</span></div>
  <div class="help-sc-row"><span class="help-sc-keys"><kbd>F1</kbd></span><span>Help panel</span></div>
</div>`
        },
        {
            id: 'tips-tricks', title: 'Tips & Tricks', icon: '💡', content: `
<ul class="help-list">
  <li>Hold <kbd>Shift</kbd> and click to <strong>select multiple</strong> devices</li>
  <li>Use <kbd>Ctrl</kbd>+scroll to <strong>zoom</strong> precisely</li>
  <li>Drag the canvas background to <strong>pan</strong> around</li>
  <li>Use the <strong>minimap</strong> for quick navigation on large topologies</li>
  <li>The <strong>grid</strong> can be toggled and resized from the View menu</li>
  <li>Multi-select shapes and use the <strong>alignment toolbar</strong> to arrange them</li>
  <li>Use <strong>snap guides</strong> (pink lines) to align shapes precisely</li>
  <li><strong>Drag & drop</strong> images from your file manager directly onto the canvas</li>
</ul>
<div class="help-tryit">💡 <strong>Try it:</strong> Hold Shift and click two devices to multi-select them!</div>`
        },
        {
            id: 'troubleshooting', title: 'Troubleshooting', icon: '🔧', content: `
<div class="help-faq">
  <div class="help-faq-item">
    <h4 class="help-h4">Links won't connect</h4>
    <p class="help-desc">Make sure you're dragging from the green dot on the device edge to another device. The target device must have available ports.</p>
  </div>
  <div class="help-faq-item">
    <h4 class="help-h4">Canvas feels slow</h4>
    <p class="help-desc">Try hiding the grid (View → Toggle Grid) and minimap. Large topologies with many links can be resource-intensive.</p>
  </div>
  <div class="help-faq-item">
    <h4 class="help-h4">Export looks different than canvas</h4>
    <p class="help-desc">PNG export captures the visible viewport. Use "Fit to View" (<kbd>Ctrl</kbd>+<kbd>0</kbd>) before exporting to include all elements.</p>
  </div>
  <div class="help-faq-item">
    <h4 class="help-h4">Lost my work</h4>
    <p class="help-desc">Use <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo recent changes. Save frequently with <kbd>Ctrl</kbd>+<kbd>S</kbd>.</p>
  </div>
</div>`
        },
    ]

    readonly welcomeFeatures = [
        { icon: '⬡', title: 'Draw Shapes', desc: 'Rectangles, circles, diamonds, and more' },
        { icon: '⤢', title: 'Connect Shapes', desc: 'Drag from edges to create links' },
        { icon: '🎨', title: 'Style Links', desc: 'Arrows, colors, dashes, weight' },
        { icon: '✎', title: 'Add Labels', desc: 'Double-click links to label them' },
        { icon: '🖼', title: 'Import Images', desc: 'Drag & drop PNG, JPG, SVG, GIF' },
        { icon: '▤', title: 'Use Templates', desc: 'Pre-built network diagrams' },
        { icon: '⤓', title: 'Export', desc: 'SVG, PNG, and JSON formats' },
        { icon: '⌨', title: 'Shortcuts', desc: 'Press ? for keyboard shortcuts' },
    ]

    // canvas context menu
    ctxCanvasOpen = false
    ctxCanvasX = 0
    ctxCanvasY = 0
    private _ctxCanvasSvgPt: { x: number; y: number } = { x: 0, y: 0 }

    onCanvasRightClick (ev: MouseEvent): void {
        // Only show if clicking on empty canvas (not on a node/link/shape)
        const target = ev.target as HTMLElement
        if (target.closest('.node-group, .link-group, .shape-group, .ctx-menu')) { return }
        ev.preventDefault()
        const pos = this._ctxPos(ev, 200, 550)
        this.ctxCanvasX = pos.x
        this.ctxCanvasY = pos.y
        this._ctxCanvasSvgPt = this.svgPt(ev)
        this.ctxCanvasOpen = true
        this.cdr.markForCheck()
    }

    closeCanvasCtx (): void {
        this.ctxCanvasOpen = false
        this.cdr.markForCheck()
    }

    addShapeAt (type: string): void {
        const pt = this._ctxCanvasSvgPt
        const sizes: Record<string, [number, number]> = {
            circle: [100, 100], diamond: [100, 100], star: [100, 100], hexagon: [100, 100],
            cylinder: [100, 70], cloud: [140, 90], 'arrow-right': [120, 60], 'arrow-double': [140, 60], 'line-h': [120, 10],
        }
        const [w, h] = sizes[type] ?? [120, 80]
        const shape = this.svc.addShape(type as any, pt.x - w / 2, pt.y - h / 2, w, h)
        this.selectedShapeId = shape.id
        this.statusMsg = `Added ${type}`
        this.ctxCanvasOpen = false
        this.cdr.markForCheck()
    }

    addTextAnnotationAt (): void {
        const pt = this._ctxCanvasSvgPt
        this.svc.addAnnotation(pt.x, pt.y)
        this.statusMsg = 'Added note'
        this.ctxCanvasOpen = false
        this.cdr.markForCheck()
    }

    // ── Image import ─────────────────────────────────────────────────────────

    /** Pending SVG position for image insert (set by context-menu or defaults to center) */
    private _imageInsertPt: { x: number; y: number } | null = null

    /** Context menu "Insert Image…" */
    insertImageAt (): void {
        this._imageInsertPt = { ...this._ctxCanvasSvgPt }
        this.ctxCanvasOpen = false
        this._triggerImageFilePicker()
    }

    /** File menu "Insert Image…" */
    insertImageFromMenu (): void {
        this._imageInsertPt = null // will default to viewport center
        this._triggerImageFilePicker()
    }

    /** Palette "Image" item */
    insertImageFromPalette (): void {
        this._imageInsertPt = null
        this._triggerImageFilePicker()
    }

    private _triggerImageFilePicker (): void {
        const input = document.getElementById('imageFileInput') as HTMLInputElement | null
        if (input) {
            input.value = '' // reset so same file can be re-selected
            input.click()
        }
    }

    onImageFileInput (ev: Event): void {
        const file = (ev.target as HTMLInputElement)?.files?.[0]
        if (!file) { return }
        this._loadImageFile(file, this._imageInsertPt)
        this._imageInsertPt = null
    }

    /** Read an image file, convert to base64 data URL, and add as annotation */
    private _loadImageFile (file: File, pt?: { x: number; y: number } | null): void {
        const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif']
        if (!validTypes.includes(file.type)) {
            this.statusMsg = 'Unsupported image format. Use PNG, JPG, SVG, or GIF.'
            this.cdr.markForCheck()
            return
        }
        // Limit file size to 5 MB
        if (file.size > 5 * 1024 * 1024) {
            this.statusMsg = 'Image too large (max 5 MB)'
            this.cdr.markForCheck()
            return
        }
        const reader = new FileReader()
        reader.onload = () => {
            const dataUrl = reader.result as string
            // Determine natural dimensions and cap at 400px
            const img = new Image()
            img.onload = () => {
                let w = img.naturalWidth || 200
                let h = img.naturalHeight || 200
                const maxDim = 400
                if (w > maxDim || h > maxDim) {
                    const scale = maxDim / Math.max(w, h)
                    w = Math.round(w * scale)
                    h = Math.round(h * scale)
                }
                // Default position: viewport center
                const insertPt = pt ?? this._viewportCenter()
                const ann = this.svc.addImageAnnotation(insertPt.x - w / 2, insertPt.y - h / 2, dataUrl, w, h)
                this.selectedShapeId = ann.id
                this.statusMsg = 'Inserted image'
                this.cdr.markForCheck()
            }
            img.onerror = () => {
                this.statusMsg = 'Failed to load image'
                this.cdr.markForCheck()
            }
            img.src = dataUrl
        }
        reader.readAsDataURL(file)
    }

    /** Returns the center of the current viewport in SVG coords */
    private _viewportCenter (): { x: number; y: number } {
        const svg = this.svgRef?.nativeElement
        if (!svg) { return { x: 200, y: 200 } }
        const r = svg.getBoundingClientRect()
        return {
            x: (r.width / 2 - this.vpX) / this.vpScale,
            y: (r.height / 2 - this.vpY) / this.vpScale,
        }
    }

    /** Handle image paste from clipboard (Ctrl+V) */
    private _handleClipboardImagePaste (ev: ClipboardEvent): boolean {
        const items = ev.clipboardData?.items
        if (!items) { return false }
        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile()
                if (file) {
                    ev.preventDefault()
                    this._loadImageFile(file, null)
                    return true
                }
            }
        }
        return false
    }

    clearCanvas (): void {
        if (!confirm('Clear entire canvas? This will remove all nodes, links, shapes, and annotations.')) { return }
        this.svc.clearTopology()
        this.selectedShapeId = null
        this.selectedShapeIds.clear()
        this.selectedNodeIds.clear()
        this.selectedLinkIds.clear()
        this.ctxCanvasOpen = false
        this.statusMsg = 'Canvas cleared'
        this.cdr.markForCheck()
    }

    // palette collapse/resize/filter state
    paletteCollapsed = false
    paletteWidth = 160
    paletteFilter = ''
    hoveredTemplate: string | null = null

    get filteredNodeTypes (): string[] {
        if (!this.paletteFilter) { return this.nodeTypes }
        const q = this.paletteFilter.toLowerCase()
        return this.nodeTypes.filter((t: string) => this.meta[t]?.label?.toLowerCase().includes(q))
    }

    readonly allShapes = [
        { type: 'rectangle', icon: '▭', label: 'Rectangle' },
        { type: 'circle', icon: '●', label: 'Circle' },
        { type: 'diamond', icon: '◆', label: 'Diamond' },
        { type: 'triangle', icon: '▲', label: 'Triangle' },
        { type: 'star', icon: '★', label: 'Star' },
        { type: 'hexagon', icon: '⬡', label: 'Hexagon' },
        { type: 'parallelogram', icon: '▱', label: 'Parallelogram' },
        { type: 'cylinder', icon: '⊖', label: 'Cylinder / DB' },
        { type: 'cloud', icon: '☁', label: 'Cloud' },
        { type: 'arrow-right', icon: '➤', label: 'Arrow (Single)' },
        { type: 'arrow-double', icon: '⟺', label: 'Arrow (Double)' },
        { type: 'line-h', icon: '─', label: 'Line' },
    ]

    get filteredShapes (): { type: string; icon: string; label: string }[] {
        if (!this.paletteFilter) { return this.allShapes }
        const q = this.paletteFilter.toLowerCase()
        return this.allShapes.filter(s => s.label.toLowerCase().includes(q))
    }

    get filteredTemplates (): any[] {
        if (!this.paletteFilter) { return this.shapeTemplates }
        const q = this.paletteFilter.toLowerCase()
        return this.shapeTemplates.filter((t: any) => t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q))
    }
    paletteDevicesOpen = true
    paletteShapesOpen = true
    paletteTemplatesOpen = false
    _paletteResizing = false
    private _paletteResizeStartX = 0
    private _paletteResizeStartW = 0

    onPaletteResizeStart (ev: MouseEvent): void {
        ev.preventDefault()
        this._paletteResizing = true
        this._paletteResizeStartX = ev.clientX
        this._paletteResizeStartW = this.paletteWidth

        const onMove = (e: MouseEvent) => {
            const dx = e.clientX - this._paletteResizeStartX
            this.paletteWidth = Math.max(80, Math.min(280, this._paletteResizeStartW + dx))
            this.cdr.markForCheck()
        }
        const onUp = () => {
            this._paletteResizing = false
            this.cdr.markForCheck()
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
    }

    // readymade shape diagram templates
    shapeTemplates = [
        { id: 'flowchart', name: 'Flowchart', icon: '🔀',
          desc: 'Start → Process → Decision → End' },
        { id: 'network-3tier', name: '3-Tier Network', icon: '🏢',
          desc: 'Core → Distribution → Access layers' },
        { id: 'cloud-arch', name: 'Cloud Architecture', icon: '☁',
          desc: 'Users → LB → App → DB with firewall' },
        { id: 'decision-tree', name: 'Decision Tree', icon: '🌳',
          desc: 'Diamond decisions with outcomes' },
        { id: 'pipeline', name: 'CI/CD Pipeline', icon: '🚀',
          desc: 'Build → Test → Stage → Deploy' },
        { id: 'hub-spoke', name: 'Hub & Spoke', icon: '🕸',
          desc: 'Central hub with satellite nodes' },
        { id: 'org-chart', name: 'Org Chart', icon: '👥',
          desc: 'CEO → VPs → Managers hierarchy' },
        { id: 'swimlane', name: 'Swimlane', icon: '🏊',
          desc: '3 vertical lanes with process steps' },
        { id: 'er-diagram', name: 'ER Diagram', icon: '🗃',
          desc: 'User → Order → Product entities' },
        { id: 'mind-map', name: 'Mind Map', icon: '🧠',
          desc: 'Central idea with branching topics' },
        { id: 'sequence', name: 'Sequence Diagram', icon: '↕',
          desc: 'Client → Server → DB interactions' },
        { id: 'infra-diagram', name: 'Infrastructure', icon: '🖥',
          desc: 'Internet → FW → DMZ → LAN → DB' },
    ]

    applyShapeTemplate (id: string): void {
        const shapes: { type: string; x: number; y: number; w: number; h: number; label: string; fill?: string; stroke?: string }[] = []
        const links: { src: number; tgt: number; srcAx?: number; srcAy?: number; tgtAx?: number; tgtAy?: number; label?: string }[] = []

        const cx = (-this.vpX + 400) / this.vpScale
        const cy = (-this.vpY + 300) / this.vpScale

        switch (id) {
            case 'flowchart':
                shapes.push(
                    { type: 'circle', x: cx, y: cy, w: 80, h: 80, label: 'Start', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx - 20, y: cy + 120, w: 120, h: 60, label: 'Process 1' },
                    { type: 'diamond', x: cx - 20, y: cy + 230, w: 120, h: 100, label: 'Decision?', fill: '#713f12', stroke: '#f59e0b' },
                    { type: 'rectangle', x: cx - 20, y: cy + 380, w: 120, h: 60, label: 'Process 2' },
                    { type: 'rectangle', x: cx + 160, y: cy + 255, w: 120, h: 60, label: 'Alt Path', fill: '#1e1b4b', stroke: '#8b5cf6' },
                    { type: 'circle', x: cx, y: cy + 490, w: 80, h: 80, label: 'End', fill: '#7f1d1d', stroke: '#ef4444' },
                )
                links.push(
                    { src: 0, tgt: 1, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 1, tgt: 2, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 2, tgt: 3, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0, label: 'Yes' },
                    { src: 2, tgt: 4, srcAx: 1, srcAy: 0.5, tgtAx: 0, tgtAy: 0.5, label: 'No' },
                    { src: 3, tgt: 5, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 4, tgt: 3, srcAx: 0.5, srcAy: 1, tgtAx: 1, tgtAy: 0.5 },
                )
                break
            case 'network-3tier':
                shapes.push(
                    { type: 'rectangle', x: cx, y: cy, w: 200, h: 60, label: 'Core Layer', fill: '#7f1d1d', stroke: '#ef4444' },
                    { type: 'rectangle', x: cx - 80, y: cy + 120, w: 150, h: 50, label: 'Distribution A', fill: '#713f12', stroke: '#f59e0b' },
                    { type: 'rectangle', x: cx + 130, y: cy + 120, w: 150, h: 50, label: 'Distribution B', fill: '#713f12', stroke: '#f59e0b' },
                    { type: 'rectangle', x: cx - 140, y: cy + 240, w: 120, h: 40, label: 'Access 1', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx - 0, y: cy + 240, w: 120, h: 40, label: 'Access 2', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx + 140, y: cy + 240, w: 120, h: 40, label: 'Access 3', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx + 280, y: cy + 240, w: 120, h: 40, label: 'Access 4', fill: '#065f46', stroke: '#10b981' },
                )
                links.push(
                    { src: 0, tgt: 1, srcAx: 0.25, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 0, tgt: 2, srcAx: 0.75, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 1, tgt: 3, srcAx: 0.25, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 1, tgt: 4, srcAx: 0.75, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 2, tgt: 5, srcAx: 0.25, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 2, tgt: 6, srcAx: 0.75, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                )
                break
            case 'cloud-arch':
                shapes.push(
                    { type: 'circle', x: cx, y: cy, w: 100, h: 80, label: 'Users', fill: '#1e1b4b', stroke: '#8b5cf6' },
                    { type: 'triangle', x: cx - 10, y: cy + 120, w: 120, h: 60, label: 'Firewall', fill: '#7f1d1d', stroke: '#ef4444' },
                    { type: 'rectangle', x: cx - 10, y: cy + 220, w: 120, h: 50, label: 'Load Balancer', fill: '#0c4a6e', stroke: '#0ea5e9' },
                    { type: 'rectangle', x: cx - 100, y: cy + 320, w: 100, h: 50, label: 'App Server 1' },
                    { type: 'rectangle', x: cx + 100, y: cy + 320, w: 100, h: 50, label: 'App Server 2' },
                    { type: 'circle', x: cx, y: cy + 430, w: 100, h: 80, label: 'Database', fill: '#065f46', stroke: '#10b981' },
                )
                links.push(
                    { src: 0, tgt: 1, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 1, tgt: 2, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 2, tgt: 3, srcAx: 0.25, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 2, tgt: 4, srcAx: 0.75, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 3, tgt: 5, srcAx: 0.5, srcAy: 1, tgtAx: 0.25, tgtAy: 0 },
                    { src: 4, tgt: 5, srcAx: 0.5, srcAy: 1, tgtAx: 0.75, tgtAy: 0 },
                )
                break
            case 'decision-tree':
                shapes.push(
                    { type: 'diamond', x: cx, y: cy, w: 120, h: 100, label: 'Start?', fill: '#713f12', stroke: '#f59e0b' },
                    { type: 'diamond', x: cx - 140, y: cy + 150, w: 120, h: 100, label: 'Option A?', fill: '#0c4a6e', stroke: '#0ea5e9' },
                    { type: 'diamond', x: cx + 140, y: cy + 150, w: 120, h: 100, label: 'Option B?', fill: '#1e1b4b', stroke: '#8b5cf6' },
                    { type: 'rectangle', x: cx - 200, y: cy + 310, w: 100, h: 50, label: 'Result 1', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx - 80, y: cy + 310, w: 100, h: 50, label: 'Result 2', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx + 80, y: cy + 310, w: 100, h: 50, label: 'Result 3', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx + 200, y: cy + 310, w: 100, h: 50, label: 'Result 4', fill: '#065f46', stroke: '#10b981' },
                )
                links.push(
                    { src: 0, tgt: 1, srcAx: 0, srcAy: 0.5, tgtAx: 0.5, tgtAy: 0, label: 'Yes' },
                    { src: 0, tgt: 2, srcAx: 1, srcAy: 0.5, tgtAx: 0.5, tgtAy: 0, label: 'No' },
                    { src: 1, tgt: 3, srcAx: 0, srcAy: 0.5, tgtAx: 0.5, tgtAy: 0, label: 'Yes' },
                    { src: 1, tgt: 4, srcAx: 1, srcAy: 0.5, tgtAx: 0.5, tgtAy: 0, label: 'No' },
                    { src: 2, tgt: 5, srcAx: 0, srcAy: 0.5, tgtAx: 0.5, tgtAy: 0, label: 'Yes' },
                    { src: 2, tgt: 6, srcAx: 1, srcAy: 0.5, tgtAx: 0.5, tgtAy: 0, label: 'No' },
                )
                break
            case 'pipeline':
                const stages = ['Build', 'Test', 'Stage', 'Deploy']
                const colors = [
                    { fill: '#0c4a6e', stroke: '#0ea5e9' },
                    { fill: '#713f12', stroke: '#f59e0b' },
                    { fill: '#1e1b4b', stroke: '#8b5cf6' },
                    { fill: '#065f46', stroke: '#10b981' },
                ]
                for (let i = 0; i < 4; i++) {
                    shapes.push({ type: 'rectangle', x: cx + i * 160, y: cy, w: 120, h: 60, label: stages[i], ...colors[i] })
                }
                for (let i = 0; i < 3; i++) {
                    links.push({ src: i, tgt: i + 1, srcAx: 1, srcAy: 0.5, tgtAx: 0, tgtAy: 0.5 })
                }
                break
            case 'hub-spoke':
                shapes.push({ type: 'circle', x: cx, y: cy, w: 120, h: 120, label: 'Hub', fill: '#7f1d1d', stroke: '#ef4444' })
                const hn = 6, hr = 180
                for (let i = 0; i < hn; i++) {
                    const angle = (i / hn) * Math.PI * 2 - Math.PI / 2
                    shapes.push({
                        type: 'rectangle',
                        x: cx + 20 + Math.cos(angle) * hr, y: cy + 20 + Math.sin(angle) * hr,
                        w: 80, h: 50, label: `Node ${i + 1}`,
                    })
                    links.push({ src: 0, tgt: i + 1 })
                }
                break

            case 'org-chart':
                shapes.push(
                    { type: 'rectangle', x: cx + 40, y: cy, w: 140, h: 50, label: 'CEO', fill: '#7f1d1d', stroke: '#ef4444' },
                    { type: 'rectangle', x: cx - 60, y: cy + 100, w: 120, h: 45, label: 'VP Engineering', fill: '#0c4a6e', stroke: '#0ea5e9' },
                    { type: 'rectangle', x: cx + 100, y: cy + 100, w: 120, h: 45, label: 'VP Sales', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx - 120, y: cy + 200, w: 100, h: 40, label: 'Team Lead A' },
                    { type: 'rectangle', x: cx, y: cy + 200, w: 100, h: 40, label: 'Team Lead B' },
                    { type: 'rectangle', x: cx + 60, y: cy + 200, w: 100, h: 40, label: 'Sales Rep 1' },
                    { type: 'rectangle', x: cx + 180, y: cy + 200, w: 100, h: 40, label: 'Sales Rep 2' },
                )
                links.push(
                    { src: 0, tgt: 1, srcAx: 0.3, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 0, tgt: 2, srcAx: 0.7, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 1, tgt: 3, srcAx: 0.3, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 1, tgt: 4, srcAx: 0.7, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 2, tgt: 5, srcAx: 0.3, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 2, tgt: 6, srcAx: 0.7, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                )
                break

            case 'swimlane':
                // 3 lanes
                shapes.push(
                    { type: 'rectangle', x: cx - 60, y: cy - 20, w: 120, h: 380, label: '', fill: 'rgba(59,130,246,0.1)', stroke: '#3b82f6' },
                    { type: 'rectangle', x: cx + 80, y: cy - 20, w: 120, h: 380, label: '', fill: 'rgba(34,197,94,0.1)', stroke: '#10b981' },
                    { type: 'rectangle', x: cx + 220, y: cy - 20, w: 120, h: 380, label: '', fill: 'rgba(168,85,247,0.1)', stroke: '#8b5cf6' },
                )
                // Lane headers
                shapes.push(
                    { type: 'rectangle', x: cx - 40, y: cy, w: 80, h: 30, label: 'Design', fill: '#0c4a6e', stroke: '#0ea5e9' },
                    { type: 'rectangle', x: cx + 100, y: cy, w: 80, h: 30, label: 'Develop', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx + 240, y: cy, w: 80, h: 30, label: 'Review', fill: '#1e1b4b', stroke: '#8b5cf6' },
                )
                // Steps
                shapes.push(
                    { type: 'rectangle', x: cx - 40, y: cy + 60, w: 80, h: 35, label: 'Wireframe' },
                    { type: 'rectangle', x: cx + 100, y: cy + 130, w: 80, h: 35, label: 'Code' },
                    { type: 'rectangle', x: cx + 240, y: cy + 200, w: 80, h: 35, label: 'PR Review' },
                    { type: 'rectangle', x: cx + 100, y: cy + 280, w: 80, h: 35, label: 'Deploy' },
                )
                links.push(
                    { src: 6, tgt: 7, srcAx: 1, srcAy: 0.5, tgtAx: 0, tgtAy: 0.5 },
                    { src: 7, tgt: 8, srcAx: 1, srcAy: 0.5, tgtAx: 0, tgtAy: 0.5 },
                    { src: 8, tgt: 9, srcAx: 0, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                )
                break

            case 'er-diagram':
                shapes.push(
                    { type: 'rectangle', x: cx - 60, y: cy, w: 120, h: 80, label: 'User\nid, name, email', fill: '#0c4a6e', stroke: '#0ea5e9' },
                    { type: 'rectangle', x: cx + 140, y: cy, w: 120, h: 80, label: 'Order\nid, date, total', fill: '#065f46', stroke: '#10b981' },
                    { type: 'rectangle', x: cx + 340, y: cy, w: 120, h: 80, label: 'Product\nid, name, price', fill: '#713f12', stroke: '#f59e0b' },
                    { type: 'diamond', x: cx + 40, y: cy + 130, w: 80, h: 60, label: 'places', fill: '#1e1b4b', stroke: '#8b5cf6' },
                    { type: 'diamond', x: cx + 240, y: cy + 130, w: 80, h: 60, label: 'contains', fill: '#1e1b4b', stroke: '#8b5cf6' },
                )
                links.push(
                    { src: 0, tgt: 3, srcAx: 0.5, srcAy: 1, tgtAx: 0, tgtAy: 0.5, label: '1' },
                    { src: 3, tgt: 1, srcAx: 1, srcAy: 0.5, tgtAx: 0.5, tgtAy: 1, label: 'N' },
                    { src: 1, tgt: 4, srcAx: 0.5, srcAy: 1, tgtAx: 0, tgtAy: 0.5, label: '1' },
                    { src: 4, tgt: 2, srcAx: 1, srcAy: 0.5, tgtAx: 0.5, tgtAy: 1, label: 'N' },
                )
                break

            case 'mind-map':
                shapes.push(
                    { type: 'circle', x: cx, y: cy, w: 120, h: 100, label: 'Main Idea', fill: '#7f1d1d', stroke: '#ef4444' },
                )
                const topics = ['Topic A', 'Topic B', 'Topic C', 'Topic D']
                const tColors = [
                    { fill: '#0c4a6e', stroke: '#0ea5e9' }, { fill: '#065f46', stroke: '#10b981' },
                    { fill: '#713f12', stroke: '#f59e0b' }, { fill: '#1e1b4b', stroke: '#8b5cf6' },
                ]
                const subTopics = [['Sub 1', 'Sub 2'], ['Sub 3', 'Sub 4'], ['Sub 5', 'Sub 6'], ['Sub 7', 'Sub 8']]
                for (let i = 0; i < 4; i++) {
                    const a = (i / 4) * Math.PI * 2 - Math.PI / 2
                    const tx = cx + 30 + Math.cos(a) * 160, ty = cy + 20 + Math.sin(a) * 130
                    shapes.push({ type: 'rectangle', x: tx, y: ty, w: 100, h: 40, label: topics[i], ...tColors[i] })
                    links.push({ src: 0, tgt: shapes.length - 1 })
                    for (let j = 0; j < 2; j++) {
                        const sa = a + (j === 0 ? -0.4 : 0.4)
                        shapes.push({ type: 'rectangle', x: tx + Math.cos(sa) * 100, y: ty + Math.sin(sa) * 60, w: 80, h: 30, label: subTopics[i][j] })
                        links.push({ src: shapes.length - 2 - j, tgt: shapes.length - 1 })
                    }
                }
                break

            case 'sequence':
                const actors = ['Client', 'API Server', 'Database']
                const aColors2 = [
                    { fill: '#0c4a6e', stroke: '#0ea5e9' }, { fill: '#065f46', stroke: '#10b981' }, { fill: '#713f12', stroke: '#f59e0b' },
                ]
                for (let i = 0; i < 3; i++) {
                    shapes.push({ type: 'rectangle', x: cx + i * 180, y: cy, w: 100, h: 40, label: actors[i], ...aColors2[i] })
                    // Lifeline
                    shapes.push({ type: 'line-h', x: cx + i * 180 + 48, y: cy + 40, w: 4, h: 280, label: '' })
                }
                // Messages as labeled links
                links.push(
                    { src: 0, tgt: 2, srcAx: 1, srcAy: 0.5, tgtAx: 0, tgtAy: 0.5, label: 'GET /api' },
                    { src: 2, tgt: 4, srcAx: 1, srcAy: 0.5, tgtAx: 0, tgtAy: 0.5, label: 'SELECT *' },
                )
                break

            case 'infra-diagram':
                shapes.push(
                    { type: 'cloud', x: cx + 20, y: cy, w: 140, h: 80, label: 'Internet', fill: '#1e1b4b', stroke: '#8b5cf6' },
                    { type: 'triangle', x: cx + 40, y: cy + 120, w: 100, h: 60, label: 'Firewall', fill: '#7f1d1d', stroke: '#ef4444' },
                    { type: 'rectangle', x: cx - 20, y: cy + 220, w: 220, h: 50, label: 'DMZ (Web Servers)', fill: '#0c4a6e', stroke: '#0ea5e9' },
                    { type: 'triangle', x: cx + 40, y: cy + 310, w: 100, h: 60, label: 'Firewall 2', fill: '#7f1d1d', stroke: '#ef4444' },
                    { type: 'rectangle', x: cx - 20, y: cy + 410, w: 220, h: 50, label: 'LAN (App Servers)', fill: '#065f46', stroke: '#10b981' },
                    { type: 'cylinder', x: cx + 30, y: cy + 500, w: 120, h: 70, label: 'Database', fill: '#713f12', stroke: '#f59e0b' },
                )
                links.push(
                    { src: 0, tgt: 1, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 1, tgt: 2, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 2, tgt: 3, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 3, tgt: 4, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                    { src: 4, tgt: 5, srcAx: 0.5, srcAy: 1, tgtAx: 0.5, tgtAy: 0 },
                )
                break
        }

        // Create shapes
        const annIds: string[] = []
        for (const s of shapes) {
            const ann = this.svc.addShape(s.type as any, s.x, s.y, s.w, s.h)
            if (s.fill) { this.svc.updateAnnotation(ann.id, { fillColor: s.fill, strokeColor: s.stroke, label: s.label, text: s.label }) }
            else { this.svc.updateAnnotation(ann.id, { label: s.label, text: s.label }) }
            annIds.push(ann.id)
        }

        // Create links
        for (const l of links) {
            const newLink = this.svc.addShapeLink({
                sourceAnnotationId: annIds[l.src],
                targetAnnotationId: annIds[l.tgt],
                sourceAnchorX: l.srcAx, sourceAnchorY: l.srcAy,
                targetAnchorX: l.tgtAx, targetAnchorY: l.tgtAy,
            })
            if (newLink && l.label) {
                this.svc.updateLinkConfig(newLink.id, {
                    labels: [{ id: this._uid(), text: l.label, t: 0.5, perpOffset: -14, fontSize: 10, fontWeight: 'bold', color: '#e2e8f0' }],
                    showArrow: true,
                } as any)
            } else if (newLink) {
                this.svc.updateLinkConfig(newLink.id, { showArrow: true } as any)
            }
        }

        this.statusMsg = `Template "${id}" applied`
        this.cdr.markForCheck()
    }

    // rectangle shape state
    selectedShapeId: string | null = null
    hoveredShapeId: string | null = null
    editingShapeId: string | null = null
    editingShapeLabel = ''
    ctxShapeId: string | null = null
    ctxShapeX = 0; ctxShapeY = 0
    private _resizingShape: Annotation | null = null
    private _resizeHandle = ''   // 'nw','ne','sw','se','n','s','e','w'
    private _resizeOriginX = 0; private _resizeOriginY = 0
    private _resizeOrigRect = { x: 0, y: 0, w: 0, h: 0 }

    // Multi-select shapes
    selectedShapeIds = new Set<string>()

    // Rubber band (marquee) selection
    private _rubberBand = false
    rubberBandRect: { x: number; y: number; w: number; h: number } | null = null
    private _rubberBandOrigin = { x: 0, y: 0 }

    // Node resize state
    private _resizingNodeId: string | null = null
    private _nodeResizeHandle = ''
    private _nodeResizeOriginX = 0; private _nodeResizeOriginY = 0
    private _nodeResizeOrigRect = { x: 0, y: 0, w: 0, h: 0 }

    // topology description edit
    editingDescription = false
    editingDescriptionText = ''

    // last-saved topology file path — used to derive inventory sidecar path
    private _lastTopoFilePath: string | null = null
    // file drag-and-drop overlay
    fileDragOver = false
    private _dragEnterCount = 0

    readonly nodeTypes: NodeType[] = ['router', 'switch', 'pc', 'cloud', 'firewall', 'server', 'host', 'bridge']
    readonly meta = NODE_TYPE_META
    readonly nw = NODE_W
    readonly nh = NODE_H
    readonly infraScale = 0.55
    readonly infraNw = Math.round(NODE_W * 0.55)
    readonly infraNh = Math.round(NODE_H * 0.55)

    private _subs: Subscription[] = []

    private _isActiveTab = false

    // ── Performance: O(1) lookup maps ────────────────────────────────────────
    private _nodeMap = new Map<string, TopologyNode>()
    private _linkMap = new Map<string, TopologyLink>()
    private _annotationMap = new Map<string, Annotation>()

    // ── Performance: link path & midpoint caches ─────────────────────────────
    // Keyed by link.id, invalidated on topology change
    private _linkPathCache = new Map<string, string>()
    private _linkMidpointCache = new Map<string, { x: number; y: number }>()
    // Signature map to detect when a link's geometry actually changed
    private _linkGeomSig = new Map<string, string>()
    private _parallelCache = new Map<string, { index: number; total: number }>()

    // ── Performance: viewport culling ────────────────────────────────────────
    private _visibleNodeIds = new Set<string>()
    private _visibleLinkIds = new Set<string>()
    private _visibleAnnotationIds = new Set<string>()
    private _vpDirty = true  // marks viewport cache as needing recomputation

    /** Nodes visible in the current viewport (cached) */
    get visibleNodes (): TopologyNode[] {
        if (this._vpDirty) { this._recomputeVisibility() }
        const nodes = this.topology?.nodes
        if (!nodes) { return [] }
        // For small topologies, skip culling
        if (nodes.length <= 80) { return nodes }
        return nodes.filter(n => this._visibleNodeIds.has(n.id))
    }

    /** Links visible in the current viewport (cached) */
    get visibleLinks (): TopologyLink[] {
        if (this._vpDirty) { this._recomputeVisibility() }
        const links = this.topology?.links
        if (!links) { return [] }
        if ((this.topology?.nodes?.length ?? 0) <= 80) { return links }
        return links.filter(l => this._visibleLinkIds.has(l.id))
    }

    /** Annotations visible in the current viewport (cached) */
    get visibleAnnotations (): Annotation[] {
        if (this._vpDirty) { this._recomputeVisibility() }
        const anns = this.topology?.annotations
        if (!anns) { return [] }
        if ((this.topology?.nodes?.length ?? 0) <= 80) { return anns }
        return anns.filter(a => this._visibleAnnotationIds.has(a.id))
    }

    /** Recompute which elements are inside the visible viewport */
    private _recomputeVisibility (): void {
        this._vpDirty = false
        this._visibleNodeIds.clear()
        this._visibleLinkIds.clear()
        this._visibleAnnotationIds.clear()

        const svgEl = this.svgRef?.nativeElement
        if (!svgEl) { return }
        const r = svgEl.getBoundingClientRect()
        // Compute the world-space bounding box of the viewport with generous padding
        const pad = 200  // extra pixels in world space to avoid pop-in
        const vLeft   = (-this.vpX / this.vpScale) - pad
        const vTop    = (-this.vpY / this.vpScale) - pad
        const vRight  = vLeft + (r.width / this.vpScale) + pad * 2
        const vBottom = vTop + (r.height / this.vpScale) + pad * 2

        const nodes = this.topology?.nodes
        if (!nodes) { return }

        for (const n of nodes) {
            const w = this.nodeW(n), h = this.nodeH(n)
            if (n.x + w >= vLeft && n.x <= vRight && n.y + h >= vTop && n.y <= vBottom) {
                this._visibleNodeIds.add(n.id)
            }
        }

        const links = this.topology?.links
        if (links) {
            for (const l of links) {
                // A link is visible if either endpoint is visible, or both nodes are outside but link might cross viewport
                const srcVisible = this._visibleNodeIds.has(l.sourceNodeId)
                const tgtVisible = this._visibleNodeIds.has(l.targetNodeId)
                // Also check annotation endpoints
                const srcAnnVisible = l.sourceAnnotationId ? this._visibleAnnotationIds.has(l.sourceAnnotationId) : false
                const tgtAnnVisible = l.targetAnnotationId ? this._visibleAnnotationIds.has(l.targetAnnotationId) : false
                if (srcVisible || tgtVisible || srcAnnVisible || tgtAnnVisible) {
                    this._visibleLinkIds.add(l.id)
                } else {
                    // Check if both endpoints are outside but the link could cross the viewport
                    const sn = this._nodeMap.get(l.sourceNodeId)
                    const tn = this._nodeMap.get(l.targetNodeId)
                    if (sn && tn) {
                        const sx = this.nodeCx(sn), sy = this.nodeCy(sn)
                        const tx = this.nodeCx(tn), ty = this.nodeCy(tn)
                        // Simple line-rect intersection: check if the line bounding box overlaps the viewport
                        const lx1 = Math.min(sx, tx), ly1 = Math.min(sy, ty)
                        const lx2 = Math.max(sx, tx), ly2 = Math.max(sy, ty)
                        if (lx2 >= vLeft && lx1 <= vRight && ly2 >= vTop && ly1 <= vBottom) {
                            this._visibleLinkIds.add(l.id)
                        }
                    }
                }
            }
        }

        const anns = this.topology?.annotations
        if (anns) {
            for (const a of anns) {
                const aw = a.width ?? 120, ah = a.height ?? 80
                if (a.x + aw >= vLeft && a.x <= vRight && a.y + ah >= vTop && a.y <= vBottom) {
                    this._visibleAnnotationIds.add(a.id)
                }
            }
        }
    }

    /** Mark viewport cache as dirty — called on pan/zoom/topology change */
    private _invalidateViewport (): void {
        this._vpDirty = true
    }

    /** Rebuild O(1) lookup maps from current topology */
    private _rebuildMaps (): void {
        this._nodeMap.clear()
        this._linkMap.clear()
        this._annotationMap.clear()
        if (!this.topology) { return }
        for (const n of this.topology.nodes) { this._nodeMap.set(n.id, n) }
        for (const l of this.topology.links) { this._linkMap.set(l.id, l) }
        for (const a of (this.topology.annotations ?? [])) { this._annotationMap.set(a.id, a) }
    }

    /** Invalidate link geometry caches — called when topology changes */
    private _invalidateLinkCaches (): void {
        this._linkPathCache.clear()
        this._linkMidpointCache.clear()
        this._linkGeomSig.clear()
        this._parallelCache.clear()
    }

    /** Invalidate link caches only for links connected to a specific node */
    private _invalidateLinkCachesForNode (nodeId: string): void {
        const links = this.topology?.links
        if (!links) { return }
        for (const l of links) {
            if (l.sourceNodeId === nodeId || l.targetNodeId === nodeId) {
                this._linkPathCache.delete(l.id)
                this._linkMidpointCache.delete(l.id)
                this._linkGeomSig.delete(l.id)
            }
        }
    }

    /** Invalidate link caches for links connected to a specific annotation */
    private _invalidateLinkCachesForAnnotation (annId: string): void {
        const links = this.topology?.links
        if (!links) { return }
        for (const l of links) {
            if (l.sourceAnnotationId === annId || l.targetAnnotationId === annId) {
                this._linkPathCache.delete(l.id)
                this._linkMidpointCache.delete(l.id)
                this._linkGeomSig.delete(l.id)
            }
        }
    }

    // ── Performance: RAF batching for drag/pan/zoom ──────────────────────────
    private _rafId: number | null = null
    private _rafPending = false

    /** Schedule a single RAF-batched change detection tick */
    private _scheduleRaf (): void {
        if (this._rafPending) { return }
        this._rafPending = true
        this._rafId = requestAnimationFrame(() => {
            this._rafPending = false
            this._rafId = null
            this.cdr.markForCheck()
            this.cdr.detectChanges()
        })
    }

    // ── Performance: reusable SVG point for coordinate transforms ────────────
    private _svgPt: { x: number; y: number } = { x: 0, y: 0 }

    // ── License / activation ─────────────────────────────────────────────────
    showLicenseDialog = false
    licenseKeyInput = ''
    licenseActivationError = ''
    showSplashScreen = false

    private static _splashShown = false

    constructor (
        public svc: TopologyService,
        public invSvc: InventoryService,
        @Inject(TAB_MANAGER) private tabMgr: any,
        private cdr: ChangeDetectorRef,
        @Inject(IS_ACTIVE_TAB) private _isActive$: BehaviorSubject<boolean>,
        private graphSvc: TopologyGraphService,
        public licenseSvc: LicenseService,
        private topoExportSvc: TopologyExportService,
    ) {}

    ngOnInit (): void {
        // ── Splash screen: only on first app launch, not on new tabs ──
        if (!NetopsCanvasComponent._splashShown) {
            NetopsCanvasComponent._splashShown = true
            this.showSplashScreen = true
            this.cdr.markForCheck()
            setTimeout(() => {
                this.showSplashScreen = false
                this.checkLicenseOnStartup()
                setTimeout(() => this.checkAndShowWelcome(), 500)
                this.cdr.markForCheck()
            }, 2000)
        } else {
            this.checkLicenseOnStartup()
        }

        // ── Theme: read persisted preference or respect system default ──
        const savedTheme = localStorage.getItem('netops-theme')
        if (savedTheme === 'light' || savedTheme === 'dark') {
            this.currentTheme = savedTheme
        } else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
            this.currentTheme = 'light'
        }
        document.documentElement.setAttribute('data-theme', this.currentTheme)

        this._subs.push(
            this._isActive$.subscribe(v => { this._isActiveTab = v }),
            this.svc.topology$.subscribe(t => {
                this.topology = t
                this._rebuildMaps()
                this._invalidateLinkCaches()
                this._invalidateViewport()
                this._pruneSelectionIds()
                this._computeNodeStubs()
                this.cdr.markForCheck()
            }),
            this.svc.selectedNode$.subscribe(id => { this.selectedNodeId = id; this.cdr.markForCheck() }),
            this.svc.selectedLink$.subscribe(id => { this.selectedLinkId = id; this.cdr.markForCheck() }),
            // Keep inventory panel, alarm indicators, and status bar reactive
            this.invSvc.store$.subscribe(() => { this.cdr.markForCheck() }),
        )
        // Initialize server heartbeat and attempt auto-reconnect
        this._loadClabServers().then(() => {
            this._startHeartbeat()
            this._autoReconnectOnStartup()
        })

        // Listen for Docker progress events (pull/load streaming)
        const api = (window as any).netopsAPI
        if (api?.onDockerProgress) {
            api.onDockerProgress((msg: string) => {
                this.dockerProgressMsg = msg
                this.cdr.markForCheck()
            })
        }

    }

    toggleTheme (): void {
        this.currentTheme = this.currentTheme === 'dark' ? 'light' : 'dark'
        document.documentElement.setAttribute('data-theme', this.currentTheme)
        localStorage.setItem('netops-theme', this.currentTheme)
        this.cdr.markForCheck()
    }

    ngOnDestroy (): void {
        this._subs.forEach(s => s.unsubscribe())
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null }
        if (this._clabInspectTimer) { clearTimeout(this._clabInspectTimer) }
        if (this._clabEnableTimer)  { clearTimeout(this._clabEnableTimer) }
        this.stopLivePolling()
        this._stopHeartbeat()
        this._stopServerResourcePolling()
        const api = (window as any).netopsAPI
        if (api?.offDockerProgress) { api.offDockerProgress() }
    }

    // ── Containerlab vendor helpers ──────────────────────────────────────────

    /** Map vendor string (+ optional model) to containerlab kind */
    private _vendorToClabKind (vendor?: string, model?: string, switchFamily?: string): string {
        const v = (vendor ?? '').trim().toLowerCase()
        const sf = (switchFamily ?? '').trim().toUpperCase()
        if (v === 'sonic' || v === 'edgecore') { return 'sonic-vs' }
        if (v === 'arista')  { return 'ceos' }
        if (v === 'cisco') {
            const m = (model ?? '').trim().toUpperCase()
            if (m.startsWith('XRD') || m.startsWith('XR') || m.startsWith('IOS-XR') || m.startsWith('IOSXR')) { return 'cisco_xrd' }
            if (m.startsWith('XRV')) { return 'cisco_xrv9k' }
            if (m.startsWith('CSR') || m.startsWith('IOS-XE') || m.startsWith('IOSXE') || m.startsWith('C8000')) { return 'cisco_csr1000v' }
            if (m.startsWith('N9K') || m.startsWith('NEXUS')) { return 'cisco_n9kv' }
            return 'cisco_xrd'  // default Cisco → XRd (lightweight)
        }
        if (v === 'nokia')   { return 'srl' }
        if (v === 'juniper') {
            // In 'crpd' mode, always use lightweight crpd (works without KVM)
            if (this.clabJuniperMode === 'crpd') { return 'crpd' }
            // In 'vm' mode, map to full VM kinds (requires KVM/nested virtualization)
            const m = (model ?? '').trim().toUpperCase()
            if (m.startsWith('QFX') || sf === 'QFX')  { return 'juniper_vqfx' }
            if (m.startsWith('EX') || sf === 'EX')    { return 'juniper_vjunosswitch' }
            if (m.startsWith('MX') || sf === 'MX')    { return 'juniper_vjunosrouter' }
            if (sf === 'PTX-EVO' || (m.startsWith('PTX') && m.includes('EVO')) || m.includes('EVO')) { return 'juniper_vjunosevolved' }
            if (m.startsWith('PTX') || sf === 'PTX')  { return 'juniper_vjunosrouter' }
            if (m.startsWith('ACX') || sf === 'ACX')  { return 'juniper_vjunosrouter' }
            return 'crpd'  // no model → lightweight fallback
        }
        return 'linux'
    }

    /** Analyze vendor composition of current topology */
    private _getTopologyVendorComposition (): { hasSonic: boolean; sonicCount: number; totalCount: number; vendorSummary: string } {
        const vendorCounts = new Map<string, number>()
        let sonicCount = 0
        for (const node of this.topology.nodes) {
            const kind = this._vendorToClabKind(node.vendor, node.model, node.switchFamily)
            if (kind === 'sonic-vs') { sonicCount++ }
            const v = node.vendor || (node.type === 'server' ? 'Server' : node.type === 'pc' ? 'PC' : 'Generic')
            vendorCounts.set(v, (vendorCounts.get(v) ?? 0) + 1)
        }
        const parts: string[] = []
        for (const [v, c] of vendorCounts) { parts.push(`${v} (${c})`) }
        return {
            hasSonic: sonicCount > 0,
            sonicCount,
            totalCount: this.topology.nodes.length,
            vendorSummary: parts.join(', ') || 'empty',
        }
    }

    /** Compute warnings for SONiC containerlab readiness + host/bridge validation (synchronous) */
    private _computeClabWarnings (): string[] {
        const warnings: string[] = []
        const sonicNodes = this.topology.nodes.filter(n => this._vendorToClabKind(n.vendor, n.model, n.switchFamily) === 'sonic-vs')

        if (sonicNodes.length) {
            const noAsn = sonicNodes.filter(n => n.asn == null)
            if (noAsn.length) {
                const names = noAsn.slice(0, 3).map(n => n.label).join(', ')
                const suffix = noAsn.length > 3 ? ` +${noAsn.length - 3} more` : ''
                warnings.push(`${noAsn.length} SONiC node(s) have no ASN (${names}${suffix}). BGP will not be configured.`)
            }

            const withAsn = sonicNodes.filter(n => n.asn != null)
            const noPortIps = withAsn.filter(n => {
                const linkedPortIds = this.topology.links
                    .filter(l => l.sourceNodeId === n.id || l.targetNodeId === n.id)
                    .map(l => l.sourceNodeId === n.id ? l.sourcePortId : l.targetPortId)
                return linkedPortIds.length > 0 && linkedPortIds.every(pid => {
                    const port = n.ports.find(p => p.id === pid)
                    return !port?.ipAddress?.trim()
                })
            })
            if (noPortIps.length) {
                const names = noPortIps.slice(0, 3).map(n => n.label).join(', ')
                const suffix = noPortIps.length > 3 ? ` +${noPortIps.length - 3} more` : ''
                warnings.push(`${noPortIps.length} SONiC node(s) have no IPs on linked ports (${names}${suffix}). BGP peering will not establish.`)
            }

            const noLoopback = withAsn.filter(n => !(n.loopbackIp?.trim() || n.mgmtIp?.trim()))
            if (noLoopback.length) {
                warnings.push(`${noLoopback.length} SONiC node(s) have no loopback IP. BGP router-id may not be set.`)
            }
        }

        // Host interface warnings (synchronous)
        const hostNodes = this.topology.nodes.filter(n => n.type === 'host')
        const linkedHostNodes = hostNodes.filter(hn =>
            this.topology.links.some(l => l.sourceNodeId === hn.id || l.targetNodeId === hn.id),
        )
        for (const hn of linkedHostNodes) {
            // Check each port that is connected
            const linkedPortIds = this.topology.links
                .filter(l => l.sourceNodeId === hn.id || l.targetNodeId === hn.id)
                .map(l => l.sourceNodeId === hn.id ? l.sourcePortId : l.targetPortId)
            for (const portId of linkedPortIds) {
                const port = hn.ports.find(p => p.id === portId)
                const label = port?.label ?? ''
                if (!label || label === 'NIC' || label.match(/^NIC\d+$/)) {
                    warnings.push(`${hn.label}: port "${port?.label || portId}" has no host interface assigned. Deploy will use "host:UNSET".`)
                }
            }
        }

        // Check duplicate host interfaces across nodes on same server
        const ifaceServerMap = new Map<string, string>()   // "serverId:ifaceName" → nodeLabel
        for (const hn of hostNodes) {
            const sid = hn.serverId || 'local'
            for (const port of hn.ports) {
                const label = port.label
                if (!label || label === 'NIC' || label.match(/^NIC\d+$/)) { continue }
                const key = `${sid}:${label}`
                if (ifaceServerMap.has(key)) {
                    warnings.push(`Duplicate host interface "${label}" on same server: ${ifaceServerMap.get(key)} and ${hn.label}`)
                } else {
                    ifaceServerMap.set(key, hn.label)
                }
            }
        }

        // Bridge node warnings — check per-port bridge assignment
        const bridgeNodes = this.topology.nodes.filter(n => n.type === 'bridge')
        for (const bn of bridgeNodes) {
            // Find ports that are used in links
            const usedPorts = new Set<string>()
            for (const l of this.topology.links) {
                if (l.sourceNodeId === bn.id) { usedPorts.add(l.sourcePortId) }
                if (l.targetNodeId === bn.id) { usedPorts.add(l.targetPortId) }
            }
            for (const portId of usedPorts) {
                const port = bn.ports.find(p => p.id === portId)
                const label = port?.label ?? ''
                const hasBridge = label && label !== 'br' && !label.match(/^br\d+$/)
                if (!hasBridge && !bn.bridgeName) {
                    warnings.push(`${bn.label} port ${port?.label || portId}: no bridge selected. Deploy will use "bridge:UNSET".`)
                }
            }
        }

        return warnings
    }

    /** Async pre-deploy validation — checks interfaces/bridges actually exist on target servers */
    async runPreDeployValidation (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabValidateHostInterfaces) { return }

        this.clabValidating = true
        this.clabValidationErrors = []
        this.clabValidationWarnings = []
        this.clabValidationDone = false
        this.cdr.markForCheck()

        try {
            // Collect host interfaces grouped by server
            const serverIfaceMap = new Map<string, { ifaces: string[]; nodeLabels: Map<string, string> }>()
            for (const node of this.topology.nodes) {
                if (node.type !== 'host') { continue }
                const sid = node.serverId || 'local'
                if (!serverIfaceMap.has(sid)) {
                    serverIfaceMap.set(sid, { ifaces: [], nodeLabels: new Map() })
                }
                const entry = serverIfaceMap.get(sid)!
                for (const port of node.ports) {
                    const label = port.label
                    if (label && label !== 'NIC' && !label.match(/^NIC\d+$/)) {
                        entry.ifaces.push(label)
                        entry.nodeLabels.set(label, node.label)
                    }
                }
            }

            // Validate host interfaces per server
            for (const [serverId, entry] of serverIfaceMap) {
                if (!entry.ifaces.length) { continue }
                const serverName = this.clabServers.find(s => s.id === serverId)?.name ?? (serverId === 'local' ? 'local' : serverId)
                const result = await api.clabValidateHostInterfaces({
                    interfaces: entry.ifaces,
                    serverId,
                })
                if (!result.ok) {
                    this.clabValidationWarnings.push(`Could not validate interfaces on ${serverName}: ${result.message}`)
                    continue
                }
                for (const r of result.results ?? []) {
                    const nodeLabel = entry.nodeLabels.get(r.name) ?? ''
                    const prefix = nodeLabel ? `${nodeLabel} → ${r.name}` : r.name
                    if (!r.exists) {
                        this.clabValidationErrors.push(`${prefix}: interface does not exist on ${serverName}`)
                    } else {
                        if (r.state === 'down') {
                            this.clabValidationWarnings.push(`${prefix}: interface is DOWN on ${serverName}`)
                        }
                        if (r.hasIp) {
                            this.clabValidationWarnings.push(`${prefix}: has an IP address assigned — containerlab will move it out of the host namespace`)
                        }
                        if (r.inBridge) {
                            this.clabValidationWarnings.push(`${prefix}: is a member of bridge "${r.bridgeName}" — must be removed first`)
                        }
                    }
                }
            }

            // Collect bridges grouped by server (per-port bridge names)
            const serverBridgeMap = new Map<string, { bridges: string[]; nodeLabels: Map<string, string> }>()
            for (const node of this.topology.nodes) {
                if (node.type !== 'bridge') { continue }
                const sid = node.serverId || 'local'
                if (!serverBridgeMap.has(sid)) {
                    serverBridgeMap.set(sid, { bridges: [], nodeLabels: new Map() })
                }
                const entry = serverBridgeMap.get(sid)!
                // Collect bridge names from each port
                for (const port of node.ports) {
                    const label = port.label ?? ''
                    const bridgeName = (label && label !== 'br' && !label.match(/^br\d+$/)) ? label : node.bridgeName
                    if (bridgeName && !entry.bridges.includes(bridgeName)) {
                        entry.bridges.push(bridgeName)
                        entry.nodeLabels.set(bridgeName, node.label)
                    }
                }
            }

            // Validate bridges per server
            if (api?.clabValidateBridges) {
                for (const [serverId, entry] of serverBridgeMap) {
                    if (!entry.bridges.length) { continue }
                    const serverName = this.clabServers.find(s => s.id === serverId)?.name ?? (serverId === 'local' ? 'local' : serverId)
                    const result = await api.clabValidateBridges({
                        bridges: entry.bridges,
                        serverId,
                    })
                    if (!result.ok) {
                        this.clabValidationWarnings.push(`Could not validate bridges on ${serverName}: ${result.message}`)
                        continue
                    }
                    for (const r of result.results ?? []) {
                        const nodeLabel = entry.nodeLabels.get(r.name) ?? ''
                        const prefix = nodeLabel ? `${nodeLabel} → ${r.name}` : r.name
                        if (!r.exists) {
                            this.clabValidationErrors.push(`${prefix}: bridge does not exist on ${serverName}`)
                        }
                    }
                }
            }
        } catch (err) {
            this.clabValidationWarnings.push(`Validation error: ${(err as Error).message}`)
        }

        this.clabValidating = false
        this.clabValidationDone = true
        this.cdr.markForCheck()
    }

    // ── Viewport helpers ────────────────────────────────────────────────────

    get vpTransform (): string {
        return `translate(${this.vpX},${this.vpY}) scale(${this.vpScale})`
    }

    private svgPt (ev: MouseEvent): { x: number; y: number } {
        if (!this.svgRef?.nativeElement) { return { x: 0, y: 0 } }
        const r = this.svgRef.nativeElement.getBoundingClientRect()
        return {
            x: (ev.clientX - r.left - this.vpX) / this.vpScale,
            y: (ev.clientY - r.top  - this.vpY) / this.vpScale,
        }
    }

    onWheel (ev: WheelEvent): void {
        if (this.viewMode !== '2d' || !this.svgRef?.nativeElement) { return }
        ev.preventDefault()
        const unit = ev.deltaMode === 0 ? 45 : (ev.deltaMode === 1 ? 3 : 1)
        const scaledDelta = ev.deltaY / unit
        const clampedDelta = Math.max(-6, Math.min(6, scaledDelta))
        const factor = Math.exp(-clampedDelta * 0.12)
        const r = this.svgRef.nativeElement.getBoundingClientRect()
        this._zoomAt(factor, ev.clientX - r.left, ev.clientY - r.top)
        this._invalidateViewport()
    }

    resetView (): void { this.vpX = 0; this.vpY = 0; this.vpScale = 1; this._invalidateViewport(); this.cdr.markForCheck() }

    zoomIn (): void { this._zoomFromCenter(1.08) }
    zoomOut (): void { this._zoomFromCenter(0.92) }

    /** Zoom to fit all nodes and shapes in the viewport with padding */
    zoomFit (): void {
        const nodes = this.topology?.nodes
        const anns = this.topology?.annotations ?? []
        if ((!nodes || nodes.length === 0) && anns.length === 0) { this.resetView(); return }
        const pad = 60
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of (nodes ?? [])) {
            const nw = n.width ?? NODE_W, nh = n.height ?? NODE_H
            if (n.x < minX) { minX = n.x }
            if (n.y < minY) { minY = n.y }
            if (n.x + nw > maxX) { maxX = n.x + nw }
            if (n.y + nh > maxY) { maxY = n.y + nh }
        }
        for (const a of anns) {
            const aw = a.width ?? 120, ah = a.height ?? 80
            if (a.x < minX) { minX = a.x }
            if (a.y < minY) { minY = a.y }
            if (a.x + aw > maxX) { maxX = a.x + aw }
            if (a.y + ah > maxY) { maxY = a.y + ah }
        }
        if (!isFinite(minX)) { this.resetView(); return }
        if (!this.svgRef?.nativeElement) { return }
        const svgR = this.svgRef.nativeElement.getBoundingClientRect()
        const contentW = maxX - minX + pad * 2
        const contentH = maxY - minY + pad * 2
        const scale = Math.min(svgR.width / contentW, svgR.height / contentH, this.maxScale)
        const clampedScale = Math.max(this.minScale, scale)
        this.vpScale = clampedScale
        this.vpX = (svgR.width - contentW * clampedScale) / 2 - (minX - pad) * clampedScale
        this.vpY = (svgR.height - contentH * clampedScale) / 2 - (minY - pad) * clampedScale
        this._invalidateViewport()
        this.cdr.markForCheck()
    }

    get zoomPercent (): number { return Math.round(this.vpScale * 100) }

    isShapeSelected (id: string): boolean { return this.selectedShapeIds.has(id) || this.selectedShapeId === id }

    // ── Minimap ───────────────────────────────────────────────────────────────
    readonly MINIMAP_W = 180
    readonly MINIMAP_H = 120

    get minimapViewBox (): string {
        const nodes = this.topology?.nodes
        if (!nodes || nodes.length === 0) { return '0 0 1000 700' }
        const pad = 100
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of nodes) {
            if (n.x < minX) { minX = n.x }
            if (n.y < minY) { minY = n.y }
            if (n.x + NODE_W > maxX) { maxX = n.x + NODE_W }
            if (n.y + NODE_H > maxY) { maxY = n.y + NODE_H }
        }
        return `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`
    }

    get minimapViewport (): { x: number; y: number; w: number; h: number } {
        const svgEl = this.svgRef?.nativeElement
        if (!svgEl) { return { x: 0, y: 0, w: 100, h: 100 } }
        const r = svgEl.getBoundingClientRect()
        return {
            x: -this.vpX / this.vpScale,
            y: -this.vpY / this.vpScale,
            w: r.width / this.vpScale,
            h: r.height / this.vpScale,
        }
    }

    onMinimapClick (ev: MouseEvent): void {
        const target = ev.currentTarget as SVGSVGElement
        if (!target) { return }
        const rect = target.getBoundingClientRect()
        const vb = this.minimapViewBox.split(' ').map(Number)
        const clickX = vb[0] + (ev.clientX - rect.left) / rect.width * vb[2]
        const clickY = vb[1] + (ev.clientY - rect.top) / rect.height * vb[3]
        const svgEl = this.svgRef.nativeElement
        const svgRect = svgEl.getBoundingClientRect()
        this.vpX = -(clickX * this.vpScale - svgRect.width / 2)
        this.vpY = -(clickY * this.vpScale - svgRect.height / 2)
        this.cdr.markForCheck()
    }

    get isPanning (): boolean { return this._panning }

    private _zoomFromCenter (factor: number): void {
        const r = this.svgRef.nativeElement.getBoundingClientRect()
        this._zoomAt(factor, r.width / 2, r.height / 2)
    }

    private _zoomAt (factor: number, cx: number, cy: number): void {
        const nextScale = Math.min(this.maxScale, Math.max(this.minScale, this.vpScale * factor))
        const applied = nextScale / this.vpScale
        this.vpX = cx - (cx - this.vpX) * applied
        this.vpY = cy - (cy - this.vpY) * applied
        this.vpScale = nextScale
        this._invalidateViewport()
        this.cdr.markForCheck()
    }

    // ── Palette drag ────────────────────────────────────────────────────────

    onPaletteDragStart (ev: DragEvent, type: NodeType): void {
        ev.dataTransfer!.setData('nodeType', type)
        ev.dataTransfer!.effectAllowed = 'copy'
    }

    onCanvasDragOver (ev: DragEvent): void { ev.preventDefault(); ev.dataTransfer!.dropEffect = 'copy' }

    onCanvasDrop (ev: DragEvent): void {
        ev.preventDefault()
        ev.stopPropagation()
        this._dragEnterCount = 0
        this.fileDragOver = false
        // Palette node drop
        const type = ev.dataTransfer?.getData('nodeType') as NodeType | undefined
        if (type) {
            const { x, y } = this.svgPt(ev as unknown as MouseEvent)
            const node = this.svc.addNode(type, x - NODE_W / 2, y - NODE_H / 2)
            this.statusMsg = `Added ${node.label}`
            this.cdr.markForCheck()
            return
        }
        // Palette shape drop
        const shapeType = ev.dataTransfer?.getData('shapeType') || this._pendingShapeDrop
        this._pendingShapeDrop = null
        const validShapes = ['rectangle', 'circle', 'diamond', 'triangle', 'star', 'hexagon', 'parallelogram', 'cylinder', 'cloud', 'arrow-right', 'arrow-double', 'line-h']
        if (shapeType && validShapes.includes(shapeType)) {
            const { x, y } = this.svgPt(ev as unknown as MouseEvent)
            const sizes: Record<string, [number, number]> = {
                circle: [100, 100], diamond: [100, 100], star: [100, 100], hexagon: [100, 100],
                cylinder: [100, 70], cloud: [140, 90], 'arrow-right': [120, 60], 'arrow-double': [140, 60], 'line-h': [120, 10],
            }
            const [w, h] = sizes[shapeType] ?? [120, 80]
            const shape = this.svc.addShape(shapeType as any, x - w / 2, y - h / 2, w, h)
            this.selectedShapeId = shape.id
            this.statusMsg = `Added ${shapeType}`
            this.cdr.markForCheck()
            return
        }
        // Template drop
        const templateId = ev.dataTransfer?.getData('templateId') || this._pendingTemplateDrop
        this._pendingTemplateDrop = null
        if (templateId && this.shapeTemplates.some((t: any) => t.id === templateId)) {
            this.applyShapeTemplate(templateId)
            return
        }
        // Image file drop — add as image annotation at drop position
        const file = ev.dataTransfer?.files?.[0]
        if (file && /^image\/(png|jpeg|svg\+xml|gif)$/.test(file.type)) {
            const pt = this.svgPt(ev as unknown as MouseEvent)
            this._loadImageFile(file, pt)
            return
        }
        // File drop — load topology JSON
        if (file) { this._handleDroppedFile(file) }
    }

    // ── File drag-and-drop ───────────────────────────────────────────────────

    onShellDragEnter (ev: DragEvent): void {
        ev.preventDefault()
        this._dragEnterCount++
        if (ev.dataTransfer?.types?.includes('Files')) {
            this.fileDragOver = true
            this.cdr.markForCheck()
        }
    }

    onShellDragLeave (ev: DragEvent): void {
        ev.preventDefault()
        this._dragEnterCount--
        if (this._dragEnterCount <= 0) {
            this._dragEnterCount = 0
            this.fileDragOver = false
            this.cdr.markForCheck()
        }
    }

    onShellDrop (ev: DragEvent): void {
        ev.preventDefault()
        this._dragEnterCount = 0
        this.fileDragOver = false
        const file = ev.dataTransfer?.files?.[0]
        if (file && /^image\/(png|jpeg|svg\+xml|gif)$/.test(file.type)) {
            this._loadImageFile(file, null)
        } else if (file) {
            this._handleDroppedFile(file)
        }
        this.cdr.markForCheck()
    }

    private _handleDroppedFile (file: File): void {
        if (!file.name.endsWith('.json')) {
            this.statusMsg = 'Only .json topology files or images (PNG, JPG, SVG, GIF) are supported'
            this.cdr.markForCheck()
            return
        }
        // Electron exposes the full filesystem path on dropped files
        const nativePath: string | undefined = (file as any).path
        if (nativePath && /-inv\.json$/i.test(nativePath)) {
            this.statusMsg = 'That is an inventory file. Please drop the .topo.json file instead.'
            this.importError = 'Dropped inventory sidecar instead of topology'
            this.cdr.markForCheck()
            return
        }
        const reader = new FileReader()
        reader.onload = async () => {
            const json = reader.result as string
            const ok = this.svc.importJSON(json)
            if (ok) {
                this.statusMsg = `Loaded: ${this.topology.name}`
                // Auto-load inventory sidecar if we have the native path
                if (nativePath) {
                    this._lastTopoFilePath = nativePath
                    const loaded = await this._tryLoadInventorySidecar(nativePath)
                    if (loaded) { this.statusMsg += ' (inventory restored)' }
                } else {
                    this._lastTopoFilePath = null
                }
            } else if (this._looksLikeInventory(json)) {
                this.statusMsg = 'That is an inventory file, not a topology. Please drop the .topo.json file.'
                this.importError = 'Dropped inventory file instead of topology'
            } else {
                this.statusMsg = 'Invalid topology file'
                this.importError = 'Invalid topology file'
            }
            this.cdr.markForCheck()
        }
        reader.readAsText(file)
    }

    // ── Canvas background ───────────────────────────────────────────────────

    onBgMouseDown (ev: MouseEvent): void {
        if (this.pendingLink) { return }
        if (this.portPickerCtx) { return }   // don't pan/close while port picker is open
        if (ev.button === 0 || ev.button === 1) {
            // Shift-drag on empty canvas → rubber band selection
            if (this._isMultiSelectIntent(ev) && ev.button === 0) {
                const pt = this.svgPt(ev)
                this._rubberBand = true
                this._rubberBandOrigin = { x: pt.x, y: pt.y }
                this.rubberBandRect = { x: pt.x, y: pt.y, w: 0, h: 0 }
                this.cdr.markForCheck()
                return
            }
            this._panning = true
            this._panMoved = false
            this.closeCtxMenu()
        }
    }

    onBgClick (): void {
        this.closeMenus()
        if (this._ignoreNextBgClick) {
            this._ignoreNextBgClick = false
            return
        }
        if (this._panMoved) {
            this._panMoved = false
            return
        }
        // If port picker is open, a click on the canvas background should close it
        // (user clicked away to dismiss), but guard against closing it during normal flow.
        if (this.portPickerCtx) {
            this.closePortPicker()
            if (this.pendingLink && !this.linkModeActive) { this.pendingLink = null }
            this.cdr.markForCheck()
            return
        }
        this.clearSelection()
        this.selectedShapeId = null
        this.selectedShapeIds.clear()
        this.ctxShapeId = null
        this.closeCtxMenu()
        this.closeCtxLinkMenu()
        if (this.pendingLink && !this.linkModeActive) { this.pendingLink = null; this.cdr.markForCheck() }
    }

    // ── Node interactions ───────────────────────────────────────────────────

    onNodeMouseDown (ev: MouseEvent, node: TopologyNode): void {
        if (ev.button !== 0) { return }
        ev.stopPropagation()
        if (this.pendingLink || this._shapeDragSourceId) { return }   // don't drag while drawing link
        if (this.linkModeActive) {
            // In link mode, mousedown starts a drag-to-connect from this node
            this._linkDragSourceId = node.id
            const pt = this.svgPt(ev)
            this.pendingMouse = { x: pt.x, y: pt.y }
            return
        }
        this._dragNode = node
        const pt = this.svgPt(ev)
        this._dragOX = pt.x - node.x
        this._dragOY = pt.y - node.y
        this.dragGhostOrigin = { x: node.x, y: node.y }
    }

    onNodeMouseUp (ev: MouseEvent, node: TopologyNode): void {
        // Shape drag-to-connect: dropped on a node → create shape→node link
        if (this._shapeDragSourceId) {
            const freePort = this.svc.freePorts(node.id)?.[0]
            if (freePort) {
                this.svc.addShapeLink({
                    sourceAnnotationId: this._shapeDragSourceId,
                    sourceAnchorX: this._shapeDragAnchor?.x,
                    sourceAnchorY: this._shapeDragAnchor?.y,
                    targetNodeId: node.id,
                    targetPortId: freePort.id,
                })
                this.statusMsg = 'Link created'
            } else {
                this.statusMsg = 'No free ports on target node'
            }
            this._shapeDragSourceId = null
            this._shapeDragAnchor = null
            this.cdr.markForCheck()
            return
        }
        if (!this.linkModeActive || !this._linkDragSourceId) { return }
        if (this._linkDragSourceId === node.id) {
            // Released on same node — treat as click: open source port picker
            this._linkDragSourceId = null
            this.pendingLink = null
            this._openPortPicker(`src:${node.id}`, node, ev)
            return
        }
        // Released on a different node — use first free ports on each side
        const srcId = this._linkDragSourceId
        this._linkDragSourceId = null
        this.pendingLink = null
        const srcPorts = this.svc.freePorts(srcId)
        const tgtPorts = this.svc.freePorts(node.id)
        if (!srcPorts.length) { this.statusMsg = 'No free ports on source node'; this.cdr.markForCheck(); return }
        if (!tgtPorts.length) { this.statusMsg = 'No free ports on target node'; this.cdr.markForCheck(); return }
        const result = this.svc.addLink(srcId, srcPorts[0].id, node.id, tgtPorts[0].id)
        this.statusMsg = result ? `Link created` : 'Could not create link (port already in use?)'
        this.cdr.markForCheck()
    }

    onNodeClick (ev: MouseEvent, node: TopologyNode): void {
        ev.stopPropagation()
        this.closeCtxMenu()
        this.closeCtxLinkMenu()
        this.closePortPicker()

        // If a drag-to-connect was in progress, onNodeMouseUp handles it; ignore click
        if (this._linkDragSourceId) { return }

        // Link mode click-to-click: first click opens source port picker
        if (this.linkModeActive && !this.pendingLink) {
            this._openPortPicker(`src:${node.id}`, node, ev)
            return
        }

        if (this.pendingLink) {
            if (node.id === this.pendingLink.sourceNodeId) {
                this.pendingLink = null
                this.cdr.markForCheck()
                return
            }
            // Shape-to-node link: auto-pick first free port (draw.io style)
            if (this.pendingLink.sourceAnnotationId) {
                const freePort = this.svc.freePorts(node.id)?.[0]
                if (freePort) {
                    this.svc.addShapeLink({
                        sourceAnnotationId: this.pendingLink.sourceAnnotationId,
                        sourceAnchorX: this.pendingLink.anchorX,
                        sourceAnchorY: this.pendingLink.anchorY,
                        targetNodeId: node.id,
                        targetPortId: freePort.id,
                    })
                    this.statusMsg = 'Link created'
                } else {
                    this.statusMsg = 'No free ports on target node'
                }
                this.pendingLink = null
                this.cdr.markForCheck()
                return
            }
            this._openPortPicker(`tgt:${node.id}`, node, ev)
            return
        }
        if (this._isMultiSelectIntent(ev)) {
            if (this.selectedNodeIds.has(node.id)) { this.selectedNodeIds.delete(node.id) }
            else { this.selectedNodeIds.add(node.id) }
            this._syncPrimarySelection()
            this.statusMsg = this._selectionStatus()
            this.cdr.markForCheck()
            return
        }

        this.selectedNodeIds = new Set([node.id])
        this.selectedLinkIds.clear()
        this._syncPrimarySelection()
        this.statusMsg = `Selected: ${node.label}`
    }

    onNodeRightClick (ev: MouseEvent, node: TopologyNode): void {
        ev.preventDefault()
        ev.stopPropagation()
        this.closePortPicker()
        this.pendingLink = null
        this.selectedNodeIds = new Set([node.id])
        this.selectedLinkIds.clear()
        this._syncPrimarySelection()
        this.ctxNodeId = node.id
        const pos = this._ctxPos(ev, 180, 350)
        this.ctxX = pos.x
        this.ctxY = pos.y
        this.cdr.markForCheck()
    }

    // ── Context menu actions ────────────────────────────────────────────────

    closeCtxMenu (): void { this.ctxNodeId = null; this.cdr.markForCheck() }

    ctxStartLink (ev: MouseEvent, nodeId: string): void {
        ev.preventDefault()
        ev.stopPropagation()
        this._ignoreNextBgClick = true
        // Capture context menu position before closing (for port picker placement)
        const px = this.ctxX
        const py = this.ctxY
        this.closeCtxMenu()
        // Defer opening by one macrotask so the click that closed the context menu
        // cannot immediately bubble to canvas and close the picker.
        window.setTimeout(() => {
            const node = this.topology.nodes.find(n => n.id === nodeId)
            if (!node) {
                this.statusMsg = 'Node not found for Add Link'
                this.cdr.markForCheck()
                return
            }
            this._openPortPickerAt(`src:${nodeId}`, node, px, py)
        }, 0)
    }

    ctxRename (nodeId: string): void {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return }
        this.renamingId = nodeId
        this.renamingLabel = node.label
        this.cdr.markForCheck()
    }

    ctxDelete (nodeId: string): void {
        this.closeCtxMenu()
        this.svc.removeNode(nodeId)
        this._pruneSelectionIds()
        this.statusMsg = 'Node deleted'
    }

    async ctxStart (nodeId: string): Promise<void> {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return }
        const container = this._findContainerForNode(node)
        if (!container) {
            this.svc.startNode(nodeId)
            this.statusMsg = `${node.label}: running (UI only — no container found)`
            this.cdr.markForCheck()
            return
        }
        const api = (window as any).netopsAPI
        // If node is paused/suspended → unpause; otherwise → start
        const isSuspended = node.status === 'suspended' || container.state === 'paused'
        if (isSuspended) {
            const result = await api.clabContainerSuspend({ container: container.name, suspend: false })
            if (result.ok) {
                this.svc.startNode(nodeId)
                this.statusMsg = `${node.label}: resumed`
            } else {
                this.statusMsg = `${node.label}: unpause failed — ${result.message}`
            }
        } else {
            const result = await api.clabContainerStart({ container: container.name })
            if (result.ok) {
                this.svc.startNode(nodeId)
                this.statusMsg = `${node.label}: started`
            } else {
                this.statusMsg = `${node.label}: start failed — ${result.message}`
            }
        }
        this.cdr.markForCheck()
    }

    async ctxStop (nodeId: string): Promise<void> {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return }
        const container = this._findContainerForNode(node)
        if (!container) {
            this.svc.stopNode(nodeId)
            this.statusMsg = `${node.label}: stopped (UI only — no container found)`
            this.cdr.markForCheck()
            return
        }
        const api = (window as any).netopsAPI
        const result = await api.clabContainerStop({ container: container.name })
        if (result.ok) {
            this.svc.stopNode(nodeId)
            this.statusMsg = `${node.label}: stopped`
        } else {
            this.statusMsg = `${node.label}: stop failed — ${result.message}`
        }
        this.cdr.markForCheck()
    }

    async ctxSuspend (nodeId: string): Promise<void> {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return }
        const container = this._findContainerForNode(node)
        if (!container) {
            this.svc.suspendNode(nodeId)
            this.statusMsg = `${node.label}: suspended (UI only — no container found)`
            this.cdr.markForCheck()
            return
        }
        const api = (window as any).netopsAPI
        const result = await api.clabContainerSuspend({ container: container.name, suspend: true })
        if (result.ok) {
            this.svc.suspendNode(nodeId)
            this.statusMsg = `${node.label}: suspended`
        } else {
            this.statusMsg = `${node.label}: suspend failed — ${result.message}`
        }
        this.cdr.markForCheck()
    }

    async ctxOpenSshTerminal (nodeId: string): Promise<void> {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) {
            this.statusMsg = 'Node not found'
            this.cdr.markForCheck()
            return
        }

        const hostRaw = (node.mgmtIp ?? '').trim()
        const host = hostRaw.split('/')[0].trim()
        const username = (node.sshUsername ?? '').trim()
        const portRaw = node.sshPort ?? 22
        const portCandidate = Number.isFinite(portRaw) ? Math.trunc(portRaw) : 22
        const port = portCandidate >= 1 && portCandidate <= 65535 ? portCandidate : 22

        if (!host || !username) {
            this.statusMsg = `${node.label}: set Mgmt IP and SSH username first`
            this.cdr.markForCheck()
            return
        }

        const api = window.netopsAPI
        if (!api?.openSshTerminal) {
            this.statusMsg = 'SSH terminal API is unavailable in this runtime'
            this.cdr.markForCheck()
            return
        }

        try {
            const result = await api.openSshTerminal({ host, port, username })
            this.statusMsg = result.message
        } catch (err) {
            this.statusMsg = `Failed to open SSH terminal: ${(err as Error).message}`
        }
        this.cdr.markForCheck()
    }

    // ── View config in new window ────────────────────────────────────────────

    private _configWindows = new Map<string, Window>()
    private _configMsgHandlers = new Map<string, (e: MessageEvent) => void>()

    ctxViewConfig (nodeId: string): void {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return }

        // If already open for this node, focus it
        const existing = this._configWindows.get(nodeId)
        if (existing && !existing.closed) { existing.focus(); return }

        const label = node.label ?? 'Node'
        const cfg = node.startupConfig ?? ''

        const win = window.open('', '_blank', 'width=900,height=700,menubar=no,toolbar=no')
        if (!win) { return }
        this._configWindows.set(nodeId, win)

        win.document.write(this._buildConfigWindowHtml(label, cfg))
        win.document.close()
        win.document.title = `Config — ${label}`

        const handler = (e: MessageEvent) => {
            if (e.source !== win) { return }
            if (e.data?.type === 'config-save') {
                this.svc.updateNodeConfig(nodeId, { startupConfig: e.data.config })
                this.statusMsg = `${label}: config saved`
                this.cdr.markForCheck()
            }
        }
        this._configMsgHandlers.set(nodeId, handler)
        window.addEventListener('message', handler)

        const checkClosed = setInterval(() => {
            if (win.closed) {
                clearInterval(checkClosed)
                const h = this._configMsgHandlers.get(nodeId)
                if (h) { window.removeEventListener('message', h); this._configMsgHandlers.delete(nodeId) }
                this._configWindows.delete(nodeId)
            }
        }, 500)
    }

    /** Open a side-by-side config compare window — lets user pick another node to compare with */
    ctxCompareConfig (nodeId: string): void {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node?.startupConfig) { return }

        // Find all other nodes with configs
        const otherNodes = this.topology.nodes.filter(n => n.id !== nodeId && n.startupConfig)
        if (!otherNodes.length) {
            this.statusMsg = 'No other nodes with configs to compare'
            this.cdr.markForCheck()
            return
        }

        // Let user pick which node to compare with
        const options = otherNodes.map(n => `${n.label} (${n.vendor ?? ''} ${n.role ?? ''})`).join('\n')
        const choice = prompt(`Compare ${node.label} config with:\n\n${otherNodes.map((n, i) => `${i + 1}. ${n.label} (${n.vendor ?? ''} ${n.role ?? ''})`).join('\n')}\n\nEnter number:`)
        if (!choice) { return }
        const idx = parseInt(choice, 10) - 1
        if (idx < 0 || idx >= otherNodes.length) { return }
        const otherNode = otherNodes[idx]

        // Open compare window
        const leftCfg = node.startupConfig!.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const rightCfg = otherNode.startupConfig!.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const win = window.open('', '_blank', 'width=1400,height=700,menubar=no,toolbar=no')
        if (!win) { return }
        win.document.write(`<!DOCTYPE html><html><head><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; color:#c9d1d9; font-family:monospace; display:flex; flex-direction:column; height:100vh; }
.header { display:flex; padding:8px 16px; background:#161b22; border-bottom:1px solid #30363d; gap:16px; align-items:center; }
.header h3 { font-size:13px; flex:1; }
.header .vs { color:#f0883e; font-weight:bold; }
.panels { display:flex; flex:1; overflow:hidden; }
.panel { flex:1; overflow:auto; padding:12px; border-right:1px solid #30363d; }
.panel:last-child { border-right:none; }
.panel-title { font-size:11px; color:#8b949e; margin-bottom:8px; text-transform:uppercase; letter-spacing:1px; }
pre { font-size:12px; line-height:1.6; white-space:pre-wrap; word-break:break-all; }
</style></head><body>
<div class="header">
  <h3>${node.label}</h3>
  <span class="vs">⟷ COMPARE ⟷</span>
  <h3>${otherNode.label}</h3>
</div>
<div class="panels">
  <div class="panel"><div class="panel-title">${node.label} (${node.vendor ?? ''} ${node.model ?? ''})</div><pre>${leftCfg}</pre></div>
  <div class="panel"><div class="panel-title">${otherNode.label} (${otherNode.vendor ?? ''} ${otherNode.model ?? ''})</div><pre>${rightCfg}</pre></div>
</div>
</body></html>`)
        win.document.close()
        win.document.title = `Compare: ${node.label} ⟷ ${otherNode.label}`
    }

    ctxShowTroubleshoot (nodeId: string): void {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return }

        this.tsNodeLabel = node.label ?? 'Node'
        this.tsSections = this._buildTroubleshootSections(node)
        this.tsDialogVisible = true
        this.cdr.markForCheck()
    }

    /** Whether the right-clicked node can fetch & compare config */
    get ctxNodeCanFetchDiff (): boolean {
        if (!this.ctxNodeId) { return false }
        const node = this.topology.nodes.find(n => n.id === this.ctxNodeId)
        if (!node || !node.startupConfig?.trim()) { return false }
        // Can diff if: has running container OR has SSH credentials
        const safeName = node.label.replace(/\s+/g, '-').toLowerCase()
        const hasCtn = this.clabContainers?.some(c => c.name.endsWith('-' + safeName) && c.state === 'running')
        if (hasCtn) { return true }
        const host = (node.mgmtIp ?? '').split('/')[0]
        return !!(host && node.sshUsername && node.sshPassword)
    }

    /** Fetch running config from device and show diff in a popup window */
    async ctxFetchAndCompare (nodeId: string): Promise<void> {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return }

        const api = (window as any).netopsAPI
        const localConfig = (node.startupConfig ?? '').trim()
        if (!localConfig) { this.statusMsg = 'No local config to compare'; this.cdr.markForCheck(); return }

        this.statusMsg = `Fetching running config from ${node.label}...`
        this.cdr.markForCheck()

        let remoteConfig = ''
        try {
            const cmds = getVendorCommands(node.vendor ?? '', node.model ?? '')
            const safeName = node.label.replace(/\s+/g, '-').toLowerCase()
            const ctn = this.clabContainers?.find(c => c.name.endsWith('-' + safeName) && c.state === 'running')

            if (ctn && api?.clabExecCommand) {
                const result = await api.clabExecCommand({ containerName: ctn.name, command: cmds.showRunningConfig })
                if (result.ok) { remoteConfig = result.output ?? '' }
                else { throw new Error(result.message) }
            } else {
                const host = (node.mgmtIp ?? '').split('/')[0]
                if (!host || !api?.sshShellSession) { throw new Error('No SSH access') }
                let result: any
                if (this._backendSvc?.isConnected) {
                    result = await this._backendSvc.runCommand(host, node.sshPort ?? 22, node.sshUsername ?? '', node.sshPassword ?? '', cmds.showRunningConfig)
                } else {
                    result = await api.sshShellSession({
                        host, port: node.sshPort ?? 22,
                        username: node.sshUsername ?? '', password: node.sshPassword ?? '',
                        commands: [cmds.showRunningConfig],
                    })
                }
                if (result.ok) { remoteConfig = result.output ?? '' }
                else { throw new Error(result.message) }
            }

            // Clean the fetched config
            remoteConfig = this._cleanPulledConfig(remoteConfig, node.vendor ?? '')
        } catch (err) {
            this.statusMsg = `Fetch failed: ${(err as Error).message}`
            this.cdr.markForCheck()
            return
        }

        this.statusMsg = ''
        this.cdr.markForCheck()

        // Open diff in a new window
        this._openDiffWindow(node.label, localConfig, remoteConfig)
    }

    /** Open a diff comparison window showing local vs running config */
    private _openDiffWindow (nodeLabel: string, localConfig: string, runningConfig: string): void {
        const win = window.open('', '_blank', 'width=1200,height=800,menubar=no,toolbar=no')
        if (!win) { return }

        const localLines = localConfig.split('\n')
        const runningLines = runningConfig.split('\n')
        const localSet = new Set(localLines.map(l => l.trim()).filter(l => l))
        const runningSet = new Set(runningLines.map(l => l.trim()).filter(l => l))

        const onlyLocal = localLines.filter(l => l.trim() && !runningSet.has(l.trim()))
        const onlyRunning = runningLines.filter(l => l.trim() && !localSet.has(l.trim()))
        const common = localLines.filter(l => l.trim() && runningSet.has(l.trim()))

        const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

        const diffHtml = [
            ...onlyLocal.map(l => `<div class="diff-removed">- ${escHtml(l)}</div>`),
            ...onlyRunning.map(l => `<div class="diff-added">+ ${escHtml(l)}</div>`),
            ...common.map(l => `<div class="diff-common">  ${escHtml(l)}</div>`),
        ].join('\n')

        win.document.write(`<!DOCTYPE html><html><head><title>Config Diff: ${nodeLabel}</title>
<style>
  body { margin: 0; font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px; background: #1a1a2e; color: #e0e0e0; }
  .header { padding: 12px 20px; background: #16213e; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
  .header h2 { margin: 0; font-size: 16px; }
  .stats { display: flex; gap: 16px; font-size: 13px; }
  .stats .removed { color: #f87171; }
  .stats .added { color: #4ade80; }
  .stats .common { color: #94a3b8; }
  .diff { padding: 12px 20px; white-space: pre; overflow: auto; height: calc(100vh - 60px); }
  .diff-removed { color: #f87171; background: rgba(248,113,113,0.1); padding: 1px 4px; }
  .diff-added { color: #4ade80; background: rgba(74,222,128,0.1); padding: 1px 4px; }
  .diff-common { color: #64748b; padding: 1px 4px; }
</style></head><body>
<div class="header">
  <h2>Config Diff: ${nodeLabel}</h2>
  <div class="stats">
    <span class="removed">− ${onlyLocal.length} only in local</span>
    <span class="added">+ ${onlyRunning.length} only on device</span>
    <span class="common">= ${common.length} matching</span>
  </div>
</div>
<div class="diff">${diffHtml}</div>
</body></html>`)
        win.document.close()
        win.document.title = `Config Diff: ${nodeLabel}`
    }

    private _buildTroubleshootSections (node: any): typeof this.tsSections {
        const vendor = (node.vendor ?? '').toLowerCase()
        const sections: typeof this.tsSections = []

        if (vendor === 'juniper') {
            sections.push({
                title: '🔍 Basic System Health',
                open: true,
                commands: [
                    { command: 'show system alarms', description: 'Check active alarms' },
                    { command: 'show chassis alarms', description: 'Hardware alarms' },
                    { command: 'show interfaces terse', description: 'Interface up/down status' },
                    { command: 'show interfaces extensive | match "error|CRC|loss"', description: 'Interface errors' },
                    { command: 'show lldp neighbors', description: 'Verify neighbor topology' },
                    { command: 'show system commit', description: 'Last config commit status' },
                    { command: 'show ntp associations', description: 'NTP sync status' },
                    { command: 'show version', description: 'JunOS version' },
                ],
            })

            if (node.asn) {
                sections.push({
                    title: '📡 BGP Underlay',
                    open: false,
                    commands: [
                        { command: 'show bgp summary', description: 'All BGP sessions' },
                        { command: 'show bgp neighbor | match "Peer|State|flap"', description: 'Session state and flaps' },
                        { command: 'show bgp neighbor <peer-ip> | match "Last error|State"', description: 'Debug specific peer' },
                        { command: 'show route protocol bgp', description: 'BGP routes in RIB' },
                        { command: 'show route advertising-protocol bgp <peer-ip>', description: 'Routes sent to peer' },
                        { command: 'show route receive-protocol bgp <peer-ip>', description: 'Routes received from peer' },
                        { command: 'show route <dest> detail | match "next-hop"', description: 'Verify ECMP paths' },
                        { command: 'show bfd session', description: 'BFD session status' },
                        { command: 'test policy EXPORT-LOOPBACK <prefix>', description: 'Test export policy match' },
                    ],
                })
            }

            const hasOverlay = node.overlayEnabled || (node.startupConfig ?? '').includes('evpn')
            if (hasOverlay) {
                sections.push({
                    title: '🔗 EVPN-VXLAN Overlay',
                    open: false,
                    commands: [
                        { command: 'show bgp summary group OVERLAY', description: 'EVPN overlay sessions' },
                        { command: 'show evpn instance extensive', description: 'EVPN instance details' },
                        { command: 'show evpn database', description: 'MAC/IP learned via EVPN' },
                        { command: 'show evpn database mac-address <mac> extensive', description: 'Specific MAC trace' },
                        { command: 'show ethernet-switching vxlan-tunnel-end-point remote', description: 'Remote VTEPs' },
                        { command: 'show vlans extensive | match "vlan-id|vxlan-id"', description: 'VNI-to-VLAN mapping' },
                        { command: 'show ethernet-switching table', description: 'MAC address table' },
                        { command: 'show bridge mac-ip-table summary', description: 'MAC-IP binding count' },
                        { command: 'show bridge mac-ip-table kernel differences', description: 'L2ALD vs kernel sync' },
                        { command: 'show ethernet-switching context-history mac <mac>', description: 'MAC state machine trace' },
                        { command: 'show evpn route-type 2', description: 'Type-2 MAC/IP routes' },
                        { command: 'show evpn route-type 3', description: 'Type-3 Inclusive Multicast' },
                        { command: 'show evpn route-type 5', description: 'Type-5 IP Prefix routes' },
                        { command: 'show ddos-protection protocols vxlan', description: 'DDOS drops (scale issues)' },
                        { command: 'ping overlay mac <mac> bridge-domain <bd>', description: 'Overlay reachability' },
                    ],
                })

                // MAC-VRF specific commands
                sections.push({
                    title: '🏢 MAC-VRF Verification',
                    open: false,
                    commands: [
                        { command: 'show mac-vrf forwarding vxlan-tunnel-end-point remote', description: 'Per MAC-VRF VTEP tunnels' },
                        { command: 'show mac-vrf forwarding interface <ifl>', description: 'MAC-VRF interface state/VLAN membership' },
                        { command: 'show mac-vrf forwarding mac-table', description: 'MAC table per MAC-VRF instance' },
                        { command: 'show mac-vrf forwarding mac-table instance <mac-vrf-name>', description: 'MACs in specific MAC-VRF' },
                        { command: 'show mac-vrf forwarding mac-ip-table', description: 'MAC-IP bindings per MAC-VRF' },
                        { command: 'show mac-vrf forwarding flood', description: 'BUM flood list per MAC-VRF' },
                        { command: 'show evpn instance <mac-vrf-name> extensive', description: 'EVPN instance for MAC-VRF' },
                        { command: 'show route table <mac-vrf-name>.evpn.0', description: 'EVPN routes in MAC-VRF table' },
                        { command: 'show bgp summary | match "mac-vrf"', description: 'Per MAC-VRF route counts' },
                        { command: 'show route instance <mac-vrf-name> detail', description: 'MAC-VRF routing instance detail' },
                    ],
                })

                sections.push({
                    title: '🌐 IRB / Inter-VLAN Routing',
                    open: false,
                    commands: [
                        { command: 'show interfaces irb terse', description: 'IRB interface status' },
                        { command: 'show interfaces irb.100 | match "Hardware|Current"', description: 'Verify anycast MAC' },
                        { command: 'show route table EVPN-VRF.inet.0', description: 'VRF routing table' },
                        { command: 'show route table EVPN-VRF.evpn.0 match-prefix "5:*"', description: 'Type-5 prefix routes' },
                        { command: 'ping routing-instance EVPN-VRF <ip> source <irb-ip>', description: 'Test VRF connectivity' },
                    ],
                })
            }

            const hasEsi = (node.startupConfig ?? '').includes('esi') || (node.ports ?? []).some((p: any) => (p.description ?? '').toLowerCase().includes('esi'))
            if (hasEsi) {
                sections.push({
                    title: '🔀 ESI-LAG / Multi-Homing',
                    open: false,
                    commands: [
                        { command: 'show evpn instance extensive | match "ESI|DF|Designated"', description: 'ESI and DF status' },
                        { command: 'show interfaces ae0 terse', description: 'LAG interface status' },
                        { command: 'show lacp interfaces ae0', description: 'LACP negotiation' },
                        { command: 'show evpn instance designated-forwarder', description: 'DF election result' },
                        { command: 'show evpn instance esi <esi> local-bias', description: 'Local bias state' },
                        { command: 'show evpn instance extensive | match "core-isolation"', description: 'Core isolation check' },
                    ],
                })
            }

            const hasSR = (node.startupConfig ?? '').includes('source-packet-routing') || (node.startupConfig ?? '').includes('nodeSid')
            if (hasSR) {
                sections.push({
                    title: '🏷️ SR-MPLS / SPRING',
                    open: false,
                    commands: [
                        { command: 'show isis overview | no-more', description: 'IS-IS status, SRGB, Node SID, SPRING state' },
                        { command: 'show isis adjacency extensive', description: 'IS-IS adjacencies with Adj-SIDs' },
                        { command: 'show isis database extensive | match "Node SID|SRGB|SPRING"', description: 'Node SID/SRGB from IS-IS DB' },
                        { command: 'show isis database <sys-id> detail', description: 'Specific node IS-IS LSP detail' },
                        { command: 'show route table inet.3', description: 'Labeled unicast routes (SR forwarding)' },
                        { command: 'show route table mpls.0 label <label>', description: 'MPLS label forwarding entry' },
                        { command: 'show route table mpls.0 label <label> detail', description: 'Detailed label operation (Push/Swap/Pop)' },
                        { command: 'show mpls label usage', description: 'MPLS label allocation ranges' },
                        { command: 'show spring-traffic-engineering overview', description: 'SPRING-TE status' },
                        { command: 'show spring-traffic-engineering lsp detail', description: 'SR-TE LSP details' },
                        { command: 'traceroute mpls segment-routing isis <prefix>', description: 'SR-MPLS path trace' },
                    ],
                })

                sections.push({
                    title: '🛡️ TI-LFA / Fast Reroute',
                    open: false,
                    commands: [
                        { command: 'show isis overview | match Backup', description: 'Post-Convergence Backup status' },
                        { command: 'show isis interface ge-* extensive | match "Protection"', description: 'Per-interface TI-LFA protection state' },
                        { command: 'show isis backup spf results level 2 <dest>', description: 'TI-LFA backup SPF calculation for destination' },
                        { command: 'run show route <prefix> table inet.3 detail | match "entry|L-ISIS|weight|operation"', description: 'Primary + backup paths with label ops' },
                        { command: 'show isis interface ge-* extensive | match "Post convergence|Node cost|Fate"', description: 'Post-convergence and fate-sharing status' },
                        { command: 'show mpls fate-sharing', description: 'MPLS fate-sharing groups' },
                        { command: 'show bfd session', description: 'BFD session status (fast failure detection)' },
                        { command: 'show bfd session extensive | match "State|Interface|Minimum"', description: 'BFD timers and state detail' },
                    ],
                })
            }

            const hasLdp = (node.startupConfig ?? '').includes('ldp') || (node.startupConfig ?? '').includes('mplsLdp')
            if (hasSR && hasLdp) {
                sections.push({
                    title: '🔄 SR-LDP Interworking',
                    open: false,
                    commands: [
                        { command: 'show ldp database', description: 'LDP label database (input/output labels)' },
                        { command: 'show ldp session', description: 'LDP session status with neighbors' },
                        { command: 'show ldp neighbor', description: 'LDP neighbor discovery' },
                        { command: 'show isis source-packet-routing mapping-server', description: 'SR mapping server entries' },
                        { command: 'show route table mpls.0 | match "LDP|L-ISIS"', description: 'MPLS table — SR vs LDP labels' },
                        { command: 'show route table inet.3 detail | match "protocol|Push|Swap|Pop"', description: 'Label operations per prefix' },
                    ],
                })
            }

            const hasSRv6 = (node.startupConfig ?? '').includes('srv6') || (node.startupConfig ?? '').includes('srv6Locator')
            if (hasSRv6) {
                sections.push({
                    title: '🌐 SRv6',
                    open: false,
                    commands: [
                        { command: 'show isis overview | match "SRv6|Locator"', description: 'SRv6 locator and status' },
                        { command: 'show route table inet6.3', description: 'IPv6 labeled routes (SRv6 forwarding)' },
                        { command: 'show route table inet6.0 match-prefix "fc00:*"', description: 'SRv6 locator prefixes' },
                        { command: 'show isis database extensive | match "SRv6|Locator|End"', description: 'SRv6 SIDs from IS-IS DB' },
                        { command: 'show route fec0:0:0:*/128 detail', description: 'SRv6 End SID forwarding' },
                        { command: 'traceroute <ipv6-dest> source <loopback-v6>', description: 'IPv6 path trace' },
                    ],
                })
            }

            const hasOism = (node.startupConfig ?? '').includes('oism') || (node.startupConfig ?? '').includes('igmp-snooping')
            if (hasOism) {
                sections.push({
                    title: '📡 OISM / Multicast',
                    open: false,
                    commands: [
                        { command: 'show igmp-snooping evpn', description: 'IGMP snooping EVPN state' },
                        { command: 'show igmp-snooping membership', description: 'Multicast group membership' },
                        { command: 'show igmp-snooping route', description: 'IGMP snooping route table' },
                        { command: 'show evpn multicast-snooping', description: 'EVPN SMET Type-6 routes' },
                        { command: 'show evpn instance extensive | match "multicast|SMET|assisted"', description: 'OISM/AR status' },
                        { command: 'show pim interfaces', description: 'PIM interface status' },
                        { command: 'show pim rps extensive', description: 'PIM RP information' },
                        { command: 'show pim join extensive', description: 'PIM join/prune state' },
                        { command: 'show multicast route extensive', description: 'Multicast forwarding table' },
                        { command: 'show ethernet-switching flood vlan <vlan>', description: 'BUM flood list (AR optimization)' },
                    ],
                })
            }

            const hasVlans = (node.vlans ?? []).length > 0
            if (hasVlans) {
                sections.push({
                    title: '🔌 L2 / VLANs',
                    open: false,
                    commands: [
                        { command: 'show vlans', description: 'VLAN list and status' },
                        { command: 'show ethernet-switching interface', description: 'Port VLAN membership' },
                        { command: 'show ethernet-switching table', description: 'MAC address table' },
                        { command: 'show spanning-tree bridge', description: 'RSTP bridge status' },
                        { command: 'show spanning-tree interface', description: 'RSTP port roles' },
                        { command: 'show ethernet-switching storm-control interface', description: 'Storm control stats' },
                    ],
                })
            }

            sections.push({
                title: '📋 EVPN Tracing (Enable for Debug)',
                open: false,
                commands: [
                    { command: 'set protocols evpn traceoptions file evpn.log size 50m', description: 'Enable EVPN logging' },
                    { command: 'set protocols evpn traceoptions flag all', description: 'Log all EVPN events' },
                    { command: 'set protocols l2-learning traceoptions file l2ald.log size 50m', description: 'Enable L2ALD logging' },
                    { command: 'set protocols l2-learning traceoptions flag all', description: 'Log all L2 events' },
                    { command: 'set protocols l2-learning traceoptions in-memory-debug', description: 'Enable in-memory trace' },
                    { command: 'show ethernet-switching debug trace', description: 'Dump in-memory trace' },
                ],
            })

            // Telemetry validation (if telemetry is enabled)
            const hasTelemetry = node.telemetryEnabled || (node.startupConfig ?? '').includes('grpc') || (node.startupConfig ?? '').includes('telemetry')
            if (hasTelemetry) {
                sections.push({
                    title: '📡 Telemetry Validation',
                    open: false,
                    commands: [
                        { command: 'show system services extension-service request-response grpc', description: 'gRPC service status' },
                        { command: 'show agent sensors', description: 'Active telemetry sensors' },
                        { command: 'show services analytics streaming-server', description: 'Streaming server connections' },
                        { command: 'show services analytics sensor', description: 'Sensor subscription status' },
                        { command: 'show services analytics export-profile', description: 'Export profile (interval, transport)' },
                        { command: 'show system connections | match 50051', description: 'Verify gRPC port listening' },
                        { command: 'show system processes extensive | match na-grpcd', description: 'gRPC daemon process status' },
                    ],
                })
            }

            sections.push({
                title: '📦 Collect for JTAC Support',
                open: false,
                commands: [
                    { command: 'request support information | save /var/tmp/rsi.txt', description: 'Full RSI' },
                    { command: 'request support information evpn-vxlan | save /var/tmp/rsi-evpn.txt', description: 'EVPN RSI (22.2+)' },
                    { command: 'show configuration | display set | save /var/tmp/config.txt', description: 'Running config' },
                    { command: 'show log messages | last 200', description: 'Recent system logs' },
                    { command: 'show system core-dumps', description: 'Check for crashes' },
                    { command: 'request system core-dump routing running', description: 'Live RPD core' },
                    { command: 'request system core-dump l2ald running', description: 'Live L2ALD core' },
                ],
            })
        } else if (vendor === 'sonic' || vendor === 'edgecore') {
            sections.push({
                title: '🔍 Basic System Health',
                open: true,
                commands: [
                    { command: 'show system status', description: 'System overview' },
                    { command: 'show interfaces status', description: 'Interface status' },
                    { command: 'show ip interfaces', description: 'IP interface config' },
                    { command: 'show lldp neighbors', description: 'LLDP neighbors' },
                ],
            })
            if (node.asn) {
                sections.push({
                    title: '📡 BGP',
                    open: false,
                    commands: [
                        { command: 'show ip bgp summary', description: 'BGP session summary' },
                        { command: 'show ip bgp neighbors', description: 'BGP neighbor details' },
                        { command: 'show ip route', description: 'IP routing table' },
                        { command: 'vtysh -c "show bgp summary"', description: 'FRR BGP summary' },
                    ],
                })
            }
        } else if (vendor === 'cisco') {
            // ── Cisco NX-OS / IOS-XR / IOS-XE troubleshooting ──
            sections.push({
                title: '🔍 Basic System Health',
                open: true,
                commands: [
                    { command: 'show version', description: 'Software version and uptime' },
                    { command: 'show module', description: 'Line card / module status' },
                    { command: 'show interface status', description: 'Port up/down summary' },
                    { command: 'show ip interface brief', description: 'L3 interface IP summary' },
                    { command: 'show lldp neighbors', description: 'LLDP topology' },
                    { command: 'show logging last 50', description: 'Recent syslog messages' },
                    { command: 'show processes cpu history', description: 'CPU utilization trend' },
                ],
            })

            const hasBgp = (node.asn ?? 0) > 0
            if (hasBgp) {
                sections.push({
                    title: '🛰️ BGP Underlay',
                    open: false,
                    commands: [
                        { command: 'show bgp summary', description: 'BGP session states' },
                        { command: 'show bgp ipv4 unicast neighbors <ip>', description: 'Detailed neighbor info' },
                        { command: 'show ip route bgp', description: 'BGP routes in RIB' },
                        { command: 'show bgp ipv4 unicast neighbors <ip> advertised-routes', description: 'Routes sent to peer' },
                        { command: 'show bgp ipv4 unicast neighbors <ip> received-routes', description: 'Routes received from peer' },
                        { command: 'show ip route <prefix> detail', description: 'Verify ECMP paths' },
                        { command: 'show bfd neighbors', description: 'BFD session status' },
                    ],
                })
            }

            const hasOverlay = node.overlayEnabled || (node.startupConfig ?? '').includes('evpn') || (node.startupConfig ?? '').includes('nve')
            if (hasOverlay) {
                sections.push({
                    title: '🔗 EVPN-VXLAN Overlay',
                    open: false,
                    commands: [
                        { command: 'show bgp l2vpn evpn summary', description: 'EVPN overlay sessions' },
                        { command: 'show nve peers', description: 'NVE VTEP peers' },
                        { command: 'show nve vni', description: 'VNI status and mappings' },
                        { command: 'show nve interface nve1', description: 'NVE interface details' },
                        { command: 'show l2route evpn mac all', description: 'EVPN MAC routes (Type-2)' },
                        { command: 'show l2route evpn mac-ip all', description: 'EVPN MAC-IP routes' },
                        { command: 'show bgp l2vpn evpn', description: 'All EVPN routes' },
                        { command: 'show bgp l2vpn evpn route-type 2', description: 'Type-2 MAC/IP routes' },
                        { command: 'show bgp l2vpn evpn route-type 5', description: 'Type-5 IP prefix routes' },
                        { command: 'show fabric forwarding anycast-gateway-mac', description: 'Anycast GW MAC' },
                        { command: 'show mac address-table dynamic', description: 'Dynamic MAC table' },
                        { command: 'show vxlan', description: 'VXLAN summary' },
                    ],
                })
            }

            const hasVpc = (node.startupConfig ?? '').includes('vpc') || (node.ports ?? []).some((p: any) => (p.description ?? '').toLowerCase().includes('vpc'))
            if (hasVpc) {
                sections.push({
                    title: '🔗 vPC Multi-Homing',
                    open: false,
                    commands: [
                        { command: 'show vpc', description: 'vPC domain status' },
                        { command: 'show vpc brief', description: 'vPC peer-link and keepalive status' },
                        { command: 'show vpc consistency-parameters global', description: 'vPC config consistency check' },
                        { command: 'show vpc role', description: 'vPC primary/secondary role' },
                        { command: 'show port-channel summary', description: 'Port-channel status' },
                        { command: 'show vpc orphan-ports', description: 'Single-attached (orphan) ports' },
                    ],
                })
            }

            const hasSR = (node.startupConfig ?? '').includes('segment-routing') || (node.startupConfig ?? '').includes('nodeSid')
            if (hasSR) {
                sections.push({
                    title: '🏷️ SR-MPLS / SPRING',
                    open: false,
                    commands: [
                        { command: 'show isis segment-routing label table', description: 'SRGB and Node SID labels' },
                        { command: 'show isis adjacency detail', description: 'IS-IS adjacencies with Adj-SIDs' },
                        { command: 'show isis database detail', description: 'IS-IS LSDB with SR TLVs' },
                        { command: 'show mpls forwarding-table', description: 'MPLS label forwarding table' },
                        { command: 'show segment-routing local-block', description: 'SRLB allocation' },
                        { command: 'show cef <prefix> detail', description: 'CEF with SR labels' },
                        { command: 'show isis fast-reroute summary', description: 'TI-LFA coverage summary' },
                        { command: 'show isis fast-reroute detail <prefix>', description: 'TI-LFA backup path detail' },
                        { command: 'show bfd neighbors', description: 'BFD for IS-IS fast detection' },
                        { command: 'traceroute mpls ipv4 <prefix>/<mask>', description: 'SR-MPLS path trace' },
                    ],
                })
            }

            const hasTelC = (node.startupConfig ?? '').includes('grpc') || (node.startupConfig ?? '').includes('telemetry')
            if (hasTelC) {
                sections.push({
                    title: '📡 Telemetry Validation',
                    open: false,
                    commands: [
                        { command: 'show telemetry transport', description: 'Telemetry transport sessions' },
                        { command: 'show telemetry data collector brief', description: 'Data collector status' },
                        { command: 'show telemetry control database subscriptions', description: 'Active subscriptions' },
                        { command: 'show telemetry control database sensor-groups', description: 'Sensor group config' },
                        { command: 'show telemetry control database destination-groups', description: 'Destination group config' },
                        { command: 'show grpc internal gnmi service statistics', description: 'gNMI service stats' },
                        { command: 'show system internal sysmgr service name grpc', description: 'gRPC daemon status' },
                    ],
                })
            }

            sections.push({
                title: '📦 Collect for TAC Support',
                open: false,
                commands: [
                    { command: 'show tech-support > bootflash:show-tech.txt', description: 'Full show-tech' },
                    { command: 'show running-config', description: 'Running configuration' },
                    { command: 'show logging logfile', description: 'System log file' },
                    { command: 'show system internal sysmgr service name bgp', description: 'BGP process status' },
                    { command: 'show cores', description: 'Check for process crashes' },
                ],
            })
        } else if (vendor === 'arista') {
            // ── Arista EOS troubleshooting ──
            sections.push({
                title: '🔍 Basic System Health',
                open: true,
                commands: [
                    { command: 'show version', description: 'Software version and uptime' },
                    { command: 'show interfaces status', description: 'Port up/down summary' },
                    { command: 'show ip interface brief', description: 'L3 interface IP summary' },
                    { command: 'show lldp neighbors', description: 'LLDP topology' },
                    { command: 'show logging last 50', description: 'Recent syslog messages' },
                    { command: 'show processes top once', description: 'CPU/memory usage' },
                ],
            })
            if ((node.asn ?? 0) > 0) {
                sections.push({
                    title: '🛰️ BGP Underlay',
                    open: false,
                    commands: [
                        { command: 'show bgp summary', description: 'BGP session states' },
                        { command: 'show bgp neighbors <ip>', description: 'Detailed neighbor info' },
                        { command: 'show ip route bgp', description: 'BGP routes in RIB' },
                        { command: 'show bgp evpn summary', description: 'EVPN session summary' },
                        { command: 'show bfd peers', description: 'BFD session status' },
                    ],
                })
            }
            const hasOverlayA = node.overlayEnabled || (node.startupConfig ?? '').includes('evpn')
            if (hasOverlayA) {
                sections.push({
                    title: '🔗 EVPN-VXLAN Overlay',
                    open: false,
                    commands: [
                        { command: 'show vxlan vtep', description: 'VXLAN VTEP peers' },
                        { command: 'show vxlan vni', description: 'VNI status and mappings' },
                        { command: 'show vxlan address-table', description: 'VXLAN MAC table' },
                        { command: 'show bgp evpn', description: 'All EVPN routes' },
                        { command: 'show bgp evpn route-type mac-ip', description: 'Type-2 MAC/IP routes' },
                        { command: 'show bgp evpn route-type ip-prefix', description: 'Type-5 IP prefix routes' },
                        { command: 'show interfaces vxlan 1', description: 'VXLAN interface details' },
                        { command: 'show mac address-table dynamic', description: 'Dynamic MAC table' },
                    ],
                })
            }
            const hasTelA = (node.startupConfig ?? '').includes('gnmi') || (node.startupConfig ?? '').includes('grpc')
            if (hasTelA) {
                sections.push({
                    title: '📡 Telemetry Validation',
                    open: false,
                    commands: [
                        { command: 'show management api gnmi', description: 'gNMI API status and transport' },
                        { command: 'show management api gnmi counters', description: 'gNMI request/response counters' },
                        { command: 'show management api gnmi provider', description: 'gNMI provider (eos-native/openconfig)' },
                        { command: 'show management api gnmi transport grpc', description: 'gRPC transport status and port' },
                        { command: 'show management api gnmi certificate', description: 'TLS certificate status' },
                    ],
                })
            }
            sections.push({
                title: '📦 Collect for TAC',
                open: false,
                commands: [
                    { command: 'show tech-support > flash:show-tech.txt', description: 'Full show-tech' },
                    { command: 'show running-config', description: 'Running configuration' },
                    { command: 'bash cat /var/log/messages | tail -100', description: 'System log tail' },
                ],
            })
        } else if (vendor === 'nokia') {
            // ── Nokia SR Linux troubleshooting ──
            sections.push({
                title: '🔍 Basic System Health',
                open: true,
                commands: [
                    { command: 'show version', description: 'Software version' },
                    { command: 'show interface brief', description: 'Interface summary' },
                    { command: 'show system lldp neighbor', description: 'LLDP neighbors' },
                    { command: 'show platform chassis', description: 'Chassis status' },
                    { command: 'show system utilization', description: 'CPU/memory usage' },
                ],
            })
            if ((node.asn ?? 0) > 0) {
                sections.push({
                    title: '🛰️ BGP Underlay',
                    open: false,
                    commands: [
                        { command: 'show network-instance default protocols bgp neighbor', description: 'BGP neighbors' },
                        { command: 'show network-instance default route-table ipv4-unicast summary', description: 'IPv4 route summary' },
                        { command: 'show network-instance default protocols bgp routes evpn summary', description: 'EVPN route summary' },
                        { command: 'show network-instance default protocols bgp neighbor <ip> detail', description: 'Neighbor detail' },
                        { command: 'show bfd network-instance default peer', description: 'BFD peers' },
                    ],
                })
            }
            const hasOverlayN = node.overlayEnabled || (node.startupConfig ?? '').includes('evpn')
            if (hasOverlayN) {
                sections.push({
                    title: '🔗 EVPN-VXLAN Overlay',
                    open: false,
                    commands: [
                        { command: 'show tunnel-interface vxlan-interface vtep detail', description: 'VTEP details' },
                        { command: 'show network-instance * protocols bgp routes evpn route-type 2 summary', description: 'Type-2 MAC/IP routes' },
                        { command: 'show network-instance * protocols bgp routes evpn route-type 5 summary', description: 'Type-5 IP prefix routes' },
                        { command: 'show network-instance * bridge-table mac-table all', description: 'MAC address table' },
                        { command: 'show network-instance * vxlan-interface *', description: 'VXLAN interface status' },
                    ],
                })
            }
            const hasTelN = (node.startupConfig ?? '').includes('grpc') || (node.startupConfig ?? '').includes('gnmi')
            if (hasTelN) {
                sections.push({
                    title: '📡 Telemetry Validation',
                    open: false,
                    commands: [
                        { command: 'info / system grpc', description: 'gRPC server configuration' },
                        { command: 'info / system grpc admin-state', description: 'gRPC admin state (enable/disable)' },
                        { command: 'info / system grpc services', description: 'Enabled gRPC services (gnmi, gribi, p4rt)' },
                        { command: 'info / system grpc tls-profile', description: 'TLS profile for gRPC' },
                        { command: 'tools system grpc-server status', description: 'gRPC server runtime status' },
                        { command: 'info / system grpc network-instance', description: 'Network instance for gRPC binding' },
                    ],
                })
            }
            sections.push({
                title: '📦 Collect for Support',
                open: false,
                commands: [
                    { command: 'info flat', description: 'Full flat configuration' },
                    { command: 'show system logging buffer', description: 'System log buffer' },
                    { command: 'tools system techsupport generate', description: 'Generate tech-support' },
                ],
            })
        } else {
            sections.push({
                title: '🔍 General Troubleshooting',
                open: true,
                commands: [
                    { command: 'show interfaces', description: 'Interface status' },
                    { command: 'show ip route', description: 'Routing table' },
                    { command: 'show lldp neighbors', description: 'LLDP topology' },
                ],
            })
        }

        return sections
    }

    private _buildConfigWindowHtml (label: string, config: string): string {
        const escaped = config.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        return `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0f1923; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif;
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid #1e2d42; background: #141e2d; flex-shrink: 0;
  }
  .title { font-size: 14px; font-weight: 600; }
  .actions { display: flex; gap: 8px; }
  .btn {
    border-radius: 6px; padding: 6px 16px; font-size: 12px; cursor: pointer;
    border: 1px solid #1e2d42; background: transparent; color: #6e8099;
    transition: background 0.12s, color 0.12s;
  }
  .btn:hover { background: #0a1120; color: #c9d1d9; }
  .btn-primary {
    background: rgba(59,130,246,0.12); border-color: rgba(59,130,246,0.4);
    color: #3b82f6; font-weight: 600;
  }
  .btn-primary:hover { background: rgba(59,130,246,0.22); }
  .btn-close { font-size: 16px; padding: 4px 10px; line-height: 1; }
  .btn-close:hover { color: #ef4444; border-color: #ef4444; }
  textarea {
    flex: 1; background: #060e18; border: none; color: #a8d8a8;
    font-size: 13px; font-family: 'Courier New', monospace;
    padding: 16px 20px; outline: none; resize: none; line-height: 1.6; width: 100%;
  }
  textarea::placeholder { color: #6e8099; opacity: 0.4; }
  .status { padding: 4px 16px; font-size: 10px; color: #6e8099; background: #141e2d;
    border-top: 1px solid #1e2d42; flex-shrink: 0; }
</style>
</head>
<body>
  <div class="header">
    <span class="title">Startup Config — ${label.replace(/</g, '&lt;')}</span>
    <div class="actions">
      <button class="btn" onclick="copyConfig()">Copy</button>
      <button class="btn btn-primary" onclick="saveConfig()">Save to Topology</button>
      <button class="btn btn-close" onclick="window.close()" title="Close">✕</button>
    </div>
  </div>
  <textarea id="cfg" spellcheck="false" placeholder="! Paste startup config here...">${escaped}</textarea>
  <div class="status" id="status">Edit config and click "Save to Topology" to apply changes.</div>
  <script>
    function copyConfig() {
      navigator.clipboard.writeText(document.getElementById('cfg').value).then(function() {
        document.getElementById('status').textContent = 'Copied to clipboard.';
        setTimeout(function() {
          document.getElementById('status').textContent = 'Edit config and click "Save to Topology" to apply changes.';
        }, 2000);
      });
    }
    function saveConfig() {
      var config = document.getElementById('cfg').value;
      if (window.opener) {
        window.opener.postMessage({ type: 'config-save', config: config }, '*');
        document.getElementById('status').textContent = 'Saved to topology ✓';
        setTimeout(function() {
          document.getElementById('status').textContent = 'Edit config and click "Save to Topology" to apply changes.';
        }, 2000);
      }
    }
    document.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveConfig(); }
    });
  </script>
</body>
</html>`
    }

    commitRename (): void {
        if (this.renamingId && this.renamingLabel.trim()) {
            this.svc.renameNode(this.renamingId, this.renamingLabel.trim())
        }
        this.renamingId = null
        this.cdr.markForCheck()
    }

    cancelRename (): void { this.renamingId = null; this.cdr.markForCheck() }

    onRenameKey (ev: KeyboardEvent): void {
        if (ev.key === 'Enter') { this.commitRename() }
        if (ev.key === 'Escape') { this.cancelRename() }
    }

    // ── Port picker ─────────────────────────────────────────────────────────

    private _portPickerOptions (nodeId: string): PortPickerOption[] {
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

        const options = node.ports
            .filter(p => p.enabled)
            .map(port => ({ port, available: !used.has(port.id) }))

        // Show available ports first, then in-use ports.
        options.sort((a, b) => Number(b.available) - Number(a.available))
        return options
    }

    /** For host/bridge nodes, fetch interfaces/bridges from server and build dynamic port picker options */
    private async _portPickerOptionsAsync (nodeId: string): Promise<PortPickerOption[]> {
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return [] }
        const api = (window as any).netopsAPI

        // Collect already-used interface/bridge names on this node's ports
        const usedPorts = new Set(
            this.topology.links.flatMap(l => {
                const r: string[] = []
                if (l.sourceNodeId === nodeId) { r.push(l.sourcePortId) }
                if (l.targetNodeId === nodeId) { r.push(l.targetPortId) }
                return r
            }),
        )
        const usedNames = new Set<string>()
        for (const pid of usedPorts) {
            const p = node.ports.find(x => x.id === pid)
            if (p) { usedNames.add(p.label) }
        }

        if (node.type === 'host') {
            const serverId = node.serverId || 'local'
            const cacheKey = `host:${serverId}`
            const cached = this._hostIfaceCache.get(cacheKey)
            let ifaces: Array<{ name: string; state: string }>
            if (cached && Date.now() - cached.ts < this._CACHE_TTL) {
                ifaces = cached.ifaces
            } else if (api?.clabListHostInterfaces) {
                try {
                    const res = await api.clabListHostInterfaces({ serverId })
                    ifaces = res?.ok ? (res.interfaces ?? []) : []
                    this._hostIfaceCache.set(cacheKey, { ts: Date.now(), ifaces })
                } catch { ifaces = [] }
            } else { ifaces = [] }
            return ifaces.map(iface => ({
                port: { id: `__iface__${iface.name}`, label: iface.name, enabled: true },
                available: !usedNames.has(iface.name),
                displayLabel: `${iface.name} (${iface.state})`,
            }))
        }

        if (node.type === 'bridge') {
            const serverId = node.serverId || 'local'
            const cacheKey = `bridge:${serverId}`
            const cached = this._bridgeListCache.get(cacheKey)
            let bridges: Array<{ name: string; type: string; state: string }>
            if (cached && Date.now() - cached.ts < this._CACHE_TTL) {
                bridges = cached.bridges
            } else if (api?.bridgeList) {
                try {
                    const res = await api.bridgeList({ serverId })
                    bridges = res?.ok ? (res.bridges ?? []) : []
                    this._bridgeListCache.set(cacheKey, { ts: Date.now(), bridges })
                } catch { bridges = [] }
            } else { bridges = [] }
            return bridges.map(br => ({
                port: { id: `__bridge__${br.name}`, label: br.name, enabled: true },
                available: !usedNames.has(br.name),
                displayLabel: `${br.name} (${br.type}${br.state ? ', ' + br.state : ''})`,
            }))
        }

        return this._portPickerOptions(nodeId)
    }

    private _openPortPicker (ctx: string, node: TopologyNode, ev: MouseEvent | null): void {
        const nodeId = ctx.slice(4)
        const isHostOrBridge = node.type === 'host' || node.type === 'bridge'
        this.portPickerNodeType = node.type

        // Position near cursor or node centre
        const svgR = this.svgRef.nativeElement.getBoundingClientRect()
        const posX = ev ? ev.clientX - svgR.left + 8 : (node.x + NODE_W / 2) * this.vpScale + this.vpX + 8
        const posY = ev ? ev.clientY - svgR.top : (node.y + NODE_H / 2) * this.vpScale + this.vpY

        if (isHostOrBridge) {
            // Async: fetch interfaces/bridges from server, then show picker
            this.portPickerCtx = ctx
            this.portPickerPorts = []
            this.portPickerLoading = true
            this.portPickerX = posX
            this.portPickerY = posY
            this.cdr.markForCheck()
            this._portPickerOptionsAsync(nodeId).then(options => {
                if (this.portPickerCtx !== ctx) { return } // stale
                this.portPickerPorts = options
                this.portPickerLoading = false
                if (!options.length) {
                    this.statusMsg = node.type === 'host' ? 'No interfaces found on server' : 'No bridges found on server'
                } else if (!options.some(p => p.available)) {
                    this.statusMsg = 'All interfaces/bridges already assigned'
                }
                this.cdr.markForCheck()
            })
        } else {
            const options = this._portPickerOptions(nodeId)
            if (!options.length) {
                this.statusMsg = 'No enabled ports on that node'
                this.pendingLink = null
                this.cdr.markForCheck()
                return
            }
            this.portPickerCtx   = ctx
            this.portPickerPorts = options
            this.portPickerLoading = false
            if (!options.some(p => p.available)) {
                this.statusMsg = 'All ports are currently in use'
            }
            this.portPickerX = posX
            this.portPickerY = posY
            this.cdr.markForCheck()
        }
    }

    /** Open port picker at explicit canvas-wrap coordinates (used by context menu Add Link). */
    private _openPortPickerAt (ctx: string, node: TopologyNode, x: number, y: number): void {
        const nodeId = ctx.slice(4)
        const isHostOrBridge = node.type === 'host' || node.type === 'bridge'
        this.portPickerNodeType = node.type

        if (isHostOrBridge) {
            this.portPickerCtx = ctx
            this.portPickerPorts = []
            this.portPickerLoading = true
            this.portPickerX = x
            this.portPickerY = y
            this.cdr.markForCheck()
            this._portPickerOptionsAsync(nodeId).then(options => {
                if (this.portPickerCtx !== ctx) { return }
                this.portPickerPorts = options
                this.portPickerLoading = false
                if (!options.length) {
                    this.statusMsg = node.type === 'host' ? 'No interfaces found on server' : 'No bridges found on server'
                }
                this.cdr.markForCheck()
            })
            return
        }

        const options = this._portPickerOptions(nodeId)
        if (!options.length) {
            this.statusMsg = 'No enabled ports on that node'
            this.pendingLink = null
            this.cdr.markForCheck()
            return
        }
        this.portPickerCtx   = ctx
        this.portPickerPorts = options
        this.portPickerLoading = false
        if (!options.some(p => p.available)) {
            this.statusMsg = 'All ports are currently in use'
        }
        this.portPickerX     = x
        this.portPickerY     = y
        this.cdr.markForCheck()
    }

    onPortPick (option: PortPickerOption): void {
        if (!option.available) {
            this.statusMsg = `Port ${option.port.label} is already in use`
            this.cdr.markForCheck()
            return
        }

        let port = option.port
        const ctx = this.portPickerCtx ?? ''
        const nodeId = ctx.slice(4)

        // For host/bridge picks from server list, find or create a real port and assign the name
        if (port.id.startsWith('__iface__') || port.id.startsWith('__bridge__')) {
            const name = port.label  // the interface/bridge name
            const node = this.topology.nodes.find(n => n.id === nodeId)
            if (!node) { return }

            // Find an unused port already assigned to this name
            let realPort = node.ports.find(p => p.label === name)
            if (!realPort) {
                // Find first unassigned port
                const usedPortIds = new Set(
                    this.topology.links.flatMap(l => {
                        const r: string[] = []
                        if (l.sourceNodeId === nodeId) { r.push(l.sourcePortId) }
                        if (l.targetNodeId === nodeId) { r.push(l.targetPortId) }
                        return r
                    }),
                )
                const isGeneric = (lbl: string) => node.type === 'host'
                    ? (!lbl || lbl === 'NIC' || /^NIC\d+$/.test(lbl))
                    : (!lbl || lbl === 'br' || /^br\d+$/.test(lbl))
                realPort = node.ports.find(p => !usedPortIds.has(p.id) && isGeneric(p.label))

                const isFirstPort = node.ports.length === 0 || (!realPort && node.ports.every(p => {
                    const usedPortIds2 = new Set(
                        this.topology.links.flatMap(l => {
                            const r: string[] = []
                            if (l.sourceNodeId === nodeId) { r.push(l.sourcePortId) }
                            if (l.targetNodeId === nodeId) { r.push(l.targetPortId) }
                            return r
                        }),
                    )
                    return usedPortIds2.has(p.id) || !isGeneric(p.label)
                }))

                if (!realPort) {
                    // No available port — auto-add a new one
                    const idx = node.ports.length
                    const prefix = node.type === 'host' ? 'nic' : 'br'
                    realPort = { id: `${prefix}${idx}`, label: name, enabled: true }
                    this.svc.updateNodeConfig(nodeId, { ports: [...node.ports, realPort] } as any)
                } else {
                    // Assign the name to the port
                    this.svc.updatePort(nodeId, realPort.id, { label: name })
                }

                // Update legacy single-value fields for backward compat (first assigned port)
                if (node.type === 'host' && (isFirstPort || node.ports.length <= 1)) {
                    this.svc.updateNodeConfig(nodeId, { hostInterface: name })
                }
                if (node.type === 'bridge' && (isFirstPort || node.ports.length <= 1)) {
                    this.svc.updateNodeConfig(nodeId, { bridgeName: name })
                }
            }
            port = realPort
        }

        if (ctx.startsWith('src:')) {
            this.pendingLink = { sourceNodeId: nodeId, sourcePortId: port.id }
            this.portPickerCtx = null
            this.statusMsg = `Drawing link from port ${port.label} — click target node`
        } else if (ctx.startsWith('tgt:') && this.pendingLink) {
            let result: TopologyLink | null
            if (this.pendingLink.sourceAnnotationId) {
                // Source is a shape, target is a node
                result = this.svc.addShapeLink({
                    sourceAnnotationId: this.pendingLink.sourceAnnotationId,
                    targetNodeId: nodeId,
                    targetPortId: port.id,
                })
            } else {
                result = this.svc.addLink(
                    this.pendingLink.sourceNodeId, this.pendingLink.sourcePortId,
                    nodeId, port.id,
                )
            }
            if (this.linkModeActive) {
                this.statusMsg = result
                    ? `Link created — click another node to continue`
                    : 'Could not create link (port already in use?)'
            } else {
                this.statusMsg = result
                    ? `Link created: ${port.label}`
                    : 'Could not create link (port already in use?)'
            }
            this.pendingLink = null
            this.portPickerCtx = null
        }
        this.cdr.markForCheck()
    }

    closePortPicker (): void {
        this.portPickerCtx = null
        this.cdr.markForCheck()
    }

    // ── Link interactions ───────────────────────────────────────────────────

    onLinkHandleMouseDown (ev: MouseEvent, link: TopologyLink): void {
        ev.stopPropagation()
        ev.preventDefault()
        this._dragLinkId = link.id
        // Capture the perpendicular unit vector once at drag start
        const s = this._nodeMap.get(link.sourceNodeId)
        const t = this._nodeMap.get(link.targetNodeId)
        if (!s || !t) { return }
        const dx = this.nodeCx(t) - this.nodeCx(s)
        const dy = this.nodeCy(t) - this.nodeCy(s)
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        this._dragLinkPerpX = -dy / len
        this._dragLinkPerpY = dx / len
    }

    onLinkClick (ev: MouseEvent, link: TopologyLink): void {
        ev.stopPropagation()
        if (this._isMultiSelectIntent(ev)) {
            if (this.selectedLinkIds.has(link.id)) { this.selectedLinkIds.delete(link.id) }
            else { this.selectedLinkIds.add(link.id) }
            this._syncPrimarySelection()
            this.statusMsg = this._selectionStatus()
            this.closeCtxMenu()
            this.closePortPicker()
            this.cdr.markForCheck()
            return
        }

        this.selectedLinkIds = new Set([link.id])
        this.selectedNodeIds.clear()
        this._syncPrimarySelection()
        this.closeCtxMenu()
        this.closePortPicker()
        this.statusMsg = `Link selected — press Delete to remove`
    }

    @HostListener('document:click')
    onDocumentClick (): void {
        // Close dropdown menus when clicking anywhere outside the menu bar.
        // The menubar element has (click)='$event.stopPropagation()' so clicks
        // inside it do NOT reach this handler.
        this.closeMenus()
    }

    @HostListener('window:paste', ['$event'])
    onPaste (ev: ClipboardEvent): void {
        if (!this._isActiveTab) { return }
        if (this._isTextInputTarget(ev.target)) { return }
        this._handleClipboardImagePaste(ev)
    }

    @HostListener('window:keydown', ['$event'])
    onKeyDown (ev: KeyboardEvent): void {
        if (!this._isActiveTab) { return }
        // Admin panel: Ctrl+Shift+L
        if (ev.ctrlKey && ev.shiftKey && ev.key === 'L') {
            ev.preventDefault()
            this.toggleAdminPanel()
            return
        }
        if (this.showAdminPanel && ev.key === 'Escape') {
            ev.preventDefault()
            this.showAdminPanel = false
            this.cdr.markForCheck()
            return
        }
        if ((this.pendingLink || this._shapeDragSourceId) && ev.key === 'Escape') {
            ev.preventDefault()
            this.pendingLink = null
            this._shapeDragSourceId = null
            this._shapeDragAnchor = null
            this.statusMsg = ''
            this.cdr.markForCheck()
            return
        }
        if (this.showServiceDialog && ev.key === 'Escape') {
            ev.preventDefault()
            this.cancelServiceDialog()
            return
        }
        if (this.showClabDialog && ev.key === 'Escape') {
            ev.preventDefault()
            this.cancelClabDialog()
            return
        }
        if (this.showClabStatusDialog && ev.key === 'Escape') {
            ev.preventDefault()
            this.closeClabStatusDialog()
            return
        }
        if (this.showDetectLabDialog && ev.key === 'Escape') {
            ev.preventDefault()
            this.closeDetectLabDialog()
            return
        }
        if (this.showAutoIpDialog && ev.key === 'Escape') {
            ev.preventDefault()
            this.cancelAutoIpDialog()
            return
        }
        if (this.showAutoIpv6Dialog && ev.key === 'Escape') {
            ev.preventDefault()
            this.cancelAutoIpv6Dialog()
            return
        }
        // F1 → open Help window
        if (ev.key === 'F1') {
            ev.preventDefault()
            this.openHelpDialog()
            return
        }

        if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) {
            if (this._isTextInputTarget(ev.target)) { return }
            this.showShortcutsOverlay = !this.showShortcutsOverlay
            this.cdr.markForCheck()
            return
        }

        // Ctrl+Shift+S → Save Workspace (must come before Ctrl+S)
        if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 's') {
            ev.preventDefault()
            this.saveWorkspace()
            return
        }

        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
            ev.preventDefault()
            this.saveTopology()
            return
        }

        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'o') {
            ev.preventDefault()
            this.loadTopology()
            return
        }

        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f') {
            ev.preventDefault()
            this.showSearch = !this.showSearch
            if (!this.showSearch) { this.searchQuery = '' }
            this.cdr.markForCheck()
            return
        }

        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
            if (this._isTextInputTarget(ev.target)) { return }
            ev.preventDefault()
            if (ev.shiftKey) { this.redo() } else { this.undo() }
            return
        }

        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'y') {
            if (this._isTextInputTarget(ev.target)) { return }
            ev.preventDefault()
            this.redo()
            return
        }

        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'c') {
            if (this._isTextInputTarget(ev.target)) { return }
            ev.preventDefault()
            if (this.selectedNodeIds.size) { this.copyNodes(); return }
            if (this.selectedShapeIds.size > 0 || this.selectedShapeId) { this.copyShape(); return }
            if (this.selectedLinkIds.size) { this.copyLink(); return }
        }

        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'v') {
            if (this._isTextInputTarget(ev.target)) { return }
            if (this._linkClipboard && !this._clipboard.length && !this._shapeClipboard.length) { this.pasteLink(); return }
            if (this._shapeClipboard.length && !this._clipboard.length) { this.pasteShape(); return }
            this.pasteNodes()
            return
        }

        if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'a') {
            if (this._isTextInputTarget(ev.target)) { return }
            ev.preventDefault()
            this.selectAll()
            return
        }

        if (ev.key === 'Delete' || ev.key === 'Backspace') {
            if (this._isTextInputTarget(ev.target)) { return }
            if (this.renamingId) { return }
            const nodeIds = [...this.selectedNodeIds]
            const linkIds = [...this.selectedLinkIds]
            const shapeIds = [...this.selectedShapeIds]

            // Also include single-selected shape
            if (this.selectedShapeId && !shapeIds.includes(this.selectedShapeId)) {
                shapeIds.push(this.selectedShapeId)
            }

            // Filter out locked shapes
            const deletableShapeIds = shapeIds.filter(id => {
                const ann = (this.topology.annotations ?? []).find(a => a.id === id)
                return !ann?.locked
            })

            if (nodeIds.length || linkIds.length || deletableShapeIds.length) {
                const nodeIdSet = new Set(nodeIds)
                const explicitLinks = linkIds.filter(id => {
                    const link = this.svc.getLink(id)
                    if (!link) { return false }
                    return !nodeIdSet.has(link.sourceNodeId) && !nodeIdSet.has(link.targetNodeId)
                })

                explicitLinks.forEach(id => this.svc.removeLink(id))
                nodeIds.forEach(id => this.svc.removeNode(id))
                deletableShapeIds.forEach(id => this.svc.removeAnnotation(id))

                const removedCount = explicitLinks.length + nodeIds.length + deletableShapeIds.length
                this.selectedNodeIds.clear()
                this.selectedLinkIds.clear()
                this.selectedShapeIds.clear()
                this.selectedShapeId = null
                this._syncPrimarySelection()
                this.statusMsg = removedCount > 1 ? `${removedCount} items removed` : 'Item removed'
                this.cdr.markForCheck()
            }
        }
        if (ev.key === 'Escape') {
            this.pendingLink = null
            this.linkModeActive = false
            this._linkDragSourceId = null
            this.closePortPicker()
            this.closeCtxMenu()
            this.closeCtxLinkMenu()
            this.closeMenus()
            if (this.editingAnnotationId) { this.editingAnnotationId = null }
            if (this.editingDescription) { this.cancelDescription() }
            if (this.selectedNodeIds.size || this.selectedLinkIds.size) {
                this.clearSelection()
            }
            this.statusMsg = 'Ready'
            this.cdr.markForCheck()
        }

        // Link mode toggle with L key
        if (ev.key === 'l' || ev.key === 'L') {
            if (this._isTextInputTarget(ev.target)) { return }
            this.toggleLinkMode()
        }
    }

    // ── Global mouse events ─────────────────────────────────────────────────

    /** Snap a coordinate to the nearest grid line (grid = 20px) */
    private _snap (v: number): number { const g = this.gridCellSize; return Math.round(v / g) * g }

    /** Compute snap guides for a dragged node against other nodes */
    private _computeSnapGuides (draggedId: string, rawX: number, rawY: number): { x: number; y: number } {
        const nodes = this.topology?.nodes
        if (!nodes || nodes.length < 2) {
            this.snapGuides = []
            this.snapDistanceMarkers = []
            return { x: rawX, y: rawY }
        }
        const tol = this._snapTolerance
        const dw = this.nodeW(this._dragNode!), dh = this.nodeH(this._dragNode!)
        const dMidX = rawX + dw / 2, dMidY = rawY + dh / 2
        const dRight = rawX + dw, dBottom = rawY + dh

        let snapX = rawX, snapY = rawY
        let bestDx = tol + 1, bestDy = tol + 1
        const guides: Array<{ type: 'h' | 'v'; pos: number; from: number; to: number }> = []
        const distMarkers: Array<{ x: number; y: number; dist: number; horizontal: boolean }> = []

        for (const n of nodes) {
            if (n.id === draggedId) { continue }
            const nw = this.nodeW(n), nh = this.nodeH(n)
            const nMidX = n.x + nw / 2, nMidY = n.y + nh / 2
            const nRight = n.x + nw, nBottom = n.y + nh

            // Vertical guides (x alignment): left-left, center-center, right-right
            const vChecks = [
                { dragVal: rawX, refVal: n.x, label: 'left' },
                { dragVal: dMidX, refVal: nMidX, label: 'center' },
                { dragVal: dRight, refVal: nRight, label: 'right' },
                { dragVal: rawX, refVal: nRight, label: 'left-right' },
                { dragVal: dRight, refVal: n.x, label: 'right-left' },
            ]
            for (const vc of vChecks) {
                const diff = Math.abs(vc.dragVal - vc.refVal)
                if (diff < tol && diff < bestDx) {
                    bestDx = diff
                    snapX = rawX + (vc.refVal - vc.dragVal)
                }
            }

            // Horizontal guides (y alignment): top-top, middle-middle, bottom-bottom
            const hChecks = [
                { dragVal: rawY, refVal: n.y, label: 'top' },
                { dragVal: dMidY, refVal: nMidY, label: 'middle' },
                { dragVal: dBottom, refVal: nBottom, label: 'bottom' },
                { dragVal: rawY, refVal: nBottom, label: 'top-bottom' },
                { dragVal: dBottom, refVal: n.y, label: 'bottom-top' },
            ]
            for (const hc of hChecks) {
                const diff = Math.abs(hc.dragVal - hc.refVal)
                if (diff < tol && diff < bestDy) {
                    bestDy = diff
                    snapY = rawY + (hc.refVal - hc.dragVal)
                }
            }
        }

        // Rebuild guides using snapped position
        const finalMidX = snapX + dw / 2, finalMidY = snapY + dh / 2
        const finalRight = snapX + dw, finalBottom = snapY + dh

        for (const n of nodes) {
            if (n.id === draggedId) { continue }
            const nw = this.nodeW(n), nh = this.nodeH(n)
            const nMidX = n.x + nw / 2, nMidY = n.y + nh / 2
            const nRight = n.x + nw, nBottom = n.y + nh

            // Vertical guides
            const vAligns = [
                { val: snapX, ref: n.x },
                { val: finalMidX, ref: nMidX },
                { val: finalRight, ref: nRight },
            ]
            for (const va of vAligns) {
                if (Math.abs(va.val - va.ref) < 1) {
                    const minY = Math.min(snapY, n.y) - 20
                    const maxY = Math.max(finalBottom, nBottom) + 20
                    guides.push({ type: 'v', pos: va.ref, from: minY, to: maxY })
                }
            }

            // Horizontal guides
            const hAligns = [
                { val: snapY, ref: n.y },
                { val: finalMidY, ref: nMidY },
                { val: finalBottom, ref: nBottom },
            ]
            for (const ha of hAligns) {
                if (Math.abs(ha.val - ha.ref) < 1) {
                    const minX = Math.min(snapX, n.x) - 20
                    const maxX = Math.max(finalRight, nRight) + 20
                    guides.push({ type: 'h', pos: ha.ref, from: minX, to: maxX })
                }
            }

            // Distance markers when edges are close (within 80px)
            const hGap = snapX - nRight
            if (hGap > 0 && hGap < 80 && Math.abs(finalMidY - nMidY) < dh) {
                distMarkers.push({ x: nRight + hGap / 2, y: Math.min(finalMidY, nMidY), dist: Math.round(hGap), horizontal: true })
            }
            const hGap2 = n.x - finalRight
            if (hGap2 > 0 && hGap2 < 80 && Math.abs(finalMidY - nMidY) < dh) {
                distMarkers.push({ x: finalRight + hGap2 / 2, y: Math.min(finalMidY, nMidY), dist: Math.round(hGap2), horizontal: true })
            }
            const vGap = snapY - nBottom
            if (vGap > 0 && vGap < 80 && Math.abs(finalMidX - nMidX) < dw) {
                distMarkers.push({ x: Math.min(finalMidX, nMidX), y: nBottom + vGap / 2, dist: Math.round(vGap), horizontal: false })
            }
            const vGap2 = n.y - finalBottom
            if (vGap2 > 0 && vGap2 < 80 && Math.abs(finalMidX - nMidX) < dw) {
                distMarkers.push({ x: Math.min(finalMidX, nMidX), y: finalBottom + vGap2 / 2, dist: Math.round(vGap2), horizontal: false })
            }
        }

        // Deduplicate guides (keep unique by type+pos)
        const seen = new Set<string>()
        this.snapGuides = guides.filter(g => {
            const key = `${g.type}:${Math.round(g.pos)}`
            if (seen.has(key)) { return false }
            seen.add(key)
            return true
        })
        this.snapDistanceMarkers = distMarkers
        return { x: snapX, y: snapY }
    }

    /** Compute snap guides for shape (annotation) dragging — checks against other shapes and nodes */
    private _computeShapeSnapGuides (draggedId: string, rawX: number, rawY: number, dw: number, dh: number): { x: number; y: number } {
        const tol = this._snapTolerance
        const dMidX = rawX + dw / 2, dMidY = rawY + dh / 2
        const dRight = rawX + dw, dBottom = rawY + dh

        let snapX = rawX, snapY = rawY
        let bestDx = tol + 1, bestDy = tol + 1
        const guides: Array<{ type: 'h' | 'v'; pos: number; from: number; to: number }> = []

        // Collect all reference rectangles: other shapes + nodes
        const refs: Array<{ id: string; x: number; y: number; w: number; h: number }> = []
        for (const ann of (this.topology.annotations ?? [])) {
            if (ann.id === draggedId) continue
            refs.push({ id: ann.id, x: ann.x, y: ann.y, w: ann.width ?? 120, h: ann.height ?? 80 })
        }
        for (const n of (this.topology.nodes ?? [])) {
            refs.push({ id: n.id, x: n.x, y: n.y, w: this.nodeW(n), h: this.nodeH(n) })
        }
        if (refs.length === 0) { this.snapGuides = []; this.snapDistanceMarkers = []; return { x: rawX, y: rawY } }

        for (const r of refs) {
            const rMidX = r.x + r.w / 2, rMidY = r.y + r.h / 2
            const rRight = r.x + r.w, rBottom = r.y + r.h
            // Vertical (x) alignment
            for (const [dv, rv] of [[rawX, r.x], [dMidX, rMidX], [dRight, rRight], [rawX, rRight], [dRight, r.x]]) {
                const diff = Math.abs(dv - rv)
                if (diff < tol && diff < bestDx) { bestDx = diff; snapX = rawX + (rv - dv) }
            }
            // Horizontal (y) alignment
            for (const [dv, rv] of [[rawY, r.y], [dMidY, rMidY], [dBottom, rBottom], [rawY, rBottom], [dBottom, r.y]]) {
                const diff = Math.abs(dv - rv)
                if (diff < tol && diff < bestDy) { bestDy = diff; snapY = rawY + (rv - dv) }
            }
        }
        // Rebuild guide lines
        const fMidX = snapX + dw / 2, fRight = snapX + dw, fMidY = snapY + dh / 2, fBottom = snapY + dh
        for (const r of refs) {
            const rMidX = r.x + r.w / 2, rRight = r.x + r.w, rMidY = r.y + r.h / 2, rBottom = r.y + r.h
            for (const [sv, rv] of [[snapX, r.x], [fMidX, rMidX], [fRight, rRight]]) {
                if (Math.abs(sv - rv) < 1) {
                    guides.push({ type: 'v', pos: rv, from: Math.min(snapY, r.y) - 20, to: Math.max(fBottom, rBottom) + 20 })
                }
            }
            for (const [sv, rv] of [[snapY, r.y], [fMidY, rMidY], [fBottom, rBottom]]) {
                if (Math.abs(sv - rv) < 1) {
                    guides.push({ type: 'h', pos: rv, from: Math.min(snapX, r.x) - 20, to: Math.max(fRight, rRight) + 20 })
                }
            }
        }
        const seen = new Set<string>()
        this.snapGuides = guides.filter(g => { const k = `${g.type}:${Math.round(g.pos)}`; if (seen.has(k)) return false; seen.add(k); return true })
        this.snapDistanceMarkers = []
        return { x: snapX, y: snapY }
    }

    /** Clear snap guides */
    private _clearSnapGuides (): void {
        if (this.snapGuides.length || this.snapDistanceMarkers.length) {
            this.snapGuides = []
            this.snapDistanceMarkers = []
        }
    }

    @HostListener('mousemove', ['$event'])
    onMouseMove (ev: MouseEvent): void {
        if (this._handleNodeResize(ev)) { return }
        if (this._handleShapeResize(ev)) { return }
        if (this._dragNode) {
            const pt = this.svgPt(ev)
            let rawX = pt.x - this._dragOX
            let rawY = pt.y - this._dragOY
            if (!ev.shiftKey) {
                rawX = this._snap(rawX)
                rawY = this._snap(rawY)
            }
            // Apply snap guides (Figma-style alignment)
            const snapped = this._computeSnapGuides(this._dragNode.id, rawX, rawY)
            this.svc.moveNode(this._dragNode.id, snapped.x, snapped.y)
            // Show drag coordinates
            this.dragCoords = { x: Math.round(snapped.x), y: Math.round(snapped.y) }
            // Invalidate link caches for links connected to this node
            this._invalidateLinkCachesForNode(this._dragNode.id)
            this._invalidateViewport()
            return
        }
        if (this._dragLinkId) {
            // Project mouse movement onto the perpendicular axis of the link
            const pt = this.svgPt(ev)
            const link = this._linkMap.get(this._dragLinkId)
            if (link) {
                const s = this._nodeMap.get(link.sourceNodeId)
                const t = this._nodeMap.get(link.targetNodeId)
                if (s && t) {
                    const mx = (this.nodeCx(s) + this.nodeCx(t)) / 2
                    const my = (this.nodeCy(s) + this.nodeCy(t)) / 2
                    // Project (mouse - midpoint) onto perpendicular
                    const newOffset = Math.round(
                        (pt.x - mx) * this._dragLinkPerpX +
                        (pt.y - my) * this._dragLinkPerpY,
                    )
                    this.svc.patchLink(link.id, { bendOffset: newOffset })
                }
            }
            return
        }
        if (this._dragAnnotation) {
            const pt = this.svgPt(ev)
            let newX = ev.shiftKey ? pt.x - this._dragAnnOX : this._snap(pt.x - this._dragAnnOX)
            let newY = ev.shiftKey ? pt.y - this._dragAnnOY : this._snap(pt.y - this._dragAnnOY)
            // Snap guides for shape dragging
            if (!ev.shiftKey) {
                const snapped = this._computeShapeSnapGuides(this._dragAnnotation.id, newX, newY,
                    this._dragAnnotation.width ?? 120, this._dragAnnotation.height ?? 80)
                newX = snapped.x; newY = snapped.y
            } else {
                this.snapGuides = []; this.snapDistanceMarkers = []
            }
            const dx = newX - this._dragAnnotation.x
            const dy = newY - this._dragAnnotation.y
            this.svc.updateAnnotation(this._dragAnnotation.id, { x: newX, y: newY })
            this._invalidateLinkCachesForAnnotation(this._dragAnnotation.id)
            this._invalidateViewport()
            // Move contained nodes if this is a zone
            if (this._dragAnnotation.isZone && this._dragAnnotation.zoneNodeIds?.length) {
                for (const nodeId of this._dragAnnotation.zoneNodeIds) {
                    const node = this._nodeMap.get(nodeId)
                    if (node) { this.svc.moveNode(nodeId, node.x + dx, node.y + dy) }
                }
            }
            return
        }
        // Rubber band selection drag
        if (this._rubberBand) {
            const pt = this.svgPt(ev)
            const ox = this._rubberBandOrigin.x, oy = this._rubberBandOrigin.y
            this.rubberBandRect = {
                x: Math.min(ox, pt.x), y: Math.min(oy, pt.y),
                w: Math.abs(pt.x - ox), h: Math.abs(pt.y - oy),
            }
            this.cdr.markForCheck()
            return
        }
        if (this._panning) {
            this.vpX += ev.movementX
            this.vpY += ev.movementY
            if (ev.movementX !== 0 || ev.movementY !== 0) { this._panMoved = true }
            this._invalidateViewport()
            this._scheduleRaf()
            return
        }
        // Rotation drag
        if (this._rotatingShape) {
            const pt = this.svgPt(ev)
            const ann = this._rotatingShape
            const cx = ann.x + (ann.width ?? 120) / 2
            const cy = ann.y + (ann.height ?? 80) / 2
            const angle = Math.atan2(pt.y - cy, pt.x - cx) * 180 / Math.PI + 90
            const snapped = ev.shiftKey ? angle : Math.round(angle / 15) * 15
            const normalized = ((snapped % 360) + 360) % 360
            this.svc.updateAnnotation(ann.id, { rotation: normalized })
            this.cdr.markForCheck()
            return
        }
        // Waypoint drag
        if (this._waypointDragLink && this._waypointDragIndex >= 0) {
            const pt = this.svgPt(ev)
            const link = this._linkMap.get(this._waypointDragLink!.id) ?? this._waypointDragLink
            const wp = [...(link.waypoints ?? [])]
            wp[this._waypointDragIndex] = { x: this._snap(pt.x), y: this._snap(pt.y) }
            this.svc.updateLinkConfig(link.id, { waypoints: wp } as any)
            this.cdr.markForCheck()
            return
        }
        // Label drag: reposition individual label using t + perpOffset
        // Only start actual drag after moving > 4px to allow click-to-edit
        if (this._labelDragLink && this._labelDragLabelId && this._labelDragStartMouse) {
            const pt = this.svgPt(ev)
            const dist = Math.hypot(pt.x - this._labelDragStartMouse.x, pt.y - this._labelDragStartMouse.y)
            if (dist > 4) {
                this._labelDragMoved = true
                const { t, perpOffset } = this._pointToLinkParams(this._labelDragLink, pt.x, pt.y)
                const link = this._linkMap.get(this._labelDragLink!.id) ?? this._labelDragLink
                const labels = (link.labels ?? this._migrateLegacyLabels(link))
                    .map(l => l.id === this._labelDragLabelId ? { ...l, t, perpOffset } : l)
                this.svc.updateLinkConfig(link.id, { labels, userLabel: undefined } as any)
            }
            this.cdr.markForCheck()
            return
        }
        // Endpoint drag: reposition link anchor along shape edge (must be checked before pendingLink)
        if (this._endpointDragLink) {
            const link = this._endpointDragLink
            const end = this._endpointDragEnd
            const annId = end === 'source' ? link.sourceAnnotationId : link.targetAnnotationId
            if (!annId) { return }
            const ann = this._annotationMap.get(annId)
            if (!ann) { return }
            const pt = this.svgPt(ev)
            const anchor = this._nearestEdgeAnchor(ann, pt.x, pt.y)
            const changes: Partial<TopologyLink> = end === 'source'
                ? { sourceAnchorX: anchor.x, sourceAnchorY: anchor.y }
                : { targetAnchorX: anchor.x, targetAnchorY: anchor.y }
            this.svc.updateLinkConfig(link.id, changes)
            this.cdr.markForCheck()
            return
        }
        if (this.pendingLink || this._linkDragSourceId || this._shapeDragSourceId) {
            const pt = this.svgPt(ev)
            this.pendingMouse = { x: pt.x, y: pt.y }
            this.cdr.markForCheck()
            return
        }
    }

    @HostListener('window:mouseup', ['$event'])
    onMouseUp (ev?: MouseEvent): void {
        if (!this._isActiveTab) { return }
        this._handleNodeResizeEnd()
        this._handleShapeResizeEnd()

        // Rubber band selection end
        if (this._rubberBand && this.rubberBandRect) {
            const r = this.rubberBandRect
            if (r.w > 5 || r.h > 5) {
                // Select nodes within rectangle
                for (const n of this.topology.nodes) {
                    const nw = n.width ?? NODE_W, nh = n.height ?? NODE_H
                    if (n.x + nw > r.x && n.x < r.x + r.w && n.y + nh > r.y && n.y < r.y + r.h) {
                        this.selectedNodeIds.add(n.id)
                    }
                }
                // Select shapes within rectangle
                for (const a of (this.topology.annotations ?? [])) {
                    const aw = a.width ?? 120, ah = a.height ?? 80
                    if (a.x + aw > r.x && a.x < r.x + r.w && a.y + ah > r.y && a.y < r.y + r.h) {
                        this.selectedShapeIds.add(a.id)
                    }
                }
                // Select links whose midpoint falls within the rectangle
                for (const l of this.topology.links) {
                    const mid = this.linkMidpoint(l)
                    if (mid.x >= r.x && mid.x <= r.x + r.w && mid.y >= r.y && mid.y <= r.y + r.h) {
                        this.selectedLinkIds.add(l.id)
                    }
                }
                this._syncPrimarySelection()
                this.statusMsg = this._selectionStatus()
            }
            this._rubberBand = false
            this.rubberBandRect = null
            this.cdr.markForCheck()
            return
        }

        // Rotation drag end
        if (this._rotatingShape) {
            this._rotatingShape = null
            this.cdr.markForCheck()
            return
        }

        // Waypoint drag end
        if (this._waypointDragLink) {
            this._waypointDragLink = null
            this._waypointDragIndex = -1
            this.cdr.markForCheck()
            return
        }

        // Label drag end — if mouse barely moved, treat as click → edit label
        if (this._labelDragLink && this._labelDragLabelId) {
            if (!this._labelDragMoved) {
                // Click (not drag) → open editor
                const link = this._linkMap.get(this._labelDragLink!.id)
                if (link) {
                    const lbl = this.getLinkLabels(link).find((l: any) => l.id === this._labelDragLabelId)
                    if (lbl) {
                        this.onLabelDblClick(new MouseEvent('dblclick'), link, lbl)
                    }
                }
            }
            this._labelDragLink = null
            this._labelDragLabelId = null
            this._labelDragStartMouse = null
            this._labelDragStartOffset = null
            this._labelDragMoved = false
            this.cdr.markForCheck()
            return
        }

        // Endpoint drag end (link anchor repositioning)
        if (this._endpointDragLink) {
            this._endpointDragLink = null
            this.cdr.markForCheck()
            return
        }

        // Shape drag-to-connect: check if released on a shape or empty canvas
        if (this._shapeDragSourceId) {
            const pt = ev ? this.svgPt(ev) : this.pendingMouse
            const targetShape = this._hitTestShape(pt.x, pt.y, this._shapeDragSourceId)
            if (targetShape) {
                // Compute target anchor from drop point
                const tAnchor = this._nearestEdgeAnchor(targetShape, pt.x, pt.y)
                console.log('[shape-drag] CREATE link srcAnchor:', this._shapeDragAnchor, 'tgtAnchor:', tAnchor, 'drop:', pt)
                this.svc.addShapeLink({
                    sourceAnnotationId: this._shapeDragSourceId,
                    sourceAnchorX: this._shapeDragAnchor?.x,
                    sourceAnchorY: this._shapeDragAnchor?.y,
                    targetAnnotationId: targetShape.id,
                    targetAnchorX: tAnchor.x,
                    targetAnchorY: tAnchor.y,
                })
                this.statusMsg = 'Link created'
            } else {
                // Check if released on a node (fallback for when onNodeMouseUp doesn't fire)
                const targetNode = this._hitTestNode(pt.x, pt.y)
                if (targetNode) {
                    const freePort = this.svc.freePorts(targetNode.id)?.[0]
                    if (freePort) {
                        this.svc.addShapeLink({
                            sourceAnnotationId: this._shapeDragSourceId,
                            sourceAnchorX: this._shapeDragAnchor?.x,
                            sourceAnchorY: this._shapeDragAnchor?.y,
                            targetNodeId: targetNode.id,
                            targetPortId: freePort.id,
                        })
                        this.statusMsg = 'Link created'
                    } else {
                        this.statusMsg = 'No free ports on target node'
                    }
                }
            }
            // else: released on empty canvas → cancelled silently
            this._shapeDragSourceId = null
            this._shapeDragAnchor = null
            this._dragNode = null
            this._dragAnnotation = null
            this._dragLinkId = null
            this._panning = false
            this._clearSnapGuides()
            this.dragGhostOrigin = null
            this.dragCoords = null
            this.cdr.markForCheck()
            return
        }

        this._dragNode = null
        this._dragAnnotation = null
        this._dragLinkId = null
        this._panning = false
        this._clearSnapGuides()
        this.dragGhostOrigin = null
        this.dragCoords = null
        if (this._linkDragSourceId) {
            // Released on empty canvas — cancel drag-to-connect
            this._linkDragSourceId = null
            this.pendingLink = null
            this.cdr.markForCheck()
        }
    }

    /** Hit-test: find a rectangle annotation at (x,y), excluding `excludeId` */
    private _hitTestShape (x: number, y: number, excludeId?: string): Annotation | null {
        for (const ann of (this.topology?.annotations ?? [])) {
            if (!this.isShapeType(ann.type) || ann.id === excludeId) { continue }
            // Bounding box test (works for all shapes as first pass)
            if (x >= ann.x && x <= ann.x + (ann.width ?? 0) && y >= ann.y && y <= ann.y + (ann.height ?? 0)) {
                return ann
            }
        }
        return null
    }

    /** Hit-test: find a node at (x,y) */
    private _hitTestNode (x: number, y: number): TopologyNode | null {
        for (const n of (this.topology?.nodes ?? [])) {
            const w = this.nodeW(n), h = this.nodeH(n)
            if (x >= n.x && x <= n.x + w && y >= n.y && y <= n.y + h) {
                return n
            }
        }
        return null
    }

    // ── Link geometry ────────────────────────────────────────────────────────

    nodeW (n: TopologyNode): number {
        return n.width ?? ((n.type === 'host' || n.type === 'bridge') ? this.infraNw : NODE_W)
    }
    nodeH (n: TopologyNode): number {
        return n.height ?? ((n.type === 'host' || n.type === 'bridge') ? this.infraNh : NODE_H)
    }
    nodeCx (n: TopologyNode): number { return n.x + this.nodeW(n) / 2 }
    nodeCy (n: TopologyNode): number { return n.y + this.nodeH(n) / 2 }

    /** Safe node lookup — O(1) via Map, returns a fallback at 0,0 if not found (for minimap) */
    private _emptyNode = { id: '', label: '', type: '' as any, x: 0, y: 0, status: '' as any, ports: [] } as TopologyNode
    getNodeById (id: string): TopologyNode {
        return this._nodeMap.get(id) ?? this._emptyNode
    }

    // Returns { index, total } of this link among all parallel links between the same endpoint pair.
    private _parallelInfo (link: TopologyLink): { index: number; total: number } {
        let cached = this._parallelCache.get(link.id)
        if (cached) { return cached }
        const endpointKey = (l: TopologyLink) => {
            const sKey = l.sourceAnnotationId || l.sourceNodeId
            const tKey = l.targetAnnotationId || l.targetNodeId
            return sKey < tKey ? `${sKey}|${tKey}` : `${tKey}|${sKey}`
        }
        const k = endpointKey(link)
        if (!k || k === '|') { return { index: 0, total: 1 } }
        const siblings = this.topology.links.filter(l => endpointKey(l) === k)
        cached = { index: siblings.indexOf(link), total: siblings.length }
        this._parallelCache.set(link.id, cached)
        return cached
    }

    // Base perpendicular offset before user bend adjustment.
    // Single link: small bow. Multiple parallel links: fan symmetrically.
    // Shape links with explicit anchors always use 0 — the anchors provide separation.
    private _baseOffset (link: TopologyLink): number {
        const hasAnchor = link.sourceAnchorX != null || link.targetAnchorX != null
        if (hasAnchor) { return 0 }
        const { index, total } = this._parallelInfo(link)
        if (total === 1) { return -20 }
        const step = 55
        const start = -((total - 1) / 2) * step
        return start + index * step
    }

    // Effective offset = base + user's manual bendOffset (curved) or lateral shift (straight).
    private _linkOffset (link: TopologyLink): number {
        return (link.bendOffset ?? 0) !== 0
            ? link.bendOffset!
            : this._baseOffset(link)
    }

    /**
     * Resolve a link endpoint to {x, y}.
     * For shapes, returns the edge intersection toward the other endpoint (not center).
     * `otherPt` is the other endpoint's center — used to compute edge intersection.
     */
    private _linkEndpoint (
        nodeId: string, annotationId: string | undefined,
        otherPt?: { x: number; y: number },
        anchorX?: number, anchorY?: number,
    ): { x: number; y: number } | null {
        if (annotationId) {
            const ann = this._annotationMap.get(annotationId) ?? (this.topology.annotations ?? []).find(a => a.id === annotationId)
            if (!ann) { return null }
            // If anchor fractions are stored, use them (specific anchor point)
            if (anchorX != null && anchorY != null) {
                return { x: ann.x + (ann.width ?? 120) * anchorX, y: ann.y + (ann.height ?? 80) * anchorY }
            }
            // Fallback: compute closest perimeter point toward the other endpoint
            const cx = ann.x + (ann.width ?? 120) / 2
            const cy = ann.y + (ann.height ?? 80) / 2
            if (!otherPt) { return { x: cx, y: cy } }
            return this._closestPerimeterPoint(ann, otherPt.x, otherPt.y)
        }
        const node = this._nodeMap.get(nodeId)
        if (node) { return { x: this.nodeCx(node), y: this.nodeCy(node) } }
        return null
    }

    /** Public helper for template: get the rendered endpoint position of a shape link */
    linkEndpointXY (link: TopologyLink, end: 'source' | 'target'): { x: number; y: number } {
        const annId = end === 'source' ? link.sourceAnnotationId : link.targetAnnotationId
        const nodeId = end === 'source' ? link.sourceNodeId : link.targetNodeId
        const ax = end === 'source' ? link.sourceAnchorX : link.targetAnchorX
        const ay = end === 'source' ? link.sourceAnchorY : link.targetAnchorY
        return this._linkEndpoint(nodeId, annId, undefined, ax, ay) ?? { x: 0, y: 0 }
    }

    // ── Endpoint drag for repositioning shape link anchors ──────────────

    private _endpointDragLink: TopologyLink | null = null
    private _endpointDragEnd: 'source' | 'target' = 'source'

    onLinkEndpointDragStart (ev: MouseEvent, link: TopologyLink, end: 'source' | 'target'): void {
        ev.preventDefault()
        ev.stopPropagation()
        this._endpointDragLink = link
        this._endpointDragEnd = end
    }

    /** Convert a CIDR prefix length to a dotted subnet mask (e.g. 24 → 255.255.255.0) */
    private _prefixToMask (prefix: number): string {
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
        return [(mask >>> 24) & 0xff, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff].join('.')
    }

    private _rectEdgePoint (
        cx: number, cy: number, w: number, h: number,
        tx: number, ty: number,
    ): { x: number; y: number } {
        const dx = tx - cx
        const dy = ty - cy
        if (dx === 0 && dy === 0) { return { x: cx, y: cy } }

        const hw = w / 2
        const hh = h / 2
        const absDx = Math.abs(dx)
        const absDy = Math.abs(dy)

        // Scale factor to reach rectangle edge
        let scale: number
        if (absDx * hh > absDy * hw) {
            // Hits left or right edge
            scale = hw / absDx
        } else {
            // Hits top or bottom edge
            scale = hh / absDy
        }
        return { x: cx + dx * scale, y: cy + dy * scale }
    }

    /** Orthogonal (right-angle) path between two anchor points on shape edges.
     *  Determines which edges the anchors are on and routes accordingly. */
    private _orthogonalPath (sx: number, sy: number, tx: number, ty: number, link: TopologyLink): string {
        // Determine which edge each anchor is on (0=top, 1=right, 2=bottom, 3=left)
        const srcEdge = this._anchorEdge(link.sourceAnchorX!, link.sourceAnchorY!)
        const tgtEdge = this._anchorEdge(link.targetAnchorX!, link.targetAnchorY!)
        const margin = 20  // offset from shape edge before turning

        // Route based on edge directions
        if (srcEdge === 2 && tgtEdge === 0) {
            // Bottom → Top: simple vertical with midpoint horizontal jog
            const my = (sy + ty) / 2
            return `M${sx},${sy} L${sx},${my} L${tx},${my} L${tx},${ty}`
        }
        if (srcEdge === 0 && tgtEdge === 2) {
            const my = (sy + ty) / 2
            return `M${sx},${sy} L${sx},${my} L${tx},${my} L${tx},${ty}`
        }
        if (srcEdge === 1 && tgtEdge === 3) {
            // Right → Left: horizontal with midpoint vertical jog
            const mx = (sx + tx) / 2
            return `M${sx},${sy} L${mx},${sy} L${mx},${ty} L${tx},${ty}`
        }
        if (srcEdge === 3 && tgtEdge === 1) {
            const mx = (sx + tx) / 2
            return `M${sx},${sy} L${mx},${sy} L${mx},${ty} L${tx},${ty}`
        }
        // Same edge or diagonal: go out, across, then in
        if (srcEdge === 0 || srcEdge === 2) {
            // Vertical exit
            const outY = srcEdge === 0 ? sy - margin : sy + margin
            const inY = tgtEdge === 0 ? ty - margin : (tgtEdge === 2 ? ty + margin : ty)
            if (tgtEdge === 0 || tgtEdge === 2) {
                return `M${sx},${sy} L${sx},${outY} L${tx},${outY} L${tx},${ty}`
            }
            // Target on left/right
            return `M${sx},${sy} L${sx},${outY} L${tx + (tgtEdge === 3 ? -margin : margin)},${outY} L${tx + (tgtEdge === 3 ? -margin : margin)},${ty} L${tx},${ty}`
        }
        // Horizontal exit
        const outX = srcEdge === 3 ? sx - margin : sx + margin
        if (tgtEdge === 1 || tgtEdge === 3) {
            return `M${sx},${sy} L${outX},${sy} L${outX},${ty} L${tx},${ty}`
        }
        const inX = tgtEdge === 0 ? tx : tx
        return `M${sx},${sy} L${outX},${sy} L${outX},${ty + (tgtEdge === 0 ? -margin : margin)} L${inX},${ty + (tgtEdge === 0 ? -margin : margin)} L${tx},${ty}`
    }

    /** Determine which edge an anchor fraction is on: 0=top, 1=right, 2=bottom, 3=left */
    private _anchorEdge (ax: number, ay: number): number {
        // Check if anchor is at an edge (within tolerance)
        const t = 0.01
        if (ay <= t) { return 0 }           // top
        if (ax >= 1 - t) { return 1 }       // right
        if (ay >= 1 - t) { return 2 }       // bottom
        if (ax <= t) { return 3 }            // left
        // Interior anchor — use closest edge
        const dTop = ay, dRight = 1 - ax, dBottom = 1 - ay, dLeft = ax
        const min = Math.min(dTop, dRight, dBottom, dLeft)
        if (min === dTop) { return 0 }
        if (min === dRight) { return 1 }
        if (min === dBottom) { return 2 }
        return 3
    }

    linkPath (link: TopologyLink): string {
        if (!link) { return '' }
        // Check path cache using geometry signature
        const sig = this._linkGeomSignature(link)
        const cachedSig = this._linkGeomSig.get(link.id)
        if (cachedSig === sig) {
            const cached = this._linkPathCache.get(link.id)
            if (cached != null) { return cached }
        }
        const result = this._computeLinkPath(link)
        this._linkPathCache.set(link.id, result)
        this._linkGeomSig.set(link.id, sig)
        return result
    }

    /** Compute geometry signature for a link — changes when endpoint positions change */
    private _linkGeomSignature (link: TopologyLink): string {
        const sn = this._nodeMap.get(link.sourceNodeId)
        const tn = this._nodeMap.get(link.targetNodeId)
        const sa = link.sourceAnnotationId ? this._annotationMap.get(link.sourceAnnotationId) : null
        const ta = link.targetAnnotationId ? this._annotationMap.get(link.targetAnnotationId) : null
        // Include all factors that affect link geometry
        return `${sn?.x ?? 0},${sn?.y ?? 0},${sn?.width ?? 0},${sn?.height ?? 0}|` +
            `${tn?.x ?? 0},${tn?.y ?? 0},${tn?.width ?? 0},${tn?.height ?? 0}|` +
            `${sa?.x ?? 0},${sa?.y ?? 0},${sa?.width ?? 0},${sa?.height ?? 0}|` +
            `${ta?.x ?? 0},${ta?.y ?? 0},${ta?.width ?? 0},${ta?.height ?? 0}|` +
            `${link.sourceAnchorX ?? ''},${link.sourceAnchorY ?? ''},${link.targetAnchorX ?? ''},${link.targetAnchorY ?? ''}|` +
            `${link.bendOffset ?? 0}|${link.routing ?? ''}|${link.waypoints?.length ?? 0}|` +
            `${link.waypoints?.map(w => `${w.x},${w.y}`).join(';') ?? ''}|${this.linkStyleCurved ? 1 : 0}`
    }

    private _computeLinkPath (link: TopologyLink): string {
        // First pass: get centers (no edge clipping yet) — anchored endpoints skip clipping
        const sc = this._linkEndpoint(link.sourceNodeId, link.sourceAnnotationId, undefined, link.sourceAnchorX, link.sourceAnchorY)
        const tc = this._linkEndpoint(link.targetNodeId, link.targetAnnotationId, undefined, link.targetAnchorX, link.targetAnchorY)
        if (!sc || !tc) { return '' }
        // Second pass: clip shape endpoints to edge toward the other center (only for non-anchored)
        const sp = (link.sourceAnchorX != null) ? sc : this._linkEndpoint(link.sourceNodeId, link.sourceAnnotationId, tc)!
        const tp = (link.targetAnchorX != null) ? tc : this._linkEndpoint(link.targetNodeId, link.targetAnnotationId, sc)!
        if (!sp || !tp) { return '' }
        const sx = sp.x, sy = sp.y
        const tx = tp.x, ty = tp.y

        // Orthogonal routing only when explicitly enabled
        if (link.routing === 'orthogonal' && link.sourceAnchorX != null && link.targetAnchorX != null) {
            return this._orthogonalPath(sx, sy, tx, ty, link)
        }

        // Waypoint routing: polyline through intermediate points
        if (link.waypoints?.length) {
            const pts = [{ x: sx, y: sy }, ...link.waypoints, { x: tx, y: ty }]
            return 'M' + pts.map(p => `${p.x},${p.y}`).join(' L')
        }

        const dx = tx - sx, dy = ty - sy
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        const px = -dy / len, py = dx / len

        if (this.linkStyleCurved) {
            const offset = this._linkOffset(link)
            const mx = (sx + tx) / 2 + px * offset
            const my = (sy + ty) / 2 + py * offset
            return `M${sx},${sy} Q${mx},${my} ${tx},${ty}`
        }

        // Straight mode: only apply compact auto-shift for parallel links.
        // Ignore curved-mode manual bend offset so endpoints remain visually anchored.
        const { index, total } = this._parallelInfo(link)
        const autoShift = total === 1 ? 0 : (-((total - 1) / 2) + index) * 10
        const shift = autoShift
        return `M${sx + px * shift},${sy + py * shift} L${tx + px * shift},${ty + py * shift}`
    }

    linkMidpoint (link: TopologyLink): { x: number; y: number } {
        if (!link) { return { x: 0, y: 0 } }
        // Check midpoint cache (shares the same geometry signature as linkPath)
        const sig = this._linkGeomSignature(link)
        const cachedSig = this._linkGeomSig.get(link.id)
        if (cachedSig === sig) {
            const cached = this._linkMidpointCache.get(link.id)
            if (cached) { return cached }
        }
        const result = this._computeLinkMidpoint(link)
        this._linkMidpointCache.set(link.id, result)
        // Also store sig if not already done by linkPath
        if (cachedSig !== sig) { this._linkGeomSig.set(link.id, sig) }
        return result
    }

    private _computeLinkMidpoint (link: TopologyLink): { x: number; y: number } {
        const sc = this._linkEndpoint(link.sourceNodeId, link.sourceAnnotationId, undefined, link.sourceAnchorX, link.sourceAnchorY)
        const tc = this._linkEndpoint(link.targetNodeId, link.targetAnnotationId, undefined, link.targetAnchorX, link.targetAnchorY)
        if (!sc || !tc) { return { x: 0, y: 0 } }
        const sp = (link.sourceAnchorX != null) ? sc : this._linkEndpoint(link.sourceNodeId, link.sourceAnnotationId, tc)!
        const tp = (link.targetAnchorX != null) ? tc : this._linkEndpoint(link.targetNodeId, link.targetAnnotationId, sc)!
        if (!sp || !tp) { return { x: 0, y: 0 } }
        const sx = sp.x, sy = sp.y
        const tx = tp.x, ty = tp.y
        const dx = tx - sx, dy = ty - sy
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        const px = -dy / len, py = dx / len

        if (this.linkStyleCurved) {
            const offset = this._linkOffset(link)
            return {
                x: (sx + tx) / 2 + px * offset * 0.5,
                y: (sy + ty) / 2 + py * offset * 0.5,
            }
        }

        // Straight mode midpoint follows straight auto-shift only.
        const { index, total } = this._parallelInfo(link)
        const shift = total === 1 ? 0 : (-((total - 1) / 2) + index) * 10
        return {
            x: (sx + tx) / 2 + px * shift,
            y: (sy + ty) / 2 + py * shift,
        }
    }

    linkLabel (link: TopologyLink): string {
        const sp = this.portLabel(link.sourceNodeId, link.sourcePortId)
        const tp = this.portLabel(link.targetNodeId, link.targetPortId)
        return `${sp} ↔ ${tp}`
    }

    linkIpLabel (link: TopologyLink): string {
        const sp = this.portIp(link.sourceNodeId, link.sourcePortId)
        const tp = this.portIp(link.targetNodeId, link.targetPortId)
        if (!sp && !tp) { return '' }
        return `${sp || '—'} ↔ ${tp || '—'}`
    }

    /** Determine the dominant VLAN mode for a link (trunk > access > none) */
    linkVlanMode (link: TopologyLink): 'trunk' | 'access' | 'none' {
        const sp = this._getPort(link.sourceNodeId, link.sourcePortId)
        const tp = this._getPort(link.targetNodeId, link.targetPortId)
        const sm = sp?.vlanMode
        const tm = tp?.vlanMode
        if (sm === 'trunk' || tm === 'trunk') { return 'trunk' }
        if (sm === 'access' || tm === 'access') { return 'access' }
        return 'none'
    }

    /** Return a short VLAN label for a link (e.g. "Trunk: all", "Access: 100") */
    linkVlanLabel (link: TopologyLink): string {
        const sp = this._getPort(link.sourceNodeId, link.sourcePortId)
        const tp = this._getPort(link.targetNodeId, link.targetPortId)
        const sm = sp?.vlanMode
        const tm = tp?.vlanMode
        if (sm === 'trunk' || tm === 'trunk') {
            const trunkPort = sm === 'trunk' ? sp : tp
            const allowed = trunkPort?.trunkAllowedVlans
            if (allowed?.toLowerCase() === 'all') { return 'Trunk: all' }
            if (allowed) { return `Trunk: ${allowed.length > 16 ? allowed.slice(0, 14) + '…' : allowed}` }
            return 'Trunk'
        }
        if (sm === 'access' || tm === 'access') {
            const accessPort = sm === 'access' ? sp : tp
            return accessPort?.vlan ? `VLAN ${accessPort.vlan}` : 'Access'
        }
        return ''
    }

    /** Stroke color for VLAN view links */
    linkVlanColor (link: TopologyLink): string {
        const mode = this.linkVlanMode(link)
        if (mode === 'trunk') { return '#3b82f6' }
        if (mode === 'access') { return '#22c55e' }
        return '#4b5563'
    }

    /** Count of VLANs defined on a node */
    nodeVlanCount (node: TopologyNode): number {
        return node.vlans?.length ?? 0
    }

    // ── BGP view helpers ─────────────────────────────────────────────────────

    /** Classify a link's BGP relationship: eBGP, iBGP, or none */
    linkBgpMode (link: TopologyLink): 'ebgp' | 'ibgp' | 'none' {
        const s = this._nodeMap.get(link.sourceNodeId)
        const t = this._nodeMap.get(link.targetNodeId)
        const sAsn = s?.asn
        const tAsn = t?.asn
        if (!sAsn || !tAsn) { return 'none' }
        return sAsn === tAsn ? 'ibgp' : 'ebgp'
    }

    /** Stroke color for BGP view links */
    linkBgpColor (link: TopologyLink): string {
        const mode = this.linkBgpMode(link)
        if (mode === 'ebgp') { return '#f59e0b' }
        if (mode === 'ibgp') { return '#8b5cf6' }
        return '#4b5563'
    }

    /** Return a BGP label for a link (e.g. "eBGP 65001↔65002" or "iBGP AS65001") */
    linkBgpLabel (link: TopologyLink): string {
        const s = this._nodeMap.get(link.sourceNodeId)
        const t = this._nodeMap.get(link.targetNodeId)
        const sAsn = s?.asn
        const tAsn = t?.asn
        if (!sAsn || !tAsn) { return '' }
        if (sAsn !== tAsn) {
            const sLabel = is4ByteAsn(sAsn) ? asnToAsdot(sAsn) : String(sAsn)
            const tLabel = is4ByteAsn(tAsn) ? asnToAsdot(tAsn) : String(tAsn)
            return `eBGP ${sLabel}↔${tLabel}`
        }
        const label = is4ByteAsn(sAsn) ? asnToAsdot(sAsn) : String(sAsn)
        return `iBGP AS${label}`
    }

    /** Return ASN badge text for a node (e.g. "AS65001" or "AS2.0" for 4-byte) */
    nodeAsnLabel (node: TopologyNode): string {
        if (!node.asn) { return '' }
        return 'AS' + (is4ByteAsn(node.asn) ? asnToAsdot(node.asn) : String(node.asn))
    }

    pendingPath (): string {
        // Shape drag source (draw.io style drag-to-connect)
        if (this._shapeDragSourceId && this._shapeDragAnchor) {
            const ann = (this.topology.annotations ?? []).find(a => a.id === this._shapeDragSourceId)
            if (!ann) { return '' }
            const sx = ann.x + (ann.width ?? 120) * this._shapeDragAnchor.x
            const sy = ann.y + (ann.height ?? 80) * this._shapeDragAnchor.y
            return `M${sx},${sy} L${this.pendingMouse.x},${this.pendingMouse.y}`
        }
        // Shape source via pendingLink (context menu / click-click fallback)
        const srcAnnId = this.pendingLink?.sourceAnnotationId
        if (srcAnnId) {
            const ann = (this.topology.annotations ?? []).find(a => a.id === srcAnnId)
            if (!ann) { return '' }
            const edge = this._rectEdgePoint(
                ann.x + (ann.width ?? 120) / 2, ann.y + (ann.height ?? 80) / 2,
                ann.width ?? 120, ann.height ?? 80,
                this.pendingMouse.x, this.pendingMouse.y,
            )
            return `M${edge.x},${edge.y} L${this.pendingMouse.x},${this.pendingMouse.y}`
        }
        // Node source
        const srcId = this.pendingLink?.sourceNodeId ?? this._linkDragSourceId
        if (!srcId) { return '' }
        const s = this.topology.nodes.find(n => n.id === srcId)
        if (!s) { return '' }
        return `M${this.nodeCx(s)},${this.nodeCy(s)} L${this.pendingMouse.x},${this.pendingMouse.y}`
    }

    get hasPendingPath (): boolean {
        return !!(this.pendingLink || this._linkDragSourceId || this._shapeDragSourceId)
    }

    portLabel (nodeId: string, portId: string): string {
        const n = this._nodeMap.get(nodeId)
        if (!n) { return portId }
        const port = n.ports.find(p => p.id === portId)
        if (!port) { return portId }
        // For host nodes, show "host:enp3s0" style label
        if (n.type === 'host') {
            const label = port.label
            if (label && label !== 'NIC' && !label.match(/^NIC\d+$/)) { return label }
            return n.hostInterface || 'NIC'
        }
        // For bridge nodes, show per-port bridge name
        if (n.type === 'bridge') {
            const label = port.label
            if (label && label !== 'br' && !label.match(/^br\d+$/)) { return label }
            return n.bridgeName || 'bridge'
        }
        return port.label
    }

    portIp (nodeId: string, portId: string): string {
        return this._nodeMap.get(nodeId)?.ports.find(p => p.id === portId)?.ipAddress?.trim() ?? ''
    }

    portIpv6 (nodeId: string, portId: string): string {
        return this._nodeMap.get(nodeId)?.ports.find(p => p.id === portId)?.ipv6Address?.trim() ?? ''
    }

    linkIpv6Label (link: TopologyLink): string {
        const sp = this.portIpv6(link.sourceNodeId, link.sourcePortId)
        const tp = this.portIpv6(link.targetNodeId, link.targetPortId)
        if (!sp && !tp) { return '' }
        return `${sp || '—'} ↔ ${tp || '—'}`
    }

    isNodeSelected (id: string): boolean { return this.selectedNodeIds.has(id) }
    isLinkSelected (id: string): boolean { return this.selectedLinkIds.has(id) }

    clearSelection (): void {
        this.selectedNodeIds.clear()
        this.selectedLinkIds.clear()
        this.selectedShapeIds.clear()
        this.svc.selectNode(null)
    }

    /** Create a zone rectangle around the currently selected nodes */
    groupSelectedNodes (): void {
        if (this.selectedNodeIds.size < 2) {
            this.statusMsg = 'Select 2+ nodes to group'
            this.cdr.markForCheck()
            return
        }
        const nodes = this.topology.nodes.filter(n => this.selectedNodeIds.has(n.id))
        const pad = 30
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of nodes) {
            if (n.x < minX) { minX = n.x }
            if (n.y < minY) { minY = n.y }
            if (n.x + NODE_W > maxX) { maxX = n.x + NODE_W }
            if (n.y + NODE_H > maxY) { maxY = n.y + NODE_H }
        }
        const zone = this.svc.addRectangle(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2)
        this.svc.updateAnnotation(zone.id, {
            isZone: true,
            zoneNodeIds: nodes.map(n => n.id),
            fillColor: 'rgba(59, 130, 246, 0.06)',
            strokeColor: '#3b82f6',
            strokeWidth: 1,
            opacity: 1,
            label: 'Zone',
        })
        this.selectedShapeId = zone.id
        this.statusMsg = `Grouped ${nodes.length} nodes into zone`
        this.cdr.markForCheck()
    }

    private _isMultiSelectIntent (ev: MouseEvent): boolean {
        return ev.shiftKey || ev.ctrlKey || ev.metaKey
    }

    private _isTextInputTarget (target: EventTarget | null): boolean {
        const el = target as HTMLElement | null
        if (!el) { return false }
        if (el.isContentEditable) { return true }
        const tag = el.tagName
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    private _selectionStatus (): string {
        const total = this.selectedNodeIds.size + this.selectedLinkIds.size + this.selectedShapeIds.size
        if (!total) { return 'Ready' }
        if (total === 1 && this.selectedNodeIds.size === 1) {
            const id = [...this.selectedNodeIds][0]
            const label = this.topology.nodes.find(n => n.id === id)?.label ?? 'Node'
            return `Selected: ${label}`
        }
        if (total === 1 && this.selectedLinkIds.size === 1) {
            return 'Selected: 1 link'
        }
        const parts: string[] = []
        if (this.selectedNodeIds.size) { parts.push(`${this.selectedNodeIds.size} nodes`) }
        if (this.selectedLinkIds.size) { parts.push(`${this.selectedLinkIds.size} links`) }
        if (this.selectedShapeIds.size) { parts.push(`${this.selectedShapeIds.size} shapes`) }
        return `Selected: ${parts.join(', ')}`
    }

    private _syncPrimarySelection (): void {
        if (this.selectedNodeIds.size === 1 && this.selectedLinkIds.size === 0) {
            this.svc.selectNode([...this.selectedNodeIds][0])
            return
        }
        if (this.selectedLinkIds.size === 1 && this.selectedNodeIds.size === 0) {
            this.svc.selectLink([...this.selectedLinkIds][0])
            return
        }
        this.svc.selectNode(null)
    }

    private _pruneSelectionIds (): void {
        const nodeIds = new Set(this.topology.nodes.map(n => n.id))
        const linkIds = new Set(this.topology.links.map(l => l.id))
        let changed = false

        for (const id of [...this.selectedNodeIds]) {
            if (!nodeIds.has(id)) { this.selectedNodeIds.delete(id); changed = true }
        }
        for (const id of [...this.selectedLinkIds]) {
            if (!linkIds.has(id)) { this.selectedLinkIds.delete(id); changed = true }
        }

        if (changed) { this._syncPrimarySelection() }
    }

    // ── Menu bar ─────────────────────────────────────────────────────────────

    toggleMenu (name: string): void {
        this.openMenu = this.openMenu === name ? null : name
        this.cdr.markForCheck()
    }

    closeMenus (): void {
        if (this.openMenu) { this.openMenu = null }
        if (this.ctxCanvasOpen) { this.ctxCanvasOpen = false }
        if (this.ctxNodeId) { this.ctxNodeId = null }
        if (this.ctxLinkId) { this.ctxLinkId = null }
        if (this.ctxShapeId) { this.ctxShapeId = null }
        if (this.ctxLabelLinkId) { this.ctxLabelLinkId = null; this.ctxLabelId = null }
        if (this.ctxWaypointLinkId) { this.ctxWaypointLinkId = null }
        this.cdr.markForCheck()
    }

    onMenuEnter (name: string): void {
        if (this.openMenu && this.openMenu !== name) {
            this.openMenu = name
            this.cdr.markForCheck()
        }
    }

    // ── Toolbar ──────────────────────────────────────────────────────────────

    openTemplates (): void { this.showTemplates = true; this.cdr.markForCheck() }
    closeTemplates (): void { this.showTemplates = false; this.cdr.markForCheck() }
    openBuilder (): void { this.showBuilder = true; this.cdr.markForCheck() }
    closeBuilder (): void { this.showBuilder = false; this.cdr.markForCheck() }
    toggleIpVisibility (): void { this.showIpLabels = !this.showIpLabels; this.cdr.markForCheck() }
    toggleVlanView (): void {
        this.showVlanView = !this.showVlanView
        if (this.showVlanView) { this.showBgpView = false; this.showTrafficFlowView = false }
        this.cdr.markForCheck()
    }
    toggleBgpView (): void {
        this.showBgpView = !this.showBgpView
        if (this.showBgpView) { this.showVlanView = false; this.showTrafficFlowView = false }
        this.cdr.markForCheck()
    }
    toggleInterfaceLabels (): void { this.showInterfaceLabels = !this.showInterfaceLabels; this.cdr.markForCheck() }

    toggle3DView (): void {
        this.viewMode = this.viewMode === '2d' ? '3d' : '2d'
        this.cdr.markForCheck()
    }

    onNodeSelect3D (nodeId: string | null): void {
        this.svc.selectNode(nodeId ?? null as any)
    }

    /** Build topology from LLDP discovery result — creates nodes + links automatically */
    buildTopologyFromDiscovery (devices: Array<{ hostname: string; mgmtIp: string; vendor: string; model: string; interfaces: string[] }>,
                                links: Array<{ srcHost: string; srcInterface: string; dstHost: string; dstInterface: string }>): void {
        // Create nodes with grid layout
        const nodeMap = new Map<string, string>() // hostname → nodeId
        let x = 100, y = 100
        const cols = Math.ceil(Math.sqrt(devices.length))
        for (let i = 0; i < devices.length; i++) {
            const dev = devices[i]
            const type = dev.vendor.toLowerCase().includes('firewall') ? 'firewall' as const : 'router' as const
            const node = this.svc.addNode(type, x, y)
            this.svc.updateNodeConfig(node.id, {
                label: dev.hostname,
                vendor: dev.vendor,
                model: dev.model,
                mgmtIp: dev.mgmtIp,
                mapped: true,
                mappedBy: 'hostname',
            } as any)
            nodeMap.set(dev.hostname, node.id)
            x += 200
            if ((i + 1) % cols === 0) { x = 100; y += 180 }
        }

        // Create links
        for (const link of links) {
            const srcId = nodeMap.get(link.srcHost)
            const tgtId = nodeMap.get(link.dstHost)
            if (!srcId || !tgtId || srcId === tgtId) { continue }
            // Check if link already exists
            const exists = this.topology.links.some(l =>
                (l.sourceNodeId === srcId && l.targetNodeId === tgtId) ||
                (l.sourceNodeId === tgtId && l.targetNodeId === srcId)
            )
            if (exists) { continue }
            const srcNode = this.topology.nodes.find(n => n.id === srcId)
            const tgtNode = this.topology.nodes.find(n => n.id === tgtId)
            if (!srcNode || !tgtNode) { continue }
            const srcPort = srcNode.ports.find(p => !this.topology.links.some(l =>
                (l.sourceNodeId === srcId && l.sourcePortId === p.id) || (l.targetNodeId === srcId && l.targetPortId === p.id)
            ))
            const tgtPort = tgtNode.ports.find(p => !this.topology.links.some(l =>
                (l.sourceNodeId === tgtId && l.sourcePortId === p.id) || (l.targetNodeId === tgtId && l.targetPortId === p.id)
            ))
            if (srcPort && tgtPort) {
                this.svc.addLink(srcId, srcPort.id, tgtId, tgtPort.id)
            }
        }

        this.statusMsg = `Built topology: ${devices.length} devices, ${links.length} links from LLDP discovery`
        this.cdr.markForCheck()
    }

    onMappingApplied (mappings: Map<string, { hostname: string; mgmtIp: string; vendor: string; model: string }>): void {
        // Apply mapping to topology nodes
        for (const [nodeId, entry] of mappings) {
            const node = this.topology.nodes.find(n => n.id === nodeId)
            if (!node) { continue }
            this.svc.updateNodeConfig(nodeId, {
                mapped: true,
                mappedBy: 'hostname',
                mgmtIp: entry.mgmtIp,
                vendor: entry.vendor || node.vendor,
                model: entry.model || node.model,
            } as any)
        }

        this.statusMsg = `Mapped ${mappings.size} nodes to physical devices`
        this.cdr.markForCheck()

        // Auto-save topology so mapping persists across restarts
        this.saveTopology()

        // Prompt to push configs
        if (mappings.size > 0) {
            const push = confirm(`${mappings.size} nodes mapped and saved. Push configs to physical devices now?`)
            if (push) { this.pushAllConfigs({ skipConfirm: true }) }
        }
    }

    get mappedNodeCount (): number {
        return this.topology?.nodes?.filter(n => n.mapped).length ?? 0
    }

    updateMappedField (nodeId: string, field: string, event: Event): void {
        const value = (event.target as HTMLInputElement).value
        this.svc.updateNodeConfig(nodeId, { [field]: value } as any)
    }

    unmapDevice (nodeId: string): void {
        this.svc.updateNodeConfig(nodeId, { mapped: false, mappedBy: undefined } as any)
        this.statusMsg = 'Device unmapped'
        this.cdr.markForCheck()
    }

    unmapAllDevices (): void {
        if (!confirm('Remove mapping from all devices?')) { return }
        for (const node of this.topology.nodes.filter(n => n.mapped)) {
            this.svc.updateNodeConfig(node.id, { mapped: false, mappedBy: undefined } as any)
        }
        this.statusMsg = 'All devices unmapped'
        this.saveTopology()
        this.cdr.markForCheck()
    }

    onNodeAdded3D (event: { type: string; x: number; y: number }): void {
        const node = this.svc.addNode(event.type as any, event.x, event.y)
        this.statusMsg = `Added ${node.label} in 3D view`
        this.cdr.markForCheck()
    }

    onNodeMoved3D (event: { nodeId: string; x: number; y: number }): void {
        this.svc.moveNode(event.nodeId, event.x, event.y)
    }

    onLinkCreated3D (event: { sourceNodeId: string; targetNodeId: string }): void {
        const srcNode = this.topology.nodes.find(n => n.id === event.sourceNodeId)
        const tgtNode = this.topology.nodes.find(n => n.id === event.targetNodeId)
        if (!srcNode || !tgtNode) { return }
        // Find first available port on each node
        const srcPort = srcNode.ports.find(p => !this.topology.links.some(l =>
            (l.sourceNodeId === srcNode.id && l.sourcePortId === p.id) ||
            (l.targetNodeId === srcNode.id && l.targetPortId === p.id)
        ))
        const tgtPort = tgtNode.ports.find(p => !this.topology.links.some(l =>
            (l.sourceNodeId === tgtNode.id && l.sourcePortId === p.id) ||
            (l.targetNodeId === tgtNode.id && l.targetPortId === p.id)
        ))
        if (!srcPort || !tgtPort) {
            this.statusMsg = 'No available ports for new link'
            this.cdr.markForCheck()
            return
        }
        this.svc.addLink(event.sourceNodeId, srcPort.id, event.targetNodeId, tgtPort.id)
        this.statusMsg = `Link created: ${srcNode.label} ↔ ${tgtNode.label}`
        this.cdr.markForCheck()
    }

    // ── Digital Twin ──────────────────────────────────────────────────────

    toggleDigitalTwin (): void {
        this.digitalTwinActive = !this.digitalTwinActive
        if (this.digitalTwinActive) {
            // Start all monitoring sources
            if (!this.livePollingActive) { this.startLivePolling() }
            this._pollTwinState()
            this._twinPollTimer = setInterval(() => this._pollTwinState(), 30_000)
        } else {
            // Stop twin-specific polling (keep live polling if user started it independently)
            if (this._twinPollTimer) { clearInterval(this._twinPollTimer); this._twinPollTimer = null }
            this.twinNodeHealth.clear()
            this.twinConfigDrift.clear()
            this.twinActiveAlarms.clear()
            this.showTwinDashboard = false
        }
        this.cdr.markForCheck()
    }

    private async _pollTwinState (): Promise<void> {
        if (!this.digitalTwinActive) { return }
        const api = (window as any).netopsAPI

        // Collect alarms from inventory service
        for (const node of this.topology.nodes) {
            const nodeAlarms = this.invSvc.allAlarms
                .filter(a => a.nodeId === node.id && !a.clearedAt)
                .map(a => ({ severity: a.severity, message: a.message }))
            if (nodeAlarms.length) {
                this.twinActiveAlarms.set(node.id, nodeAlarms)
            } else {
                this.twinActiveAlarms.delete(node.id)
            }
        }

        // Poll health for mapped nodes via SSH
        for (const node of this.topology.nodes) {
            if (!node.mapped || !node.mgmtIp || !node.sshUsername) { continue }
            try {
                await this.invSvc.pollDevice(node.id)
                const devVer = this.invSvc.store.deviceVersions[node.id]
                if (devVer) {
                    this.twinNodeHealth.set(node.id, {
                        cpu: devVer.cpuPercent ?? 0,
                        mem: devVer.memoryUsedPercent ?? 0,
                        alarms: this.twinActiveAlarms.get(node.id)?.length ?? 0,
                    })
                }
            } catch (err) { console.warn('Twin poll failed:', (err as Error).message) }
        }

        // Config drift detection for containerlab nodes
        if (api?.clabFetchConfig && this.clabContainers?.length) {
            for (const node of this.topology.nodes) {
                if (!node.vendor || !node.startupConfig?.trim()) { continue }
                const safeName = node.label.replace(/\s+/g, '-').toLowerCase()
                const ctn = this.clabContainers.find(c => c.name.endsWith('-' + safeName) && c.state === 'running')
                if (!ctn) { continue }
                try {
                    const result = await api.clabFetchConfig({ containerName: ctn.name, kind: ctn.kind })
                    if (result.ok && result.output) {
                        const drift = this._computeConfigDrift(node.startupConfig, result.output)
                        if (drift.hasDrift) {
                            this.twinConfigDrift.set(node.id, drift)
                        } else {
                            this.twinConfigDrift.delete(node.id)
                        }
                    }
                } catch (err) { console.warn('Twin poll failed:', (err as Error).message) }
            }
        }

        this.cdr.markForCheck()
    }

    private _computeConfigDrift (generated: string, running: string): { hasDrift: boolean; addedCount: number; removedCount: number; addedLines: string[]; removedLines: string[] } {
        const normalize = (cfg: string): Set<string> => {
            return new Set(
                cfg.split('\n')
                    .map(l => l.trim())
                    .filter(l => l && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('/*'))
                    .map(l => l.replace(/\s+/g, ' '))
            )
        }
        const genLines = normalize(generated)
        const runLines = normalize(running)

        const addedLines: string[] = []
        const removedLines: string[] = []
        for (const line of runLines) {
            if (!genLines.has(line)) { addedLines.push(line) }
        }
        for (const line of genLines) {
            if (!runLines.has(line)) { removedLines.push(line) }
        }

        const hasDrift = (addedLines.length + removedLines.length) > 5
        return { hasDrift, addedCount: addedLines.length, removedCount: removedLines.length, addedLines, removedLines }
    }

    getTwinAlarmSeverity (nodeId: string): string {
        const alarms = this.twinActiveAlarms.get(nodeId)
        if (!alarms?.length) { return '' }
        if (alarms.some(a => a.severity === 'critical')) { return 'critical' }
        if (alarms.some(a => a.severity === 'major')) { return 'major' }
        return 'minor'
    }

    getTwinCpu (nodeId: string): number { return this.twinNodeHealth.get(nodeId)?.cpu ?? -1 }
    getTwinMem (nodeId: string): number { return this.twinNodeHealth.get(nodeId)?.mem ?? -1 }

    getNodeBgpCount (nodeId: string): string {
        const node = this.topology?.nodes?.find(n => n.id === nodeId)
        if (!node) { return '—' }
        const safeName = node.label.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase()
        // Find container matching this node
        for (const [ctnName, neighbors] of this.liveBgpState) {
            if (ctnName.endsWith('-' + safeName)) {
                const up = neighbors.filter(n => n.state === 'established').length
                return `${up}/${neighbors.length}`
            }
        }
        return '—'
    }

    // ── Traffic Flow Visualization ─────────────────────────────────────

    private readonly _flowColors = [
        '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
        '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
    ]

    toggleTrafficFlowView (): void {
        this.showTrafficFlowView = !this.showTrafficFlowView
        if (this.showTrafficFlowView) {
            this.showVlanView = false
            this.showBgpView = false
            this._recomputeFlows()
        }
        this.cdr.markForCheck()
    }

    toggleTrafficFlowPanel (): void {
        this.showTrafficFlowPanel = !this.showTrafficFlowPanel
        this.cdr.markForCheck()
    }

    addFlow (): void {
        if (!this.flowFormSource || !this.flowFormDest || this.flowFormSource === this.flowFormDest) {
            this.statusMsg = 'Select different source and destination nodes'
            this.cdr.markForCheck()
            return
        }
        const flow: TrafficFlow = {
            id: crypto.randomUUID(),
            name: this.flowFormName || `Flow ${this.trafficFlows.length + 1}`,
            sourceNodeId: this.flowFormSource,
            destNodeId: this.flowFormDest,
            protocol: this.flowFormProtocol === 'Any' ? undefined : this.flowFormProtocol,
            port: this.flowFormPort ?? undefined,
            color: this.flowFormColor,
            enabled: true,
        }
        this.trafficFlows = [...this.trafficFlows, flow]
        // Reset form & pick next color
        this.flowFormName = ''
        this.flowFormSource = ''
        this.flowFormDest = ''
        this.flowFormProtocol = 'Any'
        this.flowFormPort = null
        this.flowFormColor = this._flowColors[this.trafficFlows.length % this._flowColors.length]
        this._recomputeFlows()
    }

    removeFlow (flowId: string): void {
        this.trafficFlows = this.trafficFlows.filter(f => f.id !== flowId)
        if (this.flowEditingId === flowId) { this.flowEditingId = null }
        this._recomputeFlows()
    }

    toggleFlowEnabled (flowId: string): void {
        const f = this.trafficFlows.find(x => x.id === flowId)
        if (f) { f.enabled = !f.enabled }
        this._recomputeFlows()
    }

    editFlow (flowId: string): void {
        const f = this.trafficFlows.find(x => x.id === flowId)
        if (!f) { return }
        this.flowEditingId = flowId
        this.flowFormName = f.name
        this.flowFormSource = f.sourceNodeId
        this.flowFormDest = f.destNodeId
        this.flowFormProtocol = f.protocol ?? 'Any'
        this.flowFormPort = f.port ?? null
        this.flowFormColor = f.color
        this.cdr.markForCheck()
    }

    saveFlowEdit (): void {
        if (!this.flowEditingId) { return }
        const f = this.trafficFlows.find(x => x.id === this.flowEditingId)
        if (f) {
            f.name = this.flowFormName || f.name
            f.sourceNodeId = this.flowFormSource || f.sourceNodeId
            f.destNodeId = this.flowFormDest || f.destNodeId
            f.protocol = this.flowFormProtocol === 'Any' ? undefined : this.flowFormProtocol
            f.port = this.flowFormPort ?? undefined
            f.color = this.flowFormColor
        }
        this.flowEditingId = null
        this._recomputeFlows()
    }

    cancelFlowEdit (): void { this.flowEditingId = null; this.cdr.markForCheck() }

    private _recomputeFlows (): void {
        if (!this.showTrafficFlowView || !this.trafficFlows.length) {
            this.computedFlowPaths = []
            this.cdr.markForCheck()
            return
        }
        const enabledFlows = this.trafficFlows.filter(f => f.enabled)
        this.computedFlowPaths = this.graphSvc.computeFlowPaths(
            this.topology,
            enabledFlows,
            this._simulatedFailedNodes,
            this._simulatedFailedLinks,
        )
        this.cdr.markForCheck()
    }

    linkFlowColor (link: TopologyLink): string | null {
        if (!this.showTrafficFlowView || !this.computedFlowPaths.length) { return null }
        const fp = this.computedFlowPaths.find(p => !p.broken && p.linkIds.includes(link.id))
        if (!fp) { return null }
        return this.trafficFlows.find(f => f.id === fp.flowId)?.color ?? null
    }

    linkFlowLabel (link: TopologyLink): string {
        if (!this.showTrafficFlowView || !this.computedFlowPaths.length) { return '' }
        const fps = this.computedFlowPaths.filter(p => !p.broken && p.linkIds.includes(link.id))
        return fps.map(p => this.trafficFlows.find(f => f.id === p.flowId)?.name ?? '')
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i)   // dedupe
            .join(', ')
    }

    isFlowReachable (flowId: string): boolean {
        return this.computedFlowPaths.filter(p => p.flowId === flowId).some(p => !p.broken)
    }

    isFlowRerouted (flowId: string): boolean {
        return this.computedFlowPaths.filter(p => p.flowId === flowId).some(p => p.rerouted)
    }

    getLinkById (linkId: string): TopologyLink | undefined {
        return this._linkMap.get(linkId)
    }

    getFlowColor (flowId: string): string {
        return this.trafficFlows.find(f => f.id === flowId)?.color ?? '#3b82f6'
    }

    trackFlowPath (_: number, fp: ComputedFlowPath): string {
        return `${fp.flowId}-${fp.pathIndex}`
    }

    nodeLabel (nodeId: string): string {
        return this._nodeMap.get(nodeId)?.label ?? nodeId
    }

    // ── Failure Simulation ─────────────────────────────────────────────

    get hasSimulatedFailures (): boolean {
        return this._simulatedFailedNodes.size > 0 || this._simulatedFailedLinks.size > 0
    }

    isNodeSimFailed (nodeId: string): boolean {
        return this._simulatedFailedNodes.has(nodeId)
    }

    isLinkSimFailed (linkId: string): boolean {
        return this._simulatedFailedLinks.has(linkId)
    }

    ctxSimulateFailure (nodeId: string): void {
        this.closeCtxMenu()
        if (this._simulatedFailedNodes.has(nodeId)) {
            this._simulatedFailedNodes.delete(nodeId)
            this.statusMsg = 'Failure simulation removed'
        } else {
            this._simulatedFailedNodes.add(nodeId)
            this.statusMsg = 'Node failure simulated'
        }
        this._recomputeFlows()
    }

    ctxLinkSimulateFailure (): void {
        if (!this.ctxLinkId) { return }
        if (this._simulatedFailedLinks.has(this.ctxLinkId)) {
            this._simulatedFailedLinks.delete(this.ctxLinkId)
            this.statusMsg = 'Link failure simulation removed'
        } else {
            this._simulatedFailedLinks.add(this.ctxLinkId)
            this.statusMsg = 'Link failure simulated'
        }
        this.ctxLinkId = null
        this._recomputeFlows()
    }

    clearAllSimulatedFailures (): void {
        this._simulatedFailedNodes.clear()
        this._simulatedFailedLinks.clear()
        this.statusMsg = 'All simulated failures cleared'
        this._recomputeFlows()
    }

    // ── Packet Capture ────────────────────────────────────────────────────────

    async startPacketCapture (linkId: string): Promise<void> {
        const link = this.topology.links.find(l => l.id === linkId)
        if (!link) { return }
        // Find the source node's container
        const node = this.topology.nodes.find(n => n.id === link.sourceNodeId)
        if (!node) { return }
        const safeName = node.label.replace(/[^a-zA-Z0-9_-]/g, '_')
        const container = this.clabContainers.find(c => c.name.endsWith('-' + safeName))
        if (!container) {
            this.statusMsg = 'No deployed container found for this node'
            this.cdr.markForCheck()
            return
        }
        const api = (window as any).netopsAPI
        if (!api?.clabStartCapture) { return }
        this.captureLinkId = linkId
        this.captureLines = []
        this.captureActive = true
        this.showCaptureDialog = true
        this.cdr.markForCheck()
        // Register listener
        if (api.onCaptureData) {
            api.offCaptureData?.()
            api.onCaptureData((data: { captureId: string; line: string }) => {
                if (data.captureId !== this.captureId) { return }
                if (data.line === '__CAPTURE_DONE__') {
                    this.captureActive = false
                    this.cdr.markForCheck()
                    return
                }
                this.captureLines.push(data.line)
                if (this.captureLines.length > 500) { this.captureLines.shift() }
                this.cdr.markForCheck()
            })
        }
        try {
            const result = await api.clabStartCapture({ container: container.name, iface: 'any', count: 200 })
            if (result.ok) {
                this.captureId = result.captureId
            } else {
                this.captureActive = false
                this.captureLines.push(`Error: ${result.message}`)
                this.cdr.markForCheck()
            }
        } catch {
            this.captureActive = false
            this.captureLines.push('Failed to start capture')
            this.cdr.markForCheck()
        }
    }

    async stopCapture (): Promise<void> {
        const api = (window as any).netopsAPI
        if (api?.clabStopCapture && this.captureId) {
            await api.clabStopCapture({ captureId: this.captureId })
        }
        this.captureActive = false
        this.cdr.markForCheck()
    }

    // ── Topology Diff ──────────────────────────────────────────────────────

    async compareTopologyWithSaved (): Promise<void> {
        if (!this.clabFilePath) {
            this.statusMsg = 'No deployed topology file to compare'
            this.cdr.markForCheck()
            return
        }
        const api = (window as any).netopsAPI
        if (!api?.clabReadTopologyFile) { return }
        try {
            const result = await api.clabReadTopologyFile({ filePath: this.clabFilePath })
            if (!result.ok) {
                this.statusMsg = `Could not read file: ${result.message}`
                this.cdr.markForCheck()
                return
            }
            const savedLines = result.content.split('\n')
            const genResult = this._generateClabYaml()
            if (!genResult.ok) {
                this.statusMsg = `Generate error: ${(genResult as any).error}`
                this.cdr.markForCheck()
                return
            }
            const currentLines = (genResult as any).yaml.split('\n')
            this.topoDiffLines = this._computeSimpleDiff(savedLines, currentLines)
            this.showTopoDiff = true
            this.cdr.markForCheck()
        } catch {
            this.statusMsg = 'Diff comparison failed'
            this.cdr.markForCheck()
        }
    }

    /** Simple line-by-line diff (no LCS — just match/insert/delete) */
    private _computeSimpleDiff (
        oldLines: string[], newLines: string[],
    ): Array<{ type: 'same' | 'add' | 'remove'; text: string }> {
        const result: Array<{ type: 'same' | 'add' | 'remove'; text: string }> = []
        const maxLen = Math.max(oldLines.length, newLines.length)
        let oi = 0, ni = 0
        while (oi < oldLines.length || ni < newLines.length) {
            if (oi < oldLines.length && ni < newLines.length) {
                if (oldLines[oi] === newLines[ni]) {
                    result.push({ type: 'same', text: oldLines[oi] })
                    oi++; ni++
                } else {
                    // Look ahead in new for old[oi]
                    const nextInNew = newLines.indexOf(oldLines[oi], ni)
                    // Look ahead in old for new[ni]
                    const nextInOld = oldLines.indexOf(newLines[ni], oi)
                    if (nextInNew >= 0 && (nextInOld < 0 || nextInNew - ni < nextInOld - oi)) {
                        // Lines were added
                        while (ni < nextInNew) {
                            result.push({ type: 'add', text: newLines[ni++] })
                        }
                    } else if (nextInOld >= 0) {
                        // Lines were removed
                        while (oi < nextInOld) {
                            result.push({ type: 'remove', text: oldLines[oi++] })
                        }
                    } else {
                        result.push({ type: 'remove', text: oldLines[oi++] })
                        result.push({ type: 'add', text: newLines[ni++] })
                    }
                }
            } else if (oi < oldLines.length) {
                result.push({ type: 'remove', text: oldLines[oi++] })
            } else {
                result.push({ type: 'add', text: newLines[ni++] })
            }
        }
        return result
    }

    closeCaptureDialog (): void {
        this.stopCapture()
        this.showCaptureDialog = false
        this.captureLines = []
        this.captureId = ''
        const api = (window as any).netopsAPI
        api?.offCaptureData?.()
        this.cdr.markForCheck()
    }

    // ── Health summary widget ────────────────────────────────────────────────

    get healthSummary (): { nodesUp: number; total: number; alarms: number; bgpUp: number; bgpTotal: number } {
        return {
            nodesUp: this.liveSummary.nodesUp,
            total: this.liveSummary.nodesTotal || this.topology.nodes.length,
            alarms: this.invSvc.activeAlarmCount,
            bgpUp: this.liveSummary.bgpUp,
            bgpTotal: this.liveSummary.bgpTotal,
        }
    }

    // ── Bulk credential setting ──────────────────────────────────────────────

    openBulkCredDialog (): void {
        this.bulkCredVendor = ''
        this.bulkCredUsername = ''
        this.bulkCredPassword = ''
        this.bulkCredMgmtPrefix = ''
        this.showBulkCredDialog = true
        this.closeCtxMenu()
        this.cdr.markForCheck()
    }

    applyBulkCredentials (): void {
        const ids = [...this.selectedNodeIds]
        if (!ids.length) { return }
        const changes: any = {}
        if (this.bulkCredVendor.trim()) { changes.vendor = this.bulkCredVendor.trim() }
        if (this.bulkCredUsername.trim()) { changes.sshUsername = this.bulkCredUsername.trim() }
        if (this.bulkCredPassword) { changes.sshPassword = this.bulkCredPassword }

        for (let i = 0; i < ids.length; i++) {
            const nodeChanges = { ...changes }
            if (this.bulkCredMgmtPrefix.trim()) {
                nodeChanges.mgmtIp = this.bulkCredMgmtPrefix.trim() + (10 + i)
            }
            this.svc.updateNodeConfig(ids[i], nodeChanges)
        }

        this.showBulkCredDialog = false
        this.statusMsg = `Applied credentials to ${ids.length} node(s)`
        this.cdr.markForCheck()
    }

    // ── Route table view ─────────────────────────────────────────────────────

    toggleRouteView (): void {
        this.showRouteView = !this.showRouteView
        if (this.showRouteView && !this.liveRouteTable.size) {
            this.fetchRouteTables()
        }
        this.cdr.markForCheck()
    }

    async fetchRouteTables (): Promise<void> {
        this.routeFetching = true
        this.cdr.markForCheck()
        const api = (window as any).netopsAPI
        if (!api?.sshRunCommand) { this.routeFetching = false; return }

        for (const node of this.topology.nodes) {
            const host = (node.mgmtIp ?? '').split('/')[0].trim()
            if (!host || !node.sshUsername || !node.vendor) { continue }
            const cmds = getVendorCommands(node.vendor)
            if (!cmds.showRouteTable) { continue }
            try {
                let result: any
                if (this._backendSvc?.isConnected) {
                    result = await this._backendSvc.runCommand(host, node.sshPort ?? 22, node.sshUsername, node.sshPassword ?? '', cmds.showRouteTable)
                } else {
                    result = await api.sshRunCommand({
                        host, port: node.sshPort ?? 22,
                        username: node.sshUsername, password: node.sshPassword ?? '',
                        timeoutMs: 15000, command: cmds.showRouteTable,
                    })
                }
                if (result.ok && result.output) {
                    this.liveRouteTable.set(node.id, parseRouteTable(node.vendor, result.output))
                }
            } catch (err) { console.warn('Health poll failed:', (err as Error).message) }
        }
        this.routeFetching = false
        this.statusMsg = `Fetched route tables from ${this.liveRouteTable.size} device(s)`
        this.cdr.markForCheck()
    }

    /** Get route count for a node (for display) */
    nodeRouteCount (nodeId: string): number {
        return this.liveRouteTable.get(nodeId)?.length ?? 0
    }

    // ── Interface counters view ────────────────────────────────────────────────

    toggleCounterView (): void {
        this.showCounterView = !this.showCounterView
        if (this.showCounterView && !this.liveInterfaceCounters.size) {
            this.fetchInterfaceCounters()
        }
        this.cdr.markForCheck()
    }

    async fetchInterfaceCounters (): Promise<void> {
        this.counterFetching = true
        this.cdr.markForCheck()
        const api = (window as any).netopsAPI
        if (!api?.sshRunCommand) { this.counterFetching = false; return }

        for (const node of this.topology.nodes) {
            const host = (node.mgmtIp ?? '').split('/')[0].trim()
            if (!host || !node.sshUsername || !node.vendor) { continue }
            const cmds = getVendorCommands(node.vendor)
            if (!cmds.showInterfaceCounters) { continue }
            try {
                let result: any
                if (this._backendSvc?.isConnected) {
                    result = await this._backendSvc.runCommand(host, node.sshPort ?? 22, node.sshUsername, node.sshPassword ?? '', cmds.showInterfaceCounters)
                } else {
                    result = await api.sshRunCommand({
                        host, port: node.sshPort ?? 22,
                        username: node.sshUsername, password: node.sshPassword ?? '',
                        timeoutMs: 15000, command: cmds.showInterfaceCounters,
                    })
                }
                if (result.ok && result.output) {
                    this.liveInterfaceCounters.set(node.id, parseInterfaceCounters(node.vendor, result.output))
                }
            } catch (err) { console.warn('Health poll failed:', (err as Error).message) }
        }
        this.counterFetching = false
        this.statusMsg = `Fetched counters from ${this.liveInterfaceCounters.size} device(s)`
        this.cdr.markForCheck()
    }

    /** Get total error count for a node (for display) */
    nodeErrorCount (nodeId: string): number {
        const counters = this.liveInterfaceCounters.get(nodeId)
        if (!counters) { return 0 }
        let total = 0
        counters.forEach(c => { total += c.rxErrors + c.txErrors })
        return total
    }

    // ── Import from running lab ──────────────────────────────────────────────

    async importFromRunningLab (lab: { labName: string; topoFile: string; containers: Array<{ name: string; state: string; ipv4Address: string; ipv6Address: string; kind: string; image: string }> }): Promise<void> {
        const api = (window as any).netopsAPI

        // Parse topology file if available
        if (lab.topoFile && api?.clabParseTopology) {
            try {
                const parsed = await api.clabParseTopology({ filePath: lab.topoFile })
                if (parsed.ok && parsed.nodes?.length) {
                    this._loadTopologyFromClab(parsed.labName, parsed.nodes, parsed.links ?? [])
                }
            } catch (err) {
                this.statusMsg = `Could not parse topology: ${(err as Error).message}`
                this.cdr.markForCheck()
                return
            }
        } else {
            // Build minimal topology from container list
            const clabNodes = lab.containers.map(c => ({
                name: c.name.replace(`clab-${lab.labName}-`, ''),
                kind: c.kind,
                image: c.image,
            }))
            this._loadTopologyFromClab(lab.labName, clabNodes, [])
        }

        this.clabContainers = lab.containers
        this.clabDeployed = true
        this.clabFilePath = lab.topoFile || null
        this.showDetectLabDialog = false
        this.startLivePolling()
        this.statusMsg = `Imported topology from "${lab.labName}" — ${lab.containers.length} container(s)`
        this.cdr.markForCheck()
    }

    openAutoIpDialog (): void {
        if (!this.topology.links.length) {
            this.statusMsg = 'No links to auto-address'
            this.cdr.markForCheck()
            return
        }

        this.autoIpDialogError = ''
        this.autoIpInput = this.autoIpBaseCidr
        this.autoIpHasExisting = this.topology.links.some(link => {
            const sp = this._getPort(link.sourceNodeId, link.sourcePortId)
            const tp = this._getPort(link.targetNodeId, link.targetPortId)
            return !!(sp?.ipAddress?.trim() || tp?.ipAddress?.trim())
        })
        this.autoIpOverwriteExisting = false
        this.showAutoIpDialog = true
        this.cdr.markForCheck()
    }

    cancelAutoIpDialog (): void {
        this.showAutoIpDialog = false
        this.autoIpDialogError = ''
        this.cdr.markForCheck()
    }

    openClabDialog (): void {
        // Detect vendor composition and set smart defaults
        this.clabVendorInfo = this._getTopologyVendorComposition()
        this.clabImageInput = this.clabVendorInfo.hasSonic ? 'netreplica/docker-sonic-vs:latest' : ''
        this.clabWarnings = this._computeClabWarnings()
        this.clabMgmtSubnet = ''
        this.clabDialogError = ''
        this.clabPrereqChecked = false
        this.clabStartingDocker = false
        this.clabDeploying = false
        this.clabInstallingClab = false
        this.clabLoadingImage = false
        this.clabImages = []
        this.clabImagesChecked = false
        this.clabValidating = false
        this.clabValidationErrors = []
        this.clabValidationWarnings = []
        this.clabValidationDone = false
        this.showClabDialog = true
        this.cdr.markForCheck()
        // Load servers then check prereqs, then run pre-deploy validation
        this._loadClabServers().then(async () => {
            await this._checkClabPrereqs()
            await this.runPreDeployValidation()
        })
        this._fetchAvailableDockerImages()
    }

    cancelClabDialog (): void {
        this.showClabDialog = false
        this.clabDialogError = ''
        this.clabDeploying = false
        this.cdr.markForCheck()
    }

    private async _fetchAvailableDockerImages (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.dockerListImages) { return }
        try {
            const res = await api.dockerListImages()
            if (Array.isArray(res?.images)) {
                this.availableDockerImages = res.images
                    .map((img: any) => img.name ?? img)
                    .filter((name: string) => name && name !== '<none>:<none>')
                    .sort()
            }
        } catch { /* ignore */ }
        this.cdr.markForCheck()
    }

    // ── Containerlab server management ────────────────────────────────────

    private async _loadClabServers (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabServerList) { return }
        try {
            const res = await api.clabServerList()
            this.clabServers = res.profiles ?? []
            this.clabActiveServerId = res.activeServerId ?? 'local'
            this.cdr.markForCheck()
        } catch { /* ignore */ }
    }

    async switchClabServer (id: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabServerSetActive) { return }
        try {
            await api.clabServerSetActive({ id })
            this.clabActiveServerId = id
            // Clear caches for new server
            this._hostIfaceCache.clear()
            this._bridgeListCache.clear()
            // Re-check prereqs for new server
            this.clabPrereqChecked = false
            this.clabImagesChecked = false
            this.cdr.markForCheck()
            this._checkClabPrereqs()
            this._startHeartbeat()
        } catch { /* ignore */ }
    }

    openClabServerSettings (): void {
        this.showClabServerSettings = true
        this.editingServer = null
        this.clabServerTestResult = null
        this.cdr.markForCheck()
    }

    closeClabServerSettings (): void {
        this.showClabServerSettings = false
        this.editingServer = null
        this.cdr.markForCheck()
    }

    addNewServer (): void {
        this.editingServer = {
            id: `server-${Date.now()}`,
            name: '',
            type: 'ssh',
            host: '',
            port: 22,
            username: '',
            password: '',
            remoteLabDir: '/tmp/containerlab-labs',
        }
        this.clabServerTestResult = null
        this.cdr.markForCheck()
    }

    editServer (s: { id: string; name: string; type: 'local' | 'ssh'; host?: string; port?: number; username?: string; password?: string; remoteLabDir?: string }): void {
        if (s.type === 'local') { return }
        this.editingServer = {
            id: s.id,
            name: s.name,
            type: 'ssh',
            host: s.host ?? '',
            port: s.port ?? 22,
            username: s.username ?? '',
            password: s.password ?? '',
            remoteLabDir: s.remoteLabDir ?? '/tmp/containerlab-labs',
        }
        this.clabServerTestResult = null
        this.cdr.markForCheck()
    }

    async saveServer (): Promise<void> {
        if (!this.editingServer) { return }
        const api = (window as any).netopsAPI
        if (!api?.clabServerSave) { return }

        const profile = { ...this.editingServer }
        if (!profile.name.trim()) { profile.name = profile.host || 'Remote Server' }

        try {
            await api.clabServerSave({ profile })
            await this._loadClabServers()
            this.editingServer = null
            this.cdr.markForCheck()
        } catch { /* ignore */ }
    }

    async deleteServer (id: string): Promise<void> {
        if (id === 'local') { return }
        const api = (window as any).netopsAPI
        if (!api?.clabServerDelete) { return }
        try {
            await api.clabServerDelete({ id })
            if (this.clabActiveServerId === id) {
                await this.switchClabServer('local')
            }
            await this._loadClabServers()
            this.cdr.markForCheck()
        } catch { /* ignore */ }
    }

    async testServer (id: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabServerTest) { return }
        this.clabServerTesting = true
        this.clabServerTestResult = null
        this.cdr.markForCheck()
        try {
            const res = await api.clabServerTest({ id })
            this.clabServerTestResult = {
                ok: res.ok,
                message: res.message,
                ssh: res.ssh ?? false,
                docker: res.docker ?? false,
                clab: res.clab ?? false,
                kvm: res.kvm ?? false,
            }
            // Auto-activate server on successful test
            if (res.ok && id !== this.clabActiveServerId) {
                await this.switchClabServer(id)
                this._startHeartbeat()
                this._pollServerResources()
            }
        } catch (e: any) {
            this.clabServerTestResult = { ok: false, message: e?.message ?? 'Test failed' }
        }
        this.clabServerTesting = false
        this.cdr.markForCheck()
    }

    get activeClabServerName (): string {
        const s = this.clabServers.find(p => p.id === this.clabActiveServerId)
        return s?.name ?? 'Local'
    }

    get hasClabArchMismatch (): boolean {
        return this.clabImages.some(i => i.archMismatch)
    }

    // ── Server heartbeat & connection indicator ──────────────────────────

    private _startHeartbeat (): void {
        this._stopHeartbeat()
        const server = this.clabServers.find(s => s.id === this.clabActiveServerId)
        if (!server || server.type === 'local') {
            this.serverConnectionStatus = 'local'
            this.cdr.markForCheck()
            return
        }
        // Immediate check
        this._doHeartbeat()
        // Poll every 30 seconds
        this._heartbeatTimer = setInterval(() => this._doHeartbeat(), 30_000)
    }

    private _stopHeartbeat (): void {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer)
            this._heartbeatTimer = null
        }
    }

    private async _doHeartbeat (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabServerHeartbeat) { return }
        try {
            const res = await api.clabServerHeartbeat()
            this.serverConnectionStatus = res.ok ? 'connected' : 'disconnected'
        } catch {
            this.serverConnectionStatus = 'disconnected'
        }
        this.cdr.markForCheck()
    }

    // ── Server Manager dialog ────────────────────────────────────────────

    openServerManager (): void {
        this.showServerManager = true
        this._loadClabServers().then(() => {
            this._startServerResourcePolling()
            this.cdr.markForCheck()
        })
    }

    closeServerManager (): void {
        this.showServerManager = false
        this._stopServerResourcePolling()
        this.cdr.markForCheck()
    }

    private _startServerResourcePolling (): void {
        this._stopServerResourcePolling()
        // Poll resources for active server immediately
        this._pollServerResources()
        this._serverResourceTimer = setInterval(() => this._pollServerResources(), 30_000)
    }

    private _stopServerResourcePolling (): void {
        if (this._serverResourceTimer) {
            clearInterval(this._serverResourceTimer)
            this._serverResourceTimer = null
        }
    }

    private async _pollServerResources (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabServerResources) { return }

        // Mark active server as checking
        const activeId = this.clabActiveServerId
        this.serverManagerResources[activeId] = {
            ...(this.serverManagerResources[activeId] ?? { cpu: '—', mem: '—', disk: '—', containers: 0, vms: 0, kvm: false }),
            status: 'checking',
        }
        this.cdr.markForCheck()

        try {
            const res = await api.clabServerResources()
            if (res.ok) {
                this.serverManagerResources[activeId] = {
                    cpu: res.cpu ?? '—',
                    mem: `${res.memUsed ?? '—'} / ${res.memTotal ?? '—'}`,
                    disk: `${res.diskUsed ?? '—'} / ${res.diskTotal ?? '—'}`,
                    containers: res.containers ?? 0,
                    vms: res.vms ?? 0,
                    kvm: res.kvm ?? false,
                    status: 'connected',
                }
                // Track CPU history for sparklines
                const cpuVal = parseFloat(String(res.cpu ?? '0').replace('%', ''))
                if (!isNaN(cpuVal)) {
                    if (!this.serverResourceHistory[activeId]) { this.serverResourceHistory[activeId] = [] }
                    this.serverResourceHistory[activeId].push(cpuVal)
                    if (this.serverResourceHistory[activeId].length > 30) {
                        this.serverResourceHistory[activeId].shift()
                    }
                }
            } else {
                this.serverManagerResources[activeId] = {
                    cpu: '—', mem: '—', disk: '—', containers: 0, vms: 0, kvm: false,
                    status: 'disconnected',
                }
            }
        } catch {
            this.serverManagerResources[activeId] = {
                cpu: '—', mem: '—', disk: '—', containers: 0, vms: 0, kvm: false,
                status: 'disconnected',
            }
        }
        this.cdr.markForCheck()
    }

    // ── Lab Snapshots ─────────────────────────────────────────────────────

    async openSnapshotDialog (): Promise<void> {
        this.showSnapshotDialog = true
        this.snapshotName = `snap-${Date.now()}`
        await this._loadSnapshots()
        this.cdr.markForCheck()
    }

    private async _loadSnapshots (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabSnapshotList) { return }
        try {
            const result = await api.clabSnapshotList()
            this.snapshotList = result.ok ? (result.snapshots ?? []) : []
        } catch {
            this.snapshotList = []
        }
        this.cdr.markForCheck()
    }

    async createSnapshot (): Promise<void> {
        if (!this.clabContainers.length) {
            this.statusMsg = 'No deployed containers to snapshot'
            this.cdr.markForCheck()
            return
        }
        const api = (window as any).netopsAPI
        if (!api?.clabSnapshotCreate) { return }
        this.snapshotCreating = true
        this.cdr.markForCheck()
        try {
            const result = await api.clabSnapshotCreate({
                containers: this.clabContainers.map(c => c.name),
                snapshotName: this.snapshotName || `snap-${Date.now()}`,
            })
            this.statusMsg = result.ok ? `Snapshot created: ${result.message}` : `Snapshot failed: ${result.message}`
            await this._loadSnapshots()
        } catch {
            this.statusMsg = 'Snapshot creation failed'
        }
        this.snapshotCreating = false
        this.cdr.markForCheck()
    }

    // ── File Browser ───────────────────────────────────────────────────────

    openFileBrowser (): void {
        this.showFileBrowser = true
        this.fileBrowserPath = '/'
        this.fileBrowserFileContent = ''
        this.fileBrowserViewingFile = ''
        this.browseDir('/')
    }

    async browseDir (dir: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.sftpListDir) { return }
        this.fileBrowserLoading = true
        this.fileBrowserPath = dir
        this.fileBrowserFileContent = ''
        this.fileBrowserViewingFile = ''
        this.cdr.markForCheck()
        try {
            const result = await api.sftpListDir({ path: dir })
            if (result.ok) {
                this.fileBrowserItems = (result.items ?? []).sort((a: any, b: any) => {
                    if (a.isDir !== b.isDir) { return a.isDir ? -1 : 1 }
                    return a.name.localeCompare(b.name)
                })
            } else {
                this.fileBrowserItems = []
                this.statusMsg = result.message
            }
        } catch {
            this.fileBrowserItems = []
        }
        this.fileBrowserLoading = false
        this.cdr.markForCheck()
    }

    navigateUp (): void {
        const parts = this.fileBrowserPath.replace(/\/$/, '').split('/')
        parts.pop()
        const parent = parts.join('/') || '/'
        this.browseDir(parent)
    }

    async viewFile (name: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.sftpReadFile) { return }
        const fullPath = this.fileBrowserPath.endsWith('/') ? this.fileBrowserPath + name : this.fileBrowserPath + '/' + name
        try {
            const result = await api.sftpReadFile({ path: fullPath })
            if (result.ok) {
                this.fileBrowserViewingFile = name
                this.fileBrowserFileContent = result.content
            } else {
                this.statusMsg = `Read failed: ${result.message}`
            }
        } catch {
            this.statusMsg = 'Read failed'
        }
        this.cdr.markForCheck()
    }

    async deleteRemoteFile (name: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.sftpDeleteFile) { return }
        const fullPath = this.fileBrowserPath.endsWith('/') ? this.fileBrowserPath + name : this.fileBrowserPath + '/' + name
        try {
            const result = await api.sftpDeleteFile({ path: fullPath })
            if (result.ok) {
                this.browseDir(this.fileBrowserPath)
            } else {
                this.statusMsg = result.message
                this.cdr.markForCheck()
            }
        } catch {
            this.statusMsg = 'Delete failed'
            this.cdr.markForCheck()
        }
    }

    formatFileSize (bytes: number): string {
        if (bytes < 1024) { return `${bytes} B` }
        if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB` }
        if (bytes < 1024 * 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(1)} MB` }
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    }

    /** Generate SVG sparkline path for server CPU history */
    sparklinePath (serverId: string): string {
        const data = this.serverResourceHistory[serverId]
        if (!data || data.length < 2) { return '' }
        const w = 80, h = 20
        const max = Math.max(...data, 100)
        const step = w / (data.length - 1)
        return data.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ')
    }

    /** Attempt to reconnect to a previously running lab on startup */
    private async _autoReconnectOnStartup (): Promise<void> {
        try {
            const raw = localStorage.getItem('netops-last-lab')
            if (!raw) { return }
            const saved = JSON.parse(raw)
            if (!saved?.labName || !saved?.serverId) { return }

            // Only auto-reconnect if on the same server
            if (saved.serverId !== this.clabActiveServerId) { return }

            const api = (window as any).netopsAPI
            if (!api?.clabDetectRunning) { return }

            const result = await api.clabDetectRunning()
            if (!result.ok || !result.labs?.length) { return }

            const lab = result.labs.find((l: any) => l.labName === saved.labName)
            if (!lab) {
                // Lab no longer running — clear stored state
                localStorage.removeItem('netops-last-lab')
                return
            }

            // Auto-reconnect silently
            this.reconnectLab(lab)
        } catch { /* ignore — silent startup check */ }
    }


    // ── Docker Image Manager ──────────────────────────────────────────────

    openImageManager (): void {
        this.showImageManager = true
        this.imageTagSource = ''
        this.imageTagTarget = ''
        this.imageManagerError = ''
        this.cdr.markForCheck()
        this._loadClabServers()
        this.loadAllImages()
    }

    closeImageManager (): void {
        this.showImageManager = false
        this.imageManagerError = ''
        this.cdr.markForCheck()
    }

    async switchImageManagerServer (id: string): Promise<void> {
        await this.switchClabServer(id)
        this.loadAllImages()
    }

    /** Parse human-readable size strings like "195MB", "1.2GB" to bytes for comparison */
    private _parseSizeToBytes (s: string): number {
        const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)/i)
        if (!m) { return 0 }
        const val = parseFloat(m[1])
        const unit = m[2].toUpperCase()
        const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }
        return val * (multipliers[unit] ?? 0)
    }

    /** Parse age strings like "2 weeks ago", "3 months ago" to rough seconds for comparison */
    private _parseAgeToSeconds (s: string): number {
        const m = s.match(/^(\d+)\s*(second|minute|hour|day|week|month|year)/i)
        if (!m) { return 0 }
        const val = parseInt(m[1], 10)
        const unit = m[2].toLowerCase()
        const multipliers: Record<string, number> = {
            second: 1, minute: 60, hour: 3600, day: 86400,
            week: 604800, month: 2592000, year: 31536000,
        }
        return val * (multipliers[unit] ?? 0)
    }

    /** Image names from local Docker for the node-properties server image picker */
    get localDockerImageNames (): string[] {
        return this.allDockerImages.map(i => i.name).filter(n => n !== '<none>:<none>')
    }

    get sortedDockerImages (): typeof this.allDockerImages {
        const images = [...this.allDockerImages]
        const dir = this.imageSortDir === 'asc' ? 1 : -1
        images.sort((a, b) => {
            let cmp = 0
            switch (this.imageSortField) {
                case 'name':
                    cmp = a.name.localeCompare(b.name)
                    break
                case 'size':
                    cmp = this._parseSizeToBytes(a.size) - this._parseSizeToBytes(b.size)
                    break
                case 'arch':
                    cmp = a.arch.localeCompare(b.arch)
                    break
                case 'created':
                    cmp = this._parseAgeToSeconds(a.created) - this._parseAgeToSeconds(b.created)
                    break
            }
            return cmp * dir
        })
        return images
    }

    toggleImageSort (field: 'name' | 'size' | 'arch' | 'created'): void {
        if (this.imageSortField === field) {
            this.imageSortDir = this.imageSortDir === 'asc' ? 'desc' : 'asc'
        } else {
            this.imageSortField = field
            this.imageSortDir = 'asc'
        }
        this.cdr.markForCheck()
    }

    async loadAllImages (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.dockerListImages) { return }
        this.imageManagerLoading = true
        this.cdr.markForCheck()
        try {
            const result = await api.dockerListImages()
            this.allDockerImages = result.images ?? []
            this.imageManagerHostArch = result.hostArch ?? ''
            if (result.error) { this.imageManagerError = result.error }
        } catch {
            this.imageManagerError = 'Failed to list Docker images'
        }
        this.imageManagerLoading = false
        this.cdr.markForCheck()
        // Load disk usage in parallel (non-blocking)
        this._loadDockerDiskUsage()
    }

    private async _loadDockerDiskUsage (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.dockerSystemDf) { return }
        try {
            const result = await api.dockerSystemDf()
            this.dockerDiskUsage = result.ok ? (result.rows ?? []) : []
        } catch {
            this.dockerDiskUsage = []
        }
        this.cdr.markForCheck()
    }

    // ── vrnetlab Image Builder ──────────────────────────────────────────

    async openVrnetlabBuilder (): Promise<void> {
        const api = (window as any).netopsAPI
        if (api?.vrnetlabVendors) {
            try {
                this.vrnetlabVendors = await api.vrnetlabVendors()
            } catch { /* ignore */ }
        }
        this.vrnetlabVendor = ''
        this.vrnetlabImagePath = ''
        this.vrnetlabBuilding = false
        this.vrnetlabBuildError = ''
        this.showVrnetlabBuilder = true
        this.cdr.markForCheck()
    }

    closeVrnetlabBuilder (): void {
        this.showVrnetlabBuilder = false
        this.cdr.markForCheck()
    }

    async selectVrnetlabImage (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.vrnetlabSelectImage) { return }
        try {
            const result = await api.vrnetlabSelectImage()
            if (result.ok && result.path) {
                this.vrnetlabImagePath = result.path
            }
        } catch { /* ignore */ }
        this.cdr.markForCheck()
    }

    async startVrnetlabBuild (): Promise<void> {
        if (!this.vrnetlabVendor || !this.vrnetlabImagePath) { return }
        const api = (window as any).netopsAPI
        if (!api?.vrnetlabBuildImage) { return }
        this.vrnetlabBuilding = true
        this.vrnetlabBuildError = ''
        this.cdr.markForCheck()
        try {
            const result = await api.vrnetlabBuildImage({
                vendor: this.vrnetlabVendor,
                vmImagePath: this.vrnetlabImagePath,
            })
            if (!result.ok) {
                this.vrnetlabBuildError = result.message ?? 'Build failed'
            } else {
                // Build launched in terminal — close builder dialog
                this.showVrnetlabBuilder = false
                this.statusMsg = 'vrnetlab build started in terminal. Refresh Docker Image Manager when done.'
            }
        } catch (err) {
            this.vrnetlabBuildError = 'Build failed'
        }
        this.vrnetlabBuilding = false
        this.cdr.markForCheck()
    }

    // ── VM Manager (libvirt/virsh) ──────────────────────────────────────

    async openVmManager (): Promise<void> {
        this.showVmManager = true
        this.vmManagerError = ''
        this.showVmCreateForm = false
        this.vmSnapshotTarget = ''
        this.cdr.markForCheck()
        await this._loadClabServers()
        await this.refreshVmList()
        this.cdr.markForCheck()
    }

    closeVmManager (): void {
        this.showVmManager = false
        this.cdr.markForCheck()
    }

    async switchVmManagerServer (id: string): Promise<void> {
        await this.switchClabServer(id)
        await this.refreshVmList()
        this.cdr.markForCheck()
    }

    async refreshVmList (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.virshList) { return }
        this.vmManagerLoading = true
        this.cdr.markForCheck()
        try {
            const result = await api.virshList()
            if (result.ok) {
                this.vmList = result.vms ?? []
                this.vmManagerError = ''
            } else {
                this.vmList = []
                this.vmManagerError = result.message || 'virsh not available'
            }
        } catch {
            this.vmList = []
            this.vmManagerError = 'Failed to list VMs'
        }
        this.vmManagerLoading = false
        this.cdr.markForCheck()
    }

    async vmAction (vmName: string, action: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.virshAction) { return }
        try {
            const result = await api.virshAction({ vm: vmName, action })
            if (!result.ok) {
                this.vmManagerError = result.message || `${action} failed`
            }
        } catch {
            this.vmManagerError = `${action} failed`
        }
        this.cdr.markForCheck()
        await this.refreshVmList()
    }

    async openVmConsole (vmName: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.virshConsole) { return }
        try {
            await api.virshConsole({ vm: vmName })
        } catch { /* terminal window opens independently */ }
    }

    toggleVmCreateForm (): void {
        this.showVmCreateForm = !this.showVmCreateForm
        if (this.showVmCreateForm) {
            this.vmCreateName = ''
            this.vmCreateCpu = 2
            this.vmCreateMemory = 2048
            this.vmCreateDiskPath = ''
            this.vmCreateBridge = 'virbr0'
            this.vmUploadError = ''
            // Auto-load disk image library
            if (!this.vmDiskImagesLoaded) {
                this.refreshDiskImages()
            }
        }
        this.cdr.markForCheck()
    }

    async selectVmDiskImage (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.vrnetlabSelectImage) { return }
        try {
            const result = await api.vrnetlabSelectImage()
            if (result.ok && result.path) {
                this.vmCreateDiskPath = result.path
            }
        } catch { /* ignore */ }
        this.cdr.markForCheck()
    }

    async createVm (): Promise<void> {
        if (!this.vmCreateName.trim() || !this.vmCreateDiskPath.trim()) { return }
        const api = (window as any).netopsAPI
        if (!api?.virshCreateVm) { return }
        this.vmCreating = true
        this.vmManagerError = ''
        this.cdr.markForCheck()
        try {
            const result = await api.virshCreateVm({
                name: this.vmCreateName.trim(),
                cpu: this.vmCreateCpu,
                memoryMb: this.vmCreateMemory,
                diskPath: this.vmCreateDiskPath.trim(),
                networkBridge: this.vmCreateBridge.trim() || 'virbr0',
            })
            if (result.ok) {
                this.showVmCreateForm = false
                await this.refreshVmList()
            } else {
                this.vmManagerError = result.message || 'Create VM failed'
            }
        } catch {
            this.vmManagerError = 'Create VM failed'
        }
        this.vmCreating = false
        this.cdr.markForCheck()
    }

    async loadVmSnapshots (vmName: string): Promise<void> {
        if (this.vmSnapshotTarget === vmName) {
            this.vmSnapshotTarget = ''
            this.vmSnapshots = []
            this.cdr.markForCheck()
            return
        }
        this.vmSnapshotTarget = vmName
        const api = (window as any).netopsAPI
        if (!api?.virshSnapshotList) { return }
        try {
            const result = await api.virshSnapshotList({ vm: vmName })
            this.vmSnapshots = result.ok ? (result.snapshots ?? []) : []
        } catch {
            this.vmSnapshots = []
        }
        this.cdr.markForCheck()
    }

    async createVmSnapshot (vmName: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.virshSnapshotCreate) { return }
        try {
            const result = await api.virshSnapshotCreate({ vm: vmName, name: `snap-${Date.now()}` })
            if (!result.ok) {
                this.vmManagerError = result.message || 'Snapshot failed'
            }
        } catch {
            this.vmManagerError = 'Snapshot failed'
        }
        await this.loadVmSnapshots(vmName)
        this.cdr.markForCheck()
    }

    async revertVmSnapshot (vmName: string, snapName: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.virshSnapshotRevert) { return }
        try {
            const result = await api.virshSnapshotRevert({ vm: vmName, name: snapName })
            if (!result.ok) {
                this.vmManagerError = result.message || 'Snapshot revert failed'
            }
        } catch {
            this.vmManagerError = 'Snapshot revert failed'
        }
        await this.refreshVmList()
        await this.loadVmSnapshots(vmName)
        this.cdr.markForCheck()
    }

    vmStateClass (state: string): string {
        const s = state.toLowerCase()
        if (s.includes('running')) { return 'vm-state-running' }
        if (s.includes('paused') || s.includes('suspend')) { return 'vm-state-paused' }
        return 'vm-state-off'
    }

    // ── VM Delete / Snapshot Delete / Autostart ─────────────────────────

    confirmDeleteVm (vmName: string): void {
        this.vmDeleteConfirm = vmName
        this.vmDeleteStorage = false
        this.cdr.markForCheck()
    }

    cancelDeleteVm (): void {
        this.vmDeleteConfirm = ''
        this.cdr.markForCheck()
    }

    async deleteVm (): Promise<void> {
        if (!this.vmDeleteConfirm) { return }
        const api = (window as any).netopsAPI
        if (!api?.virshDeleteVm) { return }
        try {
            const result = await api.virshDeleteVm({ vm: this.vmDeleteConfirm, removeStorage: this.vmDeleteStorage })
            if (!result.ok) {
                this.vmManagerError = result.message || 'Delete failed'
            }
        } catch {
            this.vmManagerError = 'Delete VM failed'
        }
        this.vmDeleteConfirm = ''
        this.cdr.markForCheck()
        await this.refreshVmList()
    }

    async deleteVmSnapshot (vmName: string, snapName: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.virshSnapshotDelete) { return }
        try {
            const result = await api.virshSnapshotDelete({ vm: vmName, name: snapName })
            if (!result.ok) {
                this.vmManagerError = result.message || 'Snapshot delete failed'
            }
        } catch {
            this.vmManagerError = 'Snapshot delete failed'
        }
        await this.loadVmSnapshots(vmName)
        this.cdr.markForCheck()
    }

    async toggleVmAutostart (vmName: string, enable: boolean): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.virshAutostart) { return }
        try {
            const result = await api.virshAutostart({ vm: vmName, enable })
            if (!result.ok) {
                this.vmManagerError = result.message || 'Autostart toggle failed'
            } else {
                await this.refreshVmList()
            }
        } catch {
            this.vmManagerError = 'Autostart toggle failed'
        }
        this.cdr.markForCheck()
    }

    // ── Disk Image Library ────────────────────────────────────────────

    async refreshDiskImages (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.virshListDiskImages) { return }
        this.vmDiskImagesLoading = true
        this.cdr.markForCheck()
        try {
            const result = await api.virshListDiskImages()
            if (result.ok) {
                this.vmDiskImages = result.images ?? []
                this.vmDiskImagesLoaded = true
            } else {
                this.vmManagerError = result.message || 'Failed to list disk images'
            }
        } catch {
            this.vmManagerError = 'Failed to list disk images'
        }
        this.vmDiskImagesLoading = false
        this.cdr.markForCheck()
    }

    selectDiskImageFromLibrary (img: { name: string; size: string; path: string }): void {
        this.vmCreateDiskPath = img.path
        this.cdr.markForCheck()
    }

    async uploadDiskImage (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.vrnetlabSelectImage || !api?.virshUploadDiskImage) { return }

        // First, pick a local file
        let localPath = ''
        try {
            const pick = await api.vrnetlabSelectImage()
            if (!pick.ok || !pick.path) { return }
            localPath = pick.path
        } catch { return }

        this.vmUploadingImage = true
        this.vmUploadError = ''
        this.cdr.markForCheck()

        try {
            const result = await api.virshUploadDiskImage({ localPath })
            if (result.ok) {
                // Refresh the image list to show the new image
                await this.refreshDiskImages()
                // Auto-select the uploaded image
                if (result.path) {
                    this.vmCreateDiskPath = result.path
                }
            } else {
                this.vmUploadError = result.message || 'Upload failed'
            }
        } catch {
            this.vmUploadError = 'Upload failed'
        }
        this.vmUploadingImage = false
        this.cdr.markForCheck()
    }

    // ── Bridge Manager ──────────────────────────────────────────────────

    async openBridgeManager (): Promise<void> {
        this.showBridgeManager = true
        this.bridgeManagerError = ''
        this.showBridgeCreateForm = false
        this.cdr.markForCheck()
        await this._loadClabServers()
        await this.refreshBridgeList()
        this.cdr.markForCheck()
    }

    closeBridgeManager (): void {
        this.showBridgeManager = false
        this.cdr.markForCheck()
    }

    async switchBridgeManagerServer (id: string): Promise<void> {
        await this.switchClabServer(id)
        await this.refreshBridgeList()
        this.cdr.markForCheck()
    }

    async refreshBridgeList (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.bridgeList) { return }
        this.bridgeManagerLoading = true
        this.cdr.markForCheck()
        try {
            const result = await api.bridgeList()
            if (result.ok) {
                this.bridgeList = result.bridges ?? []
                this.bridgeManagerError = ''
            } else {
                this.bridgeList = []
                this.bridgeManagerError = result.message || 'Failed to list bridges'
            }
        } catch {
            this.bridgeList = []
            this.bridgeManagerError = 'Failed to list bridges'
        }
        this.bridgeManagerLoading = false
        this.cdr.markForCheck()
    }

    toggleBridgeCreateForm (): void {
        this.showBridgeCreateForm = !this.showBridgeCreateForm
        if (this.showBridgeCreateForm) {
            this.bridgeCreateType = 'libvirt'
            this.bridgeCreateName = ''
            this.bridgeCreateMode = 'nat'
            this.bridgeCreateSubnet = ''
            this.bridgeCreateDhcp = true
            this.bridgeCreateDhcpStart = ''
            this.bridgeCreateDhcpEnd = ''
            this.bridgeCreateIpAddress = ''
            this.bridgeCreateVxlanRemote = ''
            this.bridgeCreateVni = 100
        }
        this.cdr.markForCheck()
    }

    async createBridge (): Promise<void> {
        if (!this.bridgeCreateName.trim()) { return }
        const api = (window as any).netopsAPI
        this.bridgeCreating = true
        this.bridgeManagerError = ''
        this.cdr.markForCheck()

        try {
            let result: any
            if (this.bridgeCreateType === 'libvirt') {
                if (!api?.bridgeCreateLibvirt) { return }
                result = await api.bridgeCreateLibvirt({
                    name: this.bridgeCreateName.trim(),
                    mode: this.bridgeCreateMode,
                    subnet: this.bridgeCreateSubnet.trim(),
                    dhcp: this.bridgeCreateDhcp,
                    dhcpStart: this.bridgeCreateDhcpStart.trim(),
                    dhcpEnd: this.bridgeCreateDhcpEnd.trim(),
                })
            } else if (this.bridgeCreateType === 'linux') {
                if (!api?.bridgeCreateLinux) { return }
                result = await api.bridgeCreateLinux({
                    name: this.bridgeCreateName.trim(),
                    ipAddress: this.bridgeCreateIpAddress.trim(),
                })
            } else {
                if (!api?.bridgeCreateOvs) { return }
                result = await api.bridgeCreateOvs({
                    name: this.bridgeCreateName.trim(),
                    vxlanRemote: this.bridgeCreateVxlanRemote.trim(),
                    vni: this.bridgeCreateVni,
                })
            }

            if (result?.ok) {
                this.showBridgeCreateForm = false
                await this.refreshBridgeList()
            } else {
                this.bridgeManagerError = result?.message || 'Create bridge failed'
            }
        } catch (e: any) {
            this.bridgeManagerError = e?.message || 'Create bridge failed'
        }
        this.bridgeCreating = false
        this.cdr.markForCheck()
    }

    async deleteBridge (br: { name: string; type: string }): Promise<void> {
        const api = (window as any).netopsAPI
        this.bridgeManagerError = ''
        try {
            let result: any
            if (br.type === 'libvirt') {
                result = await api?.bridgeDeleteLibvirt?.({ name: br.name })
            } else if (br.type === 'ovs') {
                result = await api?.bridgeDeleteOvs?.({ name: br.name })
            } else {
                result = await api?.bridgeDeleteLinux?.({ name: br.name })
            }
            if (!result?.ok) {
                this.bridgeManagerError = result?.message || 'Delete failed'
            }
        } catch {
            this.bridgeManagerError = 'Delete bridge failed'
        }
        this.cdr.markForCheck()
        await this.refreshBridgeList()
    }

    async bridgeAction (name: string, action: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.bridgeActionLibvirt) { return }
        try {
            const result = await api.bridgeActionLibvirt({ name, action })
            if (!result.ok) {
                this.bridgeManagerError = result.message || `${action} failed`
            }
        } catch {
            this.bridgeManagerError = `${action} failed`
        }
        this.cdr.markForCheck()
        await this.refreshBridgeList()
    }

    bridgeStateClass (state: string): string {
        const s = state.toLowerCase()
        if (s.includes('active') || s.includes('running') || s.includes('yes')) { return 'vm-state-running' }
        if (s.includes('inactive') || s.includes('no')) { return 'vm-state-off' }
        return 'vm-state-paused'
    }

    // ── VXLAN Tunnel Dialog ─────────────────────────────────────────────

    openVxlanDialog (): void {
        this.showVxlanDialog = true
        this.vxlanBridgeName = ''
        this.vxlanRemoteIp = ''
        this.vxlanVni = 100
        this.vxlanMethod = 'linux'
        this.vxlanCreating = false
        this.vxlanError = ''
        this.cdr.markForCheck()
    }

    closeVxlanDialog (): void {
        this.showVxlanDialog = false
        this.cdr.markForCheck()
    }

    async createVxlanTunnel (): Promise<void> {
        if (!this.vxlanBridgeName.trim() || !this.vxlanRemoteIp.trim()) { return }
        const api = (window as any).netopsAPI
        if (!api?.vxlanSetupTunnel) { return }
        this.vxlanCreating = true
        this.vxlanError = ''
        this.cdr.markForCheck()
        try {
            const result = await api.vxlanSetupTunnel({
                bridgeName: this.vxlanBridgeName.trim(),
                remoteIp: this.vxlanRemoteIp.trim(),
                vni: this.vxlanVni,
                method: this.vxlanMethod,
            })
            if (result.ok) {
                this.showVxlanDialog = false
                this.statusMsg = `VXLAN tunnel created: ${this.vxlanBridgeName} → ${this.vxlanRemoteIp} (VNI ${this.vxlanVni})`
            } else {
                this.vxlanError = result.message || 'Tunnel setup failed'
            }
        } catch {
            this.vxlanError = 'Tunnel setup failed'
        }
        this.vxlanCreating = false
        this.cdr.markForCheck()
    }

    async searchDockerHub (): Promise<void> {
        const term = this.dockerSearchTerm.trim()
        if (!term) { return }
        const api = (window as any).netopsAPI
        if (!api?.dockerSearch) { return }
        this.dockerSearching = true
        this.cdr.markForCheck()
        try {
            const result = await api.dockerSearch({ term })
            this.dockerSearchResults = result.ok ? (result.results ?? []) : []
            if (!result.ok) { this.imageManagerError = result.message }
        } catch {
            this.dockerSearchResults = []
        }
        this.dockerSearching = false
        this.cdr.markForCheck()
    }

    selectSearchResult (name: string): void {
        this.imagePullName = name
        this.dockerSearchResults = []
        this.dockerSearchTerm = ''
        this.cdr.markForCheck()
    }

    async deleteDockerImage (name: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.dockerDeleteImage) { return }
        try {
            const result = await api.dockerDeleteImage({ image: name })
            if (result.ok) {
                this.imageManagerError = ''
                this.loadAllImages()
            } else {
                this.imageManagerError = `Delete failed: ${result.message}`
                this.cdr.markForCheck()
            }
        } catch {
            this.imageManagerError = 'Delete failed'
            this.cdr.markForCheck()
        }
    }

    toggleImageSelect (name: string): void {
        if (this.imageManagerSelected.has(name)) {
            this.imageManagerSelected.delete(name)
        } else {
            this.imageManagerSelected.add(name)
        }
        this.cdr.markForCheck()
    }

    toggleSelectAllImages (): void {
        if (this.imageManagerSelected.size === this.allDockerImages.length) {
            this.imageManagerSelected.clear()
        } else {
            for (const img of this.allDockerImages) {
                this.imageManagerSelected.add(img.name)
            }
        }
        this.cdr.markForCheck()
    }

    get allImagesSelected (): boolean {
        return this.allDockerImages.length > 0 && this.imageManagerSelected.size === this.allDockerImages.length
    }

    async deleteSelectedImages (): Promise<void> {
        if (this.imageManagerSelected.size === 0) { return }
        const api = (window as any).netopsAPI
        if (!api?.dockerDeleteImages) { return }
        const images = Array.from(this.imageManagerSelected)
        this.imageManagerLoading = true
        this.cdr.markForCheck()
        try {
            const result = await api.dockerDeleteImages({ images })
            if (!result.ok) {
                this.imageManagerError = result.message
            } else {
                this.imageManagerError = ''
            }
            this.imageManagerSelected.clear()
            this.loadAllImages()
        } catch {
            this.imageManagerError = 'Bulk delete failed'
            this.imageManagerLoading = false
            this.cdr.markForCheck()
        }
    }

    startTagImage (name: string): void {
        this.imageTagSource = name
        this.imageTagTarget = ''
        this.cdr.markForCheck()
    }

    cancelTagImage (): void {
        this.imageTagSource = ''
        this.imageTagTarget = ''
        this.cdr.markForCheck()
    }

    async applyTagImage (): Promise<void> {
        if (!this.imageTagSource || !this.imageTagTarget.trim()) { return }
        const api = (window as any).netopsAPI
        if (!api?.dockerTagImage) { return }
        try {
            const result = await api.dockerTagImage({ source: this.imageTagSource, target: this.imageTagTarget.trim() })
            if (result.ok) {
                this.imageTagSource = ''
                this.imageTagTarget = ''
                this.imageManagerError = ''
                this.loadAllImages()
            } else {
                this.imageManagerError = `Tag failed: ${result.message}`
                this.cdr.markForCheck()
            }
        } catch {
            this.imageManagerError = 'Tag failed'
            this.cdr.markForCheck()
        }
    }

    async pullDockerImage (): Promise<void> {
        const name = this.imagePullName.trim()
        if (!name) { return }
        const api = (window as any).netopsAPI
        if (!api?.clabPullImage) { return }

        this.imagePulling = true
        this.imagePullError = ''
        this.cdr.markForCheck()

        try {
            const result = await api.clabPullImage({ image: name })
            if (result.ok) {
                this.imagePullName = ''
                this.imagePullError = ''
                this.loadAllImages()
            } else {
                this.imagePullError = result.message || 'Pull failed'
                this.cdr.markForCheck()
            }
        } catch {
            this.imagePullError = 'Pull request failed'
            this.cdr.markForCheck()
        }
        this.imagePulling = false
        this.cdr.markForCheck()
    }

    async importDockerImageFromManager (): Promise<void> {
        // Reuse the existing importDockerImage but refresh the manager list after
        await this.importDockerImage()
        if (this.showImageManager) {
            this.loadAllImages()
        }
    }

    private async _checkClabPrereqs (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabCheckPrereqs) { return }
        try {
            const p = await api.clabCheckPrereqs()
            this.clabDockerOk = p.docker
            this.clabDockerInstalled = p.dockerInstalled
            this.clabDockerMsg = p.dockerMessage
            this.clabClabOk = p.clab
            this.clabClabMsg = p.clabMessage
            this.clabPrereqChecked = true
        } catch {
            this.clabDockerOk = false
            this.clabDockerInstalled = false
            this.clabDockerMsg = 'Failed to check Docker status'
            this.clabClabOk = false
            this.clabClabMsg = 'Failed to check containerlab status'
            this.clabPrereqChecked = true
        }
        this.cdr.markForCheck()
        // If Docker is running, check required images
        if (this.clabDockerOk) {
            this._checkClabImages()
        }
    }

    /** Collect unique Docker images from topology and check local availability */
    private async _checkClabImages (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabCheckImages) {
            this.clabImagesChecked = true
            this.cdr.markForCheck()
            return
        }

        const imageNames = this._getRequiredImages()
        if (!imageNames.length) {
            this.clabImagesChecked = true
            this.cdr.markForCheck()
            return
        }

        try {
            const result = await api.clabCheckImages({ images: imageNames })
            this.clabHostArch = result.hostArch ?? ''
            this.clabImages = (result.images ?? []).map((img: any) => ({
                name: img.name,
                available: img.available,
                size: img.size || '',
                pulling: false,
                error: '',
                arch: img.arch || '',
                archMismatch: !!img.archMismatch,
                alternativeTags: img.alternativeTags ?? undefined,
            }))
        } catch {
            this.clabImages = imageNames.map(n => ({ name: n, available: false, size: '', pulling: false, error: 'check failed', arch: '', archMismatch: false }))
        }
        this.clabImagesChecked = true
        this.cdr.markForCheck()
    }

    /** Return unique Docker image names the current topology needs */
    private _getRequiredImages (): string[] {
        const kindDefaultImage: Record<string, string> = {
            'sonic-vs': this.clabImageInput || 'docker-sonic-vs:latest',
            'ceos':     'ceos:latest',
            'cisco_xrd':             'ios-xr/xrd-control-plane:latest',
            'cisco_xrv9k':           'vrnetlab/vr-xrv9k:latest',
            'cisco_csr1000v':        'vrnetlab/vr-csr:latest',
            'cisco_n9kv':            'vrnetlab/vr-n9kv:latest',
            'srl':      'ghcr.io/nokia/srlinux:latest',
            'crpd':     'crpd:latest',
            'juniper_vqfx':          'vrnetlab/vr-vqfx:latest',
            'juniper_vjunosswitch':  'vrnetlab/vr-vjunosswitch:latest',
            'juniper_vjunosrouter':  'vrnetlab/vr-vjunosrouter:latest',
            'juniper_vjunosevolved': 'vrnetlab/juniper_vjunosevolved:latest',
            'linux':    'alpine:latest',
        }
        const images = new Set<string>()
        // Only include the SONiC-VS primary image if topology has SONiC nodes
        const composition = this.clabVendorInfo ?? this._getTopologyVendorComposition()
        if (composition.hasSonic) {
            const primaryImage = (this.clabImageInput || 'netreplica/docker-sonic-vs:latest').trim()
            if (primaryImage) { images.add(primaryImage) }
        }
        for (const node of this.topology.nodes) {
            const kind = this._vendorToClabKind(node.vendor, node.model, node.switchFamily)
            // Per-node image override takes precedence
            if (node.image?.trim()) {
                images.add(node.image.trim())
            } else {
                images.add(kindDefaultImage[kind] ?? 'alpine:latest')
            }
        }
        return Array.from(images)
    }

    async pullClabImage (imageName: string): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabPullImage) { return }

        const entry = this.clabImages.find(i => i.name === imageName)
        if (!entry || entry.pulling) { return }

        entry.pulling = true
        entry.error = ''
        this.cdr.markForCheck()

        try {
            const result = await api.clabPullImage({ image: imageName })
            if (result.ok) {
                entry.available = true
                entry.pulling = false
                entry.error = ''
                // Re-check to get size
                this._checkClabImages()
            } else {
                entry.pulling = false
                entry.error = result.message || 'Pull failed'
            }
        } catch {
            entry.pulling = false
            entry.error = 'Pull request failed'
        }
        this.cdr.markForCheck()
    }

    recheckClabImages (): void {
        this.clabImagesChecked = false
        this.clabImages = []
        this.cdr.markForCheck()
        this._checkClabImages()
    }

    /** When multiple tags exist for a repo, let user pick which one to use */
    selectAlternativeTag (imageIdx: number, tag: string): void {
        if (imageIdx < 0 || imageIdx >= this.clabImages.length) { return }
        this.clabImages[imageIdx].name = tag
        // Keep dropdown visible so user can change selection again
        this.cdr.markForCheck()
    }

    clabLoadingImage = false
    clabLoadingImageMsg = ''

    async importDockerImage (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabLoadImage) { return }

        this.clabLoadingImage = true
        this.clabLoadingImageMsg = 'Selecting file…'
        this.clabDialogError = ''
        this.cdr.markForCheck()

        try {
            // Pass the primary image name so docker import can tag it correctly.
            // Try SONiC image first, then fall back to the first missing/mismatched image from the list.
            const imageName = this.clabImageInput.trim()
                || (this.clabVendorInfo?.hasSonic ? 'netreplica/docker-sonic-vs:latest' : '')
                || this.clabImages.find(i => !i.available || i.archMismatch)?.name
                || this.clabImages[0]?.name
                || ''

            // Show progress — file picker is open, once user selects, loading begins
            this.clabLoadingImageMsg = 'Loading image… this may take a few minutes for large files'
            this.cdr.markForCheck()

            const result = await api.clabLoadImage({ imageName })
            this.clabLoadingImage = false
            this.clabLoadingImageMsg = ''
            if (result.ok) {
                this.clabDialogError = ''
                this.statusMsg = result.message || 'Image loaded'
                // If the loaded image matches a required image, update its status
                if (result.imageName) {
                    const entry = this.clabImages.find(i => i.name === result.imageName)
                    if (entry) {
                        entry.available = true
                        entry.archMismatch = false
                        entry.error = ''
                    }
                }
                // Re-check all images to refresh statuses + arch
                this._checkClabImages()
            } else if (result.message !== 'Cancelled') {
                this.clabDialogError = `Load failed: ${result.message}`
            }
        } catch {
            this.clabLoadingImage = false
            this.clabLoadingImageMsg = ''
            this.clabDialogError = 'Failed to load Docker image'
        }
        this.cdr.markForCheck()
    }

    async startDockerFromDialog (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabStartDocker) { return }
        this.clabStartingDocker = true
        this.cdr.markForCheck()
        try {
            const result = await api.clabStartDocker()
            if (result.ok) {
                this.clabDockerMsg = result.message
                this.clabDialogError = ''
                // Re-check prereqs after delay to allow Docker to fully start
                setTimeout(() => this.recheckClabPrereqs(), 5000)
            } else {
                this.clabDialogError = result.message
            }
        } catch {
            this.clabDialogError = 'Failed to start Docker'
        }
        this.clabStartingDocker = false
        this.cdr.markForCheck()
    }

    recheckClabPrereqs (): void {
        this.clabPrereqChecked = false
        this.clabDialogError = ''
        this.clabImages = []
        this.clabImagesChecked = false
        this.cdr.markForCheck()
        this._checkClabPrereqs()
    }

    async autoInstallClab (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabAutoInstall) { return }
        this.clabInstallingClab = true
        this.clabDialogError = ''
        this.clabClabMsg = 'Downloading containerlab…'
        this.cdr.markForCheck()
        try {
            const result = await api.clabAutoInstall()
            if (result.ok) {
                this.clabClabMsg = result.message
                this.clabClabOk = true
                this.clabDialogError = ''
            } else {
                this.clabDialogError = result.message
                this.clabClabMsg = 'Install failed'
            }
        } catch {
            this.clabDialogError = 'Failed to install containerlab'
            this.clabClabMsg = 'Install failed'
        }
        this.clabInstallingClab = false
        this.cdr.markForCheck()
    }

    openServiceDialog (): void {
        this.serviceProfileId = ''
        this.serviceOverwrite = false
        this.serviceRegenConfigs = true
        this.showServiceDialog = true
        this.cdr.markForCheck()
    }

    cancelServiceDialog (): void {
        this.showServiceDialog = false
        this.cdr.markForCheck()
    }

    applyServiceDialog (): void {
        if (!this.serviceProfileId) { return }
        this.svc.applyServiceProfile(this.serviceProfileId, this.serviceOverwrite, this.serviceRegenConfigs)
        this.showServiceDialog = false
        this.cdr.markForCheck()
    }

    getServiceDescription (profileId: string): string {
        return SERVICE_PROFILES.find(p => p.id === profileId)?.description ?? ''
    }

    /** Recompute the endpoint stub map from current topology: finds free ports with configured vlanMode */
    private _computeNodeStubs (): void {
        this.nodeStubMap.clear()
        const topo = this.topology
        if (!topo?.nodes?.length) { return }

        // Build set of connected port keys  (nodeId:portId)
        const connected = new Set<string>()
        for (const link of topo.links) {
            connected.add(`${link.sourceNodeId}:${link.sourcePortId}`)
            connected.add(`${link.targetNodeId}:${link.targetPortId}`)
        }

        for (const node of topo.nodes) {
            let accessCount = 0
            let trunkCount = 0
            let accessVlan: number | undefined
            for (const port of node.ports) {
                const key = `${node.id}:${port.id}`
                if (connected.has(key)) { continue }  // skip connected ports
                if (!port.vlanMode) { continue }       // skip unconfigured
                if (port.vlanMode === 'access') {
                    accessCount++
                    if (accessVlan == null && port.vlan != null) { accessVlan = port.vlan }
                } else if (port.vlanMode === 'trunk') {
                    trunkCount++
                }
            }
            if (accessCount > 0) {
                const label = accessVlan != null ? `VLAN ${accessVlan}` : 'Access'
                this.nodeStubMap.set(node.id, { mode: 'access', label, count: accessCount })
            } else if (trunkCount > 0) {
                this.nodeStubMap.set(node.id, { mode: 'trunk', label: 'Trunk', count: trunkCount })
            }
        }
    }

    selectAll (): void {
        this.selectedNodeIds = new Set(this.topology.nodes.map(n => n.id))
        this.selectedLinkIds = new Set(this.topology.links.map(l => l.id))
        this.selectedShapeIds = new Set((this.topology.annotations ?? []).map(a => a.id))
        this._syncPrimarySelection()
        this.statusMsg = this._selectionStatus()
        this.cdr.markForCheck()
    }

    startAll (): void {
        this.svc.startAll()
        this.statusMsg = `All nodes running (${this.topology.nodes.length})`
        this.cdr.markForCheck()
    }

    stopAll (): void {
        this.svc.stopAll()
        this.statusMsg = 'All nodes stopped'
        this.cdr.markForCheck()
    }

    get runningCount (): number { return this.svc.runningCount }

    newTopology (): void {
        if (this.topology.nodes.length && !confirm('Discard current topology?')) { return }
        this.svc.newTopology()
        this.invSvc.reset()
        this._lastTopoFilePath = null
        this.statusMsg = 'New topology created'
    }

    async saveTopology (): Promise<void> {
        const json = this.svc.exportJSON()
        if (window.netopsAPI) {
            try {
                let res: { ok: boolean; filePath?: string; message?: string }
                if (this._lastTopoFilePath) {
                    // Auto-save to the same file — no dialog
                    res = await window.netopsAPI.saveTopologyDirect(json, this._lastTopoFilePath)
                } else {
                    // First save — show Save As dialog
                    res = await window.netopsAPI.saveTopology(json, this.topology.name)
                }
                if (res.ok) {
                    this.svc.notifySaved()
                    // Auto-save inventory sidecar alongside topology
                    if (res.filePath) {
                        this._lastTopoFilePath = res.filePath
                        const invPath = this._toInventoryPath(res.filePath)
                        this.invSvc.setSidecarPath(invPath)
                        await this.invSvc.save(invPath).catch(() => {})
                    }
                }
                this.statusMsg = res.ok ? `Saved to ${res.filePath}` : 'Save cancelled'
            } catch (err) {
                this.statusMsg = `Save failed: ${(err as Error).message ?? 'unknown error'}`
            }
        } else {
            // browser fallback
            const blob = new Blob([json], { type: 'application/json' })
            const url  = URL.createObjectURL(blob)
            const a    = document.createElement('a')
            a.href     = url
            a.download = `${this.topology.name.replace(/\s+/g, '_')}.topo.json`
            a.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
            this.svc.notifySaved()
            this.statusMsg = 'Topology downloaded'
        }
        this.cdr.markForCheck()
    }

    /** Save As — always shows the file dialog, even if a path is known */
    async saveTopologyAs (): Promise<void> {
        const json = this.svc.exportJSON()
        if (window.netopsAPI) {
            try {
                const res = await window.netopsAPI.saveTopology(json, this.topology.name)
                if (res.ok) {
                    this.svc.notifySaved()
                    if (res.filePath) {
                        this._lastTopoFilePath = res.filePath
                        const invPath = this._toInventoryPath(res.filePath)
                        this.invSvc.setSidecarPath(invPath)
                        await this.invSvc.save(invPath).catch(() => {})
                    }
                }
                this.statusMsg = res.ok ? `Saved to ${res.filePath}` : 'Save cancelled'
            } catch (err) {
                this.statusMsg = `Save failed: ${(err as Error).message ?? 'unknown error'}`
            }
        }
        this.cdr.markForCheck()
    }

    async loadTopology (): Promise<void> {
        this.importError = ''
        if (window.netopsAPI) {
            try {
                const res = await window.netopsAPI.loadTopology()
                if (!res.ok || !res.json) { this.statusMsg = 'Load cancelled'; this.cdr.markForCheck(); return }

                // Detect if user accidentally picked an inventory sidecar file
                if (res.filePath && /\.inv\.json$/i.test(res.filePath)) {
                    const topoPath = this._toTopoPath(res.filePath)
                    const topoRes = await window.netopsAPI.inventoryLoad(topoPath).catch(() => null)
                    if (topoRes?.ok && topoRes.json) {
                        const ok = this.svc.importJSON(topoRes.json)
                        if (ok) {
                            this._lastTopoFilePath = topoPath
                            await this.invSvc.load(res.filePath).catch(() => false)
                            this.invSvc.setSidecarPath(res.filePath)
                            this.statusMsg = `Loaded topology: ${this.topology.name} (inventory restored)`
                            this.cdr.markForCheck()
                            return
                        }
                    }
                    this.statusMsg = 'That is an inventory file. Please select the .topo.json file instead.'
                    this.importError = 'Selected .inv.json instead of .topo.json'
                    this.cdr.markForCheck()
                    return
                }

                const ok = this.svc.importJSON(res.json)
                if (!ok) {
                    // Check if user picked a workspace file
                    if (this._looksLikeWorkspace(res.json)) {
                        this.statusMsg = 'This is a workspace file. Use File → Open Workspace… to load it.'
                        this.importError = 'Selected workspace file instead of topology'
                    // Check if user picked an inventory file without .inv.json naming
                    } else if (this._looksLikeInventory(res.json)) {
                        this.statusMsg = 'That is an inventory file, not a topology. Please select the .topo.json file.'
                        this.importError = 'Selected inventory file instead of topology'
                    } else {
                        this.statusMsg = 'Invalid topology file'
                        this.importError = 'Invalid topology file'
                    }
                    this.cdr.markForCheck()
                    return
                }

                // Derive topology name from the filename (e.g. "my-lab.topo.json" → "my-lab")
                // Use renameTopology() so the BehaviorSubject emits and the tab label updates.
                if (res.filePath) {
                    const basename = res.filePath.replace(/\\/g, '/').split('/').pop() || ''
                    const nameFromFile = basename.replace(/\.topo\.json$/i, '').replace(/\.json$/i, '')
                    if (nameFromFile) {
                        this.svc.renameTopology(nameFromFile)
                    }
                }

                this.statusMsg = `Loaded: ${this.topology.name}`
                // Auto-load inventory sidecar alongside topology
                if (res.filePath) {
                    this._lastTopoFilePath = res.filePath
                    const loaded = await this._tryLoadInventorySidecar(res.filePath)
                    if (loaded) { this.statusMsg += ' (inventory restored)' }
                }
            } catch (err) {
                this.statusMsg = `Load failed: ${(err as Error).message ?? 'unknown error'}`
                this.importError = 'Failed to load topology file'
            }
        } else {
            document.getElementById('fileInput')?.click()
        }
        this.cdr.markForCheck()
    }

    /**
     * Try loading the inventory sidecar file for a topology path.
     * Tries multiple candidate filenames to handle different OS/dialog naming.
     * e.g. for "Lab.topo.json" tries: Lab.inv.json, Lab.topo.inv.json
     * e.g. for "Lab.json"      tries: Lab.inv.json
     */
    private async _tryLoadInventorySidecar (topoPath: string): Promise<boolean> {
        const candidates = this._inventoryCandidates(topoPath)
        for (const invPath of candidates) {
            const loaded = await this.invSvc.load(invPath).catch(() => false)
            if (loaded) {
                this.invSvc.setSidecarPath(invPath)
                console.log(`[inventory] Restored from: ${invPath}`)
                return true
            }
        }
        // No existing sidecar found — set the default path for auto-save
        // so future inventory changes (e.g. config backups) are persisted
        // even before the user explicitly saves the topology.
        const defaultPath = this._toInventoryPath(topoPath)
        this.invSvc.setSidecarPath(defaultPath)
        console.log(`[inventory] No sidecar found (tried: ${candidates.join(', ')}). Auto-save path: ${defaultPath}`)
        return false
    }

    /** Build candidate inventory sidecar paths for a given topology path */
    private _inventoryCandidates (topoPath: string): string[] {
        const seen = new Set<string>()
        const paths: string[] = []
        const add = (p: string) => { if (!seen.has(p)) { seen.add(p); paths.push(p) } }

        // Extract directory and base name
        const dir  = topoPath.replace(/[/\\][^/\\]+$/, '')
        const file = topoPath.replace(/^.*[/\\]/, '')  // filename only

        if (/\.topo\.json$/i.test(file)) {
            const base = file.replace(/\.topo\.json$/i, '')
            add(`${dir}/${base}.inv.json`)      // Lab.inv.json   (dot)
            add(`${dir}/${base}-inv.json`)       // Lab-inv.json   (dash)
            add(`${dir}/${base}.topo.inv.json`)  // Lab.topo.inv.json
        } else if (/\.json$/i.test(file)) {
            const base = file.replace(/\.json$/i, '')
            add(`${dir}/${base}.inv.json`)       // Lab.inv.json   (dot)
            add(`${dir}/${base}-inv.json`)        // Lab-inv.json   (dash)
        }

        // Also try by topology name (spaces preserved + underscored)
        const rawName = this.topology.name
        add(`${dir}/${rawName}.inv.json`)
        add(`${dir}/${rawName}-inv.json`)
        add(`${dir}/${rawName.replace(/\s+/g, '_')}.inv.json`)
        add(`${dir}/${rawName.replace(/\s+/g, '_')}-inv.json`)

        return paths
    }

    /** Derive primary inventory sidecar path from topology path (for saving) */
    private _toInventoryPath (topoPath: string): string {
        // Use dash-separated name: "Lab.topo.json" → "Lab-inv.json"
        // This avoids macOS compound-extension issues with ".inv.json"
        if (/\.topo\.json$/i.test(topoPath)) {
            return topoPath.replace(/\.topo\.json$/i, '-inv.json')
        }
        return topoPath.replace(/\.json$/i, '-inv.json')
    }

    /** Derive topology path from inventory sidecar path: name.inv.json → name.topo.json */
    private _toTopoPath (invPath: string): string {
        return invPath.replace(/\.inv\.json$/i, '.topo.json')
    }

    /** Check if a JSON string looks like an inventory file rather than a topology */
    private _looksLikeInventory (json: string): boolean {
        try {
            const obj = JSON.parse(json)
            return obj && typeof obj === 'object' && 'deviceVersions' in obj && 'version' in obj
        } catch { return false }
    }

    /** Check if a JSON string looks like a workspace file */
    private _looksLikeWorkspace (json: string): boolean {
        try {
            const obj = JSON.parse(json)
            return obj && typeof obj === 'object' && obj.type === 'tlink-workspace' && Array.isArray(obj.tabs)
        } catch { return false }
    }

    // ── Workspace (save / load all tabs) ──────────────────────────────────────

    async saveWorkspace (): Promise<void> {
        if (!window.netopsAPI) { return }
        try {
            const json = this.tabMgr.exportWorkspace()
            let res: { ok: boolean; filePath?: string; message?: string }
            if (this.tabMgr.lastWorkspaceFilePath) {
                // Auto-save to the same file — no dialog
                res = await window.netopsAPI.saveWorkspaceDirect(json, this.tabMgr.lastWorkspaceFilePath)
            } else {
                // First save — show Save As dialog
                const defaultName = this.topology.name || 'Workspace'
                res = await window.netopsAPI.saveWorkspace(json, defaultName)
            }
            if (res.ok && res.filePath) {
                this.tabMgr.lastWorkspaceFilePath = res.filePath
            }
            this.statusMsg = res.ok ? `Workspace saved to ${res.filePath}` : 'Save workspace cancelled'
        } catch (err) {
            this.statusMsg = `Save workspace failed: ${(err as Error).message ?? 'unknown error'}`
        }
        this.cdr.markForCheck()
    }

    /** Save Workspace As — always shows the file dialog */
    async saveWorkspaceAs (): Promise<void> {
        if (!window.netopsAPI) { return }
        try {
            const json = this.tabMgr.exportWorkspace()
            const defaultName = this.topology.name || 'Workspace'
            const res = await window.netopsAPI.saveWorkspace(json, defaultName)
            if (res.ok && res.filePath) {
                this.tabMgr.lastWorkspaceFilePath = res.filePath
            }
            this.statusMsg = res.ok ? `Workspace saved to ${res.filePath}` : 'Save workspace cancelled'
        } catch (err) {
            this.statusMsg = `Save workspace failed: ${(err as Error).message ?? 'unknown error'}`
        }
        this.cdr.markForCheck()
    }

    async loadWorkspace (): Promise<void> {
        if (!window.netopsAPI) { return }
        try {
            const res = await window.netopsAPI.loadWorkspace()
            if (!res.ok || !res.json) {
                this.statusMsg = 'Load workspace cancelled'
                this.cdr.markForCheck()
                return
            }

            // Validate
            if (!this._looksLikeWorkspace(res.json)) {
                this.statusMsg = 'Invalid workspace file'
                this.cdr.markForCheck()
                return
            }

            // Warn about unsaved changes
            const hasDirty = this.tabMgr.tabs.some(t => t.isDirty)
            if (hasDirty && !confirm('Loading a workspace will close all current tabs. Unsaved changes will be lost. Continue?')) {
                this.statusMsg = 'Load workspace cancelled'
                this.cdr.markForCheck()
                return
            }

            const ok = this.tabMgr.importWorkspace(res.json)
            const parsed = JSON.parse(res.json)
            if (ok && res.filePath) {
                this.tabMgr.lastWorkspaceFilePath = res.filePath

                // Derive a name from the workspace filename (e.g. "Topology1.workspace.json" → "Topology1")
                const basename = res.filePath.replace(/\\/g, '/').split('/').pop() || ''
                const wsName = basename.replace(/\.workspace\.json$/i, '').replace(/\.json$/i, '')

                // Rename tabs that still have the default name
                if (wsName) {
                    const tabs = this.tabMgr.tabs
                    for (let i = 0; i < tabs.length; i++) {
                        const svc = tabs[i].injector.get(TopologyService)
                        if (svc.topology.name === 'Untitled Topology' || !svc.topology.name) {
                            const label = tabs.length === 1 ? wsName : `${wsName}-${i + 1}`
                            svc.renameTopology(label)
                        }
                    }
                }
            }
            this.statusMsg = ok
                ? `Workspace loaded (${parsed.tabs.length} tab${parsed.tabs.length !== 1 ? 's' : ''})`
                : 'Failed to load workspace'
        } catch (err) {
            this.statusMsg = `Load workspace failed: ${(err as Error).message ?? 'unknown error'}`
        }
        this.cdr.markForCheck()
    }

    openDeviceImport (): void {
        this.deviceMapError = ''
        document.getElementById('deviceFileInput')?.click()
    }

    autoAddressTopology (): void {
        this.openAutoIpDialog()
    }

    autoGenerateLoopbacks (): void {
        let result: AutoLoopbackSummary
        try {
            result = this.svc.autoAssignLoopbacks(false, this.autoLoopbackBaseCidr)
        } catch (err) {
            this.statusMsg = `Loopback assignment failed: ${(err as Error).message}`
            this.cdr.markForCheck()
            return
        }

        if (!result.totalNodes) {
            this.statusMsg = 'No nodes in topology'
            this.cdr.markForCheck()
            return
        }

        if (!result.eligibleNodes) {
            this.statusMsg = 'No eligible nodes for loopback assignment'
            this.cdr.markForCheck()
            return
        }

        if (!result.assigned) {
            if (result.skippedCapacity) {
                this.statusMsg = `No loopbacks assigned (subnet exhausted: ${this.autoLoopbackBaseCidr})`
            } else {
                this.statusMsg = 'No loopbacks assigned (eligible nodes already have loopback IPs)'
            }
            this.cdr.markForCheck()
            return
        }

        const skipped: string[] = []
        if (result.skippedExisting) { skipped.push(`${result.skippedExisting} kept`) }
        if (result.skippedCapacity) { skipped.push(`${result.skippedCapacity} out-of-range`) }
        this.statusMsg = `Assigned loopback /32 IPs to ${result.assigned}/${result.eligibleNodes} eligible nodes from ${this.autoLoopbackBaseCidr}${skipped.length ? ` (${skipped.join(', ')})` : ''}`
        this.cdr.markForCheck()
    }

    applyAutoIpDialog (): void {
        const subnet = this.autoIpInput.trim()
        if (!subnet) {
            this.autoIpDialogError = 'Subnet is required'
            this.cdr.markForCheck()
            return
        }
        this.autoIpDialogError = ''
        this.autoIpBaseCidr = subnet

        let result
        try {
            result = this.svc.autoAddressLinks(
                this.autoIpHasExisting && this.autoIpOverwriteExisting,
                this.autoIpBaseCidr,
            )
        } catch (err) {
            this.autoIpDialogError = (err as Error).message
            this.cdr.markForCheck()
            return
        }

        this.showAutoIpDialog = false

        if (!result.addressedLinks) {
            if (result.skippedCapacity) {
                this.statusMsg = 'No addresses applied (subnet exhausted for /30 link allocation)'
            } else {
                this.statusMsg = result.skippedMissing
                    ? 'No addresses applied (missing ports on some links)'
                    : 'No addresses applied (all links already had IPs)'
            }
            this.cdr.markForCheck()
            return
        }

        const skipped: string[] = []
        if (result.skippedExisting) { skipped.push(`${result.skippedExisting} kept`) }
        if (result.skippedMissing) { skipped.push(`${result.skippedMissing} missing`) }
        if (result.skippedCapacity) { skipped.push(`${result.skippedCapacity} out-of-range`) }
        this.statusMsg = `Auto-addressed ${result.addressedLinks}/${result.totalLinks} links from ${this.autoIpBaseCidr}${skipped.length ? ` (${skipped.join(', ')})` : ''}`
        this.cdr.markForCheck()
    }

    autoAddressV6 (): void {
        if (!this.topology.links.length) {
            this.statusMsg = 'No links to auto-address'
            this.cdr.markForCheck()
            return
        }
        this.autoIpv6Mode = 'links'
        this.autoIpv6DialogError = ''
        this.autoIpv6Input = this.autoIpv6BaseCidr
        this.autoIpv6HasExisting = this.topology.links.some(link => {
            const sp = this._getPort(link.sourceNodeId, link.sourcePortId)
            const tp = this._getPort(link.targetNodeId, link.targetPortId)
            return !!(sp?.ipv6Address?.trim() || tp?.ipv6Address?.trim())
        })
        this.autoIpv6OverwriteExisting = false
        this.showAutoIpv6Dialog = true
        this.cdr.markForCheck()
    }

    autoGenerateLoopbacksV6 (): void {
        this.autoIpv6Mode = 'loopbacks'
        this.autoIpv6DialogError = ''
        this.autoIpv6Input = this.autoLoopbackV6BaseCidr
        this.autoIpv6HasExisting = this.topology.nodes.some(n =>
            ['router', 'switch', 'firewall'].includes(n.type) && !!n.loopbackIpv6?.trim(),
        )
        this.autoIpv6OverwriteExisting = false
        this.showAutoIpv6Dialog = true
        this.cdr.markForCheck()
    }

    applyAutoIpv6Dialog (): void {
        const prefix = this.autoIpv6Input.trim()
        if (!prefix) {
            this.autoIpv6DialogError = 'Prefix is required'
            this.cdr.markForCheck()
            return
        }
        this.autoIpv6DialogError = ''

        if (this.autoIpv6Mode === 'links') {
            this.autoIpv6BaseCidr = prefix
            let result
            try {
                result = this.svc.autoAddressLinksV6(
                    this.autoIpv6HasExisting && this.autoIpv6OverwriteExisting,
                    prefix,
                )
            } catch (err) {
                this.autoIpv6DialogError = (err as Error).message
                this.cdr.markForCheck()
                return
            }
            this.showAutoIpv6Dialog = false
            if (!result.addressedLinks) {
                this.statusMsg = result.skippedMissing
                    ? 'No IPv6 addresses applied (missing ports on some links)'
                    : 'No IPv6 addresses applied (all links already had IPv6 IPs)'
            } else {
                const skipped: string[] = []
                if (result.skippedExisting) { skipped.push(`${result.skippedExisting} kept`) }
                if (result.skippedMissing) { skipped.push(`${result.skippedMissing} missing`) }
                this.statusMsg = `IPv6: auto-addressed ${result.addressedLinks}/${result.totalLinks} links with /127 subnets from ${prefix}${skipped.length ? ` (${skipped.join(', ')})` : ''}`
            }
        } else {
            this.autoLoopbackV6BaseCidr = prefix
            let result
            try {
                result = this.svc.autoAssignLoopbacksV6(
                    this.autoIpv6HasExisting && this.autoIpv6OverwriteExisting,
                    prefix,
                )
            } catch (err) {
                this.autoIpv6DialogError = (err as Error).message
                this.cdr.markForCheck()
                return
            }
            this.showAutoIpv6Dialog = false
            if (!result.assigned) {
                this.statusMsg = result.eligibleNodes
                    ? 'No IPv6 loopbacks assigned (eligible nodes already have IPv6 loopback IPs)'
                    : 'No eligible nodes for IPv6 loopback assignment'
            } else {
                const skipped: string[] = []
                if (result.skippedExisting) { skipped.push(`${result.skippedExisting} kept`) }
                this.statusMsg = `IPv6: assigned /128 loopbacks to ${result.assigned}/${result.eligibleNodes} eligible nodes from ${prefix}${skipped.length ? ` (${skipped.join(', ')})` : ''}`
            }
        }
        this.cdr.markForCheck()
    }

    cancelAutoIpv6Dialog (): void {
        this.showAutoIpv6Dialog = false
        this.autoIpv6DialogError = ''
        this.cdr.markForCheck()
    }

    onFileInput (ev: Event): void {
        this.importError = ''
        const file = (ev.target as HTMLInputElement).files?.[0]
        if (!file) { return }
        const r = new FileReader()
        r.onload = () => {
            const json = r.result as string
            const ok = this.svc.importJSON(json)
            if (ok) {
                this.statusMsg = `Loaded: ${this.topology.name}`
            } else if (this._looksLikeInventory(json)) {
                this.statusMsg = 'That is an inventory file, not a topology. Please select the .topo.json file.'
                this.importError = 'Selected inventory file instead of topology'
            } else {
                this.statusMsg = 'Invalid topology file'
                this.importError = 'Invalid topology file'
            }
            this.cdr.markForCheck()
        }
        r.readAsText(file)
        ;(ev.target as HTMLInputElement).value = ''
    }

    onDeviceFileInput (ev: Event): void {
        this.deviceMapError = ''
        const file = (ev.target as HTMLInputElement).files?.[0]
        if (!file) { return }

        const reader = new FileReader()
        reader.onload = () => {
            const records = this._parseDeviceCsv(reader.result as string)
            if (!records.length) {
                this.deviceMapError = 'No usable device records found in CSV'
                this.statusMsg = 'Device import failed'
                this.cdr.markForCheck()
                return
            }

            // Dry-run: show preview before applying
            const preview = this.svc.previewMapDevices(records)
            this._pendingDeviceRecords = records
            this.deviceImportResult = preview
            this.deviceImportPreview = true
            this.showDeviceImportReport = true
            this.cdr.markForCheck()
        }
        reader.readAsText(file)
        ;(ev.target as HTMLInputElement).value = ''
    }

    applyDeviceImport (): void {
        if (!this._pendingDeviceRecords.length) { return }
        const result = this.svc.mapDevices(this._pendingDeviceRecords)
        this.deviceImportResult = result
        this.deviceImportPreview = false
        this.statusMsg = `Mapped ${result.matched}/${result.total} records (${result.hostnameMatches} by name, ${result.mgmtIpMatches} by mgmt IP)`
        if (result.unmatched > 0) {
            this.deviceMapError = `${result.unmatched} records were unmatched`
        }
        this._pendingDeviceRecords = []
        // Auto-save so mapping persists across restarts
        this.saveTopology()
        this.cdr.markForCheck()
    }

    closeDeviceImportReport (): void {
        this.showDeviceImportReport = false
        this.deviceImportResult = null
        this.deviceImportPreview = false
        this._pendingDeviceRecords = []
        this.cdr.markForCheck()
    }

    private _parseDeviceCsv (raw: string): DeviceInventoryRecord[] {
        const text = raw.replace(/^\uFEFF/, '')
        const rows = this._parseCsvRows(text)
        if (rows.length < 2) { return [] }

        const headers = rows[0].map(h => this._canonicalDeviceHeader(h))
        const records: DeviceInventoryRecord[] = []

        for (const row of rows.slice(1)) {
            const rec: DeviceInventoryRecord = {}
            for (let i = 0; i < headers.length; i++) {
                const key = headers[i]
                if (!key) { continue }
                const value = (row[i] ?? '').trim()
                if (!value) { continue }
                rec[key] = value
            }
            if (rec.hostname || rec.mgmtIp || rec.serialNumber || rec.sourceId) {
                records.push(rec)
            }
        }
        return records
    }

    private _parseCsvRows (text: string): string[][] {
        const rows: string[][] = []
        let row: string[] = []
        let cell = ''
        let inQuotes = false

        for (let i = 0; i < text.length; i++) {
            const ch = text[i]

            if (ch === '"') {
                if (inQuotes && text[i + 1] === '"') {
                    cell += '"'
                    i += 1
                } else {
                    inQuotes = !inQuotes
                }
                continue
            }

            if (ch === ',' && !inQuotes) {
                row.push(cell)
                cell = ''
                continue
            }

            if ((ch === '\n' || ch === '\r') && !inQuotes) {
                if (ch === '\r' && text[i + 1] === '\n') { i += 1 }
                row.push(cell)
                if (row.some(v => v.trim() !== '')) { rows.push(row) }
                row = []
                cell = ''
                continue
            }

            cell += ch
        }

        row.push(cell)
        if (row.some(v => v.trim() !== '')) { rows.push(row) }
        return rows
    }

    private _canonicalDeviceHeader (raw: string): keyof DeviceInventoryRecord | null {
        const h = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
        if (['hostname', 'name', 'node', 'node_name', 'device', 'device_name', 'label'].includes(h)) { return 'hostname' }
        if (['mgmt_ip', 'mgmtip', 'management_ip', 'managementip', 'ip', 'address', 'primary_ip', 'primary_ip4'].includes(h)) { return 'mgmtIp' }
        if (['vendor', 'manufacturer', 'make'].includes(h)) { return 'vendor' }
        if (['model', 'platform', 'device_type'].includes(h)) { return 'model' }
        if (['serial', 'serial_number', 'serialnumber', 'sn'].includes(h)) { return 'serialNumber' }
        if (['source_id', 'id', 'asset_id', 'device_id'].includes(h)) { return 'sourceId' }
        return null
    }

    private _getPort (nodeId: string, portId: string): NodePort | undefined {
        return this._nodeMap.get(nodeId)?.ports.find(p => p.id === portId)
    }

    trackById (_: number, item: { id: string }): string { return item.id }

    get nodeCount (): number { return this.topology?.nodes.length ?? 0 }
    get linkCount (): number { return this.topology?.links.length ?? 0 }
    get mappedCount (): number { return this.topology?.nodes.filter(n => n.mapped).length ?? 0 }

    get ctxNodeStatus (): string {
        return (this.ctxNodeId ? this._nodeMap.get(this.ctxNodeId) : undefined)?.status ?? 'stopped'
    }

    get ctxNodeCanOpenSsh (): boolean {
        if (!this.ctxNodeId) { return false }
        const node = this.topology?.nodes.find(n => n.id === this.ctxNodeId)
        if (!node) { return false }
        return !!((node.mgmtIp ?? '').trim() && (node.sshUsername ?? '').trim())
    }

    get ctxNodeCanOpenConsole (): boolean {
        if (!this.ctxNodeId || !this.clabDeployed || !this.clabContainers.length) { return false }
        const node = this.topology?.nodes.find(n => n.id === this.ctxNodeId)
        if (!node) { return false }
        return !!this._findContainerForNode(node)
    }

    get ctxNodeHasConfig (): boolean {
        if (!this.ctxNodeId) { return false }
        const node = this.topology?.nodes.find(n => n.id === this.ctxNodeId)
        return !!node?.startupConfig?.trim()
    }

    private _findContainerForNode (node: { label: string }): { name: string; state: string } | undefined {
        const safeName = node.label
            .replace(/\s+/g, '-')
            .replace(/[^a-zA-Z0-9_.-]/g, '')
            .toLowerCase()
        // Container names are "clab-<labName>-<nodeName>" — match by suffix
        return this.clabContainers.find(c => c.name.endsWith('-' + safeName))
    }

    async ctxOpenConsole (nodeId: string): Promise<void> {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) {
            this.statusMsg = 'Node not found'
            this.cdr.markForCheck()
            return
        }

        const container = this._findContainerForNode(node)
        if (!container) {
            this.statusMsg = `${node.label}: no matching container found — run Inspect Lab Status first`
            this.cdr.markForCheck()
            return
        }

        if (container.state !== 'running') {
            this.statusMsg = `${node.label}: container is ${container.state}, not running`
            this.cdr.markForCheck()
            return
        }

        const api = window.netopsAPI
        if (!api?.openContainerConsole) {
            this.statusMsg = 'Container console API is unavailable in this runtime'
            this.cdr.markForCheck()
            return
        }

        try {
            const result = await api.openContainerConsole({ containerName: container.name, kind: (container as any).kind || '' })
            this.statusMsg = result.ok
                ? `Opening console for ${node.label}`
                : `Console failed: ${result.message}`
        } catch (err) {
            this.statusMsg = `Failed to open console: ${(err as Error).message}`
        }
        this.cdr.markForCheck()
    }

    /** Open inline terminal panel for a container node */
    async ctxOpenInlineTerminal (nodeId: string): Promise<void> {
        this.closeCtxMenu()
        const node = this.topology.nodes.find(n => n.id === nodeId)
        if (!node) { return }

        const container = this._findContainerForNode(node)
        if (!container || container.state !== 'running') {
            this.statusMsg = container
                ? `${node.label}: container is ${container.state}, not running`
                : `${node.label}: no matching container — run Inspect Lab Status first`
            this.cdr.markForCheck()
            return
        }

        const api = (window as any).netopsAPI
        if (!api?.ptyCreate) { return }

        // Determine CLI command by kind
        const kind = ((container as any).kind || '').toLowerCase()
        let cmd = 'sh'
        if (kind.includes('sonic') || kind.includes('frr')) { cmd = 'vtysh' }
        else if (kind.includes('srl') || kind.includes('nokia')) { cmd = 'sr_cli' }
        else if (kind.includes('ceos') || kind.includes('arista')) { cmd = 'Cli' }
        else if (kind.includes('crpd') || kind.includes('juniper') || kind.includes('junos')) { cmd = 'cli' }

        const sessionId = `inline-${container.name}-${Date.now()}`
        try {
            await api.ptyCreate({
                id: sessionId,
                label: node.label,
                command: 'docker',
                args: ['exec', '-it', container.name, cmd],
            })
            this.showTerminalPanel = true
            this.cdr.markForCheck()
            // Add session to the terminal panel component
            setTimeout(() => {
                this.terminalPanelRef?.addSession(sessionId, node.label)
            }, 50)
        } catch (err) {
            this.statusMsg = `Failed to open terminal: ${(err as Error).message}`
            this.cdr.markForCheck()
        }
    }

    // ── Undo / Redo ──────────────────────────────────────────────────────────

    undo (): void {
        this.svc.undo()
        this.statusMsg = 'Undo'
        this._showToast('Undo')
        this.cdr.markForCheck()
    }

    redo (): void {
        this.svc.redo()
        this.statusMsg = 'Redo'
        this._showToast('Redo')
        this.cdr.markForCheck()
    }

    /** Show a brief toast notification at the bottom of the canvas */
    private _showToast (msg: string): void {
        this.toastMessage = msg
        this.toastVisible = true
        if (this._toastTimer) { clearTimeout(this._toastTimer) }
        this._toastTimer = setTimeout(() => {
            this.toastVisible = false
            this._toastTimer = null
            this.cdr.markForCheck()
        }, 2000)
    }

    get canUndo (): boolean { return this.svc.canUndo }
    get canRedo (): boolean { return this.svc.canRedo }

    // ── Copy / Paste ─────────────────────────────────────────────────────────

    copyNodes (): void {
        this._clipboard = this.topology.nodes.filter(n => this.selectedNodeIds.has(n.id))
        this.statusMsg = `Copied ${this._clipboard.length} node(s)`
        this.cdr.markForCheck()
    }

    pasteNodes (): void {
        if (!this._clipboard.length) { return }
        const newIds = this._clipboard.map(n => this.svc.duplicateNode(n, 40, 40))
        this.selectedNodeIds = new Set(newIds)
        this.selectedLinkIds.clear()
        this._syncPrimarySelection()
        this.statusMsg = `Pasted ${this._clipboard.length} node(s)`
        this.cdr.markForCheck()
    }

    get hasClipboard (): boolean { return this._clipboard.length > 0 }

    // ── Topology Validation ──────────────────────────────────────────────────

    validationIssues: string[] = []
    showValidationPanel = false

    validateTopology (): void {
        const issues: string[] = []
        const nodes = this.topology.nodes
        const links = this.topology.links

        // Disconnected nodes (no links)
        const connectedNodeIds = new Set(links.flatMap(l => [l.sourceNodeId, l.targetNodeId]))
        const isolated = nodes.filter(n => !connectedNodeIds.has(n.id))
        if (isolated.length) {
            issues.push(`${isolated.length} isolated node(s): ${isolated.map(n => n.label).join(', ')}`)
        }

        // Duplicate IPs across ports
        const ipSeen = new Map<string, string>()
        for (const node of nodes) {
            for (const port of node.ports) {
                const ip = port.ipAddress?.split('/')[0].trim()
                if (!ip) { continue }
                if (ipSeen.has(ip)) {
                    issues.push(`Duplicate IP ${ip} on ${node.label}/${port.label} and ${ipSeen.get(ip)}`)
                } else {
                    ipSeen.set(ip, `${node.label}/${port.label}`)
                }
            }
        }

        // Duplicate management IPs
        const mgmtSeen = new Map<string, string>()
        for (const node of nodes) {
            const mgmt = node.mgmtIp?.trim()
            if (!mgmt) { continue }
            if (mgmtSeen.has(mgmt)) {
                issues.push(`Duplicate mgmt IP ${mgmt} on ${node.label} and ${mgmtSeen.get(mgmt)}`)
            } else {
                mgmtSeen.set(mgmt, node.label)
            }
        }

        // Missing vendor assignment (non-server/cloud nodes)
        const noVendor = nodes.filter(n => !n.vendor?.trim() && n.type !== 'server' && n.type !== 'cloud' && n.type !== 'host')
        if (noVendor.length) {
            issues.push(`${noVendor.length} node(s) without vendor: ${noVendor.map(n => n.label).join(', ')}`)
        }

        // Duplicate ASN in eBGP topologies
        if ((this.topology as any).underlayProtocol === 'ebgp') {
            const asnMap = new Map<number, string[]>()
            for (const n of nodes) {
                if ((n as any).asn != null) {
                    const asn = (n as any).asn as number
                    if (!asnMap.has(asn)) { asnMap.set(asn, []) }
                    asnMap.get(asn)!.push(n.label)
                }
            }
            for (const [asn, labels] of asnMap) {
                if (labels.length > 1) {
                    issues.push(`Duplicate ASN ${asn} in eBGP topology: ${labels.join(', ')}`)
                }
            }
        }

        // Host port nodes: warn if interface not set or duplicated
        const hostNodes = nodes.filter(n => n.type === 'host')
        const noIface = hostNodes.filter(n => !n.hostInterface?.trim())
        if (noIface.length) {
            issues.push(`${noIface.length} host port(s) without interface assigned: ${noIface.map(n => n.label).join(', ')}`)
        }
        const ifaceCount = new Map<string, string[]>()
        for (const h of hostNodes) {
            if (h.hostInterface?.trim()) {
                const iface = h.hostInterface.trim()
                if (!ifaceCount.has(iface)) { ifaceCount.set(iface, []) }
                ifaceCount.get(iface)!.push(h.label)
            }
        }
        for (const [iface, labels] of ifaceCount) {
            if (labels.length > 1) {
                issues.push(`Duplicate host interface "${iface}" used by: ${labels.join(', ')}`)
            }
        }

        // Unassigned port IPs on linked ports (when topology uses IPs)
        const hasAnyIp = nodes.some(n => n.ports.some(p => p.ipAddress?.trim()))
        if (hasAnyIp) {
            for (const link of links) {
                const srcNode = nodes.find(n => n.id === link.sourceNodeId)
                const tgtNode = nodes.find(n => n.id === link.targetNodeId)
                const srcPort = srcNode?.ports.find(p => p.id === link.sourcePortId)
                const tgtPort = tgtNode?.ports.find(p => p.id === link.targetPortId)
                if (srcPort && !srcPort.ipAddress?.trim() && srcNode!.type !== 'server') {
                    issues.push(`Unassigned IP: ${srcNode!.label}/${srcPort.label}`)
                }
                if (tgtPort && !tgtPort.ipAddress?.trim() && tgtNode!.type !== 'server') {
                    issues.push(`Unassigned IP: ${tgtNode!.label}/${tgtPort.label}`)
                }
            }
        }

        // VLAN mode mismatch on connected ports
        for (const link of links) {
            const srcNode = nodes.find(n => n.id === link.sourceNodeId)
            const tgtNode = nodes.find(n => n.id === link.targetNodeId)
            const srcPort = srcNode?.ports.find(p => p.id === link.sourcePortId)
            const tgtPort = tgtNode?.ports.find(p => p.id === link.targetPortId)
            if (srcPort?.vlanMode && tgtPort?.vlanMode && srcPort.vlanMode !== tgtPort.vlanMode) {
                issues.push(`VLAN mode mismatch: ${srcNode!.label}/${srcPort.label} (${srcPort.vlanMode}) \u2194 ${tgtNode!.label}/${tgtPort.label} (${tgtPort.vlanMode})`)
            }
        }

        // Single points of failure (articulation points)
        if (nodes.length > 2 && links.length > 1) {
            const artPts = this.graphSvc.findArticulationPoints(this.topology)
            if (artPts.length) {
                const names = artPts.map(id => nodes.find(n => n.id === id)?.label ?? id)
                issues.push(`Single point(s) of failure: ${names.join(', ')}`)
            }
        }

        // No nodes
        if (!nodes.length) { issues.push('Topology is empty') }

        this.validationIssues = issues
        if (!issues.length) {
            this.statusMsg = `Validation OK \u2014 ${nodes.length} nodes, ${links.length} links, 0 issues`
        } else {
            this.showValidationPanel = true
            this.statusMsg = `Validation found ${issues.length} issue(s)`
        }
        this.cdr.markForCheck()
    }

    // ── Export formats ───────────────────────────────────────────────────────

    exportAnsibleInventory (): void {
        const yaml = this.topoExportSvc.exportAnsibleInventory(this.topology)
        this._downloadText(yaml, `${this.topology.name.replace(/\s+/g, '_')}_ansible_inventory.yml`, 'text/yaml')
        this.statusMsg = `Exported Ansible inventory (${this.topology.nodes.length} hosts)`
        this.cdr.markForCheck()
    }

    exportAnsiblePlaybook (): void {
        const yaml = this.topoExportSvc.exportAnsiblePlaybook(this.topology)
        this._downloadText(yaml, `${this.topology.name.replace(/\s+/g, '_')}_playbook.yml`, 'text/yaml')
        this.statusMsg = 'Exported Ansible playbook'
        this.cdr.markForCheck()
    }

    exportTerraformConfig (): void {
        const hcl = this.topoExportSvc.exportTerraform(this.topology)
        this._downloadText(hcl, `${this.topology.name.replace(/\s+/g, '_')}_main.tf`, 'text/plain')
        this.statusMsg = 'Exported Terraform configuration'
        this.cdr.markForCheck()
    }

    exportDeviceCsv (): void {
        const headers = ['Hostname', 'Mgmt IP', 'Vendor', 'Model', 'Serial Number', 'Source ID', 'Role', 'ASN', 'Loopback IP', 'Loopback IPv6', 'Status', 'Mapped']
        const csvEscape = (v: string): string => {
            if (!v) { return '' }
            return v.includes(',') || v.includes('"') || v.includes('\n')
                ? `"${v.replace(/"/g, '""')}"` : v
        }
        const rows: string[] = [headers.join(',')]
        for (const node of this.topology.nodes) {
            rows.push([
                csvEscape(node.label),
                csvEscape(node.mgmtIp ?? ''),
                csvEscape(node.vendor ?? ''),
                csvEscape(node.model ?? ''),
                csvEscape(node.serialNumber ?? ''),
                csvEscape(node.sourceId ?? ''),
                csvEscape(node.role ?? ''),
                node.asn != null ? String(node.asn) : '',
                csvEscape(node.loopbackIp ?? ''),
                csvEscape(node.loopbackIpv6 ?? ''),
                csvEscape(node.status ?? 'stopped'),
                node.mapped ? 'Yes' : 'No',
            ].join(','))
        }
        this._downloadText(rows.join('\n'), `${this.topology.name.replace(/\s+/g, '_')}_devices.csv`, 'text/csv')
        this.statusMsg = `Exported ${this.topology.nodes.length} devices to CSV`
        this.cdr.markForCheck()
    }

    exportGns3 (): void {
        const project = {
            name: this.topology.name,
            project_id: this.topology.id,
            nodes: this.topology.nodes.map(n => ({
                node_id: n.id,
                name: n.label,
                node_type: n.type,
                x: Math.round(n.x),
                y: Math.round(n.y),
                status: n.status,
                properties: {
                    ram: n.ram,
                    image: n.image,
                },
            })),
            links: this.topology.links.map(l => ({
                link_id: l.id,
                link_type: l.type,
                nodes: [
                    { node_id: l.sourceNodeId, port_id: l.sourcePortId },
                    { node_id: l.targetNodeId, port_id: l.targetPortId },
                ],
            })),
        }
        this._downloadText(
            JSON.stringify(project, null, 2),
            `${this.topology.name.replace(/\s+/g, '_')}.gns3`,
            'application/json',
        )
        this.statusMsg = 'Exported GNS3 project file'
        this.cdr.markForCheck()
    }

    // ── Containerlab YAML generation (shared by export & deploy) ──────────

    /**
     * Generate containerlab YAML.  When `subset` is provided only the given
     * nodes and links are emitted — used for per-server partitions in
     * multi-server deploy.  The `labSuffix` is appended to the lab name to
     * keep per-server labs unique (e.g. "lab-srv02").
     */
    private _generateClabYaml (subset?: {
        nodes: typeof this.topology.nodes
        links: typeof this.topology.links
        labSuffix?: string
    }): { ok: true; yaml: string; labName: string; extraFiles: Array<{ name: string; content: string }> } | { ok: false; error: string } {
        const nodesForYaml  = subset?.nodes ?? this.topology.nodes
        const linksForYaml  = subset?.links ?? this.topology.links
        if (!nodesForYaml.length) {
            return { ok: false, error: 'Topology has no nodes — load a template (File → Templates) or add devices first' }
        }

        const kindDefaultImage: Record<string, string> = {
            'sonic-vs':              this.clabImageInput || 'docker-sonic-vs:latest',
            'ceos':                  'ceos:latest',
            'cisco_xrd':             'ios-xr/xrd-control-plane:latest',
            'cisco_xrv9k':           'vrnetlab/vr-xrv9k:latest',
            'cisco_csr1000v':        'vrnetlab/vr-csr:latest',
            'cisco_n9kv':            'vrnetlab/vr-n9kv:latest',
            'srl':                   'ghcr.io/nokia/srlinux:latest',
            'crpd':                  'crpd:latest',
            'juniper_vqfx':          'vrnetlab/vr-vqfx:latest',
            'juniper_vjunosswitch':  'vrnetlab/vr-vjunosswitch:latest',
            'juniper_vjunosrouter':  'vrnetlab/vr-vjunosrouter:latest',
            'juniper_vjunosevolved': 'vrnetlab/juniper_vjunosevolved:latest',
            'linux':                 'alpine:latest',
        }

        // Separate host (physical port) and bridge nodes from virtual nodes
        const hostNodeIds = new Set(nodesForYaml.filter(n => n.type === 'host').map(n => n.id))
        const bridgeNodeIds = new Set(nodesForYaml.filter(n => n.type === 'bridge').map(n => n.id))
        const nonClabNodeIds = new Set([...hostNodeIds, ...bridgeNodeIds])
        const virtualNodes = nodesForYaml.filter(n => n.type !== 'host' && n.type !== 'bridge')

        const nameCount = new Map<string, number>()
        const nodeNameMap = new Map<string, string>()
        for (const node of virtualNodes) {
            let safeName = node.label.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase()
            if (!safeName) { safeName = 'node' }
            const count = nameCount.get(safeName) ?? 0
            nameCount.set(safeName, count + 1)
            if (count > 0) { safeName = `${safeName}-${count + 1}` }
            nodeNameMap.set(node.id, safeName)
        }
        // Map host nodes to 'host' and bridge nodes to 'bridge' for link endpoint generation
        for (const node of nodesForYaml) {
            if (node.type === 'host') { nodeNameMap.set(node.id, 'host') }
            if (node.type === 'bridge') { nodeNameMap.set(node.id, 'bridge') }
        }

        const nodePortEthIndex = new Map<string, Map<string, number>>()
        const nodeLinkedPorts = new Map<string, string[]>()
        for (const link of linksForYaml) {
            // Skip host and bridge nodes from ethIndex — they use literal names
            if (!nonClabNodeIds.has(link.sourceNodeId)) {
                if (!nodeLinkedPorts.has(link.sourceNodeId)) { nodeLinkedPorts.set(link.sourceNodeId, []) }
                nodeLinkedPorts.get(link.sourceNodeId)!.push(link.sourcePortId)
            }
            if (!nonClabNodeIds.has(link.targetNodeId)) {
                if (!nodeLinkedPorts.has(link.targetNodeId)) { nodeLinkedPorts.set(link.targetNodeId, []) }
                nodeLinkedPorts.get(link.targetNodeId)!.push(link.targetPortId)
            }
        }
        for (const [nodeId, portIds] of nodeLinkedPorts) {
            const map = new Map<string, number>()
            let idx = 1
            for (const pid of portIds) {
                if (!map.has(pid)) { map.set(pid, idx++) }
            }
            nodePortEthIndex.set(nodeId, map)
        }
        const getEthName = (nodeId: string, portId: string): string => {
            const idx = nodePortEthIndex.get(nodeId)?.get(portId) ?? 1
            return `eth${idx}`
        }

        const kindsUsed = new Set<string>()
        const nodeKindMap = new Map<string, string>()
        for (const node of virtualNodes) {
            const kind = this._vendorToClabKind(node.vendor, node.model, node.switchFamily)
            kindsUsed.add(kind)
            nodeKindMap.set(node.id, kind)
        }

        const baseName = this.topology.name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'lab'
        const labName = subset?.labSuffix ? `${baseName}-${subset.labSuffix}` : baseName
        const lines: string[] = []
        const extraFiles: Array<{ name: string; content: string }> = []

        lines.push(`name: ${labName}`)
        lines.push('')
        lines.push('topology:')

        // Build a map from default image → user-selected image (from tag dropdown)
        // so the YAML uses the tag the user chose, not always :latest
        const userSelectedImage = new Map<string, string>()
        for (const img of this.clabImages) {
            // img.name is the (possibly user-changed) image:tag
            // Match against default images by comparing the repo part
            const imgRepo = img.name.split(':')[0]
            for (const [, defaultImg] of Object.entries(kindDefaultImage)) {
                const defaultRepo = defaultImg.split(':')[0]
                if (imgRepo === defaultRepo && img.name !== defaultImg) {
                    userSelectedImage.set(defaultImg, img.name)
                }
            }
        }

        lines.push('  kinds:')
        for (const kind of kindsUsed) {
            const defaultImg = kindDefaultImage[kind] ?? 'alpine:latest'
            const finalImg = userSelectedImage.get(defaultImg) ?? defaultImg
            lines.push(`    ${kind}:`)
            lines.push(`      image: ${finalImg}`)
            // cRPD images imported via `docker import` lose CMD metadata; specify startup command explicitly
            if (kind === 'crpd') {
                lines.push('      cmd: /sbin/runit-init.sh')
            }
        }

        if (this.clabMgmtSubnet.trim()) {
            lines.push('  mgmt:')
            lines.push(`    ipv4-subnet: ${this.clabMgmtSubnet.trim()}`)
        }

        lines.push('  nodes:')
        for (const node of virtualNodes) {
            const safeName = nodeNameMap.get(node.id)!
            const kind = nodeKindMap.get(node.id)!
            lines.push(`    ${safeName}:`)
            lines.push(`      kind: ${kind}`)
            // Per-node image override (user-specified image takes precedence over kind default)
            if (node.image?.trim()) {
                lines.push(`      image: ${node.image.trim()}`)
            }

            if (kind === 'sonic-vs') {
                // SONiC-VS: containerlab expects config_db.json (JSON), not CLI commands.
                // Generate a comprehensive config_db.json with PORT, INTERFACE, LOOPBACK,
                // DEVICE_METADATA (hostname + BGP ASN), and BGP_NEIGHBOR entries.
                const linkedPorts = nodeLinkedPorts.get(node.id) ?? []
                const configDb: Record<string, any> = {}

                // DEVICE_METADATA — hostname and BGP ASN
                const deviceMeta: Record<string, string> = {
                    hostname: safeName,
                    type: (node.role === 'spine' || node.role === 'super-spine') ? 'SpineRouter' : 'LeafRouter',
                }
                if (node.asn != null) {
                    deviceMeta.bgp_asn = String(node.asn)
                }
                configDb.DEVICE_METADATA = { localhost: deviceMeta }

                // PORT — enable connected interfaces
                const portConfig: Record<string, any> = {}
                for (const portId of linkedPorts) {
                    const ethIdx = nodePortEthIndex.get(node.id)?.get(portId) ?? 1
                    const sonicIntf = `Ethernet${(ethIdx - 1) * 4}`
                    portConfig[sonicIntf] = { admin_status: 'up', mtu: '9100', speed: '100000' }
                }
                if (Object.keys(portConfig).length) {
                    configDb.PORT = portConfig
                }

                // LOOPBACK + LOOPBACK_INTERFACE — router-id / loopback IP
                const loopIp = (node.loopbackIp ?? node.mgmtIp)?.split('/')[0]?.trim()
                if (loopIp) {
                    const loopSrc = node.loopbackIp?.trim() || node.mgmtIp?.trim() || ''
                    const loopPrefix = loopSrc.includes('/') ? loopSrc : `${loopIp}/32`
                    configDb.LOOPBACK = { Loopback0: {} }
                    configDb.LOOPBACK_INTERFACE = {
                        'Loopback0': {},
                        [`Loopback0|${loopPrefix}`]: {},
                    }
                }

                // INTERFACE — IP addresses on connected ports
                const interfaceConfig: Record<string, any> = {}
                for (const portId of linkedPorts) {
                    const port = node.ports.find(p => p.id === portId)
                    if (!port?.ipAddress?.trim()) { continue }
                    const ethIdx = nodePortEthIndex.get(node.id)?.get(portId) ?? 1
                    const sonicIntf = `Ethernet${(ethIdx - 1) * 4}`
                    interfaceConfig[sonicIntf] = {}
                    interfaceConfig[`${sonicIntf}|${port.ipAddress.trim()}`] = {}
                }
                if (Object.keys(interfaceConfig).length) {
                    configDb.INTERFACE = interfaceConfig
                }

                // Collect BGP peers once — used for both config_db.json and FRR config
                const collectedPeers: Array<{ ip: string; remoteAs: number; name: string; isIbgp: boolean }> = []
                if (node.asn != null) {
                    for (const link of linksForYaml) {
                        let peerNodeId: string | null = null
                        let peerPortId: string | null = null
                        if (link.sourceNodeId === node.id) {
                            peerNodeId = link.targetNodeId
                            peerPortId = link.targetPortId
                        } else if (link.targetNodeId === node.id) {
                            peerNodeId = link.sourceNodeId
                            peerPortId = link.sourcePortId
                        }
                        if (!peerNodeId || !peerPortId) { continue }

                        const peerNode = nodesForYaml.find(n => n.id === peerNodeId)
                        if (!peerNode || peerNode.asn == null) { continue }

                        const peerPort = peerNode.ports.find(p => p.id === peerPortId)
                        const peerIp = peerPort?.ipAddress?.split('/')[0]?.trim()
                        if (!peerIp) { continue }

                        collectedPeers.push({
                            ip: peerIp, remoteAs: peerNode.asn,
                            name: nodeNameMap.get(peerNodeId) || peerNode.label,
                            isIbgp: peerNode.asn === node.asn,
                        })
                    }

                    // BGP_NEIGHBOR table in config_db.json
                    if (collectedPeers.length) {
                        const bgpNeighbors: Record<string, any> = {}
                        for (const peer of collectedPeers) {
                            bgpNeighbors[peer.ip] = {
                                admin_status: 'true',
                                asn: String(peer.remoteAs),
                                holdtime: '180',
                                keepalive: '60',
                                name: peer.name,
                                rrclient: (peer.isIbgp && (node.role === 'spine' || node.role === 'super-spine' || node.role === 'core')) ? '1' : '0',
                            }
                        }
                        configDb.BGP_NEIGHBOR = bgpNeighbors
                    }
                }

                const configContent = JSON.stringify(configDb, null, 2)
                const configFileName = `${safeName}-config.json`
                extraFiles.push({ name: configFileName, content: configContent })
                lines.push(`      startup-config: ${configFileName}`)
                lines.push('      enforce-startup-config: true')

                // Generate FRR config + daemons file so bgpd actually runs
                if (node.asn != null) {
                    const loopIpForRid = (node.loopbackIp ?? node.mgmtIp)?.split('/')[0]?.trim()
                    const isV6 = (addr: string) => addr.includes(':')
                    const frrLines: string[] = []
                    frrLines.push('frr defaults traditional')
                    frrLines.push(`hostname ${safeName}`)
                    frrLines.push('service integrated-vtysh-config')
                    frrLines.push('!')

                    // Interface IP addresses (zebra needs these)
                    let hasV4Intf = false
                    let hasV6Intf = false
                    const linkedPortIds = nodeLinkedPorts.get(node.id) ?? []
                    for (const portId of linkedPortIds) {
                        const port = node.ports.find(p => p.id === portId)
                        if (!port?.ipAddress?.trim()) { continue }
                        const ethIdx = nodePortEthIndex.get(node.id)?.get(portId) ?? 1
                        const sonicIntf = `Ethernet${(ethIdx - 1) * 4}`
                        const addrCmd = isV6(port.ipAddress) ? 'ipv6 address' : 'ip address'
                        if (isV6(port.ipAddress)) { hasV6Intf = true } else { hasV4Intf = true }
                        frrLines.push(`interface ${sonicIntf}`)
                        frrLines.push(` ${addrCmd} ${port.ipAddress.trim()}`)
                        frrLines.push('!')
                    }
                    // Loopback
                    if (loopIpForRid) {
                        const frrLoopSrc = node.loopbackIp?.trim() || node.mgmtIp?.trim() || ''
                        const loopCidr = frrLoopSrc.includes('/') ? frrLoopSrc : `${loopIpForRid}/32`
                        const loopCmd = isV6(loopCidr) ? 'ipv6 address' : 'ip address'
                        frrLines.push('interface Loopback0')
                        frrLines.push(` ${loopCmd} ${loopCidr}`)
                        frrLines.push('!')
                    }

                    // BGP config
                    frrLines.push(`router bgp ${node.asn}`)
                    // BGP router-id must be IPv4; skip if loopback is IPv6-only
                    if (loopIpForRid && !isV6(loopIpForRid)) {
                        frrLines.push(` bgp router-id ${loopIpForRid}`)
                    }
                    frrLines.push(' bgp bestpath as-path multipath-relax')
                    frrLines.push(' no bgp ebgp-requires-policy')

                    // Re-use peers collected above for config_db.json
                    const bgpPeers = collectedPeers

                    // Determine if this node is a route reflector (spine/super-spine/core with iBGP peers)
                    const isRR = (node.role === 'spine' || node.role === 'super-spine' || node.role === 'core')
                        && bgpPeers.some(p => p.isIbgp)

                    for (const peer of bgpPeers) {
                        frrLines.push(` neighbor ${peer.ip} remote-as ${peer.remoteAs}`)
                        frrLines.push(` neighbor ${peer.ip} description ${peer.name}`)
                    }

                    // Separate IPv4 and IPv6 peers
                    const v4Peers = bgpPeers.filter(p => !isV6(p.ip))
                    const v6Peers = bgpPeers.filter(p => isV6(p.ip))

                    // address-family ipv4 unicast (if there are IPv4 peers or interfaces)
                    if (v4Peers.length || hasV4Intf) {
                        frrLines.push(' !')
                        frrLines.push(' address-family ipv4 unicast')
                        frrLines.push('  redistribute connected')
                        // Explicitly advertise loopback network
                        if (loopIpForRid && !isV6(loopIpForRid)) {
                            const loopNet = node.loopbackIp?.includes('/') ? node.loopbackIp : `${loopIpForRid}/32`
                            frrLines.push(`  network ${loopNet}`)
                        }
                        // Explicitly advertise connected interface networks
                        for (const portId of linkedPorts) {
                            const port = node.ports.find(p => p.id === portId)
                            if (port?.ipAddress?.trim() && !isV6(port.ipAddress.trim().split('/')[0])) {
                                frrLines.push(`  network ${port.ipAddress.trim()}`)
                            }
                        }
                        for (const peer of v4Peers) {
                            frrLines.push(`  neighbor ${peer.ip} activate`)
                            if (isRR && peer.isIbgp) {
                                frrLines.push(`  neighbor ${peer.ip} route-reflector-client`)
                            }
                        }
                        frrLines.push(' exit-address-family')
                    }

                    // address-family ipv6 unicast (if there are IPv6 peers or interfaces)
                    if (v6Peers.length || hasV6Intf) {
                        frrLines.push(' !')
                        frrLines.push(' address-family ipv6 unicast')
                        frrLines.push('  redistribute connected')
                        for (const peer of v6Peers) {
                            frrLines.push(`  neighbor ${peer.ip} activate`)
                            if (isRR && peer.isIbgp) {
                                frrLines.push(`  neighbor ${peer.ip} route-reflector-client`)
                            }
                        }
                        frrLines.push(' exit-address-family')
                    }

                    frrLines.push('!')
                    frrLines.push('line vty')
                    frrLines.push('!')

                    const frrFileName = `${safeName}-frr.conf`
                    extraFiles.push({ name: frrFileName, content: frrLines.join('\n') })

                    // Daemons file — enable bgpd (must match format of /etc/frr/daemons)
                    const daemonsFileName = `${safeName}-daemons`
                    const daemonsContent = [
                        'bgpd=yes', 'ospfd=no', 'ospf6d=no',
                        'ripd=no', 'ripngd=no', 'isisd=no', 'pimd=no',
                        'ldpd=no', 'nhrpd=no', 'eigrpd=no', 'babeld=no',
                        'sharpd=no', 'pbrd=no', 'bfdd=no', 'fabricd=no', 'vrrpd=no',
                        '',
                        'vtysh_enable=yes',
                        'zebra_options="  -A 127.0.0.1 -s 90000000"',
                        'bgpd_options="   -A 127.0.0.1"',
                    ].join('\n')
                    extraFiles.push({ name: daemonsFileName, content: daemonsContent })

                    // Mount FRR config and daemons file into container (/etc/frr/ is the correct path)
                    lines.push('      binds:')
                    lines.push(`        - ${frrFileName}:/etc/frr/frr.conf`)
                    lines.push(`        - ${daemonsFileName}:/etc/frr/daemons`)
                }
            } else if (kind === 'crpd') {
                // cRPD startup-config is mounted as /config/juniper.conf inside the container.
                // That file MUST be in JunOS curly-brace config format, NOT "set" commands.
                // "set" commands are CLI-only; juniper.conf uses hierarchical curly-brace syntax.
                // cRPD uses Linux ethN interfaces, not ge-0/0/0 style.
                const cfgLines: string[] = []
                cfgLines.push('system {')
                cfgLines.push(`    host-name ${safeName};`)
                cfgLines.push('    services {')
                cfgLines.push('        ssh;')
                cfgLines.push('    }')
                cfgLines.push('}')

                // ── interfaces block ───────────────────────────────────────
                const ifaceBlocks: string[] = []

                // Loopback
                const loopIp = node.loopbackIp?.trim()
                const loopV6 = node.loopbackIpv6?.trim()
                if (loopIp || loopV6) {
                    const lb: string[] = []
                    lb.push('    lo0 {')
                    lb.push('        unit 0 {')
                    if (loopIp) {
                        const loopAddr = loopIp.includes('/') ? loopIp : `${loopIp}/32`
                        lb.push('            family inet {')
                        lb.push(`                address ${loopAddr};`)
                        lb.push('            }')
                    }
                    if (loopV6) {
                        lb.push('            family inet6 {')
                        lb.push(`                address ${loopV6};`)
                        lb.push('            }')
                    }
                    lb.push('        }')
                    lb.push('    }')
                    ifaceBlocks.push(lb.join('\n'))
                }

                // Connected interfaces using ethN names
                const linkedPorts = nodeLinkedPorts.get(node.id) ?? []
                for (const portId of linkedPorts) {
                    const port = node.ports.find(p => p.id === portId)
                    if (!port) { continue }
                    const ethIdx = nodePortEthIndex.get(node.id)?.get(portId) ?? 1
                    const ethName = `eth${ethIdx}`

                    const ib: string[] = []
                    ib.push(`    ${ethName} {`)

                    const desc = (port.description ?? '').trim().replace(/"/g, '')
                    if (desc) { ib.push(`        description "${desc}";`) }

                    const hasV4 = !!port.ipAddress?.trim()
                    const hasV6 = !!port.ipv6Address?.trim()
                    if (hasV4 || hasV6) {
                        ib.push('        unit 0 {')
                        if (hasV4) {
                            ib.push('            family inet {')
                            ib.push(`                address ${port.ipAddress!.trim()};`)
                            ib.push('            }')
                        }
                        if (hasV6) {
                            ib.push('            family inet6 {')
                            ib.push(`                address ${port.ipv6Address!.trim()};`)
                            ib.push('            }')
                        }
                        ib.push('        }')
                    }
                    ib.push('    }')
                    ifaceBlocks.push(ib.join('\n'))
                }

                if (ifaceBlocks.length) {
                    cfgLines.push('interfaces {')
                    cfgLines.push(ifaceBlocks.join('\n'))
                    cfgLines.push('}')
                }

                // ── routing-options block ──────────────────────────────────
                if (node.asn != null) {
                    const routerId = (node.loopbackIp ?? node.mgmtIp)?.split('/')[0]?.trim()
                    if (routerId && !routerId.includes(':')) {
                        cfgLines.push('routing-options {')
                        cfgLines.push(`    router-id ${routerId};`)
                        cfgLines.push(`    autonomous-system ${node.asn};`)
                        cfgLines.push('}')
                    }
                }

                // ── policy-options block (export loopback routes for eBGP) ──
                if (node.asn != null && loopIp) {
                    cfgLines.push('policy-options {')
                    cfgLines.push('    policy-statement EXPORT-LO {')
                    cfgLines.push('        term loopback {')
                    cfgLines.push('            from {')
                    cfgLines.push('                protocol direct;')
                    cfgLines.push('                route-filter 0.0.0.0/0 prefix-length-range /32-/32;')
                    cfgLines.push('            }')
                    cfgLines.push('            then accept;')
                    cfgLines.push('        }')
                    cfgLines.push('        term connected {')
                    cfgLines.push('            from protocol direct;')
                    cfgLines.push('            then accept;')
                    cfgLines.push('        }')
                    cfgLines.push('    }')
                    cfgLines.push('}')
                }

                // ── protocols block ────────────────────────────────────────
                const protoBlocks: string[] = []

                // BGP
                if (node.asn != null) {
                    // Collect BGP peers grouped by group name
                    const bgpGroups: Record<string, { type: string; neighbors: Array<{ ip: string; peerAs: number; desc: string }> }> = {}

                    for (const link of linksForYaml) {
                        let peerNodeId: string | null = null
                        let peerPortId: string | null = null
                        if (link.sourceNodeId === node.id) {
                            peerNodeId = link.targetNodeId
                            peerPortId = link.targetPortId
                        } else if (link.targetNodeId === node.id) {
                            peerNodeId = link.sourceNodeId
                            peerPortId = link.sourcePortId
                        }
                        if (!peerNodeId || !peerPortId) { continue }

                        const peerNode = nodesForYaml.find(n => n.id === peerNodeId)
                        if (!peerNode || peerNode.asn == null) { continue }

                        const peerPort = peerNode.ports.find(p => p.id === peerPortId)
                        const peerIp = peerPort?.ipAddress?.split('/')[0]?.trim()
                        if (!peerIp) { continue }

                        const groupName = peerNode.asn === node.asn ? 'IBGP' : 'EBGP'
                        if (!bgpGroups[groupName]) {
                            bgpGroups[groupName] = {
                                type: peerNode.asn === node.asn ? 'internal' : 'external',
                                neighbors: [],
                            }
                        }
                        bgpGroups[groupName].neighbors.push({
                            ip: peerIp,
                            peerAs: peerNode.asn,
                            desc: nodeNameMap.get(peerNodeId) || peerNode.label,
                        })
                    }

                    const groupNames = Object.keys(bgpGroups)
                    if (groupNames.length) {
                        const bgpBlock: string[] = []
                        bgpBlock.push('    bgp {')
                        for (const gn of groupNames) {
                            const g = bgpGroups[gn]
                            bgpBlock.push(`        group ${gn} {`)
                            bgpBlock.push(`            type ${g.type};`)
                            if (g.type === 'external') {
                                bgpBlock.push('            export EXPORT-LO;')
                                bgpBlock.push('            multipath {')
                                bgpBlock.push('                multiple-as;')
                                bgpBlock.push('            }')
                            }
                            for (const nb of g.neighbors) {
                                bgpBlock.push(`            neighbor ${nb.ip} {`)
                                bgpBlock.push(`                peer-as ${nb.peerAs};`)
                                bgpBlock.push(`                description "${nb.desc}";`)
                                bgpBlock.push('            }')
                            }
                            bgpBlock.push('        }')
                        }

                        // EVPN overlay group — iBGP sessions via loopback IPs
                        if (this.topology.overlayEnabled) {
                            const isSpine = node.role === 'spine' || node.role === 'super-spine'
                            // Collect loopback IPs of the other role
                            const overlayPeers = nodesForYaml
                                .filter(n => {
                                    if (n.id === node.id || n.asn == null) { return false }
                                    if (isSpine) { return n.role === 'leaf' || n.role === 'border-leaf' || n.role === 'tor' }
                                    return n.role === 'spine' || n.role === 'super-spine'
                                })
                                .map(n => ({
                                    ip: (n.loopbackIp ?? n.mgmtIp)?.split('/')[0]?.trim(),
                                    name: nodeNameMap.get(n.id) || n.label,
                                }))
                                .filter(p => p.ip)

                            if (overlayPeers.length) {
                                const loopIpBare = loopIp?.split('/')[0] ?? ''
                                // Use a common overlay ASN (65000) for iBGP EVPN sessions
                                // when underlay is eBGP (each node has different ASN).
                                // local-as presents this ASN to overlay peers without affecting underlay.
                                const overlayAsn = 65000
                                bgpBlock.push('        group OVERLAY {')
                                bgpBlock.push('            type internal;')
                                bgpBlock.push(`            local-address ${loopIpBare};`)
                                bgpBlock.push(`            local-as ${overlayAsn};`)
                                bgpBlock.push('            family evpn {')
                                bgpBlock.push('                signaling;')
                                bgpBlock.push('            }')
                                bgpBlock.push('            multipath;')
                                if (isSpine) {
                                    bgpBlock.push(`            cluster ${loopIpBare};`)
                                }
                                for (const peer of overlayPeers) {
                                    bgpBlock.push(`            neighbor ${peer.ip} {`)
                                    bgpBlock.push(`                description "${peer.name} EVPN";`)
                                    bgpBlock.push('            }')
                                }
                                bgpBlock.push('        }')
                            }
                        }

                        bgpBlock.push('    }')
                        protoBlocks.push(bgpBlock.join('\n'))
                    }
                }

                // OSPF
                const ospfArea = node.ospfArea ?? 0
                const hasOspfLinks = linkedPorts.some(portId => {
                    const port = node.ports.find(p => p.id === portId)
                    return port?.ipAddress?.trim()
                })
                if (hasOspfLinks && node.ospfArea != null) {
                    const ospfBlock: string[] = []
                    ospfBlock.push('    ospf {')
                    ospfBlock.push(`        area ${ospfArea} {`)
                    for (const portId of linkedPorts) {
                        const port = node.ports.find(p => p.id === portId)
                        if (!port?.ipAddress?.trim()) { continue }
                        const ethIdx = nodePortEthIndex.get(node.id)?.get(portId) ?? 1
                        ospfBlock.push(`            interface eth${ethIdx};`)
                    }
                    if (loopIp) {
                        ospfBlock.push('            interface lo0.0 {')
                        ospfBlock.push('                passive;')
                        ospfBlock.push('            }')
                    }
                    ospfBlock.push('        }')
                    ospfBlock.push('    }')
                    protoBlocks.push(ospfBlock.join('\n'))
                }

                if (protoBlocks.length) {
                    cfgLines.push('protocols {')
                    cfgLines.push(protoBlocks.join('\n'))
                    cfgLines.push('}')
                }

                const cfgFileName = `${safeName}-startup.cfg`
                extraFiles.push({ name: cfgFileName, content: cfgLines.join('\n') })
                lines.push(`      startup-config: ${cfgFileName}`)
                lines.push('      enforce-startup-config: true')
            } else if (kind.startsWith('cisco_')) {
                // Cisco IOS-XR / IOS-XE / NX-OS startup config
                const cfgLines: string[] = []
                cfgLines.push(`hostname ${safeName}`)

                // Loopback
                const loopIp = node.loopbackIp?.trim()
                if (loopIp) {
                    const loopAddr = loopIp.includes('/') ? loopIp : `${loopIp}/32`
                    cfgLines.push('!')
                    cfgLines.push('interface Loopback0')
                    cfgLines.push(` ipv4 address ${loopAddr.replace('/', ' ')}`)
                    cfgLines.push(' no shutdown')
                }

                // Physical interfaces
                const linkedPortIds = nodeLinkedPorts.get(node.id) ?? []
                for (const portId of linkedPortIds) {
                    const port = node.ports.find(p => p.id === portId)
                    const ethIdx = nodePortEthIndex.get(node.id)?.get(portId) ?? 1
                    // XRd uses GigabitEthernet0/0/0/N
                    const intfName = kind === 'cisco_n9kv'
                        ? `Ethernet1/${ethIdx}`
                        : `GigabitEthernet0/0/0/${ethIdx - 1}`
                    cfgLines.push('!')
                    cfgLines.push(`interface ${intfName}`)
                    if (port?.ipAddress?.trim()) {
                        const addr = port.ipAddress.trim()
                        // Convert CIDR to address + mask for IOS-XR
                        if (addr.includes('/')) {
                            const [ip, prefix] = addr.split('/')
                            cfgLines.push(` ipv4 address ${ip} ${this._prefixToMask(+prefix)}`)
                        } else {
                            cfgLines.push(` ipv4 address ${addr} 255.255.255.255`)
                        }
                    }
                    cfgLines.push(' no shutdown')
                }

                // BGP
                if (node.asn != null) {
                    cfgLines.push('!')
                    cfgLines.push(`router bgp ${node.asn}`)
                    const routerId = (node.loopbackIp ?? node.mgmtIp)?.split('/')[0]?.trim()
                    if (routerId) { cfgLines.push(` bgp router-id ${routerId}`) }
                    cfgLines.push(' address-family ipv4 unicast')
                    cfgLines.push(' !')
                    for (const link of linksForYaml) {
                        const isSource = link.sourceNodeId === node.id
                        const isTarget = link.targetNodeId === node.id
                        if (!isSource && !isTarget) { continue }
                        const peerId = isSource ? link.targetNodeId : link.sourceNodeId
                        const peerPortId = isSource ? link.targetPortId : link.sourcePortId
                        const peerNode = nodesForYaml.find(n => n.id === peerId)
                        if (!peerNode || peerNode.asn == null) { continue }
                        const peerPort = peerNode.ports.find(p => p.id === peerPortId)
                        const peerIp = peerPort?.ipAddress?.split('/')[0]?.trim()
                        if (!peerIp) { continue }
                        cfgLines.push(` neighbor ${peerIp}`)
                        cfgLines.push(`  remote-as ${peerNode.asn}`)
                        cfgLines.push('  address-family ipv4 unicast')
                        cfgLines.push('  !')
                    }
                }

                cfgLines.push('!')
                cfgLines.push('end')
                const cfgFileName = `${safeName}-startup.cfg`
                extraFiles.push({ name: cfgFileName, content: cfgLines.join('\n') })
                lines.push(`      startup-config: ${cfgFileName}`)
                lines.push('      enforce-startup-config: true')
            } else if (node.startupConfig?.trim()) {
                // Other vendors — write startup config as-is (containerlab can apply CLI configs)
                const userConfigFile = `${safeName}-startup.cfg`
                extraFiles.push({ name: userConfigFile, content: node.startupConfig.trim() })
                lines.push(`      startup-config: ${userConfigFile}`)
                lines.push('      enforce-startup-config: true')
            }

            // For linux kind (servers, PCs, hosts): configure IPs via exec commands
            // so the container actually has connectivity after deploy
            if (kind === 'linux') {
                const execCmds: string[] = []
                const linkedPortIds = nodeLinkedPorts.get(node.id) ?? []
                for (const portId of linkedPortIds) {
                    const port = node.ports.find(p => p.id === portId)
                    const ethIdx = nodePortEthIndex.get(node.id)?.get(portId) ?? 1
                    execCmds.push(`ip link set eth${ethIdx} up`)
                    if (port?.ipAddress?.trim()) {
                        execCmds.push(`ip addr add ${port.ipAddress.trim()} dev eth${ethIdx}`)
                    }
                }
                // Add default route via peer IP for single-homed hosts
                if (linkedPortIds.length === 1) {
                    const singleLink = linksForYaml.find(l =>
                        l.sourceNodeId === node.id || l.targetNodeId === node.id
                    )
                    if (singleLink) {
                        const peerNodeId = singleLink.sourceNodeId === node.id ? singleLink.targetNodeId : singleLink.sourceNodeId
                        const peerPortId = singleLink.sourceNodeId === node.id ? singleLink.targetPortId : singleLink.sourcePortId
                        const peerNode = nodesForYaml.find(n => n.id === peerNodeId)
                        const peerPort = peerNode?.ports.find(p => p.id === peerPortId)
                        const gwIp = peerPort?.ipAddress?.split('/')[0]?.trim()
                        if (gwIp) {
                            execCmds.push(`ip route replace default via ${gwIp}`)
                        }
                    }
                }
                if (execCmds.length) {
                    lines.push('      exec:')
                    for (const cmd of execCmds) {
                        lines.push(`        - ${cmd}`)
                    }
                }
            }

            if (node.mgmtIp?.trim() && this.clabMgmtSubnet.trim()) {
                const mgmtAddr = node.mgmtIp.trim().split('/')[0]
                lines.push(`      mgmt-ipv4: ${mgmtAddr}`)
            }

            // Store topology metadata as containerlab labels so it survives reconnect
            const labels: Record<string, string> = {}
            if (node.asn != null) { labels['tlink-asn'] = String(node.asn) }
            if (node.role)        { labels['tlink-role'] = node.role }
            if (node.mgmtIp)      { labels['tlink-mgmt-ip'] = node.mgmtIp }
            // Store port IPs as "portId=ip" entries
            const linkedPIds = nodeLinkedPorts.get(node.id) ?? []
            const portIps: string[] = []
            for (const portId of linkedPIds) {
                const port = node.ports.find(p => p.id === portId)
                if (port?.ipAddress?.trim()) {
                    portIps.push(`${portId}=${port.ipAddress.trim()}`)
                }
            }
            if (portIps.length) { labels['tlink-port-ips'] = portIps.join(',') }

            if (Object.keys(labels).length) {
                lines.push('      labels:')
                for (const [k, v] of Object.entries(labels)) {
                    // Sanitize label values: escape backslashes and double quotes for YAML safety
                    const safeV = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
                    lines.push(`        ${k}: "${safeV}"`)
                }
            }
        }

        // Collect unique bridge names from bridge node links and declare them as kind: bridge nodes
        const bridgeEthCounters = new Map<string, number>()  // bridge name → next eth index
        const declaredBridges = new Set<string>()

        // Helper functions defined before the links loop
        const getHostIfaceName = (node: typeof nodesForYaml[0] | undefined, portId: string): string => {
            if (!node) { return 'UNSET' }
            const port = node.ports.find(p => p.id === portId)
            const label = port?.label ?? ''
            if (label && label !== 'NIC' && !label.match(/^NIC\d+$/)) { return label }
            return node.hostInterface || 'UNSET'
        }
        const getBridgeName = (node: typeof nodesForYaml[0] | undefined, portId: string): string => {
            if (!node) { return 'UNSET' }
            const port = node.ports.find(p => p.id === portId)
            const label = port?.label ?? ''
            if (label && label !== 'br' && !label.match(/^br\d+$/)) { return label }
            return node.bridgeName || 'UNSET'
        }
        const getNextBridgeEth = (bridgeName: string): string => {
            const idx = bridgeEthCounters.get(bridgeName) ?? 1
            bridgeEthCounters.set(bridgeName, idx + 1)
            return `eth${idx}`
        }

        // Pre-scan links to collect bridge names
        for (const link of linksForYaml) {
            const srcIsBridge = bridgeNodeIds.has(link.sourceNodeId)
            const tgtIsBridge = bridgeNodeIds.has(link.targetNodeId)
            if (srcIsBridge) {
                const srcNode = nodesForYaml.find(n => n.id === link.sourceNodeId)
                declaredBridges.add(getBridgeName(srcNode, link.sourcePortId))
            }
            if (tgtIsBridge) {
                const tgtNode = nodesForYaml.find(n => n.id === link.targetNodeId)
                declaredBridges.add(getBridgeName(tgtNode, link.targetPortId))
            }
        }

        // Emit bridge nodes with kind: bridge (must exist on the host before deploy)
        for (const brName of declaredBridges) {
            if (brName === 'UNSET') { continue }
            lines.push(`    ${brName}:`)
            lines.push(`      kind: bridge`)
        }

        if (linksForYaml.length) {
            lines.push('  links:')
            for (const link of linksForYaml) {
                const srcName = nodeNameMap.get(link.sourceNodeId)
                const tgtName = nodeNameMap.get(link.targetNodeId)
                if (!srcName || !tgtName) { continue }

                const srcIsHost = hostNodeIds.has(link.sourceNodeId)
                const tgtIsHost = hostNodeIds.has(link.targetNodeId)
                const srcIsBridge = bridgeNodeIds.has(link.sourceNodeId)
                const tgtIsBridge = bridgeNodeIds.has(link.targetNodeId)
                const srcNode = (srcIsHost || srcIsBridge) ? nodesForYaml.find(n => n.id === link.sourceNodeId) : undefined
                const tgtNode = (tgtIsHost || tgtIsBridge) ? nodesForYaml.find(n => n.id === link.targetNodeId) : undefined

                let srcEndpoint: string
                if (srcIsHost) {
                    srcEndpoint = `macvlan:${getHostIfaceName(srcNode, link.sourcePortId)}`
                } else if (srcIsBridge) {
                    const brName = getBridgeName(srcNode, link.sourcePortId)
                    srcEndpoint = `${brName}:${getNextBridgeEth(brName)}`
                } else {
                    srcEndpoint = `${srcName}:${getEthName(link.sourceNodeId, link.sourcePortId)}`
                }

                let tgtEndpoint: string
                if (tgtIsHost) {
                    tgtEndpoint = `macvlan:${getHostIfaceName(tgtNode, link.targetPortId)}`
                } else if (tgtIsBridge) {
                    const brName = getBridgeName(tgtNode, link.targetPortId)
                    tgtEndpoint = `${brName}:${getNextBridgeEth(brName)}`
                } else {
                    tgtEndpoint = `${tgtName}:${getEthName(link.targetNodeId, link.targetPortId)}`
                }

                lines.push(`    - endpoints: ["${srcEndpoint}", "${tgtEndpoint}"]`)
            }
        }

        lines.push('')
        return { ok: true, yaml: lines.join('\n'), labName, extraFiles }
    }

    toggleClabYamlPreview (): void {
        if (this.showClabYamlPreview) {
            this.showClabYamlPreview = false
            this.clabYamlPreviewContent = ''
            this.cdr.markForCheck()
            return
        }
        const result = this._generateClabYaml()
        if (!result.ok) {
            this.clabDialogError = result.error
            this.cdr.markForCheck()
            return
        }
        this.clabYamlPreviewContent = result.yaml
        this.showClabYamlPreview = true
        this.cdr.markForCheck()
    }

    exportContainerlab (): void {
        const result = this._generateClabYaml()
        if (!result.ok) {
            this.clabDialogError = result.error
            this.cdr.markForCheck()
            return
        }
        this._downloadText(result.yaml, `${this.topology.name.replace(/\s+/g, '_')}.clab.yml`, 'text/yaml')
        // Also export startup config files for SONiC-VS nodes
        for (const extra of result.extraFiles) {
            this._downloadText(extra.content, extra.name, 'application/json')
        }
        this.showClabDialog = false
        this.statusMsg = `Exported containerlab topology (${this.topology.nodes.length} nodes, ${this.topology.links.length} links)`
        this.cdr.markForCheck()
    }

    // ── Containerlab deploy / destroy / inspect ─────────────────────────

    /** Called by template modal when user clicks "Deploy Lab" — waits a tick for template to load then deploys */
    deployAfterTemplateLoad (): void {
        this.closeTemplates()
        setTimeout(() => this.deployContainerlab(), 200)
    }

    async deployContainerlab (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabCheckPrereqs || !api?.clabSaveTopology || !api?.clabDeploy) {
            this.clabDialogError = 'Containerlab API is unavailable in this runtime'
            this.cdr.markForCheck()
            return
        }

        // Block deploy if pre-deploy validation found errors
        if (this.clabValidationErrors.length > 0) {
            this.clabDialogError = 'Cannot deploy: pre-deploy validation found errors. Fix the issues above and re-validate.'
            this.cdr.markForCheck()
            return
        }

        this.clabDialogError = ''
        this.clabDeploying = true
        this.cdr.markForCheck()

        try {
            // Step 1: Check prerequisites
            const prereqs = await api.clabCheckPrereqs()
            if (!prereqs.docker) {
                this.clabDialogError = `Docker not available: ${prereqs.dockerMessage}`
                this.clabDeploying = false
                this.cdr.markForCheck()
                return
            }
            if (!prereqs.clab) {
                this.clabDialogError = `Containerlab not found: ${prereqs.clabMessage}`
                this.clabDeploying = false
                this.cdr.markForCheck()
                return
            }

            // Step 1b: Ask about Juniper deployment mode if needed
            const hasJuniper = this.topology.nodes.some(n => (n.vendor ?? '').toLowerCase() === 'juniper')
            if (hasJuniper && this.clabJuniperMode === 'ask') {
                const useCrpd = confirm(
                    'Juniper nodes detected.\n\n' +
                    '• "OK" = Use cRPD (lightweight, no KVM required, works on macOS)\n' +
                    '• "Cancel" = Use full VM mode (vQFX/vJunos, requires KVM/nested virtualization)\n\n' +
                    'Recommended: OK (cRPD) for most environments.'
                )
                this.clabJuniperMode = useCrpd ? 'crpd' : 'vm'
            }

            // Step 2: Regenerate startup configs for all vendor nodes so they're up-to-date
            this.svc.regenerateConfigs(true)

            // Step 3: Generate YAML
            const yamlResult = this._generateClabYaml()
            if (!yamlResult.ok) {
                this.clabDialogError = yamlResult.error
                this.clabDeploying = false
                this.cdr.markForCheck()
                return
            }

            // Step 4 + 5 + 6: Save & Deploy — multi-server aware
            if (this.hasMultiServerNodes && api?.clabSaveTopologyToServer && api?.clabDeployToServer) {
                // ── Multi-server deploy ──────────────────────────────────
                const { partitions, crossLinks } = this.splitTopologyByServer()
                const serverNames = [...partitions.keys()].map(sid => {
                    const s = this.clabServers.find(p => p.id === sid)
                    return s?.name ?? sid
                })
                this.statusMsg = `Multi-server deploy across ${serverNames.join(', ')}…`
                if (crossLinks.length > 0) {
                    this.statusMsg += ` (${crossLinks.length} cross-server link${crossLinks.length > 1 ? 's' : ''} need VXLAN tunnels)`
                }
                this.cdr.markForCheck()

                let allOk = true
                const deployedFiles: string[] = []
                for (const [serverId, partition] of partitions) {
                    const serverName = this.clabServers.find(s => s.id === serverId)?.name ?? serverId
                    const safeSuffix = serverName.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase()

                    // Generate per-server YAML
                    const perServerYaml = this._generateClabYaml({
                        nodes: partition.nodes,
                        links: partition.links,
                        labSuffix: safeSuffix,
                    })
                    if (!perServerYaml.ok) {
                        this.clabDialogError = `${serverName}: ${perServerYaml.error}`
                        allOk = false
                        break
                    }

                    // Save to target server
                    this.statusMsg = `Saving topology to ${serverName}…`
                    this.cdr.markForCheck()
                    const saveResult = await api.clabSaveTopologyToServer({
                        content: perServerYaml.yaml,
                        labName: perServerYaml.labName,
                        serverId,
                        extraFiles: perServerYaml.extraFiles,
                    })
                    if (!saveResult.ok) {
                        this.clabDialogError = `Save to ${serverName} failed: ${saveResult.message}`
                        allOk = false
                        break
                    }
                    deployedFiles.push(saveResult.filePath)

                    // Deploy on target server
                    this.statusMsg = `Deploying on ${serverName}…`
                    this.cdr.markForCheck()
                    const deployResult = await api.clabDeployToServer({
                        filePath: saveResult.filePath,
                        serverId,
                    })
                    if (!deployResult.ok) {
                        this.clabDialogError = `Deploy on ${serverName} failed: ${deployResult.message}`
                        allOk = false
                        break
                    }
                }

                this.showClabDialog = false
                this.clabDeploying = false
                if (allOk) {
                    this.clabDeployed = true
                    this.clabFilePath = deployedFiles[0] ?? null
                    this.svc.startAll()
                    this.statusMsg = `Multi-server deploy complete (${partitions.size} servers, ${crossLinks.length} cross-links)`
                    if (this._clabInspectTimer) { clearTimeout(this._clabInspectTimer) }
                    if (this._clabEnableTimer)  { clearTimeout(this._clabEnableTimer) }
                    this._clabInspectTimer = setTimeout(() => this.inspectContainerlab(), 15_000)
                    // Show countdown for interface enable wait
                    let msEnableCountdown = 120
                    const msEnableTimer = setInterval(() => {
                        msEnableCountdown--
                        if (msEnableCountdown > 0) {
                            this.clabPostDeployMsg = `Waiting for containers — enabling interfaces in ${msEnableCountdown}s…`
                            this.cdr.markForCheck()
                        } else {
                            clearInterval(msEnableTimer)
                        }
                    }, 1_000)
                    this._clabEnableTimer = setTimeout(() => {
                        clearInterval(msEnableTimer)
                        this.clabPostDeployMsg = 'Enabling interfaces and loading configs…'
                        this.cdr.markForCheck()
                        this._autoEnableInterfaces()
                    }, 120_000)
                } else {
                    this.showClabDialog = true
                }
            } else {
                // ── Single-server deploy (existing flow) ─────────────────
                const saveResult = await api.clabSaveTopology({
                    content: yamlResult.yaml,
                    labName: yamlResult.labName,
                    labDir: this.clabLabDir.trim() || undefined,
                    extraFiles: yamlResult.extraFiles,
                })
                if (!saveResult.ok) {
                    this.clabDialogError = saveResult.message
                    this.clabDeploying = false
                    this.cdr.markForCheck()
                    return
                }

                this.clabFilePath = saveResult.filePath!

                const deployResult = await api.clabDeploy({ filePath: this.clabFilePath })
                this.showClabDialog = false
                this.clabDeploying = false

                if (deployResult.ok) {
                    this.clabDeployed = true
                    this.svc.startAll()
                    this.clabPostDeployMsg = `Lab "${yamlResult.labName}" deployed — waiting for containers to initialize…`
                    this.statusMsg = this.clabPostDeployMsg
                    this.cdr.markForCheck()
                    if (this._clabInspectTimer) { clearTimeout(this._clabInspectTimer) }
                    if (this._clabEnableTimer)  { clearTimeout(this._clabEnableTimer) }
                    // Show countdown progress while waiting for containers
                    let countdown = 15
                    const countdownTimer = setInterval(() => {
                        countdown--
                        if (countdown > 0) {
                            this.clabPostDeployMsg = `Lab "${yamlResult.labName}" deployed — inspecting containers in ${countdown}s…`
                            this.statusMsg = this.clabPostDeployMsg
                            this.cdr.markForCheck()
                        } else {
                            clearInterval(countdownTimer)
                        }
                    }, 1_000)
                    this._clabInspectTimer = setTimeout(() => {
                        clearInterval(countdownTimer)
                        this.clabPostDeployMsg = `Inspecting lab containers…`
                        this.statusMsg = this.clabPostDeployMsg
                        this.cdr.markForCheck()
                        this.inspectContainerlab()
                    }, 15_000)
                    // Determine wait time based on node kinds — SONiC needs 120s, cRPD/cEOS/SRL need 30s
                    const hasSonic = this.topology.nodes.some(n => {
                        const k = this._vendorToClabKind(n.vendor, n.model, n.switchFamily)
                        return k === 'sonic-vs' || k === 'sonic'
                    })
                    const enableWaitSec = hasSonic ? 120 : 30
                    // Show countdown for interface enable wait
                    let enableCountdown = enableWaitSec
                    const enableCountdownTimer = setInterval(() => {
                        enableCountdown--
                        if (enableCountdown > 0) {
                            this.clabPostDeployMsg = `Waiting for containers to initialize — enabling interfaces & pushing configs in ${enableCountdown}s…`
                            this.cdr.markForCheck()
                        } else {
                            clearInterval(enableCountdownTimer)
                        }
                    }, 1_000)
                    this._clabEnableTimer = setTimeout(() => {
                        clearInterval(enableCountdownTimer)
                        this.clabPostDeployMsg = 'Enabling interfaces and pushing startup configs…'
                        this.cdr.markForCheck()
                        this._autoEnableInterfaces()
                    }, enableWaitSec * 1_000)
                } else {
                    this.showClabDialog = true
                    this.clabDialogError = `Deploy failed: ${deployResult.message}`
                }
            }
        } catch (err) {
            this.clabDialogError = `Deploy error: ${(err as Error).message}`
            this.clabDeploying = false
        }
        // Reset Juniper mode to 'ask' for next deploy
        this.clabJuniperMode = 'ask'
        this.cdr.markForCheck()
    }

    /**
     * Split topology into per-server partitions. Nodes with a `serverId` are grouped
     * to that server; nodes without `serverId` go to the active server.
     * Cross-server links are returned separately for VXLAN tunnel wiring.
     */
    splitTopologyByServer (): {
        partitions: Map<string, { nodes: typeof this.topology.nodes; links: typeof this.topology.links }>
        crossLinks: Array<{ link: typeof this.topology.links[0]; sourceServer: string; targetServer: string }>
    } {
        const defaultServerId = this.clabActiveServerId
        const partitions = new Map<string, { nodes: typeof this.topology.nodes; links: typeof this.topology.links }>()

        // Assign each node to a server
        const nodeServerMap = new Map<string, string>()
        for (const node of this.topology.nodes) {
            const sid = node.serverId || defaultServerId
            nodeServerMap.set(node.id, sid)
            if (!partitions.has(sid)) {
                partitions.set(sid, { nodes: [], links: [] })
            }
            partitions.get(sid)!.nodes.push(node)
        }

        // Assign links — same-server links go to that partition; cross-server are separate
        const crossLinks: Array<{ link: typeof this.topology.links[0]; sourceServer: string; targetServer: string }> = []
        for (const link of this.topology.links) {
            const srcSid = nodeServerMap.get(link.sourceNodeId) ?? defaultServerId
            const tgtSid = nodeServerMap.get(link.targetNodeId) ?? defaultServerId
            if (srcSid === tgtSid) {
                partitions.get(srcSid)!.links.push(link)
            } else {
                crossLinks.push({ link, sourceServer: srcSid, targetServer: tgtSid })
            }
        }

        return { partitions, crossLinks }
    }

    /** Check whether any nodes have explicit per-node server assignments. */
    get hasMultiServerNodes (): boolean {
        return this.topology.nodes.some(n => !!n.serverId && n.serverId !== this.clabActiveServerId)
    }

    async destroyContainerlab (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabDestroy || !this.clabFilePath) {
            this.statusMsg = 'No deployed lab to destroy'
            this.cdr.markForCheck()
            return
        }

        try {
            const result = await api.clabDestroy({ filePath: this.clabFilePath })
            if (result.ok) {
                this.svc.stopAll()
                this.clabDeployed = false
                this.clabContainers = []
                this.clabFilePath = null
                this.stopLivePolling()
                try { localStorage.removeItem('netops-last-lab') } catch { /* ignore */ }
                this.statusMsg = 'Destroying lab'
            } else {
                this.statusMsg = `Destroy failed: ${result.message}`
            }
        } catch (err) {
            this.statusMsg = `Destroy error: ${(err as Error).message}`
        }
        this.cdr.markForCheck()
    }

    async inspectContainerlab (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabInspect || !this.clabFilePath) {
            this.statusMsg = 'No deployed lab to inspect'
            this.cdr.markForCheck()
            return
        }

        this.clabInspecting = true
        this.cdr.markForCheck()

        try {
            const result = await api.clabInspect({ filePath: this.clabFilePath })
            this.clabInspecting = false
            this.clabPostDeployMsg = ''

            if (result.ok && result.containers) {
                this.clabContainers = result.containers
                this.showClabStatusDialog = true

                // Update node statuses based on container states
                for (const container of result.containers) {
                    const matchedNode = this.topology.nodes.find(n => {
                        const safeName = n.label.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase()
                        return container.name.endsWith('-' + safeName)
                    })

                    if (matchedNode) {
                        const isRunning = container.state === 'running'
                        this.svc.setNodeStatus(matchedNode.id, isRunning ? 'running' : 'stopped')
                    }
                }
                this.statusMsg = `Lab has ${result.containers.length} containers`

                // Auto-enable interfaces on SONiC-VS + linux containers
                this._enableContainerInterfaces(result.containers)

                // Start live topology polling
                if (!this.livePollingActive) { this.startLivePolling() }
            } else {
                this.statusMsg = result.message || 'No containers found'
            }
        } catch (err) {
            this.clabInspecting = false
            this.statusMsg = `Inspect error: ${(err as Error).message}`
        }
        this.cdr.markForCheck()
    }

    /** Enable interfaces on all containers — SONiC (full orchestration) + linux (IP assignment). */
    private async _enableContainerInterfaces (containers: Array<{ name: string; kind: string; state: string }>): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabEnableInterfaces) { return }

        const actionableContainers = containers.filter(
            c => c.state === 'running' && (c.kind === 'sonic-vs' || c.kind === 'sonic' || c.kind === 'linux')
        )
        if (!actionableContainers.length) { return }

        this.statusMsg = `Configuring interfaces on ${actionableContainers.length} container(s)…`
        this.cdr.markForCheck()

        let succeeded = 0
        let failed = 0
        for (const ctn of actionableContainers) {
            const shortName = ctn.name.replace(/^clab-[^-]+-/, '')
            this.statusMsg = `Enabling interfaces on ${shortName} (${succeeded + failed + 1}/${actionableContainers.length})…`
            this.cdr.markForCheck()
            const matchedNode = this.topology.nodes.find(n => {
                const safeName = n.label.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase()
                return ctn.name.endsWith('-' + safeName)
            })
            const linkCount = matchedNode
                ? this.topology.links.filter(l => l.sourceNodeId === matchedNode.id || l.targetNodeId === matchedNode.id).length
                : 6

            // Build port IP data for linux containers
            const portIps: Array<{ ethIndex: number; ip: string }> = []
            let defaultGw = ''
            if ((ctn.kind === 'linux') && matchedNode) {
                const linkedPorts = this.topology.links
                    .filter(l => l.sourceNodeId === matchedNode.id || l.targetNodeId === matchedNode.id)
                const portEthMap = new Map<string, number>()
                let idx = 1
                for (const l of linkedPorts) {
                    const pid = l.sourceNodeId === matchedNode.id ? l.sourcePortId : l.targetPortId
                    if (!portEthMap.has(pid)) { portEthMap.set(pid, idx++) }
                }
                for (const l of linkedPorts) {
                    const myPortId = l.sourceNodeId === matchedNode.id ? l.sourcePortId : l.targetPortId
                    const port = matchedNode.ports.find(p => p.id === myPortId)
                    if (port?.ipAddress?.trim()) {
                        portIps.push({ ethIndex: portEthMap.get(myPortId) ?? 1, ip: port.ipAddress.trim() })
                    }
                }
                // Default gateway for single-homed hosts
                if (linkedPorts.length === 1) {
                    const sl = linkedPorts[0]
                    const peerNodeId = sl.sourceNodeId === matchedNode.id ? sl.targetNodeId : sl.sourceNodeId
                    const peerPortId = sl.sourceNodeId === matchedNode.id ? sl.targetPortId : sl.sourcePortId
                    const peerNode = this.topology.nodes.find(n => n.id === peerNodeId)
                    const peerPort = peerNode?.ports.find(p => p.id === peerPortId)
                    const gw = peerPort?.ipAddress?.split('/')[0]?.trim()
                    if (gw) { defaultGw = gw }
                }
            }

            try {
                const result = await api.clabEnableInterfaces({
                    containerName: ctn.name,
                    kind: ctn.kind,
                    linkCount,
                    ...(ctn.kind === 'linux' ? { portIps, defaultGw } : {}),
                })
                if (result?.ok) { succeeded++ } else { failed++ }
            } catch (_e) {
                failed++
            }
        }
        this.statusMsg = failed
            ? `Interfaces: ${succeeded} enabled, ${failed} failed`
            : `Interfaces enabled on ${succeeded} container(s)`
        this.cdr.markForCheck()
    }

    /**
     * Auto-enable container interfaces after deploy.
     * Called on a 120s timer to allow SONiC services to fully boot.
     * If clabContainers is empty, runs an inspect first.
     */
    private async _autoEnableInterfaces (): Promise<void> {
        if (!this.clabDeployed) { return }
        const api = (window as any).netopsAPI
        if (!api?.clabEnableInterfaces) { return }

        // If containers aren't populated yet, do a quick inspect first
        if (!this.clabContainers.length && this.clabFilePath && api.clabInspect) {
            try {
                const ir = await api.clabInspect({ filePath: this.clabFilePath })
                if (ir.ok && ir.containers) {
                    this.clabContainers = ir.containers
                }
            } catch (err) { console.warn('Container inspect failed:', (err as Error).message) }
        }

        if (this.clabContainers.length) {
            await this._enableContainerInterfaces(this.clabContainers)

            // Auto-push startup configs after interfaces are enabled
            if (this.autoConfigPushEnabled) {
                this.clabPostDeployMsg = 'Auto-pushing startup configs to all nodes…'
                this.statusMsg = this.clabPostDeployMsg
                this.cdr.markForCheck()
                try {
                    await this.pushAllConfigs({ skipConfirm: true })
                    this.clabPostDeployMsg = '✓ Configs pushed — starting live polling'
                    this.statusMsg = this.clabPostDeployMsg
                } catch (_e) {
                    this.clabPostDeployMsg = '⚠ Config push completed with errors'
                    this.statusMsg = this.clabPostDeployMsg
                }
                this.cdr.markForCheck()
                // Start live polling after config push
                if (!this.livePollingActive) { this.startLivePolling() }
                setTimeout(() => { this.clabPostDeployMsg = ''; this.cdr.markForCheck() }, 8000)
            }
        }
    }

    closeClabStatusDialog (): void {
        this.showClabStatusDialog = false
        this.cdr.markForCheck()
    }

    /** Open a terminal showing live docker logs for a container */
    viewContainerLogs (containerName: string): void {
        const api = (window as any).netopsAPI
        if (!api?.clabContainerLogs) { return }
        api.clabContainerLogs({ container: containerName })
    }

    // ── Live topology polling ─────────────────────────────────────────────────

    startLivePolling (): void {
        if (this._livePollTimer) { return }
        this.livePollingActive = true
        this.showLivePanel = true
        this.cdr.markForCheck()
        this._pollLiveStatus()
        this._livePollTimer = setInterval(() => this._pollLiveStatus(), this.livePollingInterval)
    }

    stopLivePolling (): void {
        if (this._livePollTimer) { clearInterval(this._livePollTimer); this._livePollTimer = null }
        this.livePollingActive = false
        this.showLivePanel = false
        this.liveBgpState.clear()
        this.liveSummary = { nodesUp: 0, nodesTotal: 0, bgpUp: 0, bgpTotal: 0 }
        this.cdr.markForCheck()
    }

    private async _pollLiveStatus (): Promise<void> {
        if (this._livePollRunning) { return }
        const api = (window as any).netopsAPI
        if (!api?.clabPollLiveStatus || !this.clabContainers.length) { return }
        this._livePollRunning = true

        try {
            const containers = this.clabContainers.map(c => ({ name: c.name, kind: c.kind }))
            const result = await api.clabPollLiveStatus({ containers })
            if (!result?.ok) { return }

            let nodesUp = 0
            let bgpUp = 0
            let bgpTotal = 0

            for (const cStatus of result.containers) {
                // Update node status on canvas
                const matchedNode = this.topology.nodes.find(n => {
                    const safeName = n.label.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase()
                    return cStatus.containerName.endsWith('-' + safeName)
                })
                if (matchedNode) {
                    const isRunning = cStatus.state === 'running'
                    this.svc.setNodeStatus(matchedNode.id, isRunning ? 'running' : 'stopped')
                    if (isRunning) { nodesUp++ }
                }

                // Store BGP state keyed by container name
                this.liveBgpState.set(cStatus.containerName, cStatus.bgpNeighbors ?? [])
                for (const n of (cStatus.bgpNeighbors ?? [])) {
                    bgpTotal++
                    if (n.state === 'established') { bgpUp++ }
                }
            }

            this.liveSummary = { nodesUp, nodesTotal: result.containers.length, bgpUp, bgpTotal }
        } catch (err) { console.warn('Live poll failed:', (err as Error).message) }

        this._livePollRunning = false
        this.cdr.markForCheck()
    }

    /** Get the BGP session state for a link based on the endpoints' BGP neighbor tables. */
    linkLiveColor (link: TopologyLink): string {
        if (!this.livePollingActive || !this.liveBgpState.size) { return '' }

        const srcNode = this._nodeMap.get(link.sourceNodeId)
        const tgtNode = this._nodeMap.get(link.targetNodeId)
        if (!srcNode || !tgtNode) { return '' }

        const srcPort = srcNode.ports.find(p => p.id === link.sourcePortId)
        const tgtPort = tgtNode.ports.find(p => p.id === link.targetPortId)
        const srcIp = srcPort?.ipAddress?.split('/')[0]?.trim()
        const tgtIp = tgtPort?.ipAddress?.split('/')[0]?.trim()

        if (!srcIp && !tgtIp) { return '' }

        // Find containers for these nodes
        const srcContainer = this._findContainerForNode(srcNode)
        const tgtContainer = this._findContainerForNode(tgtNode)

        // Look up BGP state: does the target's neighbor table have srcIp? And vice versa?
        let srcState = ''
        let tgtState = ''

        if (tgtContainer && srcIp) {
            const tgtNeighbors = this.liveBgpState.get(tgtContainer.name) ?? []
            const match = tgtNeighbors.find(n => n.neighborIp === srcIp)
            if (match) { tgtState = match.state }
        }
        if (srcContainer && tgtIp) {
            const srcNeighbors = this.liveBgpState.get(srcContainer.name) ?? []
            const match = srcNeighbors.find(n => n.neighborIp === tgtIp)
            if (match) { srcState = match.state }
        }

        // No BGP data for either side → no override
        if (!srcState && !tgtState) { return '' }

        // Both established
        if (srcState === 'established' && tgtState === 'established') { return '#22c55e' }
        // At least one side converging
        if (srcState === 'established' || tgtState === 'established' ||
            srcState === 'active' || tgtState === 'active' ||
            srcState === 'connect' || tgtState === 'connect' ||
            srcState === 'opensent' || tgtState === 'opensent' ||
            srcState === 'openconfirm' || tgtState === 'openconfirm') {
            return '#f59e0b'
        }
        // Both idle or unknown
        return '#ef4444'
    }

    /** Get a short BGP label for a link (e.g., "Established" or "Active"). */
    linkBgpLiveLabel (link: TopologyLink): string {
        if (!this.livePollingActive || !this.liveBgpState.size) { return '' }

        const srcNode = this._nodeMap.get(link.sourceNodeId)
        const tgtNode = this._nodeMap.get(link.targetNodeId)
        if (!srcNode || !tgtNode) { return '' }

        const srcPort = srcNode.ports.find(p => p.id === link.sourcePortId)
        const tgtPort = tgtNode.ports.find(p => p.id === link.targetPortId)
        const srcIp = srcPort?.ipAddress?.split('/')[0]?.trim()
        const tgtIp = tgtPort?.ipAddress?.split('/')[0]?.trim()

        if (!srcIp && !tgtIp) { return '' }

        const srcContainer = this._findContainerForNode(srcNode)
        const tgtContainer = this._findContainerForNode(tgtNode)

        let bestState = ''

        if (tgtContainer && srcIp) {
            const match = (this.liveBgpState.get(tgtContainer.name) ?? []).find(n => n.neighborIp === srcIp)
            if (match) { bestState = match.state }
        }
        if (!bestState && srcContainer && tgtIp) {
            const match = (this.liveBgpState.get(srcContainer.name) ?? []).find(n => n.neighborIp === tgtIp)
            if (match) { bestState = match.state }
        }

        if (!bestState) { return '' }
        // Capitalize first letter
        return bestState.charAt(0).toUpperCase() + bestState.slice(1)
    }

    async detectRunningLab (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabDetectRunning) {
            this.statusMsg = 'Detect API is unavailable'
            this.cdr.markForCheck()
            return
        }

        this.detectedLabs = []
        this.detectLabScanning = true
        this.showDetectLabDialog = true
        this.statusMsg = 'Scanning Docker for running labs…'
        this.cdr.markForCheck()

        try {
            const result = await api.clabDetectRunning()
            this.detectLabScanning = false
            if (!result.ok) {
                this.statusMsg = result.message || 'Detection failed'
                this.cdr.markForCheck()
                return
            }

            if (!result.labs || !result.labs.length) {
                this.statusMsg = 'No running containerlab labs detected'
                this.cdr.markForCheck()
                return
            }

            this.detectedLabs = result.labs
            this.detectedLabsServer = result.server ?? null
            this.statusMsg = `Found ${result.labs.length} running lab(s)`
        } catch (err) {
            this.detectLabScanning = false
            this.statusMsg = `Detection error: ${(err as Error).message}`
        }
        this.cdr.markForCheck()
    }

    async reconnectLab (lab: { labName: string; topoFile: string; containers: Array<{ name: string; state: string; ipv4Address: string; ipv6Address: string; kind: string; image: string }> }): Promise<void> {
        const api = (window as any).netopsAPI

        // If the canvas is empty and we have a topo file, parse it and load the topology
        if (this.topology.nodes.length === 0 && lab.topoFile && api?.clabParseTopology) {
            this.statusMsg = `Loading topology from ${lab.topoFile}…`
            this.cdr.markForCheck()

            try {
                const parsed = await api.clabParseTopology({ filePath: lab.topoFile })
                if (parsed.ok && parsed.nodes?.length) {
                    this._loadTopologyFromClab(parsed.labName, parsed.nodes, parsed.links)
                }
            } catch (err) {
                this.statusMsg = `Could not parse topology file: ${(err as Error).message}`
            }
        }

        this.clabContainers = lab.containers
        this.clabDeployed = true
        this.clabFilePath = lab.topoFile || null

        // Update node statuses based on container states
        for (const container of lab.containers) {
            const matchedNode = this.topology.nodes.find(n => {
                const safeName = n.label.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_.-]/g, '').toLowerCase()
                return container.name.endsWith('-' + safeName)
            })
            if (matchedNode) {
                const isRunning = container.state === 'running'
                this.svc.setNodeStatus(matchedNode.id, isRunning ? 'running' : 'stopped')
            }
        }

        this.showDetectLabDialog = false
        this.showClabStatusDialog = true
        this.startLivePolling()
        this.statusMsg = `Reconnected to "${lab.labName}" — ${lab.containers.length} container(s)`

        // Persist for auto-reconnect on restart
        try {
            localStorage.setItem('netops-last-lab', JSON.stringify({ labName: lab.labName, serverId: this.clabActiveServerId }))
        } catch { /* ignore */ }

        this.cdr.markForCheck()
    }

    /** Build a TopologyTemplate from parsed .clab.yml data and load it onto the canvas */
    private _loadTopologyFromClab (
        labName: string,
        clabNodes: Array<{ name: string; kind: string; image: string; labels?: Record<string, string> }>,
        clabLinks: Array<{ srcNode: string; srcPort: string; tgtNode: string; tgtPort: string }>,
    ): void {
        const kindToType = (kind: string): NodeType => {
            switch (kind) {
                case 'sonic-vs':              return 'switch'
                case 'ceos':                  return 'router'
                case 'cisco_xrd':             return 'router'
                case 'cisco_xrv9k':           return 'router'
                case 'cisco_csr1000v':        return 'router'
                case 'cisco_n9kv':            return 'switch'
                case 'srl':                   return 'router'
                case 'crpd':                  return 'router'
                case 'juniper_vqfx':          return 'switch'
                case 'juniper_vjunosswitch':  return 'switch'
                case 'juniper_vjunosrouter':  return 'router'
                case 'linux':                 return 'server'
                default:                      return 'router'
            }
        }

        const kindToVendor = (kind: string): string | undefined => {
            switch (kind) {
                case 'sonic-vs':              return 'SONiC'
                case 'ceos':                  return 'Arista'
                case 'cisco_xrd':             return 'Cisco'
                case 'cisco_xrv9k':           return 'Cisco'
                case 'cisco_csr1000v':        return 'Cisco'
                case 'cisco_n9kv':            return 'Cisco'
                case 'srl':                   return 'Nokia'
                case 'crpd':                  return 'Juniper'
                case 'juniper_vqfx':          return 'Juniper'
                case 'juniper_vjunosswitch':  return 'Juniper'
                case 'juniper_vjunosrouter':  return 'Juniper'
                default:                      return undefined
            }
        }

        // Build a name→index map for link resolution
        const nameIndexMap = new Map<string, number>()
        clabNodes.forEach((n, i) => nameIndexMap.set(n.name, i))

        // Figure out how many eth ports each node needs
        const nodePortCount = new Map<string, number>()
        for (const link of clabLinks) {
            const srcIdx = parseInt(link.srcPort.replace('eth', ''), 10) || 1
            const tgtIdx = parseInt(link.tgtPort.replace('eth', ''), 10) || 1
            nodePortCount.set(link.srcNode, Math.max(nodePortCount.get(link.srcNode) ?? 0, srcIdx))
            nodePortCount.set(link.tgtNode, Math.max(nodePortCount.get(link.tgtNode) ?? 0, tgtIdx))
        }

        // Layout: grid with spacing
        const cols = Math.ceil(Math.sqrt(clabNodes.length))
        const spacingX = 220
        const spacingY = 180
        const startX = 120
        const startY = 120

        const templateNodes: TemplateNodeDef[] = clabNodes.map((n, i) => {
            const type = kindToType(n.kind)
            const neededPorts = nodePortCount.get(n.name) ?? 0

            // SONiC-VS: use Ethernet0/4/8/… naming (100G, 4-lane step)
            let ports: NodePort[]
            if (n.kind === 'sonic-vs') {
                const count = Math.max(neededPorts, 6)
                ports = []
                for (let p = 0; p < count; p++) {
                    const ethNum = p * 4
                    ports.push({ id: `Ethernet${ethNum}`, label: `Ethernet${ethNum}`, enabled: true })
                }
            } else {
                ports = DEFAULT_PORTS[type].map(p => ({ ...p }))
                while (ports.length < neededPorts) {
                    const idx = ports.length
                    ports.push({ id: `eth${idx}`, label: `eth${idx + 1}`, enabled: true })
                }
            }

            // Recover topology metadata from tlink-* labels (preserved across reconnect)
            const lblAsn = n.labels?.['tlink-asn']
            const lblRole = n.labels?.['tlink-role']
            const lblMgmtIp = n.labels?.['tlink-mgmt-ip']
            const lblPortIps = n.labels?.['tlink-port-ips']

            // Apply port IP addresses from labels ("portId=ip,portId2=ip2")
            if (lblPortIps) {
                for (const entry of lblPortIps.split(',')) {
                    const [portId, ip] = entry.split('=')
                    if (portId && ip) {
                        const port = ports.find(p => p.id === portId)
                        if (port) { port.ipAddress = ip }
                    }
                }
            }

            return {
                type,
                label: n.name,
                x: startX + (i % cols) * spacingX,
                y: startY + Math.floor(i / cols) * spacingY,
                vendor: kindToVendor(n.kind),
                ports,
                asn: lblAsn ? Number(lblAsn) : undefined,
                role: (lblRole as any) || undefined,
                mgmtIp: lblMgmtIp || undefined,
            }
        })

        const templateLinks: TemplateLinkDef[] = clabLinks.flatMap(link => {
            const srcIdx = nameIndexMap.get(link.srcNode)
            const tgtIdx = nameIndexMap.get(link.tgtNode)
            if (srcIdx === undefined || tgtIdx === undefined) { return [] }

            // containerlab eth1 → first port, eth2 → second port, etc.
            const srcPortNum = parseInt(link.srcPort.replace('eth', ''), 10) || 1
            const tgtPortNum = parseInt(link.tgtPort.replace('eth', ''), 10) || 1
            const srcPortId = templateNodes[srcIdx].ports?.[srcPortNum - 1]?.id ?? `eth${srcPortNum - 1}`
            const tgtPortId = templateNodes[tgtIdx].ports?.[tgtPortNum - 1]?.id ?? `eth${tgtPortNum - 1}`

            return [{
                sourceNode: srcIdx,
                sourcePort: srcPortId,
                targetNode: tgtIdx,
                targetPort: tgtPortId,
            }]
        })

        const template: TopologyTemplate = {
            id: labName,
            name: labName,
            description: `Imported from ${labName}.clab.yml`,
            icon: '🔬',
            category: 'general' as TemplateCategory,
            nodes: templateNodes,
            links: templateLinks,
        }

        this.svc.loadTemplate(template)
    }

    async destroyDetectedLab (lab: { labName: string; containers: any[] }): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabDestroyLab) {
            this.statusMsg = 'Destroy API is unavailable'
            this.cdr.markForCheck()
            return
        }

        this.statusMsg = `Destroying lab "${lab.labName}" (${lab.containers.length} containers)…`
        this.cdr.markForCheck()

        try {
            const result = await api.clabDestroyLab({ labName: lab.labName })
            if (result.ok) {
                // Remove this lab from detected list
                this.detectedLabs = this.detectedLabs.filter(l => l.labName !== lab.labName)
                this.statusMsg = result.message || `Lab "${lab.labName}" destroyed`

                // If we were connected to this lab, clear deployed state
                if (this.clabDeployed && this.clabContainers.length > 0) {
                    const wasConnected = lab.containers.some((c: any) =>
                        this.clabContainers.some(cc => cc.name === c.name)
                    )
                    if (wasConnected) {
                        this.clabDeployed = false
                        this.clabContainers = []
                        this.clabFilePath = null
                        this.stopLivePolling()
                        for (const node of this.topology.nodes) {
                            this.svc.setNodeStatus(node.id, 'stopped')
                        }
                    }
                }

                if (this.detectedLabs.length === 0) {
                    this.statusMsg = `Lab "${lab.labName}" destroyed — no more running labs`
                }
            } else {
                this.statusMsg = result.message || 'Destroy failed'
            }
        } catch (err) {
            this.statusMsg = `Destroy error: ${(err as Error).message}`
        }
        this.cdr.markForCheck()
    }

    closeDetectLabDialog (): void {
        this.showDetectLabDialog = false
        this.detectLabScanning = false
        this.cdr.markForCheck()
    }

    private _downloadText (content: string, filename: string, mime: string): void {
        const blob = new Blob([content], { type: mime })
        const url  = URL.createObjectURL(blob)
        const a    = document.createElement('a')
        a.href = url; a.download = filename; a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    // ── Search ───────────────────────────────────────────────────────────────

    toggleSearch (): void {
        this.showSearch = !this.showSearch
        if (!this.showSearch) { this.searchQuery = '' }
        this.cdr.markForCheck()
    }

    get searchResults (): TopologyNode[] {
        const q = this.searchQuery.trim().toLowerCase()
        if (!q) { return [] }
        return this.topology?.nodes.filter(n =>
            n.label.toLowerCase().includes(q) ||
            n.type.toLowerCase().includes(q) ||
            (n.mgmtIp ?? '').includes(q),
        ) ?? []
    }

    jumpToNode (node: TopologyNode): void {
        // Centre viewport on node
        const svg = this.svgRef.nativeElement
        const r = svg.getBoundingClientRect()
        this.vpX = r.width / 2 - (node.x + NODE_W / 2) * this.vpScale
        this.vpY = r.height / 2 - (node.y + NODE_H / 2) * this.vpScale
        // Select it
        this.selectedNodeIds = new Set([node.id])
        this.selectedLinkIds.clear()
        this._syncPrimarySelection()
        this.statusMsg = `Jumped to: ${node.label}`
        this.showSearch = false
        this.searchQuery = ''
        this.cdr.markForCheck()
    }

    // ── Link quality color ───────────────────────────────────────────────────

    linkQualityColor (link: TopologyLink): string {
        if (link.status === 'down') { return '#ef4444' }
        const latMs = link.latency ?? 0
        const lossP = link.packetLoss ?? 0
        const latScore = latMs > 100 ? 1 : latMs > 10 ? 0.5 : 0
        const lossScore = lossP > 5 ? 1 : lossP > 0 ? 0.5 : 0
        const score = Math.max(latScore, lossScore)
        if (score >= 1) { return '#ef4444' }
        if (score >= 0.5) { return '#f59e0b' }
        return '#3a7aaa'
    }

    // ── Link mode ────────────────────────────────────────────────────────────

    toggleLinkMode (): void {
        this.linkModeActive = !this.linkModeActive
        if (this.linkModeActive) {
            this.statusMsg = 'Link mode — click a node to start drawing a link'
        } else {
            this.statusMsg = 'Ready'
            this.pendingLink = null
        }
        this.cdr.markForCheck()
    }

    // ── Link context menu ────────────────────────────────────────────────────

    onLinkRightClick (ev: MouseEvent, link: TopologyLink): void {
        ev.preventDefault()
        ev.stopPropagation()
        this.ctxNodeId = null
        this.selectedLinkIds = new Set([link.id])
        this.selectedNodeIds.clear()
        this._syncPrimarySelection()
        this.ctxLinkId = link.id
        const pos = this._ctxPos(ev, 200, 500)
        this.ctxLinkX = pos.x
        this.ctxLinkY = pos.y
        this.cdr.markForCheck()
    }

    closeCtxLinkMenu (): void { this.ctxLinkId = null; this.cdr.markForCheck() }

    ctxLinkDelete (): void {
        if (!this.ctxLinkId) { return }
        this.svc.removeLink(this.ctxLinkId)
        this.ctxLinkId = null
        this.statusMsg = 'Link deleted'
        this.cdr.markForCheck()
    }

    ctxLinkToggleDown (): void {
        if (!this.ctxLinkId) { return }
        // If multiple links are selected and the right-clicked link is among them,
        // toggle the entire selection together in one patch.
        const ids = this.selectedLinkIds.size > 1 && this.selectedLinkIds.has(this.ctxLinkId)
            ? [...this.selectedLinkIds]
            : [this.ctxLinkId]
        this.svc.toggleLinksDown(ids)
        const anyDown = this.topology.links.some(l => ids.includes(l.id) && l.status === 'down')
        this.statusMsg = anyDown
            ? `${ids.length} link(s) marked down`
            : `${ids.length} link(s) restored`
        this.ctxLinkId = null
        this.cdr.markForCheck()
    }

    ctxLinkProperties (): void {
        if (!this.ctxLinkId) { return }
        this.selectedLinkIds = new Set([this.ctxLinkId])
        this.selectedNodeIds.clear()
        this._syncPrimarySelection()
        this.ctxLinkId = null
        this.cdr.markForCheck()
    }

    get ctxLinkStatus (): string {
        // When multiple links are selected and right-clicked link is among them,
        // show "Restore" only if ALL of them are already down.
        if (this.selectedLinkIds.size > 1 && this.ctxLinkId && this.selectedLinkIds.has(this.ctxLinkId)) {
            const allDown = [...this.selectedLinkIds].every(id =>
                this.topology?.links.find(l => l.id === id)?.status === 'down',
            )
            return allDown ? 'down' : 'up'
        }
        return this.topology?.links.find(l => l.id === this.ctxLinkId)?.status ?? 'up'
    }

    get ctxLinkHasBend (): boolean {
        const link = this.topology?.links.find(l => l.id === this.ctxLinkId)
        return link?.bendOffset != null && link.bendOffset !== 0
    }

    ctxLinkResetBend (): void {
        if (!this.ctxLinkId) { return }
        this.svc.patchLink(this.ctxLinkId, { bendOffset: 0 })
        this.ctxLinkId = null
        this.cdr.markForCheck()
    }

    // ── Shape link helpers ─────────────────────────────────────────────────────

    /** Whether a link connects at least one shape (annotation) */
    // ── Export ───────────────────────────────────────────────────────────────

    exportSVG (): void {
        const svg = this.svgRef.nativeElement.cloneNode(true) as SVGSVGElement
        // Remove interactive elements
        svg.querySelectorAll('.link-overlay-hit, .link-hit, .shape-edge-zone, .link-endpoint-handle, .shape-handle, .link-bend-handle, .shape-edge-dot, .waypoint-handle, .link-label-input, .shape-label-input').forEach(el => el.remove())
        const data = new XMLSerializer().serializeToString(svg)
        const blob = new Blob([data], { type: 'image/svg+xml' })
        this._downloadBlob(blob, `${this.topology?.name || 'topology'}.svg`)
        this.statusMsg = 'Exported as SVG'
        this.cdr.markForCheck()
    }

    exportPNG (): void {
        const svg = this.svgRef.nativeElement.cloneNode(true) as SVGSVGElement
        svg.querySelectorAll('.link-overlay-hit, .link-hit, .shape-edge-zone, .link-endpoint-handle, .shape-handle, .link-bend-handle, .shape-edge-dot, .waypoint-handle, .link-label-input, .shape-label-input').forEach(el => el.remove())
        const data = new XMLSerializer().serializeToString(svg)
        const svgBlob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' })
        const url = URL.createObjectURL(svgBlob)
        const img = new Image()
        img.onload = () => {
            const canvas = document.createElement('canvas')
            canvas.width = img.naturalWidth || 1920
            canvas.height = img.naturalHeight || 1080
            const ctx = canvas.getContext('2d')!
            ctx.fillStyle = '#0f172a'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(img, 0, 0)
            canvas.toBlob(blob => {
                if (blob) { this._downloadBlob(blob, `${this.topology?.name || 'topology'}.png`) }
                URL.revokeObjectURL(url)
            }, 'image/png')
            this.statusMsg = 'Exported as PNG'
            this.cdr.markForCheck()
        }
        img.src = url
    }

    private _downloadBlob (blob: Blob, filename: string): void {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = filename
        a.click()
        URL.revokeObjectURL(a.href)
    }

    /** Whether an annotation type is a geometric shape (not text) */
    isShapeType (type?: string): boolean {
        return !!type && type !== 'text'
    }

    /** Build transform string for a shape group (translate + optional rotate) */
    shapeTransform (ann: Annotation): string {
        const t = `translate(${ann.x},${ann.y})`
        if (!ann.rotation) { return t }
        const cx = (ann.width ?? 120) / 2, cy = (ann.height ?? 80) / 2
        return `${t} rotate(${ann.rotation},${cx},${cy})`
    }

    // ── Rotation drag ───────────────────────────────────────────────────

    private _rotatingShape: Annotation | null = null

    onRotationStart (ev: MouseEvent, ann: Annotation): void {
        ev.preventDefault()
        ev.stopPropagation()
        this._rotatingShape = ann
    }

    /** Return SVG path d-string for a shape, in local coords (0,0 to w,h) */
    shapePathD (ann: Annotation): string {
        const w = ann.width ?? 120, h = ann.height ?? 80
        switch (ann.type) {
            case 'diamond':
                return `M${w/2},0 L${w},${h/2} L${w/2},${h} L0,${h/2} Z`
            case 'triangle':
                return `M${w/2},0 L${w},${h} L0,${h} Z`
            case 'star': {
                const cx = w / 2, cy = h / 2, or = Math.min(w, h) / 2, ir = or * 0.38
                let d = ''
                for (let i = 0; i < 10; i++) {
                    const a = (i * Math.PI / 5) - Math.PI / 2
                    const r = i % 2 === 0 ? or : ir
                    d += (i === 0 ? 'M' : 'L') + (cx + r * Math.cos(a)) + ',' + (cy + r * Math.sin(a))
                }
                return d + 'Z'
            }
            case 'hexagon': {
                const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2
                let d = ''
                for (let i = 0; i < 6; i++) {
                    const a = (i * Math.PI / 3) - Math.PI / 6
                    d += (i === 0 ? 'M' : 'L') + (cx + r * Math.cos(a)) + ',' + (cy + r * Math.sin(a))
                }
                return d + 'Z'
            }
            case 'parallelogram': {
                const skew = w * 0.2
                return `M${skew},0 L${w},0 L${w - skew},${h} L0,${h} Z`
            }
            case 'cylinder': {
                const ry = h * 0.12
                return `M0,${ry} A${w/2},${ry} 0 0,1 ${w},${ry} L${w},${h - ry} A${w/2},${ry} 0 0,1 0,${h - ry} Z`
            }
            case 'cloud': {
                // Simplified cloud shape using cubic beziers
                return `M${w*0.25},${h*0.6} C${w*0.05},${h*0.6} 0,${h*0.4} ${w*0.15},${h*0.3}
                    C${w*0.1},${h*0.1} ${w*0.3},0 ${w*0.45},${h*0.15}
                    C${w*0.5},${h*0.05} ${w*0.7},0 ${w*0.75},${h*0.15}
                    C${w*0.95},${h*0.1} ${w},${h*0.3} ${w*0.9},${h*0.45}
                    C${w},${h*0.55} ${w*0.95},${h*0.7} ${w*0.8},${h*0.7}
                    L${w*0.2},${h*0.7}
                    C${w*0.05},${h*0.7} 0,${h*0.65} ${w*0.25},${h*0.6} Z`
            }
            case 'arrow-right': {
                const aw = w * 0.6, ah = h * 0.3
                return `M0,${ah} L${aw},${ah} L${aw},0 L${w},${h/2} L${aw},${h} L${aw},${h - ah} L0,${h - ah} Z`
            }
            case 'arrow-double': {
                const ah = h * 0.3, aw = w * 0.25
                return `M0,${h/2} L${aw},0 L${aw},${ah} L${w - aw},${ah} L${w - aw},0 L${w},${h/2} L${w - aw},${h} L${w - aw},${h - ah} L${aw},${h - ah} L${aw},${h} Z`
            }
            case 'line-h':
                return `M0,${h/2 - 2} L${w},${h/2 - 2} L${w},${h/2 + 2} L0,${h/2 + 2} Z`
            default:
                return ''
        }
    }

    /** Cylinder top ellipse for separate rendering */
    cylinderTopD (ann: Annotation): string {
        const w = ann.width ?? 120, h = ann.height ?? 80
        const ry = h * 0.12
        return `M0,${ry} A${w/2},${ry} 0 0,0 ${w},${ry} A${w/2},${ry} 0 0,0 0,${ry}`
    }

    isShapeLink (link: TopologyLink | null): boolean {
        return !!(link?.sourceAnnotationId || link?.targetAnnotationId)
    }

    getCtxLink (): TopologyLink | null {
        return this.topology?.links?.find(l => l.id === this.ctxLinkId) ?? null
    }

    shapeLinkColors = ['#3b82f6', '#22c55e', '#ef4444', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#ffffff']

    ctxLinkSetColor (color: string): void {
        if (!this.ctxLinkId) { return }
        this.svc.updateLinkConfig(this.ctxLinkId, { linkColor: color } as any)
        this.ctxLinkId = null
        this.cdr.markForCheck()
    }

    ctxLinkToggleArrow (): void {
        if (!this.ctxLinkId) { return }
        const link = this.topology.links.find(l => l.id === this.ctxLinkId)
        this.svc.updateLinkConfig(this.ctxLinkId, { showArrow: !link?.showArrow } as any)
        this.cdr.markForCheck()
    }

    ctxLinkToggleRouting (): void {
        if (!this.ctxLinkId) { return }
        const link = this.topology.links.find(l => l.id === this.ctxLinkId)
        const newRouting = link?.routing === 'orthogonal' ? 'straight' : 'orthogonal'
        this.svc.updateLinkConfig(this.ctxLinkId, { routing: newRouting } as any)
        this.cdr.markForCheck()
    }

    ctxLinkSetArrows (start: boolean, end: boolean): void {
        if (!this.ctxLinkId) { return }
        this.svc.updateLinkConfig(this.ctxLinkId, { arrowStart: start, showArrow: end } as any)
        this.cdr.markForCheck()
    }

    ctxLinkSetWidth (w: number): void {
        if (!this.ctxLinkId) { return }
        this.svc.updateLinkConfig(this.ctxLinkId, { linkWidth: w } as any)
        this.cdr.markForCheck()
    }

    ctxLinkToggleSketched (): void {
        if (!this.ctxLinkId) { return }
        const link = this.topology.links.find(l => l.id === this.ctxLinkId)
        this.svc.updateLinkConfig(this.ctxLinkId, { sketched: !link?.sketched } as any)
        this.cdr.markForCheck()
    }

    ctxLinkSetDash (dash: string): void {
        if (!this.ctxLinkId) { return }
        this.svc.updateLinkConfig(this.ctxLinkId, { linkDash: dash } as any)
        this.ctxLinkId = null
        this.cdr.markForCheck()
    }

    labelColors = ['#e2e8f0', '#ffffff', '#3b82f6', '#22c55e', '#ef4444', '#f59e0b', '#8b5cf6', '#06b6d4']

    ctxLinkSetFont (size: number): void {
        if (!this.ctxLinkId) { return }
        this.svc.updateLinkConfig(this.ctxLinkId, { labelFontSize: size } as any)
        this.cdr.markForCheck()
    }

    ctxLinkSetFontWeight (weight: 'normal' | 'bold'): void {
        if (!this.ctxLinkId) { return }
        this.svc.updateLinkConfig(this.ctxLinkId, { labelFontWeight: weight } as any)
        this.cdr.markForCheck()
    }

    ctxLinkSetLabelColor (color: string): void {
        if (!this.ctxLinkId) { return }
        this.svc.updateLinkConfig(this.ctxLinkId, { labelColor: color } as any)
        this.cdr.markForCheck()
    }

    // ── Multi-label support ────────────────────────────────────────────────

    editingLinkLabelId: string | null = null  // label.id being edited
    editingLinkLabelText = ''
    private _editingLinkId: string | null = null  // parent link id

    // Context menu state for individual labels
    ctxLabelLinkId: string | null = null
    ctxLabelId: string | null = null

    /** Get all labels for a link, migrating legacy single-label if needed */
    getLinkLabels (link: TopologyLink): any[] {
        if (link.labels?.length) { return link.labels }
        if (link.userLabel) {
            return [{ id: 'legacy', text: link.userLabel, t: 0.5, perpOffset: -14,
                fontSize: link.labelFontSize, fontWeight: link.labelFontWeight, color: link.labelColor }]
        }
        return []
    }

    /** Compute absolute SVG position for a label on a link using t + perpOffset */
    labelPos (link: TopologyLink, lbl: any): { x: number; y: number } {
        const sc = this._linkEndpoint(link.sourceNodeId, link.sourceAnnotationId, undefined, link.sourceAnchorX, link.sourceAnchorY)
        const tc = this._linkEndpoint(link.targetNodeId, link.targetAnnotationId, undefined, link.targetAnchorX, link.targetAnchorY)
        if (!sc || !tc) { return { x: 0, y: 0 } }
        const sp = (link.sourceAnchorX != null) ? sc : this._linkEndpoint(link.sourceNodeId, link.sourceAnnotationId, tc)!
        const tp = (link.targetAnchorX != null) ? tc : this._linkEndpoint(link.targetNodeId, link.targetAnnotationId, sc)!
        if (!sp || !tp) { return { x: 0, y: 0 } }

        const t = lbl.t ?? 0.5
        const px = sp.x + (tp.x - sp.x) * t
        const py = sp.y + (tp.y - sp.y) * t

        // Perpendicular offset
        const dx = tp.x - sp.x, dy = tp.y - sp.y
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        const nx = -dy / len, ny = dx / len  // unit normal
        const perp = lbl.perpOffset ?? -14

        return { x: px + nx * perp, y: py + ny * perp }
    }

    /** Estimate label text width */
    labelTextWidth (lbl: any): number {
        return (lbl.text?.length ?? 0) * ((lbl.fontSize || 11) * 0.6)
    }

    /** Double-click on link body → add waypoint (Alt held) or new label at click position */
    onLinkDblClick (ev: MouseEvent, link: TopologyLink): void {
        ev.stopPropagation()
        ev.preventDefault()
        const pt = this.svgPt(ev)
        // Alt + double-click → add waypoint at click position
        if (ev.altKey) {
            const wp = [...(link.waypoints ?? []), { x: this._snap(pt.x), y: this._snap(pt.y) }]
            this.svc.updateLinkConfig(link.id, { waypoints: wp } as any)
            this.statusMsg = 'Waypoint added — drag to position'
            this.cdr.markForCheck()
            return
        }
        const { t, perpOffset } = this._pointToLinkParams(link, pt.x, pt.y)
        const newLabel = {
            id: this._uid(), text: 'Label', t, perpOffset: perpOffset - 14,
            fontSize: 11, fontWeight: 'bold' as const, color: '#e2e8f0',
        }
        const existing = link.labels ?? this._migrateLegacyLabels(link)
        this.svc.updateLinkConfig(link.id, { labels: [...existing, newLabel] } as any)
        // Start editing immediately
        this._editingLinkId = link.id
        this.editingLinkLabelId = newLabel.id
        this.editingLinkLabelText = newLabel.text
        this.cdr.markForCheck()
        setTimeout(() => {
            const input = document.querySelector('.link-label-input') as HTMLInputElement
            input?.focus()
            input?.select()
        }, 50)
    }

    /** Double-click on existing label → edit it */
    onLabelDblClick (ev: MouseEvent, link: TopologyLink, lbl: any): void {
        ev.stopPropagation()
        ev.preventDefault()
        this._editingLinkId = link.id
        this.editingLinkLabelId = lbl.id
        this.editingLinkLabelText = lbl.text
        this.cdr.markForCheck()
        setTimeout(() => {
            const input = document.querySelector('.link-label-input') as HTMLInputElement
            input?.focus()
            input?.select()
        }, 50)
    }

    /** Right-click on label → show delete option */
    onLabelRightClick (ev: MouseEvent, link: TopologyLink, lbl: any): void {
        ev.preventDefault()
        ev.stopPropagation()
        this.ctxLabelLinkId = link.id
        this.ctxLabelId = lbl.id
        const pos = this._ctxPos(ev, 160, 120)
        this.ctxLinkX = pos.x
        this.ctxLinkY = pos.y
        this.cdr.markForCheck()
    }

    deleteLinkLabel (): void {
        if (!this.ctxLabelLinkId || !this.ctxLabelId) { return }
        const link = this.topology.links.find(l => l.id === this.ctxLabelLinkId)
        if (!link) { return }
        const labels = (link.labels ?? []).filter(l => l.id !== this.ctxLabelId)
        this.svc.updateLinkConfig(this.ctxLabelLinkId, { labels, userLabel: undefined } as any)
        this.ctxLabelLinkId = null
        this.ctxLabelId = null
        this.statusMsg = 'Label deleted'
        this.cdr.markForCheck()
    }

    editCtxLabel (): void {
        if (!this.ctxLabelLinkId || !this.ctxLabelId) { return }
        const link = this.topology.links.find(l => l.id === this.ctxLabelLinkId)
        const lbl = link?.labels?.find(l => l.id === this.ctxLabelId)
        if (link && lbl) { this.onLabelDblClick(new MouseEvent('dblclick'), link, lbl) }
        this.ctxLabelLinkId = null
        this.ctxLabelId = null
    }

    closeLabelCtxMenu (): void {
        this.ctxLabelLinkId = null
        this.ctxLabelId = null
        this.cdr.markForCheck()
    }

    ctxLinkEditLabel (): void {
        if (!this.ctxLinkId) { return }
        const link = this.topology.links.find(l => l.id === this.ctxLinkId)
        if (link) {
            const existing = link.labels ?? this._migrateLegacyLabels(link)
            const newLabel = {
                id: this._uid(), text: 'Label', t: 0.5, perpOffset: -14 - existing.length * 18,
                fontSize: 11, fontWeight: 'bold' as const, color: '#e2e8f0',
            }
            this.svc.updateLinkConfig(link.id, { labels: [...existing, newLabel], userLabel: undefined } as any)
            this._editingLinkId = link.id
            this.editingLinkLabelId = newLabel.id
            this.editingLinkLabelText = newLabel.text
            this.cdr.markForCheck()
            setTimeout(() => {
                const input = document.querySelector('.link-label-input') as HTMLInputElement
                input?.focus()
                input?.select()
            }, 50)
        }
        this.ctxLinkId = null
    }

    commitLinkLabelEdit (): void {
        if (this._editingLinkId && this.editingLinkLabelId) {
            const link = this.topology.links.find(l => l.id === this._editingLinkId)
            if (link) {
                let labels = link.labels ?? this._migrateLegacyLabels(link)
                if (this.editingLinkLabelText) {
                    labels = labels.map(l => l.id === this.editingLinkLabelId ? { ...l, text: this.editingLinkLabelText } : l)
                } else {
                    // Empty text → delete the label
                    labels = labels.filter(l => l.id !== this.editingLinkLabelId)
                }
                this.svc.updateLinkConfig(link.id, { labels, userLabel: undefined } as any)
            }
        }
        this.editingLinkLabelId = null
        this._editingLinkId = null
        this.cdr.markForCheck()
    }

    cancelLinkLabelEdit (): void {
        this.editingLinkLabelId = null
        this._editingLinkId = null
        this.cdr.markForCheck()
    }

    /** Migrate legacy single-label fields into labels array */
    private _migrateLegacyLabels (link: TopologyLink): any[] {
        if (link.userLabel) {
            return [{ id: 'legacy', text: link.userLabel, t: 0.5, perpOffset: -14,
                fontSize: link.labelFontSize, fontWeight: link.labelFontWeight, color: link.labelColor }]
        }
        return []
    }

    /** Convert an SVG point to { t, perpOffset } relative to a link */
    private _pointToLinkParams (link: TopologyLink, px: number, py: number): { t: number; perpOffset: number } {
        const sc = this._linkEndpoint(link.sourceNodeId, link.sourceAnnotationId, undefined, link.sourceAnchorX, link.sourceAnchorY)
        const tc = this._linkEndpoint(link.targetNodeId, link.targetAnnotationId, undefined, link.targetAnchorX, link.targetAnchorY)
        if (!sc || !tc) { return { t: 0.5, perpOffset: 0 } }
        const sp = (link.sourceAnchorX != null) ? sc : this._linkEndpoint(link.sourceNodeId, link.sourceAnnotationId, tc)!
        const tp = (link.targetAnchorX != null) ? tc : this._linkEndpoint(link.targetNodeId, link.targetAnnotationId, sc)!
        if (!sp || !tp) { return { t: 0.5, perpOffset: 0 } }

        const dx = tp.x - sp.x, dy = tp.y - sp.y
        const len2 = dx * dx + dy * dy
        if (len2 === 0) { return { t: 0.5, perpOffset: 0 } }
        const len = Math.sqrt(len2)

        // Project point onto line to get t
        const t = Math.max(0, Math.min(1, ((px - sp.x) * dx + (py - sp.y) * dy) / len2))

        // Perpendicular distance (signed)
        const nx = -dy / len, ny = dx / len
        const closestX = sp.x + dx * t, closestY = sp.y + dy * t
        const perpOffset = (px - closestX) * nx + (py - closestY) * ny

        return { t, perpOffset }
    }

    private _uid (): string {
        return Math.random().toString(36).slice(2, 10)
    }

    // ── Label drag ──────────────────────────────────────────────────────

    private _labelDragLink: TopologyLink | null = null
    private _labelDragLabelId: string | null = null
    private _labelDragStartMouse: { x: number; y: number } | null = null
    private _labelDragStartOffset: { x: number; y: number } | null = null
    private _labelDragMoved = false

    onLinkLabelDragStart (ev: MouseEvent, link: TopologyLink, lbl: any): void {
        ev.preventDefault()
        ev.stopPropagation()
        this._labelDragLink = link
        this._labelDragLabelId = lbl.id
        this._labelDragMoved = false
        const pt = this.svgPt(ev)
        this._labelDragStartMouse = { x: pt.x, y: pt.y }
        this._labelDragStartOffset = { x: lbl.t ?? 0.5, y: lbl.perpOffset ?? -14 }
    }

    // ── Align / Distribute ─────────────────────────────────────────────────

    alignNodes (dir: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void {
        const nodes = this.topology.nodes.filter(n => this.selectedNodeIds.has(n.id))
        if (nodes.length < 2) { return }
        const getW = (n: TopologyNode) => this.nodeW(n)
        const getH = (n: TopologyNode) => this.nodeH(n)

        switch (dir) {
            case 'left': {
                const min = Math.min(...nodes.map(n => n.x))
                nodes.forEach(n => this.svc.moveNode(n.id, min, n.y)); break
            }
            case 'center': {
                const avg = nodes.reduce((s, n) => s + n.x + getW(n) / 2, 0) / nodes.length
                nodes.forEach(n => this.svc.moveNode(n.id, avg - getW(n) / 2, n.y)); break
            }
            case 'right': {
                const max = Math.max(...nodes.map(n => n.x + getW(n)))
                nodes.forEach(n => this.svc.moveNode(n.id, max - getW(n), n.y)); break
            }
            case 'top': {
                const min = Math.min(...nodes.map(n => n.y))
                nodes.forEach(n => this.svc.moveNode(n.id, n.x, min)); break
            }
            case 'middle': {
                const avg = nodes.reduce((s, n) => s + n.y + getH(n) / 2, 0) / nodes.length
                nodes.forEach(n => this.svc.moveNode(n.id, n.x, avg - getH(n) / 2)); break
            }
            case 'bottom': {
                const max = Math.max(...nodes.map(n => n.y + getH(n)))
                nodes.forEach(n => this.svc.moveNode(n.id, n.x, max - getH(n))); break
            }
        }
        this.closeCtxMenu()
        this.statusMsg = `Aligned ${dir}`
        this.cdr.markForCheck()
    }

    distributeNodes (axis: 'h' | 'v'): void {
        const nodes = this.topology.nodes.filter(n => this.selectedNodeIds.has(n.id))
        if (nodes.length < 3) { return }
        if (axis === 'h') {
            const sorted = [...nodes].sort((a, b) => a.x - b.x)
            const min = sorted[0].x, max = sorted[sorted.length - 1].x
            const step = (max - min) / (sorted.length - 1)
            sorted.forEach((n, i) => this.svc.moveNode(n.id, min + i * step, n.y))
        } else {
            const sorted = [...nodes].sort((a, b) => a.y - b.y)
            const min = sorted[0].y, max = sorted[sorted.length - 1].y
            const step = (max - min) / (sorted.length - 1)
            sorted.forEach((n, i) => this.svc.moveNode(n.id, n.x, min + i * step))
        }
        this.closeCtxMenu()
        this.statusMsg = `Distributed ${axis === 'h' ? 'horizontally' : 'vertically'}`
        this.cdr.markForCheck()
    }

    // ── Waypoints ─────────────────────────────────────────────────────────

    private _waypointDragLink: TopologyLink | null = null
    private _waypointDragIndex = -1

    ctxWaypointLinkId: string | null = null
    private _ctxWaypointIndex = -1

    ctxLinkAddWaypoint (): void {
        if (!this.ctxLinkId) { return }
        const link = this.topology.links.find(l => l.id === this.ctxLinkId)
        if (!link) { return }
        const mid = this.linkMidpoint(link)
        const wp = [...(link.waypoints ?? []), { x: mid.x, y: mid.y }]
        this.svc.updateLinkConfig(this.ctxLinkId, { waypoints: wp } as any)
        this.ctxLinkId = null
        this.statusMsg = 'Waypoint added — drag to position'
        this.cdr.markForCheck()
    }

    ctxLinkClearWaypoints (): void {
        if (!this.ctxLinkId) { return }
        this.svc.updateLinkConfig(this.ctxLinkId, { waypoints: [] } as any)
        this.ctxLinkId = null
        this.statusMsg = 'Waypoints cleared'
        this.cdr.markForCheck()
    }

    onWaypointDragStart (ev: MouseEvent, link: TopologyLink, index: number): void {
        ev.preventDefault()
        ev.stopPropagation()
        this._waypointDragLink = link
        this._waypointDragIndex = index
    }

    onWaypointRightClick (ev: MouseEvent, link: TopologyLink, index: number): void {
        ev.preventDefault()
        ev.stopPropagation()
        this.ctxWaypointLinkId = link.id
        this._ctxWaypointIndex = index
        const pos = this._ctxPos(ev, 160, 80)
        this.ctxLinkX = pos.x
        this.ctxLinkY = pos.y
        this.cdr.markForCheck()
    }

    deleteWaypoint (): void {
        if (!this.ctxWaypointLinkId) { return }
        const link = this.topology.links.find(l => l.id === this.ctxWaypointLinkId)
        if (!link) { return }
        const wp = [...(link.waypoints ?? [])]
        wp.splice(this._ctxWaypointIndex, 1)
        this.svc.updateLinkConfig(this.ctxWaypointLinkId, { waypoints: wp } as any)
        this.ctxWaypointLinkId = null
        this.statusMsg = 'Waypoint deleted'
        this.cdr.markForCheck()
    }

    // ── Link copy-paste ─────────────────────────────────────────────────────

    private _linkClipboard: TopologyLink | null = null

    copyLink (): void {
        if (!this.selectedLinkIds.size) { return }
        const linkId = [...this.selectedLinkIds][0]
        const link = this.topology.links.find(l => l.id === linkId)
        if (link) {
            this._linkClipboard = { ...link }
            this.statusMsg = 'Link copied'
            this.cdr.markForCheck()
        }
    }

    pasteLink (): void {
        if (!this._linkClipboard) { return }
        const src = this._linkClipboard
        // Duplicate the link with a new id, offset anchors slightly so it's visible
        const newLink = this.svc.addShapeLink({
            sourceAnnotationId: src.sourceAnnotationId,
            sourceNodeId: src.sourceNodeId || undefined,
            sourcePortId: src.sourcePortId || undefined,
            sourceAnchorX: src.sourceAnchorX != null ? Math.min(1, src.sourceAnchorX + 0.05) : undefined,
            sourceAnchorY: src.sourceAnchorY,
            targetAnnotationId: src.targetAnnotationId,
            targetNodeId: src.targetNodeId || undefined,
            targetPortId: src.targetPortId || undefined,
            targetAnchorX: src.targetAnchorX != null ? Math.min(1, src.targetAnchorX + 0.05) : undefined,
            targetAnchorY: src.targetAnchorY,
        })
        if (newLink) {
            // Copy style properties to the new link
            this.svc.updateLinkConfig(newLink.id, {
                linkColor: src.linkColor,
                linkDash: src.linkDash,
                linkWidth: src.linkWidth,
                showArrow: src.showArrow,
                arrowStart: src.arrowStart,
                routing: src.routing,
                sketched: src.sketched,
                waypoints: src.waypoints ? [...src.waypoints] : undefined,
                labels: src.labels?.map(l => ({ ...l, id: this._uid() })),
            } as any)
            this.selectedLinkIds = new Set([newLink.id])
            this._syncPrimarySelection()
            this.statusMsg = 'Link duplicated'
        }
        this.cdr.markForCheck()
    }

    // ── Auto-layout ────────────────────────────────────────────────────────────

    autoLayout (algorithm?: LayoutAlgorithm): void {
        if (!this.topology.nodes.length) { return }
        const algo = algorithm ?? this.layoutAlgorithm
        let result
        switch (algo) {
            case 'hierarchical': result = hierarchicalLayout(this.topology); break
            case 'radial':       result = radialLayout(this.topology); break
            case 'grid':         result = gridLayout(this.topology); break
            default:             result = forceDirectedLayout(this.topology); break
        }
        this.svc.batchMoveNodes(result.positions)
        this.statusMsg = `${algo} layout applied — ${result.positions.length} nodes arranged`
        this.cdr.markForCheck()
    }

    // ── Syslog panel ────────────────────────────────────────────────────────

    async toggleSyslogPanel (): Promise<void> {
        this.showSyslogPanel = !this.showSyslogPanel
        if (this.showSyslogPanel) {
            // Resolve local IP for vendor config hints
            await this._refreshSyslogStatus()
        }
        this.cdr.markForCheck()
    }

    async startSyslogServer (): Promise<void> {
        await this._startSyslogListener()
        this.cdr.markForCheck()
    }

    private async _refreshSyslogStatus (): Promise<void> {
        const api = window.netopsAPI as any
        if (!api?.syslogStatus) { return }
        try {
            const status = await api.syslogStatus()
            this.syslogRunning = !!status?.running
            if (status?.localIp) { this.syslogTargetIp = status.localIp }
        } catch (err) { console.warn('Syslog check failed:', (err as Error).message) }
        this.cdr.markForCheck()
    }

    private async _startSyslogListener (): Promise<void> {
        const api = window.netopsAPI as any
        if (!api?.syslogStart || !api?.onSyslogMessage) { return }

        // Check status first
        const status = await api.syslogStatus?.()
        if (status?.localIp) { this.syslogTargetIp = status.localIp }
        if (!status?.running) {
            const result = await api.syslogStart(1514)
            this.syslogRunning = result.ok
        } else {
            this.syslogRunning = true
        }

        // Subscribe to push messages
        if (!this._syslogListenerActive) {
            api.onSyslogMessage((msg: any) => {
                this.syslogMessages.unshift(msg)
                // Cap at 500 messages
                if (this.syslogMessages.length > 500) {
                    this.syslogMessages.length = 500
                }
                this.cdr.markForCheck()
            })
            this._syslogListenerActive = true
        }
        this.cdr.markForCheck()
    }

    async stopSyslogServer (): Promise<void> {
        const api = window.netopsAPI as any
        if (!api?.syslogStop) { return }
        await api.syslogStop()
        this.syslogRunning = false
        this.cdr.markForCheck()
    }

    clearSyslogMessages (): void {
        this.syslogMessages = []
        this.cdr.markForCheck()
    }

    get filteredSyslogMessages () {
        if (this.syslogSeverityFilter === 'all') { return this.syslogMessages }
        return this.syslogMessages.filter(m => m.severity === this.syslogSeverityFilter)
    }

    syslogSeverityClass (severity: string): string {
        switch (severity) {
            case 'emergency': case 'alert': case 'critical': return 'sev-crit'
            case 'error': return 'sev-error'
            case 'warning': return 'sev-warn'
            case 'notice': case 'informational': return 'sev-info'
            default: return 'sev-debug'
        }
    }

    // ── IPAM panel ───────────────────────────────────────────────────────────

    toggleIpam (): void { this.showIpam = !this.showIpam; this.cdr.markForCheck() }

    get ipamEntries (): { nodeLabel: string; portLabel: string; ip: string; cidr: string }[] {
        const entries: { nodeLabel: string; portLabel: string; ip: string; cidr: string; ipInt: number }[] = []
        for (const node of this.topology?.nodes ?? []) {
            for (const port of node.ports) {
                if (!port.ipAddress?.trim()) { continue }
                const parts = port.ipAddress.trim().split('/')
                const ip   = parts[0]
                const cidr = parts[1] ? `/${parts[1]}` : ''
                const octets = ip.split('.').map(Number)
                const ipInt  = octets.length === 4
                    ? ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
                    : 0
                entries.push({ nodeLabel: node.label, portLabel: port.label, ip, cidr, ipInt })
            }
        }
        entries.sort((a, b) => a.ipInt - b.ipInt)
        return entries.map(({ nodeLabel, portLabel, ip, cidr }) => ({ nodeLabel, portLabel, ip, cidr }))
    }

    // ── Annotations ──────────────────────────────────────────────────────────

    onAnnotationMouseDown (ev: MouseEvent, ann: Annotation): void {
        if (ev.button !== 0) { return }
        ev.stopPropagation()
        this._dragAnnotation = ann
        const pt = this.svgPt(ev)
        this._dragAnnOX = pt.x - ann.x
        this._dragAnnOY = pt.y - ann.y
    }

    /** Compute connection anchor points distributed along all 4 edges of a rectangle */
    onAnnotationDblClick (ev: MouseEvent, ann: Annotation): void {
        ev.stopPropagation()
        this.editingAnnotationId = ann.id
        this.editingAnnotationText = ann.text
        this.cdr.markForCheck()
    }

    commitAnnotationEdit (): void {
        if (this.editingAnnotationId) {
            this.svc.updateAnnotation(this.editingAnnotationId, { text: this.editingAnnotationText })
        }
        this.editingAnnotationId = null
        this.cdr.markForCheck()
    }

    deleteAnnotation (id: string): void {
        const ann = (this.topology.annotations ?? []).find(a => a.id === id)
        if (ann?.locked) { this.statusMsg = 'Cannot delete locked shape'; this.cdr.markForCheck(); return }
        this.svc.removeAnnotation(id)
        if (this.selectedShapeId === id) { this.selectedShapeId = null }
        this.selectedShapeIds.delete(id)
        this.cdr.markForCheck()
    }

    // ── Rectangle shapes ─────────────────────────────────────────────────────

    copyShape (): void {
        const shapes: Annotation[] = []
        // Collect from multi-selection first
        for (const id of this.selectedShapeIds) {
            const ann = (this.topology.annotations ?? []).find(a => a.id === id)
            if (ann) { shapes.push({ ...ann }) }
        }
        // If no multi-select, try single selection
        if (!shapes.length && this.selectedShapeId) {
            const shape = this.getSelectedShape()
            if (shape) { shapes.push({ ...shape }) }
        }
        if (!shapes.length) { return }
        this._shapeClipboard = shapes
        this.statusMsg = shapes.length > 1 ? `${shapes.length} shapes copied` : 'Shape copied'
        this.cdr.markForCheck()
    }

    pasteShape (): void {
        if (!this._shapeClipboard.length) { return }
        const newIds: string[] = []
        for (const clipShape of this._shapeClipboard) {
            const newId = this.svc.duplicateAnnotation(clipShape, 20, 20)
            newIds.push(newId)
        }
        // Update clipboard to point at the new positions for chained pastes
        this._shapeClipboard = newIds.map(id =>
            (this.topology.annotations ?? []).find(a => a.id === id)!,
        ).filter(Boolean).map(a => ({ ...a }))
        this.selectedShapeIds = new Set(newIds)
        this.selectedShapeId = newIds.length === 1 ? newIds[0] : null
        this.statusMsg = newIds.length > 1 ? `${newIds.length} shapes pasted` : 'Shape pasted'
        this.cdr.markForCheck()
    }

    private _pendingShapeDrop: string | null = null
    private _pendingTemplateDrop: string | null = null

    onTemplateDragStart (ev: DragEvent, templateId: string): void {
        this._pendingTemplateDrop = templateId
        ev.dataTransfer!.setData('templateId', templateId)
        ev.dataTransfer!.setData('text/plain', templateId)
        ev.dataTransfer!.effectAllowed = 'copy'
    }

    onShapeDragStart (ev: DragEvent, shapeType: string): void {
        this._pendingShapeDrop = shapeType
        ev.dataTransfer!.setData('shapeType', shapeType)
        ev.dataTransfer!.setData('text/plain', shapeType)
        ev.dataTransfer!.effectAllowed = 'copy'
    }

    onShapeMouseEnter (ann: Annotation): void {
        this.hoveredShapeId = ann.id
        this.cdr.markForCheck()
    }

    onShapeMouseLeave (ann: Annotation): void {
        if (this.hoveredShapeId === ann.id) {
            this.hoveredShapeId = null
            this.cdr.markForCheck()
        }
    }

    /** Find the closest point on a rectangle's perimeter to (svgX, svgY).
     *  Returns anchor fractions (0–1) and the absolute SVG position. */
    private _nearestEdgeAnchor (ann: Annotation, svgX: number, svgY: number): { x: number; y: number } {
        const pt = this._closestPerimeterPoint(ann, svgX, svgY)
        const w = ann.width ?? 120, h = ann.height ?? 80
        return {
            x: Math.max(0, Math.min(1, (pt.x - ann.x) / w)),
            y: Math.max(0, Math.min(1, (pt.y - ann.y) / h)),
        }
    }

    /** Closest point on shape perimeter to an arbitrary point (absolute SVG coords).
     *  Dispatches to shape-specific logic. Snaps to key points. */
    private _closestPerimeterPoint (ann: Annotation, px: number, py: number): { x: number; y: number } {
        if (ann.type === 'circle') { return this._closestEllipsePoint(ann, px, py) }
        const verts = this._shapeVertices(ann)
        if (verts) { return this._closestPolygonPoint(verts, px, py) }
        return this._closestRectPoint(ann, px, py)
    }

    /** Get vertices for polygon-based shapes (absolute coords), or null for rect/circle */
    private _shapeVertices (ann: Annotation): { x: number; y: number }[] | null {
        const w = ann.width ?? 120, h = ann.height ?? 80, x = ann.x, y = ann.y
        switch (ann.type) {
            case 'diamond': return this._diamondVertices(ann)
            case 'triangle': return this._triangleVertices(ann)
            case 'star': {
                const cx = x + w / 2, cy = y + h / 2, or = Math.min(w, h) / 2, ir = or * 0.38
                const pts: { x: number; y: number }[] = []
                for (let i = 0; i < 10; i++) {
                    const a = (i * Math.PI / 5) - Math.PI / 2, r = i % 2 === 0 ? or : ir
                    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
                }
                return pts
            }
            case 'hexagon': {
                const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) / 2
                const pts: { x: number; y: number }[] = []
                for (let i = 0; i < 6; i++) {
                    const a = (i * Math.PI / 3) - Math.PI / 6
                    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
                }
                return pts
            }
            case 'parallelogram': {
                const skew = w * 0.2
                return [{ x: x + skew, y }, { x: x + w, y }, { x: x + w - skew, y: y + h }, { x, y: y + h }]
            }
            case 'arrow-right': {
                const aw = w * 0.6, ah = h * 0.3
                return [
                    { x, y: y + ah }, { x: x + aw, y: y + ah }, { x: x + aw, y },
                    { x: x + w, y: y + h / 2 },
                    { x: x + aw, y: y + h }, { x: x + aw, y: y + h - ah }, { x, y: y + h - ah },
                ]
            }
            case 'arrow-double': {
                const ah = h * 0.3, aw = w * 0.25
                return [
                    { x, y: y + h / 2 }, { x: x + aw, y }, { x: x + aw, y: y + ah },
                    { x: x + w - aw, y: y + ah }, { x: x + w - aw, y },
                    { x: x + w, y: y + h / 2 },
                    { x: x + w - aw, y: y + h }, { x: x + w - aw, y: y + h - ah },
                    { x: x + aw, y: y + h - ah }, { x: x + aw, y: y + h },
                ]
            }
            case 'line-h':
                return [
                    { x, y: y + h / 2 },
                    { x: x + w, y: y + h / 2 },
                ]
            default: return null // rect, circle, cylinder, cloud use bounding box
        }
    }

    /** Rectangle perimeter with snap */
    private _closestRectPoint (ann: Annotation, px: number, py: number): { x: number; y: number } {
        const x0 = ann.x, y0 = ann.y
        const w = ann.width ?? 120, h = ann.height ?? 80
        const x1 = x0 + w, y1 = y0 + h

        let cx = Math.max(x0, Math.min(x1, px))
        let cy = Math.max(y0, Math.min(y1, py))

        if (px > x0 && px < x1 && py > y0 && py < y1) {
            const dLeft = cx - x0, dRight = x1 - cx
            const dTop = cy - y0, dBottom = y1 - cy
            const minD = Math.min(dLeft, dRight, dTop, dBottom)
            if (minD === dLeft)       { cx = x0 }
            else if (minD === dRight) { cx = x1 }
            else if (minD === dTop)   { cy = y0 }
            else                      { cy = y1 }
        }

        const snapRadius = 12
        const snapPoints = [
            { x: x0 + w / 2, y: y0 }, { x: x1, y: y0 + h / 2 },
            { x: x0 + w / 2, y: y1 }, { x: x0, y: y0 + h / 2 },
            { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 },
        ]
        let bestDist = snapRadius, snapped = { x: cx, y: cy }
        for (const sp of snapPoints) {
            const d = Math.hypot(cx - sp.x, cy - sp.y)
            if (d < bestDist) { bestDist = d; snapped = sp }
        }
        return snapped
    }

    /** Closest point on ellipse perimeter */
    private _closestEllipsePoint (ann: Annotation, px: number, py: number): { x: number; y: number } {
        const cx = ann.x + (ann.width ?? 120) / 2
        const cy = ann.y + (ann.height ?? 80) / 2
        const rx = (ann.width ?? 120) / 2, ry = (ann.height ?? 80) / 2
        const dx = px - cx, dy = py - cy
        const angle = Math.atan2(dy / ry, dx / rx)
        return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
    }

    /** Closest point on polygon perimeter */
    private _closestPolygonPoint (vertices: { x: number; y: number }[], px: number, py: number): { x: number; y: number } {
        let best = vertices[0], bestDist = Infinity
        for (let i = 0; i < vertices.length; i++) {
            const a = vertices[i], b = vertices[(i + 1) % vertices.length]
            const pt = this._closestPointOnSegment(a, b, px, py)
            const d = Math.hypot(pt.x - px, pt.y - py)
            if (d < bestDist) { bestDist = d; best = pt }
        }
        // Snap to vertices and edge midpoints
        const snapRadius = 12
        const snaps = [...vertices]
        for (let i = 0; i < vertices.length; i++) {
            const a = vertices[i], b = vertices[(i + 1) % vertices.length]
            snaps.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
        }
        for (const sp of snaps) {
            const d = Math.hypot(best.x - sp.x, best.y - sp.y)
            if (d < snapRadius) { best = sp; break }
        }
        return best
    }

    private _closestPointOnSegment (a: { x: number; y: number }, b: { x: number; y: number }, px: number, py: number): { x: number; y: number } {
        const dx = b.x - a.x, dy = b.y - a.y
        const len2 = dx * dx + dy * dy
        if (len2 === 0) { return a }
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2))
        return { x: a.x + t * dx, y: a.y + t * dy }
    }

    private _diamondVertices (ann: Annotation): { x: number; y: number }[] {
        const w = ann.width ?? 120, h = ann.height ?? 80
        return [
            { x: ann.x + w / 2, y: ann.y },
            { x: ann.x + w, y: ann.y + h / 2 },
            { x: ann.x + w / 2, y: ann.y + h },
            { x: ann.x, y: ann.y + h / 2 },
        ]
    }

    private _triangleVertices (ann: Annotation): { x: number; y: number }[] {
        const w = ann.width ?? 120, h = ann.height ?? 80
        return [
            { x: ann.x + w / 2, y: ann.y },
            { x: ann.x + w, y: ann.y + h },
            { x: ann.x, y: ann.y + h },
        ]
    }

    onShapeMouseDown (ev: MouseEvent, ann: Annotation): void {
        if (ev.button !== 0) { return }
        ev.stopPropagation()

        // Link mode: use shape as link endpoint (no port picker needed)
        if (this.linkModeActive || this.pendingLink) {
            this._handleShapeLinkClick(ann)
            return
        }

        const pt = this.svgPt(ev)
        const w = ann.width ?? 120, h = ann.height ?? 80
        const lx = pt.x - ann.x, ly = pt.y - ann.y
        const edgeThreshold = 12  // px from edge to trigger link drag
        // Skip edge-drag for shapes too small (line, thin arrows) — always drag-move instead
        const tooSmall = w < edgeThreshold * 3 || h < edgeThreshold * 3
        const nearEdge = !tooSmall && (lx < edgeThreshold || lx > w - edgeThreshold
                      || ly < edgeThreshold || ly > h - edgeThreshold)

        if (nearEdge && !ann.locked) {
            // Near edge → start drag-to-connect (draw.io style)
            ev.preventDefault()
            const anchor = this._nearestEdgeAnchor(ann, pt.x, pt.y)
            console.log('[shape-drag] START anchor:', anchor, 'click:', pt, 'shape:', ann.x, ann.y, ann.width, ann.height)
            this._shapeDragSourceId = ann.id
            this._shapeDragAnchor = anchor
            this.pendingMouse = { x: pt.x, y: pt.y }
            this.selectedShapeId = ann.id
            this.cdr.markForCheck()
            return
        }

        // Interior click → drag-to-move (with multi-select support)
        if (this._isMultiSelectIntent(ev)) {
            if (this.selectedShapeIds.has(ann.id)) { this.selectedShapeIds.delete(ann.id) }
            else { this.selectedShapeIds.add(ann.id) }
            this.selectedShapeId = this.selectedShapeIds.size === 1 ? [...this.selectedShapeIds][0] : null
            this.statusMsg = this._selectionStatus()
            this.cdr.markForCheck()
            return
        }
        this.selectedShapeId = ann.id
        this.selectedShapeIds = new Set([ann.id])
        this.ctxShapeId = null
        // Locked shapes can be selected but not dragged
        if (!ann.locked) {
            this._dragAnnotation = ann
            this._dragAnnOX = pt.x - ann.x
            this._dragAnnOY = pt.y - ann.y
        }
        this.cdr.markForCheck()
    }

    /** Handle clicking a shape during link creation */
    private _handleShapeLinkClick (ann: Annotation): void {
        if (!this.pendingLink) {
            // Start link from shape
            this.pendingLink = { sourceNodeId: '', sourcePortId: '', sourceAnnotationId: ann.id }
            this.statusMsg = `Drawing link from shape — click a node or another shape`
        } else {
            // Complete link to shape
            const src = this.pendingLink
            if (src.sourceAnnotationId === ann.id) {
                // Same shape — cancel
                this.pendingLink = null
                this.statusMsg = 'Link cancelled (same shape)'
            } else {
                const link = this.svc.addShapeLink({
                    sourceNodeId: src.sourceNodeId || undefined,
                    sourcePortId: src.sourcePortId || undefined,
                    sourceAnnotationId: src.sourceAnnotationId,
                    sourceAnchorX: src.anchorX,
                    sourceAnchorY: src.anchorY,
                    targetAnnotationId: ann.id,
                })
                this.statusMsg = link ? 'Link created' : 'Could not create link'
                this.pendingLink = null
            }
        }
        this.cdr.markForCheck()
    }

    // ── Edge zone: continuous drag-to-connect from any edge point ──────

    _edgeHoverAnnId: string | null = null
    _edgeHoverPos: { x: number; y: number } | null = null

    /** Mousedown on edge zone — start drag-to-connect from the nearest edge point */
    onEdgeZoneMouseDown (ev: MouseEvent, ann: Annotation): void {
        ev.preventDefault()
        ev.stopPropagation()
        const pt = this.svgPt(ev)
        const anchor = this._nearestEdgeAnchor(ann, pt.x, pt.y)
        this._shapeDragSourceId = ann.id
        this._shapeDragAnchor = anchor
        this.pendingMouse = { x: pt.x, y: pt.y }
        this.selectedShapeId = ann.id
        this._edgeHoverAnnId = null
        this._edgeHoverPos = null
        this.cdr.markForCheck()
    }

    /** Mousemove on edge zone — update follower dot at nearest perimeter point */
    onEdgeZoneMouseMove (ev: MouseEvent, ann: Annotation): void {
        const pt = this.svgPt(ev)
        const edge = this._closestPerimeterPoint(ann, pt.x, pt.y)
        this._edgeHoverAnnId = ann.id
        this._edgeHoverPos = edge
        this.cdr.markForCheck()
    }

    clearEdgeHover (): void {
        this._edgeHoverAnnId = null
        this._edgeHoverPos = null
        this.cdr.markForCheck()
    }

    onShapeDblClick (ev: MouseEvent, ann: Annotation): void {
        ev.stopPropagation()
        this.editingShapeId = ann.id
        this.editingShapeLabel = ann.label || ann.text || ''
        this.cdr.markForCheck()
    }

    onShapeRightClick (ev: MouseEvent, ann: Annotation): void {
        ev.preventDefault()
        ev.stopPropagation()
        this.selectedShapeId = ann.id
        this.ctxShapeId = ann.id
        const pos = this._ctxPos(ev, 180, 250)
        this.ctxShapeX = pos.x
        this.ctxShapeY = pos.y
        this.cdr.markForCheck()
    }

    ctxShapeStartLink (shapeId: string): void {
        this.ctxShapeId = null
        this.pendingLink = { sourceNodeId: '', sourcePortId: '', sourceAnnotationId: shapeId }
        this.statusMsg = 'Drawing link from shape — click a node or another shape'
        this.cdr.markForCheck()
    }

    commitShapeLabelEdit (): void {
        if (this.editingShapeId) {
            this.svc.updateAnnotation(this.editingShapeId, { label: this.editingShapeLabel, text: this.editingShapeLabel })
        }
        this.editingShapeId = null
        this.cdr.markForCheck()
    }

    ctxShapeEditLabel (): void {
        const id = this.ctxShapeId
        this.ctxShapeId = null
        if (!id) { return }
        const ann = (this.topology.annotations ?? []).find(a => a.id === id)
        if (!ann) { return }
        this.editingShapeId = id
        this.editingShapeLabel = ann.label || ann.text || ''
        this.cdr.markForCheck()
    }

    ctxShapeChangeColor (color: string): void {
        if (this.ctxShapeId) {
            this.svc.updateAnnotation(this.ctxShapeId, { strokeColor: color })
        }
        this.ctxShapeId = null
        this.cdr.markForCheck()
    }

    /** Return a label color that contrasts with the shape's fill */
    shapeLabelColor (ann: Annotation): string {
        const fill = ann.fillColor ?? '#0f2744'
        const m = fill.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
        if (m) {
            const r = +m[1], g = +m[2], b = +m[3]
            // Perceived brightness (ITU-R BT.709)
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            return lum > 160 ? '#1e293b' : '#f1f5f9'
        }
        return '#f1f5f9'
    }

    // ── Shape color presets ─────────────────────────────────────────────────

    readonly SHAPE_PRESETS: Array<{ fill: string; stroke: string; label: string }> = [
        // Row 1 — solid fills
        { fill: 'rgba(255,255,255,1)',    stroke: '#1e293b', label: 'White' },
        { fill: 'rgba(30,41,59,1)',       stroke: '#475569', label: 'Dark Slate' },
        { fill: 'rgba(132,204,22,1)',     stroke: '#65a30d', label: 'Lime Solid' },
        { fill: 'rgba(34,197,94,1)',      stroke: '#16a34a', label: 'Green Solid' },
        { fill: 'rgba(6,182,212,1)',      stroke: '#0891b2', label: 'Cyan Solid' },
        { fill: 'rgba(59,130,246,1)',     stroke: '#2563eb', label: 'Blue Solid' },
        { fill: 'rgba(168,85,247,1)',     stroke: '#7c3aed', label: 'Purple Solid' },
        { fill: 'rgba(239,68,68,1)',      stroke: '#dc2626', label: 'Red Solid' },
        // Row 2 — more solids
        { fill: 'rgba(249,115,22,1)',     stroke: '#ea580c', label: 'Orange Solid' },
        { fill: 'rgba(234,179,8,1)',      stroke: '#ca8a04', label: 'Yellow Solid' },
        { fill: 'rgba(236,72,153,1)',     stroke: '#db2777', label: 'Pink Solid' },
        { fill: 'rgba(139,92,246,1)',     stroke: '#7c3aed', label: 'Violet Solid' },
        { fill: 'rgba(20,184,166,1)',     stroke: '#0d9488', label: 'Teal Solid' },
        { fill: 'rgba(99,102,241,1)',     stroke: '#4f46e5', label: 'Indigo Solid' },
        { fill: 'rgba(156,163,175,1)',    stroke: '#6b7280', label: 'Gray Solid' },
        { fill: 'rgba(15,39,68,1)',       stroke: '#3b82f6', label: 'Navy (Default)' },
        // Row 3 — transparent fills
        { fill: 'rgba(132,204,22,0.4)',   stroke: '#65a30d', label: 'Lime' },
        { fill: 'rgba(34,197,94,0.4)',    stroke: '#16a34a', label: 'Green' },
        { fill: 'rgba(6,182,212,0.4)',    stroke: '#0891b2', label: 'Cyan' },
        { fill: 'rgba(59,130,246,0.4)',   stroke: '#2563eb', label: 'Blue' },
        { fill: 'rgba(168,85,247,0.4)',   stroke: '#7c3aed', label: 'Purple' },
        { fill: 'rgba(239,68,68,0.4)',    stroke: '#dc2626', label: 'Red' },
        { fill: 'rgba(249,115,22,0.4)',   stroke: '#ea580c', label: 'Orange' },
        { fill: 'rgba(234,179,8,0.4)',    stroke: '#ca8a04', label: 'Yellow' },
    ]

    applyShapePreset (preset: { fill: string; stroke: string }): void {
        if (!this.selectedShapeId) { return }
        // Extract opacity from the preset fill rgba and sync the opacity property
        const m = preset.fill.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/)
        const opacity = m ? parseFloat(m[1]) : 1
        this.svc.updateAnnotation(this.selectedShapeId, { fillColor: preset.fill, strokeColor: preset.stroke, opacity })
        this.cdr.markForCheck()
    }

    // ── Shape properties panel helpers ──────────────────────────────────────

    getSelectedShape (): Annotation | null {
        if (!this.selectedShapeId) { return null }
        return (this.topology.annotations ?? []).find(a => a.id === this.selectedShapeId) ?? null
    }

    /** Convert rgba fill to hex for <input type="color"> */
    shapeFillHex (): string {
        const shape = this.getSelectedShape()
        const fill = shape?.fillColor ?? '#0f2744'
        // Try to parse rgba/rgb
        const m = fill.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
        if (m) {
            const hex = (n: number) => n.toString(16).padStart(2, '0')
            return `#${hex(+m[1])}${hex(+m[2])}${hex(+m[3])}`
        }
        return fill.startsWith('#') ? fill : '#1e3a5f'
    }

    onShapePropChange (prop: string, ev: Event): void {
        if (!this.selectedShapeId) { return }
        const val = (ev.target as HTMLInputElement).value
        const changes: Partial<Annotation> = {}
        switch (prop) {
            case 'label':
                changes.label = val; changes.text = val; break
            case 'fillColor': {
                // Store hex directly — opacity is handled by the separate opacity property
                changes.fillColor = val
                break
            }
            case 'strokeColor':
                changes.strokeColor = val; break
            case 'strokeWidth':
                changes.strokeWidth = Math.max(0, Math.min(10, +val)); break
            case 'opacity': {
                changes.opacity = Math.max(0.1, Math.min(1, +val))
                break
            }
            case 'cornerRadius':
                changes.cornerRadius = Math.max(0, Math.min(40, +val)); break
            case 'rotation':
                changes.rotation = ((+val % 360) + 360) % 360; break
        }
        this.svc.updateAnnotation(this.selectedShapeId, changes)
        this.cdr.markForCheck()
    }

    // ── Shape resize ─────────────────────────────────────────────────────────

    onShapeResizeStart (ev: MouseEvent, ann: Annotation, handle: string): void {
        ev.stopPropagation()
        ev.preventDefault()
        if (ann.locked) { return }
        this._resizingShape = ann
        this._resizeHandle = handle
        const pt = this.svgPt(ev)
        this._resizeOriginX = pt.x
        this._resizeOriginY = pt.y
        this._resizeOrigRect = { x: ann.x, y: ann.y, w: ann.width, h: ann.height }
    }

    /** Called from onMouseMove host listener */
    /** Transform a global SVG point into unrotated shape-local delta */
    private _unrotatePoint (pt: { x: number; y: number }, ann: Annotation, origin: { x: number; y: number }): { dx: number; dy: number } {
        const rot = ann.rotation ?? 0
        if (!rot) { return { dx: pt.x - origin.x, dy: pt.y - origin.y } }
        const cx = ann.x + (ann.width ?? 120) / 2
        const cy = ann.y + (ann.height ?? 80) / 2
        const rad = -rot * Math.PI / 180
        // Rotate both points around shape center, then compute delta
        const cos = Math.cos(rad), sin = Math.sin(rad)
        const rpx = cos * (pt.x - cx) - sin * (pt.y - cy) + cx
        const rpy = sin * (pt.x - cx) + cos * (pt.y - cy) + cy
        const rox = cos * (origin.x - cx) - sin * (origin.y - cy) + cx
        const roy = sin * (origin.x - cx) + cos * (origin.y - cy) + cy
        return { dx: rpx - rox, dy: rpy - roy }
    }

    private _handleShapeResize (ev: MouseEvent): boolean {
        if (!this._resizingShape) { return false }
        const pt = this.svgPt(ev)
        const { dx, dy } = this._unrotatePoint(pt, this._resizingShape, { x: this._resizeOriginX, y: this._resizeOriginY })
        const o = this._resizeOrigRect
        const h = this._resizeHandle
        const MIN = 40

        let nx = o.x, ny = o.y, nw = o.w, nh = o.h

        // Horizontal
        if (h.includes('e')) { nw = Math.max(MIN, o.w + dx) }
        if (h.includes('w')) { nw = Math.max(MIN, o.w - dx); nx = o.x + (o.w - nw) }
        // Vertical
        if (h.includes('s')) { nh = Math.max(MIN, o.h + dy) }
        if (h.includes('n')) { nh = Math.max(MIN, o.h - dy); ny = o.y + (o.h - nh) }

        this.svc.updateAnnotation(this._resizingShape.id, { x: nx, y: ny, width: nw, height: nh })
        return true
    }

    /** Called from onMouseUp host listener */
    private _handleShapeResizeEnd (): void {
        this._resizingShape = null
    }

    // ── Node resize ──────────────────────────────────────────────────────────

    onNodeResizeStart (ev: MouseEvent, node: TopologyNode, handle: string): void {
        ev.stopPropagation()
        ev.preventDefault()
        this._resizingNodeId = node.id
        this._nodeResizeHandle = handle
        const pt = this.svgPt(ev)
        this._nodeResizeOriginX = pt.x
        this._nodeResizeOriginY = pt.y
        this._nodeResizeOrigRect = { x: node.x, y: node.y, w: this.nodeW(node), h: this.nodeH(node) }
    }

    private _handleNodeResize (ev: MouseEvent): boolean {
        if (!this._resizingNodeId) { return false }
        const pt = this.svgPt(ev)
        const dx = pt.x - this._nodeResizeOriginX
        const dy = pt.y - this._nodeResizeOriginY
        const o = this._nodeResizeOrigRect
        const h = this._nodeResizeHandle
        const MIN = 40
        const MAX = 200

        // Uniform resize: use the larger delta
        const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy
        let newSize: number

        if (h === 'se') { newSize = Math.min(MAX, Math.max(MIN, o.w + delta)) }
        else if (h === 'sw') { newSize = Math.min(MAX, Math.max(MIN, o.w - dx)) }
        else if (h === 'ne') { newSize = Math.min(MAX, Math.max(MIN, o.w + dx)) }
        else if (h === 'nw') { newSize = Math.min(MAX, Math.max(MIN, o.w - delta)) }
        else { newSize = o.w }

        let nx = o.x, ny = o.y
        if (h.includes('w')) { nx = o.x + (o.w - newSize) }
        if (h.includes('n')) { ny = o.y + (o.h - newSize) }

        this.svc.resizeNodeSilent(this._resizingNodeId!, nx, ny, newSize, newSize)
        return true
    }

    private _handleNodeResizeEnd (): void {
        if (this._resizingNodeId) {
            const node = this.topology.nodes.find(n => n.id === this._resizingNodeId)
            if (node) {
                this.svc.updateNodeConfig(this._resizingNodeId, { width: node.width, height: node.height })
            }
        }
        this._resizingNodeId = null
    }

    // ── Additional exports ───────────────────────────────────────────────────

    private _csvEscape (s: string): string {
        return '"' + s.replace(/"/g, '""') + '"'
    }

    exportIpMatrix (): void {
        const rows: string[] = ['Node,Port,IP Address,CIDR,Connected To']
        const esc = (s: string) => this._csvEscape(s)
        for (const node of this.topology.nodes) {
            // Include the node management IP as a "mgmt" row
            if (node.mgmtIp?.trim()) {
                const parts = node.mgmtIp.trim().split('/')
                rows.push(`${esc(node.label)},"mgmt",${esc(parts[0])},${esc(parts[1] ? '/' + parts[1] : '')},""`)
            }
            // Include loopback IP as a separate row
            if (node.loopbackIp?.trim()) {
                const parts = node.loopbackIp.trim().split('/')
                rows.push(`${esc(node.label)},"loopback",${esc(parts[0])},${esc(parts[1] ? '/' + parts[1] : '')},""`)
            }
            // Include loopback IPv6 as a separate row
            if (node.loopbackIpv6?.trim()) {
                const parts = node.loopbackIpv6.trim().split('/')
                rows.push(`${esc(node.label)},"loopback-v6",${esc(parts[0])},${esc(parts[1] ? '/' + parts[1] : '')},""`)
            }
            // Include ALL ports — those without IPs get empty IP/CIDR cells
            // so the CSV doubles as a template for import
            for (const port of node.ports) {
                const link = this.topology.links.find(l =>
                    (l.sourceNodeId === node.id && l.sourcePortId === port.id) ||
                    (l.targetNodeId === node.id && l.targetPortId === port.id),
                )
                let connectedTo = ''
                if (link) {
                    const otherId = link.sourceNodeId === node.id ? link.targetNodeId : link.sourceNodeId
                    const otherNode = this.topology.nodes.find(n => n.id === otherId)
                    connectedTo = otherNode?.label ?? ''
                }
                const ipRaw = port.ipAddress?.trim() ?? ''
                const parts = ipRaw ? ipRaw.split('/') : ['', '']
                const ip   = parts[0]
                const cidr = parts[1] ? `/${parts[1]}` : ''
                rows.push(`${esc(node.label)},${esc(port.label)},${esc(ip)},${esc(cidr)},${esc(connectedTo)}`)
                // Also export port IPv6 address as a separate row
                if (port.ipv6Address?.trim()) {
                    const v6Parts = port.ipv6Address.trim().split('/')
                    rows.push(`${esc(node.label)},${esc(port.label + ' (v6)')},${esc(v6Parts[0])},${esc(v6Parts[1] ? '/' + v6Parts[1] : '')},${esc(connectedTo)}`)
                }
            }
        }
        this._downloadText(rows.join('\n'), `${this.topology.name.replace(/\s+/g, '_')}_ip_matrix.csv`, 'text/csv')
        this.statusMsg = `Exported IP matrix (${rows.length - 1} entries)`
        this.cdr.markForCheck()
    }

    // ── IP Matrix CSV Import ────────────────────────────────────────────────

    openIpMatrixImport (): void {
        const el = document.getElementById('ipMatrixFileInput') as HTMLInputElement
        if (el) { el.click() }
    }

    onIpMatrixFileInput (ev: Event): void {
        const file = (ev.target as HTMLInputElement).files?.[0]
        if (!file) { return }

        const reader = new FileReader()
        reader.onload = () => {
            const result = this._applyIpMatrixCsv(reader.result as string)
            this.statusMsg = result
            this.cdr.markForCheck()
        }
        reader.readAsText(file)
        ;(ev.target as HTMLInputElement).value = ''
    }

    private _applyIpMatrixCsv (raw: string): string {
        const text = raw.replace(/^\uFEFF/, '')   // strip BOM
        const rows = this._parseCsvRows(text)
        if (rows.length < 2) { return 'IP matrix CSV is empty or has no data rows' }

        // Normalise headers
        const headers = rows[0].map(h => h.trim().toLowerCase().replace(/[\s_-]+/g, ''))
        const iNode  = headers.findIndex(h => ['node', 'nodename', 'device', 'hostname', 'name'].includes(h))
        const iPort  = headers.findIndex(h => ['port', 'portname', 'interface', 'intf'].includes(h))
        const iIp    = headers.findIndex(h => ['ipaddress', 'ip', 'address'].includes(h))
        const iCidr  = headers.findIndex(h => ['cidr', 'prefix', 'prefixlength', 'mask', 'subnet'].includes(h))

        if (iNode < 0 || iPort < 0 || iIp < 0) {
            return 'CSV must have at minimum Node, Port, and IP Address columns'
        }

        let assigned = 0
        let mgmtAssigned = 0
        let skipped = 0
        let notFound = 0

        for (const row of rows.slice(1)) {
            const nodeName = (row[iNode] ?? '').trim()
            const portName = (row[iPort] ?? '').trim()
            const ipVal    = (row[iIp]   ?? '').trim()
            if (!nodeName || !portName) { skipped++; continue }

            // Find the matching topology node (case-insensitive)
            const node = this.topology.nodes.find(
                n => n.label.toLowerCase() === nodeName.toLowerCase(),
            )
            if (!node) { notFound++; continue }

            // Build the full IP/CIDR value
            let cidr = iCidr >= 0 ? (row[iCidr] ?? '').trim() : ''
            if (cidr && !cidr.startsWith('/')) { cidr = '/' + cidr }
            const fullIp = ipVal ? (ipVal + cidr) : ''

            // Handle "mgmt" as special port for management IP
            if (portName.toLowerCase() === 'mgmt' || portName.toLowerCase() === 'management') {
                if (fullIp) {
                    this.svc.updateNodeConfig(node.id, { mgmtIp: fullIp })
                    mgmtAssigned++
                }
                continue
            }

            // Find the matching port (case-insensitive)
            const port = node.ports.find(
                p => p.label.toLowerCase() === portName.toLowerCase(),
            )
            if (!port) { notFound++; continue }

            // Update the port IP
            this.svc.updatePort(node.id, port.id, { ipAddress: fullIp || undefined })
            assigned++
        }

        const parts: string[] = []
        if (assigned > 0)      { parts.push(`${assigned} port IP(s) assigned`) }
        if (mgmtAssigned > 0)  { parts.push(`${mgmtAssigned} mgmt IP(s) assigned`) }
        if (notFound > 0)      { parts.push(`${notFound} not matched`) }
        if (skipped > 0)       { parts.push(`${skipped} skipped (empty)`) }
        return parts.length > 0 ? `IP matrix import: ${parts.join(', ')}` : 'No changes applied'
    }

    exportAllConfigs (): void {
        const vendorNodes = this.topology.nodes.filter(n => n.startupConfig?.trim())
        if (!vendorNodes.length) {
            this.statusMsg = 'No startup configs found — select a vendor on nodes first'
            this.cdr.markForCheck()
            return
        }

        const divider = '!' + '='.repeat(70)
        const sections: string[] = [
            divider,
            `! Topology : ${this.topology.name}`,
            `! Nodes    : ${this.topology.nodes.length}   Links: ${this.topology.links.length}`,
            `! Configs  : ${vendorNodes.length} node(s) with startup config`,
            `! Generated: ${new Date().toISOString()}`,
            divider,
            '',
        ]

        for (const node of vendorNodes) {
            sections.push(`! --- ${node.label} (${node.model || node.vendor || node.type}) ---`)
            sections.push('')
            sections.push(node.startupConfig!.trim())
            sections.push('')
        }

        this._downloadText(
            sections.join('\n'),
            `${this.topology.name.replace(/\s+/g, '_')}_configs.txt`,
            'text/plain',
        )
        this.statusMsg = `Exported startup configs for ${vendorNodes.length} node(s)`
        this.cdr.markForCheck()
    }

    get hasConfigs (): boolean {
        return this.topology?.nodes.some(n => !!n.startupConfig?.trim()) ?? false
    }

    // ── Firmware Upgrade Planner ───────────────────────────────────────

    // ── Backend Server Connection ─────────────────────────────────────

    private _backendSvc: any = null  // lazy-loaded BackendClientService

    private _getBackendSvc (): any {
        if (!this._backendSvc) {
            this._backendSvc = new (require('../services/backend-client.service').BackendClientService)()
        }
        return this._backendSvc
    }

    get backendConnected (): boolean {
        return this._backendSvc?.isConnected ?? false
    }

    async connectBackend (): Promise<void> {
        this.backendConnecting = true
        this.cdr.markForCheck()
        const svc = this._getBackendSvc()

        // Load saved URL from prefs
        const api = (window as any).netopsAPI
        const savedUrl = await api?.prefGet?.('backend-url')
        if (savedUrl) { this.backendUrl = savedUrl }

        try {
            svc.connect(this.backendUrl)
            // Save URL for next time
            api?.prefSet?.('backend-url', this.backendUrl)

            // Wait up to 5s for connection
            await new Promise<void>((resolve, reject) => {
                let checks = 0
                const timer = setInterval(() => {
                    if (svc.isConnected) { clearInterval(timer); resolve() }
                    else if (++checks > 50) { clearInterval(timer); reject(new Error('Connection timeout')) }
                }, 100)
            })

            // Wire backend client into inventory service for poll routing
            this.invSvc.setBackendClient(svc)
            this.statusMsg = `Connected to backend server at ${this.backendUrl} — polls will route through server`
        } catch (err) {
            this.statusMsg = `Backend connection failed: ${(err as Error).message}`
        }

        this.backendConnecting = false
        this.cdr.markForCheck()
    }

    disconnectBackend (): void {
        this._getBackendSvc().disconnect()
        this.invSvc.setBackendClient(null)
        this.statusMsg = 'Disconnected from backend server — polls will use local SSH'
        this.cdr.markForCheck()
    }

    async loadBackendUrl (): Promise<void> {
        const api = (window as any).netopsAPI
        const saved = await api?.prefGet?.('backend-url')
        if (saved) { this.backendUrl = saved }
        this.cdr.markForCheck()
    }

    generateUpgradePlan (): void {
        const { FirmwarePlannerService } = require('../services/firmware-planner.service')
        const planner = new FirmwarePlannerService()
        const plan = planner.generateUpgradePlan(this.topology, this.invSvc.store.deviceVersions)
        if (plan.devicesNeedingUpgrade === 0) {
            this.statusMsg = `All ${plan.totalDevices} devices are on current firmware`
            this.cdr.markForCheck(); return
        }
        const md = planner.exportPlanAsMarkdown(plan)
        this._downloadText(md, `${this.topology.name.replace(/\s+/g, '_')}_upgrade_plan.md`, 'text/markdown')
        this.statusMsg = `Upgrade plan: ${plan.devicesNeedingUpgrade}/${plan.totalDevices} need upgrade (${plan.phases.length} phases)`
        this.cdr.markForCheck()
    }

    exportHtmlReport (): void {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        const svg = this.svgRef.nativeElement.outerHTML
        const ipRows = this.ipamEntries.map(e =>
            `<tr><td>${esc(e.nodeLabel)}</td><td>${esc(e.portLabel)}</td><td>${esc(e.ip + e.cidr)}</td></tr>`,
        ).join('\n')
        const safeName = esc(this.topology.name)
        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${safeName} — NetOps Report</title>
  <style>
    body { font-family: system-ui; background: #0d1117; color: #c9d1d9; margin: 0; padding: 20px }
    h1 { color: #3b82f6; margin-bottom: 4px }
    .meta { color: #8b949e; font-size: 12px; margin-bottom: 20px }
    .diagram { background: #0a0f18; border: 1px solid #21262d; border-radius: 8px; padding: 10px; margin-bottom: 20px; overflow: auto }
    svg { max-width: 100%; height: auto }
    table { border-collapse: collapse; width: 100%; font-size: 13px }
    th { background: #161b22; color: #8b949e; text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d }
    td { padding: 6px 12px; border-bottom: 1px solid #21262d; font-family: monospace }
    tr:hover td { background: #161b22 }
  </style>
</head>
<body>
  <h1>${safeName}</h1>
  <div class="meta">Generated ${new Date().toISOString()} · ${this.topology.nodes.length} nodes · ${this.topology.links.length} links</div>
  <div class="diagram">${svg}</div>
  <h2>IP Address Map</h2>
  <table>
    <thead><tr><th>Node</th><th>Port</th><th>IP / CIDR</th></tr></thead>
    <tbody>${ipRows}</tbody>
  </table>
</body>
</html>`
        this._downloadText(html, `${this.topology.name.replace(/\s+/g, '_')}_report.html`, 'text/html')
        this.statusMsg = 'HTML report exported'
        this.cdr.markForCheck()
    }

    exportTopologySvg (): void {
        const svgEl = this.svgRef.nativeElement
        const svgClone = svgEl.cloneNode(true) as SVGSVGElement
        const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style')
        styleEl.textContent = `
          .node-body { fill: #141e2d; stroke: #21262d; }
          .node-shadow { fill: rgba(0,0,0,0.3); }
          .node-label { fill: #c9d1d9; font-size: 11px; font-weight: 600; }
          .node-type-icon { fill: #8b949e; font-size: 22px; }
          .node-type-chip { fill: #6e8099; font-size: 7px; }
          .node-status circle { fill: #22c55e; }
          .link-path { fill: none; stroke: #3a5a8a; stroke-width: 2; }
          .link-label { fill: #5a7a9a; font-size: 9px; }
          .link-ip-label { fill: #4f7ca6; font-size: 8px; }
          text { font-family: 'Segoe UI', system-ui, sans-serif; }
        `
        svgClone.insertBefore(styleEl, svgClone.firstChild)
        const svgData = new XMLSerializer().serializeToString(svgClone)
        const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${this.topology.name.replace(/\s+/g, '_')}_topology.svg`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        this.statusMsg = 'SVG exported'
        this.cdr.markForCheck()
    }

    exportTopologyPng (): void {
        const svgEl = this.svgRef.nativeElement
        const svgClone = svgEl.cloneNode(true) as SVGSVGElement
        // Inline computed styles for external CSS rules
        const computedStyles = getComputedStyle(svgEl)
        const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style')
        styleEl.textContent = `
          .node-body { fill: #141e2d; stroke: #21262d; }
          .node-shadow { fill: rgba(0,0,0,0.3); }
          .node-label { fill: #c9d1d9; font-size: 11px; font-weight: 600; }
          .node-type-icon { fill: #8b949e; font-size: 22px; }
          .node-type-chip { fill: #6e8099; font-size: 7px; }
          .node-status circle { fill: #22c55e; }
          .link-path { fill: none; stroke: #3a5a8a; stroke-width: 2; }
          .link-label { fill: #5a7a9a; font-size: 9px; }
          .link-ip-label { fill: #4f7ca6; font-size: 8px; }
          text { font-family: 'Segoe UI', system-ui, sans-serif; }
        `
        svgClone.insertBefore(styleEl, svgClone.firstChild)

        const svgData = new XMLSerializer().serializeToString(svgClone)
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
        const url = URL.createObjectURL(svgBlob)

        const img = new Image()
        img.onload = () => {
            const canvas = document.createElement('canvas')
            const rect = svgEl.getBoundingClientRect()
            canvas.width = rect.width * 2
            canvas.height = rect.height * 2
            const ctx = canvas.getContext('2d')!
            ctx.scale(2, 2)
            ctx.fillStyle = '#0a0f18'
            ctx.fillRect(0, 0, rect.width, rect.height)
            ctx.drawImage(img, 0, 0, rect.width, rect.height)
            canvas.toBlob((blob) => {
                if (!blob) { return }
                const pngUrl = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = pngUrl
                a.download = `${this.topology.name.replace(/\s+/g, '_')}_topology.png`
                a.click()
                setTimeout(() => { URL.revokeObjectURL(pngUrl); URL.revokeObjectURL(url) }, 1000)
                this.statusMsg = 'PNG exported'
                this.cdr.markForCheck()
            }, 'image/png')
        }
        img.src = url
    }

    // ── Inventory Export ─────────────────────────────────────────────────────

    exportInventoryReport (): void {
        const json = this.invSvc.exportInventoryReport()
        this._downloadText(json, `${this.topology.name.replace(/\s+/g, '_')}_inventory_report.json`, 'application/json')
        this.statusMsg = 'Inventory report exported (JSON)'
        this.cdr.markForCheck()
    }

    exportAlarmHistory (): void {
        const csv = this.invSvc.exportAlarmHistory()
        this._downloadText(csv, `${this.topology.name.replace(/\s+/g, '_')}_alarm_history.csv`, 'text/csv')
        this.statusMsg = 'Alarm history exported (CSV)'
        this.cdr.markForCheck()
    }

    exportTelegrafConfig (): void {
        const config = generateTelemetryPipeline(this.topology.nodes as any)
        if (!config) {
            this.statusMsg = 'No telemetry-enabled nodes found — enable telemetry on nodes first'
            this.cdr.markForCheck()
            return
        }
        this._downloadText(config, `${this.topology.name.replace(/\s+/g, '_')}_telegraf.conf`, 'text/plain')
        this.statusMsg = 'Telegraf config exported — use with telegraf --config telegraf.conf'
        this.cdr.markForCheck()
    }

    // ── Pull & Save Configs from Devices ────────────────────────────────────

    configSyncRunning = false
    operationProgress = ''

    async pullAndSaveConfigs (): Promise<void> {
        const nodes = this.topology.nodes.filter(n => n.vendor)
        if (!nodes.length) {
            this.statusMsg = 'No vendor nodes to pull configs from'
            this.cdr.markForCheck()
            return
        }

        const api = (window as any).netopsAPI

        // Find reachable nodes: containers or SSH
        const reachableNodes: { node: typeof nodes[0]; method: 'container' | 'ssh'; containerName?: string; host?: string; username?: string; password?: string }[] = []

        for (const node of nodes) {
            // Check container first
            const safeName = node.label.replace(/\s+/g, '-').toLowerCase()
            const ctn = this.clabContainers?.find(c => c.name.endsWith('-' + safeName) && c.state === 'running')
            if (ctn) {
                reachableNodes.push({ node, method: 'container', containerName: ctn.name })
                continue
            }
            // Check SSH
            const host = (node.mgmtIp ?? '').split('/')[0]
            if (host && node.sshUsername && node.sshPassword) {
                reachableNodes.push({ node, method: 'ssh', host, username: node.sshUsername, password: node.sshPassword })
                continue
            }
            // Mapped device with mgmtIp
            if (node.mapped && host) {
                reachableNodes.push({ node, method: 'ssh', host })
            }
        }

        if (!reachableNodes.length) {
            this.statusMsg = 'No reachable devices found — deploy containerlab or set SSH credentials'
            this.cdr.markForCheck()
            return
        }

        const confirm = window.confirm(
            `Pull running configs from ${reachableNodes.length} device(s)?\n\n` +
            `• ${reachableNodes.filter(r => r.method === 'container').length} via container\n` +
            `• ${reachableNodes.filter(r => r.method === 'ssh').length} via SSH\n\n` +
            `This will overwrite startup configs in the topology with live running configs.`
        )
        if (!confirm) { return }

        this.configSyncRunning = true
        this.operationProgress = `Pulling configs from ${reachableNodes.length} device${reachableNodes.length === 1 ? '' : 's'}...`
        this.cdr.markForCheck()

        let success = 0
        let failed = 0
        const errors: string[] = []

        // Use vendor command map for correct CLI wrapper (e.g., Juniper cli -c "…")
        const getShowCmd = (vendor: string, model?: string): string => {
            const cmds = getVendorCommands(vendor ?? '', model)
            return cmds.showRunningConfig
        }

        // Resolve SSH credentials up-front (prompt is blocking, must be sequential)
        const resolvedEntries: typeof reachableNodes = []
        for (const entry of reachableNodes) {
            if (entry.method === 'ssh' && !entry.username) {
                const username = prompt(`SSH username for ${entry.node.label} (${entry.host}):`) ?? ''
                if (!username) { failed++; errors.push(`${entry.node.label}: no credentials`); continue }
                const password = prompt(`SSH password for ${entry.node.label}:`) ?? ''
                entry.username = username
                entry.password = password
            }
            resolvedEntries.push(entry)
        }

        // Pull all configs in parallel
        const pullOne = async (entry: typeof reachableNodes[0]): Promise<void> => {
            const { node, method } = entry
            const showCmd = getShowCmd(node.vendor ?? '', node.model ?? '')

            try {
                let pulledConfig = ''

                if (method === 'container' && entry.containerName && api?.clabExecCommand) {
                    const result = await api.clabExecCommand({
                        containerName: entry.containerName,
                        command: showCmd,
                    })
                    if (result.ok) {
                        pulledConfig = result.output ?? ''
                    } else {
                        throw new Error(result.message)
                    }
                } else if (method === 'ssh' && entry.host && api?.sshRunCommand) {
                    let result: any
                    if (this._backendSvc?.isConnected) {
                        result = await this._backendSvc.runCommand(entry.host, node.sshPort ?? 22, entry.username!, entry.password!, showCmd)
                    } else {
                        result = await api.sshRunCommand({
                            host: entry.host,
                            port: node.sshPort ?? 22,
                            username: entry.username!,
                            password: entry.password!,
                            timeoutMs: 30000,
                            command: showCmd,
                        })
                    }
                    if (result.ok) {
                        pulledConfig = result.output ?? ''
                    } else {
                        throw new Error(result.message)
                    }
                }

                if (pulledConfig.trim()) {
                    let cleaned = this._cleanPulledConfig(pulledConfig, node.vendor ?? '')
                    if (!cleaned) {
                        const rawLines = pulledConfig.split('\n')
                        cleaned = rawLines.slice(1, -1).join('\n').trim()
                    }
                    if (cleaned) {
                        this.svc.updateNodeConfig(node.id, { startupConfig: cleaned, configSource: 'pulled' } as any)
                        success++
                    } else {
                        failed++
                        errors.push(`${node.label}: config empty after cleaning`)
                    }
                } else {
                    failed++
                    errors.push(`${node.label}: empty config returned`)
                }
            } catch (err) {
                failed++
                errors.push(`${node.label}: ${(err as Error).message}`)
            }

            this.operationProgress = `Pulling configs... ${success + failed}/${reachableNodes.length} (${success} ✓, ${failed} ✗)`
            this.cdr.detectChanges()
        }

        await Promise.all(resolvedEntries.map(entry => pullOne(entry)))

        // Show final progress before clearing the banner
        this.operationProgress = `Pull complete: ${success} ✓, ${failed} ✗`
        this.cdr.detectChanges()

        // Auto-save topology after pulling
        if (success > 0) {
            this.saveTopology()
        }

        // Small delay so the user can see the final progress, then show result
        await new Promise(r => setTimeout(r, 600))
        this.configSyncRunning = false
        this.operationProgress = ''

        if (failed > 0) {
            const summary = `Config pull: ${success} succeeded, ${failed} failed\n\n` +
                errors.map(e => `  ✗ ${e}`).join('\n')
            this.statusMsg = summary.replace(/\n/g, ' | ')
            this.cdr.detectChanges()
            window.alert(summary)
        } else {
            this.statusMsg = `Config pull complete: ${success} config(s) pulled & saved`
            this.cdr.detectChanges()
            window.alert(`Config pull complete: ${success} config(s) pulled & saved`)
        }
        this.cdr.detectChanges()
    }

    /** Strip SSH banners, prompts, command echoes from pulled config output */
    private _cleanPulledConfig (raw: string, vendor: string): string {
        // Strip ANSI escape codes first (terminal colors, cursor movement, etc.)
        // eslint-disable-next-line no-control-regex
        const ansiStripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')  // OSC sequences
            .replace(/[\x00-\x08\x0e-\x1f]/g, '') // other control chars except \t \n \r
        const lines = ansiStripped.split('\n')
        const v = (vendor ?? '').toLowerCase()
        let cleaned: string[] = []

        if (v === 'juniper') {
            // Juniper: keep only lines starting with "set " or comments (#)
            // Skip: banner, "## Last changed", "{master:0}", prompts, cli -c echo
            let inConfig = false
            for (const line of lines) {
                const trimmed = line.trim()
                if (trimmed.startsWith('set ') || trimmed.startsWith('deactivate ')) {
                    inConfig = true
                    cleaned.push(trimmed)
                } else if (inConfig && trimmed.startsWith('## ')) {
                    // Junos config comments like "## Last changed: ..."
                    cleaned.push(trimmed)
                }
            }
        } else if (v === 'cisco' || v === 'cisco-nxos' || v === 'cisco-iosxr') {
            // Cisco: keep from first line containing "!" or "version" or "hostname"
            let inConfig = false
            for (const line of lines) {
                const trimmed = line.trim()
                if (!inConfig && (trimmed === '!' || trimmed.startsWith('version ') || trimmed.startsWith('hostname '))) {
                    inConfig = true
                }
                if (inConfig) {
                    // Stop at "end" marker
                    if (trimmed === 'end') { cleaned.push(trimmed); break }
                    cleaned.push(line)
                }
            }
        } else if (v === 'arista') {
            // Arista: similar to Cisco
            let inConfig = false
            for (const line of lines) {
                const trimmed = line.trim()
                if (!inConfig && (trimmed === '!' || trimmed.startsWith('hostname '))) {
                    inConfig = true
                }
                if (inConfig) {
                    if (trimmed === 'end') { cleaned.push(trimmed); break }
                    cleaned.push(line)
                }
            }
        } else if (v === 'nokia') {
            // Nokia SR Linux: keep lines that look like config (indented or starting with /)
            for (const line of lines) {
                const trimmed = line.trim()
                // Skip prompts like "A:admin@node#" and empty lines at start
                if (trimmed.startsWith('A:') || trimmed.startsWith('--{') || trimmed === '') { continue }
                cleaned.push(line)
            }
        } else if (v === 'huawei') {
            // Huawei: keep from first "#" section marker
            let inConfig = false
            for (const line of lines) {
                const trimmed = line.trim()
                if (!inConfig && trimmed === '#') { inConfig = true }
                if (inConfig) {
                    if (trimmed === 'return') { cleaned.push(trimmed); break }
                    cleaned.push(line)
                }
            }
        } else {
            // Generic: strip obvious SSH noise
            for (const line of lines) {
                const trimmed = line.trim()
                // Skip common SSH banners and prompts
                if (trimmed.startsWith('Last login:') ||
                    trimmed.startsWith('Warning:') ||
                    trimmed.match(/^[A-Za-z0-9_-]+[>#$]\s*$/) ||
                    trimmed.startsWith('---') ||
                    trimmed === '') { continue }
                cleaned.push(line)
            }
        }

        return cleaned.join('\n').trim()
        this.cdr.markForCheck()
    }

    // ── Push All Configs ─────────────────────────────────────────────────────

    configPushAllRunning = false

    async pushAllConfigs (opts?: { skipConfirm?: boolean }): Promise<void> {
        const nodes = this.topology.nodes.filter(n => n.startupConfig?.trim() && n.vendor)
        if (!nodes.length) {
            this.statusMsg = 'No configs to push'
            this.cdr.markForCheck()
            return
        }

        const containerNodes = nodes.filter(n => {
            const safeName = n.label.replace(/\s+/g, '-').toLowerCase()
            return this.clabContainers?.some(c => c.name.endsWith('-' + safeName) && c.state === 'running')
        })

        // SSH nodes: check both direct credentials AND mapped device credentials
        const sshNodes = nodes.filter(n => {
            // Skip nodes already handled via container
            const safeName = n.label.replace(/\s+/g, '-').toLowerCase()
            if (this.clabContainers?.some(c => c.name.endsWith('-' + safeName) && c.state === 'running')) { return false }
            const host = (n.mgmtIp ?? '').split('/')[0]
            // Direct credentials on the node
            if (host && n.sshUsername && n.sshPassword) { return true }
            // Mapped device: check if node has mapped=true and has management IP + global/inventory credentials
            if (n.mapped && host) { return true }
            return false
        })

        const pushableCount = containerNodes.length + sshNodes.length
        if (!pushableCount) {
            this.statusMsg = `${nodes.length} nodes have configs but none are reachable. Options: deploy containerlab, set management IPs, or configure SSH credentials on nodes.`
            this.cdr.markForCheck()
            return
        }

        if (!opts?.skipConfirm) {
            const confirmed = window.confirm(
                `Push configs to ${pushableCount} node(s)?\n\n` +
                `• ${containerNodes.length} via container (docker exec)\n` +
                `• ${sshNodes.length} via SSH\n\n` +
                `This will apply startup configs to running devices.`
            )
            if (!confirmed) { return }
        }

        this.configPushAllRunning = true
        this.operationProgress = `Pushing configs to ${pushableCount} device${pushableCount === 1 ? '' : 's'}...`
        this.cdr.markForCheck()

        const api = (window as any).netopsAPI
        let success = 0
        let failed = 0
        const errors: string[] = []

        // Resolve SSH credentials up-front (prompt is blocking, must be sequential)
        const sshReady: { node: typeof sshNodes[0]; host: string; username: string; password: string }[] = []
        for (const node of sshNodes) {
            const host = (node.mgmtIp ?? '').split('/')[0]
            if (!host || !api?.sshShellSession) { continue }

            let username = node.sshUsername ?? ''
            let password = node.sshPassword ?? ''
            if (!username && node.mapped) {
                username = prompt(`SSH username for ${node.label} (${host}):`) ?? ''
                if (!username) { failed++; errors.push(`${node.label}: SSH username not provided`); continue }
                password = prompt(`SSH password for ${node.label}:`) ?? ''
                if (!password) { failed++; errors.push(`${node.label}: SSH password not provided`); continue }
            }
            if (!username) { failed++; errors.push(`${node.label}: no SSH credentials`); continue }
            sshReady.push({ node, host, username, password })
        }

        const updateProgress = (): void => {
            this.operationProgress = `Pushing configs... ${success + failed}/${pushableCount} (${success} ✓, ${failed} ✗)`
            this.cdr.detectChanges()
        }

        // Push to container node
        const pushContainer = async (node: typeof containerNodes[0]): Promise<void> => {
            const safeName = node.label.replace(/\s+/g, '-').toLowerCase()
            const ctn = this.clabContainers?.find(c => c.name.endsWith('-' + safeName) && c.state === 'running')
            if (!ctn || !api?.clabPushConfig) { return }

            try {
                const configLines = node.startupConfig!.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0)
                const result = await api.clabPushConfig({
                    containerName: ctn.name,
                    kind: ctn.kind,
                    configLines,
                })
                if (result.ok) { success++ }
                else { failed++; errors.push(`${node.label}: ${result.message}`) }
            } catch (err) {
                failed++
                errors.push(`${node.label}: ${(err as Error).message}`)
            }
            updateProgress()
        }

        // Push to SSH node
        const pushSsh = async (entry: typeof sshReady[0]): Promise<void> => {
            const { node, host, username, password } = entry
            try {
                const vendorKey = (node.vendor ?? '').trim().toLowerCase()
                const cmds = getVendorCommands(vendorKey, node.model ?? '')
                const preamble = cmds.loadConfigPreamble ?? ['configure terminal']
                const postamble = cmds.loadConfigPostamble ?? ['end', 'write memory']

                const configLines = node.startupConfig!.split('\n')
                    .map(l => l.trimEnd())
                    .filter(l => l.length > 0)
                    .filter(l => !/^Building configuration/i.test(l))
                    .filter(l => !/^Current configuration\s*:/i.test(l))
                    .filter(l => !/^Last configuration change/i.test(l))

                const commands = [...preamble, ...configLines, ...postamble]
                let result: any
                if (this._backendSvc?.isConnected) {
                    result = await this._backendSvc.loadConfig(host, node.sshPort ?? 22, username, password, commands, 300)
                } else {
                    result = await api.sshShellSession({
                        host,
                        port: node.sshPort ?? 22,
                        username,
                        password,
                        timeoutMs: 60000,
                        commands,
                        delayMs: 300,
                    })
                }
                if (result.ok) { success++ }
                else { failed++; errors.push(`${node.label}: ${result.message}`) }
            } catch (err) {
                failed++
                errors.push(`${node.label}: ${(err as Error).message}`)
            }
            updateProgress()
        }

        // Run all pushes in parallel
        await Promise.all([
            ...containerNodes.map(n => pushContainer(n)),
            ...sshReady.map(e => pushSsh(e)),
        ])

        // Show final progress before clearing the banner
        this.operationProgress = `Push complete: ${success} ✓, ${failed} ✗`
        this.cdr.detectChanges()

        // Small delay so the user can see the final progress
        await new Promise(r => setTimeout(r, 600))
        this.configPushAllRunning = false
        this.operationProgress = ''

        if (failed > 0) {
            const summary = `Config push: ${success} succeeded, ${failed} failed\n\n` +
                errors.map(e => `  ✗ ${e}`).join('\n')
            this.statusMsg = summary.replace(/\n/g, ' | ')
            this.cdr.detectChanges()
            window.alert(summary)
        } else {
            this.statusMsg = `Config push complete: ${success} config(s) pushed successfully`
            this.cdr.detectChanges()
            window.alert(`Config push complete: ${success} config(s) pushed successfully`)
        }
        this.cdr.detectChanges()
    }

    // ── Topology description ─────────────────────────────────────────────────

    startEditDescription (): void {
        this.editingDescription = true
        this.editingDescriptionText = this.topology.description ?? ''
        this.cdr.markForCheck()
    }

    commitDescription (): void {
        if (this.editingDescription) {
            this.svc.updateDescription(this.editingDescriptionText)
        }
        this.editingDescription = false
        this.cdr.markForCheck()
    }

    cancelDescription (): void {
        this.editingDescription = false
        this.cdr.markForCheck()
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Inventory Management
    // ═══════════════════════════════════════════════════════════════════════

    get inventoryPollingEnabled (): boolean { return this.invSvc.isPolling }
    get activeAlarmCount (): number { return this.invSvc.activeAlarmCount }
    get criticalAlarmCount (): number { return this.invSvc.criticalAlarmCount }
    get inventoryActiveAlarms (): DeviceAlarm[] { return this.invSvc.activeAlarms }

    // Alarm panel filters
    alarmFilterSeverity: AlarmSeverity | 'all' = 'all'
    alarmFilterCategory: string = 'all'

    get filteredAlarms (): DeviceAlarm[] {
        let alarms = this.invSvc.activeAlarms
        if (this.alarmFilterSeverity !== 'all') {
            alarms = alarms.filter(a => a.severity === this.alarmFilterSeverity)
        }
        if (this.alarmFilterCategory !== 'all') {
            alarms = alarms.filter(a => a.category === this.alarmFilterCategory)
        }
        return alarms
    }

    get alarmSeveritySummary (): Record<string, number> {
        const counts: Record<string, number> = {}
        for (const a of this.invSvc.activeAlarms) {
            counts[a.severity] = (counts[a.severity] ?? 0) + 1
        }
        return counts
    }

    acknowledgeAllAlarms (): void {
        for (const a of this.filteredAlarms) {
            if (!a.acknowledged) { this.invSvc.acknowledgeAlarm(a.id) }
        }
        this.cdr.markForCheck()
    }

    clearAllAlarms (): void {
        for (const a of this.filteredAlarms) {
            this.invSvc.clearAlarm(a.id)
        }
        this.cdr.markForCheck()
    }

    // ── Monitoring Dashboard ──────────────────────────────────────────────────

    openDashboard (): void {
        this.showDashboard = true
        this.cdr.markForCheck()
    }

    closeDashboard (): void {
        this.showDashboard = false
        this.cdr.markForCheck()
    }

    get dashboardAlarms (): DeviceAlarm[] {
        const alarms = [...this.invSvc.activeAlarms]
        if (this.dashboardAlarmSort === 'severity') {
            const order: Record<string, number> = { critical: 0, major: 1, minor: 2, warning: 3, info: 4 }
            alarms.sort((a, b) => (order[a.severity] ?? 5) - (order[b.severity] ?? 5))
        } else {
            alarms.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt))
        }
        return alarms
    }

    get dashboardDeviceHealth (): Array<{
        nodeId: string; label: string; vendor: string;
        osVersion: string; uptime: string; cpu: number | null; mem: number | null;
        alarmSeverity: string | null; status: 'up' | 'down' | 'unknown'
    }> {
        return this.topology.nodes
            .filter(n => n.mapped || n.mgmtIp)
            .map(n => {
                const dv = this.invSvc.getDeviceVersion(n.id)
                const severity = this.invSvc.nodeAlarmSeverity(n.id)
                return {
                    nodeId: n.id,
                    label: n.label,
                    vendor: n.vendor ?? '',
                    osVersion: dv?.osVersion ?? '',
                    uptime: dv?.uptime ?? '',
                    cpu: dv?.cpuPercent ?? null,
                    mem: dv?.memoryUsedPercent ?? null,
                    alarmSeverity: severity,
                    status: dv?.lastPolled ? (dv.pollError ? 'down' : 'up') : 'unknown' as 'up' | 'down' | 'unknown',
                }
            })
    }

    get dashboardSummary (): { total: number; up: number; down: number; unknown: number; critical: number; major: number; minor: number; warning: number } {
        const devices = this.dashboardDeviceHealth
        const sevCounts = this.alarmSeveritySummary
        return {
            total: devices.length,
            up: devices.filter(d => d.status === 'up').length,
            down: devices.filter(d => d.status === 'down').length,
            unknown: devices.filter(d => d.status === 'unknown').length,
            critical: sevCounts['critical'] ?? 0,
            major: sevCounts['major'] ?? 0,
            minor: sevCounts['minor'] ?? 0,
            warning: sevCounts['warning'] ?? 0,
        }
    }

    dashboardNodeLabel (nodeId: string): string {
        return this.topology.nodes.find(n => n.id === nodeId)?.label ?? nodeId
    }

    get isSelectedMapped (): boolean {
        if (!this.selectedNodeId) { return false }
        const node = this.topology?.nodes.find(n => n.id === this.selectedNodeId)
        if (!node) { return false }
        const host = (node.mgmtIp ?? '').split('/')[0].trim()
        return !!(host && (node.sshUsername ?? '').trim())
    }

    get inventoryEntries (): {
        nodeId: string; nodeLabel: string; osVersion: string; model: string;
        cpu: string; mem: string; uptime: string; lastPolled: string; pollError: string;
        hasActiveAlarm: boolean; cpuHigh: boolean; memHigh: boolean;
    }[] {
        return this.topology.nodes.map(n => {
            const dv = this.invSvc.getDeviceVersion(n.id)
            const cpuPct = dv?.cpuPercent
            const memPct = dv?.memoryUsedPercent
            return {
                nodeId: n.id,
                nodeLabel: n.label,
                osVersion: dv?.osVersion ?? '',
                model: dv?.hardwareModel ?? n.model ?? '',
                cpu: dv?.pollError ? 'Err' : cpuPct != null ? `${cpuPct}%` : '—',
                mem: dv?.pollError ? 'Err' : memPct != null ? `${memPct}%` : '—',
                uptime: dv?.uptime ?? '',
                lastPolled: dv?.lastPolled ? new Date(dv.lastPolled).toLocaleTimeString() : 'Never',
                pollError: dv?.pollError ?? '',
                hasActiveAlarm: this.invSvc.nodeHasAlarm(n.id),
                cpuHigh: cpuPct != null && cpuPct > 80,
                memHigh: memPct != null && memPct > 85,
            }
        })
    }

    get eventRules () { return this.invSvc.store.eventRules }

    toggleInventoryPanel (): void {
        this.showInventoryPanel = !this.showInventoryPanel
        this.cdr.markForCheck()
    }

    toggleAlarmPanel (): void {
        this.showAlarmPanel = !this.showAlarmPanel
        this.cdr.markForCheck()
    }

    pollIntervalMinutes = 5
    readonly pollIntervalOptions = [1, 2, 5, 10, 15, 30]

    togglePolling (): void {
        if (this.invSvc.isPolling) {
            this.invSvc.stopPolling()
            this.statusMsg = 'Auto-poll stopped'
        } else {
            this.invSvc.startPolling(this.pollIntervalMinutes * 60000)
            this.statusMsg = `Auto-poll started (every ${this.pollIntervalMinutes} min)`
        }
        this.cdr.markForCheck()
    }

    setPollInterval (minutes: number): void {
        this.pollIntervalMinutes = minutes
        if (this.invSvc.isPolling) {
            this.invSvc.startPolling(minutes * 60000)
            this.statusMsg = `Auto-poll interval changed to ${minutes} min`
        }
        this.cdr.markForCheck()
    }

    async pollAllDevices (): Promise<void> {
        this.statusMsg = 'Polling all devices…'
        this.cdr.markForCheck()
        // Track progress with periodic UI updates
        const progressInterval = setInterval(() => {
            if (this.invSvc.pollAllRunning) {
                this.statusMsg = `Polling devices… ${this.invSvc.pollAllDone}/${this.invSvc.pollAllTotal}`
                this.cdr.markForCheck()
            }
        }, 500)
        try {
            await this.invSvc.pollAllDevices()
        } finally {
            clearInterval(progressInterval)
        }
        this.statusMsg = `Poll complete — ${this.invSvc.pollAllTotal} devices`

        // Build sync proposals for all polled nodes
        const proposals = this.topology.nodes
            .map(n => this.invSvc.buildSyncProposal(n.id))
            .filter((p): p is PollSyncProposal => p !== null && (!!p.modelChange || p.portChanges.length > 0))
        if (proposals.length > 0) {
            this.pollSyncProposals = proposals
            this.pollSyncChecked = {}
            this.pollSyncExpanded = {}
            for (const p of proposals) {
                this.pollSyncExpanded[p.nodeId] = true
                const checks: Record<string, boolean> = {}
                if (p.modelChange) { checks['model'] = true }
                for (const pc of p.portChanges) { checks[`port:${pc.portId}`] = true }
                this.pollSyncChecked[p.nodeId] = checks
            }
            this.showPollSyncDialog = true
        }
        this.cdr.markForCheck()
    }

    async pollSelectedDevice (): Promise<void> {
        if (!this.selectedNodeId) { return }
        const node = this.topology.nodes.find(n => n.id === this.selectedNodeId)
        this.statusMsg = `Polling ${node?.label ?? 'device'}…`
        this.cdr.markForCheck()
        try {
            await this.invSvc.pollDevice(this.selectedNodeId)
            this.statusMsg = `Poll complete — ${node?.label ?? 'device'}`

            // Build sync proposal for the polled device
            const proposal = this.invSvc.buildSyncProposal(this.selectedNodeId)
            if (proposal && (proposal.modelChange || proposal.portChanges.length > 0)) {
                this.pollSyncProposals = [proposal]
                this.pollSyncChecked = {}
                this.pollSyncExpanded = { [proposal.nodeId]: true }
                const checks: Record<string, boolean> = {}
                if (proposal.modelChange) { checks['model'] = true }
                for (const pc of proposal.portChanges) { checks[`port:${pc.portId}`] = true }
                this.pollSyncChecked[proposal.nodeId] = checks
                this.showPollSyncDialog = true
            }
        } catch (err) {
            this.statusMsg = `Poll failed — ${(err as Error).message}`
        }
        this.cdr.markForCheck()
    }

    async backupAllConfigs (): Promise<void> {
        this.statusMsg = 'Backing up configs…'
        this.cdr.markForCheck()
        const count = await this.invSvc.backupAllConfigs('manual')
        this.statusMsg = `Backed up ${count} device configs`
        this.cdr.markForCheck()
    }

    async backupSelectedConfig (): Promise<void> {
        if (!this.selectedNodeId) { return }
        const node = this.topology.nodes.find(n => n.id === this.selectedNodeId)
        this.statusMsg = `Backing up config for ${node?.label ?? 'device'}…`
        this.cdr.markForCheck()
        const entry = await this.invSvc.backupConfig(this.selectedNodeId, 'running', 'manual')
        this.statusMsg = entry ? `Config backed up for ${node?.label}` : 'Backup failed'
        this.cdr.markForCheck()
    }

    acknowledgeAlarm (alarmId: string): void {
        this.invSvc.acknowledgeAlarm(alarmId)
        this.cdr.markForCheck()
    }

    clearAlarm (alarmId: string): void {
        this.invSvc.clearAlarm(alarmId)
        this.cdr.markForCheck()
    }

    getNodeLabel (nodeId: string): string {
        return this._nodeMap.get(nodeId)?.label ?? '?'
    }

    nodeHasAlarm (nodeId: string): boolean {
        return this.invSvc.nodeHasAlarm(nodeId)
    }

    nodeAlarmColor (nodeId: string): string {
        const sev = this.invSvc.nodeAlarmSeverity(nodeId)
        switch (sev) {
            case 'critical': return '#ef4444'
            case 'major': return '#f97316'
            case 'minor': case 'warning': return '#f59e0b'
            default: return '#3b82f6'
        }
    }

    /**
     * When alarm overlay is active, color links based on endpoint status:
     *  - both endpoints alarmed critical → red
     *  - any endpoint alarmed → orange
     *  - link status down → red
     *  - link status up → green
     *  - otherwise → default (empty string = no override)
     */
    linkAlarmOverlayColor (link: TopologyLink): string {
        if (!this.showAlarmOverlay) { return '' }

        // Link operationally down
        if (link.status === 'down') { return '#ef4444' }

        const srcSev = this.invSvc.nodeAlarmSeverity(link.sourceNodeId)
        const tgtSev = this.invSvc.nodeAlarmSeverity(link.targetNodeId)
        const sevOrder: Record<string, number> = { critical: 0, major: 1, minor: 2, warning: 3, info: 4 }
        const worstSev = (srcSev && tgtSev)
            ? ((sevOrder[srcSev] ?? 5) <= (sevOrder[tgtSev] ?? 5) ? srcSev : tgtSev)
            : (srcSev ?? tgtSev)

        if (worstSev === 'critical') { return '#ef4444' }
        if (worstSev === 'major') { return '#f97316' }
        if (worstSev === 'minor' || worstSev === 'warning') { return '#f59e0b' }
        if (link.status === 'up') { return '#22c55e' }
        return ''
    }

    openEventRulesDialog (): void {
        this.showEventRulesDialog = true
        this.cdr.markForCheck()
    }
    closeEventRulesDialog (): void {
        this.showEventRulesDialog = false
        this.cdr.markForCheck()
    }

    openCompliancePanel (): void {
        this.showCompliancePanel = true
        this.cdr.markForCheck()
    }
    closeCompliancePanel (): void {
        this.showCompliancePanel = false
        this.cdr.markForCheck()
    }

    openEventRulesPanel (): void {
        this.showEventRulesPanel = true
        this.cdr.markForCheck()
    }
    closeEventRulesPanel (): void {
        this.showEventRulesPanel = false
        this.cdr.markForCheck()
    }

    // ── Help Window (separate Electron BrowserWindow) ─────────────────────

    openHelpDialog (): void {
        this.showHelpPanel = !this.showHelpPanel
        this.cdr.markForCheck()
    }

    closeHelpDialog (): void {
        this.showHelpPanel = false
        this.cdr.markForCheck()
    }

    // ── Onboarding: Welcome Dialog ──────────────────────────────────────────

    checkAndShowWelcome (): void {
        const api = (window as any).netopsAPI
        if (api?.prefGet) {
            api.prefGet('welcome-seen').then((val: any) => {
                if (!val) {
                    this.showWelcomeDialog = true
                    this.cdr.markForCheck()
                }
            })
        }
    }

    dismissWelcome (): void {
        if (this.welcomeDontShowAgain) {
            const api = (window as any).netopsAPI
            api?.prefSet?.('welcome-seen', true)
        }
        this.showWelcomeDialog = false
        this.cdr.markForCheck()
    }

    startTourFromWelcome (): void {
        const api = (window as any).netopsAPI
        api?.prefSet?.('welcome-seen', true)
        this.showWelcomeDialog = false
        this.startTour()
    }

    // ── License Activation ────────────────────────────────────────────────────

    checkLicenseOnStartup (): void {
        const status = this.licenseSvc.checkLicense()
        if (status === 'expired' || status === 'invalid') {
            this.showLicenseDialog = true
        }
        this.cdr.markForCheck()
    }

    async onActivateLicense (): Promise<void> {
        this.licenseActivationError = ''
        const key = this.licenseKeyInput.trim().toUpperCase()
        const keyPattern5 = /^TLINK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
        const keyPattern6 = /^TLINK-[A-Z0-9]{2}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
        if (!keyPattern5.test(key) && !keyPattern6.test(key)) {
            this.licenseActivationError = 'Invalid key format. Expected: TLINK-XXXX-XXXX-XXXX-XXXX or TLINK-XX-XXXX-XXXX-XXXX-XXXX'
            this.cdr.markForCheck()
            return
        }
        const result = await this.licenseSvc.activateLicense(key)
        if (result.success) {
            this.showLicenseDialog = false
            this.licenseKeyInput = ''
        } else {
            this.licenseActivationError = result.message
        }
        this.cdr.markForCheck()
    }

    onStartTrial (): void {
        this.licenseSvc.startTrial()
        this.showLicenseDialog = false
        this.cdr.markForCheck()
    }

    onDeactivateLicense (): void {
        this.licenseSvc.deactivateLicense()
        this.showLicenseDialog = true
        this.showAdminPanel = false
        this.cdr.markForCheck()
    }

    dismissSplash (): void {
        this.showSplashScreen = false
        this.cdr.markForCheck()
    }

    /** Check feature gating — returns true if allowed */
    isLicensedFeature (feature: string): boolean {
        return this.licenseSvc.isFeatureAvailable(feature)
    }

    // ── Admin Panel (Ctrl+Shift+L) ──────────────────────────────────────────

    showAdminPanel = false

    toggleAdminPanel (): void {
        this.showAdminPanel = !this.showAdminPanel
        this.cdr.markForCheck()
    }

    // ── License Server Settings ──────────────────────────────────────────────

    showServerSettings = false
    serverUrlInput = ''
    serverReachable: boolean | null = null

    testServerConnection (): void {
        const url = this.serverUrlInput.replace(/\/+$/, '')
        if (!url) { this.serverReachable = false; return }
        this.serverReachable = null
        this.cdr.markForCheck()

        fetch(`${url}/api/health`, { method: 'GET' })
            .then(res => res.json())
            .then(data => {
                this.serverReachable = data && data.status === 'ok'
                this.cdr.markForCheck()
            })
            .catch(() => {
                this.serverReachable = false
                this.cdr.markForCheck()
            })
    }

    saveServerUrl (): void {
        const url = this.serverUrlInput.replace(/\/+$/, '')
        if (!url) { return }
        this.licenseSvc.licenseServerUrl = url
        localStorage.setItem('tlink-license-server-url', url)
        this.serverReachable = null
        this.showServerSettings = false
        this.cdr.markForCheck()
    }

    // ── Onboarding: Interactive Tour ────────────────────────────────────────

    startTour (): void {
        this.tourStep = 0
        this.showTour = true
        this._highlightTourStep()
        this.cdr.markForCheck()
    }

    nextTourStep (): void {
        if (this.tourStep < this.tourSteps.length - 1) {
            this.tourStep++
            this._highlightTourStep()
            this.cdr.markForCheck()
        } else {
            this.endTour()
        }
    }

    prevTourStep (): void {
        if (this.tourStep > 0) {
            this.tourStep--
            this._highlightTourStep()
            this.cdr.markForCheck()
        }
    }

    endTour (): void {
        this._cleanupTourDemo()
        this.showTour = false
        this.cdr.markForCheck()
    }

    get tourHighlightRect (): { top: number; left: number; width: number; height: number } {
        const step = this.tourSteps[this.tourStep]
        if (!step) return { top: 0, left: 0, width: 0, height: 0 }
        const el = document.querySelector(step.selector)
        if (!el) return { top: 0, left: 0, width: 0, height: 0 }
        const r = el.getBoundingClientRect()
        return { top: r.top, left: r.left, width: r.width, height: r.height }
    }

    get tourTooltipStyle (): Record<string, string> {
        const rect = this.tourHighlightRect
        const step = this.tourSteps[this.tourStep]
        if (!step) return {}
        const pad = 16
        const tooltipW = 340, tooltipH = 180
        const vw = window.innerWidth, vh = window.innerHeight
        let top = 0, left = 0
        switch (step.position) {
            case 'right':
                top = rect.top; left = rect.left + rect.width + pad; break
            case 'left':
                top = rect.top; left = rect.left - tooltipW - pad; break
            case 'bottom':
                top = rect.top + rect.height + pad; left = rect.left; break
            case 'top':
                top = rect.top - tooltipH - pad; left = rect.left; break
        }
        // Clamp to viewport bounds
        if (left + tooltipW > vw - 16) left = vw - tooltipW - 16
        if (left < 16) left = 16
        if (top + tooltipH > vh - 16) top = vh - tooltipH - 16
        if (top < 16) top = 16
        return { top: top + 'px', left: left + 'px' }
    }

    private _highlightTourStep (): void {
        // Ensure the targeted element is visible — e.g., expand palette
        const step = this.tourSteps[this.tourStep]
        if (!step) return
        if (step.selector === '.netops-palette' && this.paletteCollapsed) {
            this.paletteCollapsed = false
        }
        if (step.selector === '.canvas-minimap') {
            this.showMinimap = true
        }
        // Demo: create shapes + links for interactive tour steps
        if (step.demo) {
            this._createTourDemo(step.demo)
        } else {
            this._cleanupTourDemo()
        }
    }

    private _tourDemoAnimTimer: any = null

    private _createTourDemo (demoType: boolean | string): void {
        if (this._tourDemoIds.length > 0) return  // already created
        const cx = (-this.vpX + window.innerWidth / 2) / this.vpScale
        const cy = (-this.vpY + window.innerHeight / 2) / this.vpScale

        if (demoType === true || demoType === 'connect') {
            this._createConnectDemo(cx, cy)
        } else if (demoType === 'styling') {
            this._createStylingDemo(cx, cy)
        } else if (demoType === 'labels') {
            this._createLabelsDemo(cx, cy)
        } else if (demoType === 'template') {
            this._createTemplateDemo(cx, cy)
        } else if (demoType === 'custom') {
            this._createCustomDemo(cx, cy)
        }
        this.cdr.markForCheck()
    }

    private _createConnectDemo (cx: number, cy: number): void {
        const s1 = this.svc.addShape('rectangle', cx - 180, cy - 50, 120, 80)
        const s2 = this.svc.addShape('rectangle', cx + 60, cy - 50, 120, 80)
        this.svc.updateAnnotation(s1.id, { text: 'Shape A' } as any)
        this.svc.updateAnnotation(s2.id, { text: 'Shape B' } as any)
        const link = this.svc.addShapeLink({
            sourceAnnotationId: s1.id, sourceAnchorX: 1, sourceAnchorY: 0.5,
            targetAnnotationId: s2.id, targetAnchorX: 0, targetAnchorY: 0.5,
        })
        if (link) {
            this.svc.updateLinkConfig(link.id, { showArrow: true, color: '#3b82f6',
                labels: [{ id: 'tdl1', text: 'Link', t: 0.5, perpOffset: 0 }] } as any)
        }
        this._tourDemoIds = [s1.id, s2.id, ...(link ? [link.id] : [])]
        this.tourDemoConnectors = [
            { x: s1.x + s1.width, y: s1.y + s1.height / 2 },
            { x: s1.x + s1.width / 2, y: s1.y },
            { x: s1.x + s1.width / 2, y: s1.y + s1.height },
            { x: s1.x, y: s1.y + s1.height / 2 },
            { x: s2.x, y: s2.y + s2.height / 2 },
            { x: s2.x + s2.width / 2, y: s2.y },
            { x: s2.x + s2.width / 2, y: s2.y + s2.height },
            { x: s2.x + s2.width, y: s2.y + s2.height / 2 },
        ]
    }

    private _createStylingDemo (cx: number, cy: number): void {
        const s1 = this.svc.addShape('rectangle', cx - 220, cy - 40, 100, 70)
        const s2 = this.svc.addShape('rectangle', cx + 120, cy - 40, 100, 70)
        this.svc.updateAnnotation(s1.id, { text: 'Server' } as any)
        this.svc.updateAnnotation(s2.id, { text: 'Database' } as any)
        // Create 3 links with different styles
        const colors = ['#3b82f6', '#ef4444', '#22c55e']
        const dashes = ['', '8 4', '3 3']
        const weights = [2, 3, 2]
        const arrows: Array<{ show: boolean; start: boolean }> = [
            { show: true, start: false }, { show: true, start: true }, { show: true, start: false }
        ]
        const anchorsY = [0.25, 0.5, 0.75]
        const linkIds: string[] = []
        for (let i = 0; i < 3; i++) {
            const link = this.svc.addShapeLink({
                sourceAnnotationId: s1.id, sourceAnchorX: 1, sourceAnchorY: anchorsY[i],
                targetAnnotationId: s2.id, targetAnchorX: 0, targetAnchorY: anchorsY[i],
            })
            if (link) {
                this.svc.updateLinkConfig(link.id, {
                    showArrow: arrows[i].show, arrowStart: arrows[i].start,
                    color: colors[i], dashArray: dashes[i], strokeWidth: weights[i],
                } as any)
                linkIds.push(link.id)
            }
        }
        this._tourDemoIds = [s1.id, s2.id, ...linkIds]
        // Animate color cycling on the links
        let cycle = 0
        this._tourDemoAnimTimer = setInterval(() => {
            cycle++
            for (let i = 0; i < linkIds.length; i++) {
                const colorIdx = (i + cycle) % colors.length
                try {
                    this.svc.updateLinkConfig(linkIds[i], { color: colors[colorIdx] } as any)
                } catch (e) {}
            }
            this.cdr.markForCheck()
        }, 1500)
    }

    private _createLabelsDemo (cx: number, cy: number): void {
        const s1 = this.svc.addShape('circle', cx - 180, cy - 50, 100, 100)
        const s2 = this.svc.addShape('diamond', cx + 80, cy - 50, 100, 100)
        this.svc.updateAnnotation(s1.id, { text: 'Start' } as any)
        this.svc.updateAnnotation(s2.id, { text: 'End' } as any)
        const link = this.svc.addShapeLink({
            sourceAnnotationId: s1.id, sourceAnchorX: 1, sourceAnchorY: 0.5,
            targetAnnotationId: s2.id, targetAnchorX: 0, targetAnchorY: 0.5,
        })
        if (link) {
            this.svc.updateLinkConfig(link.id, {
                showArrow: true, color: '#8b5cf6', strokeWidth: 3,
                labels: [
                    { id: 'tdl-src', text: '10 Gbps', t: 0.2, perpOffset: -20 },
                    { id: 'tdl-mid', text: 'Primary Link', t: 0.5, perpOffset: 0 },
                    { id: 'tdl-tgt', text: 'Port 1', t: 0.8, perpOffset: 20 },
                ]
            } as any)
        }
        this._tourDemoIds = [s1.id, s2.id, ...(link ? [link.id] : [])]
        // Animate label position cycling
        let tick = 0
        this._tourDemoAnimTimer = setInterval(() => {
            tick++
            if (!link) return
            const offsets = [
                { perpOffset: -20 + Math.sin(tick * 0.5) * 15 },
                { perpOffset: Math.sin(tick * 0.3 + 1) * 18 },
                { perpOffset: 20 + Math.sin(tick * 0.4 + 2) * 15 },
            ]
            try {
                const existingLink = this.topology.links.find(l => l.id === link.id)
                if (existingLink && existingLink.labels) {
                    existingLink.labels.forEach((lbl: any, i: number) => {
                        if (offsets[i]) lbl.perpOffset = offsets[i].perpOffset
                    })
                    this.cdr.markForCheck()
                }
            } catch (e) {}
        }, 100)
    }

    private _createTemplateDemo (cx: number, cy: number): void {
        // Build a 3-tier network topology demo
        const tierY = [cy - 120, cy, cy + 120]
        const tierLabels = ['Web Tier', 'App Tier', 'Data Tier']
        const tierColors = ['#3b82f6', '#8b5cf6', '#22c55e']
        const shapes: any[] = []

        // Create tier label backgrounds
        for (let t = 0; t < 3; t++) {
            const bg = this.svc.addShape('rectangle', cx - 220, tierY[t] - 30, 440, 70)
            this.svc.updateAnnotation(bg.id, { fillColor: tierColors[t] + '15', borderColor: tierColors[t], text: tierLabels[t] } as any)
            shapes.push(bg)
        }

        // Create nodes in each tier
        const tierNodes: any[][] = [[], [], []]
        const nodePositions = [
            [cx - 120, cx, cx + 120],  // Web: 3 nodes
            [cx - 80, cx + 80],         // App: 2 nodes
            [cx - 60, cx + 60],          // Data: 2 nodes
        ]
        const nodeShapes = ['circle', 'hexagon', 'cylinder']
        const nodeLabels = [['LB', 'Web1', 'Web2'], ['App1', 'App2'], ['DB1', 'DB2']]

        for (let t = 0; t < 3; t++) {
            for (let n = 0; n < nodePositions[t].length; n++) {
                const s = this.svc.addShape(nodeShapes[t] as any, nodePositions[t][n] - 25, tierY[t] - 25, 50, 50)
                this.svc.updateAnnotation(s.id, { text: nodeLabels[t][n], fillColor: tierColors[t] } as any)
                tierNodes[t].push(s)
                shapes.push(s)
            }
        }

        // Connect tiers with links
        const linkIds: string[] = []
        // Web → App
        for (const webNode of tierNodes[0]) {
            for (const appNode of tierNodes[1]) {
                const link = this.svc.addShapeLink({
                    sourceAnnotationId: webNode.id, sourceAnchorX: 0.5, sourceAnchorY: 1,
                    targetAnnotationId: appNode.id, targetAnchorX: 0.5, targetAnchorY: 0,
                })
                if (link) {
                    this.svc.updateLinkConfig(link.id, { showArrow: true, color: tierColors[0], strokeWidth: 1.5 } as any)
                    linkIds.push(link.id)
                }
            }
        }
        // App → Data
        for (const appNode of tierNodes[1]) {
            for (const dataNode of tierNodes[2]) {
                const link = this.svc.addShapeLink({
                    sourceAnnotationId: appNode.id, sourceAnchorX: 0.5, sourceAnchorY: 1,
                    targetAnnotationId: dataNode.id, targetAnchorX: 0.5, targetAnchorY: 0,
                })
                if (link) {
                    this.svc.updateLinkConfig(link.id, { showArrow: true, color: tierColors[1], strokeWidth: 1.5 } as any)
                    linkIds.push(link.id)
                }
            }
        }

        this._tourDemoIds = [...shapes.map(s => s.id), ...linkIds]
    }

    private _createCustomDemo (cx: number, cy: number): void {
        // Build a custom network diagram showing variety of shapes and features
        const ids: string[] = []
        const linkIds: string[] = []

        // Cloud shape at top
        const cloud = this.svc.addShape('cloud', cx - 70, cy - 160, 140, 90)
        this.svc.updateAnnotation(cloud.id, { text: 'Internet', fillColor: '#3b82f6' } as any)
        ids.push(cloud.id)

        // Firewall (diamond)
        const fw = this.svc.addShape('diamond', cx - 35, cy - 35, 70, 70)
        this.svc.updateAnnotation(fw.id, { text: 'FW', fillColor: '#ef4444' } as any)
        ids.push(fw.id)

        // Link cloud → firewall
        const l1 = this.svc.addShapeLink({
            sourceAnnotationId: cloud.id, sourceAnchorX: 0.5, sourceAnchorY: 1,
            targetAnnotationId: fw.id, targetAnchorX: 0.5, targetAnchorY: 0,
        })
        if (l1) { this.svc.updateLinkConfig(l1.id, { showArrow: true, color: '#3b82f6', strokeWidth: 3 } as any); linkIds.push(l1.id) }

        // Switch (hexagon)
        const sw = this.svc.addShape('hexagon', cx - 40, cy + 70, 80, 80)
        this.svc.updateAnnotation(sw.id, { text: 'Core SW', fillColor: '#8b5cf6' } as any)
        ids.push(sw.id)

        // Link firewall → switch
        const l2 = this.svc.addShapeLink({
            sourceAnnotationId: fw.id, sourceAnchorX: 0.5, sourceAnchorY: 1,
            targetAnnotationId: sw.id, targetAnchorX: 0.5, targetAnchorY: 0,
        })
        if (l2) {
            this.svc.updateLinkConfig(l2.id, {
                showArrow: true, arrowStart: true, color: '#22c55e', strokeWidth: 2,
                labels: [{ id: 'custom-l2', text: '10 Gbps', t: 0.5, perpOffset: -15 }]
            } as any)
            linkIds.push(l2.id)
        }

        // Servers (rectangles) on left and right
        const srv1 = this.svc.addShape('rectangle', cx - 160, cy + 170, 100, 60)
        this.svc.updateAnnotation(srv1.id, { text: 'Web Server', fillColor: '#22c55e' } as any)
        ids.push(srv1.id)

        const srv2 = this.svc.addShape('rectangle', cx + 60, cy + 170, 100, 60)
        this.svc.updateAnnotation(srv2.id, { text: 'DB Server', fillColor: '#f59e0b' } as any)
        ids.push(srv2.id)

        // Link switch → servers
        const l3 = this.svc.addShapeLink({
            sourceAnnotationId: sw.id, sourceAnchorX: 0, sourceAnchorY: 0.75,
            targetAnnotationId: srv1.id, targetAnchorX: 0.5, targetAnchorY: 0,
        })
        if (l3) { this.svc.updateLinkConfig(l3.id, { showArrow: true, color: '#22c55e' } as any); linkIds.push(l3.id) }

        const l4 = this.svc.addShapeLink({
            sourceAnnotationId: sw.id, sourceAnchorX: 1, sourceAnchorY: 0.75,
            targetAnnotationId: srv2.id, targetAnchorX: 0.5, targetAnchorY: 0,
        })
        if (l4) { this.svc.updateLinkConfig(l4.id, { showArrow: true, color: '#f59e0b' } as any); linkIds.push(l4.id) }

        // Star for monitoring
        const star = this.svc.addShape('star', cx - 30, cy + 280, 60, 60)
        this.svc.updateAnnotation(star.id, { text: 'Monitor', fillColor: '#ec4899' } as any)
        ids.push(star.id)

        // Dashed link from monitor to switch
        const l5 = this.svc.addShapeLink({
            sourceAnnotationId: star.id, sourceAnchorX: 0.5, sourceAnchorY: 0,
            targetAnnotationId: sw.id, targetAnchorX: 0.5, targetAnchorY: 1,
        })
        if (l5) {
            this.svc.updateLinkConfig(l5.id, {
                color: '#ec4899', dashArray: '6 3', strokeWidth: 1.5,
                labels: [{ id: 'custom-l5', text: 'SNMP', t: 0.5, perpOffset: 12 }]
            } as any)
            linkIds.push(l5.id)
        }

        this._tourDemoIds = [...ids, ...linkIds]
    }

    private _cleanupTourDemo (): void {
        if (this._tourDemoAnimTimer) {
            clearInterval(this._tourDemoAnimTimer)
            this._tourDemoAnimTimer = null
        }
        if (this._tourDemoIds.length === 0) return
        for (const id of this._tourDemoIds) {
            try { this.svc.removeLink(id) } catch (e) {}
            try { this.svc.removeAnnotation(id) } catch (e) {}
        }
        this._tourDemoIds = []
        this.tourDemoConnectors = []
        this.cdr.markForCheck()
    }

    // ── Help Panel ──────────────────────────────────────────────────────────

    toggleHelpPanel (): void {
        this.showHelpPanel = !this.showHelpPanel
        this.helpScrolledDown = false
        this.cdr.markForCheck()
    }

    get filteredHelpSections () {
        if (!this.helpSearchQuery.trim()) return this.helpSections
        const q = this.helpSearchQuery.toLowerCase()
        return this.helpSections.filter(s =>
            s.title.toLowerCase().includes(q) ||
            s.content.toLowerCase().includes(q) ||
            (s.subsections || []).some(sub => sub.title.toLowerCase().includes(q) || sub.content.toLowerCase().includes(q))
        )
    }

    highlightHelpMatch (text: string): string {
        if (!this.helpSearchQuery.trim()) return text
        const q = this.helpSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return text.replace(new RegExp(`(${q})`, 'gi'), '<mark class="help-highlight">$1</mark>')
    }

    onHelpPanelScroll (ev: Event): void {
        const el = ev.target as HTMLElement
        this.helpScrolledDown = el.scrollTop > 200
        this.cdr.markForCheck()
    }

    scrollHelpToTop (): void {
        const body = document.querySelector('.help-panel-body')
        if (body) { body.scrollTo({ top: 0, behavior: 'smooth' }) }
        this.helpScrolledDown = false
        this.cdr.markForCheck()
    }

    // ── Help Panel Quick Actions ─────────────────────────────────────────────

    helpStartTour (): void {
        this.showHelpPanel = false
        this.startTour()
    }

    helpLoadTemplate (templateId: string): void {
        this.showHelpPanel = false
        this.openTemplates()
        this.cdr.markForCheck()
    }

    helpToggleGrid (): void {
        this.showGrid = !this.showGrid
        this.cdr.markForCheck()
    }

    helpToggleMinimap (): void {
        this.showMinimap = !this.showMinimap
        this.cdr.markForCheck()
    }

    helpOpenShortcuts (): void {
        this.showHelpPanel = false
        this.showShortcutsOverlay = true
        this.cdr.markForCheck()
    }

    // ── Upgrade Plans ──────────────────────────────────────────────────────

    newUpgradeNodeId = ''
    newUpgradeTarget = ''
    upgradeRunning: Record<string, boolean> = {}
    upgradeShowOutput: Record<string, boolean> = {}

    get allUpgradePlans () { return this.invSvc.store.upgradePlans }

    get upgradeNodeOptions (): { id: string; label: string; currentVersion: string }[] {
        return this.topology.nodes
            .filter(n => {
                const dv = this.invSvc.getDeviceVersion(n.id)
                return dv?.osVersion
            })
            .map(n => ({
                id: n.id,
                label: n.label,
                currentVersion: this.invSvc.getDeviceVersion(n.id)?.osVersion ?? '',
            }))
    }

    createUpgradePlan (): void {
        if (!this.newUpgradeNodeId || !this.newUpgradeTarget.trim()) { return }
        const current = this.invSvc.getDeviceVersion(this.newUpgradeNodeId)?.osVersion ?? ''
        this.invSvc.createUpgradePlan(this.newUpgradeNodeId, current, this.newUpgradeTarget.trim())
        this.newUpgradeNodeId = ''
        this.newUpgradeTarget = ''
        this.cdr.markForCheck()
    }

    async runUpgradePreCheck (planId: string): Promise<void> {
        this.upgradeRunning = { ...this.upgradeRunning, [planId]: true }
        this.cdr.markForCheck()
        await this.invSvc.runPreCheck(planId)
        this.upgradeRunning = { ...this.upgradeRunning, [planId]: false }
        this.upgradeShowOutput = { ...this.upgradeShowOutput, [planId]: true }
        this.cdr.markForCheck()
    }

    async runUpgradePostCheck (planId: string): Promise<void> {
        this.upgradeRunning = { ...this.upgradeRunning, [planId]: true }
        this.cdr.markForCheck()
        await this.invSvc.runPostCheck(planId)
        this.upgradeRunning = { ...this.upgradeRunning, [planId]: false }
        this.upgradeShowOutput = { ...this.upgradeShowOutput, [planId]: true }
        this.cdr.markForCheck()
    }

    advanceUpgradeStage (planId: string, stage: import('../api/interfaces').UpgradeStage): void {
        this.invSvc.updateUpgradeStage(planId, stage)
        this.cdr.markForCheck()
    }

    removeUpgradePlan (planId: string): void {
        this.invSvc.removeUpgradePlan(planId)
        this.cdr.markForCheck()
    }

    toggleUpgradeOutput (planId: string): void {
        this.upgradeShowOutput = { ...this.upgradeShowOutput, [planId]: !this.upgradeShowOutput[planId] }
        this.cdr.markForCheck()
    }

    nextUpgradeStage (current: string): import('../api/interfaces').UpgradeStage | null {
        const stages: import('../api/interfaces').UpgradeStage[] = [
            'planned', 'downloading', 'staged', 'upgrading', 'verifying', 'completed',
        ]
        const idx = stages.indexOf(current as any)
        return idx >= 0 && idx < stages.length - 1 ? stages[idx + 1] : null
    }

    openUpgradesDialog (): void {
        this.showUpgradesDialog = true
        this.cdr.markForCheck()
    }
    closeUpgradesDialog (): void {
        this.showUpgradesDialog = false
        this.cdr.markForCheck()
    }

    // ── Config Diff Viewer ───────────────────────────────────────────────

    configViewerNodeId: string | null = null
    configViewerBackups: ConfigBackupEntry[] = []
    configViewerSelectedA: ConfigBackupEntry | null = null
    configViewerSelectedB: ConfigBackupEntry | null = null
    configViewerDiffResult: string | null = null
    configViewerShowRaw: ConfigBackupEntry | null = null

    openConfigViewer (title?: string, content?: string): void {
        // If called with title+content (legacy), show simple viewer
        if (title && content) {
            this.configViewerTitle = title
            this.configViewerContent = content
        } else {
            this.configViewerTitle = ''
            this.configViewerContent = ''
        }
        this.configViewerNodeId = null
        this.configViewerBackups = []
        this.configViewerSelectedA = null
        this.configViewerSelectedB = null
        this.configViewerDiffResult = null
        this.configViewerShowRaw = null
        this.showConfigViewer = true
        this.cdr.markForCheck()
    }

    openConfigDiffViewer (nodeId?: string): void {
        this.configViewerTitle = ''
        this.configViewerContent = ''
        this.configViewerNodeId = nodeId ?? null
        this.configViewerSelectedA = null
        this.configViewerSelectedB = null
        this.configViewerDiffResult = null
        this.configViewerShowRaw = null
        this._loadConfigViewerBackups()
        this.showConfigViewer = true
        this.cdr.markForCheck()
    }

    private _loadConfigViewerBackups (): void {
        if (this.configViewerNodeId) {
            this.configViewerBackups = this.invSvc.store.configBackups
                .filter(b => b.nodeId === this.configViewerNodeId)
                .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        } else {
            this.configViewerBackups = this.invSvc.store.configBackups
                .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        }
    }

    setConfigViewerNode (nodeId: string): void {
        this.configViewerNodeId = nodeId || null
        this.configViewerSelectedA = null
        this.configViewerSelectedB = null
        this.configViewerDiffResult = null
        this.configViewerShowRaw = null
        this._loadConfigViewerBackups()
        this.cdr.markForCheck()
    }

    selectConfigDiffA (backup: ConfigBackupEntry): void {
        this.configViewerSelectedA = backup
        this.configViewerDiffResult = null
        this.cdr.markForCheck()
    }

    selectConfigDiffB (backup: ConfigBackupEntry): void {
        this.configViewerSelectedB = backup
        if (this.configViewerSelectedA && this.configViewerSelectedB) {
            this.configViewerDiffResult = this.invSvc.diffConfigs(
                this.configViewerSelectedA,
                this.configViewerSelectedB,
            )
        }
        this.cdr.markForCheck()
    }

    viewConfigRaw (backup: ConfigBackupEntry): void {
        this.configViewerShowRaw = this.configViewerShowRaw?.id === backup.id ? null : backup
        this.cdr.markForCheck()
    }

    exportConfigBackup (backup: ConfigBackupEntry): void {
        this.invSvc.exportBackup(backup)
    }

    get configViewerNodes (): { id: string; label: string }[] {
        const nodeIds = new Set(this.invSvc.store.configBackups.map(b => b.nodeId))
        return this.topology.nodes
            .filter(n => nodeIds.has(n.id))
            .map(n => ({ id: n.id, label: n.label }))
    }

    closeConfigViewer (): void {
        this.showConfigViewer = false
        this.configViewerNodeId = null
        this.configViewerBackups = []
        this.configViewerSelectedA = null
        this.configViewerSelectedB = null
        this.configViewerDiffResult = null
        this.configViewerShowRaw = null
        this.configLoadTarget = null
        this.configLoadOutput = null
        this.configLoadRunning = false
        this.cdr.markForCheck()
    }

    // ── Config Load from Viewer ──────────────────────────────────────────

    configLoadTarget: ConfigBackupEntry | null = null
    configLoadOutput: string | null = null
    configLoadRunning = false

    confirmConfigLoad (backup: ConfigBackupEntry): void {
        this.configLoadTarget = backup
        this.configLoadOutput = null
        this.cdr.markForCheck()
    }

    cancelConfigLoad (): void {
        this.configLoadTarget = null
        this.cdr.markForCheck()
    }

    async executeConfigLoad (): Promise<void> {
        if (!this.configLoadTarget) { return }
        this.configLoadRunning = true
        this.cdr.markForCheck()
        try {
            const result = await this.invSvc.loadConfig(
                this.configLoadTarget.nodeId,
                this.configLoadTarget.id,
            )
            this.configLoadOutput = result.output
        } catch (err) {
            this.configLoadOutput = `Error: ${(err as Error).message}`
        }
        this.configLoadRunning = false
        this.configLoadTarget = null
        this.cdr.markForCheck()
    }

    closeConfigLoadOutput (): void {
        this.configLoadOutput = null
        this.cdr.markForCheck()
    }

    // Event rule quick-add helpers
    newRuleName = ''
    newRuleTrigger: import('../api/interfaces').EventTrigger = 'alarm_raised'
    newRuleAction: import('../api/interfaces').EventActionType = 'notify'
    newRuleNodeFilter = '*'
    newRuleVendorFilter = '*'
    newRuleMessage = ''
    newRuleCommand = ''
    newRuleCheckCommand = ''
    newRuleCheckPattern = ''
    newRuleWebhookUrl = ''
    newRuleWebhookMethod = 'POST'
    readonly vendorOptions = ['*', 'cisco', 'juniper', 'arista', 'nokia', 'sonic', 'huawei', 'hpe', 'dell', 'mikrotik', 'extreme']
    showEventLog = false

    get recentEventLog () {
        return this.invSvc.store.eventLog.slice(-50).reverse()
    }

    addEventRule (): void {
        if (!this.newRuleName.trim()) { return }
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
            },
        })
        this.newRuleName = ''
        this.newRuleMessage = ''
        this.newRuleCommand = ''
        this.newRuleCheckCommand = ''
        this.newRuleCheckPattern = ''
        this.newRuleWebhookUrl = ''
        this.newRuleWebhookMethod = 'POST'
        this.cdr.markForCheck()
    }

    toggleEventRule (ruleId: string): void {
        const rule = this.invSvc.store.eventRules.find(r => r.id === ruleId)
        if (rule) {
            this.invSvc.updateEventRule(ruleId, { enabled: !rule.enabled })
            this.cdr.markForCheck()
        }
    }

    removeEventRule (ruleId: string): void {
        this.invSvc.removeEventRule(ruleId)
        this.cdr.markForCheck()
    }

    relativeTime (iso: string): string {
        const diff = Date.now() - new Date(iso).getTime()
        if (diff < 60000) { return 'just now' }
        if (diff < 3600000) { return `${Math.floor(diff / 60000)}m ago` }
        if (diff < 86400000) { return `${Math.floor(diff / 3600000)}h ago` }
        return `${Math.floor(diff / 86400000)}d ago`
    }

    // ── Poll Sync Dialog ─────────────────────────────────────────────────

    get totalPollSyncChanges (): number {
        let count = 0
        for (const p of this.pollSyncProposals) {
            if (p.modelChange) { count++ }
            count += p.portChanges.length
        }
        return count
    }

    get checkedPollSyncChanges (): number {
        let count = 0
        for (const nodeId of Object.keys(this.pollSyncChecked)) {
            for (const v of Object.values(this.pollSyncChecked[nodeId])) {
                if (v) { count++ }
            }
        }
        return count
    }

    togglePollSyncExpand (nodeId: string): void {
        this.pollSyncExpanded = { ...this.pollSyncExpanded, [nodeId]: !this.pollSyncExpanded[nodeId] }
        this.cdr.markForCheck()
    }

    togglePollSyncCheck (nodeId: string, key: string): void {
        const prev = this.pollSyncChecked[nodeId] ?? {}
        this.pollSyncChecked = {
            ...this.pollSyncChecked,
            [nodeId]: { ...prev, [key]: !prev[key] },
        }
        this.cdr.markForCheck()
    }

    selectAllPollSync (checked: boolean): void {
        const next = { ...this.pollSyncChecked }
        for (const p of this.pollSyncProposals) {
            const nodeChecks = { ...(next[p.nodeId] ?? {}) }
            if (p.modelChange) { nodeChecks['model'] = checked }
            for (const pc of p.portChanges) { nodeChecks[`port:${pc.portId}`] = checked }
            next[p.nodeId] = nodeChecks
        }
        this.pollSyncChecked = next
        this.cdr.markForCheck()
    }

    applyAllPollSync (): void {
        const appliedCount = this.checkedPollSyncChanges
        for (const proposal of this.pollSyncProposals) {
            const checks = this.pollSyncChecked[proposal.nodeId] ?? {}
            const accepted = new Set<string>(
                Object.entries(checks).filter(([, v]) => v).map(([k]) => k),
            )
            if (accepted.size > 0) {
                this.invSvc.applySyncProposal(proposal, accepted)
            }
        }
        this.statusMsg = `Applied ${appliedCount} change${appliedCount === 1 ? '' : 's'} from poll sync`
        this.dismissPollSync()
    }

    dismissPollSync (): void {
        this.showPollSyncDialog = false
        this.pollSyncProposals = []
        this.pollSyncChecked = {}
        this.pollSyncExpanded = {}
        this.cdr.markForCheck()
    }

    // ── Grid toggle & settings ──────────────────────────────────────────────

    get gridCellSize (): number {
        switch (this.gridSize) {
            case 'small': return 20
            case 'large': return 80
            default: return 40
        }
    }

    get gridMajorSize (): number {
        return this.gridCellSize * 5
    }

    toggleGrid (): void {
        this.showGrid = !this.showGrid
        this.cdr.markForCheck()
    }

    setGridSize (size: 'small' | 'medium' | 'large'): void {
        this.gridSize = size
        this.cdr.markForCheck()
    }

    // ── Shape locking ───────────────────────────────────────────────────────

    toggleShapeLock (id: string): void {
        const ann = (this.topology.annotations ?? []).find(a => a.id === id)
        if (!ann) { return }
        this.svc.updateAnnotation(id, { locked: !ann.locked })
        this.statusMsg = ann.locked ? 'Shape unlocked' : 'Shape locked'
        this.ctxShapeId = null
        this.cdr.markForCheck()
    }

    isShapeLocked (id: string): boolean {
        const ann = (this.topology.annotations ?? []).find(a => a.id === id)
        return !!ann?.locked
    }

    // ── Align & distribute shapes ───────────────────────────────────────────

    get showAlignToolbar (): boolean {
        return this.selectedShapeIds.size >= 2
    }

    private _getSelectedShapes (): Annotation[] {
        const ids = this.selectedShapeIds
        return (this.topology.annotations ?? []).filter(a => ids.has(a.id))
    }

    alignShapes (edge: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void {
        const shapes = this._getSelectedShapes()
        if (shapes.length < 2) { return }
        switch (edge) {
            case 'left': {
                const minX = Math.min(...shapes.map(s => s.x))
                shapes.forEach(s => this.svc.updateAnnotation(s.id, { x: minX }))
                break
            }
            case 'center': {
                const centers = shapes.map(s => s.x + (s.width ?? 120) / 2)
                const avg = centers.reduce((a, b) => a + b, 0) / centers.length
                shapes.forEach(s => this.svc.updateAnnotation(s.id, { x: avg - (s.width ?? 120) / 2 }))
                break
            }
            case 'right': {
                const maxR = Math.max(...shapes.map(s => s.x + (s.width ?? 120)))
                shapes.forEach(s => this.svc.updateAnnotation(s.id, { x: maxR - (s.width ?? 120) }))
                break
            }
            case 'top': {
                const minY = Math.min(...shapes.map(s => s.y))
                shapes.forEach(s => this.svc.updateAnnotation(s.id, { y: minY }))
                break
            }
            case 'middle': {
                const middles = shapes.map(s => s.y + (s.height ?? 80) / 2)
                const avg = middles.reduce((a, b) => a + b, 0) / middles.length
                shapes.forEach(s => this.svc.updateAnnotation(s.id, { y: avg - (s.height ?? 80) / 2 }))
                break
            }
            case 'bottom': {
                const maxB = Math.max(...shapes.map(s => s.y + (s.height ?? 80)))
                shapes.forEach(s => this.svc.updateAnnotation(s.id, { y: maxB - (s.height ?? 80) }))
                break
            }
        }
        this.statusMsg = `Aligned ${edge}`
        this.cdr.markForCheck()
    }

    distributeShapes (axis: 'horizontal' | 'vertical'): void {
        const shapes = this._getSelectedShapes()
        if (shapes.length < 3) { return }
        if (axis === 'horizontal') {
            const sorted = [...shapes].sort((a, b) => a.x - b.x)
            const first = sorted[0], last = sorted[sorted.length - 1]
            const totalSpan = (last.x + (last.width ?? 120)) - first.x
            const totalItemWidth = sorted.reduce((s, a) => s + (a.width ?? 120), 0)
            const gap = (totalSpan - totalItemWidth) / (sorted.length - 1)
            let cx = first.x + (first.width ?? 120) + gap
            for (let i = 1; i < sorted.length - 1; i++) {
                this.svc.updateAnnotation(sorted[i].id, { x: cx })
                cx += (sorted[i].width ?? 120) + gap
            }
        } else {
            const sorted = [...shapes].sort((a, b) => a.y - b.y)
            const first = sorted[0], last = sorted[sorted.length - 1]
            const totalSpan = (last.y + (last.height ?? 80)) - first.y
            const totalItemHeight = sorted.reduce((s, a) => s + (a.height ?? 80), 0)
            const gap = (totalSpan - totalItemHeight) / (sorted.length - 1)
            let cy = first.y + (first.height ?? 80) + gap
            for (let i = 1; i < sorted.length - 1; i++) {
                this.svc.updateAnnotation(sorted[i].id, { y: cy })
                cy += (sorted[i].height ?? 80) + gap
            }
        }
        this.statusMsg = `Distributed ${axis}ly`
        this.cdr.markForCheck()
    }

    // ── Import / Export Topology JSON ────────────────────────────────────────

    exportTopologyJson (): void {
        const json = this.svc.exportJSON()
        this._downloadText(json, `${this.topology.name.replace(/\s+/g, '_')}_topology.json`, 'application/json')
        this.statusMsg = 'Topology exported as JSON'
        this.cdr.markForCheck()
    }

    importTopologyJson (): void {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'
        input.onchange = () => {
            const file = input.files?.[0]
            if (!file) { return }
            const reader = new FileReader()
            reader.onload = () => {
                const json = reader.result as string
                const ok = this.svc.importJSON(json)
                if (ok) {
                    this.statusMsg = `Imported topology: ${this.topology.name}`
                    this.selectedShapeId = null
                    this.selectedShapeIds.clear()
                    this.selectedNodeIds.clear()
                    this.selectedLinkIds.clear()
                } else {
                    this.statusMsg = 'Failed to import topology — invalid JSON'
                }
                this.cdr.markForCheck()
            }
            reader.readAsText(file)
        }
        input.click()
    }
}
