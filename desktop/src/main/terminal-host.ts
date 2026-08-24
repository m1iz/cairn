import * as nodePty from 'node-pty'
import type { PtyHandle, PtyHost } from '@cairn/core'

export class NodePtyHost implements PtyHost {
  spawn(input: {
    executable: string
    args: string[]
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
  }): PtyHandle {
    const terminalProcess = nodePty.spawn(input.executable, input.args, {
      name: 'xterm-256color',
      cols: input.cols,
      rows: input.rows,
      cwd: input.cwd,
      env: input.env,
      ...(process.platform === 'win32' ? {} : { encoding: 'utf8' as const }),
    })
    return {
      pid: terminalProcess.pid,
      write: (data) => terminalProcess.write(data),
      resize: (cols, rows) => terminalProcess.resize(cols, rows),
      kill: () => terminalProcess.kill(),
      onData: (listener) => {
        const subscription = terminalProcess.onData(listener)
        return () => subscription.dispose()
      },
      onExit: (listener) => {
        const subscription = terminalProcess.onExit(listener)
        return () => subscription.dispose()
      },
    }
  }
}
