/**
 * Shared helpers for the bot modules (QuestBot, RaidBot, SkipBot, AutoQuestBot).
 *
 * Extracted to remove logic that had been copy-pasted across all four bots.
 * Composition (plain functions taking the bot's collaborators) is used instead
 * of a base class so the existing construction flow and class shapes are left
 * untouched.
 */

import config from "../utils/config.js";
import notifier from "../utils/notifier.js";

/**
 * Applies the constructor-time performance optimizations (resource blocking and
 * turbo CSS) that every bot shares. Both toggles honor an explicit option and
 * fall back to the stealth config — previously SkipBot and AutoQuestBot ignored
 * the `stealth.turbo_css` config fallback, which this unifies.
 *
 * The underlying enable calls are intentionally fire-and-forget (they race the
 * first navigation) to preserve the original behavior.
 *
 * @param {object} params
 * @param {import('../core/page-controller.js').default} params.controller
 * @param {import('winston').Logger} params.logger
 * @param {object} params.options - The bot's constructor options.
 */
export function applyPerformanceOptions({ controller, logger, options = {} }) {
  const blockResources =
    options.blockResources !== undefined
      ? options.blockResources
      : config.get("stealth.block_resources", false);

  if (blockResources) {
    logger.info("[System] Image blocking enabled");
    controller
      .enableResourceBlocking()
      .catch((e) => logger.warn("[System] Failed to enable image blocking", e));
  }

  const turboMode =
    options.turboMode !== undefined
      ? options.turboMode
      : config.get("stealth.turbo_css", true);

  if (turboMode) {
    controller
      .enableTurboCSS()
      .catch((e) => logger.warn("[System] Failed to enable turbo CSS", e));
  }
}

/**
 * Formats a completions-per-hour rate string, guarded against a missing/zero
 * startTime (a stats poll before start() must not divide by NaN/0).
 *
 * @param {number|null} startTime - epoch ms when the session started
 * @param {number} count - number of completions so far
 * @returns {string} e.g. "12.3/h"
 */
export function computeRate(startTime, count) {
  if (!startTime) return "0.0/h";
  const uptimeHours = (Date.now() - startTime) / (1000 * 60 * 60);
  if (uptimeHours <= 0) return "0.0/h";
  return `${(count / uptimeHours).toFixed(1)}/h`;
}

/**
 * Mean of the recorded battle durations, rounded to ms. Returns 0 when empty.
 * @param {number[]} battleTimes
 * @returns {number}
 */
export function averageBattleTime(battleTimes = []) {
  if (battleTimes.length === 0) return 0;
  const sum = battleTimes.reduce((a, b) => a + b, 0);
  return Math.round(sum / battleTimes.length);
}

/**
 * Checks for the battle "Access Verification" CAPTCHA popup. On detection it
 * notifies and pauses the bot. Identical logic previously lived in both
 * QuestBot and RaidBot.
 *
 * @param {object} bot - the bot instance (needs controller, logger, profileId, pause())
 * @returns {Promise<boolean>} true if a CAPTCHA was detected and the bot paused
 */
export async function checkBattleCaptcha(bot) {
  const selectors = config.selectors.battle;
  if (await bot.controller.elementExists(selectors.captchaPopup, 1000, true)) {
    const headerText = await bot.controller.getText(selectors.captchaHeader);
    if (headerText.includes("Access Verification")) {
      bot.logger.error("[Safety] CAPTCHA detected. Human intervention required");
      notifier
        .notifyCaptcha(bot.profileId || "p1")
        .catch((e) => bot.logger.debug("[Notifier] Failed to notify captcha", e));
      bot.pause();
      return true;
    }
  }
  return false;
}
