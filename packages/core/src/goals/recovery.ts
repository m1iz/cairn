import { isGoalTerminal, type GoalRecord } from './models'
import type { GoalRecoveryIssue, GoalStore } from './store'
import { assertGoalTransition } from './validation'

export interface GoalScopeValidationResult {
  readonly valid: boolean
  readonly reason?: 'workspace_missing' | 'binding_drift' | 'session_missing'
}

export interface GoalRecoveryServiceOptions {
  readonly hasActiveRuntime?: (goal: GoalRecord) => boolean | Promise<boolean>
  readonly validateScope?: (
    goal: GoalRecord,
  ) => GoalScopeValidationResult | Promise<GoalScopeValidationResult>
  readonly now?: () => string
}

export interface GoalRecoveryResult {
  readonly scanned: number
  readonly pausedGoalIds: readonly string[]
  readonly issues: readonly GoalRecoveryIssue[]
}

export class GoalRecoveryService {
  private readonly hasActiveRuntime: (
    goal: GoalRecord,
  ) => boolean | Promise<boolean>
  private readonly validateScope: (
    goal: GoalRecord,
  ) => GoalScopeValidationResult | Promise<GoalScopeValidationResult>
  private readonly now: () => string

  constructor(
    private readonly store: GoalStore,
    options: GoalRecoveryServiceOptions = {},
  ) {
    this.hasActiveRuntime = options.hasActiveRuntime ?? (() => false)
    this.validateScope = options.validateScope ?? (() => ({ valid: true }))
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async recoverOnStartup(): Promise<GoalRecoveryResult> {
    const records = await this.store.list()
    const pausedGoalIds: string[] = []
    for (const record of records) {
      if (!isGoalTerminal(record.status)) {
        let scopeValid = false
        try {
          scopeValid = (await this.validateScope(record)).valid
        } catch {
          // Scope validation must fail closed when its backing service is unavailable.
        }
        if (!scopeValid) {
          await this.store.requireScopeRecovery(record.id)
          continue
        }
      }
      if (
        record.status !== 'active' ||
        (record.runtime.phase !== 'executing' &&
          record.runtime.phase !== 'verifying' &&
          (record.runtime.phase !== 'planning' ||
            record.runtime.currentRunId === null)) ||
        (await this.hasActiveRuntime(record))
      ) {
        continue
      }
      const at = this.now()
      const paused = assertGoalTransition(record, {
        ...record,
        runtime: {
          ...record.runtime,
          phase: 'paused',
          currentRunId: null,
          pauseReason: 'recovery_required',
        },
        updatedAt: at,
      })
      await this.store.append(record.id, {
        type: 'goal_recovery_paused',
        record: paused,
        createdAt: at,
        data: { reason: 'recovery_required' },
      })
      pausedGoalIds.push(record.id)
    }
    const diagnostics = await this.store.diagnostics()
    return {
      scanned: records.length,
      pausedGoalIds,
      issues: diagnostics.issues,
    }
  }
}
