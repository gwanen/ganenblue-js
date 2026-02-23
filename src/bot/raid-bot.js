import PageController from '../core/page-controller.js';
import BattleHandler from './battle-handler.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger, { createScopedLogger } from '../utils/logger.js';
import config from '../utils/config.js';
import notifier from '../utils/notifier.js';

class RaidBot {
    constructor(page, options = {}) {
        // Assign profileId and scoped logger FIRST so they're available to PageController
        this.profileId = options.profileId || config.get('profile_id') || 'p1';
        this.logger = createScopedLogger(this.profileId);

        this.controller = new PageController(page, this.logger);
        this.raidBackupUrl = 'https://game.granbluefantasy.jp/#quest/assist';
        this.maxRaids = options.maxRaids || 0; // 0 = unlimited
        this.battleMode = options.battleMode || 'full_auto';
        this.honorTarget = options.honorTarget || 0;
        this.targetUser = options.targetUser || null;
        this.onBattleEnd = options.onBattleEnd || null;
        this.selectors = config.selectors.raid;
        this.battle = new BattleHandler(page, {
            fastRefresh: options.fastRefresh || false,
            logger: this.logger,
            controller: this.controller // Fix #4: Reuse the same PageController (eliminates duplicate NetworkListener)
        });

        // Enable performance optimizations
        if (options.blockResources) {
            this.logger.info('[System] Image blocking: ENABLED');
            this.controller.enableResourceBlocking().catch(e => this.logger.warn('[System] Failed to enable resource blocking', e));
        } else {
            this.logger.info('[System] Image blocking: DISABLED');
        }

        this.raidsCompleted = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.battleTimes = []; // Array to store battle durations
        this.battleTurns = []; // Array to store turn counts
        this.lastEndHonor = 0;  // Honor at end of last raid (used for per-raid diff)
        this.totalHonor = 0;    // Accumulated honor gained this session
    }

    async start() {
        this.isRunning = true;
        this.raidsCompleted = 0;
        this.battleTimes = []; // Reset battle times on start
        this.battleTurns = []; // Reset battle turns on start
        this.lastEndHonor = 0;
        this.totalHonor = 0;
        this.startTime = Date.now();

        this.logger.info('[System] Session started');
        this.logger.info(`[Status] Target: ${this.maxRaids === 0 ? 'Unlimited' : this.maxRaids} raids`);

        // Notify session start
        notifier.notifySessionStart(this.profileId || 'p1', 'raid').catch(e => this.logger.debug('[Notifier] Failed to notify start', e));

        try {
            try {
                while (this.isRunning) {
                    if (this.isPaused) {
                        await sleep(1000);
                        continue;
                    }

                    // Check raid limit
                    if (this.maxRaids > 0 && this.raidsCompleted >= this.maxRaids) {
                        this.logger.info(`[Status] Raid limit reached: ${this.raidsCompleted}/${this.maxRaids}`);
                        break;
                    }

                    const success = await this.runSingleRaid();
                    if (success) {
                        this.raidsCompleted++;
                    }

                    // Short delay between raids
                    await sleep(500);
                }
            } catch (error) {
                // Graceful exit on browser close/disconnect
                if (this.controller.isNetworkError(error) || error.message.includes('Target closed') || error.message.includes('Session closed')) {
                    this.logger.info('[System] Session terminated (Browser closed)');
                } else {
                    this.logger.error('[Error] [Bot] Raid bot error:', error);
                    notifier.notifyError(this.profileId || 'p1', error.message).catch(e => this.logger.debug('[Notifier] Failed to notify error', e));
                    await this.controller.takeScreenshot('error_raid');
                    throw error;
                }
            }
        } finally {
            this.stop();
        }
    }

    async runSingleRaid() {
        this.logger.info(`[Raid] Searching for raids (${this.raidsCompleted + 1})`);

        // Try to find and join a raid
        const joined = await this.findAndJoinRaid();

        if (!joined) {
            this.logger.warn('[Raid] Failed to join raid. Retrying');
            return;
        }

        // Select summon
        const currentUrl = this.controller.page.url();
        const isResult = currentUrl.includes('#result');
        // Check for OK button but EXCLUDE the one from the deck/supporter selection popup
        const okButton = await this.controller.page.evaluate(() => {
            const btn = document.querySelector('.btn-usual-ok');
            if (!btn) return false;
            const isDeckPopup = !!btn.closest('.pop-deck');
            const isErrorPopup = !!btn.closest('.pop-usual') || !!btn.closest('.prt-popup-footer');
            const isVisible = btn.offsetWidth > 0 && btn.offsetHeight > 0;
            return isVisible && !isDeckPopup && !isErrorPopup;
        });

        if (isResult || okButton) {
            this.logger.info('[Raid] Already in result state. Proceeding...');
        } else {
            const summonStatus = await this.selectSummon();

            // Safety: Check for captcha after summon selection
            if (await this.checkCaptcha()) {
                return false;
            }

            if (summonStatus === 'ended') {
                return false;
            }

            if (summonStatus === 'pending') {
                this.logger.info('[System] Pending battles detected. Clearing...');
                await this.clearPendingBattles();
                return false; // Restart cycle
            }
        }

        // Check if bot was stopped before starting battle
        if (!this.isRunning) {
            this.logger.debug('[System] Operation cancelled before combat initiation');
            return;
        }

        // Handle battle
        // Note: initialHonors is NOT read from the summon screen (it has no honor data).
        // Instead, RaidBot tracks lastEndHonor across raids for accurate per-raid diffing.
        const result = await this.battle.executeBattle(this.battleMode, {
            honorTarget: this.honorTarget,
            refreshOnStart: true // User requested refresh after join to skip animations
        });

        if (result?.raidFull) {
            this.logger.info('[Raid] Raid was full. Navigating back to backup page');
            await this.controller.goto(this.raidBackupUrl);
            await sleep(300);
            return false; // Restart cycle to find another raid
        }

        if (result?.raidEnded) {
            return false;
        }

        const honorReached = result?.honorReached || false;
        if (honorReached) {
            this.logger.info(`[Target] Honor goal reached: ${this.honorTarget.toLocaleString()}. Skipping rest of battle`);
        }

        if (result && result.duration > 0) {
            this.updateDetailStats(result);
        }

        if (honorReached) {
            // Immediate navigation back to raid list to ensure we move on
            await this.controller.goto(this.raidBackupUrl);
            await sleep(800);
        } else {
            this.logger.info('[Battle] Combat concluded');
        }

        return true;
    }

    async findAndJoinRaid() {
        this.logger.info('[Raid] Navigating to backup page...');
        await this.controller.goto(this.raidBackupUrl);
        await sleep(100);

        let attempts = 0;
        const maxAttempts = 10;

        while (attempts < maxAttempts && this.isRunning) {
            attempts++;

            // Check for error popup first
            const errorResult = await this.handleErrorPopup();
            if (errorResult.detected) {
                if (errorResult.text.includes('pending battles')) {
                    this.logger.info('[System] Pending battles detected. Clearing...');
                    await this.clearPendingBattles();
                    // After clearing, return to backup page
                    await this.controller.goto(this.raidBackupUrl);
                    await sleep(randomDelay(1500, 2500));
                    continue;
                }

                this.logger.info('[Status] Error popup detected. Returning to assist page...');
                await this.refreshRaidSearch();
                await sleep(randomDelay(1500, 2500));
                continue;
            }

            // Look for raid entries with class "btn-multi-raid lis-raid" (broadened from .search)
            const raidSelector = '.btn-multi-raid.lis-raid';

            // Target User Logic - Use "this.targetUser"
            if (this.targetUser) {
                this.logger.info(`[Raid] Scanning for target: "${this.targetUser}"...`);

                // Find all raid elements and check their host name
                const targetElementHandle = await this.controller.page.evaluateHandle((user, selector) => {
                    // Try to be broad to catch all raid types (search, guild-member, friend, etc)
                    const raids = document.querySelectorAll(selector);
                    const targetName = user.toLowerCase();

                    for (const raid of raids) {
                        const nameEl = raid.querySelector('.txt-request-name');
                        // Also check data-user-id if needed, but name is safer for case-insensitive
                        if (nameEl && nameEl.textContent.trim().toLowerCase().includes(targetName)) {
                            return raid;
                        }
                    }
                    return null;
                }, this.targetUser, raidSelector);

                if (targetElementHandle && targetElementHandle.asElement()) {
                    this.logger.info(`[Raid] Found target user: "${this.targetUser}". Joining...`);
                    try {
                        await targetElementHandle.click();

                        // Optimized: Removed 800ms sleep. Immediately checking for next state.

                        // Using Promise.race to catch the first available state
                        // 1. Summon List (.prt-supporter-list) -> Success
                        // 2. OK Button (.btn-usual-ok) -> Success (Result or Popup)
                        // 3. Error Popup (.pop-raid-error) -> Failure/Retry
                        // 4. Battle Screen (.cnt-raid) -> Success (Direct Join)

                        try {
                            const raceResult = await Promise.race([
                                this.controller.waitForElement('.prt-supporter-list', 3000).then(res => res ? 'summon' : null),
                                this.controller.waitForElement('.btn-usual-ok', 3000).then(res => res ? 'ok_btn' : null),
                                this.controller.waitForElement('#pop-error', 1000).then(res => res ? 'error' : null),
                                this.controller.waitForElement('.cnt-raid', 3000).then(res => res ? 'battle' : null)
                            ]);

                            if (raceResult === 'summon' || raceResult === 'battle') {
                                this.logger.info(`[Raid] Join successful (State: ${raceResult})`);
                                return true;
                            }

                            if (raceResult === 'ok_btn') {
                                const isPopup = await this.controller.page.evaluate(() => {
                                    const btn = document.querySelector('.btn-usual-ok');
                                    return btn && (btn.closest('.prt-popup-footer') || btn.closest('.pop-usual'));
                                });
                                if (!isPopup) {
                                    this.logger.info('[Raid] Join successful (State: ok_btn)');
                                    return true;
                                }
                            }

                            // If race returns null or error, do a more thorough check similar to original logic
                            const clickError = await this.handleErrorPopup();
                            if (clickError.detected) {
                                if (clickError.text === 'max_raids_limit') {
                                    this.logger.warn('[Raid] Concurrent limit reached. Restarting cycle');
                                    return false;
                                }

                                if (clickError.text.includes('pending battles')) {
                                    this.logger.info('[System] Pending battles detected after join. Clearing...');
                                    await this.clearPendingBattles();
                                    await this.controller.goto(this.raidBackupUrl);
                                    // Use small random delay to avoid bot detection on rapid retries
                                    await sleep(randomDelay(500, 1000));
                                    continue;
                                }

                                this.logger.warn(`[Raid] Error popup: ${clickError.text || 'Unknown'}. Refreshing.`);
                                // Continue loop to refresh
                            }

                        } catch (e) {
                            this.logger.debug(`[Raid] Join check error: ${e.message}`);
                        }

                    } catch (error) {
                        this.logger.error('[Error] [Raid] Error clicking target raid:', error);
                    }
                } else {
                    this.logger.info(`[Raid] Target "${this.targetUser}" not found. Re-checking...`);
                    // Wait a bit to avoid spamming checks on the same page state
                    await sleep(800);

                    // Refreshing is necessary for new raids to appear on Assist tab
                    this.logger.debug('[Raid] Refreshing list for target');
                    await this.refreshRaidSearch();
                    await sleep(randomDelay(800, 1200));
                }
            }
            else if (await this.controller.elementExists(raidSelector, 2000)) {
                this.logger.info('[Raid] Raid detected. Joining...');

                try {
                    await this.controller.clickSafe(raidSelector);
                    await sleep(200);

                    // Wait up to 3s for either: summon screen (success) OR any OK popup (error/confirm)
                    // GBF may briefly pass through the assist page before landing on summon — the longer
                    // window handles that redirect without falling through to unknown state.
                    const joinResult = await this.controller.page.waitForSelector(
                        '.prt-supporter-list, .btn-usual-ok',
                        { timeout: 3000 }
                    ).then(el => el).catch(() => null);

                    if (joinResult) {
                        const onSummon = await this.controller.elementExists('.prt-supporter-list', 100);
                        if (onSummon) {
                            this.logger.info('[Raid] Join successful');
                            return true;
                        }

                        // An OK button appeared — determine which one
                        const clickError = await this.handleErrorPopup();
                        if (clickError.detected) {
                            if (clickError.text === 'max_raids_limit') {
                                this.logger.warn('[Raid] Concurrent limit reached. Restarting cycle');
                                return false;
                            }
                            if (clickError.text.includes('pending battles')) {
                                this.logger.info('[System] Pending battles detected after join. Clearing...');
                                await this.clearPendingBattles();
                                await this.controller.goto(this.raidBackupUrl);
                                await sleep(randomDelay(1500, 2500));
                                continue;
                            }
                            // Raid full or ended
                            this.logger.warn('[Raid] Raid was full or unavailable. Refreshing...');
                            await this.refreshRaidSearch();
                            await sleep(randomDelay(800, 1200));
                            continue;
                        }

                        // OK btn present but handleErrorPopup didn't detect a known error — could be summon confirm OK
                        const urlNow = this.controller.page.url();
                        if (urlNow.includes('#raid') || urlNow.includes('_raid') || await this.controller.elementExists('.prt-supporter-list', 200)) {
                            this.logger.info('[Raid] Joined after popup confirmation');
                            return true;
                        }
                    } else {
                        // Also check if we landed directly in battle (no summon screen)
                        const urlNow = this.controller.page.url();
                        if (urlNow.includes('#raid') || urlNow.includes('_raid')) {
                            this.logger.info('[Raid] Join successful (direct battle)');
                            return true;
                        }
                    }

                    // Unknown state, refresh and retry
                    this.logger.warn('[Raid] Unknown state after join attempt. Refreshing...');
                    await this.refreshRaidSearch();
                    await sleep(randomDelay(800, 1200));

                } catch (error) {
                    this.logger.error('[Error] [Raid] Error clicking raid entry:', error);
                    await this.refreshRaidSearch();
                    await sleep(randomDelay(800, 1200));
                }

            } else {
                // No raids available, wait and refresh
                this.logger.info('[Raid] No raids available. Re-checking...');
                await sleep(2000);

                await this.refreshRaidSearch();
                await sleep(randomDelay(800, 1200));
            }
        }

        this.logger.warn(`[Raid] Failed to join raid after ${attempts} attempts`);
        return false;
    }

    async handleErrorPopup() {
        // Priority: GBF's raid-ended popup (pop-result-assist-raid) uses an empty btn-usual-ok
        // with no dimensions, so elementExists with visible:true fails. Check container class instead.
        const assistRaidEnded = await this.controller.page.evaluate(() => {
            const popup = document.querySelector('.pop-result-assist-raid.pop-show');
            if (!popup || popup.offsetWidth === 0) return null;
            const body = popup.querySelector('#popup-body, .txt-popup-body, .prt-popup-body');
            return body ? body.innerText.trim().toLowerCase() : null;
        }).catch(() => null);

        if (assistRaidEnded) {
            this.logger.info(`[Wait] Raid-ended popup detected: ${assistRaidEnded}`);
            // Click OK even if it has no dimensions (use evaluate for reliability)
            await this.controller.page.evaluate(() => {
                const btn = document.querySelector('.pop-result-assist-raid .btn-usual-ok');
                if (btn) btn.click();
            }).catch(() => { });
            await sleep(800); // Wait for redirect to assist page
            return { detected: true, text: assistRaidEnded };
        }

        // Check for generic error popup with class "prt-popup-footer" containing "btn-usual-ok"
        // Use visible: true to avoid clicking phantom/closing popups
        const errorPopupSelector = '.prt-popup-footer .btn-usualok, .prt-popup-footer .btn-usual-ok';
        const bodySelector = '.txt-popup-body';

        if (await this.controller.elementExists(errorPopupSelector, 200, true)) {
            // Get error text
            const errorText = await this.controller.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el && (el.offsetWidth > 0 || el.offsetHeight > 0) ? el.innerText : '';
            }, bodySelector);

            if (!errorText) return { detected: false, text: '' };

            this.logger.info(`[Wait] Error alert detected: ${errorText.trim()}`);

            if (errorText.toLowerCase().includes('three raid battles')) {
                this.logger.warn('[Status] Concurrent raid limit reached (max 3). Waiting...');
                try {
                    await this.controller.clickSafe(errorPopupSelector, { timeout: 2000, maxRetries: 1 });
                } catch (e) { }
                await sleep(10000);
                return { detected: true, text: 'max_raids_limit' };
            }

            try {
                // Use fast timeout and no retries for error cleanup
                await this.controller.clickSafe(errorPopupSelector, { timeout: 2000, maxRetries: 1 });
                await sleep(500);
            } catch (error) {
                this.logger.warn('[Status] Failed to click error popup OK button:', error.message);
            }
            return { detected: true, text: errorText.toLowerCase() };
        }

        return { detected: false, text: '' };
    }

    async clearPendingBattles() {
        const unclaimedUrl = this.selectors.unclaimedRaidUrl || 'https://game.granbluefantasy.jp/#quest/assist/unclaimed/0/0';
        const entrySelector = this.selectors.unclaimedRaidEntry || '.btn-multi-raid.lis-raid';

        this.logger.info('[System] Initializing pending battle clearance...');

        let clearedCount = 0;
        const maxToClear = 10; // safety limit

        while (clearedCount < maxToClear && this.isRunning) {
            await this.controller.goto(unclaimedUrl);
            await sleep(randomDelay(1500, 2500));

            const hasEntries = await this.controller.elementExists(entrySelector, 3000);
            if (!hasEntries) {
                this.logger.info('[Raid] Pending battles cleared');
                break;
            }

            this.logger.info(`[Raid] Clearing unclaimed raid #${clearedCount + 1}`);
            try {
                await this.controller.clickSafe(entrySelector);
                // Wait for either the result page to load or we are redirected
                // We wait for the OK button which usually appears on result screens
                const okButtonSelector = '.btn-usual-ok';
                this.logger.debug('[Wait] Waiting for result page');

                // Wait up to 10 seconds for the OK button to appear
                const foundOk = await this.controller.elementExists(okButtonSelector, 10000);
                if (foundOk) {
                    this.logger.info('[Raid] Result processed');
                    // Optional: tiny delay to ensure state is saved
                    await sleep(500);
                } else {
                    this.logger.warn('[System] OK button timeout. Proceeding...');
                }

                clearedCount++;
            } catch (error) {
                this.logger.error('[Error] Failed to click unclaimed raid:', error);
                break;
            }
        }

        this.logger.info(`[Raid] Finished clearing ${clearedCount} pending battles`);
    }

    async selectSummon() {
        this.logger.info('[Summon] Selecting supporter');

        // Wait for summon screen (Faster check interval)
        let retryCount = 0;
        while (retryCount < 15) { // 3s total
            // Wait for summon list, OK button, error popup, or direct battle join
            const instantBattle = await this.controller.page.evaluate(() => {
                const hash = window.location.hash;
                const att = document.querySelector('.btn-attack-start');
                const isBattleHash = hash.startsWith('#raid') || hash.startsWith('#raid_multi');
                const hasAttackBtn = att && (att.offsetWidth > 0 || att.classList.contains('display-on'));
                return isBattleHash || hasAttackBtn;
            });

            if (instantBattle) {
                this.logger.info('[Status] Transitioned to battle. Skipping summon search');
                return 'success';
            }

            if (await this.controller.elementExists('.prt-supporter-list', 100)) {
                break;
            }

            // Check for OK confirmation popup before giving up on the wait
            if (await this.controller.elementExists('.btn-usual-ok', 50, true)) {
                this.logger.info('[Summon] OK button detected during wait. Breaking loop');
                break;
            }

            retryCount++;
            await sleep(200);
        }

        const okFound = await this.controller.elementExists('.btn-usual-ok', 100, true);
        if (okFound) {
            const error = await this.handleErrorPopup();
            if (error.detected) {
                if (error.text.includes('already ended') || error.text.includes('defeated')) return 'ended';
                if (error.text.includes('pending battles')) return 'pending';
            }

            this.logger.info('[Summon] Clicking start confirmation');
            await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1, fast: true }).catch(() => {
                this.logger.debug('[Wait] Confirmation popup vanished before click');
            });
            await sleep(200);

            // Double check transition
            // Optimization: Instead of an instantaneous check that easily results in a false-negative, call validatePostClick to securely wait for the transition.
            return await this.validatePostClick();
        }

        const summonSelector = '.prt-supporter-detail';
        if (await this.controller.elementExists(summonSelector, 2500, true)) {
            this.logger.info('[Summon] Supporter selected');

            try {
                await this.controller.clickSafe(summonSelector, { timeout: 2000, maxRetries: 1 });
            } catch (error) {
                const currentUrl = this.controller.page.url();
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    this.logger.info('[Status] Transitioned to battle. Ignoring click error');
                    return 'success';
                }
                throw error;
            }

            // Check confirmation after selection
            if (await this.controller.elementExists('.btn-usual-ok', 1500, true)) {
                this.logger.info('[Summon] Clicking start confirmation...');

                // Robust Click Loop
                let clickSuccess = false;
                for (let i = 0; i < 3; i++) {
                    try {
                        await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1, fast: true });
                        clickSuccess = true;
                    } catch (e) { }

                    if (!await this.controller.elementExists('.btn-usual-ok', 200, true)) {
                        clickSuccess = true;
                        break;
                    }
                    await sleep(300);
                }

                if (!clickSuccess) this.logger.warn('[Wait] Failed to click start confirmation properly');
                await sleep(300);
            }

            return await this.validatePostClick();
        }

        // Fallback to configured selectors
        const questSelectors = config.selectors.quest;
        const summonSelectors = [
            questSelectors.summonSlot1,
            questSelectors.summonSlot2,
            questSelectors.summonSlot3
        ];

        for (const selector of summonSelectors) {
            if (await this.controller.elementExists(selector, 1000)) {
                await this.controller.clickSafe(selector);
                this.logger.info('[Summon] Supporter selected (fallback)');
                await sleep(200);

                if (await this.controller.elementExists('.btn-usual-ok', 500, true)) {
                    await this.controller.clickSafe('.btn-usual-ok', { timeout: 2000, maxRetries: 1 }).catch(() => {
                        this.logger.debug('[Summon] Fallback confirmation vanished before click');
                    });
                    await sleep(300);

                    return await this.validatePostClick();
                }
                return 'success';
            }
        }

        return 'success';
    }

    async validatePostClick() {
        // 1. Check for captcha (Highest priority)
        if (await this.checkCaptcha()) return 'captcha';

        // 1.5. Safety: Check if we are stuck on Deck Selection
        if (await this.controller.elementExists('.pop-deck.pop-show', 300, true)) {
            this.logger.warn('[Summon] Stuck on Deck Selection. Clicking OK directly.');
            await this.controller.clickSafe('.pop-deck.pop-show .btn-usual-ok', { silent: true });
            await sleep(800);
        }

        // 2. Detect "Raid already ended" or other errors with proactive polling
        // Optimization: Poll for up to 1.5 seconds (15x100ms) but exit EARLY if URL changes
        for (let i = 0; i < 15; i++) {
            // Check for success transition first
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid') || currentUrl.includes('#result')) {
                return 'success';
            }

            const error = await this.handleErrorPopup();
            if (error.detected) {
                if (error.text.includes('already ended') || error.text.includes('home screen will now appear')) {
                    this.logger.info('[Raid] Raid already ended. Returning to backup page...');
                    return 'ended';
                }
                if (error.text.includes('pending battles')) {
                    return 'pending';
                }
                // Stop polling if we found any error popup
                break;
            }
            await sleep(100);
        }

        // 3. URL/Session Validation
        const isLoggedOut = await this.controller.page.evaluate(() => {
            const url = window.location.href;
            const hasLogin = !!document.querySelector('#login-auth');
            const isHome = url === 'https://game.granbluefantasy.jp/' ||
                url === 'https://game.granbluefantasy.jp/#' ||
                url.includes('#mypage') ||
                url.includes('#top') ||
                url.includes('mobage.jp');
            return hasLogin || isHome;
        });

        if (isLoggedOut) {
            this.logger.error('[Safety] Session expired or Redirected to landing. Stopping');
            this.stop();
            return 'ended';
        }

        const finalUrl = this.controller.page.url();
        if (!finalUrl.includes('#raid') && !finalUrl.includes('_raid') && !finalUrl.includes('#result')) {
            this.logger.warn('[Status] URL did not transition to battle. Potential error');
            return 'ended';
        }

        return 'success';
    }

    async checkCaptcha() {
        const selectors = config.selectors.battle;
        if (await this.controller.elementExists(selectors.captchaPopup, 1000, true)) {
            const headerText = await this.controller.getText(selectors.captchaHeader);
            if (headerText.includes('Access Verification')) {
                this.logger.error('[Safety] Captcha detected. Human intervention required');
                notifier.notifyCaptcha(this.profileId || 'p1').catch(e => this.logger.debug('[Notifier] Failed to notify captcha', e));
                this.stop();
                return true;
            }
        }
        return false;
    }

    pause() {
        this.isPaused = true;
        this.logger.info('[Status] Bot paused');
    }

    resume() {
        this.isPaused = false;
        this.logger.info('[Status] Bot resumed');
    }

    stop() {
        this.isRunning = false;
        if (this.battle) {
            this.battle.stop();
        }
        // Cleanup resources
        this.controller.stop().catch(e => this.logger.warn('[Performance] Failed to stop controller', e));
        this.logger.info('[System] Shutdown requested');

        // Notify session completion
        notifier.notifySessionComplete(this.profileId || 'p1', this.getStats()).catch(e => this.logger.debug('[Notifier] Failed to notify completion', e));
    }

    updateDetailStats(result) {
        if (!result) return;

        // Initialize if not present
        if (!this.totalTurns) this.totalTurns = 0;
        if (!this.battleCount) this.battleCount = 0;

        // Update counts
        this.battleCount++;
        if (result.turns > 0) {
            this.totalTurns += result.turns;
        }

        // Honor tracking: diff against the honor reading at the end of the last raid
        if (result.honors > 0) {
            const gained = result.honors - this.lastEndHonor;
            if (gained > 0) {
                this.totalHonor += gained;
                this.logger.info(`[Summary] Honor gained this raid: +${gained.toLocaleString()} (Session total: ${this.totalHonor.toLocaleString()})`);
            }
            this.lastEndHonor = result.honors; // Always update baseline for next raid
        }

        if (result.duration) {
            const ms = Math.floor(result.duration);
            this.battleTimes.push(ms);
            // Keep only last 50
            if (this.battleTimes.length > 50) this.battleTimes.shift();

            if (result.turns !== undefined) {
                if (!this.battleTurns) this.battleTurns = [];
                this.battleTurns.push(result.turns);
                if (this.battleTurns.length > 50) this.battleTurns.shift();
            }

            // Trigger callback if provided
            if (this.onBattleEnd) this.onBattleEnd(this.getStats());
        }
    }

    getAverageBattleTime() {
        if (this.battleTimes.length === 0) return 0;
        const sum = this.battleTimes.reduce((a, b) => a + b, 0);
        return Math.round(sum / this.battleTimes.length);
    }

    getStats() {
        // Calculate average turns
        let avgTurns = 0;
        if (this.battleCount > 0) {
            avgTurns = (this.totalTurns / this.battleCount).toFixed(1);
        }

        // Calculate Rate
        let rate = '0.0/h';
        const now = Date.now();
        const uptimeHours = (now - this.startTime) / (1000 * 60 * 60);
        if (uptimeHours > 0) {
            const rph = this.raidsCompleted / uptimeHours;
            rate = `${rph.toFixed(1)}/h`;
        }

        return {
            completedQuests: this.raidsCompleted, // Consistent with QuestBot for Notifier
            raidsCompleted: this.raidsCompleted,
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            startTime: this.startTime,
            avgBattleTime: this.getAverageBattleTime(),
            avgTurns: avgTurns,
            battleTimes: this.battleTimes,
            battleTurns: this.battleTurns,
            battleCount: this.battleCount || 0,
            lastBattleTime: this.battleTimes.length > 0 ? this.battleTimes[this.battleTimes.length - 1] : 0,
            rate: rate,
            totalHonor: this.totalHonor || 0
        };
    }

    /**
     * Optimized raid list refresh
     * Tries to use the internal UI refresh button before falling back to full navigation
     */
    async refreshRaidSearch() {
        const currentUrl = this.controller.page.url();
        const isOnAssistPage = currentUrl.includes('#quest/assist');
        const refreshBtn = '.btn-search-refresh';

        if (isOnAssistPage) {
            const hasRefreshBtn = await this.controller.elementExists(refreshBtn, 500, true);
            if (hasRefreshBtn) {
                this.logger.debug('[Raid] On assist page. Clicking UI refresh button...');
                await this.controller.clickSafe(refreshBtn);
                return true;
            }
        }

        this.logger.info('[Raid] Navigating to assist page...');
        await this.controller.goto(this.raidBackupUrl, { waitUntil: 'domcontentloaded' });
        return true;
    }
}

export default RaidBot;
