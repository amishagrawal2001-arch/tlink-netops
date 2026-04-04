import { contextBridge, ipcRenderer } from 'electron'

interface SshRequest {
    host: string
    port?: number
    username: string
    password: string
    timeoutMs?: number
}

interface SshResult {
    ok: boolean
    message: string
    output?: string
}

interface SshTerminalRequest {
    host: string
    port?: number
    username: string
}

interface SshTerminalResult {
    ok: boolean
    message: string
}

interface SshCommandRequest extends SshRequest {
    command: string
}

interface SshMultiCommandRequest extends SshRequest {
    commands: string[]
}

interface SshMultiResult {
    ok: boolean
    message: string
    results: SshResult[]
}

contextBridge.exposeInMainWorld('netopsAPI', {
    saveTopology: (json: string, name: string) =>
        ipcRenderer.invoke('save-topology', json, name),
    saveTopologyDirect: (json: string, filePath: string) =>
        ipcRenderer.invoke('save-topology-direct', json, filePath),
    loadTopology: () =>
        ipcRenderer.invoke('load-topology'),
    openInNewWindow: (json: string) =>
        ipcRenderer.invoke('open-in-new-window', json),
    openHelpWindow: () =>
        ipcRenderer.invoke('open-help-window'),
    closeHelpWindow: () =>
        ipcRenderer.invoke('close-help-window'),
    saveWorkspace: (json: string, name: string) =>
        ipcRenderer.invoke('save-workspace', json, name),
    saveWorkspaceDirect: (json: string, filePath: string) =>
        ipcRenderer.invoke('save-workspace-direct', json, filePath),
    loadWorkspace: () =>
        ipcRenderer.invoke('load-workspace'),
    sshTestConnection: (params: SshRequest): Promise<SshResult> =>
        ipcRenderer.invoke('ssh-test-connection', params),
    sshRunShowVersion: (params: SshRequest): Promise<SshResult> =>
        ipcRenderer.invoke('ssh-run-show-version', params),
    openSshTerminal: (params: SshTerminalRequest): Promise<SshTerminalResult> =>
        ipcRenderer.invoke('open-ssh-terminal', params),

    // ── Streaming SSH ─────────────────────────────────────────────────────
    sshRunCommandStream: (
        params: SshCommandRequest,
        onChunk: (chunk: string) => void,
    ): Promise<SshResult> => {
        const id = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        ipcRenderer.on(`ssh-stream-${id}`, (_e: any, chunk: string) => onChunk(chunk))
        return ipcRenderer.invoke('ssh-run-command-stream', { ...params, streamId: id }).then((result: SshResult) => {
            ipcRenderer.removeAllListeners(`ssh-stream-${id}`)
            return result
        })
    },

    // ── Inventory management ──────────────────────────────────────────────
    sshRunCommand: (params: SshCommandRequest): Promise<SshResult> =>
        ipcRenderer.invoke('ssh-run-command', params),
    sshRunCommands: (params: SshMultiCommandRequest): Promise<SshMultiResult> =>
        ipcRenderer.invoke('ssh-run-commands', params),
    sshShellSession: (params: SshMultiCommandRequest & { delayMs?: number }): Promise<SshResult> =>
        ipcRenderer.invoke('ssh-shell-session', params),
    sshShellSessionViaBastion: (params: {
        bastion: { host: string; port?: number; username: string; password: string }
        target: { host: string; port?: number; username: string; password: string }
        commands: string[]
        delayMs?: number
    }): Promise<SshResult> =>
        ipcRenderer.invoke('ssh-shell-session-via-bastion', params),
    sshExecMulti: (params: SshMultiCommandRequest): Promise<SshResult> =>
        ipcRenderer.invoke('ssh-exec-multi', params),
    inventorySave: (json: string, filePath: string): Promise<{ ok: boolean; message?: string }> =>
        ipcRenderer.invoke('inventory-save', json, filePath),
    inventoryLoad: (filePath: string): Promise<{ ok: boolean; json?: string; message?: string }> =>
        ipcRenderer.invoke('inventory-load', filePath),
    inventoryExportConfig: (content: string, defaultName: string): Promise<{ ok: boolean; filePath?: string }> =>
        ipcRenderer.invoke('inventory-export-config', content, defaultName),
    fileHash: (content: string): Promise<{ hash: string }> =>
        ipcRenderer.invoke('file-hash', content),

    // ── Containerlab lab management ─────────────────────────────────────
    clabCheckImages: (params: { images: string[] }): Promise<any> =>
        ipcRenderer.invoke('clab-check-images', params),
    clabPullImage: (params: { image: string }): Promise<any> =>
        ipcRenderer.invoke('clab-pull-image', params),
    clabLoadImage: (params?: { imageName?: string }): Promise<any> =>
        ipcRenderer.invoke('clab-load-image', params ?? {}),
    onDockerProgress: (cb: (msg: string) => void): void => {
        ipcRenderer.on('docker-progress', (_e: any, msg: string) => cb(msg))
    },
    offDockerProgress: (): void => {
        ipcRenderer.removeAllListeners('docker-progress')
    },
    clabCheckPrereqs: (): Promise<any> =>
        ipcRenderer.invoke('clab-check-prereqs'),
    clabStartDocker: (): Promise<any> =>
        ipcRenderer.invoke('clab-start-docker'),
    clabAutoInstall: (): Promise<any> =>
        ipcRenderer.invoke('clab-auto-install'),
    clabSaveTopology: (params: { content: string; labName: string; labDir?: string; extraFiles?: Array<{ name: string; content: string }> }): Promise<any> =>
        ipcRenderer.invoke('clab-save-topology', params),
    clabDeploy: (params: { filePath: string }): Promise<any> =>
        ipcRenderer.invoke('clab-deploy', params),
    clabSaveTopologyToServer: (params: { content: string; labName: string; serverId: string; extraFiles?: Array<{ name: string; content: string }> }): Promise<any> =>
        ipcRenderer.invoke('clab-save-topology-to-server', params),
    clabDeployToServer: (params: { filePath: string; serverId: string }): Promise<any> =>
        ipcRenderer.invoke('clab-deploy-to-server', params),
    clabDestroy: (params: { filePath: string }): Promise<any> =>
        ipcRenderer.invoke('clab-destroy', params),
    clabInspect: (params: { filePath: string }): Promise<any> =>
        ipcRenderer.invoke('clab-inspect', params),
    clabDetectRunning: (): Promise<any> =>
        ipcRenderer.invoke('clab-detect-running'),
    clabDestroyLab: (params: { labName: string }): Promise<any> =>
        ipcRenderer.invoke('clab-destroy-lab', params),
    clabParseTopology: (params: { filePath: string }): Promise<any> =>
        ipcRenderer.invoke('clab-parse-topology', params),
    clabPollLiveStatus: (params: { containers: Array<{ name: string; kind: string }> }): Promise<any> =>
        ipcRenderer.invoke('clab-poll-live-status', params),
    clabEnableInterfaces: (params: { containerName: string; kind: string; linkCount: number }): Promise<any> =>
        ipcRenderer.invoke('clab-enable-interfaces', params),
    openContainerConsole: (params: { containerName: string; kind?: string }): Promise<any> =>
        ipcRenderer.invoke('open-container-console', params),
    clabPushConfig: (params: { containerName: string; kind: string; configLines: string[] }): Promise<any> =>
        ipcRenderer.invoke('clab-push-config', params),
    clabFetchConfig: (params: { containerName: string; kind: string }): Promise<any> =>
        ipcRenderer.invoke('clab-fetch-config', params),

    // ── Containerlab server management ────────────────────────────────────
    clabServerList: (): Promise<any> =>
        ipcRenderer.invoke('clab-server-list'),
    clabServerSave: (params: { profile: any }): Promise<any> =>
        ipcRenderer.invoke('clab-server-save', params),
    clabServerDelete: (params: { id: string }): Promise<any> =>
        ipcRenderer.invoke('clab-server-delete', params),
    clabServerSetActive: (params: { id: string }): Promise<any> =>
        ipcRenderer.invoke('clab-server-set-active', params),
    clabServerTest: (params: { id: string }): Promise<any> =>
        ipcRenderer.invoke('clab-server-test', params),
    clabServerHeartbeat: (): Promise<any> =>
        ipcRenderer.invoke('clab-server-heartbeat'),
    clabServerResources: (): Promise<any> =>
        ipcRenderer.invoke('clab-server-resources'),
    clabListHostInterfaces: (params?: { serverId?: string }): Promise<any> =>
        ipcRenderer.invoke('clab-list-host-interfaces', params ?? {}),
    clabValidateHostInterfaces: (params: { interfaces: string[]; serverId?: string }): Promise<any> =>
        ipcRenderer.invoke('clab-validate-host-interfaces', params),
    clabValidateBridges: (params: { bridges: string[]; serverId?: string }): Promise<any> =>
        ipcRenderer.invoke('clab-validate-bridges', params),

    // ── Docker Image Manager ─────────────────────────────────────────────
    dockerListImages: (): Promise<any> =>
        ipcRenderer.invoke('docker-list-images'),
    dockerSystemDf: (): Promise<any> =>
        ipcRenderer.invoke('docker-system-df'),
    dockerSearch: (params: { term: string }): Promise<any> =>
        ipcRenderer.invoke('docker-search', params),
    dockerDeleteImage: (params: { image: string }): Promise<any> =>
        ipcRenderer.invoke('docker-delete-image', params),
    dockerDeleteImages: (params: { images: string[] }): Promise<any> =>
        ipcRenderer.invoke('docker-delete-images', params),
    dockerTagImage: (params: { source: string; target: string }): Promise<any> =>
        ipcRenderer.invoke('docker-tag-image', params),

    // ── vrnetlab Image Builder ──────────────────────────────────────────
    vrnetlabVendors: (): Promise<any> =>
        ipcRenderer.invoke('vrnetlab-vendors'),
    vrnetlabSelectImage: (): Promise<any> =>
        ipcRenderer.invoke('vrnetlab-select-image'),
    vrnetlabBuildImage: (params: { vendor: string; vmImagePath: string }): Promise<any> =>
        ipcRenderer.invoke('vrnetlab-build-image', params),

    // ── Libvirt / virsh VM Management ───────────────────────────────────
    virshList: (): Promise<any> =>
        ipcRenderer.invoke('virsh-list'),
    virshAction: (params: { vm: string; action: string }): Promise<any> =>
        ipcRenderer.invoke('virsh-action', params),
    virshInfo: (params: { vm: string }): Promise<any> =>
        ipcRenderer.invoke('virsh-info', params),
    virshConsole: (params: { vm: string }): Promise<any> =>
        ipcRenderer.invoke('virsh-console', params),
    virshSnapshotList: (params: { vm: string }): Promise<any> =>
        ipcRenderer.invoke('virsh-snapshot-list', params),
    virshSnapshotCreate: (params: { vm: string; name?: string }): Promise<any> =>
        ipcRenderer.invoke('virsh-snapshot-create', params),
    virshSnapshotRevert: (params: { vm: string; name: string }): Promise<any> =>
        ipcRenderer.invoke('virsh-snapshot-revert', params),
    virshCreateVm: (params: { name: string; cpu: number; memoryMb: number; diskPath: string; networkBridge?: string }): Promise<any> =>
        ipcRenderer.invoke('virsh-create-vm', params),
    virshDeleteVm: (params: { vm: string; removeStorage?: boolean }): Promise<any> =>
        ipcRenderer.invoke('virsh-delete-vm', params),
    virshSnapshotDelete: (params: { vm: string; name: string }): Promise<any> =>
        ipcRenderer.invoke('virsh-snapshot-delete', params),
    virshAutostart: (params: { vm: string; enable: boolean }): Promise<any> =>
        ipcRenderer.invoke('virsh-autostart', params),
    virshListDiskImages: (): Promise<any> =>
        ipcRenderer.invoke('virsh-list-disk-images'),
    virshUploadDiskImage: (params: { localPath: string }): Promise<any> =>
        ipcRenderer.invoke('virsh-upload-disk-image', params),

    // ── Bridge & Network Management ──────────────────────────────────────
    bridgeList: (params?: { serverId?: string }): Promise<any> =>
        ipcRenderer.invoke('bridge-list', params),
    bridgeCreateLibvirt: (params: { name: string; mode?: string; subnet?: string; dhcp?: boolean; dhcpStart?: string; dhcpEnd?: string; autostart?: boolean }): Promise<any> =>
        ipcRenderer.invoke('bridge-create-libvirt', params),
    bridgeDeleteLibvirt: (params: { name: string }): Promise<any> =>
        ipcRenderer.invoke('bridge-delete-libvirt', params),
    bridgeActionLibvirt: (params: { name: string; action: string; enable?: boolean }): Promise<any> =>
        ipcRenderer.invoke('bridge-action-libvirt', params),
    bridgeCreateLinux: (params: { name: string; ipAddress?: string }): Promise<any> =>
        ipcRenderer.invoke('bridge-create-linux', params),
    bridgeDeleteLinux: (params: { name: string }): Promise<any> =>
        ipcRenderer.invoke('bridge-delete-linux', params),
    bridgeCreateOvs: (params: { name: string; vxlanRemote?: string; vni?: number }): Promise<any> =>
        ipcRenderer.invoke('bridge-create-ovs', params),
    bridgeDeleteOvs: (params: { name: string }): Promise<any> =>
        ipcRenderer.invoke('bridge-delete-ovs', params),
    vxlanSetupTunnel: (params: { bridgeName: string; remoteIp: string; vni?: number; method?: string }): Promise<any> =>
        ipcRenderer.invoke('vxlan-setup-tunnel', params),

    // ── Container Logs ────────────────────────────────────────────────────
    clabContainerLogs: (params: { container: string }): Promise<any> =>
        ipcRenderer.invoke('clab-container-logs', params),

    // ── Lab Snapshots ─────────────────────────────────────────────────────
    clabSnapshotCreate: (params: { containers: string[]; snapshotName?: string }): Promise<any> =>
        ipcRenderer.invoke('clab-snapshot-create', params),
    clabSnapshotList: (params?: { prefix?: string }): Promise<any> =>
        ipcRenderer.invoke('clab-snapshot-list', params ?? {}),

    // ── SFTP File Browser ─────────────────────────────────────────────────
    sftpListDir: (params: { path: string }): Promise<any> =>
        ipcRenderer.invoke('sftp-list-dir', params),
    sftpReadFile: (params: { path: string }): Promise<any> =>
        ipcRenderer.invoke('sftp-read-file', params),
    sftpDeleteFile: (params: { path: string }): Promise<any> =>
        ipcRenderer.invoke('sftp-delete-file', params),

    // ── Topology diff ─────────────────────────────────────────────────────
    clabReadTopologyFile: (params: { filePath: string }): Promise<any> =>
        ipcRenderer.invoke('clab-read-topology-file', params),

    // ── Packet capture ────────────────────────────────────────────────────
    clabStartCapture: (params: { container: string; iface?: string; count?: number }): Promise<any> =>
        ipcRenderer.invoke('clab-start-capture', params),
    clabStopCapture: (params: { captureId: string }): Promise<any> =>
        ipcRenderer.invoke('clab-stop-capture', params),
    onCaptureData: (cb: (data: { captureId: string; line: string }) => void): void => {
        ipcRenderer.on('capture-data', (_e: any, data: any) => cb(data))
    },
    offCaptureData: (): void => {
        ipcRenderer.removeAllListeners('capture-data')
    },

    // ── Container control (start / stop / pause / unpause) ──────────────
    clabContainerStart: (params: { container: string }): Promise<any> =>
        ipcRenderer.invoke('clab-container-start', params),
    clabContainerStop: (params: { container: string }): Promise<any> =>
        ipcRenderer.invoke('clab-container-stop', params),
    clabContainerSuspend: (params: { container: string; suspend: boolean }): Promise<any> =>
        ipcRenderer.invoke('clab-container-suspend', params),

    // ── Config snippet library ────────────────────────────────────────────
    snippetLoadAll: (): Promise<any> =>
        ipcRenderer.invoke('snippet-load-all'),
    snippetSave: (snippets: any[]): Promise<any> =>
        ipcRenderer.invoke('snippet-save', snippets),
    snippetDelete: (id: string): Promise<any> =>
        ipcRenderer.invoke('snippet-delete', id),

    // ── SNMP polling ──────────────────────────────────────────────────────
    snmpGet: (params: any): Promise<any> =>
        ipcRenderer.invoke('snmp-get', params),
    snmpWalk: (params: any): Promise<any> =>
        ipcRenderer.invoke('snmp-walk', params),
    snmpTestConnection: (params: any): Promise<any> =>
        ipcRenderer.invoke('snmp-test-connection', params),

    // ── Embedded terminal (PTY) ────────────────────────────────────────────
    ptyCreate: (params: { id: string; command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; cols?: number; rows?: number; label?: string }): Promise<any> =>
        ipcRenderer.invoke('pty-create', params),
    ptyInput: (sessionId: string, data: string): void => {
        ipcRenderer.send('pty-input', sessionId, data)
    },
    ptyResize: (sessionId: string, cols: number, rows: number): void => {
        ipcRenderer.send('pty-resize', sessionId, cols, rows)
    },
    ptyDestroy: (sessionId: string): Promise<any> =>
        ipcRenderer.invoke('pty-destroy', sessionId),
    onPtyData: (cb: (sessionId: string, data: string) => void): void => {
        ipcRenderer.on('pty-data', (_e: any, sessionId: string, data: string) => cb(sessionId, data))
    },
    onPtyExit: (cb: (sessionId: string, exitCode: number) => void): void => {
        ipcRenderer.on('pty-exit', (_e: any, sessionId: string, exitCode: number) => cb(sessionId, exitCode))
    },
    offPtyListeners: (): void => {
        ipcRenderer.removeAllListeners('pty-data')
        ipcRenderer.removeAllListeners('pty-exit')
    },

    // ── Preferences (persistent across restarts) ───────────────────────────
    prefGet: (key: string): Promise<any> =>
        ipcRenderer.invoke('pref-get', key),
    prefSet: (key: string, value: any): Promise<any> =>
        ipcRenderer.invoke('pref-set', key, value),

    // ── Syslog server ─────────────────────────────────────────────────────
    syslogStart: (port?: number): Promise<any> =>
        ipcRenderer.invoke('syslog-start', port),
    syslogStop: (): Promise<any> =>
        ipcRenderer.invoke('syslog-stop'),
    syslogStatus: (): Promise<any> =>
        ipcRenderer.invoke('syslog-status'),
    onSyslogMessage: (cb: (msg: any) => void): void => {
        ipcRenderer.on('syslog-message', (_e: any, msg: any) => cb(msg))
    },
    offSyslogMessage: (): void => {
        ipcRenderer.removeAllListeners('syslog-message')
    },
})
