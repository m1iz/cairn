import type { CoreApi } from './core-api'
import { type CoreOperationKey, type CoreOperationResult } from './operations'
import { OperationDispatcher } from './operation-dispatcher'
import {
  createCoreOperationHandlers,
  groupCoreOperationHandlers,
} from './operation-handlers'

export interface CoreOperationDispatcher {
  dispatch<Key extends CoreOperationKey>(
    operation: Key,
    args: unknown,
  ): Promise<CoreOperationResult<Key>>
  operations(): CoreOperationKey[]
}

export function createCoreOperationDispatcher(
  api: CoreApi,
): CoreOperationDispatcher {
  const dispatcher = new OperationDispatcher()
  const domains = groupCoreOperationHandlers(createCoreOperationHandlers(api))
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
