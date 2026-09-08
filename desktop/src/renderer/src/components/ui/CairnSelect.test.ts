// @vitest-environment jsdom
import { createApp, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import CairnSelect from './CairnSelect.vue'

let container: HTMLDivElement | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  container?.remove()
  container = null
})

describe('CairnSelect', () => {
  it('stays open during pointer movement, selects an option, and closes outside', async () => {
    const value = ref('reader')
    const app = createApp({
      setup: () => () =>
        h(CairnSelect, {
          modelValue: value.value,
          options: [
            { value: 'reader', label: '代码探索', description: '只读' },
            { value: 'coder', label: '实现工程', description: '可修改' },
          ],
          'onUpdate:modelValue': (next: string) => {
            value.value = next
          },
        }),
    })
    app.mount(container!)

    ;(
      container!.querySelector('.cairn-select-trigger') as HTMLButtonElement
    ).click()
    await Promise.resolve()
    expect(container!.querySelector('.cairn-select-menu')).not.toBeNull()

    container!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    await Promise.resolve()
    expect(container!.querySelector('.cairn-select-menu')).not.toBeNull()

    const coder = [...container!.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent?.includes('实现工程'),
    ) as HTMLButtonElement
    coder.click()
    await Promise.resolve()
    expect(value.value).toBe('coder')
    expect(container!.querySelector('.cairn-select-menu')).toBeNull()

    ;(
      container!.querySelector('.cairn-select-trigger') as HTMLButtonElement
    ).click()
    await Promise.resolve()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await Promise.resolve()
    expect(container!.querySelector('.cairn-select-menu')).toBeNull()

    app.unmount()
  })
})
