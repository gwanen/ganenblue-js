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
        this.lastHonors = 0;
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

    async executeBattle(mode = 'full_auto', options = {}) {
        this.stopped = false;
        this.options = options; // Store options like honorTarget
        this.lastHonors = 0; // Reset honor for new battle
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
                    logger.warn('[Wait] Auto button missing. Attempting recovery...');
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
            logger.info(`[Summary] Duration ${formattedTime} (${result.turns} turns)`);

            return result;
        } catch (error) {
            logger.error('[Error] Battle execution failed:', error);
            // Return empty result to avoid breaking stats update loop
            return { duration: 0, turns: 0 };
        }
    }

    async handleFullAuto() {
        // Check URL before saying Initializing - we might be on result screen
        const url = this.controller.page.url();
        if (url.includes('#result') || url.includes('#quest/index')) return;

        logger.info('[Battle] Initializing...');

        // Wait for Full Auto button with 5s timeout
        const found = await this.controller.waitForElement(this.selectors.fullAutoButton, 5000);

        if (found) {
            await this.controller.clickSafe(this.selectors.fullAutoButton);
            logger.info('[FA] Full Auto enabled');

            // Skill Kill Protection: If button vanishes but no result screen, refresh
            await sleep(400); // Reduced from 1000ms for snappiness
            const stillExists = await this.controller.elementExists(this.selectors.fullAutoButton, 300);
            if (!stillExists) {
                const url = this.controller.page.url();
                if (!url.includes('#result') && !url.includes('#quest/index')) {
                    logger.warn('[Wait] Auto button vanished without result. Refreshing state...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await this.checkStateAndResume('full_auto');
                }
            }
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
            logger.info('[SA] Attack initiated');

            // NOTE: Per user request, we no longer click the Auto button in semi-auto mode.
        } else {
            logger.warn('[Wait] Attack button timeout. Refreshing page...');
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            await this.checkStateAndResume('semi_auto');
        }
    }

    async waitForBattleEnd(mode) {
        const honorTarget = parseInt(this.options?.honorTarget, 10) || 0;
        const maxWaitMinutes = config.get('bot.max_battle_time') || 15;
        const maxWaitMs = maxWaitMinutes * 60 * 1000;
        const startTime = Date.now();
        const checkInterval = 1000;
        let missingUiCount = 0;

        // Initial turn detection to avoid duplicate logging
        let turnCount = await this.getTurnNumber();
        let lastTurn = turnCount;

        logger.info('[Wait] Resolving turn...');
        if (turnCount > 0) {
            const honors = await this.getHonors();
            logger.info(`[Turn ${turnCount}] ${honors.toLocaleString()} honor`);

            if (honorTarget > 0 && honors >= honorTarget) {
                logger.info(`[Target] Honor goal reached: ${honors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                return { duration: (Date.now() - startTime) / 1000, turns: turnCount, honorReached: true };
            }
        }

        while (Date.now() - startTime < maxWaitMs) {
            if (this.stopped) {
                logger.info('[Wait] Cancelled (bot stopped)');
                const duration = (Date.now() - startTime) / 1000;
                return { duration, turns: turnCount };
            }

            // 1. Check turn number (safely)
            const context = { lastTurn, turnCount };
            const turnChanged = await this.updateTurnCount(context, honorTarget);
            lastTurn = context.lastTurn;
            turnCount = context.turnCount;

            if (turnChanged && turnChanged.honorReached) {
                return { duration: (Date.now() - startTime) / 1000, turns: turnCount, honorReached: true };
            }

            const currentUrl = this.controller.page.url();

            // 1. Definite End: Result URL
            if (currentUrl.includes('#result')) {
                return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
            }

            // 2. Rematch fail popup
            if (await this.controller.elementExists('.img-rematch-fail.popup-1, .img-rematch-fail.popup-2', 100)) {
                logger.info('[Wait] Rematch fail detected. Refreshing...');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(1500); // snappier reload
                return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
            }

            // 3. Character death
            if (await this.controller.elementExists('.btn-cheer', 100)) {
                logger.info('[Raid] Party wiped (cheer button found).');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(1500); // snappier reload
                return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
            }

            // 4. Raid Ended popup (Join phase race condition)
            if (await this.controller.elementExists(this.selectors.raidEndedPopup, 100)) {
                logger.info('[Raid] Battle already ended.');
                await this.controller.clickSafe(this.selectors.raidEndedOkButton);
                await sleep(1000);
                return { duration: 0, turns: 0, raidEnded: true };
            }

            // 5. Raid Logic (while on raid page)
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                // Animation Skipping (Immediate Reload)
                if (await this.controller.elementExists('.btn-attack-start.display-off', 150)) {
                    logger.info('[Reload] Skipping animations...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(1200); // Reduced from 3000ms for snappier response

                    // Proactively check turn after reload but before FA enable
                    const reloadContext = { lastTurn, turnCount };
                    const reloadResult = await this.updateTurnCount(reloadContext, honorTarget);
                    lastTurn = reloadContext.lastTurn;
                    turnCount = reloadContext.turnCount;

                    if (reloadResult?.honorReached) {
                        return { duration: (Date.now() - startTime) / 1000, turns: turnCount, honorReached: true };
                    }

                    if (await this.checkStateAndResume(mode)) {
                        return { duration: (Date.now() - startTime) / 1000, turns: turnCount, honorReached: reloadResult?.honorReached || false };
                    }
                    continue;
                }

                // Stuck detection
                const uiElements = ['.btn-attack-start.display-on', '.btn-usual-cancel', '.btn-auto'];
                let uiFound = false;
                for (const sel of uiElements) {
                    if (await this.controller.elementExists(sel, 200)) {
                        uiFound = true;
                        break;
                    }
                }

                if (uiFound) {
                    missingUiCount = 0;
                } else {
                    missingUiCount++;
                    if (missingUiCount >= 8) { // ~8 seconds
                        logger.warn('[Wait] UI missing (stuck). Refreshing...');
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(1200);

                        // Proactively check turn after reload but before FA enable
                        const stuckContext = { lastTurn, turnCount };
                        const stuckResult = await this.updateTurnCount(stuckContext, honorTarget);
                        lastTurn = stuckContext.lastTurn;
                        turnCount = stuckContext.turnCount;

                        if (stuckResult?.honorReached) {
                            return { duration: (Date.now() - startTime) / 1000, turns: turnCount, honorReached: true };
                        }

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: turnCount, honorReached: stuckResult?.honorReached || false };
                        }
                        missingUiCount = 0;
                    }
                }

                // Note: We deliberately do NOT check for OK button here to avoid premature exit on popups.
            } else {
                // 5. Backup for non-raid URLs (Event quests, etc)
                if (await this.controller.elementExists(this.selectors.okButton, 300)) {
                    return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
                }
            }

            await sleep(checkInterval);
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
        if (url.includes('#result') || url.includes('#quest/index')) {
            return true;
        }

        // 2. Check for OK button (completion modal)
        if (await this.controller.elementExists(this.selectors.okButton, 2000)) {
            logger.info('[Cleared] Battle finished during reload');
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            return true;
        }

        // 3. Still in battle? Wait for UI components to appear
        const found = await this.controller.waitForElement('.btn-attack-start', 2000);
        if (found && !this.stopped) {
            if (mode === 'full_auto') {
                // Re-attempt FA
                const faFound = await this.controller.waitForElement(this.selectors.fullAutoButton, 3000);
                if (faFound) {
                    await this.controller.clickSafe(this.selectors.fullAutoButton);
                    logger.info('[FA] Full Auto enabled (after refresh)');

                    // Verification check
                    await sleep(1000);
                    if (!await this.controller.elementExists(this.selectors.fullAutoButton, 500)) {
                        const url = this.controller.page.url();
                        if (!url.includes('#result') && !url.includes('#quest/index')) {
                            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                            return await this.checkStateAndResume(mode);
                        }
                    }
                }
            } else if (mode === 'semi_auto') {
                // For Semi-Auto, click Attack if available
                const attackFound = await this.controller.elementExists(this.selectors.attackButton, 500);
                if (attackFound) {
                    await this.controller.clickSafe(this.selectors.attackButton);
                    logger.info('[SA] Attack initiated (after refresh)');
                }
                // NOTE: Per user request, we no longer click the Auto button in semi-auto mode.
            }
        }

        // 4. Final safety check after timeout
        const finalUrl = this.controller.page.url();
        if (finalUrl.includes('#result') || finalUrl.includes('#quest/index')) {
            return true;
        }

        return false;
    }

    /**
     * Helper to update and log turn number.
     * Takes a context object { lastTurn, turnCount } to update by reference.
     */
    async updateTurnCount(context, honorTarget = 0) {
        try {
            const currentTurn = await this.getTurnNumber();
            if (currentTurn > context.lastTurn) {
                context.lastTurn = currentTurn;
                context.turnCount = currentTurn;

                // Wait exactly for DOM to update
                await sleep(400);
                const honors = await this.getHonors();
                logger.info(`[Turn ${currentTurn}] ${honors.toLocaleString()} honor`);

                const honorReached = honorTarget > 0 && honors >= honorTarget;
                if (honorReached) {
                    logger.info(`[Target] Honor goal reached: ${honors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                }

                return { turnChanged: true, honorReached, honors };
            }
        } catch (e) {
            // Ignore
        }
        return { turnChanged: false, honorReached: false };
    }

    async getHonors() {
        let retries = 3;
        while (retries > 0) {
            try {
                const honors = await this.controller.page.evaluate(() => {
                    const userRow = document.querySelector('.lis-user.guild-member');
                    if (!userRow) return null; // Distinguish between "not found" and "0"
                    const pointEl = userRow.querySelector('.txt-point');
                    if (!pointEl) return null;
                    const honorsStr = pointEl.textContent.replace(/,/g, '').replace('pt', '').trim();
                    return parseInt(honorsStr, 10) || 0;
                });

                // If we found a value (even 0), check if it makes sense
                if (honors !== null) {
                    // Regression protection: If it's 0 but we previously had honors, 
                    // it might be a transient loading state.
                    if (honors === 0 && this.lastHonors > 0 && retries > 1) {
                        await sleep(500);
                        retries--;
                        continue;
                    }
                    this.lastHonors = honors;
                    return honors;
                }
            } catch (e) {
                // Ignore
            }

            await sleep(500);
            retries--;
        }
        return this.lastHonors; // Fallback to last known honors
    }

    async getTurnNumber() {
        try {
            return await this.controller.page.evaluate(() => {
                // Try different possible IDs for the turn counter container
                const containerIds = ['#js-turn-num-count', '#js-turn-num'];
                let container = null;

                for (const id of containerIds) {
                    container = document.querySelector(id);
                    if (container) break;
                }

                if (!container) return 0;

                // For #js-turn-num, the digits might be inside a child div with id="js-turn-num-count"
                const countContainer = container.id === 'js-turn-num-count'
                    ? container
                    : container.querySelector('#js-turn-num-count') || container;

                // Get all digit divs (num-infoX)
                const digits = countContainer.querySelectorAll('div[class*="num-info"]');
                if (digits.length === 0) return 0;

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
