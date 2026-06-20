import PageController from "../core/page-controller.js";
import { sleep, randomDelay } from "../utils/random.js";
import logger from "../utils/logger.js";
import config from "../utils/config.js";

/**
 * Handles battle orchestration, including state monitoring, mode execution (Full/Semi Auto),
 * and result processing. Integrates with NetworkListener for reactive combat logic.
 */
class BattleHandler {
    /**
     * @param {import('puppeteer').Page} page - The current browser page.
     * @param {object} [options={}] - Configuration options.
     */
    constructor(page, options = {}) {
        // Reuse parent bot's PageController if provided to avoid duplicate NetworkListeners
        this.controller = options.controller || new PageController(page);
        this.selectors = config.selectors.battle;
        this.stopped = false;
        this.battleStartTime = null;
        this.lastBattleDuration = 0;
        this.lastHonors = 0;
        this.fastRefresh = options.fastRefresh || false;
        this.noRefresh = options.noRefresh || false;
        this.summonRefresh = options.summonRefresh !== undefined ? options.summonRefresh : true;
        this.skillRefresh = options.skillRefresh !== undefined ? options.skillRefresh : false;
        this.preBattleAutoAttack = options.preBattleAutoAttack || "off";
        this.loopInterval = options.loopInterval !== undefined
            ? options.loopInterval
            : config.get('timeouts.loop_interval', 10);
        this.logger = options.logger || logger;
        this.faActive = false;
        this.isResultConfirmed = false;
    }

    /**
     * Formats milliseconds into a MM:SS string.
     * @param {number} milliseconds - Duration in ms.
     * @returns {string} Formatted time string.
     */
    formatTime(milliseconds) {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
    }

  stop() {
    this.stopped = true;
  }

    /**
     * Resets pre-registered network event flags to prevent stale data from affecting new battles.
     */
    resetPreFlags() {
        this._preNetworkFinished = false;
        this._preBossDied = false;
        this._prePartyWiped = false;
        this._preSummonUsed = false;
        this._preAbilityUsed = false;
        this._preAttackUsed = false;
        this._preNetworkTurn = 0;
        this._preNetworkTurnReady = false;
    }

    /**
     * Entry point for combat execution.
     * @param {string} [mode="full_auto"] - Combat mode ("full_auto", "semi_auto").
     * @param {object} [options={}] - Execution overrides.
     * @returns {Promise<object>} Battle summary (duration, turns, honors, rewards).
     */
    async executeBattle(mode = "full_auto", options = {}) {
    this.stopped = false;
    this.skipRaid = false;
    this.options = options;
    this.battleStartTime = Date.now();
    this.lastAttackTurn = 0;
    this.lastReloadTurn = 0;
    this.lastHonors = 0; // Reset per-raid so previousHonors starts at 0 for each new raid
    this.isResultConfirmed = false; // Reset for new battle
    this.controller.clearClickCache(); // Flush cache on new battle engagement
    this.logger.info(`[Battle] Mode: ${mode} engagement initiated`);

    // Create ref objects for lastActionTime and threshold so handleFullAuto can update them
    const lastActionTimeRef = { value: Date.now() };
    const faThresholdRef = { value: 25000 }; // Start with 25s for initial FA
    this.options.lastActionTimeRef = lastActionTimeRef;
    this.options.faThresholdRef = faThresholdRef;

    // Pre-Battle Auto Attack: fire on every battle:start (page reload during battle).
    // Defined outside try so it can be cleaned up in finally.
    const _onBattleStartForTap =
      this.preBattleAutoAttack !== "off"
        ? () => { this._doPrebattleTap().catch(() => { }); }
        : null;

    try {
      const currentUrl = this.controller.page.url();
      // Check for result page (both hash-based and path-based URLs)
      const isResultUrl =
        currentUrl.includes("#result") ||
        currentUrl.includes("/result/content/index/") ||
        currentUrl.includes("/result_multi/content/index/");
      if (isResultUrl) {
        return await this.waitForBattleEnd(mode);
      }

      if (options.refreshOnStart) {
        this.logger.info("[Battle] Action: Page reload (Animation skip)");
        await this.controller.reloadPage();
        await sleep(this.fastRefresh ? 20 : 50);

        const earlyStateAfterRefresh = await this.checkEarlyBattleEndPopup();
        if (earlyStateAfterRefresh) {
          return earlyStateAfterRefresh;
        }
      }

      if (!this.controller.isAlive()) {
        throw new Error("Battle failed: Page crashed or disconnected");
      }

      const loadSelector =
        mode === "semi_auto" ? this.selectors.attackButton : ".btn-auto";

      // Pre-Battle (initial load): start.json fires before listener registers, so check DOM directly
      if (this.preBattleAutoAttack !== "off") {
        const loadingVisible = await this.controller.page
          .evaluate(() => {
            const el = document.querySelector(".prt-start-direction");
            return el ? el.style.display !== "none" : false;
          })
          .catch(() => false);
        if (loadingVisible) this._doPrebattleTap().catch(() => { });
      }

      // Root Cause Fix: We cannot reliably listen for start.json here because the page navigation
      // (e.g. goto/reload) completes the network request BEFORE this executeBattle logic even runs.
      // Previously, the domReady race masked this by winning instantly. When domReady was removed,
      // it exposed the dead listener, resulting in consistent 10-second timeouts.

      // We wait for the battle UI to appear (max 10s) to validate we successfully entered the battle
      // before proceeding to Mode activation. This is a highly optimized DOM mutation check.
      let battleLoaded = await this.controller.waitForElement(loadSelector, 10000);

      if (!battleLoaded) {
        if (!this.controller.isAlive()) {
          throw new Error("Battle failed: Page crashed during load");
        }
        const currentUrl = this.controller.page.url();

        const earlyStateFallback = await this.checkEarlyBattleEndPopup();
        if (earlyStateFallback) {
          return earlyStateFallback;
        }

        if (currentUrl.includes("#raid") || currentUrl.includes("_raid")) {
          const dismissed = await this.dismissSalutePopup();
          if (dismissed) {
            if (this.options.skipOnSalute) {
              this.logger.info(
                "[Battle] Salute detected. Skipping raid as requested",
              );
              return { skipRaid: true, duration: 0, turns: 0 };
            }
            this.logger.info("[Battle] Action: Salute popup dismissed");
            await sleep(300);
            battleLoaded = await this.controller.waitForElement(
              loadSelector,
              10000,
            );
          }

          if (!battleLoaded) {
            this.logger.warn("[Warn] Battle: UI interface missing (Auto button not found). Performing Hard Reload...");
            await this.controller.reloadHard();
            // Wait another 10s after refresh
            battleLoaded = await this.controller.waitForElement(
              loadSelector,
              10000,
            );

            if (!battleLoaded) {
              this.logger.warn(
                "[Battle] Auto button still missing. Attempting recovery",
              );
            }
          }
        } else if (!currentUrl.includes("#result")) {
          // Safety: Check for a lagged confirmation button (OK) before throwing error
          const okBtn = ".btn-usual-ok";
          if (await this.controller.elementExists(okBtn, 2000, true)) {
            this.logger.info(
              "[Battle] Late confirmation button detected. Clicking",
            );
            await this.controller.clickSafe(okBtn, { fast: true });
            await sleep(400);
            battleLoaded = await this.controller.waitForElement(
              loadSelector,
              10000,
            );
          }

          if (!battleLoaded) {
            throw new Error(`Battle failed to load. URL: ${currentUrl}`);
          }
        }
      }

      // Proactive Turn Fetch
      const initialTurns = await this.getTurnNumber();
      this.logger.info("[Battle] State: Combat ready");

      // Pre-register battle events BEFORE handleFullAuto so that an instant quick-summon
      // (fired the moment FA activates) isn't missed due to the listener gap between
      // handleFullAuto() returning and waitForBattleEnd() registering its own handlers.
      this._preSummonUsed = false;
      this._preAbilityUsed = false;
      this._preAttackUsed = false;
      this._preBossDied = false;
      this._prePartyWiped = false;
      this._preNetworkTurn = 0;
      this._preNetworkTurnReady = false;
      this._preNetworkFinished = false;

      const _onPreSummon = () => {
        this._preSummonUsed = true;
      };
      const _onPreAbility = () => {
        this._preAbilityUsed = true;
      };
      const _onPreAttack = () => {
        this._preAttackUsed = true;
      };
      const _onPreBoss = () => {
        this._preBossDied = true;
      };
      const _onPreWipe = () => {
        this._prePartyWiped = true;
      };
      const _onPreStart = ({ turn }) => {
        this._preNetworkTurn = turn;
        this._preNetworkTurnReady = true;
      };
      const _onPreResult = () => {
        this._preNetworkFinished = true;
        this.isResultConfirmed = true; // Mark as end-state confirmed
      };

      // Register pre-battle tap for all reloads during this battle
      if (_onBattleStartForTap && this.controller.network) {
        this.controller.network.on("battle:start", _onBattleStartForTap);
      }

      try {
        if (this.controller.network) {
          this.controller.network.on("battle:summon_used", _onPreSummon);
          this.controller.network.on("battle:ability_used", _onPreAbility);
          this.controller.network.on("battle:attack_used", _onPreAttack);
          this.controller.network.on("battle:boss_died", _onPreBoss);
          this.controller.network.on("battle:party_wiped", _onPreWipe);
          this.controller.network.on("battle:start", _onPreStart);
          this.controller.network.once("battle:result", _onPreResult);
        }

        if (mode === "full_auto") {
          await this.handleFullAuto();
        } else if (mode === "semi_auto") {
          this._initialSemiAutoAttacked = await this.handleSemiAuto(true);
        }
      } finally {
        // REQUIRED: Remove pre-listeners immediately — waitForBattleEnd registers its own.
        // This finally block ensures they are removed even if an error occurs during FA/SA activation.
        if (this.controller.network) {
          this.controller.network.off("battle:summon_used", _onPreSummon);
          this.controller.network.off("battle:ability_used", _onPreAbility);
          this.controller.network.off("battle:attack_used", _onPreAttack);
          this.controller.network.off("battle:boss_died", _onPreBoss);
          this.controller.network.off("battle:party_wiped", _onPreWipe);
          this.controller.network.off("battle:start", _onPreStart);
          this.controller.network.off("battle:result", _onPreResult);
        }
      }

      if (this.skipRaid) {
        return { skipRaid: true, duration: 0, turns: 0 };
      }

      // Wait for battle to complete - return result for stats
      const result = await this.waitForBattleEnd(mode, initialTurns);

      // Calculate battle duration
      this.lastBattleDuration = Date.now() - this.battleStartTime;
      const formattedTime = this.formatTime(this.lastBattleDuration);
      this.logger.info(`[Status] Report: ${formattedTime} (Turns: ${result.turns})`);

      // Attach current honors to result for tracking
      this.lastHonors = result.honors; // Update lastHonors to current total

      // Append duration to result object so bots can verify it
      result.duration = this.lastBattleDuration;

      return result;
    } catch (error) {
      const isNavError =
        error.message.includes("Execution context was destroyed") ||
        error.message.includes("Target closed") ||
        error.message.includes("Session closed") ||
        this.controller.isNetworkError(error);

      if (isNavError) {
        this.logger.debug("[Battle] Interrupted by browser navigation or stop");
      } else {
        this.logger.error(`[Error] Battle: Execution failure (Fault: ${error.message})`);
        if (error.message.includes("Battle failed to load")) {
          this.logger.warn("[Warn] Battle: Combat load failure (Halt triggered)");
          this.stop();
        }
      }
      return { duration: 0, turns: 0 };
    } finally {
      // NetworkListener is managed by PageController — stopped only when session ends.
      if (_onBattleStartForTap && this.controller.network) {
        this.controller.network.off("battle:start", _onBattleStartForTap);
      }
    }
  }

    /**
     * Performs a pre-battle tap to arm auto-attack before the UI is fully interactive.
     * Uses CDP touch events for precise timing.
     * @private
     */
    async _doPrebattleTap() {
    try {
      const coords = await this.controller.page.evaluate(() => {
        const el = document.querySelector(".prt-auto-setting");
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      });

      const client = await this.controller.page.target().createCDPSession();
      try {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: coords.x, y: coords.y, id: 0 }],
        });
        await client.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
          changedTouches: [{ x: coords.x, y: coords.y, id: 0 }],
        });
      } finally {
        await client.detach().catch(() => { });
      }

      const confirmed = await this.controller.waitForElement(".btn-ready-auto", 500);
      this.logger.info(confirmed
        ? "[Battle] Pre-Battle: Auto attack armed"
        : "[Battle] Pre-Battle: btn-ready-auto not detected"
      );
    } catch (e) {
      this.logger.debug(`[Battle] Pre-Battle: Tap failed (${e.message})`);
    }
  }

    /**
     * Activates Full Auto mode and handles common post-activation popups.
     * Includes retry logic for UI inconsistencies.
     */
    async handleFullAuto() {
    const url = this.controller.page.url();
    // Check for result page (both hash-based and path-based URLs)
    const isResultUrl =
      url.includes("#result") ||
      url.includes("/result/content/index/") ||
      url.includes("/result_multi/content/index/");
    if (isResultUrl || url.includes("#quest/index")) return;

    this.logger.info("[Battle] Mode: Full Auto activation initiated");
    this.faActive = false; // Reset — will be set true after successful click

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        // Quick pre-check: if page is already on result/login, skip 20s wait
        const preUrl = this.controller.page.url();
        if (
          preUrl.includes("#result") ||
          preUrl.includes("/result/content/index/") ||
          preUrl.includes("/result_multi/content/index/") ||
          preUrl.includes("#quest/index") ||
          preUrl.includes("#mypage") ||
          preUrl.includes("#top")
        ) {
          return; // Battle ended or redirected — don't wait for FA button
        }

        const btnFound = await this.controller.waitForElement(
          this.selectors.fullAutoButton,
          20000,
        );

        if (!btnFound) {
          // Check for Salute popup
          const dismissed = await this.dismissSalutePopup();
          if (dismissed) {
            if (this.options.skipOnSalute) {
              this.logger.info(
                "[Battle] Salute detected. Skipping raid as requested",
              );
              this.skipRaid = true;
              return;
            }
            this.logger.info(
              `[Battle] Salute dismissed. Retry ${attempts}/${maxAttempts}`,
            );
            continue; // Try again in this while loop
          }

          this.logger.warn("[Warn] Battle: UI interface missing (Auto button not found). Performing Hard Reload...");
          await this.controller.reloadHard();
          await sleep(200);
          await this.checkStateAndResume("full_auto");
          return;
        }

        // btn-ready-auto persists in DOM after loading screen hides — reliable FA-armed signal
        const preBattleArmed = await this.controller.page
          .evaluate(() => !!document.querySelector(".btn-ready-auto"))
          .catch(() => false);

        if (preBattleArmed) {
          this.logger.info("[Battle] Full Auto already active (pre-battle armed). Skipping click");
          this.faActive = true;
        } else {
          await this.controller.cachedClick(this.selectors.fullAutoButton, 0);
          this.logger.debug("[Battle] Fast-clicked Full Auto");
          this.faActive = true;
        }

        // Fix: Update lastActionTime AND reset threshold after FA click
        // GBF lockout after chain bursts can last 10-20s, which is normal
        // This applies to EVERY FA activation (turn 1, turn 2+, re-engagement)
        if (this.options && this.options.lastActionTimeRef) {
          this.options.lastActionTimeRef.value = Date.now();
        }
        if (this.options && this.options.faThresholdRef) {
          this.options.faThresholdRef.value = 25000; // 25s after every FA click
        }

        // Handle common post-click popups
        await sleep(50);

        // 1.5 Handle "Waiting for last turn" popup
        if (
          await this.controller.elementExists(
            ".pop-usual.common-pop-error.pop-show",
            100,
          )
        ) {
          const errorText = await this.controller.getText(
            ".pop-usual.common-pop-error.pop-show .txt-popup-body",
          );
          if (errorText.includes("Waiting for last turn")) {
            await this.controller.reloadHard();
            await sleep(200);
            await this.checkStateAndResume("full_auto");
            return;
          }
        }

        // 1.6 Handle "Battle Concluded" popup
        if (
          await this.controller.elementExists(".pop-rematch-fail.pop-show", 100)
        ) {
          await this.controller.reloadHard();
          await sleep(200);
          await this.checkStateAndResume("full_auto");
          return;
        }

        // 1.7 Handle "Battle Already Ended" / assist raid popup
        // Fires when the raid ended between the page load and the FA click landing
        if (
          await this.controller.elementExists(".pop-result-assist-raid.pop-show", 100)
        ) {
          this.logger.info("[Battle] Already ended popup detected after FA click");
          await this.controller.reloadHard();
          await sleep(200);
          await this.checkStateAndResume("full_auto");
          return;
        }

        return; // Success, exit method
      } catch (e) {
        this.logger.warn(`[Full Auto] Click failed: ${e.message}`);
        await this.controller.reloadHard();
        await sleep(200);
        await this.checkStateAndResume("full_auto");
        return;
      }
    }

    this.logger.warn(
      `[Full Auto] Failed after ${maxAttempts} attempts. Performing Hard Reload`,
    );
    await this.controller.reloadHard();
    await sleep(200);
    await this.checkStateAndResume("full_auto");
  }

  /**
   * Verifies if FA is actually running.
   * Since GBF doesn't change the DOM when FA is clicked (no class toggle),
   * we track state internally via this.faActive flag set by handleFullAuto.
   */
  async verifyFullAutoState() {
    // Internal state tracking: if handleFullAuto clicked the button without error,
    // FA is running. GBF provides no reliable DOM signal for FA state.
    if (this.faActive) return true;

    // Frame validity guard: check frame is attached before evaluate
    if (!(await this.controller.isFrameAttached())) {
      this.logger.debug(
        "[Full Auto] Frame detached during verify, assuming active",
      );
      return true;
    }

    return await this.controller.page
      .evaluate((selectors) => {
        // Safety: If the page is still in a loading/overlay state, assume FA is active/pending
        const loading = document.querySelector(
          ".prt-loading-container, .prt-popup-back.show, #loading-mask",
        );
        if (loading && loading.offsetHeight > 0) return true;

        // Check for explicit FA-active signals (some GBF versions may add 'pushed')
        const autoBtn = document.querySelector(selectors.fullAutoButton);
        if (autoBtn && autoBtn.classList.contains("pushed")) return true;

        return false;
      }, this.selectors)
      .catch(() => true); // If evaluate fails, assume active (don't reload on frame issues)
  }

    /**
     * Executes a single combat turn in Semi Auto mode.
     * Performs a reactive attack and optional animation skip reload.
     * @returns {Promise<boolean>} True if the attack was network-confirmed.
     */
    async handleSemiAuto(skipReloadOnTimeout = false) {
    const activeSelector = ".btn-attack-start.display-on";
    const startTime = Date.now();

    // Step 1: Reactive Attack Activation (Ultra-fast polling)
    // Replaces waitForSelector with sub-10ms resolution to fire the instant UI is ready.
    this.logger.debug("[Battle] Awaiting reactive attack activation...");
    let attackReady = false;
    const attackWatchdog = config.get('timeouts.semi_auto_watchdog', 10000);
    while (Date.now() - startTime < attackWatchdog) {
      if (await this.controller.elementExists(activeSelector, 0, true)) {
        attackReady = true;
        break;
      }
      await sleep(Math.max(5, Math.floor(this.loopInterval / 2))); // Ultra-snappy cadence
    }

    if (!attackReady) {
      this.logger.warn("[Warn] Battle: Exception (Attack button timeout)");
      if (!skipReloadOnTimeout) {
        await this.controller.reloadPage();
      }
      return false;
    }

    // Step 2: Register listeners BEFORE clicking — fast servers can return _attack_result.json
    // before a post-click registration would catch it, causing a 3s timeout every turn.
    // Also listen for battle:result to short-circuit the timeout when the boss dies on this hit
    // (killing blow triggers result directly with no attack_result.json).
    this.logger.debug("[Battle] Waiting for attack confirmation...");
    let battleEndedDuringAttack = false;
    const attackConfirmedPromise = new Promise((resolve) => {
      let resolved = false;
      const cleanup = () => {
        if (this.controller.network) {
          this.controller.network.off("battle:attack_used", onAttack);
          this.controller.network.off("battle:result", onResult);
        }
      };
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(false);
        }
      }, config.get('timeouts.semi_auto_attack_confirm', 3000));

      const onAttack = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          cleanup();
          this.logger.debug("[Semi Auto] Attack confirmed via network");
          resolve(true);
        }
      };

      const onResult = () => {
        if (!resolved) {
          resolved = true;
          battleEndedDuringAttack = true;
          clearTimeout(timeout);
          cleanup();
          resolve(false);
        }
      };

      if (this.controller.network) {
        this.controller.network.once("battle:attack_used", onAttack);
        this.controller.network.once("battle:result", onResult);
      } else {
        clearTimeout(timeout);
        resolve(false);
      }
    });

    try {
      await this.controller.cachedClick(activeSelector, 0);
    } catch (e) {
      this.logger.warn(`[Warn] Battle: Attack failure (Fault: ${e.message})`);
      await this.controller.reloadPage();
      return false;
    }
    this.logger.info("[Battle] Attack execution initiated");

    // Step 3: Await confirmation (listener was armed before the click)
    const attackConfirmed = await attackConfirmedPromise;

    if (!attackConfirmed) {
      // battle:result fired during the wait — boss died on this hit, no need to reload
      if (battleEndedDuringAttack) {
        this.logger.info("[Battle] State: Combat concluded (Killing blow detected)");
        return false;
      }
      this.logger.warn(
        "[Semi Auto] Network confirmation timeout. Checking state...",
      );
      // Check if battle ended
      const ended = await this.controller.page
        .evaluate(() => {
          return !!document.querySelector(
            ".prt-result, #js-result, .pop-cheer, .btn-cheer",
          );
        })
        .catch(() => false);
      if (ended) {
        this.logger.info("[Battle] State: Combat concluded (Skipping attack)");
        await sleep(100);
        return false;
      }
      this.logger.warn("[Semi Auto] Refreshing anyway");
    }

    // Step 5: Check if battle ended during attack confirmation to avoid unnecessary reload
    if (this.stopped) return false;

    const isEnded = await this.controller.page
      .evaluate(() => {
        const href = window.location.href;
        const resultVisible = !!document.querySelector(
          ".prt-result, #js-result, .cnt-result",
        );
        return (
          href.includes("#result") ||
          href.includes("/result/content/index/") ||
          resultVisible
        );
      })
      .catch(() => false);

    if (isEnded) {
      this.logger.info(
        "[Semi Auto] Combat ended (Skipping animation-skip reload)",
      );
      return attackConfirmed;
    }

    // Step 6: Refresh to skip animations
    // Following Full Auto pattern: return immediately after starting reload.
    this.logger.info("[Battle] Page reload triggered (Animation skip)");
    await this.controller.reloadPage();
    await sleep(5); // Minimal settle (reduced from 20ms)
    return attackConfirmed;
  }

    /**
     * Monitors the battle progress until termination (victory, defeat, or timeout).
     * Orchestrates reactive reloads and honor/turn logging based on network events.
     * @param {string} mode - Active combat mode.
     * @param {number|null} [initialTurns=null] - Pre-fetched turn count.
     * @returns {Promise<object>} Final battle statistics.
     */
    async waitForBattleEnd(mode, initialTurns = null) {
    const honorTarget = parseInt(this.options?.honorTarget, 10) || 0;
    this.logger.debug(
      `[Honor] Target: ${honorTarget.toLocaleString()} (raw: "${this.options?.honorTarget}")`,
    );
    const maxWaitMinutes = config.get("bot.max_battle_time") || 15;
    const maxWaitMs = maxWaitMinutes * 60 * 1000;
    const startTime = Date.now();
    // checkInterval will be dynamic inside the loop
    let missingUiCount = 0;
    let lastFACheckTime = Date.now(); // Start timer from now to avoid immediate fire
    let lastEndStateCheckTime = 0; // Throttle battle-end DOM checks to 1000ms
    let lastCheckTurn = 0; // Used for Turn-Change Priority Refresh
    let lastSkipCheckTime = 0; // Throttle non-raid menu checks
    let iterationCount = 0; // Memory: track loop iterations for GC
    let lastHardReloadTime = Date.now(); // Memory: track last hard reload
    const hardReloadInterval = 30 * 60 * 1000; // 30 minutes in ms

    const currentUrl = this.controller.page.url();
    const isRaid = currentUrl.includes("#raid") || currentUrl.includes("_raid");

    // Initial turn/honor detection consolidated into a single fetch
    const isSemiAuto = mode === "semi_auto";
    let turnCount = 0;
    let previousHonors =
      this.options?.initialHonors > 0
        ? this.options.initialHonors
        : this.lastHonors || 0;

    if (initialTurns !== null) {
      turnCount = initialTurns;
    } else {
      const state = await this.getBattleState();
      turnCount = state.turn;
      if (isRaid && state.honors !== null) {
        previousHonors = state.honors;
      }
    }

    let lastTurn = turnCount;
    let lastTurnChangeTime = Date.now();
    let honorTargetReached = false; // Track when honor target is reached

    // Seed lastAttackedTurn only if the initial semi-auto attack actually landed.
    // If it failed (button not found → reload), keep -1 so same-turn reload re-arms networkTurnReady.
    const initialAttacked = isSemiAuto ? (this._initialSemiAutoAttacked === true) : false;
    let lastAttackedTurn = initialAttacked ? turnCount : -1;
    this.logger.debug(`[Battle] Resolving turns (Mode: ${mode})`);

    if (!isSemiAuto && turnCount > 0) {
      const honorLog =
        isRaid && previousHonors > 0
          ? ` ${previousHonors.toLocaleString()} honor`
          : "";
      this.logger.info(`[Turn ${turnCount}]${honorLog}`);

      if (isRaid && honorTarget > 0 && previousHonors >= honorTarget) {
        this.logger.info(
          `[Target] Honor goal reached: ${previousHonors.toLocaleString()} / ${honorTarget.toLocaleString()}`,
        );
        return {
          duration: (Date.now() - startTime) / 1000,
          turns: Math.max(turnCount, 1),
          honors: previousHonors,
          honorReached: true,
        };
      }
    }

    // Network event flags
    let networkFinished = this._preNetworkFinished || false;
    let bossDied = this._preBossDied || false;
    let partyWiped = this._prePartyWiped || false;
    let attackUsed = this._preAttackUsed || false;
    let summonUsed = this._preSummonUsed || false;
    let abilityUsed = this._preAbilityUsed || false;

    let networkTurn =
      this._preNetworkTurn > 0 ? this._preNetworkTurn : turnCount;
    let networkTurnReady = this._preNetworkTurnReady || false;

    // Reset pre-flags immediately after seeding
    this._preSummonUsed = false;
    this._preAbilityUsed = false;
    this._preAttackUsed = false;
    this._preBossDied = false;
    this._prePartyWiped = false;
    this._preNetworkTurn = 0;
    this._preNetworkTurnReady = false;
    this._preNetworkFinished = false;
    let lastActionTime = Date.now();
    let faInactivityThreshold = 25000; // Initial: 25s for OUGI lockout after FA click
    let lastHonorCheckTime = 0; // Throttle getHonors() DOM reads to every 3s

    // If turn changed during transition, log it now (full_auto only)
    if (!isSemiAuto && networkTurn > turnCount) {
      this.logger.info(`[Turn ${networkTurn}]`);
      turnCount = networkTurn;
    } else if (isSemiAuto && networkTurn > turnCount) {
      turnCount = networkTurn; // still need turnCount updated for lastAttackedTurn logic
    }
    let lastAttackEventTime = 0; // Track when attack event was received
    let lastAttackRefreshTime = 0; // Track last attack-based refresh

    const updateHonor = async (netHonor, existingHonors = null) => {
      if (isSemiAuto || !isRaid) return; // Skip honor reads in semi-auto and non-raid modes
      // Use snapshot honors when available to avoid a redundant IPC round-trip.
      const honor = existingHonors !== null ? existingHonors : await this.getHonors();

      if (honor !== null && honor > previousHonors) {
        const diff = honor - previousHonors;
        this.logger.info(
          `[Honor] ${honor.toLocaleString()} (+${diff.toLocaleString()})`,
        );
        previousHonors = honor;

        // Stop early if goal reached
        if (
          honorTarget > 0 &&
          previousHonors >= honorTarget &&
          !honorTargetReached
        ) {
          this.logger.info(
            `[Target] Honor goal reached: ${previousHonors.toLocaleString()} / ${honorTarget.toLocaleString()}`,
          );
          honorTargetReached = true;
        }
      }
    };

    let capturedRewards = null;
    const onBattleResult = ({ rewards } = {}) => {
      networkFinished = true;
      if (rewards != null) capturedRewards = rewards;
      if (!this.isResultConfirmed) {
        this.isResultConfirmed = true;
        this.logger.info("[Status] Signal: Combat Result (Rewards) detected");
      }
    };
    const onBossDied = ({ honor } = {}) => {
      updateHonor(honor);
      bossDied = true;
      if (!this.isResultConfirmed) {
        this.isResultConfirmed = true;
        this.logger.info("[Status] Signal: Combat Result (Boss Died) detected");
      }
    };
    const onPartyWiped = ({ honor } = {}) => {
      updateHonor(honor);
      partyWiped = true;
      if (!this.isResultConfirmed) {
        this.isResultConfirmed = true;
        this.logger.info("[Status] Signal: Combat Result (Wiped) detected");
      }
    };
    if (this._preNetworkFinished && !this.isResultConfirmed) {
      onBattleResult();
    }
    const onAttack = ({ honor } = {}) => {
      attackUsed = true;
      this.options.lastActionTimeRef.value = Date.now();
      // Do NOT touch faThresholdRef here — handleFullAuto sets it to 25s after every FA click,
      // and reducing it to 5s races against the loop's attackUsed handler on fast (no-skill) turns.
      lastFACheckTime = Date.now();
      lastAttackEventTime = Date.now();
    };
    const onSummonUsed = ({ honor } = {}) => {
      updateHonor(honor);
      summonUsed = true;
      this.options.lastActionTimeRef.value = Date.now();
      this.options.faThresholdRef.value = 8000; // 5s after summon (+2s per user request)
      lastFACheckTime = Date.now();
    };
    const onAbilityUsed = ({ honor } = {}) => {
      abilityUsed = true;
      this.options.lastActionTimeRef.value = Date.now();
      this.options.faThresholdRef.value = 8000; // 5s after ability (+2s per user request)
      lastFACheckTime = Date.now();
    };

    const onBattleStart = ({ turn }) => {
      // In semi_auto, after an attack the page reloads and start.json re-fires with the
      // SAME turn number (server hasn't advanced yet). We only want to re-arm networkTurnReady
      // for a same-turn reload if we haven't already attacked that turn (turn > lastAttackedTurn).
      // For a genuine new turn (turn > networkTurn) we always re-arm.
      const isSameTurnReload =
        isSemiAuto && turn === networkTurn && turn > lastAttackedTurn;
      if (turn > networkTurn || isSameTurnReload) {
        // Log TURN immediately for UI feedback (full_auto only — SA doesn't need it)
        if (!isSemiAuto && turn > turnCount) {
          this.logger.info(`[Turn ${turn}]`);
          turnCount = turn; // Update so loop logic doesn't double-log
        } else if (turn > turnCount) {
          turnCount = turn; // Still update for lastAttackedTurn logic
        }

        networkTurn = turn;
        networkTurnReady = true; // Signal Semi Auto: new turn, attack button should be ready
        this.options.lastActionTimeRef.value = Date.now();
        // FA: turn just started — attack + skills haven't resolved yet (can take 10-15s).
        // SA: button is ready immediately — use configured watchdog threshold (default 10s).
        const saThreshold = config.get("timeouts.semi_auto_watchdog", 10000);
        this.options.faThresholdRef.value = isSemiAuto ? saThreshold : 15000;
        lastFACheckTime = Date.now();
        lastAttackEventTime = 0;
        attackUsed = false; // Clear stale attack flag on turn change
        this.logger.debug(
          `[Network] Turn ${turn} started (timeout reset), networkTurnReady=true`,
        );
      }
    };

    try {
      if (this.controller.network) {
        this.controller.network.on("battle:result", onBattleResult);
        this.controller.network.on("battle:boss_died", onBossDied);
        this.controller.network.on("battle:party_wiped", onPartyWiped);
        this.controller.network.on("battle:start", onBattleStart);
        this.controller.network.on("battle:attack_used", onAttack);
        this.controller.network.on("battle:ability_used", onAbilityUsed);
        this.controller.network.on("battle:summon_used", onSummonUsed);
      }

      while (Date.now() - startTime < maxWaitMs) {
        // Sync lastActionTime and threshold from refs (may be updated by handleFullAuto)
        lastActionTime = this.options.lastActionTimeRef.value;
        faInactivityThreshold = this.options.faThresholdRef.value;

        // Fast-path: battle:result already fired — exit without DOM snapshot.
        // Prevents hang when page.evaluate blocks mid-navigation (e.g. semi-auto reload
        // on result page sets networkFinished during the reload, but snapshot call never resolves).
        if (networkFinished) {
          await sleep(50);
          if (!capturedRewards) {
            const deadline = Date.now() + 2000;
            while (!capturedRewards && Date.now() < deadline) await sleep(50);
          }
          return {
            duration: (Date.now() - startTime) / 1000,
            turns: isSemiAuto ? "N/A" : Math.max(turnCount + 1, 1),
            honors: previousHonors,
            honorReached: honorTargetReached,
            rewards: capturedRewards,
          };
        }

        // SPD-02: Batched UI State Snapshot (Replaces multiple individual IPC calls)
        const snapshot = await this.getBattleStateSnapshot();
        const currentUrl = snapshot.url;

        // Turn-Change Priority: network turn incremented — bypass throttles for immediate check
        if (turnCount > lastCheckTurn) {
          lastCheckTurn = turnCount;
          lastEndStateCheckTime = 0;
        }
        if (this.stopped) {
          this.logger.info("[Battle] Cancelled (Bot stopped)");
          const duration = (Date.now() - startTime) / 1000;
          return {
            duration,
            turns: isSemiAuto ? "N/A" : Math.max(turnCount, 1),
          };
        }

        // --- PRIORITY 0: Network end-state signals (fastest) ---
        if (bossDied || partyWiped) {
          if (this.noRefresh) {
            // Free quest: game auto-navigates to result URL — clear flags and wait for networkFinished
            bossDied = false;
            partyWiped = false;
          } else {
            await this.controller.page.reload({ waitUntil: "domcontentloaded" });
            await sleep(this.fastRefresh ? 100 : 200);
            if (
              isRaid &&
              honorTarget > 0 &&
              !honorTargetReached &&
              previousHonors >= honorTarget
            ) {
              honorTargetReached = true;
            }
            return {
              duration: (Date.now() - startTime) / 1000,
              turns: isSemiAuto ? "N/A" : Math.max(turnCount, 1),
              honors: previousHonors,
              honorReached: honorTargetReached,
            };
          }
        }

        if (networkFinished) {
          await sleep(50);
          if (
            isRaid &&
            honorTarget > 0 &&
            !honorTargetReached &&
            previousHonors < honorTarget
          ) {
            const finalHonor = await this.getHonors();
            if (finalHonor > previousHonors) previousHonors = finalHonor;
            if (finalHonor >= honorTarget) honorTargetReached = true;
          }
          // Wait up to 2s for content/detail XHR to arrive after content/index
          if (!capturedRewards) {
            const deadline = Date.now() + 2000;
            while (!capturedRewards && Date.now() < deadline) await sleep(50);
          }
          return {
            duration: (Date.now() - startTime) / 1000,
            turns: isSemiAuto ? "N/A" : Math.max(turnCount + 1, 1),
            honors: previousHonors,
            honorReached: honorTargetReached,
            rewards: capturedRewards,
          };
        }

        // DOM fallback: start.json may fire before any listener registers (during waitForElement
        // or getTurnNumber). If button is ready but networkTurnReady is still false, arm it now.
        if (isSemiAuto && !networkTurnReady && snapshot.isAttackOn && !networkFinished) {
          this.logger.debug("[Semi Auto] DOM fallback: attack button ready, arming networkTurnReady");
          networkTurnReady = true;
          if (networkTurn === 0) networkTurn = turnCount;
        }

        // --- PRIORITY 1: Semi-Auto Detection (network-driven) ---
        // battle:start fires via start.json when a new turn begins — attack button is ready
        if (isSemiAuto && networkTurnReady && !networkFinished) {
          this.logger.debug(
            "[Semi Auto] networkTurnReady detected, attacking...",
          );
          networkTurnReady = false;
          const attackedTurnAttempt = networkTurn;
          lastAttackedTurn = attackedTurnAttempt; // optimistic — blocks same-turn reload re-arm during await
          const confirmed = await this.handleSemiAuto(); // DOM check for .display-on
          if (!confirmed) {
            lastAttackedTurn = attackedTurnAttempt - 1; // rollback — allow same-turn reload to retry
          }
          continue;
        }

        // Exit early if honor target reached
        if (honorTargetReached) {
          return {
            duration: (Date.now() - startTime) / 1000,
            turns: isSemiAuto ? "N/A" : Math.max(turnCount, 1),
            honors: previousHonors,
            honorReached: true,
          };
        }

        // 3. Result Page Detection (Snapshot-based)
        if (snapshot.isResultPage || snapshot.hash.includes("#result")) {
          if (!this.isResultConfirmed) {
            this.isResultConfirmed = true;
            this.logger.info("[Status] Signal: Combat Result (Page) detected");
          }
          // Wait for network confirmation to avoid race condition with quest navigation
          // The network event may fire after URL change, so we poll networkFinished flag
          if (!networkFinished) {
            this.logger.debug(
              "[Network] Result page detected, awaiting network confirmation...",
            );
            const waitStart = Date.now();
            // Optimization: If URL already contains #result, reduce wait to 300ms (fast skip)
            const waitTimeout = snapshot.hash.includes("#result") ? 300 : 1500;
            while (!networkFinished && Date.now() - waitStart < waitTimeout) {
              await sleep(50);
            }
            if (networkFinished) {
              this.logger.debug(
                `[Network] Result network confirmation received (${Date.now() - waitStart}ms)`,
              );
            } else {
              this.logger.debug(
                `[Network] Result network confirmation timeout (1.5s), proceeding anyway`,
              );
            }
          } else {
            this.logger.debug(
              "[Network] Result page detected, networkFinished already set",
            );
          }
          // Final honor check before returning from result page
          if (isRaid && honorTarget > 0 && !honorTargetReached) {
            const finalHonor = await this.getHonors();
            if (finalHonor > previousHonors) previousHonors = finalHonor;
            if (finalHonor >= honorTarget) honorTargetReached = true;
          }
          return {
            duration: (Date.now() - startTime) / 1000,
            turns: isSemiAuto ? "N/A" : Math.max(turnCount, 1),
            honors: previousHonors,
            honorReached: honorTargetReached,
          };
        }

        // Network-Driven End-State Detection (throttled DOM checks removed)
        // Rely on battle:result network event for primary detection
        // DOM watchdog kept only for stuck battle recovery
        if (Date.now() - lastEndStateCheckTime > 3000) {
          lastEndStateCheckTime = Date.now();

          // Watchdog: Check if attack is processing (via snapshot)
          const isAttacking = !!snapshot.isAttackOn; // If display-on, we are potentially attacking or ready
          const uiVisible = !!snapshot.isAttackOn || snapshot.isAutoOn || snapshot.isPopShow;

          // Watchdog Logic: Detect stuck battles
          if (!isAttacking) {
            if (uiVisible) {
              missingUiCount = 0;
            } else {
              missingUiCount++;
              if (missingUiCount >= 6 && !this.noRefresh) {
                // ~18s with 3s checks
                this.logger.warn("[Battle] UI missing (stuck). Refreshing");
                await this.controller.reloadPage();
                await sleep(this.fastRefresh ? 100 : 200);
                this.controller.clearClickCache();
                try {
                  if (isSemiAuto) {
                    this.logger.info("[Battle] Re-engaging Semi Auto");
                    networkTurnReady = true;
                  } else {
                    await this.handleFullAuto();
                  }
                } catch (e) {
                  this.logger.warn(
                    `[Battle] Re-engagement failed: ${e.message}`,
                  );
                }
                lastFACheckTime = Date.now();
                missingUiCount = 0;
              }
            }
          } else {
            missingUiCount = 0;
          }
        }

        if (currentUrl.match(/#(?:raid|raid_multi)(?:\/|$)/) && !this.noRefresh) {
          // Animation Skipping (Full Auto only — SA handles its own reload after each attack)
          // Added: Check lastReloadTurn to avoid reloading multiple times for the same turn animation skip

          // 0.5. Summon Used: Reload immediately to skip summon animation (if enabled)
          if (mode !== "semi_auto" && summonUsed) {
            summonUsed = false;
            if (this.summonRefresh) {
              this.logger.info("[Summon] Refreshing page after summon");
              await this.controller.reloadPage();
              await sleep(this.fastRefresh ? 100 : 200);
              this.controller.clearClickCache();
              try {
                await this.handleFullAuto();
              } catch (e) {
                this.logger.warn(`[Battle] Re-engagement failed: ${e.message}`);
              }
              lastFACheckTime = Date.now();
              continue;
            }
          }

          // 0.6. Ability Used: Reload immediately to skip skill animation (if enabled, Full Auto only)
          if (mode !== "semi_auto" && abilityUsed) {
            abilityUsed = false;
            if (this.skillRefresh) {
              this.logger.info("[Ability] Refreshing page after skill usage");
              await this.controller.reloadPage();
              await sleep(this.fastRefresh ? 100 : 200);
              this.controller.clearClickCache();
              try {
                await this.handleFullAuto();
              } catch (e) {
                this.logger.warn(`[Battle] Re-engagement failed: ${e.message}`);
              }
              lastFACheckTime = Date.now();
              continue;
            }
          }

          // 1. Network Attack Skip (Priority)
          // Honor is read from DOM here — right after the attack is processed server-side —
          // before the page reload tears down the DOM.
          if (mode !== "semi_auto" && attackUsed) {
            attackUsed = false;

            // Duplicate guard: skip if the attack event arrived before (or during) the last refresh.
            // Using Date.now() vs lastAttackRefreshTime was broken — lastAttackRefreshTime is set
            // AFTER handleFullAuto, so any attack that fires during handleFullAuto would always read
            // near-zero delta and get silently swallowed with no refresh.
            if (lastAttackEventTime <= lastAttackRefreshTime) {
              continue;
            }

            this.logger.info("[Battle] Normal attack fired");

            // Check honor once: After attack, but BEFORE reload (as requested)
            // Pass snapshot.honors to skip redundant getBattleStateSnapshot IPC call.
            if (isRaid) {
              await updateHonor(null, snapshot.honors ?? null);
            }

            // Exit immediately if goal was just reached — no need to reload/re-engage
            if (honorTargetReached) {
              return {
                duration: (Date.now() - startTime) / 1000,
                turns: isSemiAuto ? "N/A" : Math.max(turnCount, 1),
                honors: previousHonors,
                honorReached: true,
              };
            }

            // Security-04: Variable Refresh Jitter
            await this.controller.reloadPage();
            await sleep(this.fastRefresh ? 20 : 50);
            this.controller.clearClickCache();
            try {
              await this.handleFullAuto();
            } catch (e) {
              this.logger.warn(`[Battle] Re-engagement failed: ${e.message}`);
            }
            lastAttackRefreshTime = Date.now();
            lastFACheckTime = Date.now();
            continue;
          }

          // 3. Persistence Check — refresh after no activity for a long period
          const persistenceThreshold = mode === "semi_auto" ? 15000 : 25000; // Keeping FA at 25s for persistence, but watchdog will hit earlier
          if (
            (mode === "full_auto" || mode === "semi_auto") &&
            !this.stopped &&
            Date.now() - lastFACheckTime > persistenceThreshold
          ) {
            this.logger.info(`[${mode === "semi_auto" ? "Semi Auto" : "Full Auto"}] Inactive ${persistenceThreshold / 1000}s. Performing Hard Reload`);
            lastFACheckTime = Date.now();
            this.options.lastActionTimeRef.value = Date.now();
            this.options.faThresholdRef.value = mode === "semi_auto" ? config.get("timeouts.semi_auto_watchdog", 10000) : 15000;
            await this.controller.reloadHard();
            await sleep(this.fastRefresh ? 20 : 50);
            this.controller.clearClickCache();
            try {
              if (mode === "semi_auto") {
                this.logger.info("[Battle] Re-engaging Semi Auto");
                networkTurnReady = true;
              } else {
                await this.handleFullAuto();
              }
            } catch (e) {
              this.logger.warn(`[Battle] Re-engagement failed: ${e.message}`);
            }
            lastFACheckTime = Date.now();
            continue;
          }

          // 4. Inactivity Watchdog (Dynamic threshold)
          if (
            (mode === "full_auto" || mode === "semi_auto") &&
            Date.now() - lastActionTime > faInactivityThreshold
          ) {
            this.logger.warn(`[${mode === "semi_auto" ? "Semi Auto" : "Full Auto"}] Inactive. Performing Hard Reload`);
            this.options.lastActionTimeRef.value = Date.now();
            this.options.faThresholdRef.value = mode === "semi_auto" ? config.get("timeouts.semi_auto_watchdog", 10000) : 15000; // Reset after recovery refresh
            await this.controller.reloadHard();
            await sleep(this.fastRefresh ? 20 : 50);
            this.controller.clearClickCache();
            try {
              if (mode === "semi_auto") {
                this.logger.info("[Battle] Re-engaging Semi Auto");
                networkTurnReady = true;
              } else {
                await this.handleFullAuto();
              }
            } catch (e) {
              this.logger.warn(`[Battle] Re-engagement failed: ${e.message}`);
            }
            lastFACheckTime = Date.now();
            continue;
          }
        }

        if (!currentUrl.includes("#raid") && !currentUrl.includes("_raid")) {
          // Throttled menu checks (network-primary, DOM fallback for empty result)
          if (Date.now() - lastSkipCheckTime > 1000) {
            lastSkipCheckTime = Date.now();
            if (
              await this.controller.elementExists(
                this.selectors.emptyResultNotice,
                100,
              )
            ) {
              // Check honor target before returning
              if (
                isRaid &&
                honorTarget > 0 &&
                !honorTargetReached &&
                previousHonors >= honorTarget
              ) {
                honorTargetReached = true;
              }
              return {
                duration: (Date.now() - startTime) / 1000,
                turns: isSemiAuto ? "N/A" : Math.max(turnCount, 1),
                honors: previousHonors,
                honorReached: honorTargetReached,
              };
            }
          }
        }

        // Memory Management: Periodic GC every 100 iterations (~10s)
        // This prevents heap bloat from accumulated battle objects and closures
        if (iterationCount % 100 === 0) {
          this.controller.triggerGC();
        }
        iterationCount++;

        // Memory Management: Hard reload every 30 minutes to clear page context
        // This clears accumulated DOM nodes, JS heap, and cached responses from GBF SPA
        if (Date.now() - lastHardReloadTime > hardReloadInterval) {
          this.logger.info(
            "[Memory] Periodic Hard Reload to clear page context",
          );
          await this.controller.reloadHard();
          await sleep(500);
          lastHardReloadTime = Date.now();
          // Reset iteration counter to avoid immediate GC after reload
          iterationCount = 0;
        }
        await sleep(this.loopInterval);
      }

      throw new Error("Battle timeout");
    } finally {
      if (this.controller.network) {
        this.controller.network.off("battle:result", onBattleResult);
        this.controller.network.off("battle:boss_died", onBossDied);
        this.controller.network.off("battle:party_wiped", onPartyWiped);
        this.controller.network.off("battle:start", onBattleStart);
        this.controller.network.off("battle:attack_used", onAttack);
        this.controller.network.off("battle:ability_used", onAbilityUsed);
        this.controller.network.off("battle:summon_used", onSummonUsed);
      }
    }
  }

  async handleResult() {
    // Skips clicking OK as requested.
  }

  /**
   * Standardized state detection after refresh.
   */
  async checkStateAndResume(mode) {
    try {
      return await this._checkStateAndResume(mode);
    } catch (e) {
      this.logger.warn(
        `[Battle] State check failed: ${e.message}. Will continue loop`,
      );
      return false;
    }
  }

  async _checkStateAndResume(mode) {
    const url = this.controller.page.url();

    // Check both hash-based and path-based result/quest index URLs
    const isResultUrl =
      url.includes("#result") ||
      url.includes("/result/content/index/") ||
      url.includes("/result_multi/content/index/") ||
      url.includes("#quest/index") ||
      url.includes("/quest/index/content/index/");
    if (isResultUrl) {
      return true;
    }

    // Check for Empty Result Notice or Wipe/Cheer popup (network is primary, this is fallback)
    const endState2 = await this.controller.page
      .evaluate((selectors) => {
        if (document.querySelector(selectors.emptyResultNotice))
          return "empty_result";
        const cheer = document.querySelector(
          ".pop-cheer.pop-show, .btn-cheer, .btn-salute",
        );
        if (cheer && cheer.offsetWidth > 0) return "wiped";
        const rematch = document.querySelector(".pop-rematch-fail.pop-show");
        if (rematch && rematch.offsetWidth > 0) return "wiped";
        const elixir = document.querySelector(".pop-use-elixir, .img-elixir");
        if (elixir && elixir.offsetWidth > 0) return "wiped";
        return null;
      }, this.selectors)
      .catch(() => null);

    if (endState2 === "wiped") {
      this.logger.info("[Battle] Party wiped");
      return true;
    }
    if (endState2 === "empty_result") {
      this.logger.info("[Battle] Empty result detected");
      return true;
    }

    // Still in battle? Quick pre-check before re-engaging FA to prevent reload loops
    this.logger.debug("[Battle] Checking for battle UI to re-engaging FA");

    // Frame stability guard: ensure frame is attached before waitForFunction
    if (!(await this.controller.isFrameAttached())) {
      this.logger.warn(
        "[Battle] Frame detached during state check, waiting for stability...",
      );
      await this.controller.waitForFrameStable(2000);
    }

    const foundState = await this.controller.page
      .waitForFunction(
        () => {
          const ui = document.querySelector(
            ".btn-attack-start, .btn-auto, .btn-usual-cancel",
          );
          if (ui && ui.offsetWidth > 0) return "battle";

          const cheer = document.querySelector(
            ".pop-cheer.pop-show, .btn-cheer, .btn-salute",
          );
          if (cheer && cheer.offsetWidth > 0) return "wiped";

          const ended = document.querySelector(
            ".prt-result, #js-result, .pop-result-assist-raid.pop-show, .pop-usual.pop-show",
          );
          if (ended && ended.offsetWidth > 0) return "ended";

          const href = window.location.href;
          if (
            href.includes("#result") ||
            href.includes("/result/content/index/") ||
            href.includes("#quest/index") ||
            href.includes("/quest/index/content/index/")
          )
            return "ended";

          return null;
        },
        { timeout: 2000 },
      )
      .then((res) => res.jsonValue())
      .catch(() => null);

    if (foundState === "wiped") {
      this.logger.info("[Battle] Party wiped");
      return true;
    }

    if (foundState === "ended") {
      // Found a terminal state, don't wait further
      return true;
    }

    const found = foundState === "battle";

    if (found && !this.stopped) {
      if (mode === "full_auto") {
        // Wait briefly for start.json so [Turn X] is logged before [Full Auto] Activating
        if (this.controller.network) {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, 200); // max 200ms wait (was 500ms)
            this.controller.network.once("battle:start", () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
        this.logger.info("[Battle] Re-engaging Full Auto");
        this.faActive = false; // Reset before re-engagement — handleFullAuto sets true on success
        await this.handleFullAuto();
        // Signal caller to update lastActionTime by returning a special value
        return { faReengaged: true };
      } else if (mode === "semi_auto") {
        this.logger.info("[Battle] Re-engaging Semi Auto");
        await this.handleSemiAuto();
        return { faReengaged: true };
      }
    }

    const finalUrl = this.controller.page.url();
    // Check both hash-based and path-based result/quest index URLs
    const isFinalResultUrl =
      finalUrl.includes("#result") ||
      finalUrl.includes("/result/content/index/") ||
      finalUrl.includes("/result_multi/content/index/") ||
      finalUrl.includes("#quest/index");
    if (isFinalResultUrl) {
      await sleep(50); // SPA navigation buffer
      return true;
    }

    return false;
  }

  async getHonors() {
    const state = await this.getBattleState();
    return state.honors || 0;
  }

  async getTurnNumber() {
    const state = await this.getBattleState();
    return state.turn || 0;
  }

    /**
     * Detects popups that indicate an early end to the battle or join failure.
     * @param {boolean} [questMode=false] - If true, skips stale result page checks.
     * @returns {Promise<object|null>} Error details if found, otherwise null.
     */
    async checkEarlyBattleEndPopup(questMode = false) {
    const popupData = await this.controller.page
      .evaluate((skipResultElement) => {
        // Skip result page check in quest mode - elements may be stale from previous battle
        if (!skipResultElement) {
          const href = window.location.href;
          const isResultUrl =
            href.includes("#result") ||
            href.includes("/result/content/index/") ||
            href.includes("/result_multi/content/index/");
          const resultElement = document.querySelector(
            ".prt-result, .cnt-result",
          );
          if (isResultUrl || (resultElement && resultElement.offsetWidth > 0)) {
            return { state: "ended", text: "Result page detected" };
          }
        }

        const assistRaidPopup = document.querySelector(
          ".pop-result-assist-raid.pop-show",
        );
        if (assistRaidPopup && assistRaidPopup.offsetWidth > 0) {
          const body = assistRaidPopup.querySelector(
            "#popup-body, .txt-popup-body, .prt-popup-body",
          );
          const rawText = body ? body.textContent.trim() : "";
          const text = rawText.toLowerCase();
          if (
            text.includes("already ended") ||
            text.includes("home screen will now appear") ||
            text.includes("heavy") ||
            text.includes("currently")
          ) {
            return { state: "ended", text: rawText };
          }
        }

        const okBtn = document.querySelector(".btn-usual-ok");
        if (!okBtn || okBtn.offsetWidth === 0) return null;

        const body =
          document.querySelector(".txt-popup-body") ||
          document.querySelector(".prt-popup-body");
        if (!body) return null;

        const rawText = body.textContent.trim();
        const text = rawText.toLowerCase();

        if (text.includes("raid battle is full"))
          return { state: "full", text: rawText };
        if (
          text.includes("already ended") ||
          text.includes("home screen will now appear") ||
          text.includes("already been defeated") ||
          text.includes("heavy") ||
          text.includes("currently")
        )
          return { state: "ended", text: rawText };
        if (text.includes("pending battles")) {
          return { state: "pending", text: rawText };
        }
        if (text.includes("three raid battles")) {
          return { state: "concurrent_limit", text: rawText };
        }

        return null;
      }, questMode)
      .catch(() => null);

    if (popupData) {
      this.logger.info(
        `[Raid] Join error detected: ${popupData.text || popupData.state}`,
      );
      return {
        duration: 0,
        turns: 0,
        raidFull: popupData.state === "full",
        raidEnded: popupData.state === "ended",
        raidPending: popupData.state === "pending",
        raidConcurrentLimit: popupData.state === "concurrent_limit",
        errorText: popupData.text,
      };
    }
    return null;
  }

  async dismissSalutePopup() {
    return await this.controller.page
      .evaluate(() => {
        const popup = document.querySelector(
          ".pop-salute.pop-show, .pop-cheer.pop-show",
        );
        if (popup && popup.offsetWidth > 0) {
          const btn = popup.querySelector(".btn-usual-ok, .btn-usual-cancel");
          if (btn) {
            btn.click();
            return true;
          }
        }
        return false;
      })
      .catch(() => false);
  }

    /**
     * Captures a comprehensive snapshot of battle state in a single DOM round-trip.
     * Highly optimized for combat loop performance.
     * @returns {Promise<object>} State snapshot including turn, honors, and UI flags.
     */
    async getBattleStateSnapshot() {
    return await this.controller.page
      .evaluate((selectors) => {
        const res = {
          turn: 0,
          honors: 0,
          isBossDead: false,
          isPartyWiped: false,
          isResultPage: false,
          isAttackOn: false,
          isAutoOn: false,
          isPopShow: false,
          url: window.location.href,
          hash: window.location.hash,
        };

        // 1. Turn Number
        const turnElem = document.querySelector(selectors.turnCounter);
        if (turnElem) {
          res.turn = parseInt(turnElem.textContent, 10) || 0;
        } else {
          // Fallback turn detection (older/alternative UI)
          const turnCounter = document.querySelector(
            ".prt-turn-info, #js-turn-num, #js-turn-num-count",
          );
          if (turnCounter) {
            const digits = turnCounter.querySelectorAll('div[class*="num-info"]');
            if (digits && digits.length > 0) {
              let str = "";
              for (const d of digits) {
                const match = d.className.match(/num-info(\d)/);
                if (match) str += match[1];
              }
              res.turn = parseInt(str, 10) || 0;
            }
          }
        }

        // 2. Honors (Robust Detection)
        // Priority 1: User row in contribution list (most reliable across all raid types)
        const userRow = document.querySelector(".lis-user.guild-member");
        if (userRow) {
          const pointEl = userRow.querySelector(".txt-point");
          if (pointEl) {
            res.honors =
              parseInt(pointEl.textContent.replace(/[,/pt]/g, ""), 10) || 0;
          }
        }

        // Priority 2: Total honor counter (fallback for GW/Events where user row might be hidden or delayed)
        if (!res.honors) {
          const honorElem = document.querySelector(".prt-total-honor");
          if (honorElem) {
            res.honors =
              parseInt(honorElem.textContent.replace(/[,/]/g, ""), 10) || 0;
          }
        }

        // 3. Terminal States
        const result = document.querySelector(
          ".prt-result, #js-result, .cnt-result, .prt-result-head",
        );
        if (result && result.offsetWidth > 0) res.isResultPage = true;

        // 4. UI Controls
        const att = document.querySelector(selectors.attackButton);
        if (att && att.classList.contains("display-on")) res.isAttackOn = true;

        const auto = document.querySelector(".btn-auto, .btn-full-auto");
        if (auto && auto.classList.contains("pushed")) res.isAutoOn = true;

        // 5. Popups
        const pop = document.querySelector(".pop-show, .pop-usual");
        if (pop && pop.offsetWidth > 0) res.isPopShow = true;

        // 6. Boss Death / Wipe DOM Falbacks
        const bossDeath = document.querySelector(".prt-battle-boss.die");
        if (bossDeath) res.isBossDead = true;

        return res;
      }, this.selectors)
      .catch(() => ({
        turn: 0,
        honors: 0,
        isBossDead: false,
        isPartyWiped: false,
        isResultPage: false,
        isAttackOn: false,
        isAutoOn: false,
        isPopShow: false,
        url: "",
        hash: "",
      }));
  }

  async getBattleState() {
    const snapshot = await this.getBattleStateSnapshot();
    return {
      turn: snapshot.turn || 0,
      honors: snapshot.honors || 0,
    };
  }
}

export default BattleHandler;
