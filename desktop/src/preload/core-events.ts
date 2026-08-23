import { CORE_EVENT_CHANNEL } from '../shared/ipc-contract'

export interface CoreEventIpcRendererLike {
  on(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
  removeListener(
    channel: string,
    listener: (event: unknown, payload: unknown) => void,
  ): void
}

export interface CoreEventBridge {
  onCoreEvent(listener: (event: unknown) => void): () => void
}

export function createCoreEventBridge(
  ipcRenderer: CoreEventIpcRendererLike,
): CoreEventBridge {
  return {
    onCoreEvent: (listener) => {
      const wrapped = (_event: unknown, payload: unknown) => listener(payload)
      ipcRenderer.on(CORE_EVENT_CHANNEL, wrapped)
      return () => ipcRenderer.removeListener(CORE_EVENT_CHANNEL, wrapped)
    },
  }
}
