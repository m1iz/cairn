import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { canonicalJson } from '../goals/events'
import { syncDirectoryBestEffortSync } from '../util/fs-durability'

/** Local Core-only authenticity for persisted Control action metadata. */
export class CoreControlActionSigner {
  private readonly key: Buffer

  constructor(stateRoot: string) {
    const directory = join(stateRoot, 'control')
    const path = join(directory, 'core-action.key')
    mkdirSync(directory, { recursive: true, mode: 0o700 })

    if (!existsSync(path)) {
      const temporaryPath = join(
        directory,
        `.core-action.key.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
      )
      let descriptor: number | undefined
      try {
        descriptor = openSync(temporaryPath, 'wx', 0o600)
        writeFileSync(descriptor, randomBytes(32))
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined

        try {
          linkSync(temporaryPath, path)
          syncDirectoryBestEffortSync(directory)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
        if (existsSync(temporaryPath)) {
          unlinkSync(temporaryPath)
          syncDirectoryBestEffortSync(directory)
        }
      }
    }
    chmodSync(path, 0o600)
    this.key = readFileSync(path)
    if (this.key.length !== 32)
      throw new Error('Core Control action key is unavailable.')
  }

  sign(payload: Readonly<Record<string, unknown>>): string {
    return createHmac('sha256', this.key)
      .update(canonicalJson(payload as never), 'utf8')
      .digest('hex')
  }

  verify(
    payload: Readonly<Record<string, unknown>>,
    signature: unknown,
  ): boolean {
    const actual = String(signature ?? '')
    if (!/^[a-f0-9]{64}$/.test(actual)) return false
    const expected = this.sign(payload)
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  }
}
