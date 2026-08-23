import { describe, expect, it, vi } from 'vitest'
import {
  syncDirectoryBestEffort,
  syncDirectoryBestEffortSync,
} from './fs-durability'

describe('directory durability compatibility', () => {
  it.each(['EPERM', 'EISDIR', 'EINVAL', 'EBADF'])(
    'tolerates Windows async directory fsync unsupported error %s',
    async (code) => {
      await expect(
        syncDirectoryBestEffort('/state', {
          platform: 'win32',
          openDirectory: async () => {
            throw Object.assign(new Error('unsupported'), { code })
          },
        }),
      ).resolves.toBeUndefined()
    },
  )

  it('closes a Windows async directory handle after unsupported fsync', async () => {
    const close = vi.fn(async () => undefined)
    await expect(
      syncDirectoryBestEffort('/state', {
        platform: 'win32',
        openDirectory: async () => ({
          sync: async () => {
            throw Object.assign(new Error('unsupported'), { code: 'EINVAL' })
          },
          close,
        }),
      }),
    ).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not hide non-Windows or real async I/O failures', async () => {
    for (const [platform, code] of [
      ['darwin', 'EPERM'],
      ['win32', 'EIO'],
    ] as const) {
      await expect(
        syncDirectoryBestEffort('/state', {
          platform,
          openDirectory: async () => {
            throw Object.assign(new Error('I/O failed'), { code })
          },
        }),
      ).rejects.toMatchObject({ code })
    }
  })

  it('tolerates only explicit Windows sync directory errors and still closes', () => {
    const close = vi.fn()
    expect(() =>
      syncDirectoryBestEffortSync('/state', {
        platform: 'win32',
        openDirectory: () => 42,
        sync: () => {
          throw Object.assign(new Error('unsupported'), { code: 'EBADF' })
        },
        close,
      }),
    ).not.toThrow()
    expect(close).toHaveBeenCalledWith(42)
    expect(() =>
      syncDirectoryBestEffortSync('/state', {
        platform: 'win32',
        openDirectory: () => {
          throw Object.assign(new Error('I/O failed'), { code: 'EIO' })
        },
        sync: vi.fn(),
        close: vi.fn(),
      }),
    ).toThrow(/I\/O failed/)
  })
})
