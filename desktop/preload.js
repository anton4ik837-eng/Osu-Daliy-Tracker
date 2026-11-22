const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('DesktopBridge', {
  appendLog: line => ipcRenderer.invoke('desktop:logs-append', line),
  startLog: () => ipcRenderer.invoke('desktop:logs-start'),
  exportLog: options => ipcRenderer.invoke('desktop:logs-export', options),
  openExternal: url => ipcRenderer.invoke('desktop:open-external', url)
});
