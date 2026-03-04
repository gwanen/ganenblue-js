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
            this.logger.info('[System] Image blocking: ENABLED');
            this.controller.enableResourceBlocking().catch(e => this.logger.warn('[System] Failed to enable resource blocking', e));
        } else {
            this.logger.info('[System] Image blocking: DISABLED');
        }

        this.questsCompleted = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.battleTimes = []; // Array to store battle durations
        this.battleTurns = []; // Array to store turn counts

        this.raidErrorType = null;
        this.onRaidError = (info) => {
            this.logger.warn(`[Network] Deck or Join error detected: ${info.type}`);
            this.raidErrorType = info.type;
        };
    }

    async start() {
        this.isRunning = true;
        this.questsCompleted = 0;
        this.battleTimes = []; // Reset battle times on start
        this.battleTurns = []; // Reset battle turns on start
        this.raidErrorType = null;
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

                // Check quest limit
                if (this.maxQuests > 0 && this.questsCompleted >= this.maxQuests) {
                    this.logger.info(`[Status] Quest limit reached: ${this.questsCompleted}/${this.maxQuests}`);
                    break;
                }

                const success = await this.runSingleQuest();
                if (success) {
                    this.questsCompleted++;
                }

                // Short delay between quests - balanced for browser health
                await sleep(50);
            }
        } catch (error) {
            // Graceful exit on browser close/disconnect
            if (this.controller.isNetworkError(error) || error.message.includes('Target closed') || error.message.includes('Session closed')) {
                this.logger.info('[System] Session terminated (Browser closed)');
            } else {
                this.logger.error('[Error] [Bot] Quest bot error:', error);
                notifier.notifyError(this.profileId || 'p1', error.message).catch(e => this.logger.debug('[Notifier] Failed to notify error', e));
                throw error;
            }
        } finally {
            this.stop();
        }
    }

    async runSingleQuest() {
        this.logger.info(`[Quest] Starting quest (${this.questsCompleted + 1})`);

        // Check for Replicard URL
        const isReplicard = this.questUrl.includes('/replicard/');

        if (isReplicard) {
            await this.controller.gotoSPA(this.questUrl);
            await sleep(randomDelay(100, 300));
            const battleStarted = await this.startReplicardBattle();
            if (!battleStarted) {
                this.logger.warn('[Quest] Failed to start replicard battle. Retrying');
                return false;
            }
        } else {
            // Standard quest navigation
            await this.controller.gotoSPA(this.questUrl);
            await sleep(randomDelay(100, 300));

            const summonStatus = await this.selectSummon();

            if (summonStatus === 'pending') {
                this.logger.info('[System] Pending battles detected. Initializing cleanup...');
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
            this.logger.info('[Quest] Pending battles detected during battle. Initializing cleanup...');
            await this.clearPendingBattles();
        }

        this.logger.info('[Battle] Combat concluded');
        return true;
    }

    async startReplicardBattle() {
        this.logger.info('[Replicard] Engaging monster');
        const monsterSelector = '.btn-monster.lis-monster';
        const okButton = '.btn-usual-ok';

        if (await this.controller.elementExists(monsterSelector, 5000)) {
            await this.controller.clickSafe(monsterSelector);
            await sleep(800);

            // Check for AP/Confirmation popup
            if (await this.controller.elementExists(okButton, 1000, true)) {
                await this.controller.clickSafe(okButton);
                await sleep(500);
            }

            // Select summon
            const summonStatus = await this.selectSummon();
            return summonStatus === 'success';
        }

        this.logger.warn('[Replicard] Monster not found on page');
        return false;
    }

    async selectSummon() {
        this.logger.info('[Summon] Selecting supporter');

        // Check for early error popup
        const earlyError = await this.checkEarlyBattleEndPopup();
        if (earlyError) {
            if (earlyError.raidPending) return 'pending';
            return 'ended';
        }

        // Wait for summon screen - Optimized with single evaluate check
        let retryCount = 0;
        while (retryCount < 50) {
            const state = await this.controller.page.evaluate(() => {
                const results = {
                    listFound: !!document.querySelector('.prt-supporter-list'),
                    okFound: !!document.querySelector('.btn-usual-ok'),
                    isResult: window.location.hash.includes('#result') || !!document.querySelector('.prt-result'),
                    isRaid: window.location.hash.match(/#(?:raid|raid_multi)(?:\/|$)/)
                };
                return results;
            }).catch(() => ({}));

            if (state.listFound || state.okFound) break;

            if (state.isResult) {
                this.logger.info('[Summon] Redirected or battle ended early detected');
                return 'ended';
            }

            if (state.isRaid) {
                this.logger.info('[Summon] Already in battle, skipping selection');
                return 'success';
            }

            retryCount++;
            await sleep(300);
        }

        const okFound = await this.controller.elementExists('.btn-usual-ok', 300, true);
        if (okFound) {
            const error = await this.checkEarlyBattleEndPopup();
            if (error) {
                if (error.raidPending) return 'pending';
                return 'ended';
            }

            this.logger.info('[Summon] Clicking confirmation');
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
                this.logger.info('[Summon] Clicking confirmation...');
                await this.controller.clickSafe('.btn-usual-ok', { timeout: 1000, maxRetries: 1, fast: true }).catch(() => { });
                await sleep(50);
            }

            return await this.validatePostClick();
        }

        this.logger.warn('[Summon] No supporter or party selection found');
        return 'failed';
    }

    async validatePostClick() {
        if (await this.checkCaptcha()) return 'captcha';

        // Consolidate multiple popup checks to save IPC
        const popupState = await this.controller.page.evaluate(() => {
            const results = {};
            if (document.querySelector('.pop-deck.pop-show')) results.deck = true;
            if (document.querySelector('.prt-deck')) results.party = true;
            if (document.querySelector('.btn-usual-ok')) results.ok = true;
            if (document.querySelector('.pop-usual.pop-show')) results.warning = true;
            return results;
        }).catch(() => ({}));

        if (popupState.deck) {
            this.logger.warn('[Summon] Stuck on Deck Popup. Clicking OK directly.');
            await this.controller.clickSafe('.pop-deck.pop-show .btn-usual-ok', { silent: true });
            await sleep(800);
        } else if (popupState.party && popupState.ok) {
            this.logger.warn('[Summon] Stuck on Party screen. Clicking OK directly.');
            await this.controller.clickSafe('.btn-usual-ok', { fast: true, timeout: 1000, maxRetries: 1 });
            await sleep(800);
        } else if (popupState.warning && popupState.ok) {
            this.logger.warn('[Summon] Warning popup detected. Clicking OK...');
            await this.controller.clickSafe('.btn-usual-ok', { fast: true, timeout: 1000, maxRetries: 1 });
            await sleep(800);
        }

        // Wait for URL transition - Optimized for IPC relief
        for (let i = 0; i < 15; i++) {
            if (this.raidErrorType !== null) {
                const type = this.raidErrorType;
                this.raidErrorType = null;
                if (type === 'pending') return 'pending';
                return 'ended';
            }

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
                this.logger.info('[Summon] Party screen confirmed. Clicking OK...');
                await this.controller.clickSafe('.btn-usual-ok.se-quest-start', { fast: true });
                await sleep(500);
            }

            await sleep(300);
        }

        const isLoggedOut = await this.controller.page.evaluate(() => {
            const hasLogin = !!document.querySelector('#login-auth');
            const isHome = window.location.href.includes('#mypage') || window.location.href.includes('#top');
            return hasLogin || isHome;
        });

        if (isLoggedOut) {
            this.logger.error('[Safety] Session expired. Stopping');
            this.stop();
            return 'ended';
        }

        const finalUrl = this.controller.page.url();
        if (!finalUrl.match(/#(?:raid|raid_multi|quest\/index)(?:\/|$)/) && !finalUrl.includes('#result')) {
            this.logger.warn('[Status] URL did not transition to battle. Potential error');
            return 'ended';
        }

        return 'success';
    }

    async clearPendingBattles() {
        const unclaimedUrl = 'https://game.granbluefantasy.jp/#quest/assist/unclaimed/0/0';
        const entrySelector = config.selectors.raid.unclaimedRaidEntry;

        this.logger.info('[System] Initializing pending battle clearance...');

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

            this.logger.info(`[Quest] Clearing unclaimed raid #${clearedCount + 1}`);
            try {
                await this.controller.clickSafe(entrySelector);
                const okButtonSelector = '.btn-usual-ok';
                const foundOk = await this.controller.elementExists(okButtonSelector, 10000);
                if (foundOk) {
                    this.logger.info('[Quest] Result processed');
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
        this.logger.info(`[Quest] Finished clearing ${clearedCount} pending battles`);
    }

    async checkEarlyBattleEndPopup() {
        return await this.battle.checkEarlyBattleEndPopup();
    }

    async checkCaptcha() {
        const selectors = config.selectors.battle;
        if (await this.controller.elementExists(selectors.captchaPopup, 1000, true)) {
            const headerText = await this.controller.getText(selectors.captchaHeader);
            if (headerText.includes('Access Verification')) {
                this.logger.error('[Safety] Captcha detected. Human intervention required');
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
            this.controller.network.off('raid:error', this.onRaidError);
        }
        if (this.battle) {
            this.battle.stop();
        }
        this.controller.stop().catch(() => { });
        this.logger.info('[System] Shutdown requested');
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
