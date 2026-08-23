import type { CoreOperationKey } from '@cairn/core'

export const CORE_IPC_PREFIX = 'cairn:core:'
export const CORE_EVENT_CHANNEL = 'cairn:core:event'
export const TERMINAL_EVENT_CHANNEL = 'cairn:terminal:event'
export const TERMINAL_SUBSCRIPTION_CHANNEL = 'cairn:terminal:subscription'

const OPERATION_KEY_RE = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/

export function channelForCoreOperation(
  operationKey: CoreOperationKey,
): string {
  const key = String(operationKey || '').trim()
  if (!OPERATION_KEY_RE.test(key))
    throw new Error(`invalid core IPC operation: ${operationKey}`)
  return CORE_IPC_PREFIX + key.replaceAll('.', ':')
}
