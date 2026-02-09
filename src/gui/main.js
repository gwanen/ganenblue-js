import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import BrowserManager from '../core/browser.js';
import QuestBot from '../bot/quest-bot.js';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
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

    // Open DevTools in dev mode
    mainWindow.webContents.openDevTools();
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

ipcMain.handle('browser:launch', async (event, settings) => {
    if (browserManager) {
        logger.info('Browser already open, reusing...');
        return { success: true, message: 'Browser already open' };
    }

    try {
        logger.info('Launching browser for manual login...');

        // Config overrides if needed (e.g. headless)
        // config.set('browser.headless', false); // Always visible for login

        browserManager = new BrowserManager(config.get('browser'));
        const page = await browserManager.launch();

        // Go to GBF handling page
        await page.goto('http://game.granbluefantasy.jp/', { waitUntil: 'domcontentloaded' });

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
        logger.info('Starting automation...');

        // Update config with GUI settings
        if (settings.questUrl) config.set('bot.quest_url', settings.questUrl);
        if (settings.battleMode) config.set('bot.battle_mode', settings.battleMode);
        if (settings.maxQuests) config.set('bot.max_quests', parseInt(settings.maxQuests));

        // Initialize Bot with EXISTING page
        botInstance = new QuestBot(browserManager.page, {
            questUrl: config.get('bot.quest_url'),
            maxQuests: config.get('bot.max_quests'),
            battleMode: config.get('bot.battle_mode')
        });

        // Start bot loop (non-blocking)
        botInstance.start().catch(err => {
            logger.error('Bot execution error:', err);
            mainWindow.webContents.send('bot:status', 'Error');
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
