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
            logger.info('Starting bot via CLI...');

            // Override config with CLI options
            if (options.url) config.set('bot.quest_url', options.url);
            if (options.max) config.set('bot.max_quests', parseInt(options.max));
            if (options.mode) config.set('bot.battle_mode', options.mode);
            if (options.headless) config.set('browser.headless', true);

            // Validate required config
            const questUrl = config.get('bot.quest_url');
            if (!questUrl) {
                logger.error('Error: Quest URL is required. Set it in config/default.yaml or pass --url option.');
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
                logger.info('Stopping bot...');
                bot.stop();
                await browserManager.close();
                process.exit(0);
            });

            // Start Bot
            await bot.start();

            await browserManager.close();
            logger.info('Bot finished successfully.');

        } catch (error) {
            logger.error('Fatal error:', error);
            process.exit(1);
        }
    });

program.command('config')
    .description('View current configuration')
    .action(() => {
        console.log(JSON.stringify(config.config, null, 2));
    });

program.parse();
