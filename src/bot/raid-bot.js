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
        this.refreshOnStart = options.refreshOnStart !== undefined ? options.refreshOnStart : true;
        this.selectors = config.selectors.raid;
        this.battle = new BattleHandler(page, {
            fastRefresh: options.fastRefresh || false,
            logger: this.logger,
            controller: this.controller
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

        // Network Error State for Fast Fallback
        this.raidErrorType = null;
        this.onRaidError = this._onRaidError.bind(this);
    }

    _onRaidError(info) {
        this.logger.warn(`[Network] Raid entry failed: ${info.type}. Triggering fast fallback...`);
        this.raidErrorType = info.type;
    }

    /**
     * Node-side polling for the raidErrorType flag.
     * Used in Promise.race to avoid Puppeteer context issues.
     */
    async waitForRaidError(timeout = 3000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (this.raidErrorType !== null || !this.isRunning) return true;
            await sleep(100);
        }
        return false;
    }

    /**
     * Fast Recovery: Clear UI and refresh list.
     * If already on assist page, reload. Otherwise, navigate back.
     */
    async recoverFromJoinError() {
        const errorType = this.raidErrorType;
        const currentUrl = this.controller.page.url();
        const isOnAssistPage = currentUrl.includes('#quest/assist');

        // Dismiss any lingering error popups before navigating/reloading
        await this.controller.clickSafe('.btn-usual-ok', { silent: true, fast: true }).catch(() => { });

        // Logic refined: check_multi_start failures trigger refresh.
        // All others (initial join, deck create) navigate back.
        if (errorType === 'check_multi_start' || isOnAssistPage) {
            this.logger.warn(`[Raid] Join failed (${errorType || 'UI'}). Performing fast refresh...`);
            await this.controller.reloadPage();
        } else {
            this.logger.warn(`[Raid] Join failed (${errorType}). Returning to assist page...`);
            await this.controller.gotoSPA(this.raidBackupUrl);
        }
        await sleep(200);
    }

    async start() {
        this.isRunning = true;
        this.raidsCompleted = 0;
        this.battleTimes = []; // Reset battle times on start
        this.battleTurns = []; // Reset battle turns on start
        this.lastEndHonor = 0;
        this.totalHonor = 0;
        this.startTime = Date.now();

        if (this.controller.network) {
            this.controller.network.on('raid:error', this.onRaidError);
        }

        this.logger.info('[Bot] Session started');

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

                // Short delay between raids - balanced for browser health
                await sleep(50);
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
        } finally {
            this.stop();
        }
    }

    async runSingleRaid() {
        this.logger.info(`[Raid] Searching for raids (${this.raidsCompleted + 1})`);
        this.raidErrorType = null; // Reset error for new cycle

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

            if (summonStatus === 'ended' || this.raidErrorType !== null || summonStatus === 'failed') {
                this.logger.warn(`[Raid] Summon selection returned ${summonStatus || 'error'}`);
                await this.recoverFromJoinError();
                return false;
            }

            if (summonStatus === 'concurrent_limit' || this.raidErrorType === 'concurrent_limit') {
                this.logger.info('[System] Concurrent raid limit reached (3 active backups).');
                await this.waitForActiveBackupsCooldown();
                this.raidErrorType = null;
                return false; // Restart cycle
            }

            if (summonStatus === 'pending' || this.raidErrorType === 'pending') {
                this.logger.info('[System] Pending battles detected. Clearing...');
                const clearedCount = await this.clearPendingBattles();
                if (clearedCount === 0) {
                    await this.waitForActiveBackupsCooldown();
                }
                return false; // Restart cycle
            }
        }

        // Check if bot was stopped before starting battle
        if (!this.isRunning) {
            this.logger.debug('[System] Operation cancelled before combat initiation');
            return;
        }

        // Handle battle
        const result = await this.battle.executeBattle(this.battleMode, {
            honorTarget: this.honorTarget,
            refreshOnStart: this.refreshOnStart
        });

        if (result?.raidFull) {
            this.logger.info('[Raid] Raid was full. Navigating back to backup page');
            await this.controller.gotoSPA(this.raidBackupUrl);
            await sleep(300);
            return false; // Restart cycle to find another raid
        }

        if (result?.raidEnded) {
            return false;
        }

        if (result?.raidConcurrentLimit) {
            this.logger.info('[System] Concurrent raid limit reached (3 active backups).');
            await this.waitForActiveBackupsCooldown();
            return false;
        }

        if (result?.raidPending) {
            this.logger.info('[Raid] Pending battles detected. Clearing automatically');
            const clearedCount = await this.clearPendingBattles();
            if (clearedCount === 0) {
                await this.waitForActiveBackupsCooldown();
            }
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
            await this.controller.gotoSPA(this.raidBackupUrl);
            await sleep(50);
        } else {
            this.logger.info('[Battle] Combat concluded');
        }

        return true;
    }

    async findAndJoinRaid() {
        this.logger.info('[Raid] Navigating to backup page...');
        await this.controller.gotoSPA(this.raidBackupUrl);
        await sleep(100);

        let attempts = 0;
        const maxAttempts = 10;

        while (attempts < maxAttempts && this.isRunning) {
            attempts++;

            if (this.raidErrorType !== null) {
                if (this.raidErrorType === 'concurrent_limit') {
                    this.logger.info('[System] Concurrent raid limit reached (3 active backups).');
                    await this.waitForActiveBackupsCooldown();
                    await this.controller.gotoSPA(this.raidBackupUrl);
                    await sleep(randomDelay(100, 300));
                    this.raidErrorType = null;
                    continue;
                }

                if (this.raidErrorType === 'pending') {
                    this.logger.info('[Network] Pending battles detected. Clearing automatically');
                    const clearedCount = await this.clearPendingBattles();
                    if (clearedCount === 0) {
                        await this.waitForActiveBackupsCooldown();
                    }
                    await this.controller.gotoSPA(this.raidBackupUrl);
                    await sleep(randomDelay(100, 300));
                    this.raidErrorType = null;
                    continue;
                }
                return false;
            }

            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#result')) {
                this.logger.info('[Raid] Resolving pending result screen...');
                const okFound = await this.controller.elementExists('.btn-usual-ok', 500);
                if (okFound) {
                    await this.controller.clickSafe('.btn-usual-ok', { fast: true }).catch(() => { });
                    await sleep(100);
                } else {
                    await this.controller.gotoSPA('https://game.granbluefantasy.jp/#mypage');
                    await sleep(100);
                    await this.controller.gotoSPA(this.raidBackupUrl);
                }
                continue;
            }

            // Check for error popup first
            const errorResult = await this.battle.checkEarlyBattleEndPopup();
            if (errorResult) {
                // Clear the error popup
                await this.controller.clickSafe('.btn-usual-ok', { fast: true }).catch(() => { });

                if (errorResult.raidFull || errorResult.raidEnded) {
                    this.logger.info('[Status] Raid full or ended. Escaping popup state...');
                    await this.controller.reloadPage();
                    await sleep(randomDelay(1500, 2500));
                    continue;
                }

                if (errorResult.raidConcurrentLimit) {
                    this.logger.info('[System] Concurrent raid limit reached (3 active backups).');
                    await this.waitForActiveBackupsCooldown();
                    await this.controller.gotoSPA(this.raidBackupUrl, { waitUntil: 'domcontentloaded' });
                    await sleep(randomDelay(100, 300));
                    continue;
                }

                if (errorResult.raidPending) {
                    this.logger.info('[Status] Pending battles detected. Initializing cleanup');
                    const clearedCount = await this.clearPendingBattles();
                    if (clearedCount === 0) {
                        await this.waitForActiveBackupsCooldown();
                    }
                    await this.controller.gotoSPA(this.raidBackupUrl, { waitUntil: 'domcontentloaded' });
                    await sleep(randomDelay(100, 300));
                    continue;
                }
                this.logger.info('[Status] Error popup detected. Escaping popup state...');
                await this.controller.reloadPage();
                await sleep(randomDelay(1500, 2500));
                continue;
            }

            const raidSelector = this.selectors.raidEntry;

            if (this.targetUser) {
                this.logger.info(`[Raid] Scanning for target: "${this.targetUser}"...`);

                const targetElementHandle = await this.controller.page.evaluateHandle((user, selector) => {
                    const raids = document.querySelectorAll(selector);
                    const targetName = user.toLowerCase();
                    for (const raid of raids) {
                        const nameEl = raid.querySelector('.txt-request-name');
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

                        try {
                            const raceResult = await Promise.race([
                                this.controller.waitForElement('.prt-supporter-list', 3000).then(res => res ? 'summon' : null),
                                this.controller.waitForElement('.btn-usual-ok', 3000).then(res => res ? 'ok_btn' : null),
                                this.controller.waitForElement('#pop-error', 1000).then(res => res ? 'error' : null),
                                this.controller.waitForElement('.cnt-raid', 3000).then(res => res ? 'battle' : null),
                                this.waitForRaidError(3000).then(res => res ? 'network_error' : null)
                            ]);

                            if (raceResult === 'network_error') {
                                if (this.raidErrorType === 'pending') {
                                    this.logger.info('[Network] Pending battles detected during join. Initializing cleanup');
                                    await this.clearPendingBattles();
                                    await this.controller.gotoSPA(this.raidBackupUrl);
                                    this.raidErrorType = null;
                                    continue;
                                }
                                return false;
                            }
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

                            const clickError = await this.battle.checkEarlyBattleEndPopup();
                            if (clickError) {
                                if (clickError.raidFull) {
                                    this.logger.warn('[Raid] Raid full. Returning to assist page.');
                                    return false;
                                }
                                if (clickError.raidPending) {
                                    this.logger.info('[Status] Pending battles detected after join. Initializing cleanup');
                                    await this.clearPendingBattles();
                                    await this.controller.gotoSPA(this.raidBackupUrl);
                                    await sleep(randomDelay(100, 300));
                                    continue;
                                }
                            }

                        } catch (e) {
                            this.logger.debug(`[Raid] Join check error: ${e.message}`);
                        }

                    } catch (error) {
                        this.logger.error('[Error] [Raid] Error clicking target raid:', error);
                    }
                } else {
                    this.logger.info(`[Raid] Target "${this.targetUser}" not found. Re-checking...`);
                    await sleep(800);
                    await this.refreshRaidSearch();
                    await sleep(randomDelay(800, 1200));
                }
            }
            else if (await this.controller.elementExists(raidSelector, 2000)) {
                this.logger.info('[Raid] Raid detected. Joining...');

                try {
                    await this.controller.clickSafe(raidSelector);
                    await sleep(200);

                    const joinResult = await Promise.race([
                        this.controller.page.waitForSelector('.prt-supporter-list, .btn-usual-ok', { timeout: 3000 }),
                        this.waitForRaidError(3000).then(res => res ? 'network_error' : null)
                    ]).catch(() => null);

                    if (joinResult === 'network_error') {
                        if (this.raidErrorType === 'pending') {
                            this.logger.info('[Network] Pending battles detected during join. Initializing cleanup');
                            await this.clearPendingBattles();
                            await this.controller.gotoSPA(this.raidBackupUrl);
                            this.raidErrorType = null;
                            continue;
                        }
                        return false;
                    }
                    if (joinResult) {
                        const onSummon = await this.controller.elementExists('.prt-supporter-list', 100);
                        if (onSummon) {
                            this.logger.info('[Raid] Join successful');
                            return true;
                        }

                        const clickError = await this.battle.checkEarlyBattleEndPopup();
                        if (clickError) {
                            if (clickError.raidPending) {
                                this.logger.info('[Status] Pending battles detected after join. Initializing cleanup');
                                await this.clearPendingBattles();
                                await this.controller.gotoSPA(this.raidBackupUrl);
                                await sleep(randomDelay(100, 300));
                                continue;
                            }
                            // Fast Recovery: Target-aware reload/navigation
                            await this.recoverFromJoinError();
                            continue;
                        }

                        const urlNow = this.controller.page.url();
                        if (urlNow.includes('#raid') || urlNow.includes('_raid') || await this.controller.elementExists('.prt-supporter-list', 200)) {
                            this.logger.info('[Raid] Joined after popup confirmation');
                            return true;
                        }
                    } else {
                        const urlNow = this.controller.page.url();
                        if (urlNow.includes('#raid') || urlNow.includes('_raid')) {
                            this.logger.info('[Raid] Join successful (direct battle)');
                            return true;
                        }
                    }

                    this.logger.warn('[Raid] Unknown state after join attempt. Recovering...');
                    await this.recoverFromJoinError();

                } catch (error) {
                    this.logger.error('[Error] [Raid] Error clicking raid entry. Recovering...', error);
                    await this.recoverFromJoinError();
                }

            } else {
                this.logger.info('[Raid] No raids available. Re-checking...');
                await sleep(2000);

                // If the game asynchronously redirected us to a pending result screen while we waited
                if (this.controller.page.url().includes('#result')) {
                    continue;
                }

                await this.refreshRaidSearch();
                await sleep(randomDelay(800, 1200));
            }
        }

        this.logger.warn(`[Raid] Failed to join raid after ${attempts} attempts`);
        return false;
    }

    async clearPendingBattles() {
        const unclaimedUrl = 'https://game.granbluefantasy.jp/#quest/assist/unclaimed/0/0';
        const entrySelector = this.selectors.unclaimedRaidEntry;

        this.logger.info('[System] Initializing pending battle clearance...');

        let clearedCount = 0;
        const maxToClear = 10;

        while (clearedCount < maxToClear && this.isRunning) {
            await this.controller.gotoSPA(unclaimedUrl);
            await sleep(randomDelay(100, 300));

            const hasEntries = await this.controller.elementExists(entrySelector, 3000);
            if (!hasEntries) {
                this.logger.info('[Raid] Pending battles cleared');
                break;
            }

            this.logger.info(`[Raid] Clearing unclaimed raid #${clearedCount + 1}`);
            try {
                await this.controller.clickSafe(entrySelector);
                const okButtonSelector = '.btn-usual-ok';
                this.logger.debug('[Wait] Waiting for result page');

                const foundOk = await this.controller.elementExists(okButtonSelector, 10000);
                if (foundOk) {
                    this.logger.info('[Raid] Result processed');
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
        return clearedCount;
    }

    async waitForActiveBackupsCooldown() {
        this.logger.warn('[Raid] 3 simultaneous active backup limit reached!');
        for (let i = 0; i < 15; i += 5) {
            if (!this.isRunning) break;
            this.logger.info(`[Wait] (${i}/15) resuming in ${15 - i}s...`);
            await sleep(5000);
        }
        if (this.isRunning) {
            this.logger.info(`[Wait] (15/15) resuming...`);
        }
    }

    async selectSummon() {
        this.logger.info('[Summon] Selecting supporter');

        let retryCount = 0;
        while (retryCount < 15) { // 3s total
            if (this.raidErrorType !== null) return 'ended';

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

            if (await this.controller.elementExists('.prt-supporter-list', 100, true)) {
                break;
            }

            if (await this.controller.elementExists('.btn-usual-ok', 50, true)) {
                this.logger.info('[Summon] OK button detected during wait. Breaking loop');
                break;
            }

            retryCount++;
            await sleep(200);
        }

        const okFound = await this.controller.elementExists('.btn-usual-ok', 100, true);
        if (okFound) {
            const error = await this.battle.checkEarlyBattleEndPopup();
            if (error) {
                if (error.raidEnded || error.raidFull) return 'ended';
                if (error.raidPending) return 'pending';
            }

            this.logger.info('[Summon] Clicking start confirmation');
            await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1, fast: true }).catch(() => {
                this.logger.debug('[Wait] Confirmation popup vanished before click');
            });
            await sleep(200);

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

            if (await this.controller.elementExists('.btn-usual-ok', 1500, true)) {
                this.logger.info('[Summon] Clicking start confirmation...');

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

        this.logger.warn('[Summon] No supporter or party selection found');
        return 'failed';
    }

    async validatePostClick() {
        if (await this.checkCaptcha()) return 'captcha';

        // Check for Deck selection stuck popups
        if (await this.controller.elementExists('.pop-deck.pop-show', 300, true)) {
            this.logger.warn('[Summon] Stuck on Deck Popup. Clicking OK directly.');
            await this.controller.clickSafe('.pop-deck.pop-show .btn-usual-ok', { silent: true });
            await sleep(800);
        }

        // Check for Party Deck stuck (e.g., Quick Summon skip)
        if (await this.controller.elementExists('.prt-deck', 100, true)) {
            if (await this.controller.elementExists('.btn-usual-ok', 100, true)) {
                this.logger.warn('[Summon] Stuck on Party screen. Clicking OK directly.');
                await this.controller.clickSafe('.btn-usual-ok', { fast: true });
                await sleep(800);
            }
        }

        // Check for Warning Popups (e.g., "Elixirs can't be used")
        if (await this.controller.elementExists('.pop-usual.pop-show', 100, true)) {
            if (await this.controller.elementExists('.pop-usual.pop-show .btn-usual-ok', 50, true)) {
                this.logger.warn('[Summon] Warning popup detected on Party screen. Clicking OK...');
                await this.controller.clickSafe('.pop-usual.pop-show .btn-usual-ok', { fast: true });
                await sleep(500);
            }
        }

        for (let i = 0; i < 15; i++) {
            if (this.raidErrorType !== null) return 'ended';
            const currentUrl = this.controller.page.url();

            if (currentUrl.includes('supporter_raid')) {
                // If we land on the full-page party selection screen, click the start button
                if (await this.controller.elementExists('.btn-usual-ok.se-quest-start', 100, true)) {
                    this.logger.info('[Summon] Party screen confirmed. Clicking OK...');
                    await this.controller.clickSafe('.btn-usual-ok.se-quest-start', { fast: true });
                    await sleep(500);
                }
            } else if (currentUrl.match(/#(?:raid|raid_multi)(?:\/|$)/) || currentUrl.includes('#result')) {
                return 'success';
            }

            const error = await this.battle.checkEarlyBattleEndPopup();
            if (error) {
                if (error.raidEnded) {
                    this.logger.info('[Raid] Raid already ended. Returning to backup page...');
                    return 'ended';
                }
                if (error.raidPending) {
                    return 'pending';
                }
                break;
            }
            await sleep(100);
        }

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
        if (!finalUrl.match(/#(?:raid|raid_multi)(?:\/|$)/) && !finalUrl.includes('#result')) {
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

        if (this.controller.network) {
            this.controller.network.off('raid:error', this.onRaidError);
        }

        this.controller.stop().catch(e => this.logger.warn('[Performance] Failed to stop controller', e));
        this.logger.info('[System] Shutdown requested');
        notifier.notifySessionComplete(this.profileId || 'p1', this.getStats()).catch(e => this.logger.debug('[Notifier] Failed to notify completion', e));
    }

    updateDetailStats(result) {
        if (!result) return;
        if (!this.totalTurns) this.totalTurns = 0;
        if (!this.battleCount) this.battleCount = 0;
        this.battleCount++;
        if (result.turns > 0) {
            this.totalTurns += result.turns;
        }
        if (result.honors > 0) {
            const gained = result.honors - this.lastEndHonor;
            if (gained > 0) {
                this.totalHonor += gained;
                this.logger.info(`[Summary] Honor gained this raid: +${gained.toLocaleString()} (Session total: ${this.totalHonor.toLocaleString()})`);
            }
            this.lastEndHonor = result.honors;
        }
        if (result.duration) {
            const ms = Math.floor(result.duration);
            this.battleTimes.push(ms);
            if (this.battleTimes.length > 50) this.battleTimes.shift();
            if (result.turns !== undefined) {
                if (!this.battleTurns) this.battleTurns = [];
                this.battleTurns.push(result.turns);
                if (this.battleTurns.length > 50) this.battleTurns.shift();
            }
            if (this.onBattleEnd) this.onBattleEnd(this.getStats());
        }
    }

    getAverageBattleTime() {
        if (this.battleTimes.length === 0) return 0;
        const sum = this.battleTimes.reduce((a, b) => a + b, 0);
        return Math.round(sum / this.battleTimes.length);
    }

    getStats() {
        let avgTurns = 0;
        if (this.battleCount > 0) {
            avgTurns = (this.totalTurns / this.battleCount).toFixed(1);
        }
        let rate = '0.0/h';
        const uptimeHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
        if (uptimeHours > 0) {
            const rph = this.raidsCompleted / uptimeHours;
            rate = `${rph.toFixed(1)}/h`;
        }
        return {
            completedQuests: this.raidsCompleted,
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
        await this.controller.gotoSPA(this.raidBackupUrl, { waitUntil: 'domcontentloaded' });
        return true;
    }
}

export default RaidBot;
