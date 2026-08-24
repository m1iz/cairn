import { beforeEach, describe, expect, it, vi } from 'vitest'

const pty = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

vi.mock('node-pty', () => ({ spawn: pty.spawn }))

import { NodePtyHost } from './terminal-host'

describe('NodePtyHost', () => {
  beforeEach(() => {
    pty.spawn.mockReset()
    pty.spawn.mockReturnValue({
      pid: 123,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    })
  })

  it('does not pass the unsupported encoding option to node-pty on Windows', () => {
    new NodePtyHost().spawn({
      executable: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      args: [],
      cwd: process.cwd(),
      env: {},
      cols: 80,
      rows: 24,
    })

    const options = pty.spawn.mock.calls[0]?.[2]
    if (process.platform === 'win32')
      expect(options).not.toHaveProperty('encoding')
    else expect(options).toMatchObject({ encoding: 'utf8' })
  })
})
