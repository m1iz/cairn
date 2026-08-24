import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MessageGraphStore,
  projectHistoryToMessageGraph,
  projectMessageGraphToHistory,
} from './message-graph'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('MessageGraphStore', () => {
  it('projects history rows to a parent-linked graph and back without changing them', () => {
    const history = [
      { seq: 1, role: 'user', content: 'first', turn_id: 'turn_1' },
      { seq: 2, role: 'assistant', content: 'answer', turn_id: 'turn_1' },
      { seq: 3, type: 'compact_event', archived: true },
      { seq: 4, role: 'user', content: 'second', turn_id: 'turn_2' },
    ]

    const graph = projectHistoryToMessageGraph(history, {
      sessionId: 'session_fixture',
    })

    expect(graph.nodes).toHaveLength(3)
    expect(graph.nodes.map((node) => node.parentId)).toEqual([
      null,
      graph.nodes[0]!.id,
      graph.nodes[1]!.id,
    ])
    expect(graph.leafId).toBe(graph.nodes[2]!.id)
    expect(graph.compactBoundaries).toEqual([
      expect.objectContaining({
        compactedUntilHistorySeq: 3,
        parentLeafId: graph.nodes[1]!.id,
      }),
    ])
    expect(projectMessageGraphToHistory(graph)).toEqual([
      history[0],
      history[1],
      history[3],
    ])
    expect(history[0]).not.toHaveProperty('message_id')
  })

  it('recovers either branch from an explicitly selected leaf', () => {
    const store = new MessageGraphStore(tmp('cairn-message-branch-'))
    const root = store.appendCommitted({
      role: 'user',
      content: 'root',
      turnId: 'turn_root',
      historySeq: 1,
    })
    const first = store.appendCommitted({
      role: 'assistant',
      content: 'branch A',
      turnId: 'turn_a',
      historySeq: 2,
    })

    store.selectLeaf(root.id)
    const second = store.appendCommitted({
      role: 'assistant',
      content: 'branch B',
      turnId: 'turn_b',
      historySeq: 3,
    })

    expect(store.project(first.id).map((row) => row.content)).toEqual([
      'root',
      'branch A',
    ])
    expect(store.project(second.id).map((row) => row.content)).toEqual([
      'root',
      'branch B',
    ])
    expect(store.snapshot().leafId).toBe(second.id)
  })

  it('commits a partial whose history row landed before a crash and tombstones a true orphan', () => {
    const root = tmp('cairn-message-orphan-')
    const store = new MessageGraphStore(root)
    const landed = store.beginMessage({
      role: 'user',
      content: 'landed',
      turnId: 'turn_landed',
    })
    const orphan = store.beginMessage({
      role: 'assistant',
      content: 'partial stream',
      turnId: 'turn_orphan',
    })

    const reopened = new MessageGraphStore(root, {
      historyRows: [
        {
          seq: 7,
          role: 'user',
          content: 'landed',
          turn_id: 'turn_landed',
          message_id: landed.id,
        },
      ],
    })
    const byId = Object.fromEntries(
      reopened.snapshot().nodes.map((node) => [node.id, node]),
    )

    expect(byId[landed.id]).toMatchObject({
      status: 'committed',
      historySeq: 7,
    })
    expect(byId[orphan.id]).toMatchObject({
      status: 'tombstoned',
      tombstoneReason: 'orphan_partial',
    })
    expect(reopened.project().map((row) => row.content)).toEqual(['landed'])
  })

  it('backtracks to the exact leaf captured by a compact boundary', () => {
    const store = new MessageGraphStore(tmp('cairn-message-compact-'))
    store.appendCommitted({
      role: 'user',
      content: 'before',
      turnId: 'turn_before',
      historySeq: 1,
    })
    const boundary = store.recordCompactBoundary({
      compactedUntilHistorySeq: 1,
      compactionId: 'compact_1',
    })
    store.appendCommitted({
      role: 'assistant',
      content: 'after',
      turnId: 'turn_after',
      historySeq: 2,
    })

    expect(store.backtrackToCompactBoundary(boundary.id)).toBe(
      boundary.parentLeafId,
    )
    expect(store.project().map((row) => row.content)).toEqual(['before'])
  })

  it('isolates malformed sidecar lines and never copies their raw content into diagnostics', () => {
    const root = tmp('cairn-message-corrupt-')
    const path = join(root, 'message_graph.jsonl')
    writeFileSync(path, '{"secret":"do-not-leak"\n', 'utf8')

    const store = new MessageGraphStore(root)

    expect(store.snapshot().diagnostics).toEqual([
      expect.objectContaining({ code: 'invalid_json', line: 1 }),
    ])
    expect(JSON.stringify(store.snapshot().diagnostics)).not.toContain(
      'do-not-leak',
    )
    expect(readFileSync(path, 'utf8')).toContain('do-not-leak')
  })

  it('moves the previous graph filename and continues it with the canonical schema', () => {
    const root = tmp('cairn-message-graph-migration-')
    const initial = new MessageGraphStore(root)
    initial.appendCommitted({
      role: 'user',
      content: 'before migration',
      turnId: 'turn_before',
      historySeq: 1,
    })
    const currentPath = join(root, 'message_graph.jsonl')
    const previousPath = join(root, 'message_graph.v2.jsonl')
    writeFileSync(
      currentPath,
      readFileSync(currentPath, 'utf8').replaceAll(
        'cairn.message-graph-event',
        'cairn.message-graph-event.v2',
      ),
      'utf8',
    )
    renameSync(currentPath, previousPath)

    const reopened = new MessageGraphStore(root)
    reopened.appendCommitted({
      role: 'assistant',
      content: 'after migration',
      turnId: 'turn_after',
      historySeq: 2,
    })

    expect(existsSync(previousPath)).toBe(false)
    expect(existsSync(currentPath)).toBe(true)
    expect(reopened.project().map((row) => row.content)).toEqual([
      'before migration',
      'after migration',
    ])
    expect(
      readFileSync(currentPath, 'utf8').trim().split('\n').at(-1),
    ).toContain('"schemaVersion":"cairn.message-graph-event"')
  })

  it('replays durable prompt queue transitions after reopening the session', () => {
    const root = tmp('cairn-prompt-replay-')
    const store = new MessageGraphStore(root)
    store.recordPrompt({
      id: 'prompt_1',
      turnId: 'turn_prompt_1',
      clientMessageId: 'client_1',
      delivery: 'interject',
      targetCommandId: 'turn:owner_1',
    })
    store.transitionPrompt('prompt_1', 'interjected')

    const reopened = new MessageGraphStore(root)

    expect(reopened.snapshot().prompts).toEqual([
      expect.objectContaining({
        id: 'prompt_1',
        turnId: 'turn_prompt_1',
        clientMessageId: 'client_1',
        delivery: 'interject',
        targetCommandId: 'turn:owner_1',
        state: 'interjected',
      }),
    ])
    expect(reopened.transitionPrompt('prompt_1', 'completed')).toMatchObject({
      state: 'completed',
    })
  })

  it('rejects an illegal transition out of a terminal prompt state', () => {
    const store = new MessageGraphStore(tmp('cairn-prompt-terminal-'))
    store.recordPrompt({
      id: 'prompt_terminal',
      turnId: 'turn_terminal',
      delivery: 'queue',
    })
    store.transitionPrompt('prompt_terminal', 'cancelled', 'owner_cancelled')

    expect(() => store.transitionPrompt('prompt_terminal', 'running')).toThrow(
      'illegal prompt transition: cancelled -> running',
    )
    expect(store.snapshot().prompts[0]).toMatchObject({
      state: 'cancelled',
      reason: 'owner_cancelled',
    })
  })

  it('durably replaces a queued prompt in one replayable graph event', () => {
    const root = tmp('cairn-prompt-atomic-replace-')
    const store = new MessageGraphStore(root)
    store.recordPrompt({
      id: 'prompt_original',
      turnId: 'turn_original',
      delivery: 'queue',
      content: 'urgent correction',
    })

    store.replaceQueuedPrompt('prompt_original', {
      id: 'prompt_replacement',
      turnId: 'turn_original',
      delivery: 'interject',
      targetCommandId: 'turn:owner',
      content: 'urgent correction',
      supportsInterjection: true,
    })

    expect(new MessageGraphStore(root).snapshot().prompts).toEqual([
      expect.objectContaining({
        id: 'prompt_original',
        state: 'cancelled',
        reason: 'replaced_by_interjection',
      }),
      expect.objectContaining({
        id: 'prompt_replacement',
        state: 'queued',
        delivery: 'interject',
      }),
    ])
  })
})
