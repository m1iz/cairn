/**
 * 类型化事件总线 (MIG-FND-005)。
 *
 * 承载 runtime 事件流（替代 Python 的 emit 回调链）。W15 由 Electron 主进程把事件桥到
 * 渲染层 IPC；进程内订阅，无需 WS/last_seq。
 */

export type Unsubscribe = () => void

/** 事件映射：事件名 → payload 类型。具体事件在 W14 (runtime/events) 填充。 */
export type EventMap = Record<string, unknown>

export class EventBus<E extends EventMap> {
  #handlers: { [K in keyof E]?: Set<(payload: E[K]) => void> } = {}
  #any: Set<(name: keyof E, payload: E[keyof E]) => void> = new Set()

  on<K extends keyof E>(
    name: K,
    handler: (payload: E[K]) => void,
  ): Unsubscribe {
    const set = (this.#handlers[name] ??= new Set())
    set.add(handler)
    return () => set.delete(handler)
  }

  once<K extends keyof E>(
    name: K,
    handler: (payload: E[K]) => void,
  ): Unsubscribe {
    const off = this.on(name, (payload) => {
      off()
      handler(payload)
    })
    return off
  }

  /** 订阅所有事件（事件桥用）。 */
  onAny(handler: (name: keyof E, payload: E[keyof E]) => void): Unsubscribe {
    this.#any.add(handler)
    return () => this.#any.delete(handler)
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    this.#handlers[name]?.forEach((h) => h(payload))
    this.#any.forEach((h) => h(name, payload as E[keyof E]))
  }
}
