import { closeSync, fsyncSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'

const WINDOWS_UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set([
  'EBADF',
  'EINVAL',
  'EISDIR',
  'EPERM',
])

const WINDOWS_UNSUPPORTED_FILE_FSYNC_CODES = new Set([
  'EBADF',
  'EINVAL',
  'ENOSYS',
  'EPERM',
])

interface AsyncDirectoryHandle {
  sync(): Promise<void>
  close(): Promise<void>
}

interface AsyncFileSyncHandle {
  sync(): Promise<void>
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
 * Persists a file where the platform supports it. Windows Node builds can
 * report EPERM/EINVAL for fsync on an otherwise writable regular file. The
 * rename itself remains atomic, and unsupported Windows fsync operations are
 * tolerated so local stores remain usable after migration.
 */
export async function syncFileBestEffort(
  handle: AsyncFileSyncHandle,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    await handle.sync()
  } catch (error) {
    if (!unsupportedFileSync(error, platform)) throw error
  }
}

export function syncFileBestEffortSync(
  descriptor: number,
  platform: NodeJS.Platform = process.platform,
): void {
  try {
    fsyncSync(descriptor)
  } catch (error) {
    if (!unsupportedFileSync(error, platform)) throw error
  }
}

/**
 * Persists a directory entry where the platform supports it. Node/Windows
 * cannot open or fsync directory handles consistently; only those explicit
 * unsupported-operation errors are tolerated.
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

function unsupportedFileSync(
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  return (
    platform === 'win32' &&
    WINDOWS_UNSUPPORTED_FILE_FSYNC_CODES.has(
      String((error as NodeJS.ErrnoException)?.code ?? ''),
    )
  )
}
