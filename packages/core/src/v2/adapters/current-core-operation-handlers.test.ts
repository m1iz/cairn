import { describe, expect, it } from 'vitest'
import type { CoreApi } from '../../api/core-api'
import { coreOperationKeys } from '../../api/operations'
import {
  createCurrentCoreOperationHandlers,
  groupCoreOperationHandlers,
} from './current-core-operation-handlers'

describe('current Core domain operation handlers', () => {
  it('partitions the frozen operation surface without gaps or duplicates', () => {
    const handlers = createCurrentCoreOperationHandlers({} as CoreApi)
    const grouped = groupCoreOperationHandlers(handlers)
    const flattened = [...grouped.values()].flatMap((group) =>
      group.map(({ operation }) => operation),
    )

    expect(new Set(flattened).size).toBe(flattened.length)
    expect(flattened.sort()).toEqual(coreOperationKeys())
    expect(grouped.get('control')?.map(({ operation }) => operation)).toEqual([
      'control.answerInteraction',
      'control.approvePlan',
      'control.cancelInteraction',
      'control.commentPlan',
      'control.get',
      'control.setMode',
      'control.setPermissionMode',
    ])
    expect(grouped.get('lifecycle')?.map(({ operation }) => operation)).toEqual(
      ['bootstrap'],
    )
  })
})
