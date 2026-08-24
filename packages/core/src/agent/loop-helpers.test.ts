import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalRegularPath,
  cloneTodoItems,
  commandTurnId,
  existingPath,
  fileModifiedAt,
  hookErrorKind,
  isBenignTurnInterruption,
  mcpStateIdempotencyKey,
  safeRuntimeError,
  safeSkillName,
  scopeLabel,
} from './loop-helpers'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('AgentLoop boundary helpers', () => {
  it('accepts only existing regular paths inside the declared boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-loop-helpers-'))
    roots.push(root)
    const file = join(root, 'skill.md')
    writeFileSync(file, '# Skill\n', 'utf8')

    expect(canonicalRegularPath(root, root, 'directory')).toBe(root)
    expect(canonicalRegularPath(file, root, 'file')).toBe(file)
    expect(canonicalRegularPath(join(root, 'missing'), root, 'file')).toBeNull()
    expect(canonicalRegularPath(tmpdir(), root, 'directory')).toBeNull()
    expect(existingPath(file)).toBe(file)
    expect(fileModifiedAt(file)).toBeGreaterThan(0)
    expect(fileModifiedAt(join(root, 'missing'))).toBe(0)
  })

  it('normalizes safe runtime values without exposing arbitrary objects', () => {
    expect(commandTurnId('turn:abc')).toBe('abc')
    expect(commandTurnId('command')).toBe('command')
    expect(
      hookErrorKind(Object.assign(new Error('x'), { name: 'HookError' })),
    ).toBe('HookError')
    expect(isBenignTurnInterruption({ name: 'TurnPaused' })).toBe(true)
    expect(isBenignTurnInterruption(new Error('other'))).toBe(false)
    expect(scopeLabel({ kind: 'project', projectId: 'p1' })).toBe('project:p1')
    expect(scopeLabel([])).toBeNull()
    expect(safeSkillName(' valid.skill-1 ')).toBe('valid.skill-1')
    expect(safeSkillName('../escape')).toBe('')
  })

  it('preserves safe errors, event keys, and todo value isolation', () => {
    expect(
      safeRuntimeError({
        toSafe: () => ({ code: 'known', message: 'safe', action: 'retry' }),
      }),
    ).toEqual({ code: 'known', message: 'safe', action: 'retry' })
    expect(safeRuntimeError(new Error('secret'))).toEqual({
      code: 'internal_error',
      message: '发生内部错误，请查看日志。',
    })
    expect(
      mcpStateIdempotencyKey({
        server_name: 'docs',
        generation: 2,
        state: 'failed',
        last_error: { code: 'offline' },
      }),
    ).toBe('mcp-state:docs:generation-2:failed:0:0:offline')

    const source = [{ id: 'todo-1', status: 'pending' }]
    const cloned = cloneTodoItems(source)
    expect(cloned).toEqual(source)
    expect(cloned[0]).not.toBe(source[0])
  })
})
