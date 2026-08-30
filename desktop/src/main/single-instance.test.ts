import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  installSingleInstanceGuard,
  type ExistingMainWindow,
  type SingleInstanceApp,
} from './single-instance'

describe('desktop single-instance guard', () => {
  it('is installed before the Electron ready lifecycle starts Core', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
    const guardOffset = source.indexOf('installSingleInstanceGuard(app')
    const readyOffset = source.indexOf('app.whenReady().then(startup)')

    expect(guardOffset).toBeGreaterThan(-1)
    expect(readyOffset).toBeGreaterThan(guardOffset)
    expect(source).toContain('if (isPrimaryInstance)')
  })

  it('quits a secondary launch before it can initialize Core state', () => {
    const app = fakeApp(false)

    expect(installSingleInstanceGuard(app.value, () => null)).toBe(false)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.listener()).toBeNull()
  })

  it('restores and focuses the primary window after a second launch', () => {
    const app = fakeApp(true)
    const window = fakeWindow({ minimized: true })

    expect(installSingleInstanceGuard(app.value, () => window.value)).toBe(true)
    app.listener()?.()

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('does not touch a destroyed primary window', () => {
    const app = fakeApp(true)
    const window = fakeWindow({ destroyed: true })

    installSingleInstanceGuard(app.value, () => window.value)
    app.listener()?.()

    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })
})

function fakeApp(granted: boolean): {
  value: SingleInstanceApp
  quit: ReturnType<typeof vi.fn>
  listener: () => (() => void) | null
} {
  let secondInstanceListener: (() => void) | null = null
  const quit = vi.fn()
  return {
    value: {
      requestSingleInstanceLock: () => granted,
      on: (_event, listener) => {
        secondInstanceListener = listener
      },
      quit,
    },
    quit,
    listener: () => secondInstanceListener,
  }
}

function fakeWindow(opts: { minimized?: boolean; destroyed?: boolean } = {}): {
  value: ExistingMainWindow
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
} {
  const restore = vi.fn()
  const show = vi.fn()
  const focus = vi.fn()
  return {
    value: {
      isDestroyed: () => opts.destroyed === true,
      isMinimized: () => opts.minimized === true,
      restore,
      show,
      focus,
    },
    restore,
    show,
    focus,
  }
}
