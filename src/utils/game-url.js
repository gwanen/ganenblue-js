/**
 * Centralized predicates for Granblue's SPA URL/hash states.
 *
 * These replace the URL substring/regex checks that were hand-inlined across
 * the bot modules, where they had drifted (e.g. some result checks omitted the
 * `result_multi` variant, some raid checks omitted `_raid`). Each predicate
 * below is the intended superset.
 *
 * NOTE: these run in the Node context only. Checks inside `page.evaluate()`
 * callbacks execute in the browser and cannot import this module, so they are
 * left inline by design. This is also distinct from NetworkListener._isRaidUrl,
 * which matches REST API endpoints (`/rest/multiraid/`), not SPA hashes.
 */

/**
 * True when the URL is a battle-result page (solo or multi).
 * @param {string} url
 * @returns {boolean}
 */
export function isResultUrl(url) {
  if (!url) return false;
  return (
    url.includes("#result") ||
    url.includes("/result/content/index/") ||
    url.includes("/result_multi/content/index/")
  );
}

/**
 * True when the URL is a raid battle page (solo raid `#raid/…` or multi
 * `#raid_multi/…`). Both battle hashes contain the `#raid` substring.
 *
 * Deliberately does NOT match on a bare `_raid` substring: that also matches
 * `supporter_raid` (the raid party-select screen), which is not a battle page
 * and previously produced false positives in the hand-inlined checks.
 * @param {string} url
 * @returns {boolean}
 */
export function isRaidUrl(url) {
  if (!url) return false;
  return url.includes("#raid");
}

/**
 * True when the URL is the post-battle quest-index page.
 * @param {string} url
 * @returns {boolean}
 */
export function isQuestIndexUrl(url) {
  if (!url) return false;
  return (
    url.includes("#quest/index") ||
    url.includes("/quest/index/content/index/")
  );
}

/**
 * True when the battle is over — either a result page or the quest-index
 * page GBF's SPA sometimes lands on instead.
 * @param {string} url
 * @returns {boolean}
 */
export function isBattleEndUrl(url) {
  return isResultUrl(url) || isQuestIndexUrl(url);
}
