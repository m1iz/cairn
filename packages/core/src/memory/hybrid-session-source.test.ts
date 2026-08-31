import { describe, expect, it } from 'vitest'
import { hybridSessionDocuments } from './hybrid-session-source'

describe('hybridSessionDocuments', () => {
  it('projects only visible user and assistant messages with exact session scope', () => {
    const documents = hybridSessionDocuments({
      sessionId: 'session-alpha',
      mode: 'build',
      projectId: 'project-one',
      historyPath: 'sessions/session-alpha/history.jsonl',
      updatedAt: 1234,
      history: [
        { role: 'system', content: 'private system prompt' },
        {
          role: 'user',
          content: 'internal wrapper',
          displayContent: 'Remember the deployment region is Singapore.',
          turn_id: 'turn-1',
          seq: 10,
          ts: '2026-08-01T10:00:00.000Z',
        },
        { role: 'assistant', content: 'Recorded for this session.' },
        { role: 'tool', content: 'secret tool output' },
        { role: 'user', content: 'hidden scheduler input', ui_hidden: true },
      ],
    })

    expect(documents).toHaveLength(2)
    expect(documents[0]).toMatchObject({
      id: 'session:session-alpha:seq:10',
      path: 'sessions/session-alpha/history.jsonl#seq:10',
      source: 'session',
      sessionId: 'session-alpha',
      projectId: 'project-one',
      createdAt: Date.parse('2026-08-01T10:00:00.000Z'),
    })
    const content = documents.map((document) => document.content).join('\n')
    expect(content).toContain('Remember the deployment region is Singapore.')
    expect(content).toContain('Recorded for this session.')
    expect(content).not.toContain('internal wrapper')
    expect(content).not.toContain('private system prompt')
    expect(content).not.toContain('secret tool output')
    expect(content).not.toContain('hidden scheduler input')
  })

  it('returns no source document when the active branch has no visible dialogue', () => {
    expect(
      hybridSessionDocuments({
        sessionId: 'session-empty',
        mode: 'chat',
        historyPath: 'sessions/session-empty/history.jsonl',
        history: [{ role: 'tool', content: 'not model-visible memory' }],
        updatedAt: 0,
      }),
    ).toEqual([])
  })
})
