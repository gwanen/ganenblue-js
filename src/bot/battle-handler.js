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

    /**
     * Clears any pre-registered network event flags that may have been set by
     * stale events (e.g. a previous battle's result.json arriving during
     * navigation to the next quest URL). Call this before executeBattle() when
     * the caller knows the pre-flags are not valid for the upcoming battle.
     */
    resetPreFlags() {
        this._preNetworkFinished = false;
        this._preBossDied = false;
        this._prePartyWiped = false;
        this._preSummonUsed = false;
        this._preNetworkTurn = 0;
        this._preNetworkTurnReady = false;
    }


    async executeBattle(mode = 'full_auto', options = {}) {
        this.stopped = false;
        this.skipRaid = false;
        this.options = options;
        this.battleStartTime = Date.now();
        this.lastAttackTurn = 0;
        this.lastReloadTurn = 0;
        this.lastHonors = 0; // Reset per-raid so previousHonors starts at 0 for each new raid
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
            // Fast Memory Fix: Bind the handler to a variable so removeListener can find it.
            // Using an anonymous arrow function inside once() creates a new reference, 
            // making removeListener fail to clean up if the DOM wins the race.
            let resolveNetwork;
            const onNetworkStart = (data) => {
                if (data && data.turn) {
                    networkTurnOnLoad = data.turn;
                }
                if (resolveNetwork) resolveNetwork('network');
            };

            const networkReady = new Promise(resolve => {
                resolveNetwork = resolve;
                if (this.controller.network) {
                    this.controller.network.once('battle:start', onNetworkStart);
                }
            });
            const domReady = this.controller.waitForElement(loadSelector, 10000)
                .then(found => found ? 'dom' : null);

            const loadSource = await Promise.race([networkReady, domReady]);
            let battleLoaded = (loadSource === 'network' || loadSource === 'dom');

            // If DOM won, remove the dangling network listener effectively
            if (loadSource !== 'network' && this.controller.network) {
                this.controller.network.removeListener('battle:start', onNetworkStart);
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
                        if (this.options.skipOnSalute) {
                            this.logger.info('[Battle] Salute detected. Skipping raid as requested');
                            return { skipRaid: true, duration: 0, turns: 0 };
                        }
                        this.logger.info('[Battle] Salute popup dismissed. Re-checking');
                        await sleep(800);
                        battleLoaded = await this.controller.waitForElement(loadSelector, 10000);
                    }

                    if (!battleLoaded) {
                        this.logger.warn('[Battle] Auto button missing. Refreshing page');
                        await this.controller.reloadPage();
                        // Wait another 10s after refresh
                        battleLoaded = await this.controller.waitForElement(loadSelector, 10000);

                        if (!battleLoaded) {
                            this.logger.warn('[Battle] Auto button still missing. Attempting recovery');
                        }
                    }
                } else if (!currentUrl.includes('#result')) {
                    // Safety: Check for a lagged confirmation button (OK) before throwing error
                    const okBtn = '.btn-usual-ok';
                    if (await this.controller.elementExists(okBtn, 2000, true)) {
                        this.logger.info('[Battle] Late confirmation button detected. Clicking');
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
            this.logger.info('[Battle] Ready');

            // Pre-register battle events BEFORE handleFullAuto so that an instant quick-summon
            // (fired the moment FA activates) isn't missed due to the listener gap between
            // handleFullAuto() returning and waitForBattleEnd() registering its own handlers.
            this._preSummonUsed = false;
            this._preBossDied = false;
            this._prePartyWiped = false;
            this._preNetworkTurn = 0;
            this._preNetworkTurnReady = false;
            this._preNetworkFinished = false;

            const _onPreSummon = () => { this._preSummonUsed = true; };
            const _onPreBoss = () => { this._preBossDied = true; };
            const _onPreWipe = () => { this._prePartyWiped = true; };
            const _onPreStart = ({ turn }) => {
                this._preNetworkTurn = turn;
                this._preNetworkTurnReady = true;
            };
            const _onPreResult = () => { this._preNetworkFinished = true; };

            if (this.controller.network) {
                this.controller.network.on('battle:summon_used', _onPreSummon);
                this.controller.network.on('battle:boss_died', _onPreBoss);
                this.controller.network.on('battle:party_wiped', _onPreWipe);
                this.controller.network.on('battle:start', _onPreStart);
                this.controller.network.once('battle:result', _onPreResult);
            }

            if (mode === 'full_auto') {
                await this.handleFullAuto();
            } else if (mode === 'semi_auto') {
                await this.handleSemiAuto(false, initialTurns);
            }

            // Remove pre-listeners — waitForBattleEnd registers its own
            if (this.controller.network) {
                this.controller.network.off('battle:summon_used', _onPreSummon);
                this.controller.network.off('battle:boss_died', _onPreBoss);
                this.controller.network.off('battle:party_wiped', _onPreWipe);
                this.controller.network.off('battle:start', _onPreStart);
                this.controller.network.off('battle:result', _onPreResult);
            }

            if (this.skipRaid) {
                return { skipRaid: true, duration: 0, turns: 0 };
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
                this.logger.error(`[Battle] Execution failed: ${error.message}`);
                if (error.message.includes('Battle failed to load')) {
                    this.logger.warn('[Safety] Battle failed to load. Halting bot');
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

            try {
                const btnFound = await this.controller.waitForElement(this.selectors.fullAutoButton, 20000);

                if (!btnFound) {
                    // Check for Salute popup
                    const dismissed = await this.dismissSalutePopup();
                    if (dismissed) {
                        if (this.options.skipOnSalute) {
                            this.logger.info('[Full Auto] Salute detected. Skipping raid as requested');
                            this.skipRaid = true;
                            return;
                        }
                        this.logger.info(`[Full Auto] Salute dismissed. Retry ${attempts}/${maxAttempts}`);
                        continue; // Try again in this while loop
                    }

                    this.logger.warn('[Full Auto] Button not found. Refreshing page');
                    await this.controller.reloadPage();
                    await sleep(800);
                    await this.checkStateAndResume('full_auto');
                    return;
                }

                await this.controller.page.click(this.selectors.fullAutoButton);
                this.logger.debug('[Battle] Fast-clicked Full Auto');

                // Handle common post-click popups
                await sleep(100);

                // 1.5 Handle "Waiting for last turn" popup
                if (await this.controller.elementExists('.pop-usual.common-pop-error.pop-show', 200)) {
                    const errorText = await this.controller.getText('.pop-usual.common-pop-error.pop-show .txt-popup-body');
                    if (errorText.includes('Waiting for last turn')) {
                        await this.controller.reloadPage();
                        await sleep(800);
                        await this.checkStateAndResume('full_auto');
                        return;
                    }
                }

                // 1.6 Handle "Battle Concluded" popup
                if (await this.controller.elementExists('.pop-rematch-fail.pop-show', 200)) {
                    await this.controller.reloadPage();
                    await sleep(800);
                    await this.checkStateAndResume('full_auto');
                    return;
                }

                return; // Success, exit method

            } catch (e) {
                this.logger.warn(`[Full Auto] Click failed: ${e.message}`);
                await this.controller.reloadPage();
                await sleep(800);
                await this.checkStateAndResume('full_auto');
                return;
            }
        }

        this.logger.warn(`[Full Auto] Failed after ${maxAttempts} attempts. Refreshing`);
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
        const selAttack = '.btn-attack-start.display-on';
        const selCancel = this.selectors.attackCancel;

        // Step 1: Wait for attack button if not already known visible
        if (!buttonAlreadyVisible) {
            this.logger.debug('[Semi Auto] Waiting for attack button');
            const attackReady = await this.controller.page
                .waitForSelector(selAttack, { timeout: 10000 })
                .then(() => true).catch(() => false);
            if (!attackReady) {
                this.logger.warn('[Semi Auto] Timeout. Refreshing page');
                await this.controller.reloadPage();
                return false;
            }
        }

        // Step 2: Click attack button
        try {
            await this.controller.page.click(selAttack);
        } catch (e) {
            this.logger.warn(`[Semi Auto] Click failed: ${e.message}. Refreshing`);
            await this.controller.reloadPage();
            return false;
        }
        this.logger.info('[Semi Auto] Attack');

        // Step 3: Wait for normal_attack network listener (attack confirmation)
        this.logger.debug('[Semi Auto] Waiting for attack confirmation...');
        const attackConfirmed = await new Promise(resolve => {
            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve(false);
                }
            }, 7000);

            const onAttack = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    this.logger.debug('[Semi Auto] Attack confirmed via network');
                    resolve(true);
                }
            };

            if (this.controller.network) {
                this.controller.network.once('battle:attack_used', onAttack);
            } else {
                clearTimeout(timeout);
                resolve(false);
            }
        });

        if (!attackConfirmed) {
            this.logger.warn('[Semi Auto] Network confirmation timeout. Checking state...');
            // Check if battle ended
            const ended = await this.controller.page.evaluate(() => {
                return !!document.querySelector('.prt-result, #js-result, .pop-cheer, .btn-cheer');
            }).catch(() => false);
            if (ended) {
                this.logger.info('[Semi Auto] Battle ended, skipping attack');
                await sleep(300);
                return false;
            }
            this.logger.warn('[Semi Auto] Refreshing anyway');
        }

        // Step 4: Brief pause for network response parsing
        await sleep(100);
        if (this.stopped) return false;

        // Step 5: Refresh to skip animations
        // Following Full Auto pattern: return immediately after starting reload.
        // The main waitForBattleEnd loop handles turn signals and battle end.
        this.logger.info('[Semi Auto] Refreshing page');
        await this.controller.reloadPage();
        await sleep(50); // Minimal settle
        return attackConfirmed; // Tell caller whether attack was network-confirmed
    }

    async waitForBattleEnd(mode, initialTurns = null) {
        const honorTarget = parseInt(this.options?.honorTarget, 10) || 0;
        this.logger.debug(`[Honor] Target: ${honorTarget.toLocaleString()} (raw: "${this.options?.honorTarget}")`);
        const maxWaitMinutes = config.get('bot.max_battle_time') || 15;
        const maxWaitMs = maxWaitMinutes * 60 * 1000;
        const startTime = Date.now();
        // checkInterval will be dynamic inside the loop
        let missingUiCount = 0;
        let lastFACheckTime = Date.now(); // Start timer from now to avoid immediate fire
        let lastEndStateCheckTime = 0; // Throttle battle-end DOM checks to 1000ms
        let lastCheckTurn = 0;         // Used for Turn-Change Priority Refresh
        let lastSkipCheckTime = 0;    // Throttle non-raid menu checks

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
        let honorTargetReached = false; // Track when honor target is reached

        // In semi_auto, executeBattle.handleSemiAuto already attacked the FIRST turn before entering
        // this loop. Seed lastAttackedTurn with that turn number so that any same-turn battle:start
        // reload (start.json re-firing turn N after reload) doesn't incorrectly re-arm networkTurnReady
        // and cause a double-attack on the same turn.
        let lastAttackedTurn = isSemiAuto ? turnCount : -1;
        this.logger.debug(`[Wait] Resolving turns (Mode: ${mode})`);

        if (!isSemiAuto && turnCount > 0) {
            const honorLog = (isRaid && previousHonors > 0) ? ` ${previousHonors.toLocaleString()} honor` : '';
            this.logger.info(`[Turn ${turnCount}]${honorLog}`);

            if (isRaid && honorTarget > 0 && previousHonors >= honorTarget) {
                this.logger.info(`[Target] Honor goal reached: ${previousHonors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors, honorReached: true };
            }
        }

        // Network event flags
        // Seed from pre-registered flags captured during transitions to catch
        // signals that fired before waitForBattleEnd registered its listeners.
        let networkFinished = this._preNetworkFinished || false;
        let bossDied = this._preBossDied || false;
        let partyWiped = this._prePartyWiped || false;
        let attackUsed = false;
        let summonUsed = this._preSummonUsed || false;

        let networkTurn = this._preNetworkTurn > 0 ? this._preNetworkTurn : turnCount;
        let networkTurnReady = this._preNetworkTurnReady || false;

        // Reset pre-flags immediately after seeding
        this._preSummonUsed = false;
        this._preBossDied = false;
        this._prePartyWiped = false;
        this._preNetworkTurn = 0;
        this._preNetworkTurnReady = false;
        this._preNetworkFinished = false;
        let lastActionTime = Date.now();
        let faInactivityThreshold = 17000; // Synchronized to 7s initial window
        let faReengagementLogged = false; // Track if FA re-engagement has been logged this battle
        let lastHonorCheckTime = 0; // Throttle getHonors() DOM reads to every 3s

        // If turn changed during transition, log it now (full_auto only)
        if (!isSemiAuto && networkTurn > turnCount) {
            this.logger.info(`[Turn ${networkTurn}]`);
            turnCount = networkTurn;
        } else if (isSemiAuto && networkTurn > turnCount) {
            turnCount = networkTurn; // still need turnCount updated for lastAttackedTurn logic
        }
        let lastAttackEventTime = 0; // Track when attack event was received
        let lastAttackRefreshTime = 0; // Track last attack-based refresh

        const updateHonor = async (netHonor) => {
            if (isSemiAuto || !isRaid) return; // Skip honor reads in semi-auto and non-raid modes
            // Priority: Always read the actual current honor from the DOM (screen)
            // Local DOM is much more reliable for the TOTAL current honor.
            const honor = await this.getHonors();

            if (honor !== null && honor > previousHonors) {
                const diff = honor - previousHonors;
                this.logger.info(`[Honor] ${honor.toLocaleString()} (+${diff.toLocaleString()})`);
                previousHonors = honor;

                // Stop early if goal reached
                if (honorTarget > 0 && previousHonors >= honorTarget && !honorTargetReached) {
                    this.logger.info(`[Target] Honor goal reached: ${previousHonors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                    honorTargetReached = true;
                }
            }
        };

        const onBattleResult = () => { networkFinished = true; };
        const onBossDied = ({ honor } = {}) => { updateHonor(honor); bossDied = true; };
        const onPartyWiped = ({ honor } = {}) => { updateHonor(honor); partyWiped = true; };
        const onAttack = ({ honor } = {}) => {
            attackUsed = true;
            lastActionTime = Date.now();
            faInactivityThreshold = 7000;
            lastFACheckTime = Date.now();
            lastAttackEventTime = Date.now();
        };
        const onAbilityOrSummon = ({ honor } = {}) => {
            lastActionTime = Date.now();
            faInactivityThreshold = 7000;
            lastFACheckTime = Date.now();
        };
        const onSummonUsed = ({ honor } = {}) => {
            updateHonor(honor);
            summonUsed = true;
            lastActionTime = Date.now();
            faInactivityThreshold = 7000;
            lastFACheckTime = Date.now();
        };

        const onBattleStart = ({ turn }) => {
            // In semi_auto, after an attack the page reloads and start.json re-fires with the
            // SAME turn number (server hasn't advanced yet). We only want to re-arm networkTurnReady
            // for a same-turn reload if we haven't already attacked that turn (turn > lastAttackedTurn).
            // For a genuine new turn (turn > networkTurn) we always re-arm.
            const isSameTurnReload = isSemiAuto && turn === networkTurn && turn > lastAttackedTurn;
            if (turn > networkTurn || isSameTurnReload) {
                // Log TURN immediately for UI feedback (full_auto only — SA doesn't need it)
                if (!isSemiAuto && turn > turnCount) {
                    this.logger.info(`[Turn ${turn}]`);
                    turnCount = turn; // Update so loop logic doesn't double-log
                } else if (turn > turnCount) {
                    turnCount = turn; // Still update for lastAttackedTurn logic
                }

                networkTurn = turn;
                networkTurnReady = true; // Signal Semi Auto: new turn, attack button should be ready
                lastActionTime = Date.now();
                lastFACheckTime = Date.now();
                faInactivityThreshold = 7000;
                lastAttackEventTime = 0;
                attackUsed = false; // Clear stale attack flag on turn change
                this.logger.debug(`[Network] Turn ${turn} started (timeout reset), networkTurnReady=true`);
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
                // Cache the URL once per tick — page.url() is an IPC call; calling it
                // multiple times in the same 50ms loop iteration wastes CPU.
                const currentUrl = this.controller.page.url();

                // Turn-Change Priority: network turn incremented — bypass throttles for immediate check
                if (turnCount > lastCheckTurn) {
                    lastCheckTurn = turnCount;
                    lastEndStateCheckTime = 0;
                }
                if (this.stopped) {
                    this.logger.info('[Battle] Cancelled (Bot stopped)');
                    const duration = (Date.now() - startTime) / 1000;
                    return { duration, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1) };
                }

                // --- PRIORITY 1: Semi-Auto Detection (network-driven) ---
                // battle:start fires via start.json when a new turn begins — attack button is ready
                if (isSemiAuto && networkTurnReady) {
                    this.logger.debug('[Semi Auto] networkTurnReady detected, attacking...');
                    networkTurnReady = false;
                    const attackedTurnAttempt = networkTurn;
                    const confirmed = await this.handleSemiAuto(true); // Button already confirmed visible by network event
                    // Only lock lastAttackedTurn when attack was network-confirmed.
                    // If click silently failed (button not ready yet), keep lastAttackedTurn as-is
                    // so the same-turn reload re-arms networkTurnReady correctly.
                    if (confirmed) {
                        lastAttackedTurn = attackedTurnAttempt;
                    }
                    continue;
                }

                // --- PRIORITY 0: Network end-state signals (fastest) ---
                if (bossDied || partyWiped) {
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(this.fastRefresh ? 200 : 500);
                    if (isRaid && honorTarget > 0 && !honorTargetReached && previousHonors >= honorTarget) {
                        honorTargetReached = true;
                    }
                    return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: honorTargetReached };
                }

                if (networkFinished) {
                    await sleep(50);
                    if (isRaid && honorTarget > 0 && !honorTargetReached && previousHonors < honorTarget) {
                        const finalHonor = await this.getHonors();
                        if (finalHonor > previousHonors) previousHonors = finalHonor;
                        if (finalHonor >= honorTarget) honorTargetReached = true;
                    }
                    return {
                        duration: (Date.now() - startTime) / 1000,
                        turns: isSemiAuto ? 'N/A' : Math.max(turnCount + 1, 1),
                        honors: previousHonors,
                        honorReached: honorTargetReached
                    };
                }

                // Exit early if honor target reached
                if (honorTargetReached) {
                    return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: true };
                }

                // 3. Result Page Detection (URL-based, network-confirmed)
                if (currentUrl.includes('#result')) {
                    // Wait for network confirmation to avoid race condition with quest navigation
                    // The network event may fire after URL change, so we poll networkFinished flag
                    if (!networkFinished) {
                        this.logger.debug('[Network] Result page detected, awaiting network confirmation...');
                        const waitStart = Date.now();
                        const waitTimeout = 1500;
                        while (!networkFinished && Date.now() - waitStart < waitTimeout) {
                            await sleep(50);
                        }
                        if (networkFinished) {
                            this.logger.debug(`[Network] Result network confirmation received (${Date.now() - waitStart}ms)`);
                        } else {
                            this.logger.debug(`[Network] Result network confirmation timeout (1.5s), proceeding anyway`);
                        }
                    } else {
                        this.logger.debug('[Network] Result page detected, networkFinished already set');
                    }
                    // Final honor check before returning from result page
                    if (isRaid && honorTarget > 0 && !honorTargetReached) {
                        const finalHonor = await this.getHonors();
                        if (finalHonor > previousHonors) previousHonors = finalHonor;
                        if (finalHonor >= honorTarget) honorTargetReached = true;
                    }
                    return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: honorTargetReached };
                }

                // Network-Driven End-State Detection (throttled DOM checks removed)
                // Rely on battle:result network event for primary detection
                // DOM watchdog kept only for stuck battle recovery
                if (Date.now() - lastEndStateCheckTime > 2000) {
                    lastEndStateCheckTime = Date.now();

                    // Watchdog: Check if attack is processing (for stuck detection)
                    const attackState = await this.controller.page.evaluate((sel) => {
                        const attBtn = document.querySelector(sel.attackButton);
                        const isAttacking = !!(attBtn && attBtn.classList.contains('display-off'));

                        // Check if any battle UI is visible (to detect stuck state)
                        const ui = document.querySelector('.btn-attack-start.display-on, .btn-usual-cancel, .btn-auto');
                        const uiVisible = !!(ui && ui.offsetWidth > 0);

                        return { isAttacking, uiVisible };
                    }, this.selectors).catch(() => ({}));

                    // Watchdog Logic: Detect stuck battles (no network activity + no UI)
                    if (!attackState.isAttacking) {
                        if (attackState.uiVisible) {
                            missingUiCount = 0;
                        } else {
                            missingUiCount++;
                            if (missingUiCount >= 10) { // ~10-20s depending on loop speed
                                this.logger.warn('[Battle] UI missing (stuck). Refreshing');
                                await this.controller.reloadPage();
                                await sleep(this.fastRefresh ? 300 : 500);
                                if (await this.checkStateAndResume(mode)) {
                                    return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: honorTargetReached };
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
                            this.logger.info('[Summon] Refreshing page after summon');
                            await this.controller.reloadPage();
                            await sleep(this.fastRefresh ? 200 : 500);
                            lastFACheckTime = Date.now();

                            if (await this.checkStateAndResume(mode)) {
                                return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: honorTargetReached };
                            }
                            continue;
                        }
                    }

                    // 1. Network Attack Skip (Priority)
                    // Honor is read from DOM here — right after the attack is processed server-side —
                    // before the page reload tears down the DOM.
                    if (mode !== 'semi_auto' && attackUsed) {
                        attackUsed = false;

                        // Cooldown: prevent multiple refreshes for same attack (min 2s between attack refreshes)
                        const timeSinceLastRefresh = Date.now() - lastAttackRefreshTime;
                        if (timeSinceLastRefresh < 2000) {
                            continue;
                        }

                        this.logger.info('[Battle] Normal attack fired');

                        // Check honor once: After attack, but BEFORE reload (as requested)
                        if (isRaid) {
                            await updateHonor(null);
                        }

                        // Exit immediately if goal was just reached — no need to reload/re-engage
                        if (honorTargetReached) {
                            return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: true };
                        }

                        await this.controller.reloadPage();
                        await sleep(this.fastRefresh ? 200 : 500);
                        lastAttackRefreshTime = Date.now();
                        lastFACheckTime = Date.now();

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: honorTargetReached };
                        }
                        continue;
                    }

                    // 3. FA Persistence Check — runs BEFORE the inactivity watchdog so its continue never masks this
                    if (mode === 'full_auto' && !this.stopped && (Date.now() - lastFACheckTime > 20000)) {
                        lastFACheckTime = Date.now();
                        const isEngaged = await this.verifyFullAutoState();

                        if (!isEngaged) {
                            if (!faReengagementLogged) {
                                this.logger.info('[Full Auto] Re-activating');
                                faReengagementLogged = true;
                            }
                            await this.handleFullAuto();
                        }
                    }

                    // 4. FA Inactivity Watchdog (Dynamic threshold)
                    if (mode === 'full_auto' && (Date.now() - lastActionTime > faInactivityThreshold)) {
                        this.logger.warn('[Full Auto] Inactive. Refreshing page');
                        lastActionTime = Date.now();
                        faInactivityThreshold = 7000; // Reset threshold after recovery refresh
                        await this.controller.reloadPage();
                        await sleep(this.fastRefresh ? 300 : 500);
                        lastFACheckTime = Date.now(); // Reset FA check timer after reload

                        if (await this.checkStateAndResume(mode)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: honorTargetReached };
                        }
                        continue;
                    }
                }

                if (!currentUrl.includes('#raid') && !currentUrl.includes('_raid')) {
                    // Throttled menu checks (network-primary, DOM fallback for empty result)
                    if (Date.now() - lastSkipCheckTime > 1000) {
                        lastSkipCheckTime = Date.now();
                        if (await this.controller.elementExists(this.selectors.emptyResultNotice, 100)) {
                            // Check honor target before returning
                            if (isRaid && honorTarget > 0 && !honorTargetReached && previousHonors >= honorTarget) {
                                honorTargetReached = true;
                            }
                            return { duration: (Date.now() - startTime) / 1000, turns: isSemiAuto ? 'N/A' : Math.max(turnCount, 1), honors: previousHonors, honorReached: honorTargetReached };
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

        // 2. Check for Empty Result Notice or Wipe/Cheer popup (network is primary, this is fallback)
        const endState2 = await this.controller.page.evaluate((selectors) => {
            if (document.querySelector(selectors.emptyResultNotice)) return 'empty_result';
            const cheer = document.querySelector('.pop-cheer.pop-show, .btn-cheer, .btn-salute');
            if (cheer && cheer.offsetWidth > 0) return 'wiped';
            const rematch = document.querySelector('.pop-rematch-fail.pop-show');
            if (rematch && rematch.offsetWidth > 0) return 'wiped';
            const elixir = document.querySelector('.pop-use-elixir, .img-elixir');
            if (elixir && elixir.offsetWidth > 0) return 'wiped';
            return null;
        }, this.selectors).catch(() => null);

        if (endState2 === 'wiped') {
            this.logger.info('[Battle] Party wiped');
            return true;
        }
        if (endState2 === 'empty_result') {
            this.logger.info('[Battle] Empty result detected');
            return true;
        }

        // 3. Still in battle? Quick pre-check before re-engaging FA to prevent reload loops
        this.logger.debug('[Battle] Checking for battle UI to re-engage FA');

        const foundState = await this.controller.page.waitForFunction(() => {
            const ui = document.querySelector('.btn-attack-start, .btn-auto, .btn-usual-cancel');
            if (ui && ui.offsetWidth > 0) return 'battle';

            const cheer = document.querySelector('.pop-cheer.pop-show, .btn-cheer, .btn-salute');
            if (cheer && cheer.offsetWidth > 0) return 'wiped';

            const ended = document.querySelector('.prt-result, #js-result, .pop-result-assist-raid.pop-show, .pop-usual.pop-show');
            if (ended && ended.offsetWidth > 0) return 'ended';

            if (window.location.hash.includes('#result') || window.location.hash.includes('#quest/index')) return 'ended';

            return null;
        }, { timeout: 6000 }).then(res => res.jsonValue()).catch(() => null);

        if (foundState === 'wiped') {
            this.logger.info('[Battle] Party wiped');
            return true;
        }

        if (foundState === 'ended') {
            // Found a terminal state, don't wait further
            return true;
        }

        const found = foundState === 'battle';

        if (found && !this.stopped) {

            if (mode === 'full_auto') {
                // Wait briefly for start.json so [Turn X] is logged before [Full Auto] Activating
                if (this.controller.network) {
                    await new Promise(resolve => {
                        const t = setTimeout(resolve, 500); // max 500ms wait
                        this.controller.network.once('battle:start', () => {
                            clearTimeout(t);
                            resolve();
                        });
                    });
                }
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

    /**
     * Check for early battle end popups (raid full, ended, pending, etc.)
     * @param {boolean} questMode - If true, skip result page element checks (may be stale from previous battle)
     */
    async checkEarlyBattleEndPopup(questMode = false) {
        const popupData = await this.controller.page.evaluate((skipResultElement) => {
            // Skip result page check in quest mode - elements may be stale from previous battle
            if (!skipResultElement) {
                const isResultUrl = window.location.href.includes('#result');
                const resultElement = document.querySelector('.prt-result, .cnt-result');
                if (isResultUrl || (resultElement && resultElement.offsetWidth > 0)) {
                    return { state: 'ended', text: 'Result page detected' };
                }
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
        }, questMode).catch(() => null);

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
