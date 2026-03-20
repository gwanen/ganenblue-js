import PageController from "../core/page-controller.js";
import BattleHandler from "./battle-handler.js";
import { sleep, randomDelay } from "../utils/random.js";
import logger, { createScopedLogger } from "../utils/logger.js";
import config from "../utils/config.js";
import notifier from "../utils/notifier.js";

class QuestBot {
  constructor(page, options = {}) {
    // Assign profileId and scoped logger FIRST so they're available to PageController
    this.profileId = options.profileId || config.get("profile_id") || "p1";
    this.logger = createScopedLogger(this.profileId);

    this.controller = new PageController(page, this.logger);
    this.questUrl = options.questUrl || config.get("quest.url");
    this.maxQuests = options.maxQuests || 0; // 0 = unlimited
    this.battleMode = options.battleMode || "full_auto";
    this.onBattleEnd = options.onBattleEnd || null;
    this.selectors = config.selectors.quest;
    this.battle = new BattleHandler(page, {
      fastRefresh: options.fastRefresh || false,
      summonRefresh:
        options.summonRefresh !== undefined ? options.summonRefresh : true,
      skillRefresh:
        options.skillRefresh !== undefined ? options.skillRefresh : false,
      logger: this.logger,
      controller: this.controller,
    });

    // Enable performance optimizations
    if (options.blockResources) {
      this.logger.info("[System] Image blocking enabled");
      this.controller
        .enableResourceBlocking()
        .catch((e) =>
          this.logger.warn("[System] Failed to enable image blocking", e),
        );
    } else {
      this.logger.info("[System] Image blocking disabled");
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
      this.logger.debug("[Network] Supporter screen detected (BGM request)");
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
      this.controller.network.on("raid:error", this.onRaidError);
      this.controller.network.on(
        "raid:supporter_screen",
        this.onSupporterScreen,
      );
    }

    this.logger.info("[Bot] Session started");

    try {
      while (this.isRunning) {
        if (this.isPaused) {
          await sleep(1000);
          continue;
        }

        // Check quest limit
        if (this.maxQuests > 0 && this.questsCompleted >= this.maxQuests) {
          this.logger.info(
            `[Quest] Limit reached (${this.questsCompleted}/${this.maxQuests})`,
          );
          break;
        }

        let success = false;
        try {
          success = await this.runSingleQuest();
        } catch (cycleError) {
          if (this.controller.isNetworkError(cycleError)) {
            this.logger.warn(
              `[Quest] Transient error during cycle. Retrying: ${cycleError.message}`,
            );
            await sleep(2000); // Increased from 500ms to allow SPA to settle
            continue;
          }
          throw cycleError; // Re-throw fatal errors
        }
        if (success) {
          this.questsCompleted++;
        }

        // Short delay between quests for browser stability
        await sleep(50);
      }
    } catch (error) {
      // Graceful exit on browser close/disconnect
      if (
        this.controller.isNetworkError(error) ||
        error.message.includes("Target closed") ||
        error.message.includes("Session closed")
      ) {
        this.logger.info("[System] Session terminated (browser closed)");
      } else {
        this.logger.error("[Bot] Quest bot error:", error);
        notifier
          .notifyError(this.profileId || "p1", error.message)
          .catch((e) =>
            this.logger.debug(
              "[Notifier] Failed to send error notification",
              e,
            ),
          );
        throw error;
      }
    } finally {
      this.stop();
    }
  }

  async runSingleQuest() {
    this.logger.info(
      `[Quest] Initiating quest cycle (${this.questsCompleted + 1})`,
    );

    // Pre-check: If already in battle, skip to battle execution
    const currentUrl = this.controller.page.url();
    const isInBattleUrl =
      currentUrl.match(/#(?:raid|raid_multi)(?:\/|$)/) !== null;

    // Check if we're on result page (should navigate away, not fight)
    const isResultUrl =
      currentUrl.includes("#result") ||
      currentUrl.includes("/result/content/index/") ||
      currentUrl.includes("/result_multi/content/index/");

    if (isResultUrl) {
      this.logger.info(
        "[Quest] Result page detected. Navigating to quest URL...",
      );
      await this.controller.gotoSPA(this.questUrl);
      await sleep(randomDelay(300, 500));
    }

    if (isInBattleUrl) {
      // Check if battle UI is present (attack button or auto button)
      // BUT exclude result page elements to avoid false positives
      const hasBattleUI = await this.controller.page
        .evaluate(() => {
          // First check if we're on result page
          const isResultPage = !!document.querySelector(
            ".prt-result, #js-result, .cnt-result",
          );
          if (isResultPage) return false; // Don't fight on result page

          const att = document.querySelector(".btn-attack-start");
          const auto = document.querySelector(".btn-auto, .btn-full-auto");
          const attVisible =
            att &&
            (att.offsetWidth > 0 || att.classList.contains("display-on"));
          const autoVisible = auto && auto.offsetWidth > 0;
          return attVisible || autoVisible;
        })
        .catch(() => false);

      if (hasBattleUI) {
        this.logger.info(
          "[Quest] Battle in progress detected. Skipping summon selection...",
        );
        const result = await this.battle.executeBattle(this.battleMode);
        if (result && result.duration > 0) {
          this.updateDetailStats(result);
        }
        this.logger.info("[Battle] Combat concluded");
        // Wait for battle:result network event before navigating
        // (result.json loads async after boss death reload)
        await this.waitForBattleResult();
        this.logger.info("[Quest] Navigating to next quest...");
        await this.controller.gotoSPA(this.questUrl);
        await sleep(randomDelay(300, 500));
        return true;
      }

      // No battle UI but we're in battle URL - check if it's a result page
      const isResultPage = await this.controller.page
        .evaluate(() => {
          return !!document.querySelector(
            ".prt-result, #js-result, .cnt-result",
          );
        })
        .catch(() => false);

      if (isResultPage) {
        this.logger.info(
          "[Quest] Result page detected in battle URL. Navigating away...",
        );
        await this.controller.gotoSPA(this.questUrl);
        await sleep(randomDelay(300, 500));
      }
    }

    // Check for Replicard URL
    const isReplicard = this.questUrl.includes("/replicard/");

    if (isReplicard) {
      await this.controller.gotoSPA(this.questUrl);
      await sleep(randomDelay(100, 200));
      const battleStarted = await this.startReplicardBattle();
      if (!battleStarted) {
        this.logger.warn("[Quest] Failed to initiate replicard battle");
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

      if (summonStatus === "pending") {
        this.logger.info(
          "[System] Pending battles detected. Initiating cleanup...",
        );
        await this.clearPendingBattles();
        return false;
      }

      if (summonStatus !== "success") {
        this.logger.warn(`[Quest] Summon selection failed (${summonStatus})`);
        return false;
      }
    }

    // Safety: Check for captcha before starting battle
    if (await this.checkCaptcha()) {
      return false;
    }

    // Check if bot was stopped before starting battle
    if (!this.isRunning) {
      this.logger.debug(
        "[System] Operation cancelled before combat initiation",
      );
      return;
    }

    // Handle battle
    // Reset stale pre-flags: the previous battle's result.json can arrive
    // during navigation to questUrl, setting _preNetworkFinished = true and
    // causing waitForBattleEnd to return immediately without fighting.
    this.battle.resetPreFlags();
    const result = await this.battle.executeBattle(this.battleMode);

    if (result && result.duration > 0) {
      this.updateDetailStats(result);
    }

    if (result?.raidPending) {
      this.logger.info("[Quest] Pending battles detected. Clearing...");
      await this.clearPendingBattles();
    }

    // Navigate back to quest URL so the next cycle starts on the supporter page,
    // not on the stale #raid URL with lingering result page UI.
    // Wait for battle:result network event first — result.json loads async
    // after boss death reload. Navigating too early causes SPA redirect loop.
    await this.waitForBattleResult();
    this.logger.info("[Quest] Navigating to next quest...");
    await this.controller.gotoSPA(this.questUrl);
    await sleep(randomDelay(300, 500));

    return true;
  }

  async startReplicardBattle() {
    this.logger.info("[Replicard] Engaging target");
    const monsterSelector = ".btn-monster.lis-monster";
    const okButton = ".btn-usual-ok";

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
      return summonStatus === "success";
    }

    this.logger.warn("[Replicard] Target not found on page");
    return false;
  }

  async selectSummon() {
    this.logger.info("[Summon] Awaiting supporter selection");

    // Wait for supporter screen via network (BGM request) or DOM fallback.
    // Timeout: 7 seconds. Re-navigate up to 2x if GBF's SPA intercepts the
    // late result.json and redirects us back to #result mid-navigation.
    const startTime = Date.now();
    const timeout = 7000;
    let renavCount = 0;

    while (Date.now() - startTime < timeout) {
      // Check network flag first (fastest)
      if (this.networkSupporterScreen) {
        this.logger.debug(
          "[Network] Supporter screen confirmed via BGM request",
        );
        break;
      }

      // URL-only check: supporter screen, battle active, or result-page intercept
      // We do NOT check DOM (.prt-result) here — stale result page elements linger
      // during SPA transitions even after the URL has moved to #quest/supporter.
      const state = await this.controller.page
        .evaluate(() => {
          const hash = window.location.hash;
          const href = window.location.href;
          return {
            listFound: !!document.querySelector(".prt-supporter-list"),
            okFound: !!document.querySelector(".btn-usual-ok"),
            isRaid: !!hash.match(/#(?:raid|raid_multi)(?:\/|$)/),
            isResult:
              hash.includes("#result") ||
              href.includes("/result/content/index/") ||
              href.includes("/result_multi/content/index/"),
          };
        })
        .catch(() => ({}));

      if (state.listFound || state.okFound) break;

      if (state.isRaid) {
        this.logger.info("[Summon] Battle state detected. Skipping selection");
        return "success";
      }

      // GBF's SPA intercepted result.json and redirected us back to #result.
      // Re-navigate to the quest URL immediately instead of waiting the full 7s.
      if (state.isResult && renavCount < 2) {
        renavCount++;
        this.logger.warn(
          `[Summon] Result page intercept detected. Re-navigating (${renavCount}/2)...`,
        );
        this.networkSupporterScreen = false;
        await this.controller.gotoSPA(this.questUrl);
        await sleep(randomDelay(200, 350));
        continue;
      }

      await sleep(100);
    }

    // Check for error popups only (skip result page check for quests - stale elements from previous battle)
    const earlyError = await this.battle.checkEarlyBattleEndPopup(true);
    if (earlyError) {
      if (earlyError.raidPending) return "pending";
      return "ended";
    }

    const okFound = await this.controller.elementExists(
      ".btn-usual-ok",
      300,
      true,
    );
    if (okFound) {
      // Reuse earlyError result if popup state hasn't changed
      if (earlyError) {
        if (earlyError.raidPending) return "pending";
        return "ended";
      }

      this.logger.info("[Summon] Confirming selection");
      await this.controller
        .clickSafe(".btn-usual-ok", {
          timeout: 1000,
          maxRetries: 1,
          fast: true,
        })
        .catch(() => {});
      await sleep(50);
      return await this.validatePostClick();
    }

    const summonSelector = ".prt-supporter-detail";
    if (await this.controller.elementExists(summonSelector, 3000, true)) {
      this.logger.info("[Summon] Supporter selected");

      try {
        await this.controller.clickSafe(summonSelector, {
          timeout: 2000,
          maxRetries: 1,
        });
      } catch (error) {
        const url = this.controller.page.url();
        if (url.match(/#(?:raid|raid_multi)(?:\/|$)/)) return "success";
        throw error;
      }

      if (await this.controller.elementExists(".btn-usual-ok", 1500, true)) {
        this.logger.info("[Summon] Confirming selection...");
        await this.controller
          .clickSafe(".btn-usual-ok", {
            timeout: 1000,
            maxRetries: 1,
            fast: true,
          })
          .catch(() => {});
        await sleep(50);
      }

      return await this.validatePostClick();
    }

    this.logger.warn("[Summon] No supporter or party selection available");
    return "failed";
  }

  async validatePostClick() {
    if (await this.checkCaptcha()) return "captcha";

    // Consolidate popup checks into single evaluate
    const popupState = await this.controller.page
      .evaluate(() => {
        const results = {};
        if (document.querySelector(".pop-deck.pop-show")) results.deck = true;
        if (document.querySelector(".prt-deck")) results.party = true;
        if (document.querySelector(".btn-usual-ok")) results.ok = true;
        if (document.querySelector(".pop-usual.pop-show"))
          results.warning = true;
        return results;
      })
      .catch(() => ({}));

    if (popupState.deck) {
      this.logger.warn("[Summon] Deck selection popup detected. Dismissing...");
      await this.controller.clickSafe(".pop-deck.pop-show .btn-usual-ok", {
        silent: true,
      });
      await sleep(800);
    } else if (popupState.party && popupState.ok) {
      this.logger.warn(
        "[Summon] Party selection popup detected. Dismissing...",
      );
      await this.controller.clickSafe(".btn-usual-ok", {
        fast: true,
        timeout: 1000,
        maxRetries: 1,
      });
      await sleep(800);
    } else if (popupState.warning && popupState.ok) {
      this.logger.warn("[Summon] Warning popup detected. Dismissing...");
      await this.controller.clickSafe(".btn-usual-ok", {
        fast: true,
        timeout: 1000,
        maxRetries: 1,
      });
      await sleep(800);
    }

    // Wait for URL transition - Reduced iterations and delay for faster completion
    for (let i = 0; i < 10; i++) {
      if (this.raidErrorType !== null) {
        const type = this.raidErrorType;
        this.raidErrorType = null;
        if (type === "pending") return "pending";
        return "ended";
      }

      // URL-only state check — no DOM result detection to avoid stale element false positives
      const state = await this.controller.page
        .evaluate(() => {
          const hash = window.location.hash;
          const url = window.location.href;
          return {
            isRaid: !!hash.match(/#(?:raid|raid_multi)(?:\/|$)/),
            isResult:
              hash.includes("#result") ||
              url.includes("/result/content/index/") ||
              url.includes("/result_multi/content/index/"),
            isParty: url.includes("supporter_raid"),
            startBtn: !!document.querySelector(".btn-usual-ok.se-quest-start"),
          };
        })
        .catch(() => ({}));

      if (state.isRaid) {
        return "success";
      }

      // In quest mode, #result during validatePostClick means GBF's SPA intercepted
      // the previous battle's result.json. Wait for it to settle instead of re-navigating.
      if (state.isResult) {
        this.logger.warn(
          "[Summon] Result page intercept detected. Waiting for network to settle...",
        );
        await sleep(randomDelay(500, 800));
        // Re-check state after waiting — URL only
        const recheckState = await this.controller.page
          .evaluate(() => {
            const hash = window.location.hash;
            const url = window.location.href;
            return {
              isRaid: !!hash.match(/#(?:raid|raid_multi)(?:\/|$)/),
              isResult:
                hash.includes("#result") ||
                url.includes("/result/content/index/") ||
                url.includes("/result_multi/content/index/"),
            };
          })
          .catch(() => ({}));

        if (recheckState.isRaid) {
          // Resolved to battle during wait — good, carry on
          return "success";
        }

        if (recheckState.isResult) {
          // Still on result page — re-navigate and let runSingleQuest retry from scratch
          this.logger.warn(
            "[Summon] Still on result page after wait. Re-navigating...",
          );
          await this.controller.gotoSPA(this.questUrl);
          await sleep(randomDelay(200, 350));
          return "ended";
        }
        // State cleared, continue with normal flow
        break;
      }

      if (state.isParty && state.startBtn) {
        this.logger.info("[Summon] Party selection confirmed. Finalizing...");
        await this.controller.clickSafe(".btn-usual-ok.se-quest-start", {
          fast: true,
        });
        await sleep(300);
      }

      await sleep(200);
    }

    // Final logout check
    const isLoggedOut = await this.controller.page.evaluate(() => {
      const hasLogin = !!document.querySelector("#login-auth");
      const isHome =
        window.location.href.includes("#mypage") ||
        window.location.href.includes("#top");
      return hasLogin || isHome;
    });

    if (isLoggedOut) {
      this.logger.error("[Safety] Session expired. Stopping bot");
      this.stop();
      return "ended";
    }

    const finalUrl = this.controller.page.url();
    // Check for valid battle/quest URLs (including path-based result URLs)
    const isValidUrl =
      finalUrl.match(/#(?:raid|raid_multi|quest\/index)(?:\/|$)/) ||
      finalUrl.includes("#result") ||
      finalUrl.includes("/result/content/index/") ||
      finalUrl.includes("/result_multi/content/index/");
    if (!isValidUrl) {
      this.logger.warn("[Quest] URL transition failed. Potential error state");
      return "ended";
    }

    return "success";
  }

  async clearPendingBattles() {
    const unclaimedUrl =
      "https://game.granbluefantasy.jp/#quest/assist/unclaimed/0/0";
    const entrySelector = config.selectors.raid.unclaimedRaidEntry;

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

        // Wait for network result event
        await new Promise((resolve) => {
          let resolved = false;
          const timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              this.controller.network?.off("battle:result", onResult);
              resolve(null);
            }
          }, 3000);

          const onResult = () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve(null);
            }
          };

          this.controller.network?.once("battle:result", onResult);
        });

        clearedCount++;
      } catch (error) {
        this.logger.error("[Error] Failed to process unclaimed raid", error);
        break;
      }
    }

    this.logger.info(`[System] Cleared ${clearedCount} pending battles`);
  }

  /**
   * Wait for battle:result network event before navigating away.
   * In quest mode, the result.json loads asynchronously after page reload
   * (triggered by boss death). If we navigate before it fires, GBF's SPA
   * router intercepts the late response and redirects back to #result,
   * causing a navigation loop.
   */
  async waitForBattleResult() {
    if (!this.controller.network) return;

    await new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.controller.network.off("battle:result", onResult);
          this.logger.debug(
            "[Network] Battle result timeout, proceeding anyway",
          );
          resolve();
        }
      }, 5000);

      const onResult = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.logger.debug("[Network] Battle result received");
          resolve();
        }
      };

      this.controller.network.once("battle:result", onResult);
    });
  }

  async checkEarlyBattleEndPopup() {
    return await this.battle.checkEarlyBattleEndPopup(true);
  }

  async checkCaptcha() {
    const selectors = config.selectors.battle;
    if (
      await this.controller.elementExists(selectors.captchaPopup, 1000, true)
    ) {
      const headerText = await this.controller.getText(selectors.captchaHeader);
      if (headerText.includes("Access Verification")) {
        this.logger.error(
          "[Safety] CAPTCHA detected. Human intervention required",
        );
        notifier.notifyCaptcha(this.profileId || "p1").catch(() => {});
        this.pause();
        return true;
      }
    }
    return false;
  }

  pause() {
    this.isPaused = true;
    this.logger.info("[Quest] Bot paused");
  }

  resume() {
    this.isPaused = false;
    this.logger.info("[Quest] Bot resumed");
  }

  stop() {
    this.isRunning = false;
    if (this.controller && this.controller.network) {
      this.controller.network.removeListener("raid:error", this.onRaidError);
      this.controller.network.removeListener(
        "raid:supporter_screen",
        this.onSupporterScreen,
      );
    }
    if (this.battle) {
      this.battle.stop();
    }
    this.controller.stop().catch(() => {});
    this.logger.info("[System] Shutdown initiated");
  }

  updateDetailStats(result) {
    if (!result) return;
    if (!this.totalTurns) this.totalTurns = 0;
    if (!this.battleCount) this.battleCount = 0;

    this.battleCount++;
    if (typeof result.turns === "number" && result.turns > 0)
      this.totalTurns += result.turns;
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

    let rate = "0.0/h";
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
      battleCount: this.battleCount || 0,
      lastBattleTime:
        this.battleTimes.length > 0
          ? this.battleTimes[this.battleTimes.length - 1]
          : 0,
      rate: rate,
    };
  }
}

export default QuestBot;
