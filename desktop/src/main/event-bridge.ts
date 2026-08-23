import { CORE_EVENT_CHANNEL } from '../shared/ipc-contract'

export interface WebContentsLike {
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
}

export class CoreEventBridge {
  private readonly targets = new Set<WebContentsLike>()

  attach(webContents: WebContentsLike): void {
    if (!webContents.isDestroyed?.()) this.targets.add(webContents)
  }

  detach(webContents: WebContentsLike): void {
    this.targets.delete(webContents)
  }

  emit(event: Record<string, unknown>): void {
    for (const target of [...this.targets]) {
      if (target.isDestroyed?.()) {
        this.targets.delete(target)
        continue
      }
      target.send(CORE_EVENT_CHANNEL, event)
    }
  }

  sink(): (event: Record<string, unknown>) => void {
    return (event) => this.emit(event)
  }

  size(): number {
    return this.targets.size
  }
}
