import PageController from '../core/page-controller.js';
import { sleep, randomDelay } from '../utils/random.js';
import { createScopedLogger } from '../utils/logger.js';
import config from '../utils/config.js';
import notifier from '../utils/notifier.js';

/**
 * Automates the post-battle "Skip" sequence for Nightmare/Quest repetitions.
 * Orchestrates loot claiming, character rank-up dismissal, and retry loops.
 */
class SkipBot {
    /**
     * @param {import('puppeteer').Page} page - The current browser page.
     * @param {object} [options={}] - Bot configuration parameters.
     */
    constructor(page, options = {}) {
        this.profileId = options.profileId || config.get('profile_id') || 'p1';
        this.logger = createScopedLogger(this.profileId);
        this.controller = new PageController(page, this.logger);
        this.questUrl = options.questUrl || '';
        this.maxRuns = options.maxRuns || 0;
        this.onBattleEnd = options.onBattleEnd || null;

        this.runsCompleted = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.startTime = null;
        this.lastRunTime = 0;
        this.fastRefresh = options.fastRefresh || false;

        // --- Performance Optimizations ---
        const blockResources = options.blockResources !== undefined
            ? options.blockResources
            : config.get('stealth.block_resources', false);

        if (blockResources) {
            this.logger.info('[System] Image blocking enabled');
            this.controller.enableResourceBlocking().catch(e =>
                this.logger.warn('[System] Failed to enable image blocking', e)
            );
        }

        if (options.turboMode) {
            this.controller.enableTurboCSS().catch(e =>
                this.logger.warn('[System] Failed to enable turbo CSS', e)
            );
        }
    }

    /**
     * Starts the bot's main loop.
     */
    async start() {
        this.isRunning = true;
        this.runsCompleted = 0;
        this.startTime = Date.now();

        this.logger.info('[Bot] Skip Nightmare session started');

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(1000);
                    continue;
                }

                if (this.maxRuns > 0 && this.runsCompleted >= this.maxRuns) {
                    this.logger.info(`[Skip] Limit reached (${this.runsCompleted}/${this.maxRuns})`);
                    break;
                }

                let success = false;
                try {
                    success = await this.runSingleSkip();
                } catch (cycleError) {
                    if (this.controller.isNetworkError(cycleError)) {
                        this.logger.warn(`[Skip] Transient error during cycle. Retrying: ${cycleError.message}`);
                        await sleep(500);
                        continue;
                    }
                    throw cycleError;
                }

                if (success) {
                    this.runsCompleted++;
                    if (this.onBattleEnd) {
                        this.onBattleEnd(this.getStats());
                    }
                }

                await sleep(50);
            }
        } catch (error) {
            if (this.controller.isNetworkError(error) || error.message.includes('Target closed') || error.message.includes('Session closed')) {
                this.logger.info('[System] Session terminated (browser closed)');
            } else {
                this.logger.error('[Bot] Skip bot error:', error);
                notifier.notifyError(this.profileId || 'p1', error.message).catch(e => this.logger.debug('[Notifier] Failed to send error notification', e));
                throw error;
            }
        } finally {
            this.stop();
        }
    }

    /**
     * Executes a single skip cycle (Play Again -> Claim Loot -> Dismiss Popups).
     * @returns {Promise<boolean>} True if the skip cycle completed successfully.
     */
    async runSingleSkip() {
        this.logger.info(`[Skip] Initiating skip cycle (${this.runsCompleted + 1})`);
        const runStartTime = Date.now();

        // --- 1. Play Again ---
        const playAgainSelector = '.btn-retry.cnt-quest';
        this.logger.debug('[Skip] Waiting for Play Again button');
        if (await this.controller.elementExists(playAgainSelector, 30000)) {
            await sleep(randomDelay(200, 400));
            await this.controller.clickSafe(playAgainSelector);
        } else {
            this.logger.warn('[Skip] Play Again button not found. Assuming not on result page.');
            return false;
        }

        // --- 2. Claim Loot ---
        const claimLootSelector = '.btn-usual-next';
        this.logger.debug('[Skip] Waiting for Claim Loot button');
        if (await this.controller.elementExists(claimLootSelector, 10000)) {
            await sleep(randomDelay(200, 400));
            await this.controller.clickSafe(claimLootSelector);
        } else {
            this.logger.warn('[Skip] Claim Loot button not found.');
            return false;
        }

        // --- 3. OK (First popup) ---
        const firstOkSelector = '.prt-popup-footer .btn-usual-ok';
        this.logger.debug('[Skip] Waiting for first OK button');
        if (await this.controller.elementExists(firstOkSelector, 10000, true)) {
            await sleep(randomDelay(100, 300));
            await this.controller.clickSafe(firstOkSelector);
        } else {
            this.logger.warn('[Skip] First OK button not found.');
            return false;
        }

        // --- 3.5 Character Rank Up Animation ---
        const rankUpSelector = '.onm-anim-parts';
        this.logger.debug('[Skip] Checking for character rank up animation');
        let rankUpCount = 0;
        const maxRankUps = 6;

        while (rankUpCount < maxRankUps) {
            const checkTimeout = rankUpCount === 0 ? 2000 : 800;
            if (await this.controller.elementExists(rankUpSelector, checkTimeout, true)) {
                this.logger.info(`[Skip] Character rank up detected (#${rankUpCount + 1}). Dismissing...`);
                await sleep(randomDelay(500, 1000));
                await this.controller.clickSafe(rankUpSelector).catch(() => { });
                await sleep(randomDelay(300, 600));
                rankUpCount++;
            } else {
                break;
            }
        }

        // --- 4. OK (Event Items popup) ---
        const eventOkSelector = '.pop-usual.pop-event-item.pop-show .btn-usual-ok';
        this.logger.debug('[Skip] Waiting for event OK button');
        if (await this.controller.elementExists(eventOkSelector, 10000, true)) {
            await sleep(randomDelay(100, 300));
            await this.controller.clickSafe(eventOkSelector);
        } else {
            this.logger.warn('[Skip] Event OK button not found.');
            return false;
        }

        const duration = Date.now() - runStartTime;
        this.lastRunTime = duration;

        return true;
    }

    pause() {
        this.isPaused = true;
        this.logger.info('[Skip] Bot paused');
    }

    resume() {
        this.isPaused = false;
        this.logger.info('[Skip] Bot resumed');
    }

    stop() {
        this.isRunning = false;
        this.controller.stop().catch(() => { });
        this.logger.info('[System] Shutdown initiated');
    }

    /**
     * Compiles session statistics for reporting.
     * @returns {object} Summary of runs and rate.
     */
    getStats() {
        let rate = '0.0/h';
        const now = Date.now();
        const uptimeHours = (now - this.startTime) / (1000 * 60 * 60);
        if (uptimeHours > 0) {
            const rph = this.runsCompleted / uptimeHours;
            rate = `${rph.toFixed(1)}/h`;
        }

        return {
            completedQuests: this.runsCompleted,
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            startTime: this.startTime,
            avgBattleTime: this.lastRunTime,
            avgTurns: 0,
            battleCount: this.runsCompleted,
            lastBattleTime: this.lastRunTime,
            rate: rate
        };
    }
}

export default SkipBot;
