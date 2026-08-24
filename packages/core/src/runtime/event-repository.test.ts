import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeEventRepositoryFactory } from './event-repository'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('runtime event repository', () => {
  it('reads legacy projection rows and appends without migrating the file', () => {
    const sessionDirectory = mkdtempSync(join(tmpdir(), 'cairn-events-'))
    roots.push(sessionDirectory)
    const runtimeDirectory = join(sessionDirectory, 'runtime')
    mkdirSync(runtimeDirectory, { recursive: true })
    writeFileSync(
      join(runtimeDirectory, 'events.jsonl'),
      `${JSON.stringify({ event: 'user_message', seq: 1, session_id: 's1', content: 'hello' })}\n`,
      'utf8',
    )
    const factory = new RuntimeEventRepositoryFactory()
    const repository = factory.openSession(sessionDirectory)

    expect(repository.latestSequence).toBe(1)
    expect(repository.replayProjectionAfter(0, { sessionId: 's1' })).toEqual([
      expect.objectContaining({ event: 'user_message', content: 'hello' }),
    ])
    repository.append(
      { event: 'assistant_done', content: 'world' },
      { sessionId: 's1' },
    )

    const reopened = factory.openSession(sessionDirectory)
    expect(reopened.latestSequence).toBe(2)
    expect(reopened.replayProjectionAfter(1, { sessionId: 's1' })).toEqual([
      expect.objectContaining({ event: 'assistant_done', content: 'world' }),
    ])
  })
})
