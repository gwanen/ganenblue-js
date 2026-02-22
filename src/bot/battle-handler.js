import PageController from '../core/page-controller.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';

class BattleHandler {
    constructor(page, options = {}) {
        // Reuse parent bot's PageController if provided (avoids duplicate NetworkListeners per profile)
        this.controller = options.controller || new PageController(page);
        this.selectors = config.selectors.battle;
        this.stopped = false;
        this.battleStartTime = null;
        this.lastBattleDuration = 0;
        this.lastHonors = 0;
        this.fastRefresh = options.fastRefresh || false;
        this.logger = options.logger || logger;
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
        if (!this.controller.isAlive()) return false;

        return await this.controller.page.evaluate(() => {
            // 1. Check for party wipe buttons (Cheer/Salute)
            const wipeSelectors = ['.btn-cheer', '.btn-salute'];
            for (const sel of wipeSelectors) {
                const el = document.querySelector(sel);
                // Note: mid-battle cheer popups also have these buttons. 
                // We check if it's the "Unable to Continue" screen or just a поддеркa prompt.
                if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
                    const header = document.querySelector('.prt-popup-header');
                    if (header && header.textContent.includes('Unable to Continue')) return true;
                    // If it's just the 'Salute Participants' (Cheer) popup, it's NOT necessarily a wipe.
                    const isSalutePopup = !!document.querySelector('.pop-cheer.pop-show');
                    if (!isSalutePopup) return true;
                }
            }

            // 2. Check for "You were defeated" popups/text
            const bodyText = document.body.innerText.toLowerCase();
            if (bodyText.includes('you were defeated') || bodyText.includes('battle has ended')) {
                // Verify it's in a popup or major container, not just random text
                const visiblePopup = document.querySelector('.pop-show, .prt-popup-body, .prt-result');
                if (visiblePopup && (visiblePopup.offsetWidth > 0 || visiblePopup.offsetHeight > 0)) {
                    return true;
                }
            }

            // 3. Check for Elixir prompt (appears when team is wiped)
            const elixirPrompt = document.querySelector('.pop-use-elixir, .img-elixir');
            if (elixirPrompt && (elixirPrompt.offsetWidth > 0 || elixirPrompt.offsetHeight > 0)) {
                return true;
            }

            // 4. Check for End-of-Battle popups (Assist Raid ended, Conclusion, etc.)
            const conclusionPopups = ['.pop-result-assist-raid.pop-show', '.pop-rematch-fail.pop-show', '.pop-conclusion'];
            for (const sel of conclusionPopups) {
                const el = document.querySelector(sel);
                if (el && (el.offsetWidth > 0 || el.style.display === 'block')) {
                    const text = el.textContent.toLowerCase();
                    if (text.includes('ended') || text.includes('defeated') || text.includes('concluded') || text.includes('home screen')) {
                        return true;
                    }
                }
            }

            return false;
        });
    }

    async executeBattle(mode = 'full_auto', options = {}) {
        this.stopped = false;
        this.options = options; // Store options like honorTarget
        this.battleStartTime = Date.now();
        this.lastAttackTurn = 0; // Track turn number of last SA attack
        this.lastReloadTurn = 0; // Track last turn where animation skipping occurred
        this.logger.info(`[Battle] Engaging combat (${mode})`);

        try {
            // Optimization: Skip wait if already finished
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#result')) {
                return await this.waitForBattleEnd(mode);
            }

            // User Optimization: Refresh on start to skip entrance animations
            if (options.refreshOnStart) {
                this.logger.info('[Battle] Refreshing to skip animations');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(this.fastRefresh ? 200 : 500);

                // Immediately check for "Raid is Full" popup after reload — don't wait 10s for the Auto button
                const raidFullAfterRefresh = await this.controller.page.evaluate(() => {
                    const popup = document.querySelector('.pop-usual.common-pop-error.pop-show');
                    if (!popup || popup.offsetWidth === 0) return false;
                    const body = popup.querySelector('.txt-popup-body');
                    return body && body.textContent.includes('raid battle is full');
                }).catch(() => false);

                if (raidFullAfterRefresh) {
                    this.logger.info('[Raid] Raid is full (detected post-refresh). Dismissing and skipping');
                    await this.controller.page.click('.pop-usual.common-pop-error.pop-show .btn-usual-ok').catch(() => { });
                    await sleep(300);
                    return { duration: 0, turns: 0, raidFull: true };
                }
            }

            if (!this.controller.isAlive()) {
                throw new Error('Battle failed: Page crashed or disconnected');
            }

            // Wait for battle screen to load (look for Auto button in FA, Attack button in SA)
            const loadSelector = mode === 'semi_auto' ? this.selectors.attackButton : '.btn-auto';
            // Optimization: Wait 10s initially as requested by user
            let battleLoaded = await this.controller.waitForElement(loadSelector, 10000);

            if (!battleLoaded) {
                if (!this.controller.isAlive()) {
                    throw new Error('Battle failed: Page crashed during load');
                }
                const currentUrl = this.controller.page.url();

                // Fallback: Check for "Raid is Full" popup (e.g. if it appeared after the 10s wait)
                const isRaidFull = await this.controller.page.evaluate(() => {
                    const popup = document.querySelector('.pop-usual.common-pop-error.pop-show');
                    if (!popup || popup.offsetWidth === 0) return false;
                    const body = popup.querySelector('.txt-popup-body');
                    return body && body.textContent.includes('raid battle is full');
                }).catch(() => false);

                if (isRaidFull) {
                    this.logger.info('[Raid] Raid is full. Dismissing and skipping');
                    await this.controller.page.click('.pop-usual.common-pop-error.pop-show .btn-usual-ok').catch(() => { });
                    await sleep(300);
                    return { duration: 0, turns: 0, raidFull: true };
                }

                // If we are on a raid page but button is missing, check for Salute popup before refreshing
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    const dismissed = await this.dismissSalutePopup();
                    if (dismissed) {
                        this.logger.info('[Battle] Salute popup dismissed. Re-checking for buttons...');
                        await sleep(800);
                        battleLoaded = await this.controller.waitForElement(loadSelector, 10000);
                    }

                    if (!battleLoaded) {
                        this.logger.warn('[Wait] Auto button missing for 10s. Refreshing page...');
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        // Wait another 10s after refresh
                        battleLoaded = await this.controller.waitForElement(loadSelector, 10000);

                        if (!battleLoaded) {
                            this.logger.warn('[Wait] Auto button still missing after refresh. Attempting recovery based on URL check');
                        }
                    }
                } else if (!currentUrl.includes('#result')) {
                    throw new Error(`Battle failed to load. URL: ${currentUrl}`);
                }
            }

            // FA Speed Optimization: Removed the 500-1000ms delay here

            // Proactive Turn Fetch: Capture turn count immediately upon entry
            const initialTurns = await this.getTurnNumber();
            if (initialTurns > 0) {
                this.logger.info(`[Battle] Starting at Turn ${initialTurns}`);
            }

            if (mode === 'full_auto') {
                await this.handleFullAuto();
            } else if (mode === 'semi_auto') {
                await this.handleSemiAuto(false, initialTurns);
            }

            // Wait for battle to complete - return result for stats
            const result = await this.waitForBattleEnd(mode, initialTurns);

            // Calculate battle duration
            this.lastBattleDuration = Date.now() - this.battleStartTime;
            const formattedTime = this.formatTime(this.lastBattleDuration);
            this.logger.info(`[Summary] Duration: ${formattedTime} (${result.turns} turns)`);

            // Calculate final honor difference (total gained during this battle execution)
            // Note: result.honors is the absolute value at end. 
            // We use the baseline captured by the bots or the first turn.
            const totalGained = result.honors - (options.initialHonors || 0);
            if (totalGained > 0) {
                this.logger.info(`[Battle] Final Honor: ${result.honors.toLocaleString()} (+${totalGained.toLocaleString()})`);
            }

            // Attach current honors to result for tracking
            this.lastHonors = result.honors; // Update lastHonors to current total

            // Append duration to result object so bots can verify it
            result.duration = this.lastBattleDuration;

            return result;
        } catch (error) {
            const isNavError = error.message.includes('Execution context was destroyed') ||
                error.message.includes('Target closed') ||
                error.message.includes('Session closed') ||
                this.controller.isNetworkError(error);

            if (isNavError) {
                this.logger.debug('[Battle] Interrupted by browser navigation or stop');
            } else {
                this.logger.error(`[Error] Battle execution failed: ${error.message}`);

                // Safety: If battle failed to load because of a redirect, stop the bot
                if (error.message.includes('Battle failed to load')) {
                    this.logger.warn('[Safety] Battle failed to load. Halting bot for safety');
                    this.stop();
                } else {
                    await this.controller.takeScreenshot('error_battle');
                }
            }
            // Return empty result to avoid breaking stats update loop
            return { duration: 0, turns: 0 };
        } finally {
            // Note: NetworkListener is managed by the shared PageController — do NOT stop it here.
            // It is stopped only when the bot session fully ends via controller.stop().
        }
    }

    async handleFullAuto() {
        const url = this.controller.page.url();
        if (url.includes('#result') || url.includes('#quest/index')) return;

        this.logger.info('[Full Auto] Initializing activation (Skill Rail check)');

        // 1. Press Auto Button (Fast Mode)
        try {
            // User Request: Wait 5s for button, if not found -> Refresh
            const btnFound = await this.controller.waitForElement(this.selectors.fullAutoButton, 5000);

            if (!btnFound) {
                // Check for Salute popup before refreshing
                const dismissed = await this.dismissSalutePopup();
                if (dismissed) {
                    this.logger.info('[Full Auto] Salute popup dismissed. Retrying activation...');
                    return this.handleFullAuto();
                }

                this.logger.warn('[Battle] FA button not found in 5s. Refreshing...');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(800);
                return this.checkStateAndResume('full_auto');
            }

            // User Request: Wait 100-150ms after finding the button before clicking
            await sleep(Math.floor(Math.random() * 51) + 100);

            await this.controller.page.click(this.selectors.fullAutoButton);
            this.logger.debug('[Battle] Fast-clicked Full Auto');
        } catch (e) {
            this.logger.warn(`[Battle] Click failed: ${e.message}`);
            // If click failed (e.g. detached), try refresh
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            await sleep(800);
            return this.checkStateAndResume('full_auto');
        }

        // 1.5 Handle "Waiting for last turn" popup
        // This appears if FA is clicked too quickly while previous turn is processing
        if (await this.controller.elementExists('.pop-usual.common-pop-error.pop-show', 500)) {
            const errorText = await this.controller.getText('.pop-usual.common-pop-error.pop-show .txt-popup-body');
            if (errorText.includes('Waiting for last turn')) {
                this.logger.warn('[Battle] "Waiting for turn" popup detected. Refreshing...');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(800);
                return this.checkStateAndResume('full_auto');
            }
        }

        // 1.6 Handle "Battle Concluded" popup (Race condition on join)
        if (await this.controller.elementExists('.pop-rematch-fail.pop-show', 500)) {
            this.logger.info('[Battle] Battle concluded popup detected. Refreshing...');
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            await sleep(800);
            return this.checkStateAndResume('full_auto');
        }

        // 2. Monitor for Skill Rail Overlayer (Max 12s)
        const checkResult = await this.controller.page.evaluate(async (selectors) => {
            const startTime = Date.now();

            while (Date.now() - startTime < 12000) { // 12s timeout
                // Check Overlayer (Goal: It should NOT have 'hide' class)
                const overlayer = document.querySelector('.prt-ability-rail-overlayer');
                const isOverlayerVisible = overlayer && !overlayer.classList.contains('hide');

                // Check Attack Button (Gone = Bad state if Overlayer not yet seen?)
                // User requirement: "if still in waiting for ability overlayer but attack button is gone -> refresh too"
                const attackBtn = document.querySelector(selectors.attackButton);
                const isAttackGone = !attackBtn || attackBtn.classList.contains('display-off') || attackBtn.offsetHeight === 0;

                // Check for "Battle Concluded" popup immediately
                const failPopup = document.querySelector('.pop-rematch-fail.pop-show'); // or .prt-popup-header containing "Battle Concluded"
                if (failPopup && failPopup.offsetWidth > 0) {
                    return { status: 'battle_ended' };
                }

                if (isOverlayerVisible) {
                    return { status: 'success' };
                }

                if (isAttackGone) {
                    return { status: 'success' };
                }

                await new Promise(r => setTimeout(r, 100));
            }

            return { status: 'timeout' }; // 10s passed with overlayer still hidden
        }, this.selectors);

        // Handle Check Results
        if (checkResult.status === 'battle_ended') {
            this.logger.info('[FA] Battle ended during skill check. Refreshing to finish.');
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            await sleep(800);
            return this.checkStateAndResume('full_auto');
        }

        if (checkResult.status === 'success') {
            this.logger.info('[Full Auto] Activation confirmed. Processing turns...');

            // 3. Wait for Attack Button to disappear (Max 45s)
            // Implementation: Wait for the attack button to definitely be gone
            try {
                await this.controller.page.waitForFunction((sel) => {
                    const btn = document.querySelector(sel);
                    const failPopup = document.querySelector('.pop-rematch-fail.pop-show');
                    if (failPopup && failPopup.offsetWidth > 0) return true; // Exit immediately if battle ended
                    return !btn || btn.classList.contains('display-off') || btn.offsetHeight === 0;
                }, { timeout: 45000 }, this.selectors.attackButton);
                this.logger.info('[Full Auto] Turn processing confirmed');
            } catch (e) {
                this.logger.warn('[Full Auto] Timeout waiting for turn processing (45s)');
                // Optional: Refresh here? Or just let the loop continue? User didn't specify, assuming continue check.
            }
            return;
        }

        // Failure Cases -> Refresh
        if (checkResult.status === 'timeout') {
            this.logger.warn('[Full Auto] Activation timed out (Skill Rail not visible). Refreshing');
        } else {
            this.logger.warn(`[Full Auto] Unexpected status: ${checkResult.status}. Refreshing`);
        }

        // Perform Refresh Verification
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

    async handleSemiAuto(buttonAlreadyVisible = false, currentTurn = null) {
        if (currentTurn !== null) {
            this.lastAttackTurn = currentTurn;
        }

        // Buffer: 50-100ms delay after button found before clicking (as requested)
        await sleep(Math.floor(Math.random() * 51) + 50);

        const selAttack = '.btn-attack-start.display-on'; // Specific selector to avoid dummy elements
        const selCancel = this.selectors.attackCancel;

        // Step 1: Only wait if we don't already know the button is present
        if (!buttonAlreadyVisible) {
            this.logger.debug('[SA] Waiting for attack button');
            const attackReady = await this.controller.page
                .waitForSelector(selAttack, { timeout: 5000 })
                .then(() => true).catch(() => false);
            if (!attackReady) {
                this.logger.warn('[SA] Attack button timeout. Refreshing');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                return;
            }
        }

        // Step 2: Click immediately via direct page.click (zero latency, same as FA)
        try {
            await this.controller.page.click(selAttack);
        } catch (e) {
            this.logger.warn(`[SA] Click failed: ${e.message}. Refreshing`);
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            return;
        }
        this.logger.info('[SA] Attack pressed');

        // Step 2.5: Handle "Battle Concluded" popup
        if (await this.controller.elementExists('.pop-rematch-fail.pop-show', 100)) {
            this.logger.info('[Battle] Battle concluded popup detected. Refreshing...');
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            await sleep(800);
            return;
        }

        // Step 3: Wait for BOTH attack AND cancel buttons to go display-off
        // This confirms the attack is fully submitted before reloading.
        // waitForSelector uses MutationObserver — fires in <1ms, no polling overhead.
        await Promise.all([
            this.controller.page.waitForSelector('.btn-attack-start.display-off', { timeout: 1000 }),
            this.controller.page.waitForSelector(`${selCancel}.display-off`, { timeout: 1000 })
        ]).catch(() => {
            this.logger.debug('[SA] display-off wait timed out (turn may have ended)');
        });

        // Step 4: Refresh to skip animations
        this.logger.info('[SA] Refreshing');
        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(50);
    }

    async waitForBattleEnd(mode, initialTurns = null) {
        const honorTarget = parseInt(this.options?.honorTarget, 10) || 0;
        const maxWaitMinutes = config.get('bot.max_battle_time') || 15;
        const maxWaitMs = maxWaitMinutes * 60 * 1000;
        const startTime = Date.now();
        // checkInterval will be dynamic inside the loop
        let missingUiCount = 0;

        const currentUrl = this.controller.page.url();
        const isRaid = currentUrl.includes('#raid') || currentUrl.includes('_raid');

        // Initial turn detection to avoid duplicate logging
        const initialState = initialTurns !== null ? { turn: initialTurns } : await this.getBattleState();
        let turnCount = initialState.turn;
        let lastTurn = turnCount;
        let lastTurnChangeTime = Date.now();
        let previousHonors = 0; // Initialize previous honors

        this.logger.debug(`[Wait] Resolving turn (Start: ${turnCount})`);
        if (turnCount > 0) {
            // Skip honor check if not a raid or if it's already provided
            let honors = 0;
            if (isRaid) {
                // Batch fetch: Get both turn and honors in one go
                const state = (this.options?.initialHonors > 0)
                    ? { turn: turnCount, honors: this.options.initialHonors }
                    : await this.getBattleState();

                honors = state.honors !== null ? state.honors : (this.lastHonors || 0);
                previousHonors = honors;
                this.logger.info(`[Turn ${turnCount}] ${honors.toLocaleString()} honor`);
            } else {
                this.logger.info(`[Turn ${turnCount}]`);
            }

            if (isRaid && honorTarget > 0 && honors >= honorTarget) {
                this.logger.info(`[Target] Honor goal reached: ${honors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors, honorReached: true };
            }
        }

        // Network Event Promise
        let networkFinished = false;
        const onBattleResult = () => {
            this.logger.info('[Network] Battle end detected');
            networkFinished = true;
        };

        if (this.controller.network) {
            this.controller.network.once('battle:result', onBattleResult);
        }

        try {
            while (Date.now() - startTime < maxWaitMs) {
                if (this.stopped) {
                    this.logger.info('[Wait] Cancelled (Bot stopped)');
                    const duration = (Date.now() - startTime) / 1000;
                    return { duration, turns: Math.max(turnCount, 1) };
                }

                const currentUrl = this.controller.page.url();

                // --- PRIORITY 1: Semi-Auto Detection ---
                if (mode === 'semi_auto' && (currentUrl.includes('#raid') || currentUrl.includes('_raid'))) {
                    // Safety: Only attack if we haven't already attacked this turn
                    if (this.lastAttackTurn < turnCount) {
                        const attReady = await this.controller.page
                            .waitForSelector('.btn-attack-start.display-on', { timeout: 1000 })
                            .then(() => true).catch(() => false);

                        if (attReady) {
                            await this.handleSemiAuto(true, turnCount); // button already confirmed present
                            continue;
                        }
                    }
                }

                if (networkFinished) {
                    // Short sleep to allow UI to update slightly (optional, but good for safety)
                    await sleep(200);
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount + 1, 1), honors: previousHonors };
                }

                // 1. Check turn number (safely)
                const context = { lastTurn, turnCount, previousHonors, isRaid };
                const turnChanged = await this.updateTurnCount(context, honorTarget);
                lastTurn = context.lastTurn;
                turnCount = context.turnCount;
                previousHonors = context.previousHonors || previousHonors;

                if (turnChanged && turnChanged.turnChanged) {
                    lastTurnChangeTime = Date.now();
                    if (turnChanged.honorReached) {
                        return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors, honorReached: true };
                    }
                }

                // Watchdog & Periodic Honor Check
                if (Date.now() - lastTurnChangeTime > 1000) {
                    const isRaid = currentUrl.includes('#raid') || currentUrl.includes('_raid');

                    if (isRaid && honorTarget > 0) {
                        const h = await this.getHonors();
                        if (h >= honorTarget) {
                            this.logger.info(`[Target] Honor goal reached periodically: ${h.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                            return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: h, honorReached: true };
                        }
                    }

                    // Stuck UI Watchdog: Reduced to 4s from 10s
                    const idleTime = Date.now() - lastTurnChangeTime;
                    if (idleTime > 4000) {
                        this.logger.warn(`[Watchdog] UI stuck for ${Math.round(idleTime / 1000)}s. Refreshing`);
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(800);

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                        }

                        lastTurnChangeTime = Date.now(); // Reset
                        continue;
                    }

                    // Original watchdog logic for FA re-activation (if needed after refresh/stuck)
                    if (idleTime > 2000 && isRaid && mode === 'full_auto') {
                        const isFaActive = await this.verifyFullAutoState();
                        if (!isFaActive && !this.stopped) {
                            this.logger.warn('[Watchdog] Full Auto dropped. Re-activating...');
                            await this.handleFullAuto();
                            lastTurnChangeTime = Date.now(); // Reset after re-activation attempt
                        }
                    }
                }

                // 1. Definite End: Result URL or Empty Result Notice
                if (currentUrl.includes('#result')) {
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                }

                // Combined end-condition check (single DOM round-trip instead of 4 sequential IPC calls)
                const endState = await this.controller.page.evaluate((selectors) => {
                    // Check empty result screen
                    if (document.querySelector(selectors.emptyResultNotice)) return 'empty_result';
                    // Check rematch failure popup
                    const rematch = document.querySelector('.img-rematch-fail.popup-1, .img-rematch-fail.popup-2');
                    if (rematch && rematch.offsetWidth > 0) return 'rematch_fail';
                    // Check party wipe: "Salute Participants" cheer popup (party knocked out in raid)
                    const cheerPopup = document.querySelector('.pop-cheer.pop-show');
                    if (cheerPopup && cheerPopup.offsetWidth > 0) return 'wiped';
                    // Check party wipe: btn-cheer / btn-salute visible (fallback)
                    const cheerBtn = document.querySelector('.btn-cheer, .btn-salute');
                    if (cheerBtn && cheerBtn.offsetWidth > 0 && cheerBtn.offsetHeight > 0) return 'wiped';
                    // Check party wipe: "Unable to Continue" header (legacy fallback)
                    const wipePopup = document.querySelector('.prt-popup-header');
                    if (wipePopup && wipePopup.textContent && wipePopup.textContent.includes('Unable to Continue')) return 'wiped';
                    // Check raid ended popup (join race condition)
                    if (document.querySelector(selectors.raidEndedPopup)) return 'raid_ended';
                    return null;
                }, this.selectors).catch(() => null);

                if (endState === 'empty_result') {
                    this.logger.info('[Wait] Empty result screen detected');
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                }
                if (endState === 'rematch_fail') {
                    this.logger.info('[Wait] Rematch failure detected. Refreshing');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(800);
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                }
                if (endState === 'wiped') {
                    this.logger.info('[Raid] Party wiped (Death popup detected)');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(800);
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                }
                if (endState === 'raid_ended') {
                    this.logger.info('[Raid] Battle already ended');
                    await this.controller.clickSafe(this.selectors.raidEndedOkButton);
                    await sleep(1000);
                    return { duration: 0, turns: 0, honors: previousHonors, raidEnded: true };
                }

                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    // Animation Skipping (Full Auto only — SA handles its own reload after each attack)
                    // Added: Check lastReloadTurn to avoid reloading multiple times for the same turn animation skip
                    if (mode !== 'semi_auto' && this.lastReloadTurn < turnCount && await this.controller.elementExists('.btn-attack-start.display-off', 100)) {
                        this.lastReloadTurn = turnCount;
                        this.logger.info('[Battle] Refreshing to skip animations');
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(this.fastRefresh ? 400 : 800);

                        const reloadContext = { lastTurn, turnCount, previousHonors };
                        const reloadResult = await this.updateTurnCount(reloadContext, honorTarget);
                        lastTurn = reloadContext.lastTurn;
                        turnCount = reloadContext.turnCount;
                        previousHonors = reloadContext.previousHonors || previousHonors;

                        if (reloadResult?.honorReached) {
                            return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors, honorReached: true };
                        }

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors, honorReached: reloadResult?.honorReached || false };
                        }
                        continue;
                    }

                    // Stuck detection
                    const uiSelector = '.btn-attack-start.display-on, .btn-usual-cancel, .btn-auto, .btn-cheer, .btn-salute';
                    const uiFound = await this.controller.elementExists(uiSelector, 100);

                    if (uiFound) {
                        missingUiCount = 0;
                    } else {
                        missingUiCount++;
                        if (missingUiCount >= 4) {
                            this.logger.warn('[Watchdog] UI missing (stuck). Refreshing');
                            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                            await sleep(800);

                            const stuckContext = { lastTurn, turnCount, previousHonors };
                            const stuckResult = await this.updateTurnCount(stuckContext, honorTarget);
                            lastTurn = stuckContext.lastTurn;
                            turnCount = stuckContext.turnCount;
                            previousHonors = stuckContext.previousHonors || previousHonors;

                            if (stuckResult?.honorReached) {
                                return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors, honorReached: true };
                            }

                            if (await this.checkStateAndResume(mode)) {
                                return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors, honorReached: stuckResult?.honorReached || false };
                            }
                            missingUiCount = 0;
                        }
                    }
                } else {
                    if (await this.controller.elementExists(this.selectors.okButton, 300) ||
                        await this.controller.elementExists(this.selectors.emptyResultNotice, 100)) {
                        return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                    }
                }

                await sleep(100);
            }
            throw new Error('Battle timeout');
        } finally {
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
            this.logger.error(`[Safety] Session expired or Redirected to landing (${url}). Stopping`);
            this.stop();
            return true; // Stop execution
        }

        if (url.includes('#result') || url.includes('#quest/index')) {
            return true;
        }

        // 2. Check for OK button (completion modal), Empty Result Notice, or Wipe/Cheer popup
        // Optimized: Single evaluate covers all end-state checks without sequential waits
        const endState2 = await this.controller.page.evaluate((selectors) => {
            if (document.querySelector(selectors.okButton)) return 'finished';
            if (document.querySelector(selectors.emptyResultNotice)) return 'finished';
            // Wipe: Salute/Cheer popup (most common wipe state in raids)
            const cheer = document.querySelector('.pop-cheer.pop-show, .btn-cheer, .btn-salute');
            if (cheer && cheer.offsetWidth > 0) return 'wiped';
            // Wipe: rematch fail
            const rematch = document.querySelector('.pop-rematch-fail.pop-show');
            if (rematch && rematch.offsetWidth > 0) return 'wiped';
            // Wipe: elixir prompt
            const elixir = document.querySelector('.pop-use-elixir, .img-elixir');
            if (elixir && elixir.offsetWidth > 0) return 'wiped';
            return null;
        }, this.selectors).catch(() => null);

        if (endState2 === 'wiped') {
            this.logger.info('[Cleared] Party wiped');
            return true;
        }
        if (endState2 === 'finished') {
            this.logger.info('[Battle] Combat concluded');
            return true;
        }

        // 3. Still in battle? Quick wipe pre-check before re-engaging FA to prevent the
        //    'attack gone without Skill Rail' refresh storm when party is dead post-reload
        const found = await this.controller.waitForElement('.btn-attack-start', 200);
        if (found && !this.stopped) {
            // Pre-check: If cheer popup already visible, don't engage FA
            const isAlreadyWiped = await this.controller.page.evaluate(() => {
                const cheer = document.querySelector('.pop-cheer.pop-show, .btn-cheer, .btn-salute');
                return cheer && cheer.offsetWidth > 0;
            }).catch(() => false);

            if (isAlreadyWiped) {
                this.logger.info('[Battle] Party wiped (pre-FA check)');
                return true;
            }

            if (mode === 'full_auto') {
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
            // High-Performance Batch Fetch: Get turn and honors in one IPC call
            const state = await this.getBattleState();
            const currentTurn = state.turn;

            if (currentTurn > context.lastTurn) {
                context.lastTurn = currentTurn;
                context.turnCount = currentTurn;

                // Log transition immediately for snappiness (Quest/Replicard)
                if (!context.isRaid) {
                    this.logger.info(`[Turn ${currentTurn}]`);
                    return { turnChanged: true, honorReached: false, honors: 0 };
                }

                // If Raid, use the pre-fetched honors
                const honors = state.honors !== null ? state.honors : context.previousHonors;
                const diff = (honors > 0 || (context.previousHonors || 0) > 0) ? honors - (context.previousHonors || 0) : null;

                if (diff !== null) {
                    this.logger.info(`[Turn ${currentTurn}] ${honors.toLocaleString()} honor (+${diff.toLocaleString()})`);
                    context.previousHonors = honors;
                    const honorReached = honorTarget > 0 && honors >= honorTarget;
                    if (honorReached) {
                        this.logger.info(`[Target] Honor goal reached: ${honors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                    }
                    return { turnChanged: true, honorReached, honors };
                } else {
                    this.logger.info(`[Turn ${currentTurn}]`);
                    return { turnChanged: true, honorReached: false, honors: 0 };
                }
            }
        } catch (e) {
            // Ignore
        }
        return { turnChanged: false, honorReached: false };
    }

    async getBattleState() {
        try {
            return await this.controller.page.evaluate(() => {
                const state = { turn: 0, honors: null };

                // 1. Get Turn Count
                const container = document.querySelector('.prt-turn-info, #js-turn-num, #js-turn-num-count');
                if (container) {
                    const digits = container.querySelectorAll('div[class*="num-info"]');
                    if (digits && digits.length > 0) {
                        let str = '';
                        for (const d of digits) {
                            const match = d.className.match(/num-info(\d)/);
                            if (match) str += match[1];
                        }
                        state.turn = parseInt(str, 10) || 0;
                    }
                }

                // 2. Get Honors
                const userRow = document.querySelector('.lis-user.guild-member');
                if (userRow) {
                    const pointEl = userRow.querySelector('.txt-point');
                    if (pointEl) {
                        const honorsStr = pointEl.textContent.replace(/,/g, '').replace('pt', '').trim();
                        state.honors = parseInt(honorsStr, 10) || 0;
                    }
                }

                return state;
            });
        } catch (e) {
            return { turn: 0, honors: null };
        }
    }


    async getHonors() {
        const state = await this.getBattleState();
        return state.honors || 0;
    }

    async getTurnNumber() {
        const state = await this.getBattleState();
        return state.turn || 0;
    }

    /**
     * Detects and dismisses the "Salute Participants" (Cheer) popup.
     * Gain DA/TA/HP buff and unblocks the UI.
     */
    async dismissSalutePopup() {
        return await this.controller.page.evaluate(() => {
            const saluteBtn = document.querySelector('.btn-salute, .pop-cheer.pop-show .btn-usual-ok');
            if (saluteBtn && saluteBtn.offsetWidth > 0 && saluteBtn.offsetHeight > 0) {
                saluteBtn.click();
                return true;
            }
            return false;
        }).catch(() => false);
    }
}

export default BattleHandler;
