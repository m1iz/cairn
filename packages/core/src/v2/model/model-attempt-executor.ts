import { ModelProviderError, type ModelProviderErrorKind } from '../../errors'
import type { ProviderErrorKind } from '../../providers/errors'
import {
  DEFAULT_SAMPLING_MAX_ATTEMPTS,
  SamplingCoordinator,
  SamplingDeadlineExceededError,
  SamplingTerminalError,
  type SamplingErrorKind,
} from '../../sampling/coordinator'
import type {
  ModelCompletion,
  ModelCompletionRequest,
} from '../contracts/model'
import { ModelGateway } from './model-gateway'
import type { ModelPort, ModelStreamCallbacks } from './model-port'

export interface ModelAttemptEventSink {
  (event: Record<string, unknown>): void | Promise<void>
}

export interface ExecuteModelAttemptsInput {
  request: ModelCompletionRequest
  port: ModelPort
  recoverRequest(error: unknown): boolean | Promise<boolean>
  model: string
  provider: string | null
  usageType: string
  emit?: ModelAttemptEventSink | null
  stream?: ModelStreamCallbacks
  onRetry?: (retryCount: number, errorKind: ProviderErrorKind) => void
}

export interface ModelAttemptResult {
  completion: ModelCompletion
  retryCount: number
  errorKind: ProviderErrorKind | ''
}

export class ModelAttemptExecutor {
  constructor(
    private readonly sampling: SamplingCoordinator = new SamplingCoordinator(),
    private readonly gateway: ModelGateway = new ModelGateway(),
  ) {}

  async execute(input: ExecuteModelAttemptsInput): Promise<ModelAttemptResult> {
    try {
      const result = await this.sampling.execute({
        signal: input.request.signal ?? null,
        emit: input.emit ? async (event) => input.emit?.({ ...event }) : null,
        invoke: async (attempt) =>
          this.gateway.complete(
            { ...input.request, signal: attempt.signal },
            input.port,
            input.stream,
          ),
        recoverRequest: input.recoverRequest,
        onRetry: async ({
          retryCount,
          classification,
          delayMs,
          requestId,
          attemptId,
          error,
        }) => {
          const kind = providerErrorKind(classification.kind)
          if (input.emit) {
            await input.emit({
              event: 'model_provider_retry',
              model: input.model,
              provider: input.provider,
              usage_type: input.usageType,
              attempt: retryCount,
              max_retries: DEFAULT_SAMPLING_MAX_ATTEMPTS - 1,
              error_kind: kind,
              retry_delay_ms: delayMs,
              request_id: requestId,
              attempt_id: attemptId,
              reason: String(
                error instanceof Error ? error.message : error,
              ).slice(0, 500),
            })
          }
          input.onRetry?.(retryCount, kind)
        },
      })
      return {
        completion: result.value,
        retryCount: result.retryCount,
        errorKind: result.lastErrorKind
          ? providerErrorKind(result.lastErrorKind)
          : '',
      }
    } catch (error) {
      if (error instanceof SamplingTerminalError) {
        if (error.classification.kind === 'context') throw error.originalError
        throw new ModelProviderError(
          modelProviderErrorKind(providerErrorKind(error.classification.kind)),
          { cause: error.originalError },
        )
      }
      if (error instanceof SamplingDeadlineExceededError)
        throw new ModelProviderError('transient', { cause: error })
      throw error
    }
  }
}

function modelProviderErrorKind(
  kind: ProviderErrorKind,
): ModelProviderErrorKind {
  if (
    kind === 'rate_limit' ||
    kind === 'auth' ||
    kind === 'transient' ||
    kind === 'permanent'
  )
    return kind
  return 'unknown'
}

function providerErrorKind(kind: SamplingErrorKind): ProviderErrorKind {
  if (kind === 'context') return 'context_overflow'
  if (kind === 'rate_limit') return 'rate_limit'
  if (kind === 'auth') return 'auth'
  if (kind === 'server' || kind === 'transport') return 'transient'
  if (
    kind === 'schema' ||
    kind === 'permission' ||
    kind === 'doom' ||
    kind === 'content_filter'
  )
    return 'permanent'
  return 'unknown'
}
