import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { GoalGateMutationLedger } from '../goals/mutation-ledger'

export class SidechainTranscript {
  readonly root: string
  readonly taskId: string
  readonly path: string
  private readonly tasksRoot: string
  private readonly taskRoot: string
  private readonly goalMutations: GoalGateMutationLedger

  constructor(root: string, taskId: string) {
    this.root = resolve(root)
    this.taskId = safeTaskId(taskId)
    this.tasksRoot = resolve(this.root, 'tasks')
    this.taskRoot = resolve(this.tasksRoot, this.taskId)
    assertContainedPath(this.tasksRoot, this.taskRoot)
    this.path = resolve(this.taskRoot, 'transcript.jsonl')
    this.goalMutations = new GoalGateMutationLedger(this.root)
    assertContainedPath(this.tasksRoot, this.path)
  }

  append(message: Record<string, unknown>): void {
    this.goalMutations.withSynchronousMutation(
      'transcript',
      `${this.taskId}:${String(message.turn_id ?? message.turnId ?? 'turn')}:${Date.now()}`,
      () => {
        mkdirSync(dirname(this.path), { recursive: true })
        this.assertExistingPathBoundary()
        const payload = {
          ...message,
          task_id: message.task_id ?? this.taskId,
          sidechain: message.sidechain ?? true,
          ts: message.ts ?? Date.now() / 1000,
        }
        const descriptor = openSync(
          this.path,
          constants.O_APPEND |
            constants.O_CREAT |
            constants.O_WRONLY |
            noFollowFlag(),
          0o600,
        )
        try {
          appendFileSync(descriptor, JSON.stringify(payload) + '\n', 'utf8')
        } finally {
          closeSync(descriptor)
        }
      },
    )
  }

  extend(messages: Array<Record<string, unknown>>): void {
    for (const message of messages) this.append(message)
  }

  read(opts: { offset?: number; limit?: number } = {}): {
    messages: Array<Record<string, any>>
    nextOffset: number
    path: string
  } {
    const offset = Math.max(0, Math.trunc(opts.offset ?? 0))
    const limit = Math.max(0, Math.trunc(opts.limit ?? 100))
    const messages: Array<Record<string, any>> = []
    let nextOffset = 0
    if (!existsSync(this.path))
      return { messages: [], nextOffset: 0, path: this.path }
    this.assertExistingPathBoundary()
    const descriptor = openSync(this.path, constants.O_RDONLY | noFollowFlag())
    let text = ''
    try {
      text = readFileSync(descriptor, 'utf8')
    } finally {
      closeSync(descriptor)
    }
    const lines = text.split('\n')
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber]
      if (!line) continue
      nextOffset = lineNumber + 1
      if (lineNumber < offset) continue
      if (messages.length >= limit) break
      try {
        const payload = JSON.parse(line)
        if (payload && typeof payload === 'object' && !Array.isArray(payload))
          messages.push(payload)
      } catch {
        continue
      }
    }
    return {
      messages,
      nextOffset: Math.min(nextOffset, offset + messages.length),
      path: this.path,
    }
  }

  inspectAll(opts: { maxBytes: number; maxMessages: number }): {
    messages: Array<Record<string, unknown>>
    issue: {
      code: 'task_transcript_malformed' | 'task_transcript_limit_exceeded'
      path: string
    } | null
    path: string
  } {
    const maxBytes = Math.max(1, Math.trunc(opts.maxBytes))
    const maxMessages = Math.max(1, Math.trunc(opts.maxMessages))
    if (!existsSync(this.path))
      return { messages: [], issue: null, path: this.path }
    this.assertExistingPathBoundary()
    if (lstatSync(this.path).size > maxBytes)
      return {
        messages: [],
        issue: { code: 'task_transcript_limit_exceeded', path: this.path },
        path: this.path,
      }
    const descriptor = openSync(this.path, constants.O_RDONLY | noFollowFlag())
    let text = ''
    try {
      text = readFileSync(descriptor, 'utf8')
    } finally {
      closeSync(descriptor)
    }
    const messages: Array<Record<string, unknown>> = []
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      let payload: unknown
      try {
        payload = JSON.parse(line)
      } catch {
        return {
          messages: [],
          issue: { code: 'task_transcript_malformed', path: this.path },
          path: this.path,
        }
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return {
          messages: [],
          issue: { code: 'task_transcript_malformed', path: this.path },
          path: this.path,
        }
      messages.push(payload as Record<string, unknown>)
      if (messages.length > maxMessages)
        return {
          messages: [],
          issue: { code: 'task_transcript_limit_exceeded', path: this.path },
          path: this.path,
        }
    }
    return { messages, issue: null, path: this.path }
  }

  private assertExistingPathBoundary(): void {
    for (const path of [this.tasksRoot, this.taskRoot, this.path]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error('sidechain transcript path contains a symlink')
    }
    if (!existsSync(this.tasksRoot) || !existsSync(this.taskRoot)) return
    const tasksReal = realpathSync(this.tasksRoot)
    const taskReal = realpathSync(this.taskRoot)
    assertContainedPath(tasksReal, taskReal)
    if (existsSync(this.path))
      assertContainedPath(tasksReal, realpathSync(this.path))
  }
}

function safeTaskId(value: unknown): string {
  const taskId = String(value ?? '').trim()
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/.test(taskId) || taskId.includes('..'))
    throw new Error('invalid task id')
  return taskId
}

function assertContainedPath(parent: string, candidate: string): void {
  const rel = relative(parent, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('sidechain transcript is outside task directory')
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}
