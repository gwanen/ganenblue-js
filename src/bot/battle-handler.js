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

    async isWiped() {
        return await this.controller.page.evaluate(() => {
            // 1. Check for party wipe buttons
            const wipeSelectors = ['.btn-cheer', '.btn-salute'];
            for (const sel of wipeSelectors) {
                const el = document.querySelector(sel);
                if (el && el.offsetWidth > 0 && el.offsetHeight > 0) return true;
            }

            // 2. Check for End-of-Battle popups (Watchdog for late-appearing errors/conclusion)
            // Case A: Assist Raid already ended
            const assistEnded = document.querySelector('.pop-result-assist-raid.pop-show');
            if (assistEnded && assistEnded.style.display === 'block') {
                const bodyText = assistEnded.querySelector('.txt-popup-body')?.textContent || '';
                if (bodyText.includes('already ended')) return true;
            }

            // Case B: Battle Concluded (Rematch Fail popup)
            const rematchFail = document.querySelector('.pop-rematch-fail.pop-show');
            if (rematchFail && (rematchFail.style.display === 'block' || rematchFail.offsetWidth > 0)) {
                const bodyText = rematchFail.querySelector('.txt-popup-body')?.textContent || '';
                if (bodyText.includes('battle has ended') || bodyText.includes('defeated')) return true;
            }

            return false;
        });
    }

    async executeBattle(mode = 'full_auto', options = {}) {
        this.stopped = false;
        this.options = options; // Store options like honorTarget
        this.lastHonors = 0; // Reset honor for new battle
        // Start timing
        this.battleStartTime = Date.now();
        logger.info(`[Battle] Engaging encounter (${mode})`);

        // Enable Network Listener
        if (this.controller.network) {
            this.controller.network.start();
        }

        try {
            // Optimization: Skip wait if already finished
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#result')) {
                return await this.waitForBattleEnd(mode);
            }

            // Wait for battle screen to load (look for Auto button in FA, Attack button in SA)
            const loadSelector = mode === 'semi_auto' ? this.selectors.attackButton : '.btn-auto';
            const battleLoaded = await this.controller.waitForElement(loadSelector, 20000);

            if (!battleLoaded) {
                const currentUrl = this.controller.page.url();
                // Check if we are actually in battle but maybe button is different or obscured
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    logger.warn('[Wait] Auto button missing. Attempting recovery');
                } else if (!currentUrl.includes('#result')) {
                    throw new Error(`Battle failed to load. URL: ${currentUrl}`);
                }
            }

            // FA Speed Optimization: Removed the 500-1000ms delay here

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
            logger.info(`[Summary] Duration: ${formattedTime} (${result.turns} turns)`);

            return result;
        } catch (error) {
            if (this.controller.isNetworkError(error) || error.message.includes('Target closed') || error.message.includes('Session closed')) {
                logger.debug('[Battle] Interrupted by browser close/stop');
            } else {
                logger.error(`[Error] Battle execution failed: ${error.message}`);

                // Safety: If battle failed to load because of a redirect, stop the bot
                if (error.message.includes('Battle failed to load')) {
                    logger.warn('[Safety] Battle failed to load. Halting bot for safety');
                    this.stop();
                } else {
                    await this.controller.takeScreenshot('error_battle');
                }
            }
            // Return empty result to avoid breaking stats update loop
            return { duration: 0, turns: 0 };
        } finally {
            // Stop Network Listener
            if (this.controller.network) {
                this.controller.network.stop();
            }
        }
    }

    async handleFullAuto() {
        const url = this.controller.page.url();
        if (url.includes('#result') || url.includes('#quest/index')) return;

        logger.info('[Battle] Initializing Full Auto');

        // 1. Wait for Auto Button or Wipe (ensure battle is loaded)
        // Optimization: Poll for BOTH auto button and wipe state to avoid blocking
        const startTimeAuto = Date.now();
        const timeoutAuto = 45000;
        let autoBtnFound = false;

        while (Date.now() - startTimeAuto < timeoutAuto) {
            if (this.stopped) return;

            const state = await this.controller.page.evaluate(() => {
                const auto = document.querySelector('.btn-auto');
                const result = window.location.hash.includes('#result');

                return {
                    autoFound: !!auto && auto.offsetWidth > 0,
                    isResult: result
                };
            });

            if (state.isResult || await this.isWiped()) {
                logger.info(await this.isWiped() ? '[Raid] Party wiped detected during FA init' : '[Wait] Landed on result during FA init');
                return; // Let executeBattle handle the result/wipe
            }

            if (state.autoFound) {
                autoBtnFound = true;
                break;
            }

            await sleep(500);
        }

        if (!autoBtnFound) {
            logger.warn('[FA] Auto button not found. Refreshing');
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            await this.checkStateAndResume('full_auto');
            return;
        }

        // 2. Press Auto Button
        logger.debug('[FA] Clicking Auto button');
        await this.controller.clickSafe(this.selectors.fullAutoButton, {
            silent: true,
            preDelay: 0,
            delay: 0,
            waitAfter: false
        });

        // 3. Wait for Attack or Auto Button Disappearance (Max 45s)
        logger.info('[Wait] Waiting for attack or auto button disappearance...');
        const startTime = Date.now();
        const timeout = 45000; // 45 seconds

        while (Date.now() - startTime < timeout) {
            if (this.stopped) return;

            const state = await this.controller.page.evaluate((selAttack, selAuto) => {
                const att = document.querySelector(selAttack);
                const auto = document.querySelector(selAuto);

                const attHidden = !att || att.classList.contains('display-off') || att.style.display === 'none';
                const autoHidden = !auto || auto.style.display === 'none';

                return { isHidden: attHidden || autoHidden };
            }, this.selectors.attackButton, this.selectors.fullAutoButton);

            if (state.isHidden) {
                // Proactively check for popups/result after disappearance to avoid false positive active state
                if (await this.isWiped()) {
                    logger.info('[Raid] Battle end detected via popup after FA toggle');
                    return;
                }
                logger.info('[FA] Full Auto active (Button hidden)');
                return;
            }

            if (await this.isWiped()) {
                logger.info('[Raid] Battle end detected via popup during FA active wait');
                return;
            }

            await sleep(500); // Poll every 500ms
        }

        // 4. Timeout - Refresh
        logger.error('[FA] Both buttons still visible after 45s. Refreshing');
        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(800);
        await this.checkStateAndResume('full_auto');
    }

    /**
     * Verifies if FA is actually running based on User Logic:
     * 1. Skill Rail Visible (AND not 'hide') -> SUCCESS
     * 2. Attack Button Hidden (display-off) -> SUCCESS (Attacking)
     * 3. Attack Button Visible (display-on) -> FAIL
     */
    async verifyFullAutoState() {
        return await this.controller.page.evaluate((selectors) => {
            // Check Attack Button
            const attackBtn = document.querySelector(selectors.attackButton);
            if (attackBtn) {
                if (attackBtn.classList.contains('display-off')) {
                    return true; // Attack started (or transitioning)
                }
                if (attackBtn.classList.contains('display-on')) {
                    return false; // Still idling, click failed
                }
            }

            // Check Auto Button disappearance as fallback
            const autoBtn = document.querySelector(selectors.fullAutoButton);
            if (!autoBtn || autoBtn.style.display === 'none') {
                return true;
            }

            return false;
        }, this.selectors);
    }

    async handleSemiAuto() {
        const selAttack = '.btn-attack-start.display-on';
        const selCancel = this.selectors.attackCancel;

        // 1. Wait for attack button
        logger.debug('[SA] Waiting for attack button');
        const attackReady = await this.controller.waitForElement(selAttack, 10000);

        if (!attackReady) {
            logger.warn('[SA] Attack button timeout. Refreshing');
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            return;
        }

        // 2. Press
        await this.controller.clickSafe(selAttack, {
            preDelay: 0,
            delay: randomDelay(50, 100),
            waitAfter: false
        });
        logger.info('[SA] Attack pressed');

        // 3. Wait for attack button and cancel button disappear
        logger.debug('[SA] Waiting for buttons to disappear');
        await this.controller.page.waitForFunction((sAtt, sCan) => {
            const att = document.querySelector(sAtt);
            const can = document.querySelector(sCan);
            const attGone = !att || att.classList.contains('display-off') || att.offsetHeight === 0;
            const canGone = !can || can.classList.contains('display-off') || can.offsetHeight === 0;
            return attGone && canGone;
        }, { timeout: 5000 }, selAttack, selCancel).catch(() => {
            logger.debug('[SA] Disappearance wait timed out');
        });

        // 4. Refresh
        logger.info('[SA] Refreshing');
        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
    }

    async waitForBattleEnd(mode) {
        const honorTarget = parseInt(this.options?.honorTarget, 10) || 0;
        const maxWaitMinutes = config.get('bot.max_battle_time') || 15;
        const maxWaitMs = maxWaitMinutes * 60 * 1000;
        const startTime = Date.now();
        // checkInterval will be dynamic inside the loop
        let missingUiCount = 0;

        // Initial turn detection to avoid duplicate logging
        let turnCount = await this.getTurnNumber();
        let lastTurn = turnCount;
        let lastTurnChangeTime = Date.now();

        logger.info('[Wait] Resolving turn');
        if (turnCount > 0) {
            const honors = await this.getHonors();
            logger.info(`[Turn ${turnCount}] ${honors.toLocaleString()} honor`);

            if (honorTarget > 0 && honors >= honorTarget) {
                logger.info(`[Target] Honor goal reached: ${honors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                return { duration: (Date.now() - startTime) / 1000, turns: turnCount, honorReached: true };
            }
        }

        // Network Event Promise
        let networkFinished = false;
        const onBattleResult = () => {
            logger.info('[Network] Battle end detected');
            networkFinished = true;
        };

        if (this.controller.network) {
            this.controller.network.once('battle:result', onBattleResult);
        }

        try {
            while (Date.now() - startTime < maxWaitMs) {
                if (this.stopped) {
                    logger.info('[Wait] Cancelled (Bot stopped)');
                    const duration = (Date.now() - startTime) / 1000;
                    return { duration, turns: turnCount };
                }

                if (networkFinished) {
                    // Short sleep to allow UI to update slightly (optional, but good for safety)
                    await sleep(500);
                    return { duration: (Date.now() - startTime) / 1000, turns: turnCount + 1 };
                }

                // 1. Check turn number (safely)
                const context = { lastTurn, turnCount };
                const turnChanged = await this.updateTurnCount(context, honorTarget);
                lastTurn = context.lastTurn;
                turnCount = context.turnCount;

                if (turnChanged) {
                    lastTurnChangeTime = Date.now();
                    if (turnChanged.honorReached) {
                        return { duration: (Date.now() - startTime) / 1000, turns: turnCount, honorReached: true };
                    }
                }

                // Watchdog & Periodic Honor Check
                if (Date.now() - lastTurnChangeTime > 1000) {
                    const currentRelUrl = this.controller.page.url();
                    const isRaid = currentRelUrl.includes('#raid') || currentRelUrl.includes('_raid');

                    if (isRaid && honorTarget > 0) {
                        const h = await this.getHonors();
                        if (h >= honorTarget) {
                            logger.info(`[Target] Honor goal reached periodically: ${h.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                            return { duration: (Date.now() - startTime) / 1000, turns: turnCount, honorReached: true };
                        }
                    }

                    // Original watchdog (10s)
                    if (Date.now() - lastTurnChangeTime > 10000 && isRaid) {
                        const isActive = await this.controller.page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            return el && el.classList.contains('active');
                        }, this.selectors.fullAutoButton);

                        if (!isActive) {
                            logger.warn('[Wait] Watchdog: Battle stuck and Full Auto is OFF. Re-activating');
                            await this.handleFullAuto();
                        }
                        lastTurnChangeTime = Date.now(); // Reset watchdog timer
                    }
                }

                const currentUrl = this.controller.page.url();

                // 1. Definite End: Result URL or Empty Result Notice
                if (currentUrl.includes('#result')) {
                    return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
                }

                if (await this.controller.elementExists(this.selectors.emptyResultNotice, 100)) {
                    logger.info('[Wait] Empty result screen detected');
                    return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
                }

                // 2. Rematch fail popup
                if (await this.controller.elementExists('.img-rematch-fail.popup-1, .img-rematch-fail.popup-2', 100)) {
                    logger.info('[Wait] Rematch failure detected. Refreshing');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(800); // Standardized fast reload
                    return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
                }

                // 3. Character death (Wipe)
                if (await this.isWiped()) {
                    logger.info('[Raid] Party wiped (Death popup detected)');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(800); // Standardized fast reload
                    return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
                }

                // 4. Raid Ended popup (Join phase race condition)
                if (await this.controller.elementExists(this.selectors.raidEndedPopup, 100)) {
                    logger.info('[Raid] Battle already ended');
                    await this.controller.clickSafe(this.selectors.raidEndedOkButton);
                    await sleep(1000);
                    return { duration: 0, turns: 0, raidEnded: true };
                }

                // 5. Raid Logic (while on raid page)
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    // Semi-Auto Proactive Trigger: If button is ready, start the sequence
                    if (mode === 'semi_auto') {
                        const attReady = await this.controller.elementExists('.btn-attack-start.display-on', 150);
                        if (attReady) {
                            await this.handleSemiAuto();
                            continue; // handleSemiAuto reloads, so we continue the loop
                        }
                    }

                    // Animation Skipping (Immediate Reload)
                    // Aggressive check: 100ms timeout for faster detection
                    if (await this.controller.elementExists('.btn-attack-start.display-off', 100)) {
                        logger.info('[Reload] Skipping animations');
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(800); // Reduced from 1200ms for maximum speed

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
                    const uiElements = ['.btn-attack-start.display-on', '.btn-usual-cancel', '.btn-auto', '.btn-cheer', '.btn-salute'];
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
                        // User Request: Faster reload on stuck UI (~4 seconds)
                        if (missingUiCount >= 4) { // ~4 seconds (was 8)
                            logger.warn('[Wait] UI missing (Stuck). Refreshing');
                            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                            await sleep(800); // Reduced from 1200ms

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
                    if (await this.controller.elementExists(this.selectors.okButton, 300) ||
                        await this.controller.elementExists(this.selectors.emptyResultNotice, 100)) {
                        return { duration: (Date.now() - startTime) / 1000, turns: turnCount };
                    }
                }

                // Dynamic wait based on context
                const isRaid = currentUrl.includes('#raid') || currentUrl.includes('_raid');
                const waitTime = isRaid ? 100 : 800; // Faster polling for raids (100ms)
                await sleep(waitTime);
            }

            throw new Error('Battle timeout');
        } finally {
            // Cleanup listener
            if (this.controller.network) {
                this.controller.network.off('battle:result', onBattleResult);
            }
        }
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

        // 1. Check URL and Login Button (Most reliable)
        // Check for home page redirections, landing pages (#top), or the presence of the login button
        const isLoggedOut = await this.controller.page.evaluate(() => {
            const url = window.location.href;
            const hasLogin = !!document.querySelector('#login-auth');
            const isHome = url === 'https://game.granbluefantasy.jp/' ||
                url === 'https://game.granbluefantasy.jp/#' ||
                url.includes('#mypage') ||
                url.includes('#top') ||
                url.includes('mobage.jp') ||
                url.includes('registration');
            return hasLogin || isHome;
        });

        if (isLoggedOut) {
            logger.error(`[Safety] Session expired or Redirected to landing (${url}). Stopping`);
            this.stop();
            return true; // Stop execution
        }

        if (url.includes('#result') || url.includes('#quest/index')) {
            return true;
        }

        // 2. Check for OK button (completion modal), Empty Result Notice, or Wipe
        if (await this.controller.elementExists(this.selectors.okButton, 2000) ||
            await this.controller.elementExists(this.selectors.emptyResultNotice, 500) ||
            await this.isWiped()) {
            logger.info(await this.isWiped() ? '[Cleared] Party wiped' : '[Cleared] Battle finished');
            return true;
        }

        // 3. Still in battle? Wait for UI components to appear
        const found = await this.controller.waitForElement('.btn-attack-start', 2000);
        if (found && !this.stopped) {
            if (mode === 'full_auto') {
                // Re-attempt FA using the centralized simplified logic
                await this.handleFullAuto();
                return false;
            } else if (mode === 'semi_auto') {
                await this.handleSemiAuto();
                return false;
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

                // Wait for DOM to update (200ms is enough for most modern systems)
                await sleep(200);
                const isRaid = this.controller.page.url().includes('raid');

                if (isRaid) {
                    const honors = await this.getHonors();
                    logger.info(`[Turn ${currentTurn}] ${honors.toLocaleString()} honor`);

                    const honorReached = honorTarget > 0 && honors >= honorTarget;
                    if (honorReached) {
                        logger.info(`[Target] Honor goal reached: ${honors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                    }
                    return { turnChanged: true, honorReached, honors };
                } else {
                    logger.info(`[Turn ${currentTurn}]`);
                    return { turnChanged: true, honorReached: false, honors: 0 };
                }
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
