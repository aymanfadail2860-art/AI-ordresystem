import { app, BrowserWindow, ipcMain, shell, Notification } from 'electron';
import path from 'node:path';
import { AppHostImpl } from '../server/host';
import { SafeStorageSecretStore } from './safeStorageSecrets';
import type { LiveTopic } from '../shared/types';

let win: BrowserWindow | null = null;
let host: AppHostImpl | null = null;

// Kun én instans – to processer må aldrig dele samme database og SMS-forbindelse
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'AI Dispatch',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Eksterne links åbnes i standardbrowseren – aldrig i app-vinduet
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  host = new AppHostImpl({
    dataDir,
    secrets: new SafeStorageSecretStore(dataDir),
    version: app.getVersion(),
    platform: process.platform,
    onLive: (topics: LiveTopic[]) => win?.webContents.send('live', topics),
    onRestartRequested: () => {
      app.relaunch();
      app.exit(0);
    },
    // Medfølgende imsg i app-pakken, ellers Homebrew-installation
    imsgCandidates: [path.join(process.resourcesPath, 'imsg', 'imsg'), '/opt/homebrew/bin/imsg', '/usr/local/bin/imsg'],
    log: (level, msg) => console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](msg),
  });
  ipcMain.handle('invoke', async (_e, method: unknown, params: unknown) => {
    if (typeof method !== 'string' || !/^[a-z]+\.[A-Za-z]+$/.test(method)) return { error: 'Ugyldig metode' };
    return host!.invoke(method, params);
  });
  await host.start();
  host.app().ctx.bus.on('alert', ({ message }: { message: string }) => {
    if (Notification.isSupported()) new Notification({ title: 'AI Dispatch', body: message }).show();
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Programmet kører videre i baggrunden, selv om vinduet lukkes (macOS-konvention)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !host) return;
  e.preventDefault();
  quitting = true;
  void host.stop().finally(() => app.exit(0));
});
