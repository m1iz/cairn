// @vitest-environment jsdom
import { createApp } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DesktopChromeBar from './DesktopChromeBar.vue'

vi.mock('vue-router', () => ({
  useRouter: () => ({ go: vi.fn() }),
}))

let container: HTMLDivElement | null = null

beforeEach(() => {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Windows',
  })
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  container?.remove()
  container = null
})

describe('DesktopChromeBar menus', () => {
  it('stays open across pointer movement and closes on an outside click', async () => {
    const app = createApp(DesktopChromeBar)
    app.mount(container!)

    const fileButton = [...container!.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '文件',
    )!
    fileButton.click()
    await Promise.resolve()
    expect(container!.querySelector('.desktop-chrome-menu-popover')).not.toBeNull()

    container!
      .querySelector('.desktop-chrome-bar')!
      .dispatchEvent(new MouseEvent('mouseleave'))
    await Promise.resolve()
    expect(container!.querySelector('.desktop-chrome-menu-popover')).not.toBeNull()

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await Promise.resolve()
    expect(container!.querySelector('.desktop-chrome-menu-popover')).toBeNull()

    app.unmount()
  })

  it('closes after choosing an item or pressing Escape', async () => {
    const app = createApp(DesktopChromeBar)
    app.mount(container!)

    const fileButton = [...container!.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '文件',
    )!
    fileButton.click()
    await Promise.resolve()
    const newChat = [...container!.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '新建对话',
    )!
    newChat.click()
    await Promise.resolve()
    expect(container!.querySelector('.desktop-chrome-menu-popover')).toBeNull()

    fileButton.click()
    await Promise.resolve()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await Promise.resolve()
    expect(container!.querySelector('.desktop-chrome-menu-popover')).toBeNull()

    app.unmount()
  })
})
