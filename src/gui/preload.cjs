const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    launchBrowser: () => ipcRenderer.invoke('browser:launch'),
    startBot: (settings) => ipcRenderer.invoke('bot:start', settings),
    stopBot: () => ipcRenderer.invoke('bot:stop'),
    getStatus: () => ipcRenderer.invoke('bot:get-status'),
    resetStats: () => ipcRenderer.invoke('bot:reset-stats'),
    restartApp: () => ipcRenderer.invoke('app:restart'),
    onLogUpdate: (callback) => ipcRenderer.on('log:update', (_event, value) => callback(value)),
    onStatusUpdate: (callback) => ipcRenderer.on('bot:status', (_event, value) => callback(value)),
});
