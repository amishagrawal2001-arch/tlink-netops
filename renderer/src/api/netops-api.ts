export interface SaveTopologyResult {
    ok: boolean
    filePath?: string
}

export interface LoadTopologyResult {
    ok: boolean
    json?: string
    filePath?: string
}

export interface OpenInNewWindowResult {
    ok: boolean
}

export interface NetopsSshRequest {
    host: string
    port?: number
    username: string
    password: string
    timeoutMs?: number
}

export interface NetopsSshResult {
    ok: boolean
    message: string
    output?: string
}

export interface NetopsSshTerminalRequest {
    host: string
    port?: number
    username: string
}

export interface NetopsSshTerminalResult {
    ok: boolean
    message: string
    sessionId?: string
}

// ─── Inventory SSH extensions ─────────────────────────────────────────────────

export interface NetopsSshCommandRequest extends NetopsSshRequest {
    command: string
}

export interface NetopsSshMultiCommandRequest extends NetopsSshRequest {
    commands: string[]
}

export interface NetopsSshMultiResult {
    ok: boolean
    message: string
    results: NetopsSshResult[]
}

export interface NetopsSshShellRequest extends NetopsSshRequest {
    commands: string[]
    delayMs?: number
}

// ─── Containerlab lab management ─────────────────────────────────────────────

export interface ClabPrereqResult {
    ok: boolean
    docker: boolean
    dockerInstalled: boolean
    dockerMessage: string
    clab: boolean
    clabMessage: string
}

export interface ClabSaveRequest {
    content: string
    labName: string
    labDir?: string
    extraFiles?: Array<{ name: string; content: string }>
}

export interface ClabParseTopologyResult {
    ok: boolean
    message?: string
    labName?: string
    nodes?: Array<{ name: string; kind: string; image: string; labels?: Record<string, string> }>
    links?: Array<{ srcNode: string; srcPort: string; tgtNode: string; tgtPort: string }>
}

export interface ClabSaveResult {
    ok: boolean
    message: string
    filePath?: string
}

export interface ClabActionRequest {
    filePath: string
}

export interface ClabActionResult {
    ok: boolean
    message: string
    sessionId?: string
}

export interface ClabContainer {
    name: string
    state: string
    ipv4Address: string
    ipv6Address: string
    kind: string
    image: string
}

export interface ClabInspectResult {
    ok: boolean
    message: string
    containers: ClabContainer[]
}

export interface ClabImageStatus {
    name: string
    available: boolean
    size: string
}

export interface ClabCheckImagesResult {
    images: ClabImageStatus[]
}

export interface ClabPullImageRequest {
    image: string
}

export interface ClabConsoleRequest {
    containerName: string
    kind?: string
}

export interface ClabEnableInterfacesRequest {
    containerName: string
    kind: string
    linkCount: number
}

export interface ClabLoadImageResult {
    ok: boolean
    message: string
    imageName: string
}

// ── Containerlab server management ──────────────────────────────────────────

export interface ClabServerProfile {
    id: string
    name: string
    type: 'local' | 'ssh'
    host?: string
    port?: number
    username?: string
    remoteLabDir?: string
}

export interface ClabServerListResult {
    profiles: ClabServerProfile[]
    activeServerId: string
}

export interface DockerImageInfo {
    name: string
    id: string
    size: string
    created: string
    arch: string
    archMismatch: boolean
}

export interface DockerListImagesResult {
    images: DockerImageInfo[]
    hostArch: string
    error?: string
}

export interface ClabServerTestResult {
    ok: boolean
    ssh: boolean
    docker: boolean
    clab: boolean
    message: string
}

export interface ClabDetectedLab {
    labName: string
    topoFile: string
    containers: ClabContainer[]
}

export interface ClabDetectRunningResult {
    ok: boolean
    message?: string
    labs: ClabDetectedLab[]
}

export interface NetopsAPI {
    saveTopology(json: string, name: string): Promise<SaveTopologyResult>
    saveTopologyDirect(json: string, filePath: string): Promise<SaveTopologyResult>
    loadTopology(): Promise<LoadTopologyResult>
    openInNewWindow(json: string): Promise<OpenInNewWindowResult>
    saveWorkspace(json: string, name: string): Promise<SaveTopologyResult>
    saveWorkspaceDirect(json: string, filePath: string): Promise<SaveTopologyResult>
    loadWorkspace(): Promise<LoadTopologyResult>
    sshTestConnection(params: NetopsSshRequest): Promise<NetopsSshResult>
    sshRunShowVersion(params: NetopsSshRequest): Promise<NetopsSshResult>
    openSshTerminal(params: NetopsSshTerminalRequest): Promise<NetopsSshTerminalResult>

    // ── Inventory management ──────────────────────────────────────────────
    sshRunCommand(params: NetopsSshCommandRequest): Promise<NetopsSshResult>
    sshRunCommands(params: NetopsSshMultiCommandRequest): Promise<NetopsSshMultiResult>
    sshShellSession(params: NetopsSshShellRequest): Promise<NetopsSshResult>
    inventorySave(json: string, filePath: string): Promise<{ ok: boolean; message?: string }>
    inventoryLoad(filePath: string): Promise<{ ok: boolean; json?: string; message?: string }>
    inventoryExportConfig(content: string, defaultName: string): Promise<{ ok: boolean; filePath?: string }>
    fileHash(content: string): Promise<{ hash: string }>

    // ── Containerlab lab management ─────────────────────────────────────
    clabCheckImages(params: { images: string[] }): Promise<ClabCheckImagesResult>
    clabPullImage(params: ClabPullImageRequest): Promise<ClabActionResult>
    clabLoadImage(params?: { imageName?: string }): Promise<ClabLoadImageResult>
    clabCheckPrereqs(): Promise<ClabPrereqResult>
    clabStartDocker(): Promise<ClabActionResult>
    clabAutoInstall(): Promise<ClabActionResult>
    clabSaveTopology(params: ClabSaveRequest): Promise<ClabSaveResult>
    clabDeploy(params: ClabActionRequest): Promise<ClabActionResult>
    clabDestroy(params: ClabActionRequest): Promise<ClabActionResult>
    clabInspect(params: ClabActionRequest): Promise<ClabInspectResult>
    clabDetectRunning(): Promise<ClabDetectRunningResult>
    clabDestroyLab(params: { labName: string }): Promise<ClabActionResult>
    clabParseTopology(params: ClabActionRequest): Promise<ClabParseTopologyResult>
    clabEnableInterfaces(params: ClabEnableInterfacesRequest): Promise<ClabActionResult>
    openContainerConsole(params: ClabConsoleRequest): Promise<ClabActionResult>

    // ── Containerlab server management ────────────────────────────────────
    clabServerList(): Promise<ClabServerListResult>
    clabServerSave(params: { profile: ClabServerProfile }): Promise<{ ok: boolean; message?: string }>
    clabServerDelete(params: { id: string }): Promise<{ ok: boolean; message?: string }>
    clabServerSetActive(params: { id: string }): Promise<{ ok: boolean; message?: string }>
    clabServerTest(params: { id: string }): Promise<ClabServerTestResult>

    // ── Docker Image Manager ─────────────────────────────────────────────
    dockerListImages(): Promise<DockerListImagesResult>
    dockerDeleteImage(params: { image: string }): Promise<{ ok: boolean; message?: string }>
    dockerTagImage(params: { source: string; target: string }): Promise<{ ok: boolean; message?: string }>

    // ── Container control (start / stop / pause / unpause) ──────────────
    clabContainerStart(params: { container: string }): Promise<{ ok: boolean; message?: string }>
    clabContainerStop(params: { container: string }): Promise<{ ok: boolean; message?: string }>
    clabContainerSuspend(params: { container: string; suspend: boolean }): Promise<{ ok: boolean; message?: string }>

    // ── Config snippet library ────────────────────────────────────────────
    snippetLoadAll(): Promise<{ ok: boolean; snippets: any[]; message?: string }>
    snippetSave(snippets: any[]): Promise<{ ok: boolean; message?: string }>
    snippetDelete(id: string): Promise<{ ok: boolean; message?: string }>

    // ── SNMP polling ──────────────────────────────────────────────────────
    snmpGet(params: any): Promise<{ ok: boolean; message: string; data?: any[] }>
    snmpWalk(params: any): Promise<{ ok: boolean; message: string; data?: any[] }>
    snmpTestConnection(params: any): Promise<{ ok: boolean; message: string; data?: any[] }>

    // ── Embedded terminal (PTY) ────────────────────────────────────────────
    ptyCreate(params: { id: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; cols?: number; rows?: number; label?: string }): Promise<{ ok: boolean; sessionId?: string; message?: string }>
    ptyInput(sessionId: string, data: string): void
    ptyResize(sessionId: string, cols: number, rows: number): void
    ptyDestroy(sessionId: string): Promise<{ ok: boolean }>
    onPtyData(cb: (sessionId: string, data: string) => void): void
    onPtyExit(cb: (sessionId: string, exitCode: number) => void): void
    offPtyListeners(): void

    // ── Syslog server ─────────────────────────────────────────────────────
    syslogStart(port?: number): Promise<{ ok: boolean; message: string }>
    syslogStop(): Promise<{ ok: boolean; message: string }>
    syslogStatus(): Promise<{ running: boolean }>
    onSyslogMessage(cb: (msg: any) => void): void
    offSyslogMessage(): void
}

declare global {
    interface Window {
        netopsAPI?: NetopsAPI
    }
}

export {}
