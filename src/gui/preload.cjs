const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    launchBrowser: (browserType) => ipcRenderer.invoke('browser:launch', browserType),
    startBot: (settings) => ipcRenderer.invoke('bot:start', settings),
    stopBot: () => ipcRenderer.invoke('bot:stop'),
    getStatus: () => ipcRenderer.invoke('bot:get-status'),
    resetStats: () => ipcRenderer.invoke('bot:reset-stats'),
    restartApp: () => ipcRenderer.invoke('app:restart'),
    saveCredentials: (credentials) => ipcRenderer.invoke('credentials:save', credentials),
    loadCredentials: () => ipcRenderer.invoke('credentials:load'),
    onLogUpdate: (callback) => ipcRenderer.on('log:update', (_event, value) => callback(value)),
    onStatusUpdate: (callback) => ipcRenderer.on('bot:status', (_event, value) => callback(value)),
    onPlaySound: (callback) => ipcRenderer.on('play-sound', (_event, value) => callback(value)),
});
