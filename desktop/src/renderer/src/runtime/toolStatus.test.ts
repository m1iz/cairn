import { describe, expect, it } from 'vitest'
import type { ToolSegment } from '../types'
import {
  applyToolResultToSegment,
  applyToolRunUpdateToSegment,
  settleRunningToolSegments,
} from './toolStatus'

function segment(): ToolSegment {
  return {
    id: 'seg_1',
    type: 'tool',
    toolId: 'call_1',
    name: 'unknown_tool',
    arguments: {},
    status: 'running',
    summary: '',
    startedAt: 100,
  }
}

describe('toolStatus guards', () => {
  it('ignores malformed tool result payload shapes instead of poisoning the segment', () => {
    const seg = segment()

    applyToolResultToSegment(seg, {
      summary: { bad: true } as any,
      artifacts: { path: 'not-an-array' } as any,
      metadata: 'not-object' as any,
      todos: { length: 1 } as any,
      endedAt: 150,
    })

    expect(seg.status).toBe('done')
    expect(seg.summary).toBe('已完成')
    expect(Array.isArray(seg.artifacts || [])).toBe(true)
    expect(seg.artifacts).toBeUndefined()
    expect(seg.metadata).toBeUndefined()
    expect(seg.todos).toBeUndefined()
  })

  it('keeps cancelled and missing-completion segments settled with safe text', () => {
    const seg = segment()

    applyToolRunUpdateToSegment(seg, {
      status: 'error_aborted',
      summary: ['cancelled'] as any,
      artifacts: [null, { path: 'ok.png', kind: 'image', bytes: 12 }] as any,
      metadata: { diff: 'patch' },
      endedAt: 200,
    })

    expect(seg.status).toBe('error_aborted')
    expect(seg.summary).toBe('')
    expect(seg.artifacts).toEqual([
      { path: 'ok.png', kind: 'image', bytes: 12 },
    ])
    expect(seg.metadata).toEqual({ diff: 'patch' })

    const other = segment()
    const count = settleRunningToolSegments(
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        segments: [other],
        streaming: true,
      } as any,
      { endedAt: 300 },
    )
    expect(count).toBe(1)
    expect(other.status).toBe('error_aborted')
    expect(other.summary).toBe('工具未返回结束事件')
  })

  it('separates full tool output from short summary and marks legacy summary-only events', () => {
    const seg = segment()

    applyToolResultToSegment(seg, {
      summary: 'run_command exit 0: npm test',
      output: 'full stdout\nline 2',
      endedAt: 180,
    })

    expect(seg.status).toBe('done')
    expect(seg.summary).toBe('run_command exit 0: npm test')
    expect(seg.output).toBe('full stdout\nline 2')
    expect(seg.outputMissing).toBeFalsy()

    const legacy = segment()
    applyToolResultToSegment(legacy, {
      summary: 'legacy summary only',
      endedAt: 190,
    })

    expect(legacy.status).toBe('done')
    expect(legacy.summary).toBe('legacy summary only')
    expect(legacy.output).toBeUndefined()
    expect(legacy.outputMissing).toBe(true)
  })
})
