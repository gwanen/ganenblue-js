import PageController from "../core/page-controller.js";
import { sleep } from "../utils/random.js";
import { createScopedLogger } from "../utils/logger.js";
import config from "../utils/config.js";
import notifier from "../utils/notifier.js";
import {
  applyPerformanceOptions,
  computeRate,
  checkBattleCaptcha,
  parseRewardChests,
} from "./bot-common.js";

const START_BUTTON = ".btn-usual-ok.se-quest-start";
const FALLBACK_BUTTON = ".btn-usual-ok";
// Error-only popups (not enough AP, quest unavailable, CAPTCHA). Kept narrow so
// the ordinary quest-start confirmation is never mistaken for a failure.
const ERROR_POPUP = ".common-pop-error.pop-show, .pop-usual.pop-error.pop-show";
// The skip response normally lands well inside a second; hold off on popup
// polling so a leftover popup from the previous cycle cannot win the race.
const POPUP_POLL_DELAY = 1000;

/**
 * Filters the configured daily quest list down to the ones that should run.
 *
 * @param {Array<object>} all - Quest entries from `daily.quests`.
 * @param {string[]|null} [selected] - Optional quest ids chosen by the caller.
 *   When provided (and non-empty) it wins over each entry's `enabled` flag.
 * @returns {Array<object>} Runnable quests, in config order.
 */
export function resolveDailyQuests(all, selected = null) {
  const quests = (Array.isArray(all) ? all : []).filter((q) => q && q.url);
  if (Array.isArray(selected) && selected.length > 0) {
    const wanted = new Set(selected);
    return quests.filter((q) => wanted.has(q.id));
  }
  return quests.filter((q) => q.enabled !== false);
}

/**
 * Farms the daily "quest skip" targets (Omega Pro, Angel Halo Pro, ...).
 *
 * These quests never enter battle: opening the supporter screen and clicking the
 * OK button POSTs to `/rest/quest/questskip/skip`. A 200 response carries a
 * `raid_id` and the rewards arrive on `/result/content/skip_raid/<raid_id>`;
 * a 500 means the quest has no skips left today, so the bot moves to the next.
 */
class DailyBot {
  /**
   * @param {import('puppeteer').Page} page - The current browser page.
   * @param {object} [options={}] - Bot configuration parameters.
   */
  constructor(page, options = {}) {
    this.profileId = options.profileId || config.get("profile_id") || "p1";
    this.logger = createScopedLogger(this.profileId);
    this.controller = new PageController(page, this.logger);
    this.onBattleEnd = options.onBattleEnd || null;

    this.quests = resolveDailyQuests(
      config.get("daily.quests", []),
      options.quests || null,
    );
    this.repeatUntilFail =
      options.repeatUntilFail !== undefined
        ? options.repeatUntilFail
        : config.get("daily.repeat_until_fail", true);
    this.maxAttemptsPerQuest =
      options.maxAttemptsPerQuest || config.get("daily.max_attempts_per_quest", 20);
    this.loopList =
      options.loopList !== undefined
        ? options.loopList
        : config.get("daily.loop_list", false);
    this.skipTimeout = config.get("daily.skip_timeout", 10000);
    this.rewardTimeout = config.get("daily.reward_timeout", 5000);

    // Session state
    this.skipsCompleted = 0;
    this.failedQuests = 0;
    this.isRunning = false;
    this.isPaused = false;
    this.startTime = null;
    this.currentQuest = null;
    this.lastSkipTime = 0;
    this.results = new Map(); // quest id -> { name, completed, failed, reason }

    // Loot counters (shared parser mutates these)
    this.redChests = 0;
    this.blueChests = 0;
    this.goldBricks = 0;
    this._lastProcessedRewardsHash = null;

    applyPerformanceOptions({
      controller: this.controller,
      logger: this.logger,
      options,
    });

    this.onSkipResult = (info) => {
      this.logger.debug(
        `[Daily] Skip signal: ok=${info.ok} status=${info.status} raid=${info.raidId ?? "-"}`,
      );
    };
    this.onResultRewards = ({ rewards }) => parseRewardChests(this, rewards);
  }

  /**
   * Runs every enabled daily quest until it is exhausted (or the cap is hit).
   */
  async start() {
    this.isRunning = true;
    this.skipsCompleted = 0;
    this.failedQuests = 0;
    this.startTime = Date.now();
    this.results = new Map();

    if (this.controller.network) {
      this.controller.network.on("quest:skip_result", this.onSkipResult);
      this.controller.network.on("battle:result", this.onResultRewards);
    }

    if (this.quests.length === 0) {
      this.logger.warn("[Daily] No quests enabled — nothing to run");
      this.stop();
      return;
    }

    this.logger.info(
      `[Bot] Daily session started (${this.quests.length} quests, repeat_until_fail: ${this.repeatUntilFail})`,
    );

    try {
      do {
        for (const quest of this.quests) {
          if (!this.isRunning) break;
          await this.runQuest(quest);
        }

        if (this.loopList && this.isRunning) {
          this.logger.info("[Daily] List complete — looping from the top");
        }
      } while (this.loopList && this.isRunning);
    } catch (error) {
      if (
        this.controller.isNetworkError(error) ||
        error.message.includes("Target closed") ||
        error.message.includes("Session closed")
      ) {
        this.logger.info("[System] Session terminated (browser closed)");
      } else {
        this.logger.error("[Bot] Daily bot error:", error);
        notifier
          .notifyError(this.profileId || "p1", error.message)
          .catch((e) =>
            this.logger.debug("[Notifier] Failed to send error notification", e),
          );
        throw error;
      }
    } finally {
      this.logSummary();
      this.stop();
    }
  }

  /**
   * Skips a single quest repeatedly until it fails or the cap is reached.
   * @param {object} quest - Entry from `daily.quests`.
   */
  async runQuest(quest) {
    this.currentQuest = quest.name || quest.id;
    const record = this.results.get(quest.id) || {
      name: quest.name || quest.id,
      completed: 0,
      failed: 0,
      reason: null,
    };
    this.results.set(quest.id, record);

    this.logger.info(`[Daily] ${record.name} — starting`);

    let attempts = 0;
    let retriedTimeout = false;

    while (this.isRunning && attempts < this.maxAttemptsPerQuest) {
      if (this.isPaused) {
        await sleep(1000);
        continue;
      }

      attempts++;

      let outcome;
      try {
        outcome = await this.runSingleSkip(quest, attempts);
      } catch (cycleError) {
        if (this.controller.isNetworkError(cycleError)) {
          this.logger.warn(
            `[Daily] Transient error on ${record.name}. Moving on: ${cycleError.message}`,
          );
          record.reason = "network error";
          record.failed++;
          break;
        }
        throw cycleError;
      }

      if (outcome.status === "ok") {
        this.skipsCompleted++;
        record.completed++;
        this.lastSkipTime = Date.now();
        this.logger.info(
          `[Daily] ${record.name} — skip #${record.completed} OK (raid ${outcome.raidId})`,
        );
        if (this.onBattleEnd) this.onBattleEnd(this.getStats());

        if (!this.repeatUntilFail) break;
        await sleep(100);
        continue;
      }

      record.failed++;

      if (outcome.status === "failed") {
        record.reason = `HTTP ${outcome.httpStatus}`;
        this.logger.info(
          `[Daily] ${record.name} — exhausted (HTTP ${outcome.httpStatus})`,
        );
      } else if (outcome.status === "blocked") {
        record.reason = outcome.message || "popup";
        this.logger.warn(`[Daily] ${record.name} — blocked: ${record.reason}`);
      } else if (outcome.status === "captcha") {
        record.reason = "captcha";
        this.logger.warn(`[Daily] ${record.name} — paused on CAPTCHA`);
      } else if (outcome.status === "unavailable") {
        record.reason = "start button not found";
        this.logger.warn(`[Daily] ${record.name} — start button not found`);
      } else if (outcome.status === "timeout" && !retriedTimeout) {
        // One retry: a slow supporter screen can swallow the first attempt.
        retriedTimeout = true;
        record.failed--;
        attempts--;
        this.logger.warn(`[Daily] ${record.name} — no skip response, retrying once`);
        await sleep(500);
        continue;
      } else {
        record.reason = "no skip response";
        this.logger.warn(`[Daily] ${record.name} — no skip response`);
      }

      break;
    }

    if (record.completed === 0) this.failedQuests++;
    this.logger.info(
      `[Daily] ${record.name}: ${record.completed} done, ${record.failed} failed${record.reason ? ` (${record.reason})` : ""}`,
    );
    this.currentQuest = null;
  }

  /**
   * Navigates to the quest supporter screen and clicks OK to consume one skip.
   * @param {object} quest - Entry from `daily.quests`.
   * @param {number} attempt - 1-based attempt counter (for logging).
   * @returns {Promise<{status: string, raidId?: number, httpStatus?: number, message?: string}>}
   */
  async runSingleSkip(quest, attempt) {
    const name = quest.name || quest.id;
    this.logger.debug(`[Daily] ${name} — attempt ${attempt}: navigating`);

    await this.controller.gotoSPA(quest.url);
    this.controller.clearClickCache();

    let selector = START_BUTTON;
    if (!(await this.controller.elementExists(START_BUTTON, 8000, true))) {
      if (await this.controller.elementExists(FALLBACK_BUTTON, 1000, true)) {
        selector = FALLBACK_BUTTON;
        this.logger.debug(`[Daily] ${name} — using generic OK button`);
      } else {
        if (await this.checkCaptcha()) return { status: "captcha" };
        return { status: "unavailable" };
      }
    }

    // Each skip is a separate raid, and two skips of the same quest routinely
    // return byte-identical reward payloads. Clear the dedup hash per attempt so
    // the second skip's loot is not mistaken for a repeat of the first.
    this._lastProcessedRewardsHash = null;

    // Arm the network waiters before clicking so a fast response is not missed.
    const skipSignal = this.waitForEvent("quest:skip_result", this.skipTimeout);
    const popupSignal = this.waitForErrorPopup(this.skipTimeout);

    await this.controller
      .clickSafe(selector, { timeout: 2000, maxRetries: 1, fast: true, silent: true })
      .catch((e) =>
        this.logger.debug(`[Daily] ${name} — start click failed: ${e.message}`),
      );

    const outcome = await Promise.race([
      skipSignal.then((r) => (r ? { type: "skip", result: r } : null)),
      popupSignal.then((m) => (m ? { type: "popup", message: m } : null)),
    ]);

    if (outcome?.type === "skip") {
      const { ok, raidId, status } = outcome.result;
      if (!ok) return { status: "failed", httpStatus: status };

      // Rewards land on /result/content/skip_raid/<raid_id>; the session
      // listener counts them, we only wait so the page settles before the
      // next navigation.
      await this.waitForEvent("battle:result", this.rewardTimeout);
      return { status: "ok", raidId };
    }

    if (outcome?.type === "popup") {
      if (await this.checkCaptcha()) return { status: "captcha" };
      return { status: "blocked", message: outcome.message };
    }

    if (await this.checkCaptcha()) return { status: "captcha" };
    return { status: "timeout" };
  }

  /**
   * Resolves with the first payload of a network event, or null on timeout.
   * @param {string} eventName - NetworkListener event name.
   * @param {number} timeout - Ms to wait.
   * @returns {Promise<object|null>}
   */
  waitForEvent(eventName, timeout) {
    const network = this.controller.network;
    if (!network) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        network.off(eventName, onEvent);
        resolve(value);
      };
      const onEvent = (data) => finish(data || {});
      const timer = setTimeout(() => finish(null), timeout);
      network.on(eventName, onEvent);
    });
  }

  /**
   * Polls for an error popup (not enough AP, quest unavailable, CAPTCHA).
   * @param {number} timeout - Ms to poll before giving up.
   * @returns {Promise<string|null>} The popup text, or null if none appeared.
   */
  async waitForErrorPopup(timeout) {
    const deadline = Date.now() + timeout;
    await sleep(POPUP_POLL_DELAY);
    while (Date.now() < deadline && this.isRunning) {
      const text = await this.controller.page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el || el.offsetHeight === 0) return null;
          return (el.innerText || "").trim().slice(0, 120);
        }, ERROR_POPUP)
        .catch(() => null);

      if (text) return text || "error popup";
      await sleep(250);
    }
    return null;
  }

  async checkCaptcha() {
    return checkBattleCaptcha(this);
  }

  /**
   * Prints the per-quest result table for the session.
   */
  logSummary() {
    if (this.results.size === 0) return;

    this.logger.info("[Daily] ===== Session Summary =====");
    for (const record of this.results.values()) {
      this.logger.info(
        `[Daily] ${record.name.padEnd(24)} | done ${record.completed} | failed ${record.failed}${record.reason ? ` | ${record.reason}` : ""}`,
      );
    }
    this.logger.info(
      `[Daily] Totals: ${this.skipsCompleted} skips | Red ${this.redChests} | Blue ${this.blueChests} | Gold Bricks ${this.goldBricks}`,
    );
  }

  pause() {
    this.isPaused = true;
    this.logger.info("[Daily] Bot paused");
  }

  resume() {
    this.isPaused = false;
    this.logger.info("[Daily] Bot resumed");
  }

  stop() {
    this.isRunning = false;
    if (this.controller && this.controller.network) {
      this.controller.network.removeListener("quest:skip_result", this.onSkipResult);
      this.controller.network.removeListener("battle:result", this.onResultRewards);
    }
    this.controller.stop().catch(() => { });
    this.logger.info("[System] Shutdown initiated");
  }

  /**
   * Compiles session statistics for reporting.
   * @returns {object} Summary of skips, loot, and per-quest breakdown.
   */
  getStats() {
    return {
      completedQuests: this.skipsCompleted,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      startTime: this.startTime,
      avgBattleTime: 0,
      avgTurns: 0,
      battleCount: this.skipsCompleted,
      lastBattleTime: 0,
      rate: computeRate(this.startTime, this.skipsCompleted),
      redChests: this.redChests,
      blueChests: this.blueChests,
      goldBricks: this.goldBricks,
      currentQuest: this.currentQuest,
      perQuest: Array.from(this.results.entries()).map(([id, r]) => ({ id, ...r })),
    };
  }
}

export default DailyBot;
