import type {
  Command,
  MessageHandler,
  MessageResult,
  Query,
} from '../contracts/messages'

type UnknownMessage = Command<unknown> | Query<unknown>
type UnknownHandler = MessageHandler<UnknownMessage, unknown>

export class MessageHandlerAlreadyRegisteredError extends Error {
  constructor(readonly kind: string) {
    super(`message handler already registered: ${kind}`)
    this.name = 'MessageHandlerAlreadyRegisteredError'
  }
}

export class MessageHandlerNotFoundError extends Error {
  constructor(readonly kind: string) {
    super(`message handler not found: ${kind}`)
    this.name = 'MessageHandlerNotFoundError'
  }
}

abstract class MessageBus {
  private readonly handlers = new Map<string, UnknownHandler>()

  register<TMessage extends UnknownMessage>(
    kind: TMessage['kind'],
    handler: MessageHandler<TMessage, MessageResult<TMessage>>,
  ): () => void {
    const normalized = normalizeKind(kind)
    if (this.handlers.has(normalized))
      throw new MessageHandlerAlreadyRegisteredError(normalized)
    this.handlers.set(normalized, handler as UnknownHandler)
    return () => {
      if (this.handlers.get(normalized) === handler)
        this.handlers.delete(normalized)
    }
  }

  protected async dispatch<TResult>(message: UnknownMessage): Promise<TResult> {
    const kind = normalizeKind(message.kind)
    const handler = this.handlers.get(kind)
    if (!handler) throw new MessageHandlerNotFoundError(kind)
    return (await handler(message)) as TResult
  }
}

export class CommandBus extends MessageBus {
  execute<TCommand extends Command<unknown>>(
    command: TCommand,
  ): Promise<MessageResult<TCommand>> {
    return this.dispatch(command)
  }
}

export class QueryBus extends MessageBus {
  ask<TQuery extends Query<unknown>>(
    query: TQuery,
  ): Promise<MessageResult<TQuery>> {
    return this.dispatch(query)
  }
}

function normalizeKind(kind: string): string {
  const normalized = String(kind ?? '').trim()
  if (!normalized) throw new Error('message kind required')
  return normalized
}
