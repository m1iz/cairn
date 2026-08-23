import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isPathWithin,
  pathsEqual,
  relativePortable,
  relativePortableOrAbsolute,
  toPortablePath,
} from './paths'

describe('portable path boundaries', () => {
  it('normalizes Windows separators only when the source uses them', () => {
    expect(toPortablePath('memory\\runtime\\events.jsonl', '\\')).toBe(
      'memory/runtime/events.jsonl',
    )
    expect(toPortablePath('literal\\name', '/')).toBe('literal\\name')
  })

  it('serializes paths under a root and preserves outside absolute paths', () => {
    const root = join(process.cwd(), 'state')
    const nested = join(root, 'memory', 'MEMORY.local.md')
    const outside = join(process.cwd(), 'outside.md')

    expect(relativePortable(root, nested)).toBe('memory/MEMORY.local.md')
    expect(relativePortableOrAbsolute(root, nested)).toBe(
      'memory/MEMORY.local.md',
    )
    expect(relativePortableOrAbsolute(root, outside)).toBe(outside)
  })

  it('compares Windows paths case-insensitively without weakening containment', () => {
    expect(pathsEqual('C:\\Users\\Agent', 'c:\\users\\agent', 'win32')).toBe(
      true,
    )
    expect(isPathWithin(join('/workspace', 'src'), '/workspace')).toBe(true)
    expect(isPathWithin('/workspace-other', '/workspace')).toBe(false)
  })
})
