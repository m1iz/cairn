export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean
  on(event: 'second-instance', listener: () => void): unknown
  quit(): void
}

export interface ExistingMainWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

/**
 * Claims Electron's per-user application lock before Core opens writable
 * state. A second launch exits without initializing Core; the primary launch
 * restores and focuses its existing window instead.
 */
export function installSingleInstanceGuard(
  app: SingleInstanceApp,
  currentWindow: () => ExistingMainWindow | null,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }

  app.on('second-instance', () => {
    const window = currentWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  return true
}
