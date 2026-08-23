// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import GoalCard from './GoalCard.vue'
import type { GoalCardViewModel } from '../../runtime/goalRender'

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

describe('GoalCard DOM contract', () => {
  it('places the Goal card above the plan in Project Execution', () => {
    const panel = source('../panels/ProjectExecutionPanel.vue')
    expect(panel).toContain('<GoalCard')
    expect(panel.indexOf('<GoalCard')).toBeLessThan(
      panel.indexOf('pe-plan-head'),
    )
  })

  it('uses semantic actions, accessible labels and a confirmation step', () => {
    const card = source('./GoalCard.vue')
    expect(card).toContain('<GoalAcceptanceMatrix')
    expect(card).toContain(':aria-label="actionLabel(action)"')
    expect(card).toContain('confirmCancel')
    expect(card).toContain("emit('action'")
    expect(card).not.toContain('phase:')
    expect(card).not.toContain('evidence:')
  })

  it('resets cancel confirmation when the rendered Goal identity changes', async () => {
    const model = ref(cardModel('goal-a'))
    const onAction = vi.fn()
    const Root = defineComponent(
      () => () => h(GoalCard, { model: model.value, onAction }),
    )
    const container = document.createElement('div')
    document.body.append(container)
    const app = createApp(Root)
    app.mount(container)

    const cancel = container.querySelector<HTMLButtonElement>(
      '[aria-label="取消 Goal"]',
    )
    expect(cancel).not.toBeNull()
    cancel!.click()
    await nextTick()
    expect(
      container.querySelector('[aria-label="确认取消 Goal"]'),
    ).not.toBeNull()

    model.value = cardModel('goal-b')
    await nextTick()
    expect(container.querySelector('[aria-label="确认取消 Goal"]')).toBeNull()
    expect(container.querySelector('[aria-label="取消 Goal"]')).not.toBeNull()
    expect(onAction).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })
})

function cardModel(id: string): GoalCardViewModel {
  return {
    id,
    outcome: `Outcome ${id}`,
    statusLabel: '进行中',
    phaseLabel: '执行中',
    cycleLabel: '第 1 轮',
    acceptanceRows: [],
    currentPlan: null,
    notice: null,
    actions: ['pause', 'cancel'],
    terminal: false,
  }
}
