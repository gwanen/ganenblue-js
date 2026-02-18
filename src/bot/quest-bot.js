import PageController from '../core/page-controller.js';
import BattleHandler from './battle-handler.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger, { createScopedLogger } from '../utils/logger.js';
import config from '../utils/config.js';
import notifier from '../utils/notifier.js';

class QuestBot {
    constructor(page, options = {}) {
        this.controller = new PageController(page);
        this.questUrl = options.questUrl;
        this.maxQuests = options.maxQuests || 0; // 0 = unlimited
        this.battleMode = options.battleMode || 'full_auto';
        this.isReplicard = options.isReplicard || false;
        this.isXeno = options.isXeno || false;
        this.zoneId = options.zoneId || null;
        this.profileId = options.profileId || config.get('profile_id') || 'p1';
        this.logger = createScopedLogger(this.profileId);
        this.replicardZoneUrl = 'https://game.granbluefantasy.jp/#replicard/stage/';
        this.onBattleEnd = options.onBattleEnd || null;
        this.selectors = config.selectors.quest;
        this.replicardSelectors = config.selectors.replicard;
        this.battle = new BattleHandler(page, {
            fastRefresh: options.fastRefresh || false,
            logger: this.logger
        });

        // Enable performance optimizations
        if (options.blockResources) {
            this.logger.info('[Performance] Image blocking: ENABLED');
            this.controller.enableResourceBlocking().catch(e => this.logger.warn('[Performance] Failed to enable resource blocking', e));
        } else {
            this.logger.info('[Performance] Image blocking: DISABLED');
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
        this.logger.debug('[Core] Set viewport to 1000x1799');

        this.logger.info('[Bot] Session started');
        this.logger.info(`[Bot] Target: ${this.maxQuests === 0 ? 'Unlimited' : this.maxQuests} ${this.isReplicard ? 'runs' : 'quests'}`);

        // Notify session start
        notifier.notifySessionStart(this.profileId || 'p1', this.isReplicard ? 'replicard' : 'quest').catch(e => this.logger.debug('[Notifier] Failed to notify start', e));

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(1000);
                    continue;
                }

                // Check quest limit
                if (this.maxQuests > 0 && this.questsCompleted >= this.maxQuests) {
                    this.logger.info(`[Status] Limit reached: ${this.questsCompleted}/${this.maxQuests}`);
                    break;
                }

                await this.runSingleQuest();
                this.questsCompleted++;


                // Minimum delay for snappiness
                await sleep(500);
            }
        } catch (error) {
            // Graceful exit on browser close/disconnect
            if (this.controller.isNetworkError(error) || error.message.includes('Target closed') || error.message.includes('Session closed')) {
                this.logger.info('[Bot] Session terminated (Browser closed)');
            } else {
                this.logger.error('[Error] [Bot] Bot error:', error);
                notifier.notifyError(this.profileId || 'p1', error.message).catch(e => this.logger.debug('[Notifier] Failed to notify error', e));
                await this.controller.takeScreenshot('error_bot');
                throw error;
            }
        } finally {
            this.isRunning = false;
        }
    }

    async runSingleQuest() {
        this.logger.info(`[${this.isReplicard ? 'Replicard' : 'Quest'}] Cycle initiated (${this.questsCompleted + 1})`);

        // Navigate to quest
        await this.controller.goto(this.questUrl);
        // Snappy navigation delay
        await sleep(150);

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
            this.logger.info('[Wait] Battle or results detected. Resuming');

            // Check if bot was stopped before starting battle
            if (!this.isRunning) {
                this.logger.debug('[System] Operation cancelled before battle initiation');
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

        // Start Battle Sequence
        let startResult;

        if (this.isReplicard) {
            startResult = await this.startReplicardBattle();
        } else {
            startResult = await this.selectSummon();
        }

        if (startResult === 'retry' || startResult === 'failed' || startResult === 'ended') {
            return;
        }

        // Safety: Check for captcha after summon selection
        if (await this.checkCaptcha()) {
            return;
        }

        // Check if bot was stopped before starting battle
        if (!this.isRunning) {
            this.logger.debug('[System] Operation cancelled before battle initiation');
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

        this.logger.info('[Cleared] Battle completed');

        // Xeno Replicard Logic: Redirect -> Wait
        if (this.isXeno && this.zoneId) {
            const redirectUrl = `${this.replicardZoneUrl}${this.zoneId}`;
            this.logger.info(`[Xeno] Redirecting to Zone ${this.zoneId}: ${redirectUrl}`);
            await this.controller.goto(redirectUrl);
            this.logger.info('[Xeno] Waiting for 3 seconds...');
            await sleep(3000);
        }
    }

    async startReplicardBattle() {
        this.logger.info('[Replicard] Checking for start button');

        // Wait for the Replicard start button
        // 3s timeout with polling
        this.logger.debug(`[Replicard] Searching for selector: ${this.replicardSelectors.startButton}`);

        let btnState = { found: false };
        let attempts = 0;
        const maxAttempts = 15; // 3 seconds (200ms interval)

        while (attempts < maxAttempts) {
            btnState = await this.controller.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return { found: false };
                const rect = el.getBoundingClientRect();
                return {
                    found: true,
                    visible: rect.width > 0 && rect.height > 0,
                    classes: el.className
                };
            }, this.replicardSelectors.startButton);

            if (btnState.found && btnState.visible) {
                break;
            }

            attempts++;
            await sleep(200);
        }

        this.logger.debug(`[Replicard] Button State: ${JSON.stringify(btnState)}`);

        if (btnState.found && btnState.visible) {
            this.logger.info('[Replicard] Start button found and visible. Clicking...');

            try {
                await this.controller.clickSafe(this.replicardSelectors.startButton, { timeout: 2000, maxRetries: 1 });
                await sleep(500);

                // Verify we moved to battle
                return await this.validatePostClick();
            } catch (error) {
                this.logger.error('[Replicard] Failed to click start button:', error);
                throw error;
            }
        } else {
            // Might already be in battle?
            const inBattle = await this.controller.page.evaluate(() => {
                const hash = window.location.hash;
                return hash.startsWith('#raid') || hash.startsWith('#raid_multi');
            });

            if (inBattle) {
                this.logger.info('[Replicard] Already in battle. Proceeding.');
                return 'success';
            }

            this.logger.warn('[Replicard] Start button not found after waiting. Retrying cycle.');
            return 'retry';
        }
    }

    async selectSummon() {
        this.logger.info('[Summon] Selecting supporter');

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
                this.logger.info('[Bot] Transitioned to battle. Skipping summon search');
                return 'success';
            }

            if (await this.controller.elementExists('.prt-supporter-list', 100)) {
                break;
            }

            // Optimization: Check for OK confirmation popup INSIDE the loop for faster reaction
            if (await this.controller.elementExists('.btn-usual-ok', 50, true)) {
                this.logger.info('[Summon] OK button detected during wait. Breaking loop');
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

            this.logger.info('[Bot] Clicking confirmation popup');
            // Use 1 retry and short timeout to avoid getting stuck if the popup vanishes
            await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1 }).catch(() => {
                this.logger.debug('[Wait] Confirmation popup vanished before click');
            });
            await sleep(400);

            // Double check if we moved to battle
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                this.logger.info('[Bot] Transitioned to battle. Skipping supporter selection');
                return 'success';
            }
        }

        // Try to select ANY available summon in the list
        // Priority: 1. Misc Tab (usually safer) -> 2. First available
        // Note: exact selectors depend on user config, but we'll try a generic approach first

        // Try to click the first available summon button/panel
        const summonSelector = '.prt-supporter-detail';
        if (await this.controller.elementExists(summonSelector, 2000, true)) {
            this.logger.info('[Summon] Supporter selected');

            try {
                // Use visibility check and silent mode for Quest mode as requested
                // Reduced timeout to 1000ms as elementExists already confirmed it
                await this.controller.clickSafe(summonSelector, { timeout: 1000, maxRetries: 1, silent: true });
            } catch (error) {
                // Check if it's a "not found" error which is expected in race conditions
                if (error.message.includes('Element not found')) {
                    this.logger.warn('[Summon] Supporter detail unavailable. Assuming transition');
                    return 'success';
                }

                // If click fails for other reasons, check if we entered battle
                const currentUrl = this.controller.page.url();
                if (currentUrl.includes('#raid') || currentUrl.includes('_raid')) {
                    this.logger.info('[Bot] Transitioned to battle. Ignoring click error');
                    return 'success';
                }
                throw error;
            }


            // Check for another confirmation popup after clicking summon (Start Quest)
            // Optimization: Increased timeout to 1500ms to ensure we catch slow transitions
            if (await this.controller.elementExists('.btn-usual-ok', 1500, true)) {
                this.logger.info('[Wait] Clicking start confirmation');

                // Robust Click with State Verification
                let clickSuccess = false;
                for (let i = 0; i < 3; i++) {
                    try {
                        await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1 });
                        clickSuccess = true;
                    } catch (e) {
                        // Ignore click error and retry logic handles it
                    }

                    // Check if popup is still there
                    if (!await this.controller.elementExists('.btn-usual-ok', 200, true)) {
                        clickSuccess = true; // Popup gone, assume success
                        break;
                    }
                    await sleep(300);
                }

                if (!clickSuccess) {
                    this.logger.warn('[Wait] Failed to click start confirmation properly');
                }

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
                this.logger.info('[Summon] Supporter selected (fallback)');
                await sleep(500);

                // Check confirmation again
                if (await this.controller.elementExists('.btn-usual-ok', 500, true)) {
                    await this.controller.clickSafe('.btn-usual-ok', { timeout: 2000, maxRetries: 1 }).catch(() => {
                        this.logger.debug('[Wait] Fallback confirmation vanished before click');
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

        // 1.5. Safety: Check if we are stuck on Deck Selection (Party Pick)
        if (await this.controller.elementExists('.pop-deck.pop-show', 300, true)) {
            this.logger.warn('[Wait] Stuck on Deck Selection. Clicking OK directly.');
            await this.controller.clickSafe('.pop-deck.pop-show .btn-usual-ok', { silent: true });
            await sleep(800);
        }

        // 2. Detect "already ended" or other errors with proactive polling
        // Optimization: Poll for up to 1.5 seconds (3x500ms) but exit EARLY if URL changes
        for (let i = 0; i < 3; i++) {
            // Check for success transition first
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#raid') || currentUrl.includes('_raid') || currentUrl.includes('#result')) {
                return 'success';
            }

            const error = await this.handleErrorPopup();
            if (error.detected) {
                if (error.text.includes('already ended') || error.text.includes('home screen will now appear')) {
                    this.logger.info('[Quest] Quest already ended popup detected. Returning to quest page');
                    return 'ended';
                }
                if (error.text.includes('pending battles')) {
                    return 'pending';
                }
                // Stop polling if we found any error popup
                break;
            }
            await sleep(500);
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
            this.logger.warn('[Wait] URL did not transition to battle. Potential error');
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

            this.logger.info(`[Wait] Error alert detected: ${errorText.trim()}`);

            try {
                await this.controller.clickSafe(errorPopupSelector, { timeout: 2000, maxRetries: 1 });
                await sleep(500);
            } catch (error) {
                this.logger.warn('[Wait] Failed to click error popup OK button:', error.message);
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

        // Calculate Rate
        let rate = '0.0/h';
        const now = Date.now();
        const uptimeHours = (now - this.startTime) / (1000 * 60 * 60);
        if (uptimeHours > 0) {
            const qph = this.questsCompleted / uptimeHours;
            rate = `${qph.toFixed(1)}/h`;
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
            lastBattleTime: this.battleTimes.length > 0 ? this.battleTimes[this.battleTimes.length - 1] : 0,
            rate: rate
        };
    }
}

export default QuestBot;
