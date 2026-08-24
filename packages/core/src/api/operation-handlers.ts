import type { CoreApi } from './core-api'
import {
  coreOperationKeys,
  invokeCoreOperation,
  type CoreOperationKey,
} from './operations'
import type { OperationHandler } from './operation-dispatcher'

export interface CoreOperationHandlerRegistration {
  domain: string
  operation: CoreOperationKey
  handle: OperationHandler
}

/**
 * Builds the Core operation handlers as explicit domain registrations.
 * Validation and compatibility behavior still have one authority in
 * `invokeCoreOperation`; this module only owns application-layer composition.
 */
export function createCoreOperationHandlers(
  api: CoreApi,
): CoreOperationHandlerRegistration[] {
  return coreOperationKeys().map((operation) => ({
    domain: operationDomain(operation),
    operation,
    handle: (args) => invokeCoreOperation(api, operation, args),
  }))
}

export function groupCoreOperationHandlers(
  registrations: readonly CoreOperationHandlerRegistration[],
): ReadonlyMap<string, readonly CoreOperationHandlerRegistration[]> {
  const groups = new Map<string, CoreOperationHandlerRegistration[]>()
  for (const registration of registrations) {
    const group = groups.get(registration.domain) ?? []
    group.push(registration)
    groups.set(registration.domain, group)
  }
  return new Map(
    [...groups].map(([domain, handlers]) => [
      domain,
      handlers.sort((left, right) =>
        left.operation.localeCompare(right.operation),
      ),
    ]),
  )
}

function operationDomain(operation: CoreOperationKey): string {
  const separator = operation.indexOf('.')
  return separator < 0 ? 'lifecycle' : operation.slice(0, separator)
}
