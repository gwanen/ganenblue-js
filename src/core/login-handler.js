import { sleep, getRandomInRange } from '../utils/random.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';

/**
 * Automates the authentication flow for the game through the Mobage platform.
 */
class LoginHandler {
    /**
     * @param {import('puppeteer').Page} page - The current browser page.
     * @param {import('winston').Logger} [scopedLogger] - Optional scoped logger instance.
     */
    constructor(page, scopedLogger = null) {
        this.page = page;
        this.logger = scopedLogger || logger;
        this.selectors = config.selectors.login;
    }

    /**
     * Orchestrates the full login sequence from the home page to credential entry.
     * @param {object} credentials - Object containing 'email' and 'password'.
     * @returns {Promise<boolean>} True if authentication succeeded.
     */
    async performLogin(credentials) {
        try {
            this.logger.info('[Auth] Authentication procedure initiated');

            // Step 1: Engage main login interface
            await this.clickLoginButton();

            // Step 2: Select the Mobage platform for authentication
            await this.selectMobageAuth();

            // Step 3: Input credentials into the platform interface
            await this.handleMobageLogin(credentials);

            // Step 4: Confirm closure and return to game state
            await this.returnToGBF();

            this.logger.info('[Auth] Authentication procedure: Complete');
            return true;
        } catch (error) {
            this.logger.error('[Error] [Login] Automation failed:', error.message);
            return false;
        }
    }

    /**
     * Clicks the initial login entry button on the game home page.
     * Bypasses if already on the authentication platform.
     * @private
     */
    async clickLoginButton() {
        const currentUrl = this.page.url();
        if (currentUrl.includes('#authentication')) {
            this.logger.info('[Auth] State: Redirect bypassed (Already authenticated)');
            return;
        }

        this.logger.info('[Auth] Awaiting authentication interface');

        try {
            await this.page.waitForSelector(this.selectors.loginButton, {
                visible: true,
                timeout: 10000
            });

            await sleep(1000);
            await this.page.click(this.selectors.loginButton);
            this.logger.info('[Auth] Action: Login interface engaged');

            // Allow time for SPA redirect to platform selector
            await sleep(2000);
        } catch (error) {
            this.logger.info('[Auth] State: Proceeding to authentication protocol');
        }
    }

    /**
     * Selects Mobage as the authentication provider and handles tab synchronization.
     * @private
     */
    async selectMobageAuth() {
        this.logger.info('[Auth] Platform selection: Mobage');

        try {
            await this.page.waitForSelector(this.selectors.mobageOption, {
                visible: true,
                timeout: 10000
            });

            await sleep(1000);
            await this.page.click(this.selectors.mobageOption);
            this.logger.info('[Auth] Platform state: Mobage selected');

            await this.page.waitForSelector(this.selectors.okButton, {
                visible: true,
                timeout: 10000
            });

            await sleep(1000);

            // Set up BOTH watchers before clicking — navigation may complete before we can await it
            const browser = this.page.browser();

            // Only resolve for actual page targets (not service workers, shared workers, etc.)
            const newPagePromise = new Promise(resolve => {
                const handler = async (target) => {
                    if (target.type() !== 'page') return;
                    const page = await target.page().catch(() => null);
                    if (!page) return;
                    browser.off('targetcreated', handler);
                    resolve({ type: 'newtab', page });
                };
                browser.on('targetcreated', handler);
                // Clean up listener after 12s regardless
                setTimeout(() => browser.off('targetcreated', handler), 12000);
            });

            // Same-tab navigation (connect.mobage.jp redirects in place)
            const sameTabNavPromise = this.page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: 20000
            }).then(() => ({ type: 'sametab', page: this.page })).catch(() => null);

            await this.page.click(this.selectors.okButton);
            this.logger.info('[Auth] Action: Redirect to platform interface');

            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 10000));
            const result = await Promise.race([newPagePromise, sameTabNavPromise, timeoutPromise]);

            if (result?.type === 'newtab') {
                this.page = result.page;
                this.logger.info('[Auth] State: Tab synchronization complete (New tab)');
                // New tab starts at about:blank then navigates — wait for the Mobage page to load
                try {
                    await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
                    this.logger.info('[Auth] State: New tab navigation complete');
                } catch (_) { /* page may already be at destination */ }
            } else if (result?.type === 'sametab') {
                this.logger.info('[Auth] State: Mobage login page loaded (Same-tab)');
            } else {
                // Timeout — page may already be loaded or still loading; check for known pages
                this.logger.info('[Auth] State: Auth redirect timeout — scanning open pages');
                const currentUrl = this.page.url();
                const pages = await browser.pages();
                const mobagePage = pages.find(p => p.url().includes('connect.mobage.jp'));
                if (mobagePage && mobagePage.url() !== currentUrl) {
                    this.page = mobagePage;
                    this.logger.info('[Auth] State: Mobage page found via scan');
                } else {
                    this.logger.info('[Auth] State: Assuming same-tab (current page is login target)');
                }
            }
        } catch (error) {
            this.logger.error(`[Login] Mobage selection failed: ${error.message}`);
            throw new Error('Mobage login option selection failed');
        }
    }

    /**
     * Handles credential entry on the Mobage platform login page.
     * Includes automated retry logic and DOM fallback for input reliability.
     * @param {object} credentials - Mobage login credentials.
     * @private
     */
    async handleMobageLogin(credentials) {
        this.logger.info('[Auth] Platform interface: Analyzing...');

        try {
            this.logger.info('[Auth] Awaiting platform interface load');

            // Retry once — if waitForSelector fires mid-navigation the context is destroyed
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    await this.page.waitForSelector(this.selectors.emailField, {
                        visible: true,
                        timeout: 30000
                    });
                    break;
                } catch (e) {
                    if (attempt === 2) throw e;
                    this.logger.debug(`[Auth] Email field wait failed (attempt ${attempt}), retrying after nav settle...`);
                    await sleep(2000);
                }
            }

            this.logger.info('[Auth] State: Platform interface ready');
            await sleep(3000);

            /**
             * Internal helper to fill fields with validation and retries.
             */
            const fillField = async (selector, value, fieldName) => {
                for (let retry = 0; retry < 3; retry++) {
                    try {
                        this.logger.debug(`[Login] Attempting to fill ${fieldName} (Attempt ${retry + 1}/3)`);
                        await this.page.waitForSelector(selector, { visible: true, timeout: 5000 });

                        // Force clear and focus via DOM
                        await this.page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            if (el) {
                                el.value = '';
                                el.focus();
                            }
                        }, selector);

                        await sleep(800);

                        // Type naturally to avoid detection
                        await this.page.type(selector, value, { delay: getRandomInRange(100, 200) });
                        await sleep(1000);

                        // Validation
                        const actualValue = await this.page.evaluate(sel => document.querySelector(sel).value, selector);
                        if (actualValue === value) {
                            this.logger.info(`[Login] Successfully filled ${fieldName}`);
                            return true;
                        }

                        // DOM Bypass Fallback
                        this.logger.warn(`[Login] ${fieldName} mismatch. Using direct DOM injection...`);
                        await this.page.evaluate((sel, val) => {
                            const el = document.querySelector(sel);
                            if (el) {
                                el.value = val;
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }, selector, value);

                        const finalValue = await this.page.evaluate(sel => document.querySelector(sel).value, selector);
                        if (finalValue === value) {
                            this.logger.info(`[Login] Successfully filled ${fieldName} via Fallback`);
                            return true;
                        }
                    } catch (e) {
                        this.logger.warn(`[Login] Error filling ${fieldName}: ${e.message}`);
                    }
                    await sleep(1000);
                }
                throw new Error(`Failed to fill ${fieldName} after 3 attempts`);
            };

            await fillField(this.selectors.emailField, credentials.email, 'email');
            await sleep(500);

            await fillField(this.selectors.passwordField, credentials.password, 'password');
            await sleep(1000);

            const loginButton = await this.page.$(this.selectors.submitButton);
            if (loginButton) {
                await loginButton.click();
                await loginButton.dispose();
                this.logger.info('[Login] Clicked login button');

                // Wait for platform to process (account for potential reCAPTCHA/delays)
                this.logger.info('[Login] Waiting for login to process...');
                await sleep(10000);
            } else {
                throw new Error('Login button not found');
            }
        } catch (error) {
            throw new Error(`Mobage login failed: ${error.message}`);
        }
    }

    /**
     * Closes the authentication interface and returns focus to the game tab.
     * @private
     */
    async returnToGBF() {
        this.logger.info('[Login] Returning to GBF...');

        try {
            const closeButton = await this.page.waitForSelector(this.selectors.closeButton, {
                timeout: 30000
            });

            if (closeButton) {
                await sleep(2000);
                await closeButton.click();
                this.logger.info('[Login] Clicked close button');
                await sleep(3000);
            }

            this.logger.info('[Login] Returned to GBF page');
        } catch (error) {
            this.logger.warn('[Login] Close button not found — authentication may have auto-completed');
        }
    }
}

export default LoginHandler;

