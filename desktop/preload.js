const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('DesktopBridge', {
  appendLog: line => ipcRenderer.invoke('desktop:logs-append', line),
  startLog: () => ipcRenderer.invoke('desktop:logs-start'),
  exportLog: options => ipcRenderer.invoke('desktop:logs-export', options),
  openExternal: url => ipcRenderer.invoke('desktop:open-external', url),
  getLaunchUrl: () => ipcRenderer.invoke('oauth:get-launch-url'),
  openAuth: url => ipcRenderer.invoke('oauth:open-auth', url),
  onOAuthCallback: callback => ipcRenderer.on('oauth:callback', (_event, url) => callback(url))
});
