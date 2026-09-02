import { describe, expect, it, vi } from 'vitest'
import {
  hideWindowForTray,
  revealMainWindow,
  shouldKeepRunningInTray,
  type MainWindowPresence,
} from './window-presence'

describe('desktop tray window presence', () => {
  it('keeps only a non-quitting Windows host alive when the tray exists', () => {
    expect(
      shouldKeepRunningInTray({
        platform: 'win32',
        quitting: false,
        trayAvailable: true,
      }),
    ).toBe(true)
    expect(
      shouldKeepRunningInTray({
        platform: 'win32',
        quitting: true,
        trayAvailable: true,
      }),
    ).toBe(false)
    expect(
      shouldKeepRunningInTray({
        platform: 'win32',
        quitting: false,
        trayAvailable: false,
      }),
    ).toBe(false)
    expect(
      shouldKeepRunningInTray({
        platform: 'linux',
        quitting: false,
        trayAvailable: true,
      }),
    ).toBe(false)
  })

  it('prevents a close and hides the main window without destroying it', () => {
    const window = fakeWindow()
    const preventDefault = vi.fn()

    hideWindowForTray({ preventDefault }, window.value)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()
    expect(window.show).not.toHaveBeenCalled()
  })

  it('restores, shows and focuses a hidden or minimized window', () => {
    const window = fakeWindow({ minimized: true })

    expect(revealMainWindow(window.value)).toBe(true)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('does not touch a destroyed window', () => {
    const window = fakeWindow({ destroyed: true })

    expect(revealMainWindow(window.value)).toBe(false)
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })
})

function fakeWindow(opts: { minimized?: boolean; destroyed?: boolean } = {}): {
  value: MainWindowPresence
  hide: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
} {
  const hide = vi.fn()
  const restore = vi.fn()
  const show = vi.fn()
  const focus = vi.fn()
  return {
    value: {
      isDestroyed: () => opts.destroyed === true,
      isMinimized: () => opts.minimized === true,
      hide,
      restore,
      show,
      focus,
    },
    hide,
    restore,
    show,
    focus,
  }
}
