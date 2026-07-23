import PageController from '../core/page-controller.js';
import { sleep } from '../utils/random.js';
import { createScopedLogger } from '../utils/logger.js';
import config from '../utils/config.js';
import notifier from '../utils/notifier.js';

/**
 * Auto-advances story quests by polling for the scene-skip, skip, and
 * quest-continue buttons once per second and clicking whichever is present.
 *
 * Unlike QuestBot this does no battle automation or navigation — it simply
 * drives the skip/continue UI on whatever quest the user is already in.
 * Starts on `start()`, runs until `stop()`.
 */
class AutoQuestBot {
    /**
     * @param {import('puppeteer').Page} page - The current browser page.
     * @param {object} [options={}] - Bot configuration parameters.
     */
    constructor(page, options = {}) {
        this.profileId = options.profileId || config.get('profile_id') || 'p1';
        this.logger = createScopedLogger(this.profileId);
        this.controller = new PageController(page, this.logger);
        this.onBattleEnd = options.onBattleEnd || null;

        this.selectors = config.selectors.auto_quest;
        this.pollInterval = config.get('timeouts.auto_quest_poll', 1000);

        this.questsCompleted = 0; // quest-continue clicks (one per quest advanced)
        this.clickCount = 0;      // total buttons clicked
        this.isRunning = false;
        this.isPaused = false;
        this.startTime = null;
        this.lastClickTime = 0;

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
     * Starts the 1s polling loop. Resolves when the bot is stopped.
     */
    async start() {
        this.isRunning = true;
        this.questsCompleted = 0;
        this.clickCount = 0;
        this.startTime = Date.now();

        this.logger.info(`[Bot] Auto Quest session started (poll: ${this.pollInterval}ms)`);

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(this.pollInterval);
                    continue;
                }

                try {
                    await this.pollAndClick();
                } catch (cycleError) {
                    if (this.controller.isNetworkError(cycleError)) {
                        this.logger.warn(`[Auto Quest] Transient error during poll. Retrying: ${cycleError.message}`);
                    } else {
                        throw cycleError;
                    }
                }

                await sleep(this.pollInterval);
            }
        } catch (error) {
            if (this.controller.isNetworkError(error) || error.message.includes('Target closed') || error.message.includes('Session closed')) {
                this.logger.info('[System] Session terminated (browser closed)');
            } else {
                this.logger.error('[Bot] Auto Quest error:', error);
                notifier.notifyError(this.profileId || 'p1', error.message).catch(e => this.logger.debug('[Notifier] Failed to send error notification', e));
                throw error;
            }
        } finally {
            this.stop();
        }
    }

    /**
     * Checks the three buttons in priority order and clicks the first visible.
     * Priority: scene-skip (rendered in front of skip) > skip > quest-continue.
     * @returns {Promise<boolean>} True if a button was clicked this cycle.
     */
    async pollAndClick() {
        // Stability first: identify the page we are on, then only probe the
        // buttons that belong to that page. Avoids clicking the wrong control.
        const url = this.controller.page.url();

        // Quest scene page → skip the story scene.
        // Scene-skip is rendered in front of the skip button, so it wins.
        if (url.includes('#quest/scene/') || url.includes('/quest/scene/')) {
            return !!(await this.clickFirstVisible(['sceneSkip', 'skip']));
        }

        // Event page → confirm the "Continue story?" popup (modal, so it wins),
        // otherwise click "Play" (quest-continue) to start the next quest.
        if (url.includes('#event/') || url.includes('/event/')) {
            return !!(await this.clickFirstVisible(['questConfirmOk', 'questContinue']));
        }

        // Unrecognized page — do nothing this cycle.
        this.logger.debug('[Auto Quest] Not on a quest-scene or event page — skipping poll');
        return false;
    }

    /**
     * Probes the given selector keys in order and clicks the first visible one.
     * @param {string[]} keys - Ordered selector keys from this.selectors.
     * @returns {Promise<string|null>} The key that was clicked, or null.
     */
    async clickFirstVisible(keys) {
        // Single non-blocking DOM probe (no waitForSelector — it would block the poll).
        const selectorList = keys.map((k) => this.selectors[k]);
        const idx = await this.controller.page.evaluate((sels) => {
            const visible = (sel) => {
                const el = sel && document.querySelector(sel);
                return !!(el && el.offsetWidth > 0 && el.offsetHeight > 0);
            };
            for (let i = 0; i < sels.length; i++) {
                if (visible(sels[i])) return i;
            }
            return -1;
        }, selectorList).catch(() => -1);

        if (idx < 0) return null;

        const key = keys[idx];
        const labels = { sceneSkip: 'Scene skip', skip: 'Skip', questContinue: 'Play (continue)', questConfirmOk: 'Continue-story OK' };
        this.logger.info(`[Auto Quest] ${labels[key] || key} detected — clicking`);

        await this.controller.clickSafe(this.selectors[key], {
            timeout: 1000,
            preDelay: 0,
            fast: true,
            silent: true,
        }).catch((e) => this.logger.debug(`[Auto Quest] ${labels[key] || key} click failed: ${e.message}`));

        this.clickCount++;
        this.lastClickTime = Date.now();
        return key;
    }

    pause() {
        this.isPaused = true;
        this.logger.info('[Auto Quest] Bot paused');
    }

    resume() {
        this.isPaused = false;
        this.logger.info('[Auto Quest] Bot resumed');
    }

    stop() {
        this.isRunning = false;
        this.controller.stop().catch(() => { });
        this.logger.info('[System] Shutdown initiated');
    }

    /**
     * Compiles session statistics for reporting.
     * @returns {object} Summary of progress and rate.
     */
    getStats() {
        let rate = '0.0/h';
        const now = Date.now();
        const uptimeHours = (now - this.startTime) / (1000 * 60 * 60);
        if (this.startTime && uptimeHours > 0) {
            const rph = this.questsCompleted / uptimeHours;
            rate = `${rph.toFixed(1)}/h`;
        }

        return {
            completedQuests: this.questsCompleted,
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            startTime: this.startTime,
            avgBattleTime: 0,
            avgTurns: 0,
            battleCount: this.questsCompleted,
            lastBattleTime: this.lastClickTime,
            rate: rate,
        };
    }
}

export default AutoQuestBot;
