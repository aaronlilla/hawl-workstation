// Hawl's part of the app's main process: the one entry point the fork's single startup hook calls.
// This is the only Hawl main-process file that imports Electron.
import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { topFrameOf } from './foreman/ipc'
import { startHawlForeman } from './foreman/start'
import type { ForemanHandle } from './foreman/start'
import type { OwnerNotice } from './foreman/types'

let handle: ForemanHandle | null = null

/** Same trust rule the rest of the app uses for its own window: the dev server's origin, or a file in the package. */
function isAppUrl(url: string): boolean {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) {
    try {
      return new URL(url).origin === new URL(dev).origin
    } catch {
      return false
    }
  }
  return url.startsWith('file://')
}

const NOTICE_TEXT: Record<OwnerNotice['kind'], string> = {
  job_held_offline: 'A job is waiting and none of your agents is online.',
  job_needs_approval: 'A job is waiting for your OK.',
  job_unclaimed: 'None of your agents took a job.',
  job_released: 'A job went back to the site because nobody could take it.',
  line_request: 'Two agents want to talk directly about a job.',
  needs_human: 'A job stopped and needs a person.'
}

/** Start the foreman. Never throws: Hawl failing to start must not stop the editor from starting. */
export async function startHawlMain(): Promise<void> {
  try {
    handle = await startHawlForeman({
      userDataDir: app.getPath('userData'),
      ipc: ipcMain,
      trusted: topFrameOf(isAppUrl),
      emit: (channel, payload) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
            w.webContents.send(channel, payload)
          }
        }
      },
      osNotify: (n) => {
        if (Notification.isSupported()) {
          new Notification({ title: 'Hawl foreman', body: NOTICE_TEXT[n.kind] }).show()
        }
      },
      dev: process.env.HAWL_FOREMAN_DEV === '1'
    })
    app.once('before-quit', () => {
      void handle?.stop()
    })
  } catch (err) {
    console.warn('[hawl-foreman] did not start:', err)
  }
}

/** For the rest of the fork: environment to add to a terminal so its agent can reach the foreman. */
export function hawlTerminalEnv(agentId: string): Record<string, string> {
  return handle?.terminalEnv(agentId) ?? {}
}
