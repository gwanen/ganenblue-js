import { sleep, randomDelay } from '../utils/random.js';
import logger from '../utils/logger.js';

class PageController {
    constructor(page) {
        this.page = page;
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
                    logger.warn(`Network error during ${operation}, retrying (${i + 1}/${maxRetries}) in ${waitTime / 1000}s...`);
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
            logger.debug(`Element not found: ${selector} (URL: ${currentUrl})`);
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
            maxRetries = 3
        } = options;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Wait for element
                const found = await this.waitForElement(selector, 5000);
                if (!found) {
                    throw new Error(`Element not found: ${selector}`);
                }

                // Random delay before click
                await sleep(randomDelay(200, 500));

                // Click
                await this.page.click(selector);
                logger.debug(`Clicked: ${selector}`);

                // Wait after click
                if (waitAfter) {
                    await sleep(delay);
                }

                return true;
            } catch (error) {
                logger.warn(`Click attempt ${attempt}/${maxRetries} failed: ${selector}`);
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
    async elementExists(selector, timeout = 2000) {
        try {
            await this.page.waitForSelector(selector, { timeout });
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
            logger.info(`Navigated to: ${url}`);
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
}

export default PageController;
