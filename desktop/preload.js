const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('DesktopBridge', {
  appendLog: line => ipcRenderer.invoke('desktop:logs-append', line),
  startLog: () => ipcRenderer.invoke('desktop:logs-start'),
  exportLog: options => ipcRenderer.invoke('desktop:logs-export', options),
  openExternal: url => ipcRenderer.invoke('desktop:open-external', url),
  downloadUpdate: (url, name) => ipcRenderer.invoke('update:download', url, name),
  secureGet: key => ipcRenderer.invoke('secure:get', key),
  secureSet: (key, value) => ipcRenderer.invoke('secure:set', key, value),
  secureClear: key => ipcRenderer.invoke('secure:clear', key),
  getLaunchUrl: () => ipcRenderer.invoke('oauth:get-launch-url'),
  onOAuthCallback: callback => ipcRenderer.on('oauth:callback', (_event, url) => callback(url)),
  onOAuthStatus: callback => ipcRenderer.on('oauth:status', (_event, text) => callback(text)),
  onOAuthSuccess: callback => ipcRenderer.on('oauth:success', (_event, session) => callback(session))
});
