import type { Ref } from 'vue'
import type { BootstrapPayload, RuntimeHistoryItem } from './types'

interface StartupSessionStore {
  activeId: Ref<string>
  load: () => Promise<void>
  backendSessionId: () => string
  isDraftSessionId: (id: string) => boolean
}

interface StartupBootstrap {
  boot: Ref<BootstrapPayload | null>
  error: Ref<string>
  loadBootstrap: (showLoading?: boolean, sessionId?: string) => Promise<void>
}

export interface InitialStartupDeps {
  sessionStore: StartupSessionStore
  bootstrap: StartupBootstrap
  switchSession: (sessionId: string) => void
  restoreFromHistory: (history: RuntimeHistoryItem[]) => void
  connectSocket: () => void
}

export async function runInitialStartup({
  sessionStore,
  bootstrap,
  switchSession,
  restoreFromHistory,
  connectSocket,
}: InitialStartupDeps): Promise<void> {
  try {
    await sessionStore.load()
  } catch {
    await bootstrap.loadBootstrap(true, '')
    return
  }

  if (sessionStore.activeId.value) switchSession(sessionStore.activeId.value)
  await bootstrap.loadBootstrap(true, sessionStore.backendSessionId())
  if (bootstrap.error.value) return

  if (!sessionStore.isDraftSessionId(sessionStore.activeId.value)) {
    restoreFromHistory(bootstrap.boot.value?.unarchivedHistory || [])
  }
  connectSocket()
}
