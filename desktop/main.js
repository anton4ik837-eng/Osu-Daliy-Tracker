const { app, BrowserWindow, ipcMain, shell, dialog, Menu, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PROTOCOL = 'osudailytracker';
const OAUTH_API = 'https://osu-daily-tracker-oauth.anton4ik837.workers.dev';
const logPath = path.join(app.getPath('userData'), 'osu-daily-tracker-log.jsonl');
const secureStorePath = path.join(app.getPath('userData'), 'secure-store.json');

function readSecureStore() {
  try { return JSON.parse(fs.readFileSync(secureStorePath, 'utf8')); }
  catch { return {}; }
}
function decodeSecureValue(value) {
  const buffer = Buffer.from(value, 'base64');
  const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buffer) : buffer.toString('utf8');
  return JSON.parse(json);
}
let mainWindow = null;
let pendingOAuthUrl = null;
let handledHandoff = null;

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

function sendAuthStatus(text) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('oauth:status', text);
}

async function completeOAuth(handoff) {
  if (!handoff || handoff === handledHandoff) return;
  handledHandoff = handoff;
  sendAuthStatus('Ответ от osu! получен. Обмениваю код на токен…');
  appendLogLine(JSON.stringify({ time: new Date().toISOString(), event: 'oauth.exchange_started', handoffPrefix: handoff.slice(0, 8) }));
  try {
    const response = await fetch(OAUTH_API + '/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ handoff })
    });
    const tokens = await response.json();
    if (!response.ok || !tokens.access_token) throw new Error(tokens.error || 'Не удалось обменять временный код.');
    const session = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + Number(tokens.expires_in || 0) * 1000,
      canHost: !!tokens.canHost
    };
    appendLogLine(JSON.stringify({ time: new Date().toISOString(), event: 'oauth.exchange_success' }));
    sendAuthStatus('Токен получен. Загружаю профиль…');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('oauth:success', session);
  } catch (error) {
    appendLogLine(JSON.stringify({ time: new Date().toISOString(), event: 'oauth.exchange_failed', message: String(error?.message || error) }));
    sendAuthStatus('Не удалось завершить вход: ' + String(error?.message || error));
  }
}

function deliverOAuthUrl(url) {
  if (!url || typeof url !== 'string' || !url.includes(PROTOCOL + '://')) return;
  const index = url.indexOf(PROTOCOL + '://');
  const clean = url.slice(index);
  pendingOAuthUrl = clean;
  appendLogLine(JSON.stringify({ time: new Date().toISOString(), event: 'oauth.deep_link_received', urlPrefix: clean.slice(0, 120) }));
  let handoff = null;
  try {
    const parsed = new URL(clean);
    handoff = parsed.searchParams.get('handoff');
    const error = parsed.searchParams.get('error');
    if (error) sendAuthStatus('osu! не завершил авторизацию: ' + error);
  } catch (error) { /* ignored */ }
  if (handoff) completeOAuth(handoff).catch(error => sendAuthStatus('Ошибка входа: ' + String(error?.message || error)));
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

ipcMain.handle('update:download', async (_event, url, name) => {
  const value = String(url || '');
  const fileName = path.basename(String(name || 'update.bin'));
  if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//i.test(value)) {
    throw new Error('Разрешена загрузка только с GitHub Releases.');
  }
  if (!/\.(exe|AppImage|deb)$/i.test(fileName)) throw new Error('Неподдерживаемый тип файла обновления.');
  const downloads = app.getPath('downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const target = path.join(downloads, 'osu-daily-tracker-' + Date.now() + '-' + fileName);
  const response = await fetch(value, { headers: { Accept: 'application/octet-stream' } });
  if (!response.ok || !response.body) throw new Error('Не удалось скачать обновление (HTTP ' + response.status + ').');
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target));
  appendLogLine(JSON.stringify({ time: new Date().toISOString(), event: 'update.downloaded', file: path.basename(target) }));
  await shell.openPath(target);
  return target;
});

ipcMain.handle('secure:get', (_event, key) => {
  try { const value = readSecureStore()[String(key)]; return value ? decodeSecureValue(value) : null; }
  catch { return null; }
});
ipcMain.handle('secure:set', (_event, key, value) => {
  try {
    const data = readSecureStore();
    const json = JSON.stringify(value);
    data[String(key)] = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json).toString('base64')
      : Buffer.from(json).toString('utf8');
    fs.writeFileSync(secureStorePath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch { return false; }
});
ipcMain.handle('secure:clear', (_event, key) => {
  try { const data = readSecureStore(); delete data[String(key)]; fs.writeFileSync(secureStorePath, JSON.stringify(data), 'utf8'); }
  catch {}
  return true;
});

ipcMain.handle('oauth:get-launch-url', () => pendingOAuthUrl);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'osu! Daily Tracker 4.17.14 · Replay Lab',
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
