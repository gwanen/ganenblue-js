import {
  sleep,
  randomDelay,
  getNormalRandom,
  generateBezierCurve,
} from "../utils/random.js";
import logger from "../utils/logger.js";
import config from "../utils/config.js";
import NetworkListener from "./network-listener.js";

/**
 * Orchestrates page interactions, navigation, and resource management.
 * Provides stealth-oriented clicking, SPA navigation, and performance optimizations.
 */
class PageController {
  /**
   * @param {import('puppeteer').Page} page - The Puppeteer page instance.
   * @param {import('winston').Logger} [scopedLogger] - Optional scoped logger instance.
   */
  constructor(page, scopedLogger = null) {
    this.page = page;
    this.logger = scopedLogger || logger;
    this.network = new NetworkListener(page, this.logger);
    this.network.start();
    this.requestHandler = null;
    this.lastMousePos = { x: 0, y: 0 };

    // Disable background throttling via CDP immediately to prevent performance drops when tab is inactive
    this.disableBackgroundThrottling().catch(() => { });
  }

  // --- Resource Management ---

  /**
   * Enables interception to block trackers, images, and media.
   * Significantly reduces bandwidth and boosts performance during heavy raiding.
   */
  async enableResourceBlocking() {
    if (this.blockingEnabled) return;
    this.blockingEnabled = true;

    await this.page.setRequestInterception(true);

    this.requestHandler = (req) => {
      const url = req.url().toLowerCase();
      const resourceType = req.resourceType();

      const isTracker =
        url.includes("google-analytics.com") ||
        url.includes("googleanalytics.com") ||
        url.includes("g-acp.com") ||
        url.includes("doubleclick.net") ||
        url.includes("googlesyndication.com") ||
        url.includes("pagead") ||
        url.includes("analytics") ||
        url.includes("adservice") ||
        url.includes("ads.") ||
        url.includes("/ads/");

      if (isTracker || ["image", "media", "font"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    };

    this.page.on("request", this.requestHandler);
    this.logger.info("[Core] State: Resource blocking active (Images/Media)");
  }

  /**
   * Disables interception and restores normal resource loading.
   */
  async disableResourceBlocking() {
    if (!this.requestHandler && !this.blockingEnabled) return;

    if (this.requestHandler) {
      this.page.off("request", this.requestHandler);
      this.requestHandler = null;
    }

    try {
      if (!this.page.isClosed()) {
        await this.page.setRequestInterception(false);
        this.logger.info("[Core] State: Resource blocking inactive");
      }
    } catch (e) {
      // Ignore if context is lost or already disabled
    }

    this.blockingEnabled = false;
  }

  /**
   * Overrides browser throttling via CDP to ensure stable performance in the background.
   */
  async disableBackgroundThrottling() {
    let client = null;
    try {
      client = await this.page.target().createCDPSession();

      // Disable focusless throttling
      await client.send("Emulation.setFocuslessThrottlingEnabled", {
        enabled: false,
      });

      // Force the page to stay in the 'active' lifecycle state
      await client.send("Page.setWebLifecycleState", { state: "active" });

      this.logger.debug("[Core] State: Background throttling disabled");
    } catch (error) {
      this.logger.debug("[Core] State: CDP throttling override failure");
    } finally {
      if (client) {
        await client.detach().catch(() => { });
      }
    }
  }

  /**
   * Returns a cached CDP session, creating one if needed.
   */
  async getCDPClient() {
    if (!this._cdpClient) {
      this._cdpClient = await this.page.target().createCDPSession();
    }
    return this._cdpClient;
  }

  /**
   * Clears the browser's HTTP response cache via CDP.
   * Safe to call at any time — does not affect cookies or session data.
   */
  async clearBrowserCache() {
    try {
      const client = await this.getCDPClient();
      await client.send('Network.clearBrowserCache');
      this.logger.info('[Memory] Browser HTTP cache cleared');
    } catch (e) {
      this._cdpClient = null;
      this.logger.debug(`[Memory] Browser cache clear failed: ${e.message}`);
    }
  }

  /**
   * Manually triggers Garbage Collection if available (requires --expose-gc).
   */
  triggerGC() {
    if (global.gc) {
      try {
        global.gc();
        this.logger.debug("[Memory] Manual GC triggered");
      } catch (e) {
        this.logger.debug("[Memory] Manual GC failed");
      }
    }
  }

  /**
   * Injects CSS to suppress animations and transitions for maximum speed.
   * Known as "Turbo Mode" — reduces CPU usage significantly.
   */
  async enableTurboCSS() {
    try {
      if (this.turboEnabled) return;

      // Guard against accumulating duplicate style tags across stop/start cycles on the same page
      const alreadyInjected = await this.page.evaluate(
        () => !!document.querySelector('style[data-ganenblue-turbo]')
      ).catch(() => false);

      this.turboEnabled = true;
      if (alreadyInjected) {
        this.logger.debug("[Core] Turbo CSS already injected in page — skipping duplicate");
        return;
      }

      await this.page.evaluate(() => {
        const style = document.createElement('style');
        style.setAttribute('data-ganenblue-turbo', '');
        style.textContent = `
          *, *::before, *::after {
            animation-duration: 0.001ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.001ms !important;
            animation-delay: 0ms !important;
            transition-delay: 0ms !important;
          }
          * { will-change: auto !important; }
          .prt-loading-container, #loading-mask { background: #000 !important; }
          [class*="effect-"], [class*="particle-"] { display: none !important; }
          .prt-battle-field, .prt-bg, [class*="background-"] {
            pointer-events: none !important;
            will-change: auto !important;
          }
          .prt-character, [class*="chara-"] {
            animation-play-state: paused !important;
            pointer-events: none !important;
          }
          canvas { visibility: hidden !important; pointer-events: none !important; }
          [class*="btn-ability"]::before, [class*="btn-ability"]::after { display: none !important; }
          [class*="txt-message-"] { animation-play-state: paused !important; }
          [class*="prt-navi-"] { pointer-events: none !important; }
          [class*="result-animation"], [class*="result-bg"], [class*="result-image"] { display: none !important; }
        `;
        document.head.appendChild(style);
      });
      this.logger.info("[Core] State: Turbo CSS active (Animations suppressed)");
    } catch (e) {
      this.logger.warn("[Core] Failed to inject Turbo CSS", e);
    }
  }

  // --- Interaction (Clicking & Mouse) ---

  /**
   * Performs a click using cached coordinates to minimize DOM lookups in time-sensitive loops.
   * @param {string} selector - The CSS selector for the element.
   * @param {number} [stabilityDelay=15] - Ms delay to wait for DOM readiness before clicking.
   */
  async cachedClick(selector, stabilityDelay = 15) {
    if (!this._clickCache) this._clickCache = new Map();

    let box = this._clickCache.get(selector);
    if (!box) {
      try {
        const el = await this.page.$(selector);
        if (el) {
          box = await el.boundingBox();
          await el.dispose();
          if (box) this._clickCache.set(selector, box);
        }
      } catch (e) {
        this.logger.debug(`[Debug] Core: cachedClick element lookup failed (${e.message})`);
      }
    }

    if (!box) {
      throw new Error(`Element not found for cached click: ${selector}`);
    }

    if (stabilityDelay > 0) {
      await sleep(stabilityDelay);
    }

    // Offset coordinates with jitter (±2px)
    const x = box.x + box.width / 2 + (Math.random() * 4 - 2);
    const y = box.y + box.height / 2 + (Math.random() * 4 - 2);

    // Fast mouse movement for efficiency
    await this.moveMouseHumanLike(x, y, true);

    await this.page.mouse.click(x, y);
    this.logger.debug(`[Debug] Cached Click: ${selector} (${stabilityDelay}ms delay)`);
  }

  /**
   * Clears the coordinate cache. Should be called when the page structure changes.
   */
  clearClickCache() {
    if (this._clickCache) this._clickCache.clear();
  }

  /**
   * Clicks an element with randomized offset, Gaussian distribution, and human-like delays.
   * @param {string} selector - CSS selector of the element.
   * @param {object} [options] - Configuration for the click.
   * @param {boolean} [options.waitAfter=true] - Whether to sleep after the click.
   * @param {number} [options.delay] - Sleep duration after the click.
   * @param {number} [options.preDelay] - Sleep duration before the click.
   * @param {number} [options.maxRetries=3] - Retry attempts on failure.
   * @param {number} [options.timeout=5000] - Ms to wait for element visibility.
   * @param {boolean} [options.silent=false] - If true, suppresses warning logs on failure.
   * @param {boolean} [options.fast=false] - If true, skips human-like delays and reduces mouse resolution.
   */
  async clickSafe(selector, options = {}) {
    const {
      waitAfter = true,
      delay = randomDelay(100, 300),
      preDelay = randomDelay(200, 500),
      maxRetries = 3,
      timeout = 5000,
      silent = false,
      fast = false,
    } = options;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const found = await this.waitForElement(selector, timeout);
        if (!found) throw new Error(`Element not found: ${selector}`);

        if (!fast && preDelay > 0) {
          await sleep(preDelay);
        }

        const element = await this.page.$(selector);
        if (!element) throw new Error(`Element handle not found: ${selector}`);

        const box = await element.boundingBox();
        await element.dispose();

        if (!box) throw new Error(`Bounding box not found for: ${selector}`);

        // Distribution logic to keep clicks concentrated near center (Gaussian)
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;

        const sigmaX = box.width / 6;
        const sigmaY = box.height / 6;

        let randomX = getNormalRandom(centerX, sigmaX);
        let randomY = getNormalRandom(centerY, sigmaY);

        // Clamp with 5% safety margin
        const marginX = box.width * 0.05;
        const marginY = box.height * 0.05;
        randomX = Math.max(box.x + marginX, Math.min(box.x + box.width - marginX, randomX));
        randomY = Math.max(box.y + marginY, Math.min(box.y + box.height - marginY, randomY));

        await this.moveMouseHumanLike(randomX, randomY, fast);
        await this.page.mouse.click(randomX, randomY);

        this.logger.debug(`[Debug] Stealth Click: ${selector} at (${Math.round(randomX)}, ${Math.round(randomY)})`);

        if (waitAfter) await sleep(delay);
        return true;
      } catch (error) {
        if (!silent) {
          this.logger.warn(`[Core] Click attempt ${attempt}/${maxRetries} failed: ${selector}`);
        }
        if (attempt === maxRetries) throw error;
        await sleep(1000);
      }
    }
  }

  /**
   * Moves the mouse cursor along a natural Bezier curve to the target.
   * @param {number} targetX - Target X coordinate.
   * @param {number} targetY - Target Y coordinate.
   * @param {boolean} [fast=false] - If true, reduces coordinate resolution for speed.
   */
  async moveMouseHumanLike(targetX, targetY, fast = false) {
    try {
      const start = this.lastMousePos;
      const end = { x: targetX, y: targetY };

      const distance = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
      if (distance < 5) {
        await this.page.mouse.move(end.x, end.y);
        this.lastMousePos = end;
        return;
      }

      const points = generateBezierCurve(start, end);
      const activePoints = fast ? [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]].filter(p => !!p) : points;

      for (const point of activePoints) {
        await this.page.mouse.move(point.x, point.y).catch(() => { });
      }

      this.lastMousePos = end;
    } catch (e) {
      this.logger.debug(`[Debug] Human mouse move failed (swallowing): ${e.message}`);
    }
  }

  // --- Utility & Error Handling ---

  /**
   * Determines if a thrown error is related to network instability or context loss.
   * @param {Error} error - The error to analyze.
   * @returns {boolean} True if the error is considered network-related.
   */
  isNetworkError(error) {
    const message = error.message || "";
    return (
      message.includes("Navigation timeout") ||
      message.includes("net::ERR") ||
      message.includes("Protocol error") ||
      message.includes("Session closed") ||
      message.includes("Target closed") ||
      message.includes("Execution context was destroyed") ||
      message.includes("Execution context is not available in detached frame") ||
      message.includes("Cannot read properties of null") ||
      message.includes("detached Frame") ||
      message.includes("Frame was detached")
    );
  }

  /**
   * Checks if the controlled page is still active and connected.
   */
  isAlive() {
    try {
      return this.page && !this.page.isClosed();
    } catch (e) {
      return false;
    }
  }

  /**
   * Wraps an asynchronous operation with retry logic for network-related failures.
   * @param {Function} fn - The async function to execute.
   * @param {number} [maxRetries=3] - Number of retry attempts.
   * @param {string} [operation="operation"] - Label for logging purposes.
   */
  async retryOnNetworkError(fn, maxRetries = 3, operation = "operation") {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (this.isNetworkError(error)) {
          const isDetached =
            error.message.includes("detached Frame") ||
            error.message.includes("context was destroyed") ||
            error.message.includes("Session closed") ||
            error.message.includes("Target closed");

          if (isDetached) this.handleDetachedFrame(error);

          if (i < maxRetries - 1) {
            const waitTime = 2000 * (i + 1);
            this.logger.warn(`[Core] Error during ${operation}, retrying (${i + 1}/${maxRetries}) in ${waitTime / 1000}s...`);
            await sleep(waitTime);
            continue;
          }
        }
        throw error;
      }
    }
  }

  /**
   * Signals a fatal frame detachment, which usually requires a bot restart.
   * @param {Error} error - The source detachment error.
   */
  handleDetachedFrame(error) {
    this.logger.error("[Safety] Browser frame detached. High risk of detection.");
    this.logger.warn("[Safety] Halting bot immediately.");

    this.detachedState = true;
    const safetyError = new Error("DETACHED_FRAME");
    safetyError.original = error;
    throw safetyError;
  }

  // --- Observation & Waiting ---

  /**
   * Waits for a selector to appear in the DOM and becomes visible.
   */
  async waitForElement(selector, timeout = 30000) {
    try {
      await this.page.waitForSelector(selector, { timeout, visible: true });
      return true;
    } catch (error) {
      this.logger.debug(`[Debug] Element not found: ${selector} (URL: ${this.page.url()})`);
      return false;
    }
  }

  /**
   * Waits for a custom function to return a truthy value.
   */
  async waitForFunction(fn, timeout = 30000) {
    try {
      await this.page.waitForFunction(fn, { timeout });
      return true;
    } catch (error) {
      this.logger.debug(`[Debug] Core: waitForFunction timeout (${error.message})`);
      return false;
    }
  }

  /**
   * Non-throwing check for element existence.
   */
  async elementExists(selector, timeout = 2000, visible = false) {
    try {
      await this.page.waitForSelector(selector, { timeout, visible });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves text content from an element. Returns empty string if failed.
   */
  async getText(selector) {
    try {
      return await this.page.$eval(selector, (el) => el.textContent);
    } catch (e) {
      this.logger.debug(`[Debug] Core: getText failed (${e.message})`);
      return "";
    }
  }

  // --- Navigation & Page Flow ---

  /**
   * Navigates to a URL with retry logic and "Hard Reload" fallback.
   * For SPA transitions, use gotoSPA().
   */
  async goto(url, options = {}) {
    const { maxRetries = 3 } = options;

    for (let i = 0; i < maxRetries; i++) {
      try {
        this.logger.info(`[Core] Navigation target: ${url}`);
        return await this.page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
          ...options,
        });
      } catch (error) {
        const isDetachedFrame = error.message?.includes("detached Frame") ||
                               error.message?.includes("Execution context is not available in detached frame");

        if (isDetachedFrame) {
          this.logger.error(`[Critical] Frame detached - cannot retry navigation`);
          throw new Error("DETACHED_FRAME");
        }

        if (this.isNetworkError(error) && i < maxRetries - 1) {
          const waitTime = 2000 * (i + 1);
          this.logger.warn(`[Network] Error during navigation, retrying...`);
          await this.reloadHard().catch(() => { });
          await sleep(waitTime);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Performs an SPA-safe navigation to a GBF hash URL.
   * Handles edge cases where setting location.hash might be ignored by the game router.
   */
  async gotoSPA(url, options = {}) {
    const { timeout = 15000, waitForSelector = null, clickSelector = null } = options;
    const targetHash = url.match(/#.+/) ? url.match(/#.+/)[0] : "";

    if (clickSelector) {
      this.logger.info(`[Core] Navigation (Click): ${clickSelector}`);
      try {
        await this.page.click(clickSelector);
      } catch (e) {
        this.logger.debug(`[Core] Page click refresh failed. Falling back to hash.`);
      }
    } else {
      if (!targetHash) return this.goto(url, options);

      this.logger.info(`[Core] Navigation (SPA): ${targetHash}`);
      try {
        await this.page.evaluate((target) => {
          const current = window.location.hash;
          if (current === target || current === target.replace("#", "")) {
            history.replaceState(null, "", "#");
          }
          window.location.hash = target.replace(/^#/, "");
        }, targetHash);
      } catch (e) {
        this.logger.debug(`[Core] gotoSPA evaluate failed, falling back to goto: ${e.message}`);
        return this.goto(url);
      }
    }

    const deadline = Date.now() + timeout;
    if (waitForSelector) {
      await this.elementExists(waitForSelector, timeout);
      return;
    }

    const success = await this.waitForSPAUpdate(Math.max(0, deadline - Date.now()));
    if (!success) {
      const reloadBtn = ".btn-treasure-footer-reload";
      if (await this.elementExists(reloadBtn, 100)) {
        this.logger.info("[Core] SPA transition seems stuck. Triggering footer reload...");
        await this.clickSafe(reloadBtn, { fast: true, silent: true }).catch(() => { });
        await sleep(500);
      }
    }

    await sleep(10);
    await this.waitForFrameStable(500);
  }

  /**
   * Performs a hard browser reload and clears the HTTP cache to prevent memory bloat on long runs.
   */
  async reloadHard() {
    this.logger.info("[Core] Action: Hard Reload (Full page reset)");
    this.clearClickCache();
    await this.page.reload({ waitUntil: "networkidle2", timeout: 60000 });
    await this.clearBrowserCache();
    await this.waitForFrameStable(1000);
  }

  /**
   * Attempts to use the in-game footer refresh button for a "Soft Reload".
   */
  async reloadSoft(options = { fast: true }) {
    this.logger.info("[Core] Action: Soft Refresh (Footer button)");
    this.clearClickCache();
    const reloadBtn = config.get("navigation.footerReload") || ".btn-treasure-footer-reload";

    if (await this.elementExists(reloadBtn, 500, true)) {
      try {
        await this.page.click(reloadBtn);
        await sleep(150);
        await this.waitForSPAUpdate(options.fast ? 500 : 5000);
        return;
      } catch (e) {
        this.logger.debug(`[Core] Soft refresh click failed: ${e.message}`);
      }
    }

    this.logger.debug("[Core] Soft refresh unavailable, falling back to page.reload");
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.waitForFrameStable(500);
  }

  /**
   * Standardized reload strategy.
   */
  async reloadPage() {
    await this.reloadSoft();
  }

  /**
   * Monitors the game loading overlay and network state to confirm SPA page load.
   */
  async waitForSPAUpdate(timeout = 3000) {
    const start = Date.now();
    try {
      await sleep(150);
      await Promise.race([
        this.page.waitForFunction(
          () => {
            const loader =
              document.querySelector("#loading") ||
              document.querySelector(".loading-wrapper") ||
              document.querySelector(".prt-loading");
            if (!loader) return true;
            const style = window.getComputedStyle(loader);
            return (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.opacity === "0"
            );
          },
          { timeout }
        ),
        this.page.waitForNetworkIdle({ idleTime: 400, timeout }).catch(() => { })
      ]);
      this.logger.debug(`[Core] SPA update finished (${Date.now() - start}ms)`);
      return true;
    } catch (e) {
      this.logger.debug(`[Core] SPA update wait reached timeout (${Date.now() - start}ms)`);
      return false;
    }
  }

  /**
   * Ensures the Puppeteer frame context is stable and reattached after transitions.
   */
  async waitForFrameStable(timeout = 3000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (await this.isFrameAttached()) {
        await sleep(20);
        return true;
      }
      await sleep(20);
    }
    this.logger.warn("[Warn] Core: Frame stability timeout");
    return false;
  }

  /**
   * Core frame health check.
   */
  async isFrameAttached() {
    try {
      if (this.page.mainFrame().isDetached()) return false;
      return await this.page
        .evaluate(() => document.readyState, { timeout: 200 })
        .then(() => true)
        .catch(() => false);
    } catch (e) {
      return false;
    }
  }

  /**
   * Native Puppeteer wait for navigation.
   */
  async waitForNavigation(timeout = 30000) {
    await this.page.waitForNavigation({ waitUntil: "networkidle2", timeout });
  }

  /**
   * Cleanup controller resources.
   */
  async stop() {
    if (this.network) {
      this.network.stop();
      this.network.clearAllListeners();
    }
    await this.disableResourceBlocking();
    if (this._cdpClient) {
      await this._cdpClient.detach().catch(() => {});
      this._cdpClient = null;
    }
  }
}

export default PageController;

