import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PlanStore } from '../plans/store'
import { TaskStore } from '../tasks/store'
import { SidechainTranscript } from '../tasks/sidechain'

describe('Gate readonly storage inspection', () => {
  it('reports a corrupt Plan index without rename or rewrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-plan-inspect-'))
    const store = new PlanStore(root)
    writeFileSync(store.indexFile, '{bad', 'utf8')
    const before = readFileSync(store.indexFile, 'utf8')
    const names = readdirSync(store.planDir)

    expect(store.inspect('plan_1')).toMatchObject({
      record: null,
      issue: { code: 'plan_store_corrupt' },
    })
    expect(readFileSync(store.indexFile, 'utf8')).toBe(before)
    expect(readdirSync(store.planDir)).toEqual(names)
  })

  it('reports a corrupt Task index without rename or rewrite', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-task-inspect-'))
    const store = new TaskStore(root)
    writeFileSync(store.indexFile, '{bad', 'utf8')
    const before = readFileSync(store.indexFile, 'utf8')
    const names = readdirSync(store.tasksDir)

    expect(store.inspect('task_1')).toMatchObject({
      record: null,
      issue: { code: 'task_store_corrupt' },
    })
    expect(readFileSync(store.indexFile, 'utf8')).toBe(before)
    expect(readdirSync(store.tasksDir)).toEqual(names)
  })

  it('rejects malformed or over-limit transcripts without partial reads or disk changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cairn-transcript-inspect-'))
    const transcript = new SidechainTranscript(root, 'task_review')
    transcript.append({ role: 'assistant', content: 'ok' })
    appendFileSync(transcript.path, '{bad\n', 'utf8')
    const before = readFileSync(transcript.path, 'utf8')

    expect(
      transcript.inspectAll({ maxBytes: 4096, maxMessages: 10 }),
    ).toMatchObject({
      messages: [],
      issue: { code: 'task_transcript_malformed' },
    })
    expect(readFileSync(transcript.path, 'utf8')).toBe(before)

    writeFileSync(
      transcript.path,
      `${JSON.stringify({ role: 'assistant', content: 'x'.repeat(200) })}\n`,
      'utf8',
    )
    expect(
      transcript.inspectAll({ maxBytes: 64, maxMessages: 10 }),
    ).toMatchObject({
      messages: [],
      issue: { code: 'task_transcript_limit_exceeded' },
    })
  })
})
