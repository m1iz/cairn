import type { TeamMember, TeamMessage } from './models'

export function memberUpdate(member: TeamMember): Record<string, unknown> {
  return { event: 'team_member_update', member: member.toDict() }
}

export function messageEvent(message: TeamMessage): Record<string, unknown> {
  return { event: 'team_message', message: message.toDict() }
}

export function runStart(opts: {
  parent_id?: string | null
  member: TeamMember
  purpose: string
}): Record<string, unknown> {
  return {
    event: 'team_run_start',
    parent_id: opts.parent_id ?? null,
    teammate: opts.member.name,
    role: opts.member.role,
    agent_type: opts.member.agent_type,
    purpose: opts.purpose,
  }
}

export function runDelta(opts: {
  parent_id?: string | null
  member: TeamMember
  delta: string
}): Record<string, unknown> {
  return {
    event: 'team_run_delta',
    parent_id: opts.parent_id ?? null,
    teammate: opts.member.name,
    delta: opts.delta,
  }
}

export function runToolCall(opts: {
  parent_id?: string | null
  member: TeamMember
  id?: string | null
  name: string
  arguments?: Record<string, unknown> | null
}): Record<string, unknown> {
  return {
    event: 'team_run_tool_call',
    parent_id: opts.parent_id ?? null,
    teammate: opts.member.name,
    id: opts.id ?? null,
    name: opts.name,
    arguments: opts.arguments ?? {},
  }
}

export function runToolResult(opts: {
  parent_id?: string | null
  member: TeamMember
  id?: string | null
  name?: string | null
  summary: string
}): Record<string, unknown> {
  return {
    event: 'team_run_tool_result',
    parent_id: opts.parent_id ?? null,
    teammate: opts.member.name,
    id: opts.id ?? null,
    name: opts.name ?? null,
    summary: opts.summary,
  }
}

export function runToolError(opts: {
  parent_id?: string | null
  member: TeamMember
  id?: string | null
  name?: string | null
  message: string
}): Record<string, unknown> {
  return {
    event: 'team_run_tool_error',
    parent_id: opts.parent_id ?? null,
    teammate: opts.member.name,
    id: opts.id ?? null,
    name: opts.name ?? null,
    message: opts.message,
  }
}

export function runDone(opts: {
  parent_id?: string | null
  member: TeamMember
  summary: string
}): Record<string, unknown> {
  return {
    event: 'team_run_done',
    parent_id: opts.parent_id ?? null,
    teammate: opts.member.name,
    summary: opts.summary,
  }
}

export function runError(opts: {
  parent_id?: string | null
  member: TeamMember
  message: string
}): Record<string, unknown> {
  return {
    event: 'team_run_error',
    parent_id: opts.parent_id ?? null,
    teammate: opts.member.name,
    message: opts.message,
  }
}
