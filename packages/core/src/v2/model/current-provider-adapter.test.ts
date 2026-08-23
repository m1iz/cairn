import { describe, expect, it, vi } from 'vitest'
import type { LLMProvider } from '../../providers/base'
import { CurrentProviderModelPort } from './current-provider-adapter'

describe('CurrentProviderModelPort', () => {
  it('maps the v2 request and normalizes the complete provider response', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: 'done',
      toolCalls: [
        { id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } },
      ],
      finishReason: 'tool_calls',
      usage: { input_tokens: 10, output_tokens: 2 },
      reasoningContent: 'brief reasoning',
      thinkingBlocks: [{ type: 'thinking', value: 'private' }],
    })
    const port = new CurrentProviderModelPort({
      chat,
    } as unknown as LLMProvider)
    const controller = new AbortController()

    const result = await port.complete({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            { type: 'image', url: 'data:image/png;base64,abc' },
          ],
        },
      ],
      model: 'model-1',
      maxOutputTokens: 100,
      temperature: 0.2,
      reasoningEffort: 'high',
      signal: controller.signal,
    })

    expect(chat).toHaveBeenCalledWith({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc' },
            },
          ],
        },
      ],
      tools: null,
      model: 'model-1',
      maxTokens: 100,
      temperature: 0.2,
      reasoningEffort: 'high',
      signal: controller.signal,
    })
    expect(result).toEqual({
      content: 'done',
      toolCalls: [
        { id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } },
      ],
      finishReason: 'tool_calls',
      usage: { input_tokens: 10, output_tokens: 2 },
      reasoningContent: 'brief reasoning',
      thinkingBlocks: [{ type: 'thinking', value: 'private' }],
    })
  })
})
