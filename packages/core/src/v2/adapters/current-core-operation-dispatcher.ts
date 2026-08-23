import type { CoreApi } from '../../api/core-api'
import {
  type CoreOperationKey,
  type CoreOperationResult,
} from '../../api/operations'
import { OperationDispatcher } from '../application/operation-dispatcher'
import {
  createCurrentCoreOperationHandlers,
  groupCoreOperationHandlers,
} from './current-core-operation-handlers'

export interface CoreOperationDispatcher {
  dispatch<Key extends CoreOperationKey>(
    operation: Key,
    args: unknown,
  ): Promise<CoreOperationResult<Key>>
  operations(): CoreOperationKey[]
}

export function createCurrentCoreOperationDispatcher(
  api: CoreApi,
): CoreOperationDispatcher {
  const dispatcher = new OperationDispatcher()
  const domains = groupCoreOperationHandlers(
    createCurrentCoreOperationHandlers(api),
  )
  for (const handlers of domains.values()) {
    for (const { operation, handle } of handlers) {
      dispatcher.register(operation, handle)
    }
  }
  return {
    dispatch: (operation, args) => dispatcher.dispatch(operation, args),
    operations: () => dispatcher.operations() as CoreOperationKey[],
  }
}
