import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import BrowserManager from '../core/browser.js';
import QuestBot from '../bot/quest-bot.js';
import RaidBot from '../bot/raid-bot.js';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let tray = null;
let botInstance = null;
let browserManager = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Open DevTools in development
    // mainWindow.webContents.openDevTools();

    // Create system tray
    createTray();
}

function createTray() {
    // Use simple emoji/text as icon for now (can replace with actual icon file later)
    const iconPath = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3Njape.org5vuPBoAAAEMSURBVDiNpdIxSwNBEAbgL2dIYWFhYaGFhYWFhf+gf8DCwsJCCwsLCwstLCwsLCwsLLSwsLBQsLCw0MLCwsJCCwsLC/+AhYWFhYWGhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFT7C8d3u7m5nJ7mbv9nY3M5Pd3d3MzOz+wP/AzOwPfI4/8Dn+wOf4A5/jD3yOP/A5/sDn+AOf4w98jj/wOf7A5/gDn+MPfI4/8Dn+wOf4A5/jD3yOP/A5/sDn+AOf4w98jj/wOf7A5/gDn+MPfI4/8Dn+wOf4A5/jD3yOP/A5/sDn+AOf4w98jj/wOf7A5/gDn+MPfI4/8Dn+wOf4A5/jD3yOP/A5/sDn+AOf4w/8H/gAOqY4TZiV8XYAAAAASUVORK5CYII='
    );

    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show/Hide',
            click: () => {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.quit();
            }
        }
    ]);

    tray.setToolTip('Ganenblue Bot');
    tray.setContextMenu(contextMenu);

    // Double-click to show window
    tray.on('click', () => {
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function showNotification(title, body, playSound = false) {
    const notification = new Notification({
        title,
        body,
        silent: !playSound
    });

    notification.show();

    if (playSound && mainWindow) {
        mainWindow.webContents.send('play-sound', 'notification');
    }
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', async () => {
    if (process.platform !== 'darwin') {
        if (botInstance) botInstance.stop();
        if (browserManager) await browserManager.close();
        app.quit();
    }
});

// --- IPC Handlers ---
ipcMain.handle('browser:launch', async (event, browserType = 'chromium') => {
    // Prevent multiple browser instances
    if (browserManager) {
        logger.info('Browser already open, reusing...');
        return { success: true, message: 'Browser already open' };
    }

    try {
        logger.info(`Launching ${browserType} browser for manual login...`);

        // Override browser type in config
        const browserConfig = {
            ...config.get('browser'),
            browser_type: browserType
        };

        browserManager = new BrowserManager(browserConfig);
        const page = await browserManager.launch();

        // Navigate to GBF and perform auto-login
        await browserManager.navigateAndLogin('http://game.granbluefantasy.jp/');

        return { success: true };
    } catch (error) {
        logger.error('Failed to launch browser:', error);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('bot:start', async (event, settings) => {
    if (botInstance && botInstance.isRunning) {
        return { success: false, message: 'Bot is already running' };
    }

    if (!browserManager || !browserManager.page) {
        return { success: false, message: 'Browser not initialized. Click "Open Browser" first.' };
    }

    try {
        logger.info(`Starting automation in ${settings.botMode} mode...`);

        const botMode = settings.botMode || 'quest';

        if (botMode === 'quest') {
            // Quest Mode
            if (settings.questUrl) config.set('bot.quest_url', settings.questUrl);
            if (settings.battleMode) config.set('bot.battle_mode', settings.battleMode);
            if (settings.maxRuns) config.set('bot.max_quests', parseInt(settings.maxRuns));

            botInstance = new QuestBot(browserManager.page, {
                questUrl: config.get('bot.quest_url'),
                maxQuests: config.get('bot.max_quests'),
                battleMode: config.get('bot.battle_mode')
            });
        } else if (botMode === 'raid') {
            // Raid Mode
            if (settings.battleMode) config.set('bot.battle_mode', settings.battleMode);
            if (settings.maxRuns) config.set('bot.max_raids', parseInt(settings.maxRuns));

            botInstance = new RaidBot(browserManager.page, {
                maxRaids: config.get('bot.max_raids'),
                battleMode: config.get('bot.battle_mode')
            });
        } else {
            return { success: false, message: `Unknown bot mode: ${botMode}` };
        }

        // Start bot loop (non-blocking)
        botInstance.start().then(() => {
            const stats = botInstance.getStats();
            const completed = stats.questsCompleted || stats.raidsCompleted || 0;
            const type = settings.mode === 'quest' ? 'quests' : 'raids';

            logger.info(`Bot completed: ${completed} ${type}`);
            mainWindow.webContents.send('bot:status', 'Stopped');

            // Show completion notification
            showNotification(
                'Farming Complete! 🎉',
                `Completed ${completed} ${type}`,
                true
            );
        }).catch(err => {
            logger.error('Bot execution error:', err);
            mainWindow.webContents.send('bot:status', 'Error');

            // Show error notification
            showNotification(
                'Bot Error',
                'An error occurred during farming',
                true
            );
        });

        return { success: true };
    } catch (error) {
        logger.error('Failed to start bot:', error);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('bot:stop', async () => {
    if (botInstance) {
        botInstance.stop();
        botInstance = null;
    }
    // Do NOT close browserManager here
    logger.info('Bot stopped from GUI (Browser kept open)');
    return { success: true };
});

ipcMain.handle('bot:get-status', () => {
    if (!botInstance) return { status: 'Stopped' };
    const stats = botInstance.getStats();
    return {
        status: stats.isRunning ? (stats.isPaused ? 'Paused' : 'Running') : 'Stopped',
        stats
    };
});

ipcMain.handle('bot:reset-stats', () => {
    if (botInstance && botInstance.battleTimes) {
        botInstance.battleTimes = [];
        botInstance.questsCompleted = 0;
        botInstance.raidsCompleted = 0;
        logger.info('Stats reset from GUI');
        return { success: true };
    }
    return { success: false, message: 'No bot instance running' };
});

ipcMain.handle('credentials:save', async (event, credentials) => {
    try {
        const credPath = path.join(__dirname, '../../config/credentials.yaml');

        const credData = {
            mobage: {
                email: credentials.email || '',
                password: credentials.password || ''
            }
        };

        writeFileSync(credPath, yaml.dump(credData), 'utf8');
        logger.info('Credentials saved successfully');
        return { success: true };
    } catch (error) {
        logger.error('Failed to save credentials:', error.message);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('credentials:load', async () => {
    try {
        const credPath = path.join(__dirname, '../../config/credentials.yaml');

        if (!existsSync(credPath)) {
            return { success: true, credentials: null };
        }

        const fileContents = readFileSync(credPath, 'utf8');
        const data = yaml.load(fileContents);

        return {
            success: true,
            credentials: data && data.mobage ? data.mobage : null
        };
    } catch (error) {
        logger.error('Failed to load credentials:', error.message);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('app:restart', async () => {
    logger.info('Restarting application...');
    app.relaunch();
    app.exit(0);
});

// Setup log streaming to renderer
// We need to extend our logger to send events to mainWindow
import winston from 'winston';

class GuiTransport extends winston.Transport {
    log(info, callback) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('log:update', info);
        }
        callback();
    }
}

logger.add(new GuiTransport());
