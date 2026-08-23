import { describe, expect, it, vi } from 'vitest'
import { createLogger, type LogLevel } from './log'

function capture(level: LogLevel) {
  const lines: {
    level: LogLevel
    msg: string
    fields: Record<string, unknown>
  }[] = []
  const log = createLogger({ level, sink: (l) => lines.push(l) })
  return { log, lines }
}

describe('log', () => {
  it('filters below the configured level', () => {
    const { log, lines } = capture('warn')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error'])
  })

  it('merges child bindings into fields', () => {
    const { log, lines } = capture('debug')
    log.child({ area: 'providers' }).info('hello', { n: 1 })
    expect(lines[0]?.fields).toEqual({ area: 'providers', n: 1 })
  })

  it('default sink routes to console without throwing', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    createLogger({ level: 'info' }).info('x')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
