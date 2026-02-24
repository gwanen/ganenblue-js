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


    async executeBattle(mode = 'full_auto', options = {}) {
        this.stopped = false;
        this.options = options;
        this.battleStartTime = Date.now();
        this.lastAttackTurn = 0;
        this.lastReloadTurn = 0;
        this.logger.info(`[Battle] Engaging combat (${mode})`);

        try {
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#result')) {
                return await this.waitForBattleEnd(mode);
            }

            if (options.refreshOnStart) {
                this.logger.info('[Battle] Refreshing to skip animations');
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(this.fastRefresh ? 200 : 500);

                const earlyStateAfterRefresh = await this.checkEarlyBattleEndPopup();
                if (earlyStateAfterRefresh) {
                    return earlyStateAfterRefresh;
                }
            }

            if (!this.controller.isAlive()) {
                throw new Error('Battle failed: Page crashed or disconnected');
            }

            const loadSelector = mode === 'semi_auto' ? this.selectors.attackButton : '.btn-auto';
            let battleLoaded = await this.controller.waitForElement(loadSelector, 10000);

            if (!battleLoaded) {
                if (!this.controller.isAlive()) {
                    throw new Error('Battle failed: Page crashed during load');
                }
                const currentUrl = this.controller.page.url();

                const earlyStateFallback = await this.checkEarlyBattleEndPopup();
                if (earlyStateFallback) {
                    return earlyStateFallback;
                }

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

            // Proactive Turn Fetch
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
                if (error.message.includes('Battle failed to load')) {
                    this.logger.warn('[Safety] Battle failed to load. Halting bot for safety');
                    this.stop();
                } else {
                    await this.controller.takeScreenshot('error_battle');
                }
            }
            return { duration: 0, turns: 0 };
        } finally {
            // NetworkListener is managed by PageController — stopped only when session ends.
        }
    }

    async handleFullAuto() {
        const url = this.controller.page.url();
        if (url.includes('#result') || url.includes('#quest/index')) return;

        this.logger.info('[Full Auto] Initializing activation');

        // Pre-listen for early attack to prevent race condition (e.g. all skills on cooldown)
        let earlyAttackFired = false;
        const tempAttackListener = () => { earlyAttackFired = true; };
        if (this.controller.network) {
            this.controller.network.once('battle:attack_used', tempAttackListener);
        }

        // 1. Press Auto Button (Fast Mode)
        try {
            // Give DOM a tiny bit of time to settle before checking
            await sleep(500);

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
                await this.checkStateAndResume('full_auto');
                return;
            }

            // User Request: Wait 100-150ms after finding the button before clicking
            // Increased to 250-350ms to prevent click flakiness where the game ignores the click
            // if the event listeners on the button haven't fully attached after a refresh.
            await sleep(Math.floor(Math.random() * 101) + 250);

            await this.controller.page.click(this.selectors.fullAutoButton);
            this.logger.debug('[Battle] Fast-clicked Full Auto');
        } catch (e) {
            this.logger.warn(`[Battle] Click failed: ${e.message}`);
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            await sleep(800);
            await this.checkStateAndResume('full_auto');
            return;
        }

        // 1.5 Handle "Waiting for last turn" popup
        // This appears if FA is clicked too quickly while previous turn is processing
        if (await this.controller.elementExists('.pop-usual.common-pop-error.pop-show', 500)) {
            const errorText = await this.controller.getText('.pop-usual.common-pop-error.pop-show .txt-popup-body');
            if (errorText.includes('Waiting for last turn')) {
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(800);
                await this.checkStateAndResume('full_auto');
                return;
            }
        }

        // 1.6 Handle "Battle Concluded" popup (Race condition on join)
        if (await this.controller.elementExists('.pop-rematch-fail.pop-show', 500)) {
            await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
            await sleep(800);
            await this.checkStateAndResume('full_auto');
            return;
        }

        // 2. Return control immediately so waitForBattleEnd can monitor network & DOM
        if (earlyAttackFired) {
            this.logger.info('[Full Auto] Normal attack fired immediately.');
        }

        if (this.controller.network) {
            this.controller.network.off('battle:attack_used', tempAttackListener);
        }
        // Do NOT return `checkStateAndResume` here. 
        // `handleFullAuto`'s job is just to click the button and wait for the action to submit.
        // The overarching `waitForBattleEnd` loop will handle checking if the battle is over or resuming FA.
    }

    /**
     * Verifies if FA is actually running based on User Logic:
     * 1. Skill Rail Visible (AND not 'hide') -> SUCCESS
     * 2. Attack Button Hidden (display-off) -> SUCCESS (Attacking)
     * 3. Attack Button Visible (display-on) -> FAIL
     */
    async verifyFullAutoState() {
        return await this.controller.page.evaluate((selectors) => {
            // 1. Primary Signal: Auto Button marked as 'pushed'
            const autoBtn = document.querySelector(selectors.fullAutoButton);
            if (autoBtn && autoBtn.classList.contains('pushed')) {
                return true;
            }

            // 2. Secondary Signal: Skill Rail is active (something is being used)
            const skillRail = document.querySelector(selectors.skillRail);
            if (skillRail && skillRail.offsetWidth > 0 && !skillRail.style.display.includes('none')) {
                return true;
            }

            // 3. Fallback: If Attack button is hidden, something is processing
            const attackBtn = document.querySelector(selectors.attackButton);
            if (attackBtn && attackBtn.classList.contains('display-off')) {
                return true;
            }

            return false;
        }, this.selectors).catch(() => false);
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

        // Step 4: Brief pause to allow in-flight network response (normal_attack_result.json)
        // to finish parsing before page context is torn down. Prevents missing cmd:win/lose on one-shots.
        await sleep(100);

        // Step 5: Refresh to skip animations
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
        let lastHonorCheckTime = 0; // Throttle getHonors() to avoid IPC spam
        let lastFACheckTime = Date.now(); // Start timer from now to avoid immediate fire

        const currentUrl = this.controller.page.url();
        const isRaid = currentUrl.includes('#raid') || currentUrl.includes('_raid');

        // Initial turn detection to avoid duplicate logging (used once at start)
        const initialState = initialTurns !== null ? { turn: initialTurns } : await this.getBattleState();
        let turnCount = initialState.turn;
        let lastTurn = turnCount;
        let lastTurnChangeTime = Date.now();
        let previousHonors = (this.options?.initialHonors > 0) ? this.options.initialHonors : (this.lastHonors || 0);
        let isHonorChecking = false; // prevents overlapping honor checks

        this.logger.debug(`[Wait] Resolving turn (Start: ${turnCount})`);

        if (turnCount > 0 && !isRaid) {
            this.logger.info(`[Turn ${turnCount}]`);
        } else if (turnCount > 0 && isRaid) {
            // Initial honor fetched once securely
            const state = await this.getBattleState();
            const honors = state.honors !== null ? state.honors : previousHonors;
            previousHonors = honors;
            this.logger.info(`[Turn ${turnCount}] ${honors.toLocaleString()} honor`);

            if (honorTarget > 0 && honors >= honorTarget) {
                this.logger.info(`[Target] Honor goal reached: ${honors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors, honorReached: true };
            }
        }

        // Network event flags
        let networkFinished = false;
        let bossDied = false;
        let partyWiped = false;
        let attackUsed = false;
        let lastActionTime = Date.now();
        let faInactivityThreshold = 15000; // Initial 15s window

        const onBattleResult = () => { this.logger.info('[Network] Battle end detected'); networkFinished = true; };
        const onBossDied = () => { bossDied = true; };
        const onPartyWiped = () => { partyWiped = true; };
        const onAttack = () => {
            attackUsed = true;
            lastActionTime = Date.now();
            faInactivityThreshold = 15000;
            lastFACheckTime = Date.now(); // Reset FA check timer on action
        };
        const onAbilityOrSummon = () => {
            lastActionTime = Date.now();
            faInactivityThreshold = 12000; // Reset to 12s window after action
            lastFACheckTime = Date.now();  // Reset FA check timer on action
            this.logger.info('[Full Auto] Ability or Summon used. Extending wait timeout (+12s)');
        };

        let networkTurn = turnCount; // Will be updated by battle:start events

        const onBattleStart = ({ turn }) => {
            if (turn > networkTurn) {
                networkTurn = turn;
                lastActionTime = Date.now();
                faInactivityThreshold = 15000; // Reset to 15s window on turn change
            }
        };

        if (this.controller.network) {
            this.controller.network.once('battle:result', onBattleResult);
            this.controller.network.on('battle:boss_died', onBossDied);
            this.controller.network.on('battle:party_wiped', onPartyWiped);
            this.controller.network.on('battle:start', onBattleStart);
            this.controller.network.on('battle:attack_used', onAttack);
            this.controller.network.on('battle:ability_used', onAbilityOrSummon);
            this.controller.network.on('battle:summon_used', onAbilityOrSummon);
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

                // --- PRIORITY 0: Network end-state signals (fastest possible detection) ---
                if (bossDied) {
                    this.logger.info('[Network] Boss death confirmed. Refreshing to result page...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(800);
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                }

                if (partyWiped) {
                    this.logger.info('[Network] Party wipe confirmed. Refreshing...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(800);
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                }

                // 1. Network-Driven Turn Check (Zero DOM overhead)
                if (networkTurn > turnCount) {
                    turnCount = networkTurn;
                    lastTurn = networkTurn;
                    lastTurnChangeTime = Date.now();
                    this.logger.info(`[Turn ${turnCount}]`);
                }

                if (networkFinished) {
                    // Short sleep to allow UI to update slightly (optional, but good for safety)
                    await sleep(200);
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount + 1, 1), honors: previousHonors };
                }

                // 2. Non-blocking Honor Tracker (Raids only)
                if (isRaid && (Date.now() - lastHonorCheckTime > 3000) && !isHonorChecking) {
                    lastHonorCheckTime = Date.now();
                    isHonorChecking = true;

                    // Fire and forget (do not await blocking the loop)
                    this.getHonors().then(currentHonor => {
                        isHonorChecking = false;
                        if (currentHonor > 0 && currentHonor > previousHonors) {
                            const diff = currentHonor - previousHonors;
                            this.logger.info(`[Honor] ${currentHonor.toLocaleString()} (+${diff.toLocaleString()})`);
                            previousHonors = currentHonor;
                        }

                        // Check if we hit the target
                        if (honorTarget > 0 && currentHonor >= honorTarget) {
                            this.logger.info(`[Target] Honor goal reached: ${currentHonor.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                            // Signal a way to break the loop by artificially concluding battle
                            networkFinished = true;
                        }
                    }).catch(() => {
                        isHonorChecking = false;
                    });
                }

                // 3. Definite End: Result URL or Empty Result Notice
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

                    // 1. Network Attack Skip (Priority)
                    if (mode !== 'semi_auto' && this.lastReloadTurn < turnCount && attackUsed) {
                        attackUsed = false;
                        this.lastReloadTurn = turnCount;
                        this.logger.info('[Battle] Normal attack fired. Refreshing page...');
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(this.fastRefresh ? 400 : 800);

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                        }
                        continue;
                    }

                    // 2. DOM Fallback Skip
                    if (mode !== 'semi_auto' && this.lastReloadTurn < turnCount && await this.controller.elementExists('.btn-attack-start.display-off', 100)) {
                        this.lastReloadTurn = turnCount;
                        this.logger.info('[Battle] Refreshing to skip animations');
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(this.fastRefresh ? 400 : 800);

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                        }
                        continue;
                    }

                    // 3. Watchdog Fallback (Dynamic inactivity window during FA)
                    if (mode === 'full_auto' && (Date.now() - lastActionTime > faInactivityThreshold)) {
                        this.logger.warn(`[Full Auto] No activity for ${faInactivityThreshold / 1000}s. Refreshing as fallback...`);
                        lastActionTime = Date.now();
                        faInactivityThreshold = 15000; // Reset threshold after recovery refresh
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(800);

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                        }
                        continue;
                    }

                    // 4. Ongoing FA Persistence Check
                    // High-reliability safety net: ensure FA stays active if logic thinks it should be.
                    // Increased interval to 10s and using verifyFullAutoState to avoid toggling it OFF.
                    if (mode === 'full_auto' && !this.stopped && (Date.now() - lastFACheckTime > 10000)) {
                        lastFACheckTime = Date.now();
                        const isEngaged = await this.verifyFullAutoState();

                        if (!isEngaged) {
                            this.logger.info('[Full Auto] Not active (Attack button still visible). Re-activating...');
                            await this.handleFullAuto();
                        }
                    }

                    // Stuck detection
                    // Only check for UI presence if attack button is not display-off
                    const attackProcessing = await this.controller.page.evaluate((sel) => {
                        const btn = document.querySelector(sel.attackButton);
                        return btn && btn.classList.contains('display-off');
                    }, this.selectors);

                    if (!attackProcessing) {
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

                                if (await this.checkStateAndResume(mode)) {
                                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                                }
                                missingUiCount = 0;
                            }
                        }
                    } else {
                        missingUiCount = 0; // Reset count if attack is currently processing
                    }
                } else {
                    if (await this.controller.elementExists(this.selectors.okButton, 300) ||
                        await this.controller.elementExists(this.selectors.emptyResultNotice, 100)) {
                        return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                    }
                }

                await sleep(200);
            }
            throw new Error('Battle timeout');
        } finally {
            if (this.controller.network) {
                this.controller.network.off('battle:result', onBattleResult);
                this.controller.network.off('battle:boss_died', onBossDied);
                this.controller.network.off('battle:party_wiped', onPartyWiped);
                this.controller.network.off('battle:start', onBattleStart);
                this.controller.network.off('battle:attack_used', onAttack);
                this.controller.network.off('battle:ability_used', onAbilityOrSummon);
                this.controller.network.off('battle:summon_used', onAbilityOrSummon);
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
        this.logger.debug('[Battle] Checking for battle UI to re-engage FA...');
        // Increased timeout to 6s and check for DOM presence (visible: false) to catch fade-in elements
        const found = await this.controller.elementExists('.btn-attack-start, .btn-auto, .btn-usual-cancel', 6000, false);
        this.logger.debug(`[Battle] Battle UI found: ${found}, stopped: ${this.stopped}`);

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
                this.logger.info('[Battle] Re-engaging Full Auto after refresh');
                await this.handleFullAuto();
                return false;
            } else if (mode === 'semi_auto') {
                this.logger.info('[Battle] Re-engaging Semi Auto after refresh');
                await this.handleSemiAuto();
                return false;
            }
        } else {
            this.logger.warn(`[Battle] Could not find attack button after refresh. FA will not re-engage. URL: ${this.controller.page.url()}`);
        }

        // 4. Final safety check after timeout
        const finalUrl = this.controller.page.url();
        if (finalUrl.includes('#result') || finalUrl.includes('#quest/index')) {
            return true;
        }

        return false;
    }

    /**
     * Deprecated: Replaced by fully decoupled network turn / non-blocking DOM honor tracking
     */
    async updateTurnCount(context, honorTarget = 0) {
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
            const saluteBtn = document.querySelector('.btn-cheer, .btn-salute, .pop-cheer.pop-show .btn-usual-ok');
            if (saluteBtn && saluteBtn.offsetWidth > 0 && saluteBtn.offsetHeight > 0) {
                saluteBtn.click();
                return true;
            }
            return false;
        }).catch(() => false);
    }
    /**
     * Checks if the battle cannot be played due to "Raid is full" or "Already ended" popups.
     * Clicks OK and returns early result state if found.
     */
    async checkEarlyBattleEndPopup() {
        const state = await this.controller.page.evaluate(() => {
            // 1. Specific check: GBF's raid-ended popup (pop-result-assist-raid).
            //    The btn-usual-ok in this popup is empty (no dimensions), so we can't
            //    rely on offsetWidth check. Check the container class directly instead.
            const assistRaidPopup = document.querySelector('.pop-result-assist-raid.pop-show');
            if (assistRaidPopup && assistRaidPopup.offsetWidth > 0) {
                const body = assistRaidPopup.querySelector('#popup-body, .txt-popup-body, .prt-popup-body');
                const text = body ? body.textContent.toLowerCase() : '';
                if (text.includes('already ended') || text.includes('home screen will now appear')) return 'ended';
            }

            // 2. Generic check: visible OK button + popup body text
            const okBtn = document.querySelector('.btn-usual-ok');
            if (!okBtn || okBtn.offsetWidth === 0) return null;

            const body = document.querySelector('.txt-popup-body') || document.querySelector('.prt-popup-body');
            if (!body) return null;

            const text = body.textContent.toLowerCase();
            if (text.includes('raid battle is full')) return 'full';
            if (text.includes('already ended') || text.includes('home screen will now appear') || text.includes('pending battles')) return 'ended';
            return null;
        }).catch(() => null);

        if (state) {
            this.logger.info(`[Raid] Raid is ${state}. Dismissing and skipping`);
            await this.controller.page.evaluate(() => {
                const btn = document.querySelector('.pop-result-assist-raid .btn-usual-ok') ||
                    document.querySelector('.btn-usual-ok');
                if (btn) btn.click();
            }).catch(() => { });
            await sleep(800);
            return { duration: 0, turns: 0, raidFull: state === 'full', raidEnded: state === 'ended' };
        }
        return null;
    }
}

export default BattleHandler;
