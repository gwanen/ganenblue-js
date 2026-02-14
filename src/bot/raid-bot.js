import PageController from '../core/page-controller.js';
import BattleHandler from './battle-handler.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';

class RaidBot {
    constructor(page, options = {}) {
        this.controller = new PageController(page);
        this.raidBackupUrl = 'https://game.granbluefantasy.jp/#quest/assist';
        this.maxRaids = options.maxRaids || 0; // 0 = unlimited
        this.battleMode = options.battleMode || 'full_auto';
        this.honorTarget = options.honorTarget || 0;
        this.onBattleEnd = options.onBattleEnd || null;
        this.selectors = config.selectors.raid;
        this.battle = new BattleHandler(page);

        // Enable performance optimizations
        if (options.blockResources) {
            logger.info('[Performance] Image blocking: ENABLED');
            this.controller.enableResourceBlocking().catch(e => logger.warn('[Performance] Failed to enable resource blocking', e));
        } else {
            logger.info('[Performance] Image blocking: DISABLED');
        }

        this.raidsCompleted = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.battleTimes = []; // Array to store battle durations
        this.battleTurns = []; // Array to store turn counts
    }

    async start() {
        this.isRunning = true;
        this.raidsCompleted = 0;
        this.battleTimes = []; // Reset battle times on start
        this.battleTurns = []; // Reset battle turns on start
        this.startTime = Date.now();

        // Set viewport to optimal resolution for farming
        await this.controller.page.setViewport({ width: 1000, height: 1799 });
        logger.debug('[Core] Set viewport to 1000x1799');

        logger.info('[Bot] Session started');
        logger.info(`[Bot] Target: ${this.maxRaids === 0 ? 'Unlimited' : this.maxRaids} raids`);

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(1000);
                    continue;
                }

                // Check raid limit
                if (this.maxRaids > 0 && this.raidsCompleted >= this.maxRaids) {
                    logger.info(`[Status] Raid limit reached: ${this.raidsCompleted}/${this.maxRaids}`);
                    break;
                }

                const success = await this.runSingleRaid();
                if (success) {
                    this.raidsCompleted++;
                }


                // Random delay between raids
                // EST: Reduced delay for speed (0.5-1s)
                await sleep(randomDelay(500, 1000));
            }
        } catch (error) {
            // Graceful exit on browser close/disconnect
            if (this.controller.isNetworkError(error) || error.message.includes('Target closed') || error.message.includes('Session closed')) {
                logger.info('[Bot] Session terminated (Browser closed)');
            } else {
                logger.error('[Error] [Bot] Raid bot error:', error);
                await this.controller.takeScreenshot('error_raid');
                throw error;
            }
        } finally {
            this.isRunning = false;
        }
    }

    async runSingleRaid() {
        logger.info(`[Raid] Searching for backups (${this.raidsCompleted + 1})`);

        // Try to find and join a raid
        const joined = await this.findAndJoinRaid();

        if (!joined) {
            logger.warn('[Raid] Failed to join raid. Retrying');
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
            const isVisible = btn.offsetWidth > 0 && btn.offsetHeight > 0;
            return isVisible && !isDeckPopup;
        });

        if (isResult || okButton) {
            logger.info('[Wait] Battle result state detected. Proceeding to battle handler');
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
                logger.info('[Bot] Pending battles detected. Clearing');
                await this.clearPendingBattles();
                return false; // Restart cycle
            }
        }

        // Check if bot was stopped before starting battle
        if (!this.isRunning) {
            logger.debug('[System] Operation cancelled before battle initiation');
            return;
        }

        // Handle battle
        const result = await this.battle.executeBattle(this.battleMode, { honorTarget: this.honorTarget });

        if (result?.raidEnded) {
            return false;
        }

        const honorReached = result?.honorReached || false;
        if (honorReached) {
            logger.info(`[Target] Honor goal reached: ${this.honorTarget.toLocaleString()}. Skipping rest of battle`);
        }

        this.updateDetailStats(result);

        // Store battle time and turns
        if (this.battle.lastBattleDuration > 0) {
            this.battleTimes.push(this.battle.lastBattleDuration);
            this.battleTurns.push(result.turns || 0);

            // Memory Optimization: keep only last 50 entries
            if (this.battleTimes.length > 50) this.battleTimes.shift();
            if (this.battleTurns.length > 50) this.battleTurns.shift();
        }

        if (honorReached) {
            // Immediate navigation back to raid list to ensure we move on
            await this.controller.goto(this.raidBackupUrl);
            await sleep(800);
        } else {
            logger.info('[Cleared] Battle completed');
        }

        return true;
    }

    async findAndJoinRaid() {
        // Navigate to raid backup page
        logger.info('[Raid] Navigating to backup page');
        await this.controller.goto(this.raidBackupUrl);
        // EST: Reduced delay for speed (0.5-1s)
        await sleep(randomDelay(500, 1000));

        let attempts = 0;
        const maxAttempts = 10; // Prevent infinite loops

        while (attempts < maxAttempts && this.isRunning) {
            attempts++;

            // Check for error popup first
            const errorResult = await this.handleErrorPopup();
            if (errorResult.detected) {
                if (errorResult.text.includes('pending battles')) {
                    logger.info('[Wait] Pending battles detected. Clearing');
                    await this.clearPendingBattles();
                    // After clearing, return to backup page
                    await this.controller.goto(this.raidBackupUrl);
                    await sleep(randomDelay(1500, 2500));
                    continue;
                }

                logger.info('[Wait] Error popup detected. Refreshing page');
                await this.controller.page.reload();
                await sleep(randomDelay(1500, 2500));
                continue;
            }

            // Look for raid entries with class "btn-multi-raid lis-raid search"
            const raidSelector = '.btn-multi-raid.lis-raid.search';

            if (await this.controller.elementExists(raidSelector, 2000)) {
                logger.info('[Raid] Found raid entry. Joining');

                try {
                    await this.controller.clickSafe(raidSelector);
                    await sleep(randomDelay(1500, 2500));

                    // Check if we successfully joined (moved to summon screen or battle)
                    const currentUrl = this.controller.page.url();
                    const onSummonScreen = await this.controller.elementExists('.prt-supporter-list', 500);
                    const inBattle = currentUrl.includes('#raid') || currentUrl.includes('_raid');

                    if (onSummonScreen || inBattle) {
                        logger.info('[Raid] Successfully joined raid');
                        return true;
                    }

                    // Check for error popup after clicking
                    const clickError = await this.handleErrorPopup();
                    if (clickError.detected) {
                        if (clickError.text === 'max_raids_limit') {
                            logger.warn('[Raid] Concurrent limit reached. Restarting cycle');
                            return false;
                        }

                        if (clickError.text.includes('pending battles')) {
                            logger.info('[Wait] Pending battles detected after join. Clearing');
                            await this.clearPendingBattles();
                            await this.controller.goto(this.raidBackupUrl);
                            await sleep(randomDelay(1500, 2500));
                            continue;
                        }

                        logger.warn('[Wait] Raid was full or unavailable. Refreshing');
                        await this.controller.page.reload();
                        await sleep(randomDelay(1500, 2500));
                        continue;
                    }

                    // Unknown state, refresh and retry
                    logger.warn('[Wait] Unknown state after join attempt. Refreshing');
                    await this.controller.page.reload();
                    await sleep(randomDelay(1500, 2500));

                } catch (error) {
                    logger.error('[Error] [Raid] Error clicking raid entry:', error);
                    await this.controller.page.reload();
                    await sleep(randomDelay(1500, 2500));
                }

            } else {
                // No raids available, wait and refresh
                logger.info('[Raid] No raids available. Re-checking');
                await sleep(5000);

                logger.info('[Raid] Refreshing page');
                await this.controller.page.reload();
                await sleep(randomDelay(1500, 2500));
            }
        }

        logger.warn(`[Wait] Failed to join raid after ${attempts} attempts`);
        return false;
    }

    async handleErrorPopup() {
        // Check for error popup with class "prt-popup-footer" containing "btn-usual-ok"
        // Use visible: true to avoid clicking phantom/closing popups
        const errorPopupSelector = '.prt-popup-footer .btn-usual-ok';
        const bodySelector = '.txt-popup-body';

        if (await this.controller.elementExists(errorPopupSelector, 1000, true)) {
            // Get error text
            const errorText = await this.controller.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el && (el.offsetWidth > 0 || el.offsetHeight > 0) ? el.innerText : '';
            }, bodySelector);

            if (!errorText) return { detected: false, text: '' };

            logger.info(`[Wait] Error alert detected: ${errorText.trim()}`);

            if (errorText.toLowerCase().includes('three raid battles')) {
                logger.warn('[Wait] Concurrent raid limit reached (Max 3). Waiting');
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
                logger.warn('[Wait] Failed to click error popup OK button (might have closed):', error.message);
            }
            return { detected: true, text: errorText.toLowerCase() };
        }

        return { detected: false, text: '' };
    }

    async clearPendingBattles() {
        const unclaimedUrl = this.selectors.unclaimedRaidUrl || 'https://game.granbluefantasy.jp/#quest/assist/unclaimed/0/0';
        const entrySelector = this.selectors.unclaimedRaidEntry || '.btn-multi-raid.lis-raid';

        logger.info('[Raid] Initializing pending battle clearance');

        let clearedCount = 0;
        const maxToClear = 10; // safety limit

        while (clearedCount < maxToClear && this.isRunning) {
            await this.controller.goto(unclaimedUrl);
            await sleep(randomDelay(1500, 2500));

            const hasEntries = await this.controller.elementExists(entrySelector, 3000);
            if (!hasEntries) {
                logger.info('[Raid] Pending battles cleared');
                break;
            }

            logger.info(`[Raid] Clearing unclaimed raid #${clearedCount + 1}`);
            try {
                await this.controller.clickSafe(entrySelector);
                // Wait for either the result page to load or we are redirected
                // We wait for the OK button which usually appears on result screens
                const okButtonSelector = '.btn-usual-ok';
                logger.debug('[Wait] Waiting for result page');

                // Wait up to 10 seconds for the OK button to appear
                const foundOk = await this.controller.elementExists(okButtonSelector, 10000);
                if (foundOk) {
                    logger.info('[Raid] Result processed');
                    // Optional: tiny delay to ensure state is saved
                    await sleep(500);
                } else {
                    logger.warn('[Wait] OK button timeout. Proceeding');
                }

                clearedCount++;
            } catch (error) {
                logger.error('[Error] Failed to click unclaimed raid:', error);
                break;
            }
        }

        logger.info(`[Raid] Finished clearing ${clearedCount} pending battles`);
    }

    async selectSummon() {
        logger.info('[Summon] Selecting supporter');

        // Wait for summon screen
        // Optimization: Reduced check interval from 1000ms to 200ms
        let retryCount = 0;
        while (retryCount < 15) { // 3s total
            // Optimization: If battle detected, skip summon selection
            const instantBattle = await this.controller.page.evaluate(() => {
                const url = window.location.href;
                const att = document.querySelector('.btn-attack-start');
                return url.includes('#raid') || url.includes('_raid') || (att && (att.offsetWidth > 0 || att.classList.contains('display-on')));
            });

            if (instantBattle) {
                logger.info('[Bot] Transitioned to battle. Skipping summon search');
                return 'success';
            }

            if (await this.controller.elementExists('.prt-supporter-list', 100)) {
                break;
            }
            retryCount++;
            await sleep(200);
        }

        // Check for 'btn-usual-ok' (Confirmation popup)
        const okFound = await this.controller.elementExists('.btn-usual-ok', 200, true);
        if (okFound) {
            // Priority: Check if the OK button belongs to a "Battle Concluded" popup first
            const error = await this.handleErrorPopup();
            if (error.detected) {
                if (error.text.includes('already ended') || error.text.includes('defeated')) return 'ended';
                if (error.text.includes('pending battles')) return 'pending';
            }

            logger.info('[Bot] Clicking confirmation popup');
            await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1 }).catch(() => {
                logger.debug('[Wait] Confirmation popup vanished before click');
            });
            await sleep(400);

            // Double check transition
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                return 'success';
            }
        }

        const summonSelector = '.prt-supporter-detail';
        if (await this.controller.elementExists(summonSelector, 2500, true)) {
            logger.info('[Summon] Supporter selected');

            try {
                await this.controller.clickSafe(summonSelector, { timeout: 2000, maxRetries: 1 });
            } catch (error) {
                const currentUrl = this.controller.page.url();
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    logger.info('[Bot] Transitioned to battle. Ignoring click error');
                    return 'success';
                }
                throw error;
            }

            // Check confirmation after selection
            if (await this.controller.elementExists('.btn-usual-ok', 1000, true)) {
                logger.info('[Wait] Clicking start confirmation');
                await this.controller.clickSafe('.btn-usual-ok', { timeout: 2000, maxRetries: 1 }).catch(() => {
                    logger.debug('[Wait] Start confirmation vanished before click');
                });
                await sleep(800);
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
                logger.info('[Summon] Supporter selected (fallback)');
                await sleep(500);

                if (await this.controller.elementExists('.btn-usual-ok', 500, true)) {
                    await this.controller.clickSafe('.btn-usual-ok', { timeout: 2000, maxRetries: 1 }).catch(() => {
                        logger.debug('[Wait] Fallback confirmation vanished before click');
                    });
                    await sleep(800);

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

        // 2. Detect "Raid already ended" or other errors with proactive polling
        // Optimization: Poll for up to 3 seconds to catch late-appearing popups
        for (let i = 0; i < 3; i++) {
            const error = await this.handleErrorPopup();
            if (error.detected) {
                if (error.text.includes('already ended') || error.text.includes('home screen will now appear')) {
                    logger.info('[Raid] Raid already ended popup detected. Returning to backup page');
                    return 'ended';
                }
                if (error.text.includes('pending battles')) {
                    return 'pending';
                }
                // Stop polling if we found any error popup
                break;
            }
            await sleep(1000);
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
            logger.error('[Safety] Session expired or Redirected to landing. Stopping');
            this.stop();
            return 'ended';
        }

        if (!finalUrl.includes('#raid') && !finalUrl.includes('_raid') && !finalUrl.includes('#result')) {
            logger.warn('[Wait] URL did not transition to battle. Potential error');
            return 'ended';
        }

        return 'success';
    }

    async checkCaptcha() {
        const selectors = config.selectors.battle;
        if (await this.controller.elementExists(selectors.captchaPopup, 1000, true)) {
            const headerText = await this.controller.getText(selectors.captchaHeader);
            if (headerText.includes('Access Verification')) {
                logger.error('[Safety] Captcha detected. Human intervention required');
                this.stop();
                return true;
            }
        }
        return false;
    }

    pause() {
        this.isPaused = true;
        logger.info('[Status] Bot paused');
    }

    resume() {
        this.isPaused = false;
        logger.info('[Status] Bot resumed');
    }

    stop() {
        this.isRunning = false;
        if (this.battle) {
            this.battle.stop();
        }
        // Cleanup resources
        this.controller.disableResourceBlocking().catch(e => logger.warn('[Performance] Failed to disable resource blocking', e));
        logger.info('[System] Shutdown requested');
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
        if (result.duration) {
            // Convert seconds to ms
            const ms = Math.floor(result.duration * 1000);
            this.battleTimes.push(ms);
            // Keep only last 50
            if (this.battleTimes.length > 50) this.battleTimes.shift();

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

        return {
            raidsCompleted: this.raidsCompleted,
            isRunning: this.isRunning,
            isPaused: this.isPaused,
            startTime: this.startTime,
            avgBattleTime: this.getAverageBattleTime(),
            avgTurns: avgTurns,
            battleTimes: this.battleTimes,
            battleTurns: this.battleTurns,
            battleCount: this.battleCount || 0,
            lastBattleTime: this.battleTimes.length > 0 ? this.battleTimes[this.battleTimes.length - 1] : 0
        };
    }
}

export default RaidBot;
