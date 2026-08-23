import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspacePolicy } from './workspace-policy'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('WorkspacePolicy', () => {
  it('allows paths inside the effective workspace and denies lexical escapes', () => {
    const workspace = tmp('cairn-workspace-policy-')
    const policy = new WorkspacePolicy({ workspaceRoot: workspace })

    const allowed = policy.resolvePath('README.md', 'read')
    const denied = policy.resolvePath('../secret.txt', 'read')

    expect(allowed.allowed).toBe(true)
    expect(allowed.resolvedPath).toBe(join(workspace, 'README.md'))
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('outside workspace')
    expect(denied.allowedRoots[0]?.path).toBe(workspace)
  })

  it('denies private state roots even when they sit under the runtime workspace', () => {
    const runtimeRoot = tmp('cairn-workspace-policy-runtime-')
    const stateRoot = join(runtimeRoot, '.cairn')
    mkdirSync(join(stateRoot, 'memory'), { recursive: true })
    writeFileSync(
      join(stateRoot, 'memory', 'MEMORY.local.md'),
      'private',
      'utf8',
    )
    const policy = new WorkspacePolicy({
      workspaceRoot: runtimeRoot,
      stateRoot,
    })

    const denied = policy.resolvePath(
      join(stateRoot, 'memory', 'MEMORY.local.md'),
      'read',
    )

    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('denied root')
    expect(denied.denyRoots[0]?.path).toBe(stateRoot)
  })

  it('denies symlink escapes through an existing ancestor', () => {
    const workspace = tmp('cairn-workspace-policy-symlink-')
    const outside = tmp('cairn-workspace-policy-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8')
    symlinkSync(outside, join(workspace, 'out'))
    const policy = new WorkspacePolicy({ workspaceRoot: workspace })

    const denied = policy.resolvePath('out/secret.txt', 'read')

    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('outside workspace')
  })
})
