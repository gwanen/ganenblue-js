import { sleep, randomDelay } from '../utils/random.js';
import logger from '../utils/logger.js';

class PageController {
    constructor(page) {
        this.page = page;
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
            logger.error(`Element not found: ${selector} (URL: ${currentUrl})`);
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
     * Navigate with retry
     */
    async goto(url, options = {}) {
        const maxRetries = options.maxRetries || 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.page.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: 30000
                });
                logger.info(`Navigated to: ${url}`);
                return true;
            } catch (error) {
                logger.warn(`Navigation attempt ${attempt}/${maxRetries} failed`);
                if (attempt === maxRetries) throw error;
                await sleep(2000);
            }
        }
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
