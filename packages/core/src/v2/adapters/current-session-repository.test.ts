import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../../sessions/store'
import { CurrentSessionRepository } from './current-session-repository'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('current Session repository adapter', () => {
  it('materializes and preserves a legacy index-only Session', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-sessions-'))
    roots.push(root)
    const sessionsDirectory = join(root, 'sessions')
    mkdirSync(sessionsDirectory, { recursive: true })
    writeFileSync(
      join(sessionsDirectory, 'index.json'),
      `${JSON.stringify([
        {
          id: 'legacy-1',
          title: 'Legacy session',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          mode: 'chat',
        },
      ])}\n`,
      'utf8',
    )

    const repository = new CurrentSessionRepository(new SessionStore(root))
    const session = repository.get('legacy-1')

    expect(session).toMatchObject({
      id: 'legacy-1',
      title: 'Legacy session',
      mode: 'chat',
      version: 1,
    })
    expect(existsSync(join(sessionsDirectory, 'legacy-1', 'meta.jsonl'))).toBe(
      true,
    )
    expect(
      existsSync(join(sessionsDirectory, 'index.legacy-backup.json')),
    ).toBe(true)
  })
})
