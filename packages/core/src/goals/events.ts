import { createHash } from 'node:crypto'
import type { GoalRecord } from './models'

export const GOAL_EVENT_SCHEMA_VERSION = 'cairn.goal.event.v1' as const

export const GOAL_DOMAIN_EVENT_TYPES = [
  'goal_created',
  'goal_updated',
  'goal_recovery_paused',
  'goal_completed',
  'goal_blocked',
] as const

export type GoalDomainEventType = (typeof GOAL_DOMAIN_EVENT_TYPES)[number]

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

export class GoalJsonValueError extends Error {
  constructor(message = 'Goal persistence value must be strict JSON.') {
    super(message)
    this.name = 'GoalJsonValueError'
  }
}

export interface GoalEventPayload extends Record<string, unknown> {
  readonly record: GoalRecord
}

export interface GoalEventEnvelope<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly schemaVersion: typeof GOAL_EVENT_SCHEMA_VERSION
  readonly goalId: string
  readonly seq: number
  readonly type: GoalDomainEventType
  readonly payload: T
  readonly prevHash: string | null
  readonly hash: string
  readonly createdAt: string
}

export type GoalEventHashInput<T extends Record<string, unknown>> = Omit<
  GoalEventEnvelope<T>,
  'hash'
>

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function createGoalEventEnvelope<T extends Record<string, unknown>>(
  input: GoalEventHashInput<T>,
): GoalEventEnvelope<T> {
  const payload = normalizeJsonValue(input.payload)
  if (!isJsonObject(payload)) throw new GoalJsonValueError()
  const normalized = { ...input, payload: payload as T }
  const envelope = {
    ...normalized,
    hash: computeGoalEventHash(normalized),
  }
  return parseGoalEventEnvelope(envelope) as GoalEventEnvelope<T>
}

export function computeGoalEventHash(
  event: GoalEventEnvelope | GoalEventHashInput<Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: event.schemaVersion,
        goalId: event.goalId,
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        prevHash: event.prevHash,
        createdAt: event.createdAt,
      }),
      'utf8',
    )
    .digest('hex')
}

export function parseGoalEventEnvelope(value: unknown): GoalEventEnvelope {
  if (!isRecord(value)) throw new Error('Goal event must be an object.')
  if (value.schemaVersion !== GOAL_EVENT_SCHEMA_VERSION)
    throw new Error('Goal event schema version is invalid.')
  if (typeof value.goalId !== 'string' || !value.goalId.trim())
    throw new Error('Goal event goalId is invalid.')
  if (!Number.isInteger(value.seq) || Number(value.seq) < 1)
    throw new Error('Goal event seq is invalid.')
  if (
    typeof value.type !== 'string' ||
    !GOAL_DOMAIN_EVENT_TYPES.includes(value.type as GoalDomainEventType)
  )
    throw new Error('Goal event type is invalid.')
  if (!isRecord(value.payload))
    throw new Error('Goal event payload is invalid.')
  if (
    value.prevHash !== null &&
    (typeof value.prevHash !== 'string' || !SHA256_PATTERN.test(value.prevHash))
  )
    throw new Error('Goal event prevHash is invalid.')
  if (typeof value.hash !== 'string' || !SHA256_PATTERN.test(value.hash))
    throw new Error('Goal event hash is invalid.')
  if (
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error('Goal event createdAt is invalid.')
  return value as unknown as GoalEventEnvelope
}

/** Stable key ordering for local corruption/tamper detection; this is not a signature. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(normalizeJsonValue(value)))
}

export function normalizeJsonValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GoalJsonValueError()
    return value
  }
  if (typeof value !== 'object') throw new GoalJsonValueError()
  if (ancestors.has(value)) throw new GoalJsonValueError()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (!descriptor || !('value' in descriptor))
          throw new GoalJsonValueError()
        output.push(normalizeJsonValue(descriptor.value, ancestors))
      }
      if (
        Reflect.ownKeys(value).some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && !isCanonicalArrayIndex(key, value.length)),
        )
      )
        throw new GoalJsonValueError()
      return output
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new GoalJsonValueError()
    const output = Object.create(null) as Record<string, JsonValue>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new GoalJsonValueError()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new GoalJsonValueError()
      output[key] = normalizeJsonValue(descriptor.value, ancestors)
    }
    return output
  } finally {
    ancestors.delete(value)
  }
}

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isJsonObject(value)) return value
  const output = Object.create(null) as Record<string, JsonValue>
  for (const key of Object.keys(value).sort()) {
    output[key] = canonicalValue(value[key]!)
  }
  return output
}

function isCanonicalArrayIndex(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(value)) return false
  const index = Number(value)
  return Number.isSafeInteger(index) && index >= 0 && index < length
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
