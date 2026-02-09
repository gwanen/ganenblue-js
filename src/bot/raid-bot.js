import PageController from '../core/page-controller.js';
import BattleHandler from './battle-handler.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';

class RaidBot {
    constructor(page, options = {}) {
        this.controller = new PageController(page);
        this.battle = new BattleHandler(page);
        this.raidBackupUrl = 'https://game.granbluefantasy.jp/#quest/assist';
        this.maxRaids = options.maxRaids || 0; // 0 = unlimited
        this.battleMode = options.battleMode || 'full_auto';
        this.selectors = config.selectors.raid;

        this.raidsCompleted = 0;
        this.isRunning = false;
        this.isPaused = false;
    }

    async start() {
        this.isRunning = true;
        this.raidsCompleted = 0;

        logger.info('Raid Bot started');
        logger.info(`Target: ${this.maxRaids === 0 ? 'Unlimited' : this.maxRaids} raids`);

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(1000);
                    continue;
                }

                // Check raid limit
                if (this.maxRaids > 0 && this.raidsCompleted >= this.maxRaids) {
                    logger.info(`Raid limit reached: ${this.raidsCompleted}/${this.maxRaids}`);
                    break;
                }

                await this.runSingleRaid();
                this.raidsCompleted++;

                logger.info(`Raids completed: ${this.raidsCompleted}${this.maxRaids > 0 ? '/' + this.maxRaids : ''}`);

                // Random delay between raids
                await sleep(randomDelay(1000, 2000));
            }
        } catch (error) {
            logger.error('Raid bot error:', error);
            throw error;
        } finally {
            this.isRunning = false;
            logger.info('Raid Bot stopped');
        }
    }

    async runSingleRaid() {
        logger.info(`Starting raid ${this.raidsCompleted + 1}...`);

        // Try to find and join a raid
        const joined = await this.findAndJoinRaid();

        if (!joined) {
            logger.warn('Failed to join raid, will retry');
            return;
        }

        // Select summon
        await this.selectSummon();

        // Check if bot was stopped before starting battle
        if (!this.isRunning) {
            logger.info('Bot stopped before battle execution');
            return;
        }

        // Handle battle
        await this.battle.executeBattle(this.battleMode);

        logger.info('Raid completed successfully');
    }

    async findAndJoinRaid() {
        // Navigate to raid backup page
        logger.info('Navigating to raid backup page...');
        await this.controller.goto(this.raidBackupUrl);
        await sleep(randomDelay(1000, 2000));

        let attempts = 0;
        const maxAttempts = 10; // Prevent infinite loops

        while (attempts < maxAttempts && this.isRunning) {
            attempts++;

            // Check for error popup first
            if (await this.handleErrorPopup()) {
                logger.info('Error popup detected, refreshing page...');
                await this.controller.page.reload();
                await sleep(randomDelay(1500, 2500));
                continue;
            }

            // Look for raid entries with class "btn-multi-raid lis-raid search"
            const raidSelector = '.btn-multi-raid.lis-raid.search';

            if (await this.controller.elementExists(raidSelector, 2000)) {
                logger.info('Found raid entry, clicking...');

                try {
                    await this.controller.clickSafe(raidSelector);
                    await sleep(randomDelay(1500, 2500));

                    // Check if we successfully joined (moved to summon screen or battle)
                    const currentUrl = this.controller.page.url();
                    const onSummonScreen = await this.controller.elementExists('.prt-supporter-list', 3000);
                    const inBattle = currentUrl.includes('#raid') || currentUrl.includes('_raid');

                    if (onSummonScreen || inBattle) {
                        logger.info('Successfully joined raid');
                        return true;
                    }

                    // Check for error popup after clicking
                    if (await this.handleErrorPopup()) {
                        logger.warn('Raid was full or unavailable, refreshing...');
                        await this.controller.page.reload();
                        await sleep(randomDelay(1500, 2500));
                        continue;
                    }

                    // Unknown state, refresh and retry
                    logger.warn('Unknown state after clicking raid, refreshing...');
                    await this.controller.page.reload();
                    await sleep(randomDelay(1500, 2500));

                } catch (error) {
                    logger.error('Error clicking raid entry:', error);
                    await this.controller.page.reload();
                    await sleep(randomDelay(1500, 2500));
                }

            } else {
                // No raids available, wait and refresh
                logger.info('No raids available, waiting 5 seconds...');
                await sleep(5000);

                logger.info('Refreshing page...');
                await this.controller.page.reload();
                await sleep(randomDelay(1500, 2500));
            }
        }

        logger.warn(`Failed to join raid after ${attempts} attempts`);
        return false;
    }

    async handleErrorPopup() {
        // Check for error popup with class "prt-popup-footer" containing "btn-usual-ok"
        const errorPopupSelector = '.prt-popup-footer .btn-usual-ok';

        if (await this.controller.elementExists(errorPopupSelector, 1000)) {
            logger.info('Error popup detected, clicking OK...');
            try {
                await this.controller.clickSafe(errorPopupSelector);
                await sleep(1000);
            } catch (error) {
                logger.warn('Failed to click error popup OK button:', error);
            }
            return true;
        }

        return false;
    }

    async selectSummon() {
        logger.info('Selecting summon...');

        // Wait for summon screen
        let retryCount = 0;
        while (retryCount < 3) {
            if (await this.controller.elementExists('.prt-supporter-list', 5000)) {
                break;
            }
            logger.warn('Summon screen not found, retrying...');
            retryCount++;
            await sleep(1000);
        }

        // Check for confirmation popup
        if (await this.controller.elementExists('.btn-usual-ok')) {
            logger.info('Found confirmation popup, clicking OK...');
            await this.controller.clickSafe('.btn-usual-ok');
            await sleep(1500);

            // Check if we moved to battle
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                logger.info('Moved to battle screen, skipping summon selection.');
                return;
            }
        }

        // Try to select first available summon
        const summonSelector = '.prt-supporter-detail';
        if (await this.controller.elementExists(summonSelector)) {
            logger.info('Found summon, clicking...');
            await this.controller.clickSafe(summonSelector);
            await sleep(randomDelay(300, 800));

            // Check for start confirmation popup
            if (await this.controller.elementExists('.btn-usual-ok')) {
                logger.info('Found start confirmation popup, clicking OK...');
                await this.controller.clickSafe('.btn-usual-ok');
            }

            return;
        }

        // Fallback to configured selectors
        const questSelectors = config.selectors.quest;
        const summonSelectors = [
            questSelectors.summonSlot1,
            questSelectors.summonSlot2,
            questSelectors.summonSlot3
        ];

        for (const selector of summonSelectors) {
            if (await this.controller.elementExists(selector, 1000)) {
                await this.controller.clickSafe(selector);
                logger.info('Summon selected (fallback)');
                await sleep(randomDelay(500, 1000));

                if (await this.controller.elementExists('.btn-usual-ok')) {
                    await this.controller.clickSafe('.btn-usual-ok');
                }
                return;
            }
        }

        logger.warn('No summons available, proceeding anyway');
    }

    pause() {
        this.isPaused = true;
        logger.info('Raid Bot paused');
    }

    resume() {
        this.isPaused = false;
        logger.info('Raid Bot resumed');
    }

    stop() {
        this.isRunning = false;
        if (this.battle) {
            this.battle.stop();
        }
        logger.info('Raid Bot stop requested');
    }

    getStats() {
        return {
            raidsCompleted: this.raidsCompleted,
            maxRaids: this.maxRaids,
            isRunning: this.isRunning,
            isPaused: this.isPaused
        };
    }
}

export default RaidBot;
