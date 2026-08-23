import type { PlanRecord } from '../plans/models'
import type { GoalRecord } from './models'

export interface ComparableGoalScope {
  sessionId: string | null
  mode: string | null
  projectId: string | null
  workspaceRoot: string | null
  projectFingerprint: string | null
}

export function planMatchesGoalScope(
  plan: PlanRecord,
  goal: GoalRecord,
): boolean {
  if (plan.sessionId !== goal.scope.sessionId) return false
  const saved = planGoalScope(plan)
  return saved !== null && goalScopesEqual(saved, goal.scope)
}

export function plansShareFullGoalScope(
  left: PlanRecord,
  right: PlanRecord,
): boolean {
  if (!left.sessionId || left.sessionId !== right.sessionId) return false
  const leftScope = planGoalScope(left)
  const rightScope = planGoalScope(right)
  return (
    leftScope !== null &&
    rightScope !== null &&
    goalScopesEqual(leftScope, rightScope)
  )
}

export function goalScopesEqual(
  left: ComparableGoalScope,
  right: ComparableGoalScope,
): boolean {
  return (
    clean(left.sessionId) === clean(right.sessionId) &&
    clean(left.mode) === clean(right.mode) &&
    nullable(left.projectId) === nullable(right.projectId) &&
    portableGoalWorkspace(left.workspaceRoot) ===
      portableGoalWorkspace(right.workspaceRoot) &&
    clean(left.projectFingerprint) === clean(right.projectFingerprint)
  )
}

function planGoalScope(plan: PlanRecord): ComparableGoalScope | null {
  const raw = plan.metadata.scope
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const scope = raw as Record<string, unknown>
  const normalized: ComparableGoalScope = {
    sessionId: clean(scope.session_id ?? scope.sessionId),
    mode: clean(scope.mode),
    projectId: nullable(scope.project_id ?? scope.projectId),
    workspaceRoot: exact(scope.workspace_root ?? scope.workspaceRoot),
    projectFingerprint: clean(
      scope.project_fingerprint ?? scope.projectFingerprint,
    ),
  }
  return normalized.sessionId &&
    normalized.mode &&
    normalized.workspaceRoot &&
    normalized.projectFingerprint
    ? normalized
    : null
}

export function portableGoalWorkspace(value: unknown): string {
  const raw = exact(value)
  const windows = /^[a-z]:[\\/]/i.test(raw) || /^[\\/]{2}/.test(raw)
  if (!windows) return raw
  const portable = raw.replace(/\\/g, '/')
  return portable.toLowerCase()
}

function nullable(value: unknown): string | null {
  return clean(value) || null
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function exact(value: unknown): string {
  return String(value ?? '')
}
