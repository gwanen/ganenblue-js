import { sleep, randomDelay, getRandomInRange, getNormalRandom } from '../utils/random.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import NetworkListener from './network-listener.js';

class PageController {
    constructor(page) {
        this.page = page;
        this.network = new NetworkListener(page);
        this.requestHandler = null;
    }

    async enableResourceBlocking() {
        if (this.blockingEnabled) return;
        this.blockingEnabled = true;

        await this.page.setRequestInterception(true);
        await this.page.setRequestInterception(true);

        this.requestHandler = (req) => {
            const resourceType = req.resourceType();
            const url = req.url();

            // Allow essential game assets but block heavy media
            if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
                // Optimization: Block images for speed, but keep some UI elements if needed
                // For now, aggressive blocking
                if (url.includes('assets/img/sp/ui') || url.includes('assets/img/sp/quest')) {
                    // Keep UI and Quest images to avoid broken layout issues if needed
                    // req.continue();
                    // Actually, for pure botting speed, block ALL images.
                    req.abort();
                } else {
                    req.abort();
                }
            } else {
                req.continue();
            }
        };

        this.page.on('request', this.requestHandler);
        logger.info('[Performance] Resource blocking enabled (Images/Media)');
    }

    async disableResourceBlocking() {
        if (!this.blockingEnabled) return;

        if (this.requestHandler) {
            this.page.off('request', this.requestHandler);
            this.requestHandler = null;
        }

        try {
            await this.page.setRequestInterception(false);
        } catch (e) {
            // Ignore if already disabled or context lost
        }

        this.blockingEnabled = false;
        logger.info('[Performance] Resource blocking disabled');
    }

    /**
     * Check if error is network-related
     */
    isNetworkError(error) {
        const message = error.message || '';
        return message.includes('Navigation timeout') ||
            message.includes('net::ERR') ||
            message.includes('Protocol error') ||
            message.includes('Session closed') ||
            message.includes('Target closed');
    }

    /**
     * Retry function with exponential backoff
     */
    async retryOnNetworkError(fn, maxRetries = 3, operation = 'operation') {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn();
            } catch (error) {
                if (this.isNetworkError(error) && i < maxRetries - 1) {
                    const waitTime = 2000 * (i + 1); // Exponential backoff: 2s, 4s, 6s
                    logger.warn(`[Network] Error during ${operation}, retrying (${i + 1}/${maxRetries}) in ${waitTime / 1000}s...`);
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
                visible: true
            });
            return true;
        } catch (error) {
            const currentUrl = this.page.url();
            logger.debug(`[Debug] Element not found: ${selector} (URL: ${currentUrl})`);
            return false;
        }
    }

    /**
     * Click with human-like behavior
     */
    async clickSafe(selector, options = {}) {
        const {
            waitAfter = true,
            delay = randomDelay(100, 300),
            maxRetries = 3,
            timeout = 5000,
            silent = false
        } = options;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Wait for element
                const found = await this.waitForElement(selector, timeout);
                if (!found) {
                    throw new Error(`Element not found: ${selector}`);
                }

                // Random delay before click
                await sleep(randomDelay(200, 500));

                // Get element and bounding box for randomized click
                const element = await this.page.$(selector);
                if (!element) throw new Error(`Element handle not found: ${selector}`);

                const box = await element.boundingBox();
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
                randomX = Math.max(box.x + marginX, Math.min(box.x + box.width - marginX, randomX));
                randomY = Math.max(box.y + marginY, Math.min(box.y + box.height - marginY, randomY));

                // Perform randomized click
                await this.page.mouse.click(randomX, randomY);
                logger.debug(`[Debug] Centralized Click: ${selector} at (${Math.round(randomX)}, ${Math.round(randomY)})`);

                // Wait after click
                if (waitAfter) {
                    await sleep(delay);
                }

                return true;
            } catch (error) {
                if (!silent) {
                    logger.warn(`[Wait] Click attempt ${attempt}/${maxRetries} failed: ${selector}`);
                }
                if (attempt === maxRetries) {
                    throw error;
                }
                await sleep(1000);
            }
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
        return await this.page.$eval(selector, el => el.textContent);
    }

    /**
     * Navigate with retry logic
     */
    async goto(url, options = {}) {
        return this.retryOnNetworkError(async () => {
            logger.info(`[Core] Navigating to: ${url}`);
            return await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000, // 60s timeout
                ...options
            });
        }, 3, 'navigation');
    }

    /**
     * Wait for navigation to complete
     */
    async waitForNavigation(timeout = 30000) {
        await this.page.waitForNavigation({
            waitUntil: 'networkidle2',
            timeout
        });
    }

    /**
     * Take a screenshot for debugging
     */
    async takeScreenshot(namePrefix = 'screenshot') {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dir = path.resolve('screenshots');
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const filename = path.join(dir, `${namePrefix}_${timestamp}.png`);

            await this.page.screenshot({ path: filename, fullPage: true });
            logger.info(`[Debug] Screenshot saved: ${filename}`);
        } catch (error) {
            logger.error(`[Error] Failed to take screenshot: ${error.message}`);
        }
    }
}

export default PageController;
