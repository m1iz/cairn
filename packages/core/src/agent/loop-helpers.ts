import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export function canonicalRegularPath(
  path: string,
  boundary: string,
  kind: 'file' | 'directory',
): string | null {
  const lexicalBoundary = resolve(boundary)
  const lexicalPath = resolve(path)
  if (!pathInside(lexicalBoundary, lexicalPath)) return null
  if (!existsSync(lexicalBoundary)) return null
  const rel = relative(lexicalBoundary, lexicalPath)
  let cursor = lexicalBoundary
  for (const part of rel ? rel.split(sep) : []) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) return null
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink()) return null
  }
  const canonicalBoundary = realpathSync(lexicalBoundary)
  const canonicalPath = realpathSync(lexicalPath)
  if (!pathInside(canonicalBoundary, canonicalPath)) return null
  const stat = lstatSync(lexicalPath)
  if (stat.isSymbolicLink()) return null
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) return null
  return canonicalPath
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

export function existingPath(path: string): string | null {
  return existsSync(path) ? path : null
}

export function fileModifiedAt(path: string): number {
  try {
    return Math.max(0, lstatSync(path).mtimeMs)
  } catch {
    return 0
  }
}

export function isBenignTurnInterruption(error: unknown): boolean {
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name?: unknown }).name || '')
      : ''
  return (
    name === 'TurnPaused' ||
    name === 'CancelledTaskError' ||
    name === 'TurnBusyError'
  )
}

export function commandTurnId(commandId: string): string {
  const value = String(commandId ?? '')
  return value.startsWith('turn:') ? value.slice('turn:'.length) : value
}

export function hookErrorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  return 'unknown_error'
}

export function mcpStateIdempotencyKey(event: Record<string, unknown>): string {
  const error = isRecord(event.last_error) ? event.last_error : null
  return [
    'mcp-state',
    String(event.server_name ?? 'unknown'),
    String(event.client_id ?? `generation-${event.generation ?? 0}`),
    String(event.state ?? 'unknown'),
    String(event.restart_attempts ?? 0),
    String(event.active_request_count ?? 0),
    String(error?.code ?? 'ok'),
  ].join(':')
}

export function safeRuntimeError(error: unknown): {
  code: string
  message: string
  action?: string
} {
  const safe = safeErrorFromToSafe(error)
  if (safe) return safe
  return { code: 'internal_error', message: '发生内部错误，请查看日志。' }
}

function safeErrorFromToSafe(
  error: unknown,
): { code: string; message: string; action?: string } | null {
  if (!error || typeof error !== 'object') return null
  const toSafe = (error as { toSafe?: unknown }).toSafe
  if (typeof toSafe !== 'function') return null
  const payload = toSafe.call(error)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null
  const record = payload as Record<string, unknown>
  const code = typeof record.code === 'string' && record.code ? record.code : ''
  const message =
    typeof record.message === 'string' && record.message ? record.message : ''
  if (!code || !message) return null
  return {
    code,
    message,
    ...(typeof record.action === 'string' && record.action
      ? { action: record.action }
      : {}),
  }
}

export function scopeLabel(scope: unknown): string | null {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null
  const record = scope as Record<string, unknown>
  const kind = String(record.kind || '')
  if (!kind) return null
  if (kind === 'project' && record.projectId)
    return `project:${String(record.projectId)}`
  if (kind === 'episode' && record.date) return `episode:${String(record.date)}`
  return kind
}

export function cloneTodoItems(
  todos: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return todos.map((todo) => ({ ...todo }))
}

export function safeSkillName(name: string): string {
  const safe = String(name || '').trim()
  return /^[A-Za-z0-9_.-]+$/.test(safe) ? safe : ''
}

export class RequestedSkillUnavailableError extends Error {
  readonly code = 'requested_skill_unavailable'

  constructor(readonly skillName: string) {
    super(`Requested skill is unavailable: ${skillName}`)
    this.name = 'RequestedSkillUnavailableError'
  }

  toSafe(): { code: string; message: string; action: string } {
    return {
      code: this.code,
      message: `请求的 Skill 不可用：${this.skillName}`,
      action: 'refresh_skills',
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
