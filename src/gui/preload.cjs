const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    launchBrowser: (profileId, browserType, settings) => ipcRenderer.invoke('browser:launch', profileId, browserType, settings),
    closeBrowser: (profileId) => ipcRenderer.invoke('browser:close', profileId),
    startBot: (profileId, settings) => ipcRenderer.invoke('bot:start', profileId, settings),
    stopBot: (profileId) => ipcRenderer.invoke('bot:stop', profileId),
    getStatus: (profileId) => ipcRenderer.invoke('bot:get-status', profileId),
    resetStats: (profileId) => ipcRenderer.invoke('bot:reset-stats', profileId),
    restartApp: () => ipcRenderer.invoke('app:restart'),
    saveCredentials: (profileId, credentials) => ipcRenderer.invoke('credentials:save', profileId, credentials),
    onLogUpdate: (callback) => ipcRenderer.on('log:update', (_event, value) => callback(value)),

    onStatusUpdate: (callback) => ipcRenderer.on('bot:status', (_event, value) => callback(value)),
    onPlaySound: (callback) => ipcRenderer.on('play-sound', (_event, value) => callback(value)),
    resizeWindow: (width, height) => ipcRenderer.invoke('app:resize-window', width, height),
});
