export interface TeamRunLimits {
  maxConcurrent: number
  maxConcurrentPerProject: number
  ttlMs: number
}

export interface TeamRunLeaseSnapshot {
  projectId: string
  memberName: string
  turnId: string
  sessionId: string | null
  startedAt: number
  deadlineAt: number
  cancelled: boolean
}

export interface TeamRunLease extends TeamRunLeaseSnapshot {
  signal: AbortSignal
  release(): void
}

interface ActiveTeamRun extends TeamRunLeaseSnapshot {
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  detachParent: (() => void) | null
}

export const DEFAULT_TEAM_RUN_LIMITS: Readonly<TeamRunLimits> = {
  maxConcurrent: 4,
  maxConcurrentPerProject: 2,
  ttlMs: 15 * 60_000,
}

export class TeamRunController {
  private readonly limits: TeamRunLimits
  private readonly active = new Map<string, ActiveTeamRun>()

  constructor(limits: Partial<TeamRunLimits> = {}) {
    this.limits = {
      maxConcurrent: positiveInt(
        limits.maxConcurrent,
        DEFAULT_TEAM_RUN_LIMITS.maxConcurrent,
      ),
      maxConcurrentPerProject: positiveInt(
        limits.maxConcurrentPerProject,
        DEFAULT_TEAM_RUN_LIMITS.maxConcurrentPerProject,
      ),
      ttlMs: positiveInt(limits.ttlMs, DEFAULT_TEAM_RUN_LIMITS.ttlMs),
    }
  }

  acquire(opts: {
    projectId: string
    memberName: string
    turnId: string
    sessionId?: string | null
    signal?: AbortSignal | null
  }): TeamRunLease {
    const key = runKey(opts.projectId, opts.memberName)
    if (this.active.has(key))
      throw new Error(`teammate '${opts.memberName}' is already working`)
    if (this.active.size >= this.limits.maxConcurrent)
      throw new Error('Team global concurrency limit reached')
    const projectRuns = [...this.active.values()].filter(
      (run) => run.projectId === opts.projectId,
    ).length
    if (projectRuns >= this.limits.maxConcurrentPerProject)
      throw new Error('Team project concurrency limit reached')

    const controller = new AbortController()
    const startedAt = Date.now()
    const active: ActiveTeamRun = {
      projectId: opts.projectId,
      memberName: opts.memberName,
      turnId: opts.turnId,
      sessionId: opts.sessionId?.trim() || null,
      startedAt,
      deadlineAt: startedAt + this.limits.ttlMs,
      cancelled: false,
      controller,
      timer: setTimeout(() => {
        active.cancelled = true
        controller.abort(new Error('Team run TTL exceeded'))
      }, this.limits.ttlMs),
      detachParent: null,
    }
    active.timer.unref?.()
    if (opts.signal) {
      const abortFromParent = () => {
        active.cancelled = true
        controller.abort(
          opts.signal?.reason ?? new Error('Parent turn cancelled'),
        )
      }
      if (opts.signal.aborted) abortFromParent()
      else {
        opts.signal.addEventListener('abort', abortFromParent, { once: true })
        active.detachParent = () =>
          opts.signal?.removeEventListener('abort', abortFromParent)
      }
    }
    this.active.set(key, active)

    return {
      ...snapshot(active),
      signal: controller.signal,
      release: () => this.release(key, opts.turnId),
    }
  }

  cancel(
    projectId: string,
    memberName: string,
    reason = 'Team run cancelled',
  ): boolean {
    const active = this.active.get(runKey(projectId, memberName))
    if (!active) return false
    active.cancelled = true
    active.controller.abort(new Error(reason))
    return true
  }

  cancelSession(sessionId: string, reason = 'Session closed'): number {
    return this.cancelWhere((run) => run.sessionId === sessionId, reason)
  }

  shutdown(reason = 'Cairn shutting down'): number {
    return this.cancelWhere(() => true, reason)
  }

  snapshot(projectId?: string | null): TeamRunLeaseSnapshot[] {
    return [...this.active.values()]
      .filter((run) => !projectId || run.projectId === projectId)
      .map(snapshot)
  }

  private cancelWhere(
    predicate: (run: ActiveTeamRun) => boolean,
    reason: string,
  ): number {
    let cancelled = 0
    for (const run of this.active.values()) {
      if (!predicate(run)) continue
      run.cancelled = true
      run.controller.abort(new Error(reason))
      cancelled += 1
    }
    return cancelled
  }

  private release(key: string, turnId: string): void {
    const active = this.active.get(key)
    if (!active || active.turnId !== turnId) return
    clearTimeout(active.timer)
    active.detachParent?.()
    this.active.delete(key)
  }
}

function runKey(projectId: string, memberName: string): string {
  return `${projectId}\u0000${memberName}`
}

function snapshot(run: ActiveTeamRun): TeamRunLeaseSnapshot {
  return {
    projectId: run.projectId,
    memberName: run.memberName,
    turnId: run.turnId,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    deadlineAt: run.deadlineAt,
    cancelled: run.cancelled,
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
