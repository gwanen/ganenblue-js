import PageController from '../core/page-controller.js';
import BattleHandler from './battle-handler.js';
import { sleep, randomDelay } from '../utils/random.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';

class RaidBot {
    constructor(page, options = {}) {
        this.controller = new PageController(page);
        this.battle = new BattleHandler(page);
        this.raidBackupUrl = 'https://game.granbluefantasy.jp/#quest/assist';
        this.maxRaids = options.maxRaids || 0; // 0 = unlimited
        this.battleMode = options.battleMode || 'full_auto';
        this.honorTarget = options.honorTarget || 0;
        this.selectors = config.selectors.raid;

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

        // Set viewport to optimal resolution for farming
        await this.controller.page.setViewport({ width: 1000, height: 1799 });
        logger.info('[Core] Set viewport to 1000x1799');

        logger.info('[Bot] Bot started. Good luck!');
        logger.info(`[Bot] Target: ${this.maxRaids === 0 ? 'Unlimited' : this.maxRaids} raids`);

        try {
            while (this.isRunning) {
                if (this.isPaused) {
                    await sleep(1000);
                    continue;
                }

                // Check raid limit
                if (this.maxRaids > 0 && this.raidsCompleted >= this.maxRaids) {
                    logger.info(`[Bot] Raid limit reached: ${this.raidsCompleted}/${this.maxRaids}`);
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
            logger.error('[Error] [Bot] Raid bot error:', error);
            throw error;
        } finally {
            this.isRunning = false;
        }
    }

    async runSingleRaid() {
        logger.info(`[Raid] Searching for backups (${this.raidsCompleted + 1})...`);

        // Try to find and join a raid
        const joined = await this.findAndJoinRaid();

        if (!joined) {
            logger.warn('[Raid] Failed to join raid, will retry');
            return;
        }

        // Select summon
        const summonStatus = await this.selectSummon();

        if (summonStatus === 'ended') {
            return false;
        }

        // Check if bot was stopped before starting battle
        if (!this.isRunning) {
            logger.info('[Bot] Stopped before battle execution');
            return;
        }

        // Handle battle
        const result = await this.battle.executeBattle(this.battleMode, { honorTarget: this.honorTarget });

        if (result?.raidEnded) {
            return false;
        }

        this.updateDetailStats(result);

        // Store battle time and turns
        if (this.battle.lastBattleDuration > 0) {
            this.battleTimes.push(this.battle.lastBattleDuration);
            this.battleTurns.push(result.turns || 0);
        }

        logger.info('[Cleared] Victory!');
        return true;
    }

    async findAndJoinRaid() {
        // Navigate to raid backup page
        logger.info('[Raid] Navigating to backup page...');
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
                    logger.info('[Wait] Pending battles detected. Clearing...');
                    await this.clearPendingBattles();
                    // After clearing, return to backup page
                    await this.controller.goto(this.raidBackupUrl);
                    await sleep(randomDelay(1500, 2500));
                    continue;
                }

                logger.info('[Wait] Error popup detected, refreshing page...');
                await this.controller.page.reload();
                await sleep(randomDelay(1500, 2500));
                continue;
            }

            // Look for raid entries with class "btn-multi-raid lis-raid search"
            const raidSelector = '.btn-multi-raid.lis-raid.search';

            if (await this.controller.elementExists(raidSelector, 2000)) {
                logger.info('[Raid] Found raid entry, clicking...');

                try {
                    await this.controller.clickSafe(raidSelector);
                    await sleep(randomDelay(1500, 2500));

                    // Check if we successfully joined (moved to summon screen or battle)
                    const currentUrl = this.controller.page.url();
                    const onSummonScreen = await this.controller.elementExists('.prt-supporter-list', 3000);
                    const inBattle = currentUrl.includes('#raid') || currentUrl.includes('_raid');

                    if (onSummonScreen || inBattle) {
                        logger.info('[Raid] Successfully joined raid');
                        return true;
                    }

                    // Check for error popup after clicking
                    const clickError = await this.handleErrorPopup();
                    if (clickError.detected) {
                        if (clickError.text.includes('pending battles')) {
                            logger.info('[Wait] Pending battles detected after click. Clearing...');
                            await this.clearPendingBattles();
                            await this.controller.goto(this.raidBackupUrl);
                            await sleep(randomDelay(1500, 2500));
                            continue;
                        }

                        logger.warn('[Wait] Raid was full or unavailable, refreshing...');
                        await this.controller.page.reload();
                        await sleep(randomDelay(1500, 2500));
                        continue;
                    }

                    // Unknown state, refresh and retry
                    logger.warn('[Wait] Unknown state after clicking raid, refreshing...');
                    await this.controller.page.reload();
                    await sleep(randomDelay(1500, 2500));

                } catch (error) {
                    logger.error('[Error] [Raid] Error clicking raid entry:', error);
                    await this.controller.page.reload();
                    await sleep(randomDelay(1500, 2500));
                }

            } else {
                // No raids available, wait and refresh
                logger.info('[Raid] No raids available, waiting 5 seconds...');
                await sleep(5000);

                logger.info('[Raid] Refreshing page...');
                await this.controller.page.reload();
                await sleep(randomDelay(1500, 2500));
            }
        }

        logger.warn(`[Wait] [Raid] Failed to join raid after ${attempts} attempts`);
        return false;
    }

    async handleErrorPopup() {
        // Check for error popup with class "prt-popup-footer" containing "btn-usual-ok"
        const errorPopupSelector = '.prt-popup-footer .btn-usual-ok';
        const bodySelector = '.txt-popup-body';

        if (await this.controller.elementExists(errorPopupSelector, 1000)) {
            // Get error text
            const errorText = await this.controller.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.innerText : '';
            }, bodySelector);

            logger.info(`[Wait] Error popup detected: ${errorText.trim()}`);

            try {
                await this.controller.clickSafe(errorPopupSelector);
                await sleep(1000);
            } catch (error) {
                logger.warn('[Wait] Failed to click error popup OK button:', error);
            }
            return { detected: true, text: errorText.toLowerCase() };
        }

        return { detected: false, text: '' };
    }

    async clearPendingBattles() {
        const unclaimedUrl = this.selectors.unclaimedRaidUrl || 'https://game.granbluefantasy.jp/#quest/assist/unclaimed/0/0';
        const entrySelector = this.selectors.unclaimedRaidEntry || '.btn-multi-raid.lis-raid';

        logger.info('[Raid] Starting to clear pending battles...');

        let clearedCount = 0;
        const maxToClear = 10; // safety limit

        while (clearedCount < maxToClear && this.isRunning) {
            await this.controller.goto(unclaimedUrl);
            await sleep(randomDelay(1500, 2500));

            const hasEntries = await this.controller.elementExists(entrySelector, 3000);
            if (!hasEntries) {
                logger.info('[Raid] No more pending battles found.');
                break;
            }

            logger.info(`[Raid] Clearing unclaimed raid #${clearedCount + 1}...`);
            try {
                await this.controller.clickSafe(entrySelector);
                // Wait for either the result page to load or we are redirected
                // We wait for the OK button which usually appears on result screens
                const okButtonSelector = '.btn-usual-ok';
                logger.info('[Wait] Waiting for result page...');

                // Wait up to 10 seconds for the OK button to appear
                const foundOk = await this.controller.elementExists(okButtonSelector, 10000);
                if (foundOk) {
                    logger.info('[Raid] Result processed.');
                    // Optional: tiny delay to ensure state is saved
                    await sleep(500);
                } else {
                    logger.warn('[Wait] OK button not found within 10s, proceeding anyway...');
                }

                clearedCount++;
            } catch (error) {
                logger.error('[Error] Failed to click unclaimed raid:', error);
                break;
            }
        }

        logger.info(`[Raid] Finished clearing ${clearedCount} pending battles.`);
    }

    async selectSummon() {
        logger.info('[Summon] Selecting supporter...');

        // Wait for summon screen
        let retryCount = 0;
        while (retryCount < 3) {
            if (await this.controller.elementExists('.prt-supporter-list', 5000)) {
                break;
            }
            logger.warn('[Wait] [Summon] screen not found, retrying...');
            retryCount++;
            await sleep(1000);
        }

        // Check for confirmation popup (General or Raid Ended)
        if (await this.controller.elementExists('.btn-usual-ok')) {
            // Specific check for ended raid popup body
            const popupText = await this.controller.page.evaluate(() => {
                const body = document.querySelector('.txt-popup-body');
                return body ? body.innerText : '';
            });

            if (popupText.includes('already ended')) {
                logger.info('[Raid] Battle already ended (during summon selection).');
                await this.controller.clickSafe('.btn-usual-ok');
                await sleep(1000);
                return 'ended';
            }

            logger.info('[Wait] Found confirmation popup, clicking OK...');
            await this.controller.clickSafe('.btn-usual-ok');
            await sleep(1500);

            // Check if we moved to battle (exclude supporter screen false positives)
            const currentUrl = this.controller.page.url();
            if (currentUrl.includes('#raid') && !currentUrl.includes('supporter')) {
                logger.info('[Bot] Moved to battle screen, skipping summon selection.');
                return 'success';
            }
        }

        // Try to select first available summon
        const summonSelector = '.prt-supporter-detail';
        if (await this.controller.elementExists(summonSelector)) {
            logger.info('[Summon] Found supporter, clicking...');
            await this.controller.clickSafe(summonSelector);
            // EST: Reduced delay for speed (0.2-0.5s)
            await sleep(randomDelay(200, 500));

            // Check for start confirmation popup
            if (await this.controller.elementExists('.btn-usual-ok')) {
                logger.info('[Wait] Found start confirmation popup, clicking OK...');
                await this.controller.clickSafe('.btn-usual-ok');
            }

            return;
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
                await sleep(randomDelay(500, 1000));

                if (await this.controller.elementExists('.btn-usual-ok')) {
                    await this.controller.clickSafe('.btn-usual-ok');
                }
                return;
            }
        }

        logger.warn('[Wait] [Summon] No supporters available, proceeding anyway');
    }

    pause() {
        this.isPaused = true;
        logger.info('[Bot] Raid Bot paused');
    }

    resume() {
        this.isPaused = false;
        logger.info('[Bot] Raid Bot resumed');
    }

    stop() {
        this.isRunning = false;
        if (this.battle) {
            this.battle.stop();
        }
        logger.info('[Bot] Raid Bot stop requested');
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
            battleCount: this.battleCount || 0
        };
    }
}

export default RaidBot;
