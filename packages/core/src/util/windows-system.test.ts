import { describe, expect, it } from 'vitest'
import {
  windowsPowerShellExecutable,
  windowsSystemExecutable,
  windowsSystemRoot,
} from './windows-system'

describe('Windows system executable resolution', () => {
  it('resolves executables from an absolute SystemRoot', () => {
    const env = { SystemRoot: 'D:\\Windows' }

    expect(windowsSystemRoot(env)).toBe('D:\\Windows')
    expect(windowsSystemExecutable('taskkill.exe', env)).toBe(
      'D:\\Windows\\System32\\taskkill.exe',
    )
  })

  it('handles Windows environment keys case-insensitively', () => {
    expect(windowsSystemRoot({ windir: 'E:\\Windows' })).toBe('E:\\Windows')
  })

  it('falls back safely when the configured root is absent or relative', () => {
    expect(windowsSystemRoot({})).toBe('C:\\Windows')
    expect(windowsSystemRoot({ SystemRoot: 'Windows' })).toBe('C:\\Windows')
  })

  it('resolves the inbox Windows PowerShell host', () => {
    expect(windowsPowerShellExecutable({ SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
  })

  it('rejects paths in executable names', () => {
    expect(() => windowsSystemExecutable('..\\cmd.exe', {})).toThrow(
      'Invalid Windows system executable name',
    )
  })
})
