import { app, BrowserWindow, ipcMain, Notification } from 'electron';
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


// Store instances per profile: 'p1', 'p2'
// Structure: { [profileId]: { browser: BrowserManager, bot: Bot, stats: Object } }
const instances = new Map();

function getInstance(profileId) {
    if (!instances.has(profileId)) {
        instances.set(profileId, {
            browser: null,
            bot: null,
            stats: {
                startTime: null,
                completedQuests: 0,
                raidsCompleted: 0,
                battleCount: 0,
                lastRate: '0.0/h'
            }
        });
    }
    return instances.get(profileId);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 450,
        height: 700,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        // skipTaskbar: true, // Removed to show in taskbar
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Open DevTools in development
    // mainWindow.webContents.openDevTools();
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

// --- Stats Updater Loop ---
let statsInterval = null;

function startStatsUpdater() {
    if (statsInterval) return;
    statsInterval = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        for (const [profileId, instance] of instances) {
            if (instance.bot && instance.bot.isRunning) {
                const stats = instance.bot.getStats();

                // Calculate duration and rate
                let duration = '00:00:00';
                let rate = '0.0/h';

                if (instance.stats.startTime) {
                    const diff = Date.now() - instance.stats.startTime;
                    const hours = Math.floor(diff / 3600000).toString().padStart(2, '0');
                    const minutes = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
                    const seconds = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
                    duration = `${hours}:${minutes}:${seconds}`;

                    // Display Actual Rate (Locked-in from last battle completion)
                    rate = instance.stats.lastRate || '0.0/h';
                }

                mainWindow.webContents.send('bot:status', {
                    profileId,
                    status: instance.bot.isPaused ? 'Paused' : 'Running',
                    stats: {
                        ...stats,
                        duration,
                        rate
                    }
                });
            }
        }
    }, 1000);
}

function stopStatsUpdater() {
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
}

// Helpers for IPC handlers
const createStatsCallback = (profileId, instance) => (stats) => {
    let duration = '00:00:00';
    let rate = '0.0/h';

    if (instance.stats.startTime) {
        const diff = Date.now() - instance.stats.startTime;
        const hours = Math.floor(diff / 3600000).toString().padStart(2, '0');
        const minutes = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
        const seconds = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
        duration = `${hours}:${minutes}:${seconds}`;

        // Calculate and Lock-in Rate (Actual)
        const completed = stats.battleCount || stats.completedQuests || stats.raidsCompleted || 0;
        if (diff > 5000) {
            const hoursFloat = diff / 3600000;
            instance.stats.lastRate = (completed / hoursFloat).toFixed(1) + '/h';
        } else {
            instance.stats.lastRate = '0.0/h';
        }
        rate = instance.stats.lastRate;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bot:status', {
            profileId,
            status: 'Running',
            stats: { ...stats, duration, rate }
        });
    }
};

app.on('before-quit', stopStatsUpdater);

app.on('window-all-closed', async () => {
    if (process.platform !== 'darwin') {
        // Close all instances
        for (const [id, instance] of instances) {
            if (instance.bot) {
                try { instance.bot.stop(); } catch (e) { console.error(`Failed to stop bot ${id}`, e); }
            }
            if (instance.browser) {
                try { await instance.browser.close(); } catch (e) { console.error(`Failed to close browser ${id}`, e); }
            }
        }
        // Force close JSON window if open

        app.quit();
    }
});

// --- IPC Handlers ---
ipcMain.handle('browser:launch', async (event, profileId, browserType = 'chromium', deviceSettings = {}) => {
    const instance = getInstance(profileId);

    // Prevent multiple browser instances for the same profile
    if (instance.browser) {
        logger.info(`[Gui] [${profileId}] Browser already open, reusing...`);
        return { success: true, message: 'Browser already open' };
    }

    try {
        logger.info(`[Gui] [${profileId}] Launching ${browserType} browser...`);

        // Override browser type in config
        const browserConfig = {
            ...config.get('browser'),
            browser_type: browserType,
            disable_sandbox: !!deviceSettings.disable_sandbox,
            emulation: deviceSettings // Pass full settings object
        };

        // Create new browser manager for this profile
        instance.browser = new BrowserManager(browserConfig, profileId);
        await instance.browser.launch();

        // Navigate to GBF and perform auto-login
        await instance.browser.navigateAndLogin('http://game.granbluefantasy.jp/');

        return { success: true };
    } catch (error) {
        logger.error(`[Error] [${profileId}] Failed to launch browser:`, error);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('browser:close', async (event, profileId) => {
    const instance = getInstance(profileId);
    if (instance.browser) {
        try {
            logger.info(`[Gui] [${profileId}] Closing browser...`);
            await instance.browser.close();
            instance.browser = null;
            instance.bot = null; // Also clear bot instance if browser closes
            return { success: true };
        } catch (error) {
            logger.error(`[Error] [${profileId}] Failed to close browser:`, error);
            return { success: false, message: error.message };
        }
    }
    return { success: true }; // Already closed
});

ipcMain.handle('bot:start', async (event, profileId, settings) => {
    const instance = getInstance(profileId);

    if (instance.bot && instance.bot.isRunning) {
        return { success: false, message: 'Bot is already running' };
    }

    if (!instance.browser || !instance.browser.page) {
        return { success: false, message: 'Browser not initialized. Click "Open Browser" first.' };
    }

    try {
        logger.info(`[Bot] [${profileId}] Starting automation in ${settings.botMode} mode...`);
        logger.debug(`[Bot] [${profileId}] Settings: ${JSON.stringify(settings)}`);

        const botMode = settings.botMode || 'quest';

        if (botMode === 'quest') {
            // Quest Mode
            if (settings.questUrl) config.set('bot.quest_url', settings.questUrl);
            if (settings.battleMode) config.set('bot.battle_mode', settings.battleMode);
            if (settings.maxRuns) config.set('bot.max_quests', parseInt(settings.maxRuns));

            instance.bot = new QuestBot(instance.browser.page, {
                questUrl: config.get('bot.quest_url'),
                maxQuests: config.get('bot.max_quests'),
                battleMode: config.get('bot.battle_mode'),
                onBattleEnd: createStatsCallback(profileId, instance),
                blockResources: settings.blockResources,
                fastRefresh: settings.fastRefresh
            });
        } else if (botMode === 'replicard') {
            // Replicard Mode (QuestBot variant)
            if (settings.questUrl) config.set('bot.quest_url', settings.questUrl);
            if (settings.battleMode) config.set('bot.battle_mode', settings.battleMode);
            if (settings.maxRuns) config.set('bot.max_quests', parseInt(settings.maxRuns)); // Reuse max_quests config

            instance.bot = new QuestBot(instance.browser.page, {
                questUrl: config.get('bot.quest_url'),
                maxQuests: config.get('bot.max_quests'),
                battleMode: config.get('bot.battle_mode'),
                onBattleEnd: createStatsCallback(profileId, instance),
                blockResources: settings.blockResources,
                fastRefresh: settings.fastRefresh,
                isReplicard: true // Enable Replicard logic
            });
        } else if (botMode === 'raid') {
            // Raid Mode
            if (settings.battleMode) config.set('bot.battle_mode', settings.battleMode);
            if (settings.maxRuns) config.set('bot.max_raids', parseInt(settings.maxRuns));

            instance.bot = new RaidBot(instance.browser.page, {
                initialUrl: settings.questUrl || config.get('bot.quest_url'),
                maxRaids: parseInt(settings.maxRuns) || config.get('bot.max_quests'),
                honorTarget: parseInt(settings.honorTarget) || 0,
                onBattleEnd: createStatsCallback(profileId, instance),
                blockResources: settings.blockResources,
                fastRefresh: settings.fastRefresh
            });
        } else {
            return { success: false, message: `Unknown bot mode: ${botMode}` };
        }



        // Start bot loop (non-blocking)
        const currentBot = instance.bot;
        instance.stats.startTime = Date.now(); // Track start time
        startStatsUpdater(); // Ensure updater is running

        currentBot.start().then(() => {
            const stats = currentBot.getStats();
            const quests = stats.completedQuests || 0;
            const raids = stats.raidsCompleted || 0;

            logger.info(`[Bot] [${profileId}] Finished: Quest ${quests} | Raid ${raids}`);
            mainWindow.webContents.send('bot:status', { profileId, status: 'Stopped' });

            // Show completion notification
            showNotification(
                'Farming Complete! 🎉',
                `[${profileId}] Quest ${quests} | Raid ${raids}`,
                true
            );
        }).catch(err => {
            logger.error(`[Error] [Bot] [${profileId}] Execution error:`, err);
            mainWindow.webContents.send('bot:status', { profileId, status: 'Error' });

            // Show error notification
            showNotification(
                'Bot Error',
                `[${profileId}] An error occurred during farming`,
                true
            );
        });

        return { success: true };
    } catch (error) {
        logger.error(`[Error] [Bot] [${profileId}] Initiation failure:`, error);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('bot:stop', async (event, profileId) => {
    const instance = getInstance(profileId);
    if (instance.bot) {
        instance.bot.stop();
        instance.bot = null;
    }
    logger.info(`[Gui] [${profileId}] Bot stopped`);
    return { success: true };
});

ipcMain.handle('bot:get-status', (event, profileId) => {
    const instance = getInstance(profileId);
    if (!instance.bot) return { status: 'Stopped' };
    const stats = instance.bot.getStats();
    return {
        status: stats.isRunning ? (stats.isPaused ? 'Paused' : 'Running') : 'Stopped',
        stats
    };
});

ipcMain.handle('bot:reset-stats', (event, profileId) => {
    const instance = getInstance(profileId);
    if (instance.bot) {
        if (instance.bot.battleTimes) instance.bot.battleTimes = [];
        if (instance.bot.battleTurns) instance.bot.battleTurns = [];
        instance.bot.questsCompleted = 0;
        instance.bot.raidsCompleted = 0;
        if (typeof instance.bot.battleCount !== 'undefined') instance.bot.battleCount = 0;
        if (typeof instance.bot.totalTurns !== 'undefined') instance.bot.totalTurns = 0;
        instance.stats.startTime = null; // Reset timer
        instance.stats.lastRate = '0.0/h'; // Reset rate

        logger.info(`[Gui] [${profileId}] Statistics reset`);
        return { success: true };
    }
    return { success: false, message: 'No bot instance running' };
});

ipcMain.handle('app:resize-window', async (event, width, height) => {
    if (mainWindow) {
        mainWindow.setSize(width, height);
        return { success: true };
    }
    return { success: false };
});

ipcMain.handle('credentials:save', async (event, profileId, credentials) => {
    try {
        const credPath = path.join(__dirname, '../../config/credentials.yaml');
        let data = {};

        if (existsSync(credPath)) {
            try {
                data = yaml.load(readFileSync(credPath, 'utf8')) || {};
            } catch (e) { /* ignore */ }
        }

        if (!data.profiles) data.profiles = {};

        data.profiles[profileId] = {
            email: credentials.email || '',
            password: credentials.password || ''
        };

        writeFileSync(credPath, yaml.dump(data), 'utf8');
        logger.info(`[Gui] [${profileId}] Credentials updated`);
        return { success: true };
    } catch (error) {
        logger.error(`[Error] [Gui] [${profileId}] Credential update failure:`, error.message);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('credentials:load', async (event, profileId) => {
    try {
        const credPath = path.join(__dirname, '../../config/credentials.yaml');

        if (!existsSync(credPath)) {
            return { success: true, credentials: null };
        }

        const fileContents = readFileSync(credPath, 'utf8');
        const data = yaml.load(fileContents);

        if (data && data.profiles) {
            // Direct match
            if (data.profiles[profileId]) {
                return { success: true, credentials: data.profiles[profileId] };
            }
            // Legacy mapping: p1 -> profile1, p2 -> profile2
            const legacyMap = { 'p1': 'profile1', 'p2': 'profile2' };
            const legacyKey = legacyMap[profileId];
            if (legacyKey && data.profiles[legacyKey]) {
                return { success: true, credentials: data.profiles[legacyKey] };
            }
        }

        return { success: true, credentials: null };
    } catch (error) {
        logger.error(`[Error] [Gui] Failed to load credentials for ${profileId}:`, error.message);
        return { success: false, message: error.message };
    }
});

ipcMain.handle('app:restart', async () => {
    logger.info('[Gui] Restarting application...');
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

            // High-priority notification for Captcha/Safety issues
            if (info.level === 'error' && (info.message.includes('Captcha') || info.message.includes('[Safety]'))) {
                const isLogout = info.message.includes('Logged out') || info.message.includes('Session');
                showNotification(
                    isLogout ? '🚨 SESSION EXPIRED 🚨' : '⚠️ CAPTCHA DETECTED ⚠️',
                    isLogout ? 'The bot was logged out or the session expired. Please log in again.' : 'The bot has stopped for safety. Please solve the verification manually.',
                    true
                );
            }
        }
        callback();
    }
}

logger.add(new GuiTransport());
