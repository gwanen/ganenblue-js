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

        logger.info('[Bot] Bot started. Good luck!');
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


                // Random delay between quests
                // EST: Reduced delay for speed (0.5-1s)
                await sleep(randomDelay(500, 1000));
            }
        } catch (error) {
            logger.error('Quest bot error:', error);
            throw error;
        } finally {
            this.isRunning = false;
        }
    }

    async runSingleQuest() {
        logger.info(`[Quest] Quest started (${this.questsCompleted + 1})`);

        // Navigate to quest
        await this.controller.goto(this.questUrl);
        // EST: Reduced delay for speed (0.5-1s)
        await sleep(randomDelay(500, 1000));

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

            const result = await this.battle.executeBattle(this.battleMode);
            this.updateDetailStats(result);

            // Store battle time
            if (this.battle.lastBattleDuration > 0) {
                this.battleTimes.push(this.battle.lastBattleDuration);
            }

            // User Optimization: Skip clicking OK button. Just return to loop (which navigates to Quest URL)
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
        const result = await this.battle.executeBattle(this.battleMode);
        this.updateDetailStats(result);

        // Store battle time
        if (this.battle.lastBattleDuration > 0) {
            this.battleTimes.push(this.battle.lastBattleDuration);
        }

        // User Optimization: Skip clicking OK button.
        // await this.battle.handleResult();

        logger.info('[Cleared] Victory!');
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
            logger.info('[Bot] Found confirmation popup, clicking OK...');
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
            logger.info('[Summon] Selecting Supporter...');

            // Double check URL before interaction
            if (this.controller.page.url().includes('#raid') || this.controller.page.url().includes('_raid')) {
                logger.info('Moved to battle screen (pre-click check), skipping summon selection.');
                return;
            }

            try {
                await this.controller.clickSafe(summonSelector);
            } catch (error) {
                // If click fails, check if we entered battle (race condition)
                const currentUrl = this.controller.page.url();
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    logger.info('Moved to battle screen (during click), ignoring error.');
                    // Wait for battle to complete
                    const result = await this.battle.waitForBattleEnd();

                    // Track stats
                    this.updateDetailStats(result);

                    // Wait a bit before next action
                    await sleep(randomDelay(500, 1000));
                    return;
                }
                throw error;
            }

            // EST: Reduced delay for speed (0.2-0.5s)
            await sleep(randomDelay(200, 500));

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

        // Check if no summons found after trying fallbacks
        // Instead of throwing error, we'll log warning and try to proceed to battle check
        // This handles cases where summon selection was skipped or handled externally
        logger.warn('No summon selected (from known lists), attempting to proceed to battle...');
        return;
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

    updateDetailStats(result) {
        if (!result) return;

        // Initialize if not present
        if (!this.totalTurns) this.totalTurns = 0;
        if (!this.battleCount) this.battleCount = 0;

        // Update counts
        this.battleCount++;
        if (result.turns > 0) {
            this.totalTurns += result.turns;
        }
    }

    getAverageBattleTime() {
        if (this.battleTimes.length === 0) return 0;
        const sum = this.battleTimes.reduce((a, b) => a + b, 0);
        return Math.round(sum / this.battleTimes.length);
    }

    getStats() {
        // Calculate average turns
        let avgTurns = 0;
        if (this.battleCount > 0) {
            avgTurns = (this.totalTurns / this.battleCount).toFixed(1);
        }

        return {
            completedQuests: this.questsCompleted,
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            startTime: this.startTime,
            avgBattleTime: this.getAverageBattleTime(),
            avgTurns: avgTurns,
            battleTimes: this.battleTimes,
            battleCount: this.battleCount || 0
        };
    }
}

export default QuestBot;
