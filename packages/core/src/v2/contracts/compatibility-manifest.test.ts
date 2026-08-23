import { createHash } from 'node:crypto'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { coreOperationKeys } from '../../api/operations'
import type { RuntimeEvent } from '../../runtime/types'
import {
  CORE_OPERATION_COMPATIBILITY,
  RUNTIME_EVENT_COMPATIBILITY,
  RUNTIME_EVENT_NAMES,
} from './compatibility-manifest'

function digest(values: readonly string[]): string {
  return createHash('sha256')
    .update([...values].sort().join('\n'))
    .digest('hex')
}

describe('v2 external compatibility manifest', () => {
  it('freezes every public Core operation name', () => {
    const operations = coreOperationKeys()

    expect(operations).toHaveLength(CORE_OPERATION_COMPATIBILITY.count)
    expect(new Set(operations).size).toBe(operations.length)
    expect(digest(operations)).toBe(CORE_OPERATION_COMPATIBILITY.sha256)
  })

  it('freezes every projected runtime event name', () => {
    expect(RUNTIME_EVENT_NAMES).toHaveLength(RUNTIME_EVENT_COMPATIBILITY.count)
    expect(new Set(RUNTIME_EVENT_NAMES).size).toBe(RUNTIME_EVENT_NAMES.length)
    expect(digest(RUNTIME_EVENT_NAMES)).toBe(RUNTIME_EVENT_COMPATIBILITY.sha256)
    expectTypeOf<(typeof RUNTIME_EVENT_NAMES)[number]>().toEqualTypeOf<
      RuntimeEvent['event']
    >()
  })
})
