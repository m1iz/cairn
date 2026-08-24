import type {
  ModelCompletion,
  ModelCompletionRequest,
  ModelProbeRequest,
  ModelProbeResult,
} from './contracts'
import {
  type ClockPort,
  type ModelPort,
  type ModelStreamCallbacks,
  systemClock,
} from './port'

const RED_PIXEL_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

export class ModelGateway {
  constructor(private readonly clock: ClockPort = systemClock) {}

  async complete(
    request: ModelCompletionRequest,
    port: ModelPort,
    callbacks?: ModelStreamCallbacks,
  ): Promise<ModelCompletion> {
    if (callbacks && port.completeStream)
      return port.completeStream(request, callbacks)
    const completion = await port.complete(request)
    if (callbacks?.onContentDelta && completion.content)
      await callbacks.onContentDelta(completion.content)
    if (callbacks?.onToolCallComplete) {
      for (const call of completion.toolCalls)
        await callbacks.onToolCallComplete(call)
    }
    return completion
  }

  async probe(
    request: ModelProbeRequest,
    port: ModelPort,
  ): Promise<ModelProbeResult> {
    const started = this.clock.now()
    try {
      const response = await port.complete(probeCompletion(request))
      const sample = String(response.content || '')
        .trim()
        .slice(0, 200)
      return {
        ok:
          request.kind === 'vision'
            ? isExpectedVisionAnswer(sample)
            : /pong/i.test(sample),
        kind: request.kind,
        entryId: request.entryId,
        latencyMs: this.clock.now() - started,
        model: request.model,
        provider: request.provider,
        sample,
        finishReason: response.finishReason || 'stop',
      }
    } catch (error) {
      return {
        ok: false,
        kind: request.kind,
        entryId: request.entryId,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: this.clock.now() - started,
        model: request.model,
        provider: request.provider,
      }
    }
  }
}

function probeCompletion(request: ModelProbeRequest): ModelCompletionRequest {
  return {
    messages:
      request.kind === 'vision'
        ? [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'What is the color of this image? Reply with one word.',
                },
                { type: 'image', url: RED_PIXEL_DATA_URL },
              ],
            },
          ]
        : [
            {
              role: 'user',
              content: 'Reply with exactly one word: pong',
            },
          ],
    model: request.model,
    maxOutputTokens: 64,
    temperature: 0,
    reasoningEffort: null,
  }
}

function isExpectedVisionAnswer(sample: string): boolean {
  const normalized = sample
    .trim()
    .toLowerCase()
    .replace(/[.!。！]+$/g, '')
  return normalized === 'red' || normalized === '红' || normalized === '红色'
}
