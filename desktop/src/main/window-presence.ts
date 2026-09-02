export interface MainWindowPresence {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  hide(): void
  show(): void
  focus(): void
}

export interface WindowCloseEvent {
  preventDefault(): void
}

export function shouldKeepRunningInTray(input: {
  platform: NodeJS.Platform
  quitting: boolean
  trayAvailable: boolean
}): boolean {
  return input.platform === 'win32' && input.trayAvailable && !input.quitting
}

export function hideWindowForTray(
  event: WindowCloseEvent,
  window: MainWindowPresence,
): void {
  event.preventDefault()
  window.hide()
}

export function revealMainWindow(window: MainWindowPresence | null): boolean {
  if (!window || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
}
