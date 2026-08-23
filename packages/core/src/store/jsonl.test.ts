import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { appendJsonl, readJsonl, rotateToArchive } from './jsonl'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cairn-jsonl-'))
})

describe('jsonl', () => {
  it('appends and reads back records', async () => {
    const p = join(dir, 'log.jsonl')
    await appendJsonl(p, { a: 1 })
    await appendJsonl(p, { a: 2 })
    const { records, badLines } = await readJsonl<{ a: number }>(p)
    expect(records).toEqual([{ a: 1 }, { a: 2 }])
    expect(badLines).toHaveLength(0)
  })

  it('isolates bad lines instead of failing the whole read', async () => {
    const p = join(dir, 'log.jsonl')
    await writeFile(p, '{"a":1}\nnot json\n{"a":2}\n', 'utf8')
    const { records, badLines } = await readJsonl<{ a: number }>(p)
    expect(records).toEqual([{ a: 1 }, { a: 2 }])
    expect(badLines).toEqual([{ line: 2, raw: 'not json' }])
  })

  it('returns empty for a missing file', async () => {
    expect(await readJsonl(join(dir, 'nope.jsonl'))).toEqual({
      records: [],
      badLines: [],
    })
  })

  it('rotates the hot segment to archive when threshold is reached', async () => {
    const hot = join(dir, 'events.jsonl')
    const archive = join(dir, 'archive', 'events.jsonl')
    for (let i = 0; i < 5; i++) await appendJsonl(hot, { i })
    const rotated = await rotateToArchive(hot, archive, { keepThreshold: 5 })
    expect(rotated).toBe(true)
    expect((await readJsonl(hot)).records).toHaveLength(0)
    expect((await readJsonl(archive)).records).toHaveLength(5)
  })

  it('does not rotate below threshold', async () => {
    const hot = join(dir, 'events.jsonl')
    await appendJsonl(hot, { i: 0 })
    expect(
      await rotateToArchive(hot, join(dir, 'a.jsonl'), { keepThreshold: 5 }),
    ).toBe(false)
  })
})
