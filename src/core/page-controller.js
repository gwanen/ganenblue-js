import {
  sleep,
  randomDelay,
  getRandomInRange,
  getNormalRandom,
  generateBezierCurve,
} from "../utils/random.js";
import logger from "../utils/logger.js";
import NetworkListener from "./network-listener.js";

class PageController {
  constructor(page, scopedLogger = null) {
    this.page = page;
    this.logger = scopedLogger || logger; // Use scoped (profile-aware) logger if provided
    this.network = new NetworkListener(page, this.logger);
    this.network.start(); // Start listening immediately
    this.requestHandler = null;
    this.lastMousePos = { x: 0, y: 0 };

    // Disable background throttling via CDP immediately
    this.disableBackgroundThrottling().catch(() => {});
  }

  async enableResourceBlocking() {
    if (this.blockingEnabled) return;
    this.blockingEnabled = true;

    await this.page.setRequestInterception(true);

    this.requestHandler = (req) => {
      const url = req.url().toLowerCase();
      const resourceType = req.resourceType();

      // Block trackers and images/media/fonts
      const isTracker =
        url.includes("google-analytics.com") ||
        url.includes("g-acp.com") ||
        url.includes("doubleclick.net");

      if (isTracker || ["image", "media", "font"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    };

    this.page.on("request", this.requestHandler);
    this.logger.info("[Browser] Resource blocking enabled (Images/Media)");
  }

  async disableBackgroundThrottling() {
    try {
      const client = await this.page.target().createCDPSession();
      // 1. Force focusless throttling to disabled (prevents background lag)
      await client.send("Emulation.setFocuslessThrottlingEnabled", {
        enabled: false,
      });
      // 2. Force the page to stay in 'active' lifecycle state
      await client.send("Page.setWebLifecycleState", { state: "active" });

      // Memory Optimization: Cleanly close the CDP session
      await client.detach();

      this.logger.debug("[Core] Background throttling disabled via CDP");
    } catch (error) {
      this.logger.debug("[Core] CDP Throttling override failed");
    }
  }

  async disableResourceBlocking() {
    if (!this.requestHandler && !this.blockingEnabled) return;

    if (this.requestHandler) {
      this.page.off("request", this.requestHandler);
      this.requestHandler = null;
    }

    try {
      // Only attempt to disable if the page is still open
      if (!this.page.isClosed()) {
        await this.page.setRequestInterception(false);
        this.logger.info("[Browser] Resource blocking disabled");
      }
    } catch (e) {
      // Ignore if context lost or already disabled
    }

    this.blockingEnabled = false;
  }

  /**
   * Stop and cleanup all controller resources
   */
  async stop() {
    if (this.network) {
      this.network.stop();
      this.network.clearAllListeners();
    }
    await this.disableResourceBlocking();
  }

  /**
   * Check if error is network-related
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
      message.includes(
        "Execution context is not available in detached frame",
      ) ||
      message.includes("Cannot read properties of null") ||
      message.includes("detached Frame") ||
      message.includes("Frame was detached")
    );
  }

  /**
   * Check if page is still "alive" (not crashed/closed)
   */
  isAlive() {
    try {
      return this.page && !this.page.isClosed();
    } catch (e) {
      return false;
    }
  }

  /**
   * Retry function with exponential backoff
   */
  async retryOnNetworkError(fn, maxRetries = 3, operation = "operation") {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (this.isNetworkError(error) && i < maxRetries - 1) {
          const waitTime = 2000 * (i + 1); // Exponential backoff: 2s, 4s, 6s
          this.logger.warn(
            `[Core] Error during ${operation}, retrying (${i + 1}/${maxRetries}) in ${waitTime / 1000}s...`,
          );
          await sleep(waitTime);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Wait for element with retry logic
   */
  async waitForElement(selector, timeout = 30000) {
    try {
      await this.page.waitForSelector(selector, {
        timeout,
        visible: true,
      });
      return true;
    } catch (error) {
      const currentUrl = this.page.url();
      this.logger.debug(
        `[Debug] Element not found: ${selector} (URL: ${currentUrl})`,
      );
      return false;
    }
  }

  /**
   * Wait for custom function to return truthy
   */
  async waitForFunction(fn, timeout = 30000) {
    try {
      await this.page.waitForFunction(fn, { timeout });
      return true;
    } catch (error) {
      this.logger.debug(`[Debug] waitForFunction timed out: ${error.message}`);
      return false;
    }
  }

  /**
   * Fast click with cached coordinates and minimal stability delay.
   * Used for time-critical buttons (auto, attack) where snappy response
   * matters more than full human-like click simulation.
   *
   * Caches bounding box to skip DOM lookups on repeat clicks.
   * Uses fast Bezier mouse movement for stealth (no teleports).
   * Adds a small 10-50ms stability delay after DOM detection for reliability.
   */
  async cachedClick(selector, stabilityDelay = 15) {
    if (!this._clickCache) this._clickCache = new Map();

    let box = this._clickCache.get(selector);
    if (!box) {
      const el = await this.page.$(selector);
      if (el) {
        box = await el.boundingBox();
        await el.dispose();
        if (box) this._clickCache.set(selector, box);
      }
    }

    if (!box)
      throw new Error(`Element not found for cached click: ${selector}`);

    // Small stability delay for DOM readiness
    if (stabilityDelay > 0) {
      await sleep(stabilityDelay);
    }

    // Uniform random position within element bounds (±2px jitter)
    const x = box.x + box.width / 2 + (Math.random() * 4 - 2);
    const y = box.y + box.height / 2 + (Math.random() * 4 - 2);

    // Fast mouse movement for stealth (skips per-point delays)
    await this.moveMouseHumanLike(x, y, true);

    await this.page.mouse.click(x, y);
    this.logger.debug(
      `[Debug] Cached Click: ${selector} (${stabilityDelay}ms delay)`,
    );
  }

  /**
   * Clear cached click coordinates (call on new battle or page reload)
   */
  clearClickCache() {
    if (this._clickCache) this._clickCache.clear();
  }

  /**
   * Click with human-like behavior
   */
  async clickSafe(selector, options = {}) {
    const {
      waitAfter = true,
      delay = randomDelay(100, 300),
      preDelay = randomDelay(200, 500),
      maxRetries = 3,
      timeout = 5000,
      silent = false,
      fast = false, // New: Skip human-like delays
    } = options;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Wait for element
        const found = await this.waitForElement(selector, timeout);
        if (!found) {
          throw new Error(`Element not found: ${selector}`);
        }

        // Random delay before click
        if (!fast && preDelay > 0) {
          await sleep(preDelay);
        }

        // Get element and bounding box for randomized click
        const element = await this.page.$(selector);
        if (!element) throw new Error(`Element handle not found: ${selector}`);

        const box = await element.boundingBox();
        await element.dispose(); // Fix Memory Leak

        if (!box) throw new Error(`Bounding box not found for: ${selector}`);

        // Calculate normal (Gaussian) distribution around center
        // Sigma (std dev) is 1/6th of width/height to keep ~99% of clicks inside
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;

        const sigmaX = box.width / 6;
        const sigmaY = box.height / 6;

        let randomX = getNormalRandom(centerX, sigmaX);
        let randomY = getNormalRandom(centerY, sigmaY);

        // Clamp to box boundaries (with 5% safety padding)
        const marginX = box.width * 0.05;
        const marginY = box.height * 0.05;
        randomX = Math.max(
          box.x + marginX,
          Math.min(box.x + box.width - marginX, randomX),
        );
        randomY = Math.max(
          box.y + marginY,
          Math.min(box.y + box.height - marginY, randomY),
        );

        // Move mouse to target
        await this.moveMouseHumanLike(randomX, randomY, fast);

        // Tiny hesitation before click
        if (!fast) {
          await sleep(randomDelay(50, 150));
        }

        // Perform randomized click
        await this.page.mouse.click(randomX, randomY);
        this.logger.debug(
          `[Debug] Stealth Click: ${selector} at (${Math.round(randomX)}, ${Math.round(randomY)})`,
        );

        // Wait after click
        if (waitAfter) {
          await sleep(delay);
        }

        return true;
      } catch (error) {
        if (!silent) {
          this.logger.warn(
            `[Core] Click attempt ${attempt}/${maxRetries} failed: ${selector}`,
          );
        }
        if (attempt === maxRetries) {
          throw error;
        }
        await sleep(1000);
      }
    }
  }

  /**
   * Move mouse cursor naturally
   */
  async moveMouseHumanLike(targetX, targetY, fast = false) {
    try {
      const start = this.lastMousePos;
      const end = { x: targetX, y: targetY };

      // If movement is very small, skip curve for speed
      const distance = Math.sqrt(
        Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2),
      );
      if (distance < 5) {
        await this.page.mouse.move(end.x, end.y);
        this.lastMousePos = end;
        return;
      }

      const points = generateBezierCurve(start, end);

      for (const point of points) {
        await this.page.mouse.move(point.x, point.y);
        if (!fast) {
          // Tiny variable delay between points for human-like speed jitter
          await sleep(getRandomInRange(2, 8));
        }
      }

      this.lastMousePos = end;
    } catch (e) {
      this.logger.debug(
        `[Debug] Human mouse move failed (swallowing): ${e.message}`,
      );
    }
  }

  /**
   * Check if element exists (no throw)
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
   * Get element text
   */
  async getText(selector) {
    return await this.page.$eval(selector, (el) => el.textContent);
  }

  /**
   * Navigate with retry logic (full page load).
   * For GBF hash-based SPA navigation, prefer gotoSPA() instead.
   */
  async goto(url, options = {}) {
    const { maxRetries = 3 } = options;

    for (let i = 0; i < maxRetries; i++) {
      try {
        this.logger.info(`[Core] Navigating to: ${url}`);
        return await this.page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
          ...options,
        });
      } catch (error) {
        const isDetached =
          error.message.includes("detached Frame") ||
          error.message.includes("context was destroyed");

        if (this.isNetworkError(error) && i < maxRetries - 1) {
          const waitTime = 2000 * (i + 1);
          this.logger.warn(
            `[Network] Error during navigation${isDetached ? " (Detached Frame)" : ""}, retrying (${i + 1}/${maxRetries}) in ${waitTime / 1000}s...`,
          );

          // If we hit a detached frame, the page state is corrupted.
          // Force a hard reload before the next navigation attempt.
          if (isDetached) {
            this.logger.info(
              "[Core] Detached frame detected. Performing hard reload to reset context...",
            );
            await this.page
              .reload({ waitUntil: "domcontentloaded" })
              .catch(() => {});
            await sleep(1000);
          }

          await sleep(waitTime);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Navigate to a GBF hash-based SPA URL (e.g. '#quest/assist').
   *
   * Problem: page.goto() on a same-origin hash URL only fires a 'hashchange'
   * event — it never triggers 'domcontentloaded'. Worse, if the target hash
   * is ALREADY the current hash, no event fires at all and the DOM stays frozen.
   *
   * This method:
   *   1. Forces a real hashchange even when already on the target URL by
   *      briefly resetting the hash to '' first.
   *   2. Uses in-page JavaScript to set location.hash directly so the SPA
   *      router always picks up the change.
   *   3. Waits for the game's own loading spinner to appear then disappear,
   *      confirming the new page DOM has been rendered.
   *
   * @param {string} url - Full URL with hash, e.g.
   *   'https://game.granbluefantasy.jp/#quest/assist'
   * @param {object} options
   * @param {number} [options.timeout=15000] - Max ms to wait for DOM to settle.
   * @param {string|null} [options.waitForSelector=null] - Optional selector to
   *   wait for after navigation (faster than relying on spinner alone).
   */
  async gotoSPA(url, options = {}) {
    const { timeout = 15000, waitForSelector = null } = options;

    // Extract just the hash portion (e.g. '#quest/assist')
    const hashMatch = url.match(/#.+/);
    const targetHash = hashMatch ? hashMatch[0] : "";

    if (!targetHash) {
      // No hash — fall back to a regular full-page navigation
      return this.goto(url, options);
    }

    this.logger.info(`[Core] SPA navigate to: ${targetHash}`);

    try {
      await this.page.evaluate((target) => {
        const current = window.location.hash;

        // If already on this hash, nudge the router by clearing it first
        // so a real hashchange event fires when we set it again.
        if (current === target || current === target.replace("#", "")) {
          // Temporarily set to a dummy hash — this fires hashchange #1
          history.replaceState(null, "", "#");
        }

        // Now set the real target — fires hashchange #2 (or #1 if we
        // weren't on this hash before), triggering the SPA router.
        window.location.hash = target.replace(/^#/, "");
      }, targetHash);
    } catch (e) {
      // Page context may be mid-navigation; fall back to hard goto.
      this.logger.debug(
        `[Core] gotoSPA evaluate failed, falling back to goto: ${e.message}`,
      );
      return this.goto(url);
    }

    // Wait for the DOM to actually reflect the new page.
    // GBF renders a .loading-bar / #loading element while switching pages.
    // We wait for: (a) a page-specific selector OR (b) loading to finish.
    const deadline = Date.now() + timeout;

    if (waitForSelector) {
      const found = await this.elementExists(waitForSelector, timeout);
      if (!found) {
        this.logger.warn(
          `[Core] gotoSPA: waitForSelector '${waitForSelector}' not found after ${timeout}ms`,
        );
      }
      return;
    }

    // Fallback: wait for the game's loading overlay to disappear, which
    // signals that the new page's DOM has been fully injected.
    try {
      await this.page.waitForFunction(
        () => {
          // GBF uses #loading or .loading-wrapper to signal transitions.
          const loader =
            document.querySelector("#loading") ||
            document.querySelector(".loading-wrapper") ||
            document.querySelector(".prt-loading");
          // If no loader present, the page has settled (or never showed one).
          if (!loader) return true;
          const style = window.getComputedStyle(loader);
          return (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.opacity === "0"
          );
        },
        { timeout: Math.max(0, deadline - Date.now()) },
      );
    } catch (e) {
      // Timeout waiting for loader — the DOM may still be fine, log and continue.
      this.logger.debug(
        `[Core] gotoSPA: loading overlay wait timed out for ${targetHash}`,
      );

      // If we timed out, the router might have ignored the SPA hash change.
      // Attempt an in-game footer reload to forcefully unstick it.
      const reloadBtn = ".btn-treasure-footer-reload";
      if (await this.elementExists(reloadBtn, 100)) {
        this.logger.info(
          "[Core] SPA transition seems stuck. Triggering footer reload...",
        );
        await this.clickSafe(reloadBtn, { fast: true, silent: true }).catch(
          () => {},
        );
        await sleep(500);
      }
    }

    // Extra short yield so any remaining microtasks on the SPA router settle.
    await sleep(50);

    // Frame stability check: ensure frame is reattached after SPA navigation
    await this.waitForFrameStable(2000);
  }

  /**
   * Reload the page using GBF's native footer reload button when possible,
   * falling back to a full browser reload if not available.
   */
  async reloadPage() {
    this.logger.info("[Core] Reloading page...");
    this.clearClickCache();
    const reloadBtn = ".btn-treasure-footer-reload";
    if (await this.elementExists(reloadBtn, 200)) {
      try {
        await this.page.click(reloadBtn);
        await sleep(200);
        return;
      } catch (e) {
        this.logger.debug(
          `[Core] Footer reload failed, falling back to page.reload: ${e.message}`,
        );
      }
    }
    await this.page.reload({ waitUntil: "domcontentloaded" });

    // Frame stability check: ensure frame is reattached after reload
    await this.waitForFrameStable(2000);
  }

  /**
   * Check if the main frame is still attached and usable.
   * Returns true if the frame is healthy, false if detached/stale.
   */
  async isFrameAttached() {
    try {
      // Quick evaluation to test frame health
      await this.page.evaluate(() => document.readyState, { timeout: 500 });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Wait for frame to be stable after navigation/reload.
   * This prevents "detached frame" errors by ensuring the frame is reattached
   * before any interaction attempts.
   */
  async waitForFrameStable(timeout = 3000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (await this.isFrameAttached()) {
        // Frame is attached, give it a brief moment to settle
        await sleep(150);
        return true;
      }
      await sleep(100);
    }
    this.logger.warn("[Core] Frame stability wait timed out");
    return false;
  }

  /**
   * Wait for navigation to complete
   */
  async waitForNavigation(timeout = 30000) {
    await this.page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout,
    });
  }
}

export default PageController;
