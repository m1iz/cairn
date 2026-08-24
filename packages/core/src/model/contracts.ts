export type ModelProbeKind = 'text' | 'vision'

export interface ModelTextContent {
  type: 'text'
  text: string
}

export interface ModelImageContent {
  type: 'image'
  url: string
}

export type ModelContent = ModelTextContent | ModelImageContent

export interface ModelMessage {
  role: string
  content?: unknown
  attributes?: Readonly<Record<string, unknown>>
}

export interface ModelCompletionRequest {
  messages: readonly ModelMessage[]
  model: string
  maxOutputTokens: number
  temperature: number
  reasoningEffort: string | null
  tools?: readonly Readonly<Record<string, unknown>>[] | null
  signal?: AbortSignal
}

export interface ModelToolCallDelta {
  index: number
  id: string
  name: string
  argumentsText: string
}

export interface ModelToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ModelCompletion {
  content: string | null
  toolCalls: readonly ModelToolCall[]
  finishReason: string
  usage: Readonly<Record<string, number>>
  reasoningContent: string | null
  thinkingBlocks: readonly Readonly<Record<string, unknown>>[] | null
}

export interface ModelProbeRequest {
  kind: ModelProbeKind
  entryId: string
  model: string
  provider: string
}

export interface ModelProbeSuccess {
  ok: boolean
  kind: ModelProbeKind
  entryId: string
  latencyMs: number
  model: string
  provider: string
  sample: string
  finishReason: string
}

export interface ModelProbeFailure {
  ok: false
  kind: ModelProbeKind
  entryId: string
  error: string
  latencyMs: number
  model: string
  provider: string
}

export type ModelProbeResult = ModelProbeSuccess | ModelProbeFailure
