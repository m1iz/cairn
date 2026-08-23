declare const messageResult: unique symbol

export interface Command<TResult = void> {
  readonly kind: string
  readonly [messageResult]?: TResult
}

export interface Query<TResult> {
  readonly kind: string
  readonly [messageResult]?: TResult
}

export type MessageResult<TMessage> = TMessage extends
  Command<infer TResult> | Query<infer TResult>
  ? TResult
  : never

export type MessageHandler<TMessage, TResult> = (
  message: TMessage,
) => TResult | Promise<TResult>
