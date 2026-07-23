#!/usr/bin/env node
import { Command } from 'commander';
import BrowserManager from '../core/browser.js';
import QuestBot from '../bot/quest-bot.js';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

const program = new Command();

program
    .name('gbf-bot')
    .description('Granblue Fantasy Automation Bot')
    .version(packageJson.version);

program.command('start')
    .description('Start the bot in quest farming mode')
    .option('-u, --url <url>', 'Quest URL to farm')
    .option('-n, --max <number>', 'Maximum number of quests to run (0 for unlimited)', '0')
    .option('-m, --mode <mode>', 'Battle mode (full_auto or semi_auto)', 'full_auto')
    .option('--headless', 'Run in headless mode')
    .action(async (options) => {
        try {
            logger.info('[Cli] Starting bot...');

            // Override config with CLI options
            if (options.url) config.set('bot.quest_url', options.url);
            if (options.max) {
                const maxVal = parseInt(options.max, 10);
                if (isNaN(maxVal) || maxVal < 0) {
                    logger.error(`[Error] [Cli] Invalid --max value: '${options.max}'. Must be a non-negative integer.`);
                    process.exit(1);
                }
                config.set('bot.max_quests', maxVal);
            }
            if (options.mode) config.set('bot.battle_mode', options.mode);
            if (options.headless) config.set('browser.headless', true);

            // Validate required config
            const questUrl = config.get('bot.quest_url');
            if (!questUrl) {
                logger.error('[Error] [Cli] Quest URL is required. Set it in config/default.yaml or pass --url option.');
                process.exit(1);
            }

            // Initialize Browser
            const browserManager = new BrowserManager(config.get('browser'));
            const page = await browserManager.launch();

            // Initialize Bot
            const bot = new QuestBot(page, {
                questUrl: questUrl,
                maxQuests: config.get('bot.max_quests'),
                battleMode: config.get('bot.battle_mode')
            });

            // Handle graceful shutdown
            process.on('SIGINT', async () => {
                try {
                    logger.info('[Wait] Stopping bot...');
                    bot.stop();
                    await browserManager.close();
                } catch (error) {
                    logger.error('[Error] [Cli] Shutdown error:', error);
                } finally {
                    process.exit(0);
                }
            });

            // Start Bot
            await bot.start();

            await browserManager.close();
            logger.info('[Cli] Finished successfully.');

        } catch (error) {
            logger.error('[Error] [Cli] Fatal error:', error);
            process.exit(1);
        }
    });

program.command('raid')
    .description('Start the bot in raid backup mode')
    .option('-n, --max <number>', 'Maximum number of raids to run (0 for unlimited)', '0')
    .option('-m, --mode <mode>', 'Battle mode (full_auto or semi_auto)', 'full_auto')
    .option('--headless', 'Run in headless mode')
    .action(async (options) => {
        try {
            logger.info('[Cli] Starting raid bot...');

            // Override config with CLI options
            if (options.max) {
                const maxVal = parseInt(options.max, 10);
                if (isNaN(maxVal) || maxVal < 0) {
                    logger.error(`[Error] [Cli] Invalid --max value: '${options.max}'. Must be a non-negative integer.`);
                    process.exit(1);
                }
                config.set('bot.max_raids', maxVal);
            }
            if (options.mode) config.set('bot.battle_mode', options.mode);
            if (options.headless) config.set('browser.headless', true);

            // Initialize Browser
            const browserManager = new BrowserManager(config.get('browser'));
            const page = await browserManager.launch();

            // Import RaidBot dynamically
            const { default: RaidBot } = await import('../bot/raid-bot.js');

            // Initialize Bot
            const bot = new RaidBot(page, {
                maxRaids: config.get('bot.max_raids'),
                battleMode: config.get('bot.battle_mode')
            });

            // Handle graceful shutdown
            process.on('SIGINT', async () => {
                try {
                    logger.info('[Wait] Stopping bot...');
                    bot.stop();
                    await browserManager.close();
                } catch (error) {
                    logger.error('[Error] [Cli] Shutdown error:', error);
                } finally {
                    process.exit(0);
                }
            });

            // Start Bot
            await bot.start();

            await browserManager.close();
            logger.info('[Cli] Finished successfully.');

        } catch (error) {
            logger.error('[Error] [Cli] Fatal error:', error);
            process.exit(1);
        }
    });

program.command('skip')
    .description('Start the bot in skip nightmare mode')
    .option('-u, --url <url>', 'Specific URL of the skip result page to farm')
    .option('-n, --max <number>', 'Maximum number of skips to run (0 for unlimited)', '0')
    .option('--headless', 'Run in headless mode')
    .action(async (options) => {
        try {
            logger.info('[Cli] Starting skip bot...');

            // Override config with CLI options
            if (options.url) config.set('bot.quest_url', options.url);
            if (options.max) {
                const maxVal = parseInt(options.max, 10);
                if (isNaN(maxVal) || maxVal < 0) {
                    logger.error(`[Error] [Cli] Invalid --max value: '${options.max}'. Must be a non-negative integer.`);
                    process.exit(1);
                }
                config.set('bot.max_quests', maxVal);
            }
            if (options.headless) config.set('browser.headless', true);

            // Initialize Browser
            const browserManager = new BrowserManager(config.get('browser'));
            const page = await browserManager.launch();

            // Import dynamically
            const { default: SkipBot } = await import('../bot/skip-bot.js');

            // Initialize Bot
            const bot = new SkipBot(page, {
                questUrl: config.get('bot.quest_url'),
                maxRuns: config.get('bot.max_quests')
            });

            // Handle graceful shutdown
            process.on('SIGINT', async () => {
                try {
                    logger.info('[Wait] Stopping bot...');
                    bot.stop();
                    await browserManager.close();
                } catch (error) {
                    logger.error('[Error] [Cli] Shutdown error:', error);
                } finally {
                    process.exit(0);
                }
            });

            // Start Bot
            await bot.start();

            await browserManager.close();
            logger.info('[Cli] Finished successfully.');

        } catch (error) {
            logger.error('[Error] [Cli] Fatal error:', error);
            process.exit(1);
        }
    });

program.command('auto-quest')
    .description('Auto-advance story quests by clicking skip / scene-skip / continue (runs until Ctrl+C)')
    .option('--headless', 'Run in headless mode')
    .action(async (options) => {
        try {
            logger.info('[Cli] Starting auto quest bot...');

            if (options.headless) config.set('browser.headless', true);

            // Initialize Browser
            const browserManager = new BrowserManager(config.get('browser'));
            const page = await browserManager.launch();

            // Import dynamically
            const { default: AutoQuestBot } = await import('../bot/auto-quest-bot.js');

            // Initialize Bot
            const bot = new AutoQuestBot(page, {});

            // Handle graceful shutdown
            process.on('SIGINT', async () => {
                try {
                    logger.info('[Wait] Stopping bot...');
                    bot.stop();
                    await browserManager.close();
                } catch (error) {
                    logger.error('[Error] [Cli] Shutdown error:', error);
                } finally {
                    process.exit(0);
                }
            });

            // Start Bot
            await bot.start();

            await browserManager.close();
            logger.info('[Cli] Finished successfully.');

        } catch (error) {
            logger.error('[Error] [Cli] Fatal error:', error);
            process.exit(1);
        }
    });

program.command('config')
    .description('View current configuration')
    .action(() => {
        console.log(JSON.stringify(config.config, null, 2));
    });

program.command('test-stealth')
    .description('Test stealth detection against sannysoft.com')
    .action(async () => {
        try {
            await import('./test-stealth.js');
        } catch (error) {
            logger.error('[Error] [Cli] Stealth test failed:', error);
            process.exit(1);
        }
    });

program.parse();
