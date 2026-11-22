const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const PROTOCOL = 'osudailytracker';
const logPath = path.join(app.getPath('userData'), 'osu-daily-tracker-log.jsonl');
let mainWindow = null;
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
  appendLogLine(JSON.stringify({ time: new Date().toISOString(), event: 'oauth.deep_link_received', urlPrefix: url.slice(0, 120) }));
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('oauth:callback', url);
    mainWindow.webContents.send('oauth:status', 'Получен ответ от osu!, завершаю вход…');
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'osu! Daily Tracker 4.0.5 · Replay Lab',
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
