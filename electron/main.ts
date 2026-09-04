import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, screen, shell } from 'electron';
import { initialBounds as computeBounds } from './services/windowBounds';
import { createCore, type Core } from './core';
import type { EventChannel } from '../shared/channels';

/**
 * The desktop shell.
 *
 * All of Flare's behaviour lives in `core.ts`; this file only translates
 * between it and Electron — IPC in, `webContents.send` out — plus the things
 * that are the shell's own job: the window, its remembered bounds, and the
 * macOS application menu. It deliberately does not know what any channel does,
 * so the browser server (which does the same translation over a websocket)
 * cannot drift away from it.
 */

if (process.env.FLARE_USERDATA) {
  app.setPath('userData', process.env.FLARE_USERDATA);
}

let win: BrowserWindow | null = null;
let core: Core | null = null;

function send(channel: EventChannel, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Where the window should open — the rules live in services/windowBounds. */
function initialBounds(): { x?: number; y?: number; width: number; height: number } {
  const settings = core?.settings.get();
  return computeBounds({
    work: screen.getPrimaryDisplay().workAreaSize,
    displays: screen.getAllDisplays().map((d) => d.workArea),
    saved: settings?.bounds,
    userSet: settings?.boundsUserSet,
  });
}

function createWindow(): void {
  const bounds = initialBounds();
  win = new BrowserWindow({
    ...bounds,
    center: bounds.x === undefined,
    minWidth: 940,
    minHeight: 620,
    show: false,
    // matches --n0; a stale value here shows as a flash of the wrong grey
    backgroundColor: '#0d0f13',
    title: 'Flare',
    // mac keeps native traffic lights (inset); win/linux get a custom title bar
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
    // Windows takes the icon from the exe and macOS from the bundle, but on
    // Linux nothing supplies one at runtime — without this the window and the
    // task switcher show the stock Electron diamond.
    ...(process.platform === 'linux'
      ? { icon: path.join(__dirname, '..', 'build', 'icon.png') }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (core?.settings.get().maximized) win.maximize();
  // painting once before showing avoids the white flash of an empty window
  win.once('ready-to-show', () => win?.show());
  win.on('maximize', () => send('evt:windowState', { maximized: true }));
  win.on('unmaximize', () => send('evt:windowState', { maximized: false }));
  /*
   * The moment the size stops being ours and starts being yours.
   *
   * `resized` and `moved` are the user-driven events — plain `resize` also
   * fires for our own `maximize()` call, which would mark a window nobody
   * touched as deliberately sized. Written once; after that the remembered
   * bounds outrank whatever the default of the day is.
   */
  const claimBounds = (): void => {
    if (!core?.settings.get().boundsUserSet) core?.settings.set({ boundsUserSet: true });
  };
  win.on('resized', claimBounds);
  win.on('moved', claimBounds);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (process.env.FLARE_DEV_URL) {
    void win.loadURL(process.env.FLARE_DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.on('close', () => {
    if (!win) return;
    core?.settings.set({
      maximized: win.isMaximized(),
      // a maximized window's bounds are the screen; keep the restore size
      ...(win.isMinimized() || win.isMaximized() ? {} : { bounds: win.getBounds() }),
    });
  });
  win.on('closed', () => {
    win = null;
  });
}

/**
 * The macOS application menu.
 *
 * Windows and Linux get the in-window menu bar and no native one. macOS always
 * shows a menu bar, and an Electron app that never sets one gets the default
 * template — which advertises "Electron" as the app name and, more seriously,
 * is the only thing binding Cmd+C / Cmd+V / Cmd+A. Without it those shortcuts
 * are dead everywhere in the window, including the editor and the terminal.
 *
 * Only the roles that have to be native live here. Everything specific to the
 * app stays in the in-window menu bar, which is the same on all three
 * platforms.
 */
function installMacMenu(): void {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'File',
        submenu: [
          {
            label: 'Open Folder…',
            accelerator: 'Cmd+O',
            click: () => void core?.handle('project:openDialog', []),
          },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

app.whenReady().then(() => {
  installMacMenu();
  core = createCore({
    dataDir: app.getPath('userData'),
    onEvent: send,
    host: {
      pickDirectory: async () => {
        if (!win) return null;
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
      },
      revealInFolder: (abs) => shell.showItemInFolder(abs),
      clipboardWrite: (text) => clipboard.writeText(text),
      clipboardRead: () => clipboard.readText(),
      windowControl: (action) => {
        if (!win) return;
        if (action === 'minimize') win.minimize();
        else if (action === 'maximize') {
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
        } else if (action === 'close') win.close();
      },
      onProjectOpened: (info) => win?.setTitle(`${info.name} — Flare`),
      /*
       * A second window is a second process.
       *
       * One process holds one session — one watcher, one shadow history, one
       * set of terminals with whatever is running in them — so a window cannot
       * host two projects, and opening one here would end the other. Launching
       * ourselves again gives the new project its own of everything, and the
       * MCP registry already expects several instances on a machine.
       */
      openInNewWindow: (root) => {
        spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, FLARE_PROJECT: root },
        }).unref();
      },
    },
  });

  // one generic forwarder per channel; the list comes from the core, so a new
  // handler is reachable from the renderer with no edit here. Each channel is
  // reachable both ways: `invoke` for a call that wants its answer, `send`
  // for one that does not (a keystroke into a terminal).
  for (const channel of core.channels) {
    ipcMain.handle(channel, (_e, ...args: unknown[]) => core?.handle(channel, args));
    ipcMain.on(channel, (_e, ...args: unknown[]) => {
      void core?.handle(channel, args).catch(() => undefined);
    });
  }

  createWindow();

  /*
   * Only an explicitly named project opens itself.
   *
   * Launch used to restore lastProject silently, which meant the start view —
   * the one place recent projects, and any way to pick a different one, are
   * listed — was unreachable in normal use. The last project is still the
   * first entry there, one click or one Enter away.
   */
  const initial = process.env.FLARE_PROJECT;
  if (initial && fs.existsSync(initial)) {
    void core.handle('project:open', [initial]).catch((err) => {
      console.error('failed to open project', err);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // failsafe: never let a lingering pty/conpty/watcher handle keep the app alive
  const forceExit = setTimeout(() => app.exit(0), 2500);
  void (async () => {
    await core?.dispose();
    clearTimeout(forceExit);
    app.exit(0);
  })();
}

app.on('window-all-closed', shutdown);
// app.quit() (e.g. from the test driver or macOS Cmd+Q) skips window-all-closed
app.on('before-quit', (e) => {
  if (!shuttingDown) {
    e.preventDefault();
    shutdown();
  }
});
