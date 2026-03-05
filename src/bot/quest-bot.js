import PageController from '../core/page-controller.js';
import BattleHandler from './battle-handler.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger, { createScopedLogger } from '../utils/logger.js';
import config from '../utils/config.js';
import notifier from '../utils/notifier.js';

class QuestBot {
    constructor(page, options = {}) {
        // Assign profileId and scoped logger FIRST so they're available to PageController
        this.profileId = options.profileId || config.get('profile_id') || 'p1';
        this.logger = createScopedLogger(this.profileId);

        this.controller = new PageController(page, this.logger);
        this.questUrl = options.questUrl || config.get('quest.url');
        this.maxQuests = options.maxQuests || 0; // 0 = unlimited
        this.battleMode = options.battleMode || 'full_auto';
        this.onBattleEnd = options.onBattleEnd || null;
        this.selectors = config.selectors.quest;
        this.battle = new BattleHandler(page, {
            fastRefresh: options.fastRefresh || false,
            logger: this.logger,
            controller: this.controller
        });

        // Enable performance optimizations
        if (options.blockResources) {
            this.logger.info('[System] Image blocking enabled');
            this.controller.enableResourceBlocking().catch(e => this.logger.warn('[System] Failed to enable image blocking', e));
        } else {
            this.logger.info('[System] Image blocking disabled');
        }

        this.questsCompleted = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.battleTimes = []; // Array to store battle durations
        this.battleTurns = []; // Array to store turn counts
        this.totalTurns = 0;
        this.battleCount = 0;

        this.raidErrorType = null;
        this.networkSupporterScreen = false; // Flag for supporter screen detection via network
        this.onRaidError = (info) => {
            this.logger.warn(`[Network] Join error detected: ${info.type}`);
            this.raidErrorType = info.type;
        };
        this.onSupporterScreen = () => {
            this.logger.debug('[Network] Supporter screen detected (BGM request)');
            this.networkSupporterScreen = true;
        };
    }

    async start() {
        this.isRunning = true;
        this.questsCompleted = 0;
        this.battleTimes = []; // Reset battle times on start
        this.battleTurns = []; // Reset battle turns on start
        this.raidErrorType = null;
        this.networkSupporterScreen = false; // Reset for new session
        this.startTime = Date.now();

        if (this.controller.network) {
            this.controller.network.on('raid:error', this.onRaidError);
            this.controller.network.on('raid:supporter_screen', this.onSupporterScreen);
        }

        this.logger.info('[Bot] Session started');

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(1000);
                    continue;
                }

                // Check quest limit
                if (this.maxQuests > 0 && this.questsCompleted >= this.maxQuests) {
                    this.logger.info(`[Status] Quest limit reached (${this.questsCompleted}/${this.maxQuests})`);
                    break;
                }

                const success = await this.runSingleQuest();
                if (success) {
                    this.questsCompleted++;
                }

                // Short delay between quests for browser stability
                await sleep(50);
            }
        } catch (error) {
            // Graceful exit on browser close/disconnect
            if (this.controller.isNetworkError(error) || error.message.includes('Target closed') || error.message.includes('Session closed')) {
                this.logger.info('[System] Session terminated (browser closed)');
            } else {
                this.logger.error('[Bot] Quest bot error:', error);
                notifier.notifyError(this.profileId || 'p1', error.message).catch(e => this.logger.debug('[Notifier] Failed to send error notification', e));
                throw error;
            }
        } finally {
            this.stop();
        }
    }

    async runSingleQuest() {
        this.logger.info(`[Quest] Initiating quest cycle (${this.questsCompleted + 1})`);

        // Pre-check: If already in battle, skip to battle execution
        const currentUrl = this.controller.page.url();
        const isInBattleUrl = currentUrl.match(/#(?:raid|raid_multi)(?:\/|$)/) !== null;

        if (isInBattleUrl) {
            // Check if battle UI is present (attack button or auto button)
            const hasBattleUI = await this.controller.page.evaluate(() => {
                const att = document.querySelector('.btn-attack-start');
                const auto = document.querySelector('.btn-auto, .btn-full-auto');
                const attVisible = att && (att.offsetWidth > 0 || att.classList.contains('display-on'));
                const autoVisible = auto && auto.offsetWidth > 0;
                return attVisible || autoVisible;
            }).catch(() => false);

            if (hasBattleUI) {
                this.logger.info('[Quest] Battle in progress detected. Skipping summon selection...');
                const result = await this.battle.executeBattle(this.battleMode);
                if (result && result.duration > 0) {
                    this.updateDetailStats(result);
                }
                this.logger.info('[Battle] Combat concluded');
                return true;
            }
        }

        // Check for Replicard URL
        const isReplicard = this.questUrl.includes('/replicard/');

        if (isReplicard) {
            await this.controller.gotoSPA(this.questUrl);
            await sleep(randomDelay(100, 200));
            const battleStarted = await this.startReplicardBattle();
            if (!battleStarted) {
                this.logger.warn('[Quest] Failed to initiate replicard battle. Retrying');
                return false;
            }
        } else {
            // Standard quest navigation
            this.networkSupporterScreen = false; // Reset for new quest
            await this.controller.gotoSPA(this.questUrl);
            // Delay to allow previous battle's result page detection to settle
            // This prevents race condition where old battle result is detected as error
            await sleep(randomDelay(200, 400));

            const summonStatus = await this.selectSummon();

            if (summonStatus === 'pending') {
                this.logger.info('[System] Pending battles detected. Initiating cleanup...');
                await this.clearPendingBattles();
                return false;
            }

            if (summonStatus !== 'success') {
                this.logger.warn(`[Quest] Summon selection failed (${summonStatus}). Retrying`);
                return false;
            }
        }

        // Safety: Check for captcha before starting battle
        if (await this.checkCaptcha()) {
            return false;
        }

        // Check if bot was stopped before starting battle
        if (!this.isRunning) {
            this.logger.debug('[System] Operation cancelled before combat initiation');
            return;
        }

        // Handle battle
        const result = await this.battle.executeBattle(this.battleMode);

        if (result && result.duration > 0) {
            this.updateDetailStats(result);
        }

        if (result?.raidPending) {
            this.logger.info('[Quest] Pending battles detected during combat. Initiating cleanup...');
            await this.clearPendingBattles();
        }

        this.logger.info('**[Battle]** Combat concluded');

        // Post-battle result page check - if on result page, skip to next cycle
        // The result page will be auto-dismissed when navigating to next quest
        await sleep(randomDelay(100, 200));
        const isResultPage = await this.controller.page.evaluate(() => {
            return window.location.hash.includes('#result') ||
                !!document.querySelector('.prt-result');
        }).catch(() => false);

        if (isResultPage) {
            this.logger.info('[Quest] Result page detected. Proceeding to next cycle...');
            return true; // Return success, next cycle will handle navigation
        }

        return true;
    }

    async startReplicardBattle() {
        this.logger.info('[Replicard] Engaging target');
        const monsterSelector = '.btn-monster.lis-monster';
        const okButton = '.btn-usual-ok';

        if (await this.controller.elementExists(monsterSelector, 5000)) {
            await this.controller.clickSafe(monsterSelector);
            await sleep(500);

            // Check for AP/Confirmation popup
            if (await this.controller.elementExists(okButton, 1000, true)) {
                await this.controller.clickSafe(okButton);
                await sleep(300);
            }

            // Select summon
            const summonStatus = await this.selectSummon();
            return summonStatus === 'success';
        }

        this.logger.warn('[Replicard] Target not found on page');
        return false;
    }

    async selectSummon() {
        this.logger.info('[Summon] Awaiting supporter selection');

        // Wait for supporter screen via network (BGM request) or DOM fallback
        // Timeout: 7 seconds
        const startTime = Date.now();
        const timeout = 7000;

        while (Date.now() - startTime < timeout) {
            // Check network flag first (fastest)
            if (this.networkSupporterScreen) {
                this.logger.debug('[Network] Supporter screen confirmed via BGM request');
                break;
            }

            // DOM fallback check
            const state = await this.controller.page.evaluate(() => {
                const results = {
                    listFound: !!document.querySelector('.prt-supporter-list'),
                    okFound: !!document.querySelector('.btn-usual-ok'),
                    isRaid: window.location.hash.match(/#(?:raid|raid_multi)(?:\/|$)/)
                };
                return results;
            }).catch(() => ({}));

            // Supporter screen loaded - proceed
            if (state.listFound || state.okFound) break;

            // Early exit if we're already in battle (quest URL may have redirected)
            if (state.isRaid) {
                this.logger.info('[Summon] Battle state detected. Skipping selection');
                return 'success';
            }

            await sleep(100);
        }

        // Check for error popups only (skip result page check for quests - stale elements from previous battle)
        const earlyError = await this.battle.checkEarlyBattleEndPopup(true);
        if (earlyError) {
            if (earlyError.raidPending) return 'pending';
            return 'ended';
        }

        const okFound = await this.controller.elementExists('.btn-usual-ok', 300, true);
        if (okFound) {
            // Reuse earlyError result if popup state hasn't changed
            if (earlyError) {
                if (earlyError.raidPending) return 'pending';
                return 'ended';
            }

            this.logger.info('[Summon] Confirming selection');
            await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1, fast: true }).catch(() => { });
            await sleep(50);
            return await this.validatePostClick();
        }

        const summonSelector = '.prt-supporter-detail';
        if (await this.controller.elementExists(summonSelector, 3000, true)) {
            this.logger.info('[Summon] Supporter selected');

            try {
                await this.controller.clickSafe(summonSelector, { timeout: 2000, maxRetries: 1 });
            } catch (error) {
                const url = this.controller.page.url();
                if (url.match(/#(?:raid|raid_multi)(?:\/|$)/)) return 'success';
                throw error;
            }

            if (await this.controller.elementExists('.btn-usual-ok', 1500, true)) {
                this.logger.info('[Summon] Confirming selection...');
                await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1, fast: true }).catch(() => { });
                await sleep(50);
            }

            return await this.validatePostClick();
        }

        this.logger.warn('[Summon] No supporter or party selection available');
        return 'failed';
    }

    async validatePostClick() {
        if (await this.checkCaptcha()) return 'captcha';

        // Consolidate popup checks into single evaluate
        const popupState = await this.controller.page.evaluate(() => {
            const results = {};
            if (document.querySelector('.pop-deck.pop-show')) results.deck = true;
            if (document.querySelector('.prt-deck')) results.party = true;
            if (document.querySelector('.btn-usual-ok')) results.ok = true;
            if (document.querySelector('.pop-usual.pop-show')) results.warning = true;
            return results;
        }).catch(() => ({}));

        if (popupState.deck) {
            this.logger.warn('[Summon] Deck selection popup detected. Dismissing...');
            await this.controller.clickSafe('.pop-deck.pop-show .btn-usual-ok', { silent: true });
            await sleep(800);
        } else if (popupState.party && popupState.ok) {
            this.logger.warn('[Summon] Party selection popup detected. Dismissing...');
            await this.controller.clickSafe('.btn-usual-ok', { fast: true, timeout: 1000, maxRetries: 1 });
            await sleep(800);
        } else if (popupState.warning && popupState.ok) {
            this.logger.warn('[Summon] Warning popup detected. Dismissing...');
            await this.controller.clickSafe('.btn-usual-ok', { fast: true, timeout: 1000, maxRetries: 1 });
            await sleep(800);
        }

        // Wait for URL transition - Reduced iterations and delay for faster completion
        for (let i = 0; i < 10; i++) {
            if (this.raidErrorType !== null) {
                const type = this.raidErrorType;
                this.raidErrorType = null;
                if (type === 'pending') return 'pending';
                return 'ended';
            }

            // Consolidate all state checks into single evaluate
            const state = await this.controller.page.evaluate(() => {
                const hash = window.location.hash;
                const url = window.location.href;
                return {
                    isRaid: !!hash.match(/#(?:raid|raid_multi)(?:\/|$)/),
                    isResult: hash.includes('#result') || !!document.querySelector('.prt-result'),
                    isParty: url.includes('supporter_raid'),
                    startBtn: !!document.querySelector('.btn-usual-ok.se-quest-start')
                };
            }).catch(() => ({}));

            if (state.isRaid || state.isResult) {
                return 'success';
            }

            if (state.isParty && state.startBtn) {
                this.logger.info('[Summon] Party selection confirmed. Finalizing...');
                await this.controller.clickSafe('.btn-usual-ok.se-quest-start', { fast: true });
                await sleep(300);
            }

            await sleep(200);
        }

        // Final logout check
        const isLoggedOut = await this.controller.page.evaluate(() => {
            const hasLogin = !!document.querySelector('#login-auth');
            const isHome = window.location.href.includes('#mypage') || window.location.href.includes('#top');
            return hasLogin || isHome;
        });

        if (isLoggedOut) {
            this.logger.error('[Safety] Session expired. Stopping bot');
            this.stop();
            return 'ended';
        }

        const finalUrl = this.controller.page.url();
        if (!finalUrl.match(/#(?:raid|raid_multi|quest\/index)(?:\/|$)/) && !finalUrl.includes('#result')) {
            this.logger.warn('[Status] URL transition failed. Potential error state');
            return 'ended';
        }

        return 'success';
    }

    async clearPendingBattles() {
        const unclaimedUrl = 'https://game.granbluefantasy.jp/#quest/assist/unclaimed/0/0';
        const entrySelector = config.selectors.raid.unclaimedRaidEntry;

        this.logger.info('[System] Initiating pending battle clearance');

        let clearedCount = 0;
        const maxToClear = 10;

        while (clearedCount < maxToClear && this.isRunning) {
            await this.controller.gotoSPA(unclaimedUrl);
            await sleep(randomDelay(100, 300));

            const hasEntries = await this.controller.elementExists(entrySelector, 3000);
            if (!hasEntries) {
                this.logger.info('[Quest] Pending battles cleared');
                break;
            }

            this.logger.info(`[Quest] Processing unclaimed raid #${clearedCount + 1}`);
            try {
                await this.controller.clickSafe(entrySelector);
                const okButtonSelector = '.btn-usual-ok';
                const foundOk = await this.controller.elementExists(okButtonSelector, 10000);
                if (foundOk) {
                    this.logger.info('[Quest] Result processed');
                    await sleep(500);
                } else {
                    this.logger.warn('[System] OK button timeout. Proceeding');
                }
                clearedCount++;
            } catch (error) {
                this.logger.error('[Error] Failed to process unclaimed raid', error);
                break;
            }
        }
        this.logger.info(`[Quest] Pending battle clearance complete (${clearedCount} cleared)`);
    }

    async checkEarlyBattleEndPopup() {
        return await this.battle.checkEarlyBattleEndPopup(true);
    }

    async checkCaptcha() {
        const selectors = config.selectors.battle;
        if (await this.controller.elementExists(selectors.captchaPopup, 1000, true)) {
            const headerText = await this.controller.getText(selectors.captchaHeader);
            if (headerText.includes('Access Verification')) {
                this.logger.error('[Safety] CAPTCHA detected. Human intervention required');
                notifier.notifyCaptcha(this.profileId || 'p1').catch(() => { });
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
        if (this.controller && this.controller.network) {
            this.controller.network.removeListener('raid:error', this.onRaidError);
            this.controller.network.removeListener('raid:supporter_screen', this.onSupporterScreen);
        }
        if (this.battle) {
            this.battle.stop();
        }
        this.controller.stop().catch(() => { });
        this.logger.info('[System] Shutdown initiated');
        notifier.notifySessionComplete(this.profileId || 'p1', this.getStats()).catch(() => { });
    }

    updateDetailStats(result) {
        if (!result) return;
        if (!this.totalTurns) this.totalTurns = 0;
        if (!this.battleCount) this.battleCount = 0;

        this.battleCount++;
        if (typeof result.turns === 'number' && result.turns > 0) this.totalTurns += result.turns;
        if (result.duration) {
            this.battleTimes.push(Math.floor(result.duration));
            if (this.battleTimes.length > 50) this.battleTimes.shift();
            if (result.turns !== undefined) {
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
        const now = Date.now();
        const uptimeHours = (now - this.startTime) / (1000 * 60 * 60);
        if (uptimeHours > 0) {
            const rph = this.questsCompleted / uptimeHours;
            rate = `${rph.toFixed(1)}/h`;
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
