import { describe, expect, it, vi } from 'vitest'
import type { ModelCompletionRequest } from '../contracts/model'
import { ModelGateway } from './model-gateway'
import type { ModelPort } from './model-port'

function clock(...values: number[]): { now(): number } {
  let index = 0
  return { now: () => values[index++] ?? values.at(-1) ?? 0 }
}

describe('ModelGateway', () => {
  it('runs a text health probe through the model port', async () => {
    const complete = vi.fn<ModelPort['complete']>().mockResolvedValue({
      content: '  pong  ',
      toolCalls: [],
      finishReason: 'stop',
      usage: {},
      reasoningContent: null,
      thinkingBlocks: null,
    })

    await expect(
      new ModelGateway(clock(100, 128)).probe(
        {
          kind: 'text',
          entryId: 'entry-1',
          model: 'model-1',
          provider: 'provider-1',
        },
        { complete },
      ),
    ).resolves.toEqual({
      ok: true,
      kind: 'text',
      entryId: 'entry-1',
      latencyMs: 28,
      model: 'model-1',
      provider: 'provider-1',
      sample: 'pong',
      finishReason: 'stop',
    })
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'model-1',
        maxOutputTokens: 64,
        temperature: 0,
        reasoningEffort: null,
      }),
    )
  })

  it('uses an image-bearing request and accepts the existing vision answers', async () => {
    let captured: ModelCompletionRequest | undefined
    const port: ModelPort = {
      complete: async (request) => {
        captured = request
        return {
          content: '红色。',
          toolCalls: [],
          finishReason: '',
          usage: {},
          reasoningContent: null,
          thinkingBlocks: null,
        }
      },
    }
    const result = await new ModelGateway(clock(10, 15)).probe(
      {
        kind: 'vision',
        entryId: 'vision',
        model: 'vision-model',
        provider: 'provider-1',
      },
      port,
    )

    expect(result).toMatchObject({
      ok: true,
      sample: '红色。',
      finishReason: 'stop',
    })
    expect(captured?.messages[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image',
          url: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      ]),
    )
  })

  it('normalizes provider failures without throwing', async () => {
    const result = await new ModelGateway(clock(200, 245)).probe(
      {
        kind: 'text',
        entryId: 'entry-1',
        model: 'model-1',
        provider: 'provider-1',
      },
      { complete: async () => Promise.reject(new Error('network down')) },
    )

    expect(result).toEqual({
      ok: false,
      kind: 'text',
      entryId: 'entry-1',
      error: 'network down',
      latencyMs: 45,
      model: 'model-1',
      provider: 'provider-1',
    })
  })
})
