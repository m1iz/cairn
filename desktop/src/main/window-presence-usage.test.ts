import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('desktop tray lifecycle wiring', () => {
  const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')

  it('keeps the Core host alive when a Windows close is redirected to tray', () => {
    expect(source).toContain('shouldKeepRunningInTray({')
    expect(source).toContain('hideWindowForTray(event, win)')
    expect(source).toContain("{ label: '退出 Cairn', click: requestAppQuit }")
    expect(source).not.toContain(
      "app.on('window-all-closed', () => {\n    if (packagedSmoke) return\n    closeCoreHost()",
    )
  })

  it('detaches the captured web contents instead of reading a destroyed window', () => {
    expect(source).toContain('const windowWebContents = win.webContents')
    expect(source).toContain('coreEventBridge.detach(windowWebContents)')
    expect(source).toContain('terminalEventBridge.detach(windowWebContents)')
    expect(source).not.toContain('detach(mainWindow.webContents)')
  })

  it('waits for Core shutdown before allowing an explicit quit', () => {
    const closeOffset = source.indexOf('void closeCoreHost().finally(() => {')
    const allowOffset = source.indexOf('allowQuit = true', closeOffset)
    const quitOffset = source.indexOf('app.quit()', allowOffset)

    expect(closeOffset).toBeGreaterThan(-1)
    expect(allowOffset).toBeGreaterThan(closeOffset)
    expect(quitOffset).toBeGreaterThan(allowOffset)
    expect(source).toContain(
      'if (coreClosing) {\n      event.preventDefault()\n      return\n    }',
    )
  })
})
