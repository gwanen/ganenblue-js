import PageController from "../core/page-controller.js";
import BattleHandler from "./battle-handler.js";
import { sleep, randomDelay } from "../utils/random.js";
import logger, { createScopedLogger } from "../utils/logger.js";
import config from "../utils/config.js";
import notifier from "../utils/notifier.js";

/**
 * Orchestrates raid-specific bot logic, including list scanning, supporter selection,
 * loot tracking, and recovery from common raid-entry errors.
 */
class RaidBot {
    /**
     * @param {import('puppeteer').Page} page - The current browser page.
     * @param {object} [options={}] - Bot configuration parameters.
     */
    constructor(page, options = {}) {
        this.profileId = options.profileId || config.get("profile_id") || "p1";
        this.logger = createScopedLogger(this.profileId);
        this.controller = new PageController(page, this.logger);
        this.raidBackupUrl = "https://game.granbluefantasy.jp/#quest/assist";
        this.maxRaids = options.maxRaids || 0;
        this.battleMode = options.battleMode || "full_auto";
        this.honorTarget = options.honorTarget || 0;
        this.targetUser = options.targetUser || null;
        this.onBattleEnd = options.onBattleEnd || null;
        this.refreshOnStart = options.refreshOnStart !== undefined ? options.refreshOnStart : true;
        this.selectors = config.selectors.raid;

        this.battle = new BattleHandler(page, {
            fastRefresh: options.fastRefresh || false,
            summonRefresh: options.summonRefresh !== undefined ? options.summonRefresh : true,
            skillRefresh: options.skillRefresh !== undefined ? options.skillRefresh : false,
            preBattleAutoAttack: options.preBattleAutoAttack || "off",
            logger: this.logger,
            controller: this.controller,
        });

        // Initialize session state
        this.raidsCompleted = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.battleTimes = [];
        this.battleTurns = [];
        this.lastEndHonor = 0;
        this.totalHonor = 0;
        this.redChests = 0;
        this.blueChests = 0;
        this.goldBricks = 0;
        this._lastProcessedRewardsHash = null;

        // --- Performance Optimizations ---
        const blockResources = options.blockResources !== undefined
            ? options.blockResources
            : config.get('stealth.block_resources', false);

        if (blockResources) {
            this.logger.info("[System] Image blocking enabled");
            this.controller.enableResourceBlocking().catch((e) =>
                this.logger.warn("[System] Failed to enable image blocking", e)
            );
        }

        const turboMode = options.turboMode !== undefined
            ? options.turboMode
            : config.get('stealth.turbo_css', true);

        if (turboMode) {
            this.controller.enableTurboCSS().catch((e) =>
                this.logger.warn("[System] Failed to enable turbo CSS", e)
            );
        }

        // --- Network Event Binding ---
        this.raidErrorType = null;
        this.networkBattleStarted = false;
        this.networkSupporterScreen = false;
        this.onRaidError = this._onRaidError.bind(this);
        this.onBattleStart = this._onBattleStart.bind(this);
        this.onSupporterScreen = this._onSupporterScreen.bind(this);
        this.onBattleResult = this._onBattleResult.bind(this);
    }

  _onBattleResult({ rewards }) {
    if (!rewards?.reward_list) {
      if (rewards) this.logger.warn("[Loot] Rewards present but reward_list missing — no chests counted");
      return;
    }

    // Dedup: Prevent double-counting when both session listener and direct call process same rewards
    const rl = rewards.reward_list;
    const rewardsHash = `${Object.keys(rl).sort().join(',')}|${JSON.stringify(rl).length}`;
    if (rewardsHash === this._lastProcessedRewardsHash) {
      this.logger.debug("[Loot] Rewards already processed (skipping duplicate)");
      return;
    }

    if (rl["4"] && !Array.isArray(rl["4"]) && typeof rl["4"] === "object") {
      const count = Object.keys(rl["4"]).length;
      this.redChests += count;
      if (count > 0) this.logger.info(`[Loot] Red Chests: +${count} (Total: ${this.redChests})`);
    }
    if (rl["11"] && !Array.isArray(rl["11"]) && typeof rl["11"] === "object") {
      const count = Object.keys(rl["11"]).length;
      this.blueChests += count;
      if (count > 0) this.logger.info(`[Loot] Blue Chests: +${count} (Total: ${this.blueChests})`);
    }
    for (const bucket of Object.values(rl)) {
      if (bucket && !Array.isArray(bucket) && typeof bucket === "object") {
        for (const item of Object.values(bucket)) {
          if (item?.name === "Gold Brick") {
            const qty = parseInt(item.count) || 1;
            this.goldBricks += qty;
            this.logger.info(`[Loot] Gold Brick: +${qty} (Total: ${this.goldBricks})`);
          }
        }
      }
    }

    this._lastProcessedRewardsHash = rewardsHash;
  }

  _onSupporterScreen() {
    this.logger.debug("[Network] Supporter screen detected via network");
    this.networkSupporterScreen = true;
  }

  _onBattleStart({ turn }) {
    this.logger.debug(`[Network] Battle start detected (Turn ${turn})`);
    this.networkBattleStarted = true;
  }

  _onRaidError(info) {
    this.logger.warn(
      `[Network] Raid entry failed: ${info.type}. Triggering fast fallback...`,
    );
    this.raidErrorType = info.type;
  }

    /**
     * Polls for network-detected raid entry errors.
     * @param {number} [timeout] - Search duration in ms (defaults to config value).
     * @returns {Promise<boolean>} True if an error was detected.
     */
    async waitForRaidError(timeout = null) {
        const defaultTimeout = config.get("timeouts.raid.error_detection", 3000);
        timeout = timeout ?? defaultTimeout;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (this.raidErrorType !== null || !this.isRunning) return true;
            await sleep(100);
        }
        return false;
    }

    /**
     * Attempts to recover from a raid join error by refreshing or navigating back.
     * Logic is context-aware based on the specific error type.
     */
    async recoverFromJoinError() {
    const errorType = this.raidErrorType;
    const currentUrl = this.controller.page?.url() || '';
    const isOnAssistPage = currentUrl.includes("#quest/assist");

    // Dismiss any lingering error popups before navigating/reloading
    await this.controller
      .clickSafe(".btn-usual-ok", {
        silent: true,
        fast: true,
        timeout: config.get("timeouts.raid.element_click", 1000),
        maxRetries: 1,
      })
      .catch(() => {});

    // Logic refined: check_multi_start failures trigger refresh.
    // All others (initial join, deck create) navigate back.
    if (errorType === "check_multi_start" || isOnAssistPage) {
      this.logger.warn(
        `[Raid] Join failed (${errorType || "UI"}). Performing fast refresh...`,
      );
      await this.controller.reloadPage();
    } else {
      this.logger.warn(
        `[Raid] Join failed (${errorType}). Returning to assist page...`,
      );
      await this.controller.gotoSPA(this.raidBackupUrl);
    }
    await sleep(config.get("timeouts.raid.page_transition", 200));
  }

    /**
     * Starts the bot's main loop.
     */
    async start() {
        this.isRunning = true;
        this.raidsCompleted = 0;
        this.battleTimes = [];
        this.battleTurns = [];
        this.lastEndHonor = 0;
        this.totalHonor = 0;
        this.redChests = 0;
        this.blueChests = 0;
        this.goldBricks = 0;
        this.startTime = Date.now();

    try {
        if (this.controller.network) {
            this.controller.network.on("raid:error", this.onRaidError);
            this.controller.network.on("battle:start", this.onBattleStart);
            this.controller.network.on("raid:supporter_screen", this.onSupporterScreen);
            this.controller.network.on("battle:result", this.onBattleResult);
        }

        this.logger.info("[Bot] Session started");

        while (this.isRunning) {
          if (this.isPaused) {
            await sleep(1000);
            continue;
          }

          // Check raid limit
          if (this.maxRaids > 0 && this.raidsCompleted >= this.maxRaids) {
            this.logger.info(
              `[Raid] Limit reached: ${this.raidsCompleted}/${this.maxRaids}`,
            );
            break;
          }

          let success = false;
          try {
            success = await this.runSingleRaid();
          } catch (cycleError) {
            if (this.controller.isNetworkError(cycleError)) {
              this.logger.warn(
                `[Raid] Transient error during cycle. Retrying: ${cycleError.message}`,
              );
              await sleep(500);
              continue;
            }
            throw cycleError; // Re-throw fatal errors
          }
          if (success) {
            this.raidsCompleted++;

            if (this.raidsCompleted % 50 === 0) {
              await this.controller.clearBrowserCache();
            }
          }

          // Short delay between raids - balanced for browser health
          await sleep(50);
        }
    } catch (error) {
        // Graceful exit on browser close/disconnect
        if (
          this.controller.isNetworkError(error) ||
          error.message.includes("Target closed") ||
          error.message.includes("Session closed")
        ) {
          this.logger.info("[System] Session terminated (Browser closed)");
        } else {
          this.logger.error("[Error] [Bot] Raid bot error:", error);
          notifier
            .notifyError(this.profileId || "p1", error.message)
            .catch((e) =>
              this.logger.debug("[Notifier] Failed to notify error", e),
            );
          throw error;
        }
    } finally {
        this.stop();
    }
  }

  async runSingleRaid() {
    this.logger.info(`[Raid] Searching for raids (${this.raidsCompleted + 1})`);
    this.raidErrorType = null; // Reset error for new cycle
    this.networkBattleStarted = false; // Reset for new raid
    this.networkSupporterScreen = false; // Reset for new raid
    this._lastProcessedRewardsHash = null; // Reset dedup for new battle

    // Try to find and join a raid
    const joined = await this.findAndJoinRaid();

    if (!joined) {
      this.logger.warn("[Raid] Failed to join raid");
      return;
    }

    // Select summon
    const currentUrl = this.controller.page.url();
    const isResult =
      currentUrl.includes("#result") ||
      currentUrl.includes("/result/content/index/");

    if (isResult) {
      this.logger.info(
        "[Raid] Result page detected. Navigating to backup...",
      );
      await this.controller.gotoSPA(this.raidBackupUrl);
      await sleep(50);
      return false; // Restart cycle
    } else {
      const summonStatus = await this.selectSummon();

      // Safety: Check for captcha after summon selection
      if (await this.checkCaptcha()) {
        return false;
      }

      if (
        summonStatus === "ended" ||
        this.raidErrorType !== null ||
        summonStatus === "failed"
      ) {
        this.logger.warn(
          `[Raid] Summon selection returned ${summonStatus || "error"}`,
        );
        await this.recoverFromJoinError();
        return false;
      }

      if (
        summonStatus === "concurrent_limit" ||
        this.raidErrorType === "concurrent_limit"
      ) {
        this.logger.info(
          "[System] Concurrent raid limit reached (3 active backups).",
        );
        await this.waitForActiveBackupsCooldown();
        this.raidErrorType = null;
        return false; // Restart cycle
      }

      if (summonStatus === "pending" || this.raidErrorType === "pending") {
        this.logger.info("[System] Pending battles detected. Clearing...");
        const clearedCount = await this.clearPendingBattles();
        if (clearedCount === 0) {
          await this.waitForActiveBackupsCooldown();
        }
        return false; // Restart cycle
      }
    }

    // Check if bot was stopped before starting battle
    if (!this.isRunning) {
      this.logger.debug(
        "[System] Operation cancelled before combat initiation",
      );
      return;
    }

    // Handle battle
    const result = await this.battle.executeBattle(this.battleMode, {
      honorTarget: this.honorTarget,
      refreshOnStart: this.refreshOnStart,
      skipOnSalute: true, // Just for raid mode
    });

    // Rewards are captured inside waitForBattleEnd before executeBattle returns.
    if (result?.rewards) {
      this.logger.info(`[Loot] Battle rewards received`);
      this._onBattleResult({ rewards: result.rewards });
    }

    // Navigate to backup page after battle ends (don't stay on result page)
    this.logger.info("[Raid] Navigating to backup page...");
    await this.controller.gotoSPA(this.raidBackupUrl);
    await sleep(50);

    // Note: skipRaid/raidFull/raidEnded are handled during battle, not after
    // This point is reached only for successful battle completion

    if (result?.raidPending) {
      this.logger.info(
        "[Raid] Pending battles detected. Clearing automatically",
      );
      const clearedCount = await this.clearPendingBattles();
      if (clearedCount === 0) {
        await this.waitForActiveBackupsCooldown();
      }
      return false;
    }

    const honorReached = result?.honorReached || false;
    const honorValue = result?.honors || 0;
    this.logger.debug(
      `[Result] honorReached: ${honorReached}, honors: ${honorValue.toLocaleString()}, target: ${this.honorTarget.toLocaleString()}`,
    );

    if (honorReached) {
      this.logger.info(
        `[Target] Honor goal reached: ${this.honorTarget.toLocaleString()}`,
      );
    }

    if (result && result.duration > 0) {
      this.updateDetailStats(result);
    }

    // Navigate back to assist page for next raid
    const raidCurrentUrl = this.controller.page.url();
    if (
      raidCurrentUrl.includes("#raid") ||
      raidCurrentUrl.includes("_raid") ||
      raidCurrentUrl.includes("#result")
    ) {
      await this.controller.gotoSPA(this.raidBackupUrl);
      // wait briefly to ensure SPA routing has time to trigger
      await sleep(300);
    }

    return true;
  }

  async findAndJoinRaid() {
    const initialUrl = this.controller.page?.url() || '';
    const isInBattleUrl = initialUrl.match(/#(?:raid|raid_multi)(?:\/|$)/);

    if (isInBattleUrl || this.networkBattleStarted) {
      this.logger.info("[Raid] Already in battle mode. Skipping search.");
      return true; // Returns true to represent a 'joined' state
    }

    if (
      this.networkSupporterScreen ||
      (await this.controller.elementExists(".prt-supporter-list", 100))
    ) {
      this.logger.info(
        "[Raid] Already on supporter selection screen. Skipping search.",
      );
      return true; // Returns true to represent a 'joined' state
    }

    this.logger.info("[Raid] Navigating to backup page...");
    await this.controller.gotoSPA(this.raidBackupUrl);
    await sleep(100);

    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts && this.isRunning) {
      attempts++;

      if (this.raidErrorType !== null) {
        if (this.raidErrorType === "concurrent_limit") {
          this.logger.info(
            "[System] Concurrent raid limit reached (3 active backups).",
          );
          await this.waitForActiveBackupsCooldown();
          await this.controller.gotoSPA(this.raidBackupUrl);
          await sleep(10);
          this.raidErrorType = null;
          continue;
        }

        if (this.raidErrorType === "pending") {
          this.logger.info(
            "[Network] Pending battles detected. Clearing automatically",
          );
          const clearedCount = await this.clearPendingBattles();
          if (clearedCount === 0) {
            await this.waitForActiveBackupsCooldown();
          }
          await this.controller.gotoSPA(this.raidBackupUrl);
          await sleep(10);
          this.raidErrorType = null;
          continue;
        }
        return false;
      }

      const currentUrl = this.controller.page.url();
      if (currentUrl.includes("#result")) {
        // Result from previous battle - navigate to assist page
        await this.controller.gotoSPA(this.raidBackupUrl);
        await sleep(config.get("timeouts.raid.page_transition", 200));
        continue;
      }

      // Check for error popup first
      const errorResult = await this.battle.checkEarlyBattleEndPopup();
      if (errorResult) {
        // Clear the error popup
        await this.controller
          .clickSafe(".btn-usual-ok", {
            fast: true,
            timeout: 1000,
            maxRetries: 1,
          })
          .catch(() => {});

        if (errorResult.raidFull || errorResult.raidEnded) {
          this.logger.info("[Raid] Raid full or ended. Escaping popup state");
          await this.controller.reloadPage();
          await sleep(200);
          continue;
        }

        if (errorResult.raidConcurrentLimit) {
          this.logger.info(
            "[System] Concurrent raid limit reached (3 active backups).",
          );
          await this.waitForActiveBackupsCooldown();
          await this.controller.gotoSPA(this.raidBackupUrl, {
            waitUntil: "domcontentloaded",
          });
          await sleep(50);
          continue;
        }

        if (errorResult.raidPending) {
          this.logger.info(
            "[Raid] Pending battles detected. Initializing cleanup",
          );
          const clearedCount = await this.clearPendingBattles();
          if (clearedCount === 0) {
            await this.waitForActiveBackupsCooldown();
          }
          await this.controller.gotoSPA(this.raidBackupUrl, {
            waitUntil: "domcontentloaded",
          });
          await sleep(50);
          continue;
        }
        this.logger.info("[Raid] Error popup detected. Escaping popup state");
        await this.controller.reloadPage();
        await sleep(200);
        continue;
      }

      const raidSelector = this.selectors.raidEntry;

      if (this.targetUser) {
        // Switch to the event/guild tab if the button is present and active
        const switchBtn = await this.controller.page.$(".btn-switch-list.event.active");
        if (switchBtn) {
          this.logger.debug("[Raid] Switching to event tab for target scan...");
          await switchBtn.click();
          await sleep(300);
        }

        this.logger.info(`[Raid] Scanning for target: "${this.targetUser}"...`);

        const raidHandle = await this.controller.page.evaluateHandle(
          (user, selector) => {
            const raids = document.querySelectorAll(selector);
            const targetName = user.toLowerCase();
            for (const raid of raids) {
              const nameEl = raid.querySelector(".txt-request-name");
              if (
                nameEl &&
                nameEl.textContent.trim().toLowerCase().includes(targetName)
              ) {
                return raid;
              }
            }
            return null;
          },
          this.targetUser,
          raidSelector,
        );

        const raidElement = raidHandle.asElement();
        const targetClicked = !!raidElement;

        if (targetClicked) {
          const box = await raidElement.boundingBox();
          await raidElement.dispose();
          if (box) {
            await this.controller.page.mouse.click(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
          }
          this.logger.info(
            `[Raid] Found target user: "${this.targetUser}". Joining...`,
          );
          try {
            // click already performed inside evaluate — no handle to detach

            try {
              const joinTimeout = config.get("timeouts.raid.join_race", 3000);
              const raceResult = await Promise.race([
                this.controller
                  .waitForElement(".prt-supporter-list", joinTimeout)
                  .then((res) => (res ? "summon" : null)),
                this.controller
                  .waitForElement(".btn-usual-ok", joinTimeout)
                  .then((res) => (res ? "ok_btn" : null)),
                this.controller
                  .waitForElement(".cnt-raid", joinTimeout)
                  .then((res) => (res ? "battle" : null)),
                this.waitForRaidError(joinTimeout).then((res) =>
                  res ? "network_error" : null,
                ),
              ]);

              if (raceResult === "network_error") {
                if (this.raidErrorType === "pending") {
                  this.logger.info(
                    "[Network] Pending battles detected during join. Initializing cleanup",
                  );
                  await this.clearPendingBattles();
                  await this.controller.gotoSPA(this.raidBackupUrl);
                  this.raidErrorType = null;
                  continue;
                }
                return false;
              }
              if (raceResult === "summon" || raceResult === "battle") {
                this.logger.info(
                  `[Raid] Join successful (State: ${raceResult})`,
                );
                return true;
              }

              if (raceResult === "ok_btn") {
                const isPopup = await this.controller.page.evaluate(() => {
                  const btn = document.querySelector(".btn-usual-ok");
                  return (
                    btn &&
                    (btn.closest(".prt-popup-footer") ||
                      btn.closest(".pop-usual"))
                  );
                });
                if (!isPopup) {
                  this.logger.info("[Raid] Join successful (State: ok_btn)");
                  return true;
                }
              }

              const clickError = await this.battle.checkEarlyBattleEndPopup();
              if (clickError) {
                if (clickError.raidFull) {
                  this.logger.warn(
                    "[Raid] Raid full. Returning to assist page.",
                  );
                  return false;
                }
                if (clickError.raidPending) {
                  this.logger.info(
                    "[Raid] Pending battles detected after join. Initializing cleanup",
                  );
                  await this.clearPendingBattles();
                  this.raidErrorType = null;
                  await this.controller.gotoSPA(this.raidBackupUrl);
                  await sleep(200);
                  continue;
                }
              }
            } catch (e) {
              this.logger.debug(`[Raid] Join check error: ${e.message}`);
            }
          } catch (error) {
            this.logger.error(
              "[Error] [Raid] Error clicking target raid:",
              error,
            );
          }
        } else {
          this.logger.info(
            `[Raid] Target "${this.targetUser}" not found. Refreshing list...`,
          );
          await this.refreshRaidSearch();
          // Wait up to 2s for the target to appear in the DOM before looping
          await this.controller.page.waitForFunction(
            (user, selector) => {
              const raids = document.querySelectorAll(selector);
              const targetName = user.toLowerCase();
              return Array.from(raids).some((raid) => {
                const nameEl = raid.querySelector(".txt-request-name");
                return nameEl && nameEl.textContent.trim().toLowerCase().includes(targetName);
              });
            },
            { timeout: 2000, polling: 200 },
            this.targetUser,
            raidSelector,
          ).catch(() => null); // timeout = not in list yet, continue loop
        }
      } else if (await this.controller.elementExists(raidSelector, 2000)) {
        this.logger.info("[Raid] Raid detected. Joining...");

        try {
          await this.controller.clickSafe(raidSelector);
          await sleep(200);

          const joinTimeout = config.get("timeouts.raid.join_race", 3000);
          const joinResult = await Promise.race([
            this.controller.page.waitForSelector(
              ".prt-supporter-list, .btn-usual-ok",
              { timeout: joinTimeout },
            ),
            this.waitForRaidError(joinTimeout).then((res) =>
              res ? "network_error" : null,
            ),
          ]).catch(() => null);

          if (joinResult === "network_error") {
            if (this.raidErrorType === "pending") {
              this.logger.info(
                "[Network] Pending battles detected during join. Initializing cleanup",
              );
              await this.clearPendingBattles();
              await this.controller.gotoSPA(this.raidBackupUrl);
              this.raidErrorType = null;
              continue;
            }
            return false;
          }
          if (joinResult) {
            const onSummon = await this.controller.elementExists(
              ".prt-supporter-list",
              100,
            );
            if (onSummon) {
              this.logger.info("[Raid] Join successful");
              return true;
            }

            const clickError = await this.battle.checkEarlyBattleEndPopup();
            if (clickError) {
              if (clickError.raidPending) {
                this.logger.info(
                  "[Raid] Pending battles detected after join. Initializing cleanup",
                );
                await this.clearPendingBattles();
                await this.controller.gotoSPA(this.raidBackupUrl);
                await sleep(10);
                continue;
              }
              // Fast Recovery: Target-aware reload/navigation
              await this.recoverFromJoinError();
              continue;
            }

            const urlNow = this.controller.page.url();
            if (
              urlNow.includes("#raid") ||
              urlNow.includes("_raid") ||
              (await this.controller.elementExists(".prt-supporter-list", 200))
            ) {
              this.logger.info("[Raid] Joined after popup confirmation");
              return true;
            }
          } else {
            const urlNow = this.controller.page?.url() || '';
            if (urlNow.includes("#raid") || urlNow.includes("_raid")) {
              this.logger.info("[Raid] Join successful (direct battle)");
              return true;
            }
          }

          this.logger.warn(
            "[Raid] Unknown state after join attempt. Recovering...",
          );
          await this.recoverFromJoinError();
        } catch (error) {
          this.logger.error(
            "[Error] [Raid] Error clicking raid entry. Recovering...",
            error,
          );
          await this.recoverFromJoinError();
        }
      } else {
        this.logger.info("[Raid] No raids available. Re-checking...");
        await sleep(2000);

        // If the game asynchronously redirected us to a pending result screen while we waited
        const currentUrl = this.controller.page?.url() || '';
        if (currentUrl.includes("#result")) {
          continue;
        }

        await this.refreshRaidSearch();
        await sleep(200);
      }
    }

    this.logger.warn(`[Raid] Failed to join raid after ${attempts} attempts`);
    return false;
  }

  async clearPendingBattles() {
    const unclaimedUrl =
      "https://game.granbluefantasy.jp/#quest/assist/unclaimed/0/0";
    const entrySelector = this.selectors.unclaimedRaidEntry;

    this.logger.info("[System] Clearing pending battles");

    let clearedCount = 0;
    const maxToClear = 10;

    while (clearedCount < maxToClear && this.isRunning) {
      await this.controller.gotoSPA(unclaimedUrl);
      await sleep(100);

      const hasEntries = await this.controller.elementExists(
        entrySelector,
        3000,
      );
      if (!hasEntries) {
        break;
      }

      try {
        await this.controller.clickSafe(entrySelector);

        // Wait for the rewards-bearing result endpoint, with a fallback timeout.
        // content/index responses include rewards directly in option.result_data.
        // If rewards are missing (e.g. empty result), a detail XHR may follow.
        // We keep listening until we get rewards or the hard timeout expires.
        await new Promise((resolve) => {
          let resolved = false;
          const hardTimeoutMs = config.get("timeouts.raid.pending_hard_timeout", 5000);
          const detailXhrMs = config.get("timeouts.raid.pending_detail_xhr", 2000);

          const hardTimeout = setTimeout(() => {
            if (!resolved && this.controller.network) {
              resolved = true;
              this.controller.network.off("battle:result", onResult);
              this.logger.warn(`[Loot] Pending raid result timeout (${Math.round(hardTimeoutMs / 1000)}s) — no result endpoint, skipping`);
              resolve(null);
            }
          }, hardTimeoutMs);

          // After the content page fires, give the detail XHR up to 2s extra.
          let softTimeout = null;
          const onResult = ({ rewards, url: resultUrl }) => {
            const shortUrl = resultUrl ? resultUrl.replace('https://game.granbluefantasy.jp', '') : '?';
            if (rewards !== null) {
              // Result endpoint responded with reward data — session listener will count chests.
              this.logger.info(`[Loot] Pending raid rewards received (${shortUrl})`);
              if (!resolved) {
                resolved = true;
                clearTimeout(hardTimeout);
                clearTimeout(softTimeout);
                if (this.controller.network) {
                  this.controller.network.off("battle:result", onResult);
                }
                resolve(null);
              }
            } else if (!softTimeout) {
              // Result fired but rewards were null — start soft countdown in case a detail XHR follows.
              this.logger.info(`[Loot] Pending raid page loaded (${shortUrl}) — no rewards yet, waiting briefly for detail XHR`);
              clearTimeout(hardTimeout);
              softTimeout = setTimeout(() => {
                if (!resolved) {
                  this.logger.warn(`[Loot] Detail XHR did not arrive in time (${Math.round(detailXhrMs / 1000)}s) — no chest data for this pending raid`);
                  resolved = true;
                  if (this.controller.network) {
                    this.controller.network.off("battle:result", onResult);
                  }
                  resolve(null);
                }
              }, detailXhrMs);
            }
          };

          if (this.controller.network) {
            this.controller.network.on("battle:result", onResult);
          }
        });

        clearedCount++;
      } catch (error) {
        this.logger.error("[Error] Failed to process unclaimed raid", error);
        break;
      }
    }

    this.logger.info(`[System] Cleared ${clearedCount} pending battles`);
    return clearedCount;
  }

  async waitForActiveBackupsCooldown() {
    this.logger.warn("[Raid] 3 simultaneous active backup limit reached!");
    const cooldownStep = config.get("timeouts.raid.cooldown", 5000);
    const totalSteps = Math.ceil(15000 / cooldownStep);
    for (let i = 0; i < totalSteps; i++) {
      if (!this.isRunning) break;
      const elapsed = i * cooldownStep;
      this.logger.info(`[Wait] (${elapsed}/${totalSteps * cooldownStep}) resuming in ${totalSteps * cooldownStep - elapsed}ms...`);
      await sleep(cooldownStep);
    }
    if (this.isRunning) {
      this.logger.info(`[Wait] Resuming...`);
    }
  }

  async selectSummon() {
    this.logger.info("[Summon] Selecting supporter");

    let retryCount = 0;
    while (retryCount < 15) {
      // 3s total
      if (this.raidErrorType !== null) return "ended";

      if (this.networkBattleStarted) {
        this.logger.info("[Raid] Battle started via network (start.json). Skipping summon search");
        return "success";
      }

      // Single batched DOM check — replaces 3 separate IPC calls per iteration
      const state = await this.controller.page.evaluate(() => {
        const hash = window.location.hash;
        const att = document.querySelector(".btn-attack-start");
        if (hash.startsWith("#raid") || hash.startsWith("#raid_multi")) return "battle";
        if (att && (att.offsetWidth > 0 || att.classList.contains("display-on"))) return "battle";
        if (document.querySelector(".prt-supporter-list")) return "supporter";
        if (document.querySelector(".btn-usual-ok")) return "ok_btn";
        return null;
      }).catch(() => null);

      if (state === "battle") {
        this.logger.info("[Raid] Transitioned to battle. Skipping summon search");
        return "success";
      }
      if (state === "supporter") break;
      if (state === "ok_btn") {
        this.logger.info("[Summon] OK button detected during wait. Breaking loop");
        break;
      }

      retryCount++;
      await sleep(50);
    }

    const okFound = await this.controller.elementExists(
      ".btn-usual-ok",
      100,
      true,
    );
    if (okFound) {
      const error = await this.battle.checkEarlyBattleEndPopup();
      if (error) {
        if (error.raidEnded || error.raidFull) return "ended";
        if (error.raidPending) return "pending";
      }

      this.logger.info("[Summon] Clicking start confirmation");
      await this.controller.cachedClick(".btn-usual-ok", 15).catch(() => {
        this.logger.debug("[Wait] Confirmation popup vanished before click");
      });
      await sleep(50);

      return await this.validatePostClick();
    }

    const summonSelector = ".prt-supporter-detail";
    if (await this.controller.elementExists(summonSelector, 2500, true)) {
      this.logger.info("[Summon] Supporter selected");

      try {
        await this.controller.clickSafe(summonSelector, {
          timeout: 2000,
          maxRetries: 1,
        });
      } catch (error) {
        const currentUrl = this.controller.page?.url() || '';
        if (currentUrl.includes("#raid") || currentUrl.includes("_raid")) {
          this.logger.info(
            "[Raid] Transitioned to battle. Ignoring click error",
          );
          return "success";
        }
        throw error;
      }

      if (await this.controller.elementExists(".btn-usual-ok", 1500, true)) {
        this.logger.info("[Summon] Clicking start confirmation...");

        let clickSuccess = false;
        for (let i = 0; i < 3; i++) {
          try {
            await this.controller.cachedClick(".btn-usual-ok", 15);
            clickSuccess = true;
          } catch (e) {}

          if (
            !(await this.controller.elementExists(".btn-usual-ok", 200, true))
          ) {
            clickSuccess = true;
            break;
          }
          await sleep(50);
        }

        if (!clickSuccess)
          this.logger.warn(
            "[Wait] Failed to click start confirmation properly",
          );
        await sleep(50);
      } else {
        // Fallback: If cancel never appeared but OK is there (e.g. an error popup instead)
        if (await this.controller.elementExists(".btn-usual-ok", 200, true)) {
          this.logger.info(
            "[Wait] Only OK button found (no cancel). Clicking anyway",
          );
          await this.controller
            .cachedClick(".btn-usual-ok", 15)
            .catch(() => {});
          await sleep(50);
        }
      }

      return await this.validatePostClick();
    }

    const questSelectors = config.selectors.quest;
    const summonSelectors = [
      questSelectors.summonSlot1,
      questSelectors.summonSlot2,
      questSelectors.summonSlot3,
    ];

    for (const selector of summonSelectors) {
      if (await this.controller.elementExists(selector, 1000)) {
        await this.controller.clickSafe(selector);
        this.logger.info("[Summon] Supporter selected (fallback)");
        await sleep(200);

        if (await this.controller.elementExists(".btn-usual-ok", 500, true)) {
          await this.controller.cachedClick(".btn-usual-ok", 15).catch(() => {
            this.logger.debug(
              "[Summon] Fallback confirmation vanished before click",
            );
          });
          await sleep(50);

          return await this.validatePostClick();
        }
        return "success";
      }
    }

    this.logger.warn("[Summon] No supporter or party selection found");
    return "failed";
  }

    /**
     * Validates combat UI stability after clicking the start button.
     * @returns {Promise<string>} Termination status ("success", "ended", "pending", "captcha").
     */
    async validatePostClick() {
    if (await this.checkCaptcha()) return "captcha";

    // Check for Deck selection stuck popups
    if (await this.controller.elementExists(".pop-deck.pop-show", 300, true)) {
      this.logger.warn("[Summon] Stuck on Deck Popup. Clicking OK directly.");
      await this.controller.clickSafe(".pop-deck.pop-show .btn-usual-ok", {
        silent: true,
      });
      await sleep(800);
    }

    // Check for Party Deck stuck (e.g., Quick Summon skip)
    if (await this.controller.elementExists(".prt-deck", 100, true)) {
      if (await this.controller.elementExists(".btn-usual-ok", 100, true)) {
        this.logger.warn(
          "[Summon] Stuck on Party screen. Clicking OK directly.",
        );
        await this.controller.clickSafe(".btn-usual-ok", {
          fast: true,
          timeout: 1000,
          maxRetries: 1,
        });
        await sleep(800);
      }
    }

    // Check for Warning Popups (e.g., "Elixirs can't be used")
    if (await this.controller.elementExists(".pop-usual.pop-show", 100, true)) {
      if (
        await this.controller.elementExists(
          ".pop-usual.pop-show .btn-usual-ok",
          50,
          true,
        )
      ) {
        this.logger.warn(
          "[Summon] Warning popup detected on Party screen. Clicking OK...",
        );
        await this.controller.clickSafe(".pop-usual.pop-show .btn-usual-ok", {
          fast: true,
          timeout: 1000,
          maxRetries: 1,
        });
        await sleep(500);
      }
    }

    for (let i = 0; i < 15; i++) {
      if (this.raidErrorType !== null) return "ended";
      const currentUrl = this.controller.page?.url() || '';

      if (currentUrl.includes("supporter_raid")) {
        // If we land on the full-page party selection screen, click the start button
        if (
          await this.controller.elementExists(
            ".btn-usual-ok.se-quest-start",
            100,
            true,
          )
        ) {
          this.logger.info("[Summon] Party screen confirmed. Clicking OK...");
          await this.controller.clickSafe(".btn-usual-ok.se-quest-start", {
            fast: true,
          });
          await sleep(500);
        }
      } else if (
        currentUrl.match(/#(?:raid|raid_multi)(?:\/|$)/) ||
        currentUrl.includes("#result")
      ) {
        return "success";
      }

      const error = await this.battle.checkEarlyBattleEndPopup();
      if (error) {
        if (error.raidEnded) {
          this.logger.info(
            "[Raid] Raid already ended. Returning to backup page...",
          );
          return "ended";
        }
        if (error.raidPending) {
          return "pending";
        }
        break;
      }
      await sleep(100);
    }

    const finalUrl = this.controller.page?.url() || '';
    if (
      !finalUrl.match(/#(?:raid|raid_multi)(?:\/|$)/) &&
      !finalUrl.includes("#result")
    ) {
      this.logger.warn(
        "[Raid] URL did not transition to battle. Potential error",
      );
      return "ended";
    }

    return "success";
  }

  async checkCaptcha() {
    const selectors = config.selectors.battle;
    if (
      await this.controller.elementExists(selectors.captchaPopup, 1000, true)
    ) {
      const headerText = await this.controller.getText(selectors.captchaHeader);
      if (headerText.includes("Access Verification")) {
        this.logger.error(
          "[Safety] Captcha detected. Human intervention required",
        );
        notifier
          .notifyCaptcha(this.profileId || "p1")
          .catch((e) =>
            this.logger.debug("[Notifier] Failed to notify captcha", e),
          );
        this.pause();
        return true;
      }
    }
    return false;
  }

  pause() {
    this.isPaused = true;
    this.logger.info("[Raid] Bot paused");
  }

  resume() {
    this.isPaused = false;
    this.logger.info("[Raid] Bot resumed");
  }

  stop() {
    this.isRunning = false;
    if (this.battle) {
      this.battle.stop();
    }

    if (this.controller.network) {
      this.controller.network.removeListener("raid:error", this.onRaidError);
      this.controller.network.removeListener(
        "battle:start",
        this.onBattleStart,
      );
      this.controller.network.removeListener(
        "raid:supporter_screen",
        this.onSupporterScreen,
      );
      this.controller.network.removeListener(
        "battle:result",
        this.onBattleResult,
      );
    }

    this.controller
      .stop()
      .catch((e) =>
        this.logger.warn("[Performance] Failed to stop controller", e),
      );
    this.logger.info("[System] Shutdown requested");
  }

  updateDetailStats(result) {
    if (!result) return;
    if (!this.totalTurns) this.totalTurns = 0;
    if (!this.battleCount) this.battleCount = 0;
    this.battleCount++;
    if (typeof result.turns === "number" && result.turns > 0) {
      this.totalTurns += result.turns;
    }
    if (result.honors > 0) {
      const gained = result.honors - this.lastEndHonor;
      if (gained > 0) {
        this.totalHonor += gained;
        this.logger.info(
          `[Summary] Honor gained this raid: +${gained.toLocaleString()} (Session total: ${this.totalHonor.toLocaleString()})`,
        );
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

    /**
     * Compiles session statistics for reporting.
     * @returns {object} Summary of raids, honors, and loot.
     */
    getStats() {
        let avgTurns = 0;
        if (this.battleCount > 0) {
            avgTurns = (this.totalTurns / this.battleCount).toFixed(1);
        }
        let rate = "0.0/h";
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
            battleCount: this.battleCount || 0,
            lastBattleTime: this.battleTimes.length > 0 ? this.battleTimes[this.battleTimes.length - 1] : 0,
            rate: rate,
            totalHonor: this.totalHonor || 0,
            redChests: this.redChests || 0,
            blueChests: this.blueChests || 0,
            goldBricks: this.goldBricks || 0,
        };
    }

  async refreshRaidSearch() {
    const currentUrl = this.controller.page.url();
    const isOnAssistPage = currentUrl.includes("#quest/assist");
    const refreshBtn = ".btn-search-refresh";
    if (isOnAssistPage) {
      const hasRefreshBtn = await this.controller.elementExists(
        refreshBtn,
        500,
        true,
      );
      if (hasRefreshBtn) {
        this.logger.debug(
          "[Raid] On assist page. Clicking UI refresh button...",
        );
        await this.controller.clickSafe(refreshBtn);
        return true;
      }
      const switchListBtn =
        '.btn-switch-list.event.active[data-list-type="event"]';
      const hasSwitchListBtn = await this.controller.elementExists(
        switchListBtn,
        500,
        true,
      );
      if (hasSwitchListBtn) {
        this.logger.debug(
          "[Raid] Refresh button not found. Clicking switch-list button...",
        );
        await this.controller.clickSafe(switchListBtn);
        return true;
      }
    }
    this.logger.info("[Raid] Navigating to assist page...");
    await this.controller.gotoSPA(this.raidBackupUrl, {
      waitUntil: "domcontentloaded",
    });
    return true;
  }
}

export default RaidBot;
