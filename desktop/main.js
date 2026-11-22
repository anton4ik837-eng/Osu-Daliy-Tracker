const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const PROTOCOL = 'osudailytracker';
const logPath = path.join(app.getPath('userData'), 'osu-daily-tracker-log.jsonl');
let mainWindow = null;
let authWindow = null;
let pendingOAuthUrl = null;

Menu.setApplicationMenu(null);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function appendLogLine(line) {
  try {
    fs.appendFileSync(logPath, String(line || '').endsWith('\n') ? String(line) : String(line) + '\n', 'utf8');
  } catch (error) {
    console.error('Desktop log write failed:', error);
  }
}

function deliverOAuthUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith(PROTOCOL + '://')) return;
  pendingOAuthUrl = url;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('oauth:callback', url);
  }
}

function handleCommandLine(argv) {
  const normalized = (argv || []).map(arg => String(arg).replace(/^"+|"+$/g, ''));
  const arg = normalized.find(value => value.includes(PROTOCOL + '://'));
  if (!arg) return;
  const index = arg.indexOf(PROTOCOL + '://');
  deliverOAuthUrl(arg.slice(index));
}

ipcMain.handle('desktop:logs-append', (_event, line) => {
  appendLogLine(line);
  return true;
});

ipcMain.handle('desktop:logs-start', () => ({ fileName: path.basename(logPath), path: logPath }));

ipcMain.handle('desktop:logs-export', async (_event, options) => {
  const filename = String(options?.filename || 'osu-daily-tracker-log.jsonl');
  const content = String(options?.content || '');
  const result = await dialog.showSaveDialog({
    title: 'Save diagnostic log',
    defaultPath: filename,
    filters: [{ name: 'JSON Lines', extensions: ['jsonl', 'json', 'txt'] }]
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { fileName: path.basename(result.filePath) };
});

ipcMain.handle('desktop:open-external', async (_event, url) => {
  const value = String(url || '');
  if (!/^https?:\/\//i.test(value)) return false;
  await shell.openExternal(value);
  return true;
});

ipcMain.handle('oauth:get-launch-url', () => pendingOAuthUrl);

ipcMain.handle('oauth:open-auth', (_event, url) => {
  const target = String(url || '');
  if (!/^https:\/\//i.test(target)) return false;
  if (authWindow && !authWindow.isDestroyed()) authWindow.focus();
  else {
    authWindow = new BrowserWindow({
      width: 900,
      height: 720,
      title: 'osu! · подтверждение аккаунта',
      parent: mainWindow || undefined,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    authWindow.setMenu(null);
    const capture = (event, nextUrl) => {
      const value = String(nextUrl || '');
      if (!value.includes(PROTOCOL + '://')) return;
      event.preventDefault();
      const index = value.indexOf(PROTOCOL + '://');
      deliverOAuthUrl(value.slice(index));
      if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      authWindow = null;
    };
    authWindow.webContents.on('will-navigate', capture);
    authWindow.webContents.on('will-frame-navigate', capture);
    authWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (String(url || '').includes(PROTOCOL + '://')) {
        capture({ preventDefault() {} }, url);
      } else if (/^https?:\/\//i.test(String(url || ''))) {
        authWindow.loadURL(url);
      }
      return { action: 'deny' };
    });
    authWindow.on('closed', () => { authWindow = null; });
    authWindow.loadURL(target);
  }
  return true;
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'osu! Daily Tracker 4.0.3 · Replay Lab',
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOAuthUrl) mainWindow.webContents.send('oauth:callback', pendingOAuthUrl);
  });

  mainWindow.loadFile(path.join(__dirname, 'www', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient(PROTOCOL);
  handleCommandLine(process.argv);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', (_event, commandLine) => {
  handleCommandLine(commandLine);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverOAuthUrl(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
