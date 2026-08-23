export type OperationHandler = (args: unknown) => unknown | Promise<unknown>

export class OperationHandlerAlreadyRegisteredError extends Error {
  constructor(readonly operation: string) {
    super(`operation handler already registered: ${operation}`)
    this.name = 'OperationHandlerAlreadyRegisteredError'
  }
}

export class OperationHandlerNotFoundError extends Error {
  constructor(readonly operation: string) {
    super(`operation handler not found: ${operation}`)
    this.name = 'OperationHandlerNotFoundError'
  }
}

export class OperationDispatcher {
  private readonly handlers = new Map<string, OperationHandler>()

  register(operation: string, handler: OperationHandler): void {
    const key = normalizeOperation(operation)
    if (this.handlers.has(key))
      throw new OperationHandlerAlreadyRegisteredError(key)
    this.handlers.set(key, handler)
  }

  async dispatch<TResult>(operation: string, args: unknown): Promise<TResult> {
    const key = normalizeOperation(operation)
    const handler = this.handlers.get(key)
    if (!handler) throw new OperationHandlerNotFoundError(key)
    return (await handler(args)) as TResult
  }

  operations(): string[] {
    return [...this.handlers.keys()].sort()
  }
}

function normalizeOperation(operation: string): string {
  const key = String(operation ?? '').trim()
  if (!key) throw new Error('operation required')
  return key
}
