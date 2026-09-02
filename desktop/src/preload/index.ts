import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createCoreBridge } from './core-ipc'
import { createCoreEventBridge } from './core-events'
import { createTerminalEventBridge } from './terminal-events'

// Expose a minimal, read-only desktop surface to the renderer.
contextBridge.exposeInMainWorld('cairn', {
  version: '0.1.0',
  platform: process.platform,
  sandboxed: process.sandboxed === true,
  selectDirectory: () => ipcRenderer.invoke('cairn:select-directory'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openPath: (target: string) => ipcRenderer.invoke('cairn:open-path', target),
  windowAction: (action: 'minimize' | 'toggle-maximize' | 'close' | 'quit') =>
    ipcRenderer.invoke('cairn:window-action', action),
  ...createCoreBridge(ipcRenderer),
  ...createCoreEventBridge(ipcRenderer),
  ...createTerminalEventBridge(ipcRenderer),
})
