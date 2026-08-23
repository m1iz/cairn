import { closeSync, fsyncSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'

const WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set([
  'EBADF',
  'EINVAL',
  'EISDIR',
  'EPERM',
])

interface AsyncDirectoryHandle {
  sync(): Promise<void>
  close(): Promise<void>
}

interface AsyncDirectorySyncOperations {
  openDirectory(path: string): Promise<AsyncDirectoryHandle>
  readonly platform: NodeJS.Platform
}

interface SyncDirectorySyncOperations {
  openDirectory(path: string): number
  sync(descriptor: number): void
  close(descriptor: number): void
  readonly platform: NodeJS.Platform
}

const ASYNC_DIRECTORY_SYNC: AsyncDirectorySyncOperations = {
  openDirectory: async (path) => await open(path, 'r'),
  platform: process.platform,
}

const SYNC_DIRECTORY_SYNC: SyncDirectorySyncOperations = {
  openDirectory: (path) => openSync(path, 'r'),
  sync: (descriptor) => fsyncSync(descriptor),
  close: (descriptor) => closeSync(descriptor),
  platform: process.platform,
}

/**
 * Persists a directory entry where the platform supports it. Node/Windows
 * cannot open or fsync directory handles consistently; only those explicit
 * unsupported-operation errors are tolerated. File fsync remains strict.
 */
export async function syncDirectoryBestEffort(
  path: string,
  operations: AsyncDirectorySyncOperations = ASYNC_DIRECTORY_SYNC,
): Promise<void> {
  let handle: AsyncDirectoryHandle | undefined
  try {
    handle = await operations.openDirectory(path)
    await handle.sync()
  } catch (error) {
    if (!unsupportedDirectorySync(error, operations.platform)) throw error
  } finally {
    await handle?.close()
  }
}

export function syncDirectoryBestEffortSync(
  path: string,
  operations: SyncDirectorySyncOperations = SYNC_DIRECTORY_SYNC,
): void {
  let descriptor: number | undefined
  try {
    descriptor = operations.openDirectory(path)
    operations.sync(descriptor)
  } catch (error) {
    if (!unsupportedDirectorySync(error, operations.platform)) throw error
  } finally {
    if (descriptor !== undefined) operations.close(descriptor)
  }
}

function unsupportedDirectorySync(
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  return (
    platform === 'win32' &&
    WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(
      String((error as NodeJS.ErrnoException)?.code ?? ''),
    )
  )
}
