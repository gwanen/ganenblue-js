const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    launchBrowser: () => ipcRenderer.invoke('browser:launch'),
    startBot: (settings) => ipcRenderer.invoke('bot:start', settings),
    stopBot: () => ipcRenderer.invoke('bot:stop'),
    getStatus: () => ipcRenderer.invoke('bot:get-status'),
    onLogUpdate: (callback) => ipcRenderer.on('log:update', (_event, value) => callback(value)),
    onStatusUpdate: (callback) => ipcRenderer.on('bot:status', (_event, value) => callback(value)),
});
