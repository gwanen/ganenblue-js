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
        logger.info(`[Battle] Engaging encounter (${mode})`);

        try {
            // Optimization: Skip wait if already finished
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#result')) {
                return await this.waitForBattleEnd(mode);
            }

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

            this.browser = await puppeteer.launch(launchOptions);

            // Reuse the initial blank page if available, otherwise create one
            const pages = await this.browser.pages();
            this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();
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
            logger.info(`[Summary] Duration ${formattedTime}`);

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
        if (turn > 0) {
            logger.info(`[Turn ${turn}]`);
        } else {
            logger.info('[Battle] Initializing...');
        }

        // Wait for Full Auto button with 5s timeout
        const found = await this.controller.waitForElement(this.selectors.fullAutoButton, 5000);

        if (found) {
            await this.controller.clickSafe(this.selectors.fullAutoButton);
            logger.info('[FA] Full Auto enabled');
        } else {
            logger.warn('[Wait] Auto button timeout. Refreshing page...');
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            await this.checkStateAndResume('full_auto');
        }
    }

    async handleSemiAuto() {
        // Wait for attack button
        if (await this.controller.waitForElement(this.selectors.attackButton, 10000)) {
            // Click Attack button to start
            await this.controller.clickSafe(this.selectors.attackButton);
            logger.info('Semi Auto: Attack initiated');

            // Enable Auto (not Full Auto) with 5s timeout
            const found = await this.controller.waitForElement(this.selectors.autoButton, 5000);
            if (found) {
                await sleep(randomDelay(500, 1000));
                await this.controller.clickSafe(this.selectors.autoButton);
                logger.info('Auto mode enabled');
            } else {
                logger.warn('[Wait] Auto button timeout. Refreshing page...');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await this.checkStateAndResume('semi_auto');
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

        logger.info('[Wait] Resolving turn...');

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
                logger.info('[Cleared] Victory!');
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
                    logger.info('[Reload] Skipping animations...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });

                    if (await this.checkStateAndResume(mode)) return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
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

                        if (await this.checkStateAndResume(mode)) return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
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

    /**
     * Standardized state detection after refresh.
     * Checks URL first, then completion modal, then battle UI.
     * Returns true if battle is finished.
     */
    async checkStateAndResume(mode) {
        const url = this.controller.page.url();

        // 1. Check URL first (Most reliable)
        if (url.includes('#result')) {
            return true;
        }

        // 2. Check for OK button (completion modal)
        if (await this.controller.elementExists(this.selectors.okButton, 2000)) {
            logger.info('[Cleared] Battle finished during reload');
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            return true;
        }

        // 3. Still in battle? Wait for UI components to appear
        const found = await this.controller.waitForElement('.btn-attack-start', 8000);
        if (found && !this.stopped) {
            if (mode === 'full_auto') {
                // Re-attempt FA
                const faFound = await this.controller.waitForElement(this.selectors.fullAutoButton, 3000);
                if (faFound) {
                    await this.controller.clickSafe(this.selectors.fullAutoButton);
                    logger.info('[FA] Full Auto enabled (after refresh)');
                }
            } else if (mode === 'semi_auto') {
                const autoFound = await this.controller.waitForElement(this.selectors.autoButton, 3000);
                if (autoFound) {
                    await this.controller.clickSafe(this.selectors.autoButton);
                    logger.info('[FA] Auto mode enabled (after refresh)');
                }
            }
        }
        return false;
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
