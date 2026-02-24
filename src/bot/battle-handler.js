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

            let earlyWipe = false;

            // Register network listeners BEFORE handleFullAuto so wipe/attack events
            // fired during FA's waitForFunction block are not missed.
            const networkFlags = {
                bossDied: false,
                partyWiped: false,
                attackResultReceived: false,
                networkTurn: initialTurns || 0,
                networkFinished: false,
                lastActivityTime: Date.now(), // Reset on every battle:start (ability/attack results)
            };
            const _onBossDied = () => { networkFlags.bossDied = true; };
            const _onPartyWiped = () => { networkFlags.partyWiped = true; };
            const _onAttackResult = () => { networkFlags.attackResultReceived = true; };
            const _onBattleResult = () => { networkFlags.networkFinished = true; };
            const _onBattleStart = ({ turn }) => {
                networkFlags.lastActivityTime = Date.now(); // Any network activity resets idle timer
                if (turn > networkFlags.networkTurn) networkFlags.networkTurn = turn;
            };
            if (this.controller.network) {
                this.controller.network.on('battle:boss_died', _onBossDied);
                this.controller.network.on('battle:party_wiped', _onPartyWiped);
                this.controller.network.on('battle:attack_result', _onAttackResult);
                this.controller.network.once('battle:result', _onBattleResult);
                this.controller.network.on('battle:start', _onBattleStart);
            }

            if (mode === 'full_auto') {
                const faResult = await this.handleFullAuto(networkFlags);
                if (faResult === 'wiped' || faResult === 'not_in_battle') earlyWipe = true;
            } else if (mode === 'semi_auto') {
                await this.handleSemiAuto(false, initialTurns);
            }

            // Wait for battle to complete - return result for stats
            let result;
            if (earlyWipe) {
                this.logger.info('[Raid] Party wiped (Death popup detected during Full Auto start)');
                // Clean up listeners before early exit
                if (this.controller.network) {
                    this.controller.network.off('battle:boss_died', _onBossDied);
                    this.controller.network.off('battle:party_wiped', _onPartyWiped);
                    this.controller.network.off('battle:attack_result', _onAttackResult);
                    this.controller.network.off('battle:result', _onBattleResult);
                    this.controller.network.off('battle:start', _onBattleStart);
                }
                await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                await sleep(800);
                result = { duration: (Date.now() - this.battleStartTime) / 1000, turns: Math.max(initialTurns, 1), honors: this.lastHonors || 0 };
            } else {
                result = await this.waitForBattleEnd(mode, initialTurns, networkFlags, {
                    _onBossDied, _onPartyWiped, _onAttackResult, _onBattleResult, _onBattleStart
                });
            }

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
            // Ensure listeners are always cleaned up on unexpected errors
            if (this.controller.network) {
                this.controller.network.off('battle:boss_died', _onBossDied);
                this.controller.network.off('battle:party_wiped', _onPartyWiped);
                this.controller.network.off('battle:attack_result', _onAttackResult);
                this.controller.network.off('battle:result', _onBattleResult);
                this.controller.network.off('battle:start', _onBattleStart);
            }

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

    async handleFullAuto(networkFlags = null) {
        const url = this.controller.page.url();
        if (url.includes('#result') || url.includes('#quest/index')) return;

        this.logger.info('[Full Auto] Engaging...');

        // 1. Press Auto Button (Fast Mode)
        try {
            // User Request: Wait 5s for button, if not found -> Refresh
            const btnFound = await this.controller.waitForElement(this.selectors.fullAutoButton, 5000);

            if (!btnFound) {
                // Check for Salute popup before refreshing
                const dismissed = await this.dismissSalutePopup();
                if (dismissed) {
                    this.logger.info('[Full Auto] Party wiped (Salute popup detected). Aborting activation.');
                    return 'wiped';
                }

                const currentUrl = this.controller.page.url();
                const isOnRaid = currentUrl.includes('#raid') || currentUrl.includes('_raid');

                if (isOnRaid) {
                    // Check if a supporter/summon confirmation overlay is present.
                    // On a genuine supporter screen: BOTH the FA button AND attack button are absent.
                    // Generic in-battle popups (level-up, notifications) also have .btn-usual-ok
                    // but the attack button is still present on the page — those are NOT supporter screens.
                    const supporterOkFound = await this.controller.elementExists('.btn-usual-ok', 300);
                    if (supporterOkFound) {
                        const attackPresent = await this.controller.elementExists(this.selectors.attackButton, 100);
                        if (!attackPresent) {
                            this.logger.info('[Battle] Supporter confirm dialog detected. Clicking OK...');
                            await this.controller.clickSafe('.btn-usual-ok');
                            await sleep(800);

                            // If clicking OK navigated away from the raid, it was an error popup
                            // (e.g. "Battle is full. You can't participate.") not a supporter confirm.
                            const urlAfterOk = this.controller.page.url();
                            const stillOnRaid = urlAfterOk.includes('#raid') || urlAfterOk.includes('_raid');
                            if (!stillOnRaid) {
                                this.logger.info('[Battle] OK dismissed an error popup (navigated away from raid). Aborting.');
                                return 'not_in_battle';
                            }

                            return; // Still on raid — was a real supporter confirm, let FA re-engage
                        }
                        // Attack button still present = in-battle popup, not supporter screen. Skip.
                        this.logger.debug('[Battle] Generic OK popup (not supporter — attack button still present). Ignoring.');
                    }

                    this.logger.warn('[Battle] FA button not found in 5s (on raid page). Refreshing...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(800);
                    return this.checkStateAndResume('full_auto');
                } else {
                    // Not on a raid page — likely stuck on assist/quest screen.
                    this.logger.warn(`[Battle] FA button not found and not on raid page (URL: ${currentUrl}). Aborting.`);
                    return 'not_in_battle';
                }
            }

            // Wait 150–250ms after button appears before clicking.
            // GBF's JS may attach event listeners slightly after the button is visible in DOM.
            await sleep(Math.floor(Math.random() * 101) + 150);

            await this.controller.page.click(this.selectors.fullAutoButton);
            // Anchor the activity stall timer to the FA click moment.
            // start.json fires on page load which would give a shorter window if the button
            // took a few seconds to appear. This ensures the full 12s stall window from click.
            if (networkFlags) networkFlags.lastActivityTime = Date.now();
            this.logger.debug('[Battle] Fast-clicked Full Auto');
            // Note: skill rail can take 12-14s to appear during lockout — not a reliable
            // verification signal. The 12s activity stall in waitForBattleEnd handles
            // genuine FA failures via network silence.
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

        // FA is clicked. Control returns to waitForBattleEnd which drives everything via
        // the activity-based stall timer (lastActivityTime) and network events.
        this.logger.info('[Full Auto] FA activated. Monitoring via network...');
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

    async waitForBattleEnd(mode, initialTurns = null, networkFlags = null, listeners = null) {
        const honorTarget = parseInt(this.options?.honorTarget, 10) || 0;
        const maxWaitMinutes = config.get('bot.max_battle_time') || 15;
        const maxWaitMs = maxWaitMinutes * 60 * 1000;
        const startTime = Date.now();
        this.lastReloadTurn = 0; // Reset per-battle: prevents stale state from previous battle blocking turn-1 animation skip

        // checkInterval will be dynamic inside the loop
        let missingUiCount = 0;
        let lastHonorCheckTime = 0;  // Throttle getHonors() to avoid IPC spam
        let lastEndStateCheck = 0;   // Throttle DOM endState evaluate (network handles fast path)

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

        // Use pre-built flags if provided (registered before handleFullAuto to avoid missing early events)
        // otherwise create fresh ones for standalone calls
        let flags = networkFlags || {
            bossDied: false, partyWiped: false,
            attackResultReceived: false, networkTurn: turnCount, networkFinished: false,
            lastActivityTime: Date.now(),
        };
        // Sync networkTurn with current turnCount baseline if not pre-built
        if (!networkFlags) flags.networkTurn = turnCount;

        // Unpack for local variable access (kept by reference so mutations propagate)
        let onBattleResult, onBossDied, onPartyWiped, onAttackResult, onBattleStart;
        if (listeners) {
            // Re-use pre-registered handlers passed from executeBattle
            ({
                _onBossDied: onBossDied, _onPartyWiped: onPartyWiped,
                _onAttackResult: onAttackResult, _onBattleResult: onBattleResult, _onBattleStart: onBattleStart
            } = listeners);
        } else {
            // Fresh setup for standalone waitForBattleEnd calls
            onBattleResult = () => { this.logger.info('[Network] Battle end detected'); flags.networkFinished = true; };
            onBossDied = () => { flags.bossDied = true; };
            onPartyWiped = () => { flags.partyWiped = true; };
            onAttackResult = () => { flags.attackResultReceived = true; };
            onBattleStart = ({ turn }) => {
                flags.lastActivityTime = Date.now();
                if (turn > flags.networkTurn) flags.networkTurn = turn;
            };

            if (this.controller.network) {
                this.controller.network.once('battle:result', onBattleResult);
                this.controller.network.on('battle:boss_died', onBossDied);
                this.controller.network.on('battle:party_wiped', onPartyWiped);
                this.controller.network.on('battle:attack_result', onAttackResult);
                this.controller.network.on('battle:start', onBattleStart);
            }
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
                if (flags.bossDied) {
                    this.logger.info('[Network] Boss death confirmed. Refreshing to result page...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(800);
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                }

                if (flags.partyWiped) {
                    this.logger.info('[Network] Party wipe confirmed. Refreshing...');
                    await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                    await sleep(800);
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                }

                // Sync turn from network if ahead of DOM count
                if (flags.networkTurn > turnCount) {
                    const honors = isRaid ? await this.getHonors() : 0;
                    const diff = honors - previousHonors;
                    if (isRaid) {
                        this.logger.info(`[Turn ${flags.networkTurn}] ${honors.toLocaleString()} honor${diff > 0 ? ` (+${diff.toLocaleString()})` : ''}`);
                        previousHonors = honors;
                        if (honorTarget > 0 && honors >= honorTarget) {
                            this.logger.info(`[Target] Honor goal reached: ${honors.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                            return { duration: (Date.now() - startTime) / 1000, turns: Math.max(flags.networkTurn, 1), honors, honorReached: true };
                        }
                    } else {
                        this.logger.info(`[Turn ${flags.networkTurn}]`);
                    }
                    lastTurn = flags.networkTurn;
                    turnCount = flags.networkTurn;
                    lastTurnChangeTime = Date.now();
                }

                if (flags.networkFinished) {
                    // Short sleep to allow UI to update slightly (optional, but good for safety)
                    await sleep(200);
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount + 1, 1), honors: previousHonors };
                }

                // 1. Check turn number (safely)
                const context = { lastTurn, turnCount, previousHonors, isRaid };
                const turnChanged = (flags.networkTurn === turnCount) ? await this.updateTurnCount(context, honorTarget) : null;
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
                    const stillOnRaid = currentUrl.includes('#raid') || currentUrl.includes('_raid');

                    if (stillOnRaid && honorTarget > 0) {
                        const now = Date.now();
                        if (now - lastHonorCheckTime > 3000) { // Throttle: max once per 3s
                            lastHonorCheckTime = now;
                            const h = await this.getHonors();
                            if (h >= honorTarget) {
                                this.logger.info(`[Target] Honor goal reached periodically: ${h.toLocaleString()} / ${honorTarget.toLocaleString()}`);
                                return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: h, honorReached: true };
                            }
                        }
                    }

                    // FA activity-based stall detection:
                    // If no battle:start event fired for 12s (no ability/attack results),
                    // FA has stalled. Refresh and re-engage.
                    const faIdleMs = Date.now() - (flags.lastActivityTime ?? startTime);
                    if (faIdleMs > 12000 && stillOnRaid && mode === 'full_auto' && !this.stopped) {
                        this.logger.warn(`[Battle] FA idle for ${Math.round(faIdleMs / 1000)}s (no network activity). Refreshing...`);
                        await this.controller.page.reload({ waitUntil: 'domcontentloaded' });
                        await sleep(this.fastRefresh ? 200 : 500);
                        flags.lastActivityTime = Date.now(); // reset before re-engaging
                        await this.handleFullAuto(flags);
                    }
                }

                // 1. Definite End: Result URL or Empty Result Notice
                if (currentUrl.includes('#result')) {
                    return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors };
                }

                // Combined end-condition DOM check — throttled to 1s since network events
                // already handle the fast path (boss death, party wipe). DOM fallback is only
                // needed for rare states: rematch_fail, empty_result, raid_ended.
                const now = Date.now();
                let endState = null;
                if (now - lastEndStateCheck >= 1000) {
                    lastEndStateCheck = now;
                    endState = await this.controller.page.evaluate((selectors) => {
                        // Check empty result screen
                        if (document.querySelector(selectors.emptyResultNotice)) return 'empty_result';
                        // Check rematch failure popup
                        const rematch = document.querySelector('.img-rematch-fail.popup-1, .img-rematch-fail.popup-2');
                        if (rematch && rematch.offsetWidth > 0) return 'rematch_fail';
                        // Check party wipe DOM fallback (in case network missed cmd:lose)
                        const cheerBtn = document.querySelector('.pop-cheer.pop-show, .btn-cheer, .btn-salute');
                        if (cheerBtn && cheerBtn.offsetWidth > 0) return 'wiped';
                        // Check raid ended popup (join race condition)
                        if (document.querySelector(selectors.raidEndedPopup)) return 'raid_ended';
                        return null;
                    }, this.selectors).catch(() => null);
                }

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
                    // PRIMARY trigger: network event battle:attack_result (normal_attack_result.json fully parsed)
                    // SECONDARY hint: attack button going display-off confirms an attack is in progress
                    // Both conditions must be met to avoid refreshing during death/win animations
                    if (!flags.partyWiped && !flags.bossDied && mode !== 'semi_auto' && this.lastReloadTurn < turnCount && flags.attackResultReceived) {
                        flags.attackResultReceived = false; // Reset for next turn
                        this.lastReloadTurn = turnCount;

                        this.logger.info('[Battle] Refreshing to skip animations (attack result received)');
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

                        if (await this.checkStateAndResume(mode, flags)) {
                            return { duration: (Date.now() - startTime) / 1000, turns: Math.max(turnCount, 1), honors: previousHonors, honorReached: reloadResult?.honorReached || false };
                        }
                        continue;
                    }

                    // Stuck detection: 0ms timeout — just check presence, don't block the tick
                    // Includes .btn-usual-ok to prevent false-positive stuck detection
                    // when a supporter/summon confirm dialog is open on a raid URL.
                    const uiSelector = '.btn-attack-start.display-on, .btn-usual-cancel, .btn-auto, .btn-cheer, .btn-salute, .btn-usual-ok';
                    const uiFound = await this.controller.elementExists(uiSelector, 0);

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

                            if (await this.checkStateAndResume(mode, flags)) {
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

                await sleep(200);
            }
            throw new Error('Battle timeout');
        } finally {
            if (this.controller.network) {
                this.controller.network.off('battle:result', onBattleResult);
                this.controller.network.off('battle:boss_died', onBossDied);
                this.controller.network.off('battle:party_wiped', onPartyWiped);
                this.controller.network.off('battle:attack_result', onAttackResult);
                this.controller.network.off('battle:start', onBattleStart);
            }
        }
    }


    /**
     * Standardized state detection after refresh.
     * Checks URL first, then completion modal, then battle UI.
     * Returns true if battle is finished.
     */
    async checkStateAndResume(mode, flags = null) {
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
                const faResult = await this.handleFullAuto(flags);
                if (faResult === 'wiped' || faResult === 'not_in_battle') return true;
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
