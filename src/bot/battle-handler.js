import PageController from '../core/page-controller.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';

class BattleHandler {
    constructor(page) {
        this.controller = new PageController(page);
        this.selectors = config.selectors.battle;
        this.stopped = false;
        this.battleStartTime = null;
        this.lastBattleDuration = 0;
    }

    formatTime(milliseconds) {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    stop() {
        this.stopped = true;
    }

    /**
     * Handle full battle flow
     */
    async executeBattle(mode = 'full_auto') {
        // Start timing
        this.battleStartTime = Date.now();
        logger.info(`Starting battle in ${mode} mode`);

        try {
            // Wait for battle screen to load (look for Auto button)
            const battleLoaded = await this.controller.waitForElement('.btn-auto', 20000);

            if (!battleLoaded) {
                const currentUrl = this.controller.page.url();
                // Check if we are actually in battle but maybe button is different or obscured
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    logger.warn('On battle page but Auto button not found. Attempting to proceed...');
                } else if (!currentUrl.includes('#result')) {
                    throw new Error(`Battle failed to load. URL: ${currentUrl}`);
                }
            }

            // EST: Reduced delay for speed
            await sleep(randomDelay(500, 1000));

            if (mode === 'full_auto') {
                await this.handleFullAuto();
            } else if (mode === 'semi_auto') {
                await this.handleSemiAuto();
            }

            // Wait for battle to complete - return result for stats
            const result = await this.waitForBattleEnd(mode);

            // Calculate battle duration
            this.lastBattleDuration = Date.now() - this.battleStartTime;
            const formattedTime = this.formatTime(this.lastBattleDuration);
            logger.info(`Battle completed in ${formattedTime}`);

            return result;
        } catch (error) {
            logger.error('Battle execution failed:', error);
            // Return empty result to avoid breaking stats update loop
            return { duration: 0, turns: 0 };
        }
    }

    async handleFullAuto() {
        // Fetch turn number before clicking
        const turn = await this.getTurnNumber();
        logger.info(`In battle : turn ${turn}`);

        // Click Full Auto button
        if (await this.controller.elementExists(this.selectors.fullAutoButton)) {
            await this.controller.clickSafe(this.selectors.fullAutoButton);
            logger.info('Full Auto activated');
        } else {
            logger.warn('Full Auto button not found, may already be active');
        }
    }

    async handleSemiAuto() {
        // Wait for attack button
        if (await this.controller.waitForElement(this.selectors.attackButton, 10000)) {
            // Click Attack button to start
            await this.controller.clickSafe(this.selectors.attackButton);
            logger.info('Semi Auto: Attack initiated');

            // Enable Auto (not Full Auto)
            if (await this.controller.elementExists(this.selectors.autoButton, 3000)) {
                await sleep(randomDelay(500, 1000));
                await this.controller.clickSafe(this.selectors.autoButton);
                logger.info('Auto mode enabled');
            }
        }
    }

    /**
     * Wait for battle to finish
     */
    async waitForBattleEnd(mode, maxWaitMinutes = 10) {
        this.stopped = false; // Reset stop flag
        const maxWaitMs = maxWaitMinutes * 60 * 1000;
        const startTime = Date.now();
        let missingUiCount = 0;
        let lastTurn = 0;
        let turnCount = 0;

        logger.info('Waiting for battle to complete...');

        while (Date.now() - startTime < maxWaitMs) {
            if (this.stopped) {
                logger.info('Battle wait cancelled (bot stopped)');
                const duration = (Date.now() - startTime) / 1000;
                return { duration, turns: turnCount };
            }

            // Check turn number (safely)
            try {
                const currentTurn = await this.getTurnNumber();
                if (currentTurn > lastTurn) {
                    lastTurn = currentTurn;
                    turnCount = currentTurn;
                }
            } catch (e) {
                // Ignore
            }

            // Checks: Completion or Failure

            // 1. Result URL (Most reliable)
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#result')) {
                logger.info('Battle completed (detected via URL)');
                return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
            }

            // 2. Rematch fail popup
            if (await this.controller.elementExists('.img-rematch-fail.popup-1, .img-rematch-fail.popup-2', 100)) {
                logger.info('Rematch fail detected. Refreshing...');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(2000);
                return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
            }

            // 3. Character death
            if (await this.controller.elementExists('.btn-cheer', 100)) {
                logger.info('Party wiped (cheer button found).');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(2000);
                return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
            }

            // 4. Raid Logic (while on raid page)
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                // OK button as backup completion
                if (await this.controller.elementExists(this.selectors.okButton, 100)) {
                    logger.info('Battle completed (OK button found)');
                    return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
                }

                // Animation Skipping
                if (await this.controller.elementExists('.btn-attack-start.display-off', 100)) {
                    logger.info('Skipping animation...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });

                    // Wait for battle UI to reappear before re-engaging
                    await this.controller.waitForElement('.btn-attack-start', 15000);
                    await sleep(1000);

                    // Re-engage Auto after refresh
                    if (!this.stopped) {
                        if (mode === 'full_auto') await this.handleFullAuto();
                        else if (mode === 'semi_auto') await this.handleSemiAuto();
                    }
                    continue;
                }

                // Stuck detection
                const uiElements = ['.btn-attack-start.display-on', '.btn-usual-cancel', '.btn-auto'];
                let uiFound = false;
                for (const sel of uiElements) {
                    if (await this.controller.elementExists(sel, 100)) {
                        uiFound = true;
                        break;
                    }
                }

                if (uiFound) {
                    missingUiCount = 0;
                } else {
                    missingUiCount++;
                    if (missingUiCount >= 10) {
                        logger.warn('UI missing for too long. Refreshing...');
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });

                        await this.controller.waitForElement('.btn-attack-start', 15000);
                        await sleep(1000);

                        // Re-engage Auto after refresh
                        if (!this.stopped) {
                            if (mode === 'full_auto') await this.handleFullAuto();
                            else if (mode === 'semi_auto') await this.handleSemiAuto();
                        }
                        missingUiCount = 0;
                    }
                }
            } else {
                // Backup for non-raid URLs
                if (await this.controller.elementExists(this.selectors.okButton, 300)) {
                    return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
                }
            }

            await sleep(1000);
        }

        throw new Error('Battle timeout');
    }

    async handleResult() {
        // Skips clicking OK as requested.
    }

    async getTurnNumber() {
        try {
            return await this.controller.page.evaluate(() => {
                const container = document.querySelector('#js-turn-num-count');
                if (!container) return 0;

                // Get all digit divs (num-infoX)
                const digits = container.querySelectorAll('div[class*="num-info"]');
                let str = '';

                // Collect digits in order
                for (const d of digits) {
                    const match = d.className.match(/num-info(\d+)/);
                    if (match) str += match[1];
                }

                return parseInt(str, 10) || 0;
            });
        } catch (e) {
            return 0;
        }
    }
}

export default BattleHandler;
