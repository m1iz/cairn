import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  net,
  shell,
  Tray,
  type OpenDialogOptions,
} from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CoreApi } from '@cairn/core'

import { resolveConfig } from './config'
import { resolveAppIconPath } from './icon'
import { preparePackagedRuntime, runtimeDefaultsRoot } from './runtime-root'
import { readBounds, pickBounds } from './window-bounds'
import {
  appAssetRequestAccess,
  resolveAssetPath,
  resolveAttachmentRawPath,
  resolveMediaRawPath,
} from './protocol'
import { createCoreHost } from './core-host'
import { CoreEventBridge } from './event-bridge'
import { moduleDirFromUrl } from './esm-path'
import { parsePackagedSmokeArgs, runPackagedSmoke } from './packaged-smoke'
import {
  createPackagedSmokeAttachment,
  verifyPackagedRenderer,
} from './packaged-renderer-smoke'
import {
  createTrustedRendererPolicy,
  type TrustedRendererPolicy,
} from './trusted-renderer'
import { mainWindowWebPreferences } from './window-security'
import { NodePtyHost } from './terminal-host'
import { TerminalEventBridge } from './terminal-event-bridge'
import { installSingleInstanceGuard } from './single-instance'
import {
  hideWindowForTray,
  revealMainWindow,
  shouldKeepRunningInTray,
} from './window-presence'
import { TERMINAL_SUBSCRIPTION_CHANNEL } from '../shared/ipc-contract'

const mainDir = moduleDirFromUrl(import.meta.url)
const mainArgv = process.argv.slice(2)
const packagedSmoke = parsePackagedSmokeArgs(process.argv)
let config = resolveConfig({ argv: mainArgv, env: process.env })
let legacyRuntimeRoot = config.runtimeRoot
let packagedRuntimeRevision = ''
const rendererRoot = path.join(mainDir, '..', 'renderer')
const appIconPath = resolveAppIconPath({
  dirname: mainDir,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})

let coreApi: CoreApi | null = null
const coreEventBridge = new CoreEventBridge()
const terminalEventBridge = new TerminalEventBridge()
let runtimeReady = false
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let allowQuit = false
let didShowTrayHint = false
let coreClosing: Promise<void> | null = null
let didLoadRetry = false
const isPrimaryInstance =
  packagedSmoke !== null ||
  installSingleInstanceGuard(app, () => {
    if ((!mainWindow || mainWindow.isDestroyed()) && runtimeReady)
      createWindow()
    return mainWindow
  })
const trustedRendererPolicy = createTrustedRendererPolicy({
  productionUrl: 'app://bundle/index.html',
  developmentUrl: process.env.ELECTRON_RENDERER_URL ?? null,
  mainWebContents: () => mainWindow?.webContents ?? null,
  openExternal: (url) => shell.openExternal(url),
  onExternalOpenError: (error, url) => {
    console.error(`failed to open external URL ${url}: ${errMessage(error)}`)
  },
})

ipcMain.on(TERMINAL_SUBSCRIPTION_CHANNEL, (event, payload: unknown) => {
  trustedRendererPolicy.authorizeIpc(event)
  terminalEventBridge.setSubscription(
    event.sender,
    terminalSubscription(payload),
  )
})

ipcMain.handle('cairn:window-action', (event, payload: unknown) => {
  trustedRendererPolicy.authorizeIpc(event)
  if (
    payload !== 'minimize' &&
    payload !== 'toggle-maximize' &&
    payload !== 'close' &&
    payload !== 'quit'
  ) {
    return { ok: false, error: 'Unsupported window action' }
  }

  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return { ok: false, error: 'Window is unavailable' }

  if (payload === 'quit') requestAppQuit()
  else if (payload === 'minimize') window.minimize()
  else if (payload === 'toggle-maximize') {
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  } else window.close()

  return { ok: true }
})

function terminalSubscription(
  payload: unknown,
): { sessionId: string; terminalId: string } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null
  const record = payload as Record<string, unknown>
  const sessionId =
    typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
  const terminalId =
    typeof record.terminalId === 'string' ? record.terminalId.trim() : ''
  if (
    !sessionId ||
    !terminalId ||
    sessionId.length > 256 ||
    terminalId.length > 256
  )
    return null
  return { sessionId, terminalId }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

ipcMain.handle('cairn:select-directory', async (event) => {
  trustedRendererPolicy.authorizeIpc(event)
  const options: OpenDialogOptions = {
    properties: ['openDirectory'],
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('cairn:open-path', async (event, target: unknown) => {
  trustedRendererPolicy.authorizeIpc(event)
  const pathValue = typeof target === 'string' ? target.trim() : ''
  if (!pathValue) return { ok: false, error: 'path is required' }
  const error = await shell.openPath(pathValue)
  return error ? { ok: false, error } : { ok: true }
})

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function mainBoundsPath(): string {
  return path.join(config.stateRoot, 'memory', 'desktop', 'window.json')
}

function prepareMainRuntime(): void {
  if (app.isPackaged) {
    const signedRoot = runtimeDefaultsRoot(process.resourcesPath)
    config = resolveConfig({
      argv: mainArgv,
      env: process.env,
      forcedRuntimeRoot: signedRoot,
    })
    const prepared = preparePackagedRuntime({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      stateRoot: config.stateRoot,
      appVersion: app.getVersion(),
    })
    legacyRuntimeRoot = prepared.legacyRuntimeRoot
    packagedRuntimeRevision = prepared.manifest.runtimeRevision
    return
  }
  config = resolveConfig({ argv: mainArgv, env: process.env })
  legacyRuntimeRoot = config.runtimeRoot
}

function closeCoreHost(): Promise<void> {
  if (coreClosing) return coreClosing
  if (!coreApi) return Promise.resolve()
  const current = coreApi
  coreApi = null
  coreClosing = current.close().catch((err) => {
    console.error(`failed to close CoreApi: ${errMessage(err)}`)
  })
  return coreClosing
}

function fail(title: string, message: string): void {
  dialog.showErrorBox(title, message)
  isQuitting = true
  app.quit()
}

function requestAppQuit(): void {
  isQuitting = true
  app.quit()
}

function showMainWindow(): void {
  if (!runtimeReady || isQuitting) return
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  revealMainWindow(mainWindow)
}

function createTray(): void {
  if (process.platform !== 'win32' || tray) return
  try {
    const icon = nativeImage.createFromPath(appIconPath).resize({
      width: 16,
      height: 16,
    })
    if (icon.isEmpty()) throw new Error(`tray icon is empty: ${appIconPath}`)
    const nextTray = new Tray(icon)
    nextTray.setToolTip('Cairn · 本地 Agent')
    nextTray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 Cairn', click: showMainWindow },
        { type: 'separator' },
        { label: '退出 Cairn', click: requestAppQuit },
      ]),
    )
    nextTray.on('click', showMainWindow)
    tray = nextTray
  } catch (error) {
    console.error(`failed to create tray: ${errMessage(error)}`)
    tray = null
  }
}

function showTrayHint(): void {
  if (!tray || didShowTrayHint) return
  didShowTrayHint = true
  try {
    tray.displayBalloon({
      title: 'Cairn 仍在后台运行',
      content: '定时任务会继续执行；点击托盘图标可重新打开。',
      iconType: 'info',
      noSound: true,
    })
  } catch {
    // Tooltip and context menu remain available if the shell rejects balloons.
  }
}

function destroyTray(): void {
  tray?.destroy()
  tray = null
}

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    const access = appAssetRequestAccess(
      url.host,
      request.headers.get('Origin'),
    )
    if (!access.allowed)
      return new Response('asset origin forbidden', { status: 403 })
    if (url.host === 'attachments') {
      const attachmentPath = resolveAttachmentRawPath(request.url, {
        stateRoot: config.stateRoot,
        legacyRuntimeRoot,
      })
      if (!attachmentPath)
        return new Response('attachment not found', { status: 404 })
      return net.fetch(pathToFileURL(attachmentPath).toString())
    }
    if (url.host === 'media') {
      const mediaPath = resolveMediaRawPath(request.url, {
        stateRoot: config.stateRoot,
        legacyRuntimeRoot,
      })
      if (!mediaPath) return new Response('media not found', { status: 404 })
      return net.fetch(pathToFileURL(mediaPath).toString())
    }
    let filePath: string | null = null
    if (url.host === 'bundle')
      filePath = resolveAssetPath(url.pathname, rendererRoot)
    if (!filePath) return new Response('asset not found', { status: 404 })
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function loadRenderer(): void {
  if (!mainWindow) return
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadURL('app://bundle/index.html')
}

function secureWindowNavigation(
  win: BrowserWindow,
  policy: TrustedRendererPolicy,
): void {
  win.webContents.on('will-navigate', (event, targetUrl) =>
    policy.handleNavigation(event, targetUrl),
  )
  win.webContents.on('will-redirect', (event, targetUrl) =>
    policy.handleNavigation(event, targetUrl),
  )
  win.webContents.setWindowOpenHandler((details) =>
    policy.handleWindowOpen(details),
  )
}

function createWindow(): void {
  const boundsPath = mainBoundsPath()
  const win = new BrowserWindow({
    ...readBounds(boundsPath),
    title: '',
    icon: appIconPath,
    backgroundColor: '#1a1410',
    show: false,
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#1d2126',
            symbolColor: '#aab1bc',
            height: 30,
          },
        }
      : {}),
    webPreferences: mainWindowWebPreferences(mainDir),
  })
  const windowWebContents = win.webContents
  mainWindow = win
  coreEventBridge.attach(windowWebContents)
  terminalEventBridge.attach(windowWebContents)
  secureWindowNavigation(win, trustedRendererPolicy)

  win.once('ready-to-show', () => {
    if (mainWindow === win) win.show()
  })

  windowWebContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription) => {
      console.error(`did-fail-load: ${errorCode} ${errorDescription}`)
      if (!didLoadRetry) {
        didLoadRetry = true
        loadRenderer()
      } else {
        fail('页面加载失败', `无法加载前端（${errorDescription}）。`)
      }
    },
  )

  win.on('close', (event) => {
    try {
      fs.mkdirSync(path.dirname(boundsPath), { recursive: true })
      const payload = pickBounds(win.getBounds())
      fs.writeFileSync(
        boundsPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      )
    } catch {
      // Best-effort persistence; never block window close on disk errors.
    }
    if (
      shouldKeepRunningInTray({
        platform: process.platform,
        quitting: isQuitting,
        trayAvailable: tray !== null,
      })
    ) {
      hideWindowForTray(event, win)
      showTrayHint()
    }
  })
  win.on('closed', () => {
    coreEventBridge.detach(windowWebContents)
    terminalEventBridge.detach(windowWebContents)
    if (mainWindow === win) mainWindow = null
  })

  loadRenderer()
}

async function startup(): Promise<void> {
  app.setName('Cairn')
  if (process.platform === 'win32') Menu.setApplicationMenu(null)
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  if (process.platform === 'win32')
    app.setAppUserModelId('com.cairn.agent.desktop')

  try {
    if (packagedSmoke && !app.isPackaged)
      throw new Error('packaged smoke mode requires a packaged application')
    prepareMainRuntime()
    coreApi = await createCoreHost({
      root: config.runtimeRoot,
      ipcMain,
      eventBridge: coreEventBridge,
      authorizeIpc: (event) => trustedRendererPolicy.authorizeIpc(event),
      coreOptions: {
        appVersion: app.getVersion(),
        ...(packagedRuntimeRevision
          ? { runtimeRevision: packagedRuntimeRevision }
          : {}),
        stateRoot: config.stateRoot,
        legacyRuntimeRoot: app.isPackaged ? legacyRuntimeRoot : null,
        legacyRuntimeSkillsHandled: app.isPackaged,
        terminalHost: new NodePtyHost(),
        terminalEventSink: terminalEventBridge.sink(),
      },
    })
    registerAppProtocol()
    if (packagedSmoke) {
      const attachment = await createPackagedSmokeAttachment(config.stateRoot)
      await runPackagedSmoke({
        core: coreApi,
        runtimeRoot: config.runtimeRoot,
        stateRoot: config.stateRoot,
        receiptPath: packagedSmoke.receiptPath,
        appVersion: app.getVersion(),
        runtimeRevision: packagedRuntimeRevision,
        commit: process.env.CAIRN_BUILD_COMMIT || 'local',
        platform: process.platform,
        arch: process.arch,
        verifyRenderer: () => {
          const webPreferences = mainWindowWebPreferences(mainDir)
          return verifyPackagedRenderer({
            createWindow: () => {
              const win = new BrowserWindow({
                show: false,
                backgroundColor: '#1a1410',
                webPreferences,
              })
              mainWindow = win
              secureWindowNavigation(win, trustedRendererPolicy)
              return win
            },
            attachmentUrl: attachment.url,
            attachmentContent: attachment.content,
            chromiumSandboxDisabledForTest:
              process.argv.includes('--no-sandbox'),
            webPreferences,
            releaseWindow: () => {
              mainWindow = null
            },
          })
        },
      })
      await coreApi.close()
      coreApi = null
      app.exit(0)
      return
    }
  } catch (err) {
    if (packagedSmoke) {
      console.error(`packaged smoke failed: ${errMessage(err)}`)
      if (coreApi) await coreApi.close().catch(() => {})
      coreApi = null
      app.exit(1)
      return
    }
    fail('CoreApi 初始化失败', errMessage(err))
    return
  }
  runtimeReady = true

  createWindow()
  createTray()
}

if (isPrimaryInstance) {
  app.whenReady().then(startup)

  app.on('activate', () => {
    showMainWindow()
  })

  app.on('window-all-closed', () => {
    if (packagedSmoke) return
    if (process.platform === 'win32' && tray && !isQuitting) return
    if (!isQuitting) requestAppQuit()
  })

  app.on('before-quit', (event) => {
    isQuitting = true
    if (allowQuit) return
    if (coreClosing) {
      event.preventDefault()
      return
    }
    if (!coreApi) return
    event.preventDefault()
    void closeCoreHost().finally(() => {
      allowQuit = true
      destroyTray()
      app.quit()
    })
  })

  app.on('will-quit', destroyTray)
}
