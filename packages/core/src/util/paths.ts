import { realpathSync } from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'

export function toPortablePath(value: string, pathSeparator = sep): string {
  return pathSeparator === '/' ? value : value.split(pathSeparator).join('/')
}

export function relativePortable(from: string, to: string): string {
  return toPortablePath(relative(from, to))
}

export function relativePortableOrAbsolute(from: string, to: string): string {
  const absolute = resolve(to)
  const rel = relative(resolve(from), absolute)
  return isRelativeEscape(rel) ? absolute : toPortablePath(rel)
}

export function pathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

export function isPathWithin(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path))
  return !isRelativeEscape(rel)
}

export function canonicalizeExistingPath(path: string): string {
  const tail: string[] = []
  let current = resolve(path)
  while (true) {
    try {
      const real = realpathSync.native(current)
      return tail.length ? resolve(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      tail.push(basename(current))
      current = parent
    }
  }
}

function isRelativeEscape(value: string): boolean {
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)
}
