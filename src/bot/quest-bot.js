import PageController from '../core/page-controller.js';
import BattleHandler from './battle-handler.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';
import notifier from '../utils/notifier.js';

class QuestBot {
    constructor(page, options = {}) {
        this.controller = new PageController(page);
        this.questUrl = options.questUrl;
        this.maxQuests = options.maxQuests || 0; // 0 = unlimited
        this.battleMode = options.battleMode || 'full_auto';
        this.onBattleEnd = options.onBattleEnd || null;
        this.selectors = config.selectors.quest;
        this.battle = new BattleHandler(page, {
            fastRefresh: options.fastRefresh || false
        });

        // Enable performance optimizations
        if (options.blockResources) {
            logger.info('[Performance] Image blocking: ENABLED');
            this.controller.enableResourceBlocking().catch(e => logger.warn('[Performance] Failed to enable resource blocking', e));
        } else {
            logger.info('[Performance] Image blocking: DISABLED');
        }

        // State
        this.questsCompleted = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.battleTimes = []; // Array to store battle durations
        this.battleTurns = []; // Array to store turn counts
    }

    async start() {
        this.isRunning = true;
        this.questsCompleted = 0;
        this.battleTimes = []; // Reset battle times on start
        this.battleTurns = []; // Reset battle turns on start
        this.startTime = Date.now();

        // Set viewport to optimal resolution for farming
        await this.controller.page.setViewport({ width: 1000, height: 1799 });
        logger.debug('[Core] Set viewport to 1000x1799');

        logger.info('[Bot] Session started');
        logger.info(`[Bot] Target: ${this.maxQuests === 0 ? 'Unlimited' : this.maxQuests} quests`);

        // Notify session start
        notifier.notifySessionStart(this.profileId || 'p1', 'quest').catch(e => logger.debug('[Notifier] Failed to notify start', e));

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(1000);
                    continue;
                }

                // Check quest limit
                if (this.maxQuests > 0 && this.questsCompleted >= this.maxQuests) {
                    logger.info(`[Status] Quest limit reached: ${this.questsCompleted}/${this.maxQuests}`);
                    break;
                }

                await this.runSingleQuest();
                this.questsCompleted++;


                // Random delay between quests
                // EST: Reduced delay for speed (0.5-1s)
                await sleep(randomDelay(500, 1000));
            }
        } catch (error) {
            // Graceful exit on browser close/disconnect
            if (this.controller.isNetworkError(error) || error.message.includes('Target closed') || error.message.includes('Session closed')) {
                logger.info('[Bot] Session terminated (Browser closed)');
            } else {
                logger.error('[Error] [Bot] Quest bot error:', error);
                notifier.notifyError(this.profileId || 'p1', error.message).catch(e => logger.debug('[Notifier] Failed to notify error', e));
                await this.controller.takeScreenshot('error_quest');
                throw error;
            }
        } finally {
            this.isRunning = false;
        }
    }

    async runSingleQuest() {
        logger.info(`[Quest] Cycle initiated (${this.questsCompleted + 1})`);

        // Navigate to quest
        await this.controller.goto(this.questUrl);
        // Optimization: Minimum delay for maximum snappiness (100-200ms)
        await sleep(randomDelay(100, 200));

        // ... rest of the code ...

        // Check for existing battle state (Redirected or Resume)
        const currentUrl = this.controller.page.url();
        const isRaidUrl = currentUrl.includes('#raid') || currentUrl.includes('_raid');
        const isResult = currentUrl.includes('#result');
        // Check for OK button but EXCLUDE the one from the deck/supporter selection popup
        const okButton = await this.controller.page.evaluate(() => {
            const btn = document.querySelector('.btn-usual-ok');
            if (!btn) return false;
            // If the button is inside a deck selection popup, it's not a "battle end" state
            const isDeckPopup = !!btn.closest('.pop-deck');
            const isVisible = btn.offsetWidth > 0 && btn.offsetHeight > 0;
            return isVisible && !isDeckPopup;
        });
        const isBattle = isRaidUrl || isResult || okButton || await this.controller.elementExists('.btn-auto', 200);

        if (isBattle) {
            logger.info('[Wait] Battle or results detected. Resuming');

            // Check if bot was stopped before starting battle
            if (!this.isRunning) {
                logger.debug('[System] Operation cancelled before battle initiation');
                return;
            }

            const result = await this.battle.executeBattle(this.battleMode);
            this.updateDetailStats(result);

            // Store battle time and turns
            if (this.battle.lastBattleDuration > 0) {
                this.battleTimes.push(this.battle.lastBattleDuration);
                this.battleTurns.push(result.turns || 0);
            }

            // User Optimization: Skip clicking OK button. Just return to loop (which navigates to Quest URL)
            return; // Skip the rest of runSingleQuest (summon selection etc)
        }

        // Select summon
        await this.selectSummon();

        // Safety: Check for captcha after summon selection
        if (await this.checkCaptcha()) {
            return;
        }

        // Check if bot was stopped before starting battle
        if (!this.isRunning) {
            logger.debug('[System] Operation cancelled before battle initiation');
            return;
        }

        // Handle battle
        const result = await this.battle.executeBattle(this.battleMode);
        this.updateDetailStats(result);

        // Store battle time and turns
        if (this.battle.lastBattleDuration > 0) {
            this.battleTimes.push(this.battle.lastBattleDuration);
            this.battleTurns.push(result.turns || 0);

            // Memory Optimization: keep only last 50 entries
            if (this.battleTimes.length > 50) this.battleTimes.shift();
            if (this.battleTurns.length > 50) this.battleTurns.shift();
        }

        // User Optimization: Skip clicking OK button.
        // await this.battle.handleResult();

        logger.info('[Cleared] Battle completed');
    }

    async selectSummon() {
        logger.info('[Summon] Selecting supporter');

        // Wait for summon screen (retry a few times)
        // Wait for summon screen (retry a few times)
        // Optimization: Reduced check interval from 1000ms to 200ms
        let retryCount = 0;
        while (retryCount < 15) { // 15 * 200ms = 3s total
            // Optimization: If battle detected, skip summon selection
            const instantBattle = await this.controller.page.evaluate(() => {
                const hash = window.location.hash;
                const att = document.querySelector('.btn-attack-start');

                // Explicitly check for battle hashes, avoiding quest/supporter_raid
                const isBattleHash = hash.startsWith('#raid') || hash.startsWith('#raid_multi');
                const hasAttackBtn = att && (att.offsetWidth > 0 || att.classList.contains('display-on'));

                return isBattleHash || hasAttackBtn;
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
        // Optimization: Reduced timeout from 500ms to 100ms
        const okFound = await this.controller.elementExists('.btn-usual-ok', 100, true);
        if (okFound) {
            // Priority: Check if the OK button belongs to a "Battle Concluded" popup first
            const error = await this.handleErrorPopup();
            if (error.detected && (error.text.includes('already ended') || error.text.includes('defeated'))) {
                return 'ended';
            }

            logger.info('[Bot] Clicking confirmation popup');
            // Use 1 retry and short timeout to avoid getting stuck if the popup vanishes
            await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1 }).catch(() => {
                logger.debug('[Wait] Confirmation popup vanished before click');
            });
            await sleep(400);

            // Double check if we moved to battle
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                logger.info('[Bot] Transitioned to battle. Skipping supporter selection');
                return 'success';
            }
        }

        // Try to select ANY available summon in the list
        // Priority: 1. Misc Tab (usually safer) -> 2. First available
        // Note: exact selectors depend on user config, but we'll try a generic approach first

        // Try to click the first available summon button/panel
        const summonSelector = '.prt-supporter-detail';
        if (await this.controller.elementExists(summonSelector, 2000, true)) {
            logger.info('[Summon] Supporter selected');

            try {
                // Use visibility check and silent mode for Quest mode as requested
                // Reduced timeout to 1000ms as elementExists already confirmed it
                await this.controller.clickSafe(summonSelector, { timeout: 1000, maxRetries: 1, silent: true });
            } catch (error) {
                // Check if it's a "not found" error which is expected in race conditions
                if (error.message.includes('Element not found')) {
                    logger.warn('[Summon] Supporter detail unavailable. Assuming transition');
                    return 'success';
                }

                // If click fails for other reasons, check if we entered battle
                const currentUrl = this.controller.page.url();
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    logger.info('[Bot] Transitioned to battle. Ignoring click error');
                    return 'success';
                }
                throw error;
            }

            // EST: Reduced delay for speed (removed random delay entirely)
            // await sleep(randomDelay(200, 500)); 

            // Check for another confirmation popup after clicking summon (Start Quest)
            // Optimization: Reduced timeout from 2000ms to 200ms
            if (await this.controller.elementExists('.btn-usual-ok', 500, true)) {
                logger.info('[Wait] Clicking start confirmation');
                await this.controller.clickSafe('.btn-usual-ok', { timeout: 2000, maxRetries: 1 }).catch(() => {
                    logger.debug('[Wait] Start confirmation vanished before click');
                });
                await sleep(800);

                return await this.validatePostClick();
            }

            return 'success';
        }

        // Fallback to configured selectors if generic failed
        const summonSelectors = [
            this.selectors.summonSlot1,
            this.selectors.summonSlot2,
            this.selectors.summonSlot3
        ];

        for (const selector of summonSelectors) {
            if (await this.controller.elementExists(selector, 1000)) {
                await this.controller.clickSafe(selector);
                logger.info('[Summon] Supporter selected (fallback)');
                await sleep(500);

                // Check confirmation again
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

        // 2. Detect "already ended" or other errors with proactive polling
        // Optimization: Poll for up to 3 seconds to catch late-appearing popups
        for (let i = 0; i < 3; i++) {
            const error = await this.handleErrorPopup();
            if (error.detected) {
                if (error.text.includes('already ended') || error.text.includes('home screen will now appear')) {
                    logger.info('[Quest] Quest already ended popup detected. Returning to quest page');
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

    async handleErrorPopup() {
        const errorPopupSelector = '.prt-popup-footer .btn-usual-ok';
        const bodySelector = '.txt-popup-body';

        if (await this.controller.elementExists(errorPopupSelector, 1000, true)) {
            const errorText = await this.controller.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el && (el.offsetWidth > 0 || el.offsetHeight > 0) ? el.innerText : '';
            }, bodySelector);

            if (!errorText) return { detected: false, text: '' };

            logger.info(`[Wait] Error alert detected: ${errorText.trim()}`);

            try {
                await this.controller.clickSafe(errorPopupSelector, { timeout: 2000, maxRetries: 1 });
                await sleep(500);
            } catch (error) {
                logger.warn('[Wait] Failed to click error popup OK button:', error.message);
            }
            return { detected: true, text: errorText.toLowerCase() };
        }

        return { detected: false, text: '' };
    }

    async checkCaptcha() {
        const selectors = config.selectors.battle;
        if (await this.controller.elementExists(selectors.captchaPopup, 1000, true)) {
            const headerText = await this.controller.getText(selectors.captchaHeader);
            if (headerText.includes('Access Verification')) {
                logger.error('[Safety] Captcha detected. Human intervention required');
                notifier.notifyCaptcha(this.profileId || 'p1').catch(e => logger.debug('[Notifier] Failed to notify captcha', e));
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

        // Notify session completion
        notifier.notifySessionComplete(this.profileId || 'p1', this.getStats()).catch(e => logger.debug('[Notifier] Failed to notify completion', e));
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
            // Convert seconds to ms for consistency with RaidBot/storage
            const ms = Math.floor(result.duration * 1000);
            this.battleTimes.push(ms);
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
            completedQuests: this.questsCompleted,
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

export default QuestBot;
