import { describe, expect, it, vi } from 'vitest'
import type { Command, Query } from '../contracts/messages'
import {
  CommandBus,
  MessageHandlerAlreadyRegisteredError,
  MessageHandlerNotFoundError,
  QueryBus,
} from './message-bus'

interface RenameSession extends Command<{ title: string }> {
  kind: 'session.rename'
  sessionId: string
  title: string
}

interface ReadSession extends Query<{ id: string }> {
  kind: 'session.read'
  sessionId: string
}

describe('v2 application message buses', () => {
  it('routes a command to exactly one registered handler', async () => {
    const bus = new CommandBus()
    const handler = vi.fn(async (command: RenameSession) => ({
      title: command.title.trim(),
    }))
    bus.register<RenameSession>('session.rename', handler)

    await expect(
      bus.execute<RenameSession>({
        kind: 'session.rename',
        sessionId: 's1',
        title: ' New title ',
      }),
    ).resolves.toEqual({ title: 'New title' })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('supports reversible registration for scoped composition', async () => {
    const bus = new QueryBus()
    const unregister = bus.register<ReadSession>('session.read', (query) => ({
      id: query.sessionId,
    }))
    await expect(
      bus.ask<ReadSession>({ kind: 'session.read', sessionId: 's1' }),
    ).resolves.toEqual({ id: 's1' })

    unregister()
    await expect(
      bus.ask<ReadSession>({ kind: 'session.read', sessionId: 's1' }),
    ).rejects.toBeInstanceOf(MessageHandlerNotFoundError)
  })

  it('rejects duplicate handlers and missing or blank message kinds', async () => {
    const bus = new CommandBus()
    bus.register('session.rename', () => undefined)

    expect(() => bus.register('session.rename', () => undefined)).toThrow(
      MessageHandlerAlreadyRegisteredError,
    )
    await expect(bus.execute({ kind: 'missing' })).rejects.toBeInstanceOf(
      MessageHandlerNotFoundError,
    )
    await expect(bus.execute({ kind: '  ' })).rejects.toThrow(
      'message kind required',
    )
  })
})
