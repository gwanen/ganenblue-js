import BrowserManager from './src/core/browser.js';
import QuestBot from './src/bot/quest-bot.js';
import logger from './src/utils/logger.js';
import config from './src/utils/config.js';

async function testCoreLogic() {
    logger.info('Starting Core Logic Verification...');

    // Mock config for testing
    config.config.browser.headless = true;
    config.config.bot.quest_url = 'https://example.com/quest';

    const browserManager = new BrowserManager(config.config.browser);

    try {
        const page = await browserManager.launch();
        logger.info('Browser launched');

        const bot = new QuestBot(page, {
            questUrl: 'https://example.com',
            maxQuests: 1
        });

        logger.info('QuestBot instantiated');

        // specialized test for methods availability
        if (typeof bot.start === 'function' && typeof bot.runSingleQuest === 'function') {
            logger.info('QuestBot methods verified');
        } else {
            throw new Error('QuestBot methods missing');
        }

        if (bot.battle && typeof bot.battle.executeBattle === 'function') {
            logger.info('BattleHandler verified');
        } else {
            throw new Error('BattleHandler missing');
        }

        if (bot.controller && typeof bot.controller.clickSafe === 'function') {
            logger.info('PageController verified');
        } else {
            throw new Error('PageController missing');
        }

        logger.info('Core Logic Verification Successful (Structure Only)');

        await browserManager.close();
    } catch (error) {
        logger.error('Verification failed:', error);
        await browserManager.close();
    }
}

testCoreLogic();
