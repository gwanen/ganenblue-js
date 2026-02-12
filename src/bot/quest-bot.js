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
        this.battleTurns = []; // Array to store turn counts
    }

    async start() {
        this.isRunning = true;
        this.questsCompleted = 0;
        this.battleTimes = []; // Reset battle times on start
        this.battleTurns = []; // Reset battle turns on start
        this.startTime = Date.now();

        // Set viewport to optimal resolution for farming
        await this.controller.page.setViewport({ width: 1000, height: 1799 });
        logger.info('[Core] Set viewport to 1000x1799');

        logger.info('[Bot] Bot started. Good luck!');
        logger.info(`[Bot] Target: ${this.maxQuests === 0 ? 'Unlimited' : this.maxQuests} quests`);

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(1000);
                    continue;
                }

                // Check quest limit
                if (this.maxQuests > 0 && this.questsCompleted >= this.maxQuests) {
                    logger.info(`[Bot] Quest limit reached: ${this.questsCompleted}/${this.maxQuests}`);
                    break;
                }

                await this.runSingleQuest();
                this.questsCompleted++;


                // Random delay between quests
                // EST: Reduced delay for speed (0.5-1s)
                await sleep(randomDelay(500, 1000));
            }
        } catch (error) {
            logger.error('[Error] [Bot] Quest bot error:', error);
            await this.controller.takeScreenshot('error_quest');
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
        const isResult = currentUrl.includes('#result');
        // Check for OK button but EXCLUDE the one from the deck/supporter selection popup
        const okButton = await this.controller.page.evaluate(() => {
            const btn = document.querySelector('.btn-usual-ok');
            if (!btn) return false;
            // If the button is inside a deck selection popup, it's not a "battle end" state
            const isDeckPopup = !!btn.closest('.pop-deck');
            const isVisible = btn.offsetWidth > 0 && btn.offsetHeight > 0;
            return isVisible && !isDeckPopup;
        });
        const isBattle = isRaidUrl || isResult || okButton || await this.controller.elementExists('.btn-auto', 200);

        if (isBattle) {
            logger.info('[Wait] Detected battle or result state after navigation. Resuming...');

            // Check if bot was stopped before starting battle
            if (!this.isRunning) {
                logger.info('[Bot] Stopped before battle execution');
                return;
            }

            const result = await this.battle.executeBattle(this.battleMode);
            this.updateDetailStats(result);

            // Store battle time and turns
            if (this.battle.lastBattleDuration > 0) {
                this.battleTimes.push(this.battle.lastBattleDuration);
                this.battleTurns.push(result.turns || 0);
            }

            // User Optimization: Skip clicking OK button. Just return to loop (which navigates to Quest URL)
            return; // Skip the rest of runSingleQuest (summon selection etc)
        }

        // Select summon
        await this.selectSummon();

        // Safety: Check for captcha after summon selection
        if (await this.checkCaptcha()) {
            return;
        }

        // Check if bot was stopped before starting battle
        if (!this.isRunning) {
            logger.info('[Bot] Stopped before battle execution');
            return;
        }

        // Handle battle
        const result = await this.battle.executeBattle(this.battleMode);
        this.updateDetailStats(result);

        // Store battle time and turns
        if (this.battle.lastBattleDuration > 0) {
            this.battleTimes.push(this.battle.lastBattleDuration);
            this.battleTurns.push(result.turns || 0);

            // Memory Optimization: keep only last 50 entries
            if (this.battleTimes.length > 50) this.battleTimes.shift();
            if (this.battleTurns.length > 50) this.battleTurns.shift();
        }

        // User Optimization: Skip clicking OK button.
        // await this.battle.handleResult();

        logger.info('[Cleared] Victory!');
    }

    async selectSummon() {
        logger.info('[Summon] Selecting supporter...');

        // Wait for summon screen (retry a few times)
        let retryCount = 0;
        while (retryCount < 3) {
            if (await this.controller.elementExists('.prt-supporter-list', 5000)) {
                break;
            }
            logger.warn('[Wait] [Summon] screen not found, retrying...');
            retryCount++;
            await sleep(1000);
        }

        // Check for 'btn-usual-ok' (Confirmation popup that might block view)
        // Use visible: true to avoid clicking phantom popups
        if (await this.controller.elementExists('.btn-usual-ok', 500, true)) {
            logger.info('[Bot] Found confirmation popup, clicking OK...');
            // Use fast timeout and no retries
            await this.controller.clickSafe('.btn-usual-ok', { timeout: 2000, maxRetries: 1 });
            await sleep(1000);

            // Double check if we moved to battle
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                logger.info('[Bot] Moved to battle screen, skipping summon selection.');
                return;
            }
        }

        // Try to select ANY available summon in the list
        // Priority: 1. Misc Tab (usually safer) -> 2. First available
        // Note: exact selectors depend on user config, but we'll try a generic approach first

        // Try to click the first available summon button/panel
        const summonSelector = '.prt-supporter-detail';
        if (await this.controller.elementExists(summonSelector, 2000, true)) {
            logger.info('[Summon] Selecting Supporter...');

            try {
                // Use visibility check and silent mode for Quest mode as requested
                // Reduced timeout to 1000ms as elementExists already confirmed it
                await this.controller.clickSafe(summonSelector, { timeout: 1000, maxRetries: 1, silent: true });
            } catch (error) {
                // Check if it's a "not found" error which is expected in race conditions
                if (error.message.includes('Element not found')) {
                    logger.warn('[Summon] Supporter detail disappeared, assuming battle start.');
                    return;
                }

                // If click fails for other reasons, check if we entered battle
                const currentUrl = this.controller.page.url();
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    logger.info('[Bot] Moved to battle screen (during click), ignoring error.');
                    return;
                }
                throw error;
            }

            // EST: Reduced delay for speed
            await sleep(randomDelay(200, 500));

            // Check for another confirmation popup after clicking summon (Start Quest)
            if (await this.controller.elementExists('.btn-usual-ok', 2000, true)) {
                logger.info('[Wait] Found start confirmation popup, clicking OK...');
                await this.controller.clickSafe('.btn-usual-ok', { timeout: 2000, maxRetries: 1 });
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
                logger.info('[Summon] Supporter selected (fallback)');
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
        logger.warn('[Wait] [Summon] No supporter selected, attempting to proceed...');
        return;
    }

    async checkCaptcha() {
        const selectors = config.selectors.battle;
        if (await this.controller.elementExists(selectors.captchaPopup, 1000, true)) {
            const headerText = await this.controller.getText(selectors.captchaHeader);
            if (headerText.includes('Access Verification')) {
                logger.error('[Safety] Captcha detected! Human intervention required.');
                this.stop();
                return true;
            }
        }
        return false;
    }

    pause() {
        this.isPaused = true;
        logger.info('[Bot] Bot paused');
    }

    resume() {
        this.isPaused = false;
        logger.info('[Bot] Bot resumed');
    }

    stop() {
        this.isRunning = false;
        if (this.battle) {
            this.battle.stop();
        }
        logger.info('[Bot] Bot stop requested');
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
            battleTurns: this.battleTurns,
            battleCount: this.battleCount || 0
        };
    }
}

export default QuestBot;
