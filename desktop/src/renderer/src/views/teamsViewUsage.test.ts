import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('TeamsView product boundary', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./TeamsView.vue', import.meta.url)),
    'utf8',
  )

  it('creates global Teams without requiring a project or exposing prompt editing', () => {
    expect(source).toContain('创建你的第一个 Team')
    expect(source).toContain('不需要编写系统提示词')
    expect(source).not.toContain('请先打开一个项目会话')
    expect(source).not.toContain('systemPrompt')
  })

  it('uses the Cairn selector and a bounded two-step member flow', () => {
    expect(source).toContain('<CairnSelect')
    expect(source).not.toContain('<select')
    expect(source).toContain('1 基本信息')
    expect(source).toContain('2 团队成员')
    expect(source).toContain('form.members.length < 6')
  })

  it('keeps Team history and member evidence understandable without deleting audit data', () => {
    expect(source).toContain(
      '显示 ${historicalIssueRuns.length} 条历史异常记录',
    )
    expect(source).toContain('Cairn · 自动汇总')
    expect(source).toContain('查看成员原始报告')
    expect(source).toContain('member-detail-toolbar')
    expect(source).toContain('position: sticky')
  })

  it('uses borderless Cairn selectors only in the lightweight conversation header', () => {
    expect(source.match(/variant="plain"/g)).toHaveLength(2)
    expect(source).toContain('class="tool-button team-head-action"')
  })
})
