import type {
  ModelCompletion,
  ModelCompletionRequest,
  ModelToolCall,
  ModelToolCallDelta,
} from '../contracts/model'

export interface ModelStreamCallbacks {
  onContentDelta?: (text: string) => void | Promise<void>
  onToolCallDelta?: (delta: ModelToolCallDelta) => void | Promise<void>
  onToolCallComplete?: (call: ModelToolCall) => void | Promise<void>
}

export interface ModelPort {
  complete(request: ModelCompletionRequest): Promise<ModelCompletion>
  completeStream?(
    request: ModelCompletionRequest,
    callbacks: ModelStreamCallbacks,
  ): Promise<ModelCompletion>
}

export interface ClockPort {
  now(): number
}

export const systemClock: ClockPort = Object.freeze({
  now: () => Date.now(),
})
