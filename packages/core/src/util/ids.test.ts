import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import { newId, validateName } from './ids'
import { nowMs, nowTs } from './time'

describe('ids/time', () => {
  it('newId keeps prefix and truncates hex to the requested length', () => {
    const id = newId('plan_', 12)
    expect(id.startsWith('plan_')).toBe(true)
    expect(id.slice('plan_'.length)).toMatch(/^[0-9a-f]{12}$/)
    expect(newId('disc_', 10).slice('disc_'.length)).toHaveLength(10)
  })

  it('newId is unique across calls', () => {
    const set = new Set(Array.from({ length: 100 }, () => newId('x_')))
    expect(set.size).toBe(100)
  })

  it('validateName enforces non-empty, length and pattern', () => {
    const pattern = /^[a-z0-9_-]+$/
    expect(
      validateName('worker-1', { pattern, maxLen: 32, label: 'name' }),
    ).toBe('worker-1')
    expect(() =>
      validateName('  ', { pattern, maxLen: 32, label: 'name' }),
    ).toThrow(ValidationError)
    expect(() =>
      validateName('bad name!', { pattern, maxLen: 32, label: 'name' }),
    ).toThrow(ValidationError)
    expect(() =>
      validateName('x'.repeat(33), { pattern, maxLen: 32, label: 'name' }),
    ).toThrow(ValidationError)
  })

  it('time helpers return seconds vs millis', () => {
    const ms = nowMs()
    const ts = nowTs()
    expect(Number.isInteger(ms)).toBe(true)
    expect(ms).toBeGreaterThan(1_700_000_000_000)
    expect(ts).toBeGreaterThan(1_700_000_000)
    expect(ts).toBeLessThan(ms)
  })
})
