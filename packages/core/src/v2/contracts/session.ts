export interface SessionActorPort<TBindings> {
  readonly sessionId: string
  submit<TResult>(
    commandId: string,
    execute: (bindings: TBindings, signal: AbortSignal) => Promise<TResult>,
    options?: { signal?: AbortSignal | null; touchedAt?: number },
  ): Promise<TResult>
  cancel(commandId?: string | null): boolean
  close(): Promise<void>
}
