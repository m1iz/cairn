import { win32 } from 'node:path'

const DEFAULT_WINDOWS_ROOT = 'C:\\Windows'

export function windowsSystemRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environmentValue(env, 'SystemRoot', 'WINDIR')
  return configured && win32.isAbsolute(configured)
    ? win32.normalize(configured)
    : DEFAULT_WINDOWS_ROOT
}

export function windowsSystemExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid Windows system executable name: ${name}`)
  }
  return win32.join(windowsSystemRoot(env), 'System32', name)
}

export function windowsPowerShellExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return win32.join(
    windowsSystemRoot(env),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  ...names: string[]
): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  for (const [name, value] of Object.entries(env)) {
    const normalized = value?.trim()
    if (wanted.has(name.toLowerCase()) && normalized) return normalized
  }
  return null
}
