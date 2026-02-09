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
                } else {
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

            // Wait for battle to complete
            await this.waitForBattleEnd(mode);

            // Calculate battle duration
            this.lastBattleDuration = Date.now() - this.battleStartTime;
            const formattedTime = this.formatTime(this.lastBattleDuration);
            logger.info(`Battle completed in ${formattedTime}`);

            return true;
        } catch (error) {
            logger.error('Battle execution failed:', error);
            throw error;
        }
    }

    async handleFullAuto() {
        // Click Full Auto button
        if (await this.controller.elementExists(this.selectors.fullAutoButton)) {
            await this.controller.clickSafe(this.selectors.fullAutoButton);
            logger.info('Full Auto activated');
        } else {
            logger.warn('Full Auto button not found, may already be active');
        }
    }

    async handleSemiAuto() {
        // Click Attack button to start
        await this.controller.clickSafe(this.selectors.attackButton);
        logger.info('Semi Auto: Attack initiated');

        // Enable Auto (not Full Auto)
        if (await this.controller.elementExists(this.selectors.autoButton)) {
            await sleep(randomDelay(500, 1000));
            await this.controller.clickSafe(this.selectors.autoButton);
            logger.info('Auto mode enabled');
        }
    }

    /**
     * Wait for battle to finish
     */
    async waitForBattleEnd(mode, maxWaitMinutes = 10) {
        this.stopped = false; // Reset stop flag
        const maxWaitMs = maxWaitMinutes * 60 * 1000;
        const startTime = Date.now();
        const checkInterval = 2000;
        let missingUiCount = 0;

        logger.info('Waiting for battle to complete...');

        while (Date.now() - startTime < maxWaitMs) {
            if (this.stopped) {
                logger.info('Battle wait cancelled (bot stopped)');
                return false;
            }

            // Check for rematch fail popup (battle already ended by other players)
            // Both popup-1 and popup-2 can appear
            const rematchFailPopup = await this.controller.elementExists('.img-rematch-fail.popup-1, .img-rematch-fail.popup-2', 500);
            if (rematchFailPopup) {
                logger.info('Rematch fail detected - battle already completed by others. Refreshing page...');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(2000);
                return true;
            }

            const currentUrl = this.controller.page.url();

            // 1. Definite End: Result URL
            if (currentUrl.includes('#result')) {
                logger.info('Battle completed (detected via URL)! Immediate return.');
                // EST: Maximum Speed - No wait for OK button.
                return true;
            }

            // 2. Raid Logic (Strictly wait while on Raid URL)
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                // User Condition: Auto-refresh if Attack/Cancel buttons are missing for ~10s
                // AND immediate refresh if 'display-off' (animation start) is detected to skip animation

                // 1. Check for Animation Start (Immediate Refresh)
                const attackOff = await this.controller.elementExists('.btn-attack-start.display-off', 200);
                if (attackOff) {
                    // Check stop before refresh
                    if (this.stopped) {
                        logger.info('Battle wait cancelled (bot stopped before refresh)');
                        return false;
                    }

                    logger.info('Attack animation started (display-off). Refreshing to skip...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(1500); // Reduced from 3000ms for snappier response

                    // Check stop after reload delay
                    if (this.stopped) {
                        logger.info('Battle wait cancelled (bot stopped after refresh)');
                        return false;
                    }

                    // Optimization: Check URL first to decide what to wait for
                    const postRefreshUrl = this.controller.page.url();

                    if (postRefreshUrl.includes('#result')) {
                        logger.info('Battle ended (URL=#result). Immediate return.');
                        return true;
                    } else {
                        // Still in raid or unknown state: Wait for Battle UI OR unexpected OK button
                        const loaded = await this.controller.waitForElement('.btn-usual-ok, .btn-auto, .btn-attack-start', 15000);

                        if (loaded) {
                            // Check if it's the OK button (Battle Done)
                            if (await this.controller.elementExists(this.selectors.okButton, 500)) {
                                logger.info('Battle completed (OK button found after refresh)!');
                                return true;
                            }

                            // If we are here, it means FA/Attack button was found (Battle Continues)
                            logger.info('Battle continues (FA/Attack button found after refresh). Re-engaging...');

                            // Check stop before re-engagement
                            if (this.stopped) {
                                logger.info('Battle wait cancelled (bot stopped before re-engagement)');
                                return false;
                            }

                            // Re-engage Auto/Attack if needed after refresh
                            if (mode === 'full_auto') {
                                await this.handleFullAuto();
                            } else if (mode === 'semi_auto') {
                                await this.handleSemiAuto();
                            }
                        } else {
                            logger.warn('Refresh complete but neither OK nor Battle UI found within timeout.');
                        }
                    }

                    // Reset counter just in case
                    missingUiCount = 0;
                    continue;
                }

                // 2. Check for Stuck State (Missing UI)
                const attackVisible = await this.controller.elementExists('.btn-attack-start.display-on', 200);
                const cancelVisible = await this.controller.elementExists('.btn-usual-cancel', 200);

                if (!attackVisible && !cancelVisible) {
                    missingUiCount++;
                    logger.debug(`Battle UI (Attack/Cancel) missing count: ${missingUiCount}/5`);

                    if (missingUiCount >= 5) { // ~10 seconds
                        // Check stop before refresh
                        if (this.stopped) {
                            logger.info('Battle wait cancelled (bot stopped before stuck state refresh)');
                            return false;
                        }

                        logger.info('Battle UI missing (Attack and Cancel not visible). Auto-refreshing page...');
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(2000); // Reduced from 4000ms for snappier response

                        // Check stop after reload delay
                        if (this.stopped) {
                            logger.info('Battle wait cancelled (bot stopped after stuck state refresh)');
                            return false;
                        }

                        missingUiCount = 0;
                        // After refresh, the loop continues and naturally checks state again
                        continue;
                    }
                } else {
                    missingUiCount = 0;
                }

                // Note: We deliberately do NOT check for OK button here to avoid premature exit on popups.

            } else {
                // 3. Not on Raid URL (and not Result URL)
                // Check for OK button here (fallback check)
                if (await this.controller.elementExists(this.selectors.okButton, 500)) {
                    logger.info('Battle completed (OK button found in non-raid URL)!');
                    return true;
                }
            }

            await sleep(checkInterval);
        }

        throw new Error('Battle timeout - exceeded maximum wait time');
    }

    async handleResult() {
        // Method kept for API compatibility, but effectively empty for "no-click" optimization
        // unless called explicitly for legacy reasons.
        // User requested NO clicking of OK button.
    }
}

export default BattleHandler;
