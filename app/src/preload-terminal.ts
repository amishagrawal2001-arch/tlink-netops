/**
 * Preload script for standalone terminal windows.
 * Exposes minimal PTY IPC to the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('terminalAPI', {
    ptyInput: (sessionId: string, data: string): void => {
        ipcRenderer.send('pty-input', sessionId, data)
    },
    ptyResize: (sessionId: string, cols: number, rows: number): void => {
        ipcRenderer.send('pty-resize', sessionId, cols, rows)
    },
    onPtyData: (cb: (sessionId: string, data: string) => void): void => {
        ipcRenderer.on('pty-data', (_e, sid, data) => cb(sid, data))
    },
    onPtyExit: (cb: (sessionId: string, exitCode: number) => void): void => {
        ipcRenderer.on('pty-exit', (_e, sid, exitCode) => cb(sid, exitCode))
    },
})
