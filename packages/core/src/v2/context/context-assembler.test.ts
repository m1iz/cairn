import { describe, expect, it } from 'vitest'
import { ContextAssemblerV2 } from './context-assembler'

describe('ContextAssemblerV2', () => {
  it('renders present fragments in decision order and audits absent includes', () => {
    const result = new ContextAssemblerV2().assemble({
      fragments: [
        {
          id: 'memory',
          kind: 'memory',
          source: 'memory.md',
          content: 'Memory',
        },
        {
          id: 'bootstrap',
          kind: 'bootstrap',
          source: 'base.md',
          content: 'Base',
        },
        { id: 'extra', kind: 'extra', source: 'extra.md', content: 'Extra' },
      ],
      decisions: [
        {
          id: 'bootstrap',
          kind: 'bootstrap',
          source: 'base.md',
          action: 'include',
          reason: 'required',
        },
        {
          id: 'missing',
          kind: 'history',
          source: 'history.jsonl',
          action: 'include',
          reason: 'dynamic',
        },
        {
          id: 'memory',
          kind: 'memory',
          source: 'memory.md',
          action: 'include',
          reason: 'selected',
        },
      ],
    })

    expect(result.prompt).toBe('Base\n\n---\n\nMemory')
    expect(result.rendered.map((entry) => entry.id)).toEqual([
      'bootstrap',
      'missing',
      'memory',
    ])
    expect(result.omitted).toContainEqual(
      expect.objectContaining({ id: 'extra', reason: 'not_in_context_plan' }),
    )
  })

  it('includes all fragments in source order when no plan exists', () => {
    const result = new ContextAssemblerV2().assemble({
      fragments: [
        { id: 'one', kind: 'one', source: 'one.md', content: 'One' },
        { id: 'two', kind: 'two', source: 'two.md', content: 'Two' },
      ],
    })
    expect(result.prompt).toBe('One\n\n---\n\nTwo')
    expect(result.rendered).toHaveLength(2)
    expect(result.omitted).toEqual([])
  })
})
