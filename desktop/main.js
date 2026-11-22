const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const logPath = path.join(app.getPath('userData'), 'osu-daily-tracker-log.jsonl');

function appendLogLine(line) {
  try {
    fs.appendFileSync(logPath, String(line || '').endsWith('\n') ? String(line) : String(line) + '\n', 'utf8');
  } catch (error) {
    console.error('Desktop log write failed:', error);
  }
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

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'osu! Daily Tracker · Replay Lab',
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  window.loadFile(path.join(__dirname, 'www', 'index.html'));

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
