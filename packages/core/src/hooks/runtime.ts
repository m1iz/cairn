import { randomUUID } from 'node:crypto'
import { HookAuditStore } from './audit'
import { HookConfigLoader } from './config'
import { aggregateHookResults } from './decision'
import { executeHook } from './executor'
import { buildHookInput, findMatchingHooks } from './matcher'
import type {
  HookAggregateDecision,
  HookAuditRecord,
  HookEventName,
  HookExecutionResult,
  HookSource,
} from './models'
import * as hookEvents from '../runtime/events'

export type HookRuntimeEmitter = (
  event: Record<string, unknown>,
) => void | Promise<void>

export interface HookRuntimeRunOptions {
  sessionId: string
  cwd: string
  projectRoot?: string | null
  stateRoot?: string | null
  source?: string | null
  toolName?: string | null
  toolInput?: Record<string, unknown> | null
  toolResult?: unknown
  permission?: Record<string, unknown> | null
  prompt?: string | null
  signal?: AbortSignal | null
  [key: string]: unknown
}

export class HookRuntime {
  readonly stateRoot: string
  readonly loader: HookConfigLoader
  readonly audit: HookAuditStore
  private readonly emitEvent: HookRuntimeEmitter | null

  constructor(opts: { stateRoot: string; emit?: HookRuntimeEmitter | null }) {
    this.stateRoot = opts.stateRoot
    this.loader = new HookConfigLoader({ stateRoot: opts.stateRoot })
    this.audit = new HookAuditStore(opts.stateRoot)
    this.emitEvent = opts.emit ?? null
  }

  async run(
    eventName: HookEventName,
    opts: HookRuntimeRunOptions,
  ): Promise<HookAggregateDecision> {
    const loaded = await this.loader.load({
      projectRoot: opts.projectRoot ?? null,
    })
    const input = buildHookInput(eventName, {
      ...opts,
      stateRoot: opts.stateRoot ?? this.stateRoot,
    })
    const hooks = findMatchingHooks(loaded.config, input)
    const results: HookExecutionResult[] = []
    for (const hook of hooks) {
      await this.emit(
        hookEvents.hookRunStarted({
          hookId: hook.id,
          eventName,
          handlerType: hook.handler.type,
          source: hook.source ? { ...hook.source } : null,
        }),
      )
      await this.emit(
        hookEvents.hookRunProgress({
          hookId: hook.id,
          eventName,
          status: 'executing',
        }),
      )
      const result = await executeHook(hook, input)
      results.push(result)
      await this.audit.append(
        auditRecordFromResult(result, {
          eventName,
          handlerType: hook.handler.type,
          source: hook.source ?? fallbackSource(this.loader.globalConfigPath),
        }),
      )
      const event =
        result.status === 'completed' || result.status === 'skipped'
          ? hookEvents.hookRunCompleted({
              hookId: hook.id,
              eventName,
              status: result.status,
              decision: result.decision,
              reason: result.reason,
              durationMs: result.durationMs,
            })
          : hookEvents.hookRunFailed({
              hookId: hook.id,
              eventName,
              status: result.status,
              decision: result.decision,
              reason: result.reason,
              durationMs: result.durationMs,
            })
      await this.emit(event)
    }
    const decision = aggregateHookResults(results)
    if (results.length > 0) {
      await this.emit(
        hookEvents.hookDecisionApplied({
          eventName,
          decision: decision.decision,
          reason: decision.reason,
          hookIds: results.map((result) => result.hookId),
        }),
      )
    }
    return decision
  }

  private async emit(event: Record<string, unknown>): Promise<void> {
    if (this.emitEvent) await this.emitEvent(event)
  }
}

function auditRecordFromResult(
  result: HookExecutionResult,
  opts: {
    eventName: HookEventName
    handlerType: HookAuditRecord['handlerType']
    source: HookSource
  },
): HookAuditRecord {
  return {
    id: `hook_audit_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    hookId: result.hookId,
    eventName: opts.eventName,
    handlerType: opts.handlerType,
    source: opts.source,
    startedAt: new Date(Date.now() - result.durationMs).toISOString(),
    durationMs: result.durationMs,
    status: result.status,
    decision: result.decision,
    reason: result.reason,
  }
}

function fallbackSource(path: string): HookSource {
  return { kind: 'global', path, readonly: false }
}
