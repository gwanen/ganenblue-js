import PageController from '../core/page-controller.js';
import BattleHandler from './battle-handler.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';

class QuestBot {
    constructor(page, options = {}) {
        this.controller = new PageController(page);
        this.battle = new BattleHandler(page);
        this.questUrl = options.questUrl;
        this.maxQuests = options.maxQuests || 0; // 0 = unlimited
        this.battleMode = options.battleMode || 'full_auto';
        this.selectors = config.selectors.quest;

        this.questsCompleted = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.battleTimes = []; // Array to store battle durations
    }

    async start() {
        this.isRunning = true;
        this.questsCompleted = 0;
        this.battleTimes = []; // Reset battle times on start

        // Set viewport to optimal resolution for farming
        await this.controller.page.setViewport({ width: 1000, height: 1799 });
        logger.info('Set viewport to 1000x1799');

        logger.info('Quest Bot started');
        logger.info(`Target: ${this.maxQuests === 0 ? 'Unlimited' : this.maxQuests} quests`);

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(1000);
                    continue;
                }

                // Check quest limit
                if (this.maxQuests > 0 && this.questsCompleted >= this.maxQuests) {
                    logger.info(`Quest limit reached: ${this.questsCompleted}/${this.maxQuests}`);
                    break;
                }

                await this.runSingleQuest();
                this.questsCompleted++;

                logger.info(`Quests completed: ${this.questsCompleted}${this.maxQuests > 0 ? '/' + this.maxQuests : ''}`);

                // Random delay between quests
                // EST: Reduced delay for speed (1-2s)
                await sleep(randomDelay(1000, 2000));
            }
        } catch (error) {
            logger.error('Quest bot error:', error);
            throw error;
        } finally {
            this.isRunning = false;
            logger.info('Quest Bot stopped');
        }
    }

    async runSingleQuest() {
        logger.info(`Starting quest ${this.questsCompleted + 1}...`);

        // Navigate to quest
        await this.controller.goto(this.questUrl);
        // EST: Reduced delay for speed (0.8-1.5s)
        await sleep(randomDelay(800, 1500));

        // Check for existing battle state (Redirected or Resume)
        const currentUrl = this.controller.page.url();
        const isRaidUrl = currentUrl.includes('#raid') || currentUrl.includes('_raid');
        const isBattle = isRaidUrl || await this.controller.elementExists('.btn-auto', 2000);

        if (isBattle) {
            logger.info('Detected battle state after navigation. Resuming...');

            // Check if bot was stopped before starting battle
            if (!this.isRunning) {
                logger.info('Bot stopped before battle execution');
                return;
            }

            await this.battle.executeBattle(this.battleMode);

            // User Optimization: Skip clicking OK button. Just return to loop (which navigates to Quest URL)
            // await this.battle.handleResult(); 

            return; // Skip the rest of runSingleQuest (summon selection etc)
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

        // Store battle time
        if (this.battle.lastBattleDuration > 0) {
            this.battleTimes.push(this.battle.lastBattleDuration);
        }

        // User Optimization: Skip clicking OK button.
        // await this.battle.handleResult();

        logger.info('Quest completed successfully');
    }

    async selectSummon() {
        logger.info('Selecting summon...');

        // Wait for summon screen (retry a few times)
        let retryCount = 0;
        while (retryCount < 3) {
            if (await this.controller.elementExists('.prt-supporter-list', 5000)) {
                break;
            }
            logger.warn('Summon screen not found, retrying...');
            retryCount++;
            await sleep(1000);
        }

        // Check for 'btn-usual-ok' (Confirmation popup that might block view)
        if (await this.controller.elementExists('.btn-usual-ok')) {
            logger.info('Found confirmation popup, clicking OK...');
            await this.controller.clickSafe('.btn-usual-ok');
            await sleep(1500); // Reduced from 3000ms for snappier response

            // Check if we moved to battle
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                logger.info('Moved to battle screen, skipping summon selection.');
                return;
            }
        }

        // Try to select ANY available summon in the list
        // Priority: 1. Misc Tab (usually safer) -> 2. First available
        // Note: exact selectors depend on user config, but we'll try a generic approach first

        // Try to click the first available summon button/panel
        const summonSelector = '.prt-supporter-detail';
        if (await this.controller.elementExists(summonSelector)) {
            logger.info('Found summon, clicking...');
            await this.controller.clickSafe(summonSelector);
            // EST: Reduced delay for speed (0.3-0.8s)
            await sleep(randomDelay(300, 800));

            // Check for another confirmation popup after clicking summon (Start Quest)
            if (await this.controller.elementExists('.btn-usual-ok')) {
                logger.info('Found start confirmation popup, clicking OK...');
                await this.controller.clickSafe('.btn-usual-ok');
            }

            return;
        }

        // Fallback to configured selectors if generic failed
        const summonSelectors = [
            this.selectors.summonSlot1,
            this.selectors.summonSlot2,
            this.selectors.summonSlot3
        ];

        for (const selector of summonSelectors) {
            if (await this.controller.elementExists(selector, 1000)) {
                await this.controller.clickSafe(selector);
                logger.info('Summon selected (fallback)');
                await sleep(randomDelay(500, 1000));

                // Check confirmation again
                if (await this.controller.elementExists('.btn-usual-ok')) {
                    await this.controller.clickSafe('.btn-usual-ok');
                }
                return;
            }
        }

        throw new Error('No summons available');
    }

    pause() {
        this.isPaused = true;
        logger.info('Bot paused');
    }

    resume() {
        this.isPaused = false;
        logger.info('Bot resumed');
    }

    stop() {
        this.isRunning = false;
        if (this.battle) {
            this.battle.stop();
        }
        logger.info('Bot stop requested');
    }

    getStats() {
        const avgTime = this.battleTimes.length > 0
            ? this.battleTimes.reduce((a, b) => a + b, 0) / this.battleTimes.length
            : 0;

        return {
            questsCompleted: this.questsCompleted,
            maxQuests: this.maxQuests,
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            battleTimes: this.battleTimes,
            averageBattleTime: avgTime
        };
    }
}

export default QuestBot;
