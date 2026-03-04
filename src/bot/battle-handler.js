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
        this.summonRefresh = options.summonRefresh !== undefined ? options.summonRefresh : true;
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
        this.logger.info(`[Battle] Engaging (${mode})`);

        try {
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#result')) {
                return await this.waitForBattleEnd(mode);
            }

            if (options.refreshOnStart) {
                this.logger.info('[Battle] Refreshing to skip animations');
                await this.controller.reloadPage();
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
            let networkTurnOnLoad = 0;

            // Race start.json network signal vs DOM button.
            // start.json fires early in the page load (before buttons render), giving
            // sub-100ms resolution when starting while already in an active battle.
            const _networkStartHandler = ({ turn }) => { networkTurnOnLoad = turn || 0; };
            const networkReady = new Promise(resolve => {
                if (this.controller.network) {
                    this.controller.network.once('battle:start', (data) => {
                        _networkStartHandler(data);
                        resolve('network');
                    });
                }
            });
            const domReady = this.controller.waitForElement(loadSelector, 10000)
                .then(found => found ? 'dom' : null);

            const loadSource = await Promise.race([networkReady, domReady]);
            let battleLoaded = (loadSource === 'network' || loadSource === 'dom');

            // If DOM won, remove the dangling network listener
            if (loadSource !== 'network' && this.controller.network) {
                this.controller.network.removeListener('battle:start', _networkStartHandler);
            }
            if (loadSource === 'network') {
                this.logger.debug(`[Battle] In-battle confirmed via start.json (turn ${networkTurnOnLoad})`);
            }

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
                        await this.controller.reloadPage();
                        // Wait another 10s after refresh
                        battleLoaded = await this.controller.waitForElement(loadSelector, 10000);

                        if (!battleLoaded) {
                            this.logger.warn('[Wait] Auto button still missing after refresh. Attempting recovery based on URL check');
                        }
                    }
                } else if (!currentUrl.includes('#result')) {
                    // Safety: Check for a lagged confirmation button (OK) before throwing error
                    const okBtn = '.btn-usual-ok';
                    if (await this.controller.elementExists(okBtn, 2000, true)) {
                        this.logger.info('[Battle] Late confirmation button detected. Clicking...');
                        await this.controller.clickSafe(okBtn, { fast: true });
                        await sleep(1000);
                        battleLoaded = await this.controller.waitForElement(loadSelector, 10000);
                    }

                    if (!battleLoaded) {
                        throw new Error(`Battle failed to load. URL: ${currentUrl}`);
                    }
                }
            }

            // Proactive Turn Fetch — skip DOM evaluation if start.json already gave us the turn
            const initialTurns = networkTurnOnLoad > 0 ? networkTurnOnLoad : await this.getTurnNumber();
            if (initialTurns > 0) {
                this.logger.info(`[Battle] Turn ${initialTurns}`);
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
            this.logger.info(`[Summary] ${formattedTime} (${result.turns} turns)`);

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

        this.logger.info('[Full Auto] Activating');

        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;

            // Pre-listen for early attack to prevent race condition
            let earlyAttackFired = false;
            const tempAttackListener = () => { earlyAttackFired = true; };
            if (this.controller.network) {
                this.controller.network.once('battle:attack_used', tempAttackListener);
            }

            const cleanupListener = () => {
                if (this.controller.network) {
                    this.controller.network.off('battle:attack_used', tempAttackListener);
                }
            };

            try {
                // Brief settle
                await sleep(100);

                const btnFound = await this.controller.waitForElement(this.selectors.fullAutoButton, 20000);

                if (!btnFound) {
                    // Check for Salute popup
                    const dismissed = await this.dismissSalutePopup();
                    if (dismissed) {
                        this.logger.info(`[Full Auto] Salute dismissed. Retry ${attempts}/${maxAttempts}`);
                        cleanupListener();
                        continue; // Try again in this while loop
                    }

                    this.logger.warn('[Battle] FA button not found in 20s. Refreshing...');
                    await this.controller.reloadPage();
                    await sleep(800);
                    cleanupListener();
                    await this.checkStateAndResume('full_auto');
                    return;
                }

                // Sharp delay before clicking
                await sleep(100);

                await this.controller.page.click(this.selectors.fullAutoButton);
                this.logger.debug('[Battle] Fast-clicked Full Auto');

                // Handle common post-click popups
                await sleep(500);

                // 1.5 Handle "Waiting for last turn" popup
                if (await this.controller.elementExists('.pop-usual.common-pop-error.pop-show', 200)) {
                    const errorText = await this.controller.getText('.pop-usual.common-pop-error.pop-show .txt-popup-body');
                    if (errorText.includes('Waiting for last turn')) {
                        await this.controller.reloadPage();
                        await sleep(800);
                        cleanupListener();
                        await this.checkStateAndResume('full_auto');
                        return;
                    }
                }

                // 1.6 Handle "Battle Concluded" popup
                if (await this.controller.elementExists('.pop-rematch-fail.pop-show', 200)) {
                    await this.controller.reloadPage();
                    await sleep(800);
                    cleanupListener();
                    await this.checkStateAndResume('full_auto');
                    return;
                }

                if (earlyAttackFired) {
                    this.logger.info('[Full Auto] Attack fired');
                }

                cleanupListener();
                return; // Success, exit method

            } catch (e) {
                this.logger.warn(`[Battle] Click failed: ${e.message}`);
                await this.controller.reloadPage();
                await sleep(800);
                cleanupListener();
                await this.checkStateAndResume('full_auto');
                return;
            }
        }

        this.logger.warn(`[Full Auto] Failed to activate after ${maxAttempts} attempts. Refreshing...`);
        await this.controller.reloadPage();
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
            // 0. Safety: If the page is still in a loading/overlay state, assume FA is active/pending
            const loading = document.querySelector('.prt-loading-container, .prt-popup-back.show, #loading-mask');
            if (loading && loading.offsetHeight > 0) return true;

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

    async handleSemiAuto(buttonAlreadyVisible = false) {
        // High-speed fixed delay
        await sleep(100);

        const selAttack = '.btn-attack-start.display-on'; // Specific selector to avoid dummy elements
        const selCancel = this.selectors.attackCancel;

        // Step 1: Only wait if we don't already know the button is present
        if (!buttonAlreadyVisible) {
            this.logger.debug('[SA] Wait for attack');
            const attackReady = await this.controller.page
                .waitForSelector(selAttack, { timeout: 5000 })
                .then(() => true).catch(() => false);
            if (!attackReady) {
                this.logger.warn('[SA] Timeout. Refreshing');
                await this.controller.reloadPage();
                return;
            }
        }

        // Step 2: Click immediately via direct page.click (zero latency, same as FA)
        try {
            await this.controller.page.click(selAttack);
        } catch (e) {
            this.logger.warn(`[SA] Click failed: ${e.message}. Refreshing`);
            await this.controller.reloadPage();
            return;
        }
        this.logger.info('[SA] Attack');

        // Step 2.5: Handle "Battle Concluded" popup
        if (await this.controller.elementExists('.pop-rematch-fail.pop-show', 100)) {
            this.logger.info('[Battle] Battle concluded popup detected. Refreshing...');
            await this.controller.reloadPage();
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
        await this.controller.reloadPage();
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
        let lastWatchdogCheckTime = 0; // Throttle stuck detection to reduce IPC traffic
        let lastEndStateCheckTime = 0; // Throttle battle-end DOM checks to 1000ms
        let lastSkipCheckTime = 0;     // Throttle animation skip DOM checks to 1000ms
        let lastCheckTurn = 0;         // Used for Turn-Change Priority Refresh

        const currentUrl = this.controller.page.url();
        const isRaid = currentUrl.includes('#raid') || currentUrl.includes('_raid');

        // Initial turn/honor detection consolidated into a single fetch
        const isSemiAuto = mode === 'semi_auto';
        let turnCount = 0;
        let previousHonors = (this.options?.initialHonors > 0) ? this.options.initialHonors : (this.lastHonors || 0);

        if (initialTurns !== null) {
            turnCount = initialTurns;
        } else {
            const state = await this.getBattleState();
            turnCount = state.turn;
            if (isRaid && state.honors !== null) {
                previousHonors = state.honors;
            }
        }

        let lastTurn = turnCount;
        let lastTurnChangeTime = Date.now();
        let isHonorChecking = false;

        this.logger.debug(`[Wait] Resolving turns (Mode: ${mode})`);

        if (turnCount > 0) {
            const honorLog = (isRaid && previousHonors > 0) ? ` ${previousHonors.toLocaleString()} honor` : '';
            this.logger.info(`[Turn ${turnCount}]${honorLog}`);

            if (isRaid && honorTarget > 0 && previousHonors >= honorTarget) {
                this.logger.info(`[Target] Honor goal reached: ${previousHonors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: true };
            }
        }

        // Network event flags
        let networkFinished = false;
        let bossDied = false;
        let partyWiped = false;
        let attackUsed = false;
        let summonUsed = false;
        let lastActionTime = Date.now();
        let faInactivityThreshold = 20000; // Synchronized to 20s initial window

        const onBattleResult = () => { this.logger.info('[Network] Battle end detected'); networkFinished = true; };
        const onBossDied = () => { bossDied = true; };
        const onPartyWiped = () => { partyWiped = true; };
        const onAttack = () => {
            attackUsed = true;
            lastActionTime = Date.now();
            faInactivityThreshold = 20000;
            lastFACheckTime = Date.now(); // Reset FA check timer on action
        };
        const onAbilityOrSummon = () => {
            lastActionTime = Date.now();
            faInactivityThreshold = 7000; // Reset to 7s after ability/fatal-chain
            lastFACheckTime = Date.now();  // Reset FA check timer on action
            this.logger.info('[Ability] Used');
        };
        const onSummonUsed = () => {
            summonUsed = true;
            lastActionTime = Date.now();
            faInactivityThreshold = 7000;
            lastFACheckTime = Date.now();
            this.logger.info('[Summon] Used — queuing page refresh');
        };

        let networkTurn = turnCount; // Will be updated by battle:start events

        const onBattleStart = ({ turn }) => {
            if (turn > networkTurn) {
                networkTurn = turn;
                lastActionTime = Date.now();
                faInactivityThreshold = 20000; // Reset to 20s window on turn change
            }
        };

        if (this.controller.network) {
            this.controller.network.once('battle:result', onBattleResult);
            this.controller.network.on('battle:boss_died', onBossDied);
            this.controller.network.on('battle:party_wiped', onPartyWiped);
            this.controller.network.on('battle:start', onBattleStart);
            this.controller.network.on('battle:attack_used', onAttack);
            this.controller.network.on('battle:ability_used', onAbilityOrSummon);
            this.controller.network.on('battle:summon_used', onSummonUsed);
        }

        try {
            while (Date.now() - startTime < maxWaitMs) {
                // Turn-Change Priority: If turn incremented via network, bypass all throttles for one immediate check
                if (turnCount > lastCheckTurn) {
                    lastCheckTurn = turnCount;
                    lastEndStateCheckTime = 0;
                    lastSkipCheckTime = 0;
                    lastWatchdogCheckTime = 0;
                }
                if (this.stopped) {
                    this.logger.info('[Wait] Cancelled (Bot stopped)');
                    const duration = (Date.now() - startTime) / 1000;
                    return { duration, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1) };
                }

                const currentUrl = this.controller.page.url();

                // --- PRIORITY 1: Semi-Auto Detection ---
                if (isSemiAuto && currentUrl.includes('#raid')) {
                    // Check for attack button using direct evaluate to avoid waitForSelector overhead
                    const attReady = await this.controller.page.evaluate(() => {
                        const btn = document.querySelector('.btn-attack-start.display-on');
                        return !!(btn && btn.offsetWidth > 0);
                    }).catch(() => false);

                    if (attReady) {
                        await this.handleSemiAuto(true);
                        continue;
                    }
                }

                // --- PRIORITY 0: Network end-state signals (fastest) ---
                if (bossDied || partyWiped) {
                    this.logger.info(`[Network] ${bossDied ? 'Boss died' : 'Wiped'}. Hard refreshing`);
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(this.fastRefresh ? 200 : 500);
                    return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                }

                if (networkTurn > turnCount) {
                    turnCount = networkTurn;
                    lastTurnChangeTime = Date.now();
                    this.logger.info(`[Turn ${turnCount}]`);
                }

                if (networkFinished) {
                    await sleep(50);
                    return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount + 1, 1), honors: previousHonors };
                }

                // 2. Non-blocking Honor Tracker
                if (isRaid && (Date.now() - lastHonorCheckTime > 3000) && !isHonorChecking) {
                    lastHonorCheckTime = Date.now();
                    isHonorChecking = true;
                    this.getHonors().then(currentHonor => {
                        isHonorChecking = false;
                        if (currentHonor > 0 && currentHonor > previousHonors) {
                            const diff = currentHonor - previousHonors;
                            this.logger.info(`[Honor] ${currentHonor.toLocaleString()} (+${diff.toLocaleString()})`);
                            previousHonors = currentHonor;
                        }
                        if (honorTarget > 0 && currentHonor >= honorTarget) {
                            this.logger.info(`[Target] Honor goal reached: ${currentHonor.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                            networkFinished = true;
                        }
                    }).catch(() => { isHonorChecking = false; });
                }

                // 3. Combined DOM Checks (End-state + Watchdog)
                // Consolidate multiple throttled DOM checks into a single evaluate to save IPC
                if (currentUrl.includes('#result')) {
                    return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                }

                if (Date.now() - lastEndStateCheckTime > 1000) {
                    lastEndStateCheckTime = Date.now();
                    const state = await this.controller.page.evaluate((sel) => {
                        const results = {};

                        // End states
                        if (document.querySelector(sel.emptyResultNotice)) results.end = 'empty_result';
                        else if (document.querySelector('.img-rematch-fail.popup-1, .img-rematch-fail.popup-2')) results.end = 'rematch_fail';
                        else if (document.querySelector('.pop-cheer.pop-show, .btn-cheer, .btn-salute')) results.end = 'wiped';
                        else if (document.querySelector(sel.raidEndedPopup)) results.end = 'raid_ended';

                        // Watchdog: Check if attack is processing
                        const attBtn = document.querySelector(sel.attackButton);
                        results.isAttacking = !!(attBtn && attBtn.classList.contains('display-off'));

                        // Watchdog: Check if any UI is visible
                        const ui = document.querySelector('.btn-attack-start.display-on, .btn-usual-cancel, .btn-auto, .btn-usual-ok');
                        results.uiVisible = !!(ui && ui.offsetWidth > 0);

                        return results;
                    }, this.selectors).catch(() => ({}));

                    if (state.end) {
                        if (state.end === 'empty_result') return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                        if (state.end === 'raid_ended') {
                            this.logger.info('[Raid] Battle already ended');
                            await this.controller.clickSafe('.btn-usual-ok', { silent: true });
                            return { duration: 0, turns: 0, honors: previousHonors, raidEnded: true };
                        }
                        // Other end states (wiped, rematch_fail) require reload
                        this.logger.info(`[Wait] Battle ended (${state.end}). Hard refreshing`);
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(this.fastRefresh ? 200 : 500);
                        return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                    }

                    // Watchdog Logic
                    if (!state.isAttacking) {
                        if (state.uiVisible) {
                            missingUiCount = 0;
                        } else {
                            missingUiCount++;
                            if (missingUiCount >= 10) { // ~10-20s depending on loop speed
                                this.logger.warn('[Watchdog] UI missing (stuck). Refreshing');
                                await this.controller.reloadPage();
                                await sleep(this.fastRefresh ? 300 : 500);
                                if (await this.checkStateAndResume(mode)) {
                                    return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                                }
                                missingUiCount = 0;
                            }
                        }
                    } else {
                        missingUiCount = 0;
                    }
                }

                if (currentUrl.match(/#(?:raid|raid_multi)(?:\/|$)/)) {
                    // Animation Skipping (Full Auto only — SA handles its own reload after each attack)
                    // Added: Check lastReloadTurn to avoid reloading multiple times for the same turn animation skip

                    // 0.5. Summon Used: Reload immediately to skip summon animation (if enabled)
                    if (mode !== 'semi_auto' && summonUsed) {
                        summonUsed = false;
                        if (this.summonRefresh) {
                            this.logger.info('[Summon] Refreshing page after summon...');
                            await this.controller.reloadPage();
                            await sleep(this.fastRefresh ? 200 : 500);
                            lastFACheckTime = Date.now();

                            if (await this.checkStateAndResume(mode)) {
                                return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                            }
                            continue;
                        }
                    }

                    // 1. Network Attack Skip (Priority)
                    if (mode !== 'semi_auto' && attackUsed) {
                        attackUsed = false;
                        this.lastReloadTurn = turnCount;
                        this.logger.info('[Battle] Normal attack fired. Refreshing page...');
                        await this.controller.reloadPage();
                        await sleep(this.fastRefresh ? 200 : 500);
                        lastFACheckTime = Date.now(); // Reset FA check timer after reload

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                        }
                        continue;
                    }

                    // 2. DOM Fallback Skip: Throttled to 1000ms
                    // FIX: turn gate removed — fallback must work even if turn number hasn't incremented yet
                    if (mode !== 'semi_auto' && Date.now() - lastSkipCheckTime > 1000) {
                        lastSkipCheckTime = Date.now();
                        if (await this.controller.elementExists('.btn-attack-start.display-off', 100)) {
                            this.lastReloadTurn = turnCount;
                            this.logger.info('[Battle] Refreshing to skip animations');
                            await this.controller.reloadPage();
                            await sleep(this.fastRefresh ? 200 : 500);
                            lastFACheckTime = Date.now(); // Reset FA check timer after reload

                            if (await this.checkStateAndResume(mode)) {
                                return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                            }
                            continue;
                        }
                    }

                    // 3. FA Persistence Check — runs BEFORE the inactivity watchdog so its continue never masks this
                    if (mode === 'full_auto' && !this.stopped && (Date.now() - lastFACheckTime > 20000)) {
                        lastFACheckTime = Date.now();
                        const isEngaged = await this.verifyFullAutoState();

                        if (!isEngaged) {
                            this.logger.info('[Full Auto] Re-activating');
                            await this.handleFullAuto();
                        }
                    }

                    // 4. FA Inactivity Watchdog (Dynamic threshold)
                    if (mode === 'full_auto' && (Date.now() - lastActionTime > faInactivityThreshold)) {
                        this.logger.warn('[Full Auto] Inactive. Refreshing');
                        lastActionTime = Date.now();
                        faInactivityThreshold = 20000; // Reset threshold after recovery refresh
                        await this.controller.reloadPage();
                        await sleep(this.fastRefresh ? 300 : 500);
                        lastFACheckTime = Date.now(); // Reset FA check timer after reload

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                        }
                        continue;
                    }
                }

                if (!currentUrl.includes('#raid') && !currentUrl.includes('_raid')) {
                    // Throttled menu checks
                    if (Date.now() - lastSkipCheckTime > 1000) {
                        lastSkipCheckTime = Date.now();
                        if (await this.controller.elementExists(this.selectors.okButton, 300) ||
                            await this.controller.elementExists(this.selectors.emptyResultNotice, 100)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors };
                        }
                    }
                }

                await sleep(50);
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
                this.controller.network.off('battle:summon_used', onSummonUsed);
            }
        }
    }

    async handleResult() {
        // Skips clicking OK as requested.
    }

    /**
     * Standardized state detection after refresh.
     */
    async checkStateAndResume(mode) {
        const url = this.controller.page.url();

        // 1. Check URL and Login Button (Most reliable)
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
        const endState2 = await this.controller.page.evaluate((selectors) => {
            if (document.querySelector(selectors.okButton)) return 'finished';
            if (document.querySelector(selectors.emptyResultNotice)) return 'finished';
            const cheer = document.querySelector('.pop-cheer.pop-show, .btn-cheer, .btn-salute');
            if (cheer && cheer.offsetWidth > 0) return 'wiped';
            const rematch = document.querySelector('.pop-rematch-fail.pop-show');
            if (rematch && rematch.offsetWidth > 0) return 'wiped';
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

        // 3. Still in battle? Quick wipe pre-check before re-engaging FA to prevent reload loops
        this.logger.debug('[Battle] Checking for battle UI to re-engage FA...');
        const found = await this.controller.elementExists('.btn-attack-start, .btn-auto, .btn-usual-cancel', 6000, false);

        if (found && !this.stopped) {
            const isAlreadyWiped = await this.controller.page.evaluate(() => {
                const cheer = document.querySelector('.pop-cheer.pop-show, .btn-cheer, .btn-salute');
                return cheer && cheer.offsetWidth > 0;
            }).catch(() => false);

            if (isAlreadyWiped) {
                this.logger.info('[Battle] Party wiped (pre-FA check)');
                return true;
            }

            if (mode === 'full_auto') {
                this.logger.info('[Battle] Re-engaging Full Auto');
                await this.handleFullAuto();
                return false;
            } else if (mode === 'semi_auto') {
                this.logger.info('[Battle] Re-engaging Semi Auto');
                await this.handleSemiAuto();
                return false;
            }
        }

        const finalUrl = this.controller.page.url();
        if (finalUrl.includes('#result') || finalUrl.includes('#quest/index')) {
            await sleep(50); // SPA navigation buffer
            return true;
        }

        return false;
    }

    async getBattleState() {
        try {
            return await this.controller.page.evaluate(() => {
                const state = { turn: 0, honors: null };
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

    async checkEarlyBattleEndPopup() {
        const popupData = await this.controller.page.evaluate(() => {
            // New: Detect result page directly (sometimes we land here instead of getting a popup)
            const isResultUrl = window.location.href.includes('#result');
            const resultElement = document.querySelector('.prt-result, .cnt-result');
            if (isResultUrl || (resultElement && resultElement.offsetWidth > 0)) {
                return { state: 'ended', text: 'Result page detected' };
            }

            const assistRaidPopup = document.querySelector('.pop-result-assist-raid.pop-show');
            if (assistRaidPopup && assistRaidPopup.offsetWidth > 0) {
                const body = assistRaidPopup.querySelector('#popup-body, .txt-popup-body, .prt-popup-body');
                const rawText = body ? body.textContent.trim() : '';
                const text = rawText.toLowerCase();
                if (text.includes('already ended') ||
                    text.includes('home screen will now appear') ||
                    text.includes('heavy') ||
                    text.includes('currently')) {
                    return { state: 'ended', text: rawText };
                }
            }

            const okBtn = document.querySelector('.btn-usual-ok');
            if (!okBtn || okBtn.offsetWidth === 0) return null;

            const body = document.querySelector('.txt-popup-body') || document.querySelector('.prt-popup-body');
            if (!body) return null;

            const rawText = body.textContent.trim();
            const text = rawText.toLowerCase();

            if (text.includes('raid battle is full')) return { state: 'full', text: rawText };
            if (text.includes('already ended') ||
                text.includes('home screen will now appear') ||
                text.includes('already been defeated') ||
                text.includes('heavy') ||
                text.includes('currently')) return { state: 'ended', text: rawText };
            if (text.includes('pending battles')) {
                return { state: 'pending', text: rawText };
            }
            if (text.includes('three raid battles')) {
                return { state: 'concurrent_limit', text: rawText };
            }

            return null;
        }).catch(() => null);

        if (popupData) {
            this.logger.info(`[Raid] Join error detected: ${popupData.text || popupData.state}`);
            return {
                duration: 0,
                turns: 0,
                raidFull: popupData.state === 'full',
                raidEnded: popupData.state === 'ended',
                raidPending: popupData.state === 'pending',
                raidConcurrentLimit: popupData.state === 'concurrent_limit',
                errorText: popupData.text
            };
        }
        return null;
    }

    async dismissSalutePopup() {
        return await this.controller.page.evaluate(() => {
            const popup = document.querySelector('.pop-salute.pop-show, .pop-cheer.pop-show');
            if (popup && popup.offsetWidth > 0) {
                const btn = popup.querySelector('.btn-usual-ok, .btn-usual-cancel');
                if (btn) {
                    btn.click();
                    return true;
                }
            }
            return false;
        }).catch(() => false);
    }
}

export default BattleHandler;
