import type { ModelCompletion, ModelCompletionRequest } from './contracts'
import type {
  ChatArgs,
  LLMProvider,
  LLMResponse,
  OpenAiMessage,
} from '../providers/base'
import type { ModelPort, ModelStreamCallbacks } from './port'

export class ProviderModelPort implements ModelPort {
  constructor(private readonly provider: LLMProvider) {}

  async complete(request: ModelCompletionRequest): Promise<ModelCompletion> {
    return normalizeCompletion(await this.provider.chat(providerArgs(request)))
  }

  async completeStream(
    request: ModelCompletionRequest,
    callbacks: ModelStreamCallbacks,
  ): Promise<ModelCompletion> {
    const response = await this.provider.chatStream({
      ...providerArgs(request),
      onContentDelta: callbacks.onContentDelta,
      onToolCallDelta: callbacks.onToolCallDelta,
      onToolCallComplete: callbacks.onToolCallComplete,
    })
    return normalizeCompletion(response)
  }
}

function providerArgs(request: ModelCompletionRequest): ChatArgs {
  return {
    messages: request.messages.map(toProviderMessage),
    tools: request.tools
      ? request.tools.map((tool) => structuredClone(tool))
      : null,
    model: request.model,
    maxTokens: request.maxOutputTokens,
    temperature: request.temperature,
    reasoningEffort: request.reasoningEffort,
    signal: request.signal ?? null,
  }
}

function normalizeCompletion(response: LLMResponse): ModelCompletion {
  return {
    content: response.content,
    toolCalls: response.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: structuredClone(call.arguments),
    })),
    finishReason: response.finishReason,
    usage: { ...response.usage },
    reasoningContent: response.reasoningContent,
    thinkingBlocks: response.thinkingBlocks
      ? response.thinkingBlocks.map((block) => structuredClone(block))
      : null,
  }
}

function toProviderMessage(
  message: ModelCompletionRequest['messages'][number],
): OpenAiMessage {
  return {
    ...(message.attributes ? structuredClone(message.attributes) : {}),
    role: message.role,
    ...(message.content === undefined
      ? {}
      : { content: toProviderContent(message.content) }),
  }
}

function toProviderContent(content: unknown): unknown {
  if (!Array.isArray(content)) return structuredClone(content)
  return content.map((part) => {
    if (
      part &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      (part as { type?: unknown }).type === 'image' &&
      typeof (part as { url?: unknown }).url === 'string'
    ) {
      return {
        type: 'image_url',
        image_url: { url: (part as { url: string }).url },
      }
    }
    return structuredClone(part)
  })
}
