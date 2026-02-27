import { sleep, getRandomInRange } from '../utils/random.js';
import logger from '../utils/logger.js';
import config from '../utils/config.js';

class LoginHandler {
    constructor(page, scopedLogger = null) {
        this.page = page;
        this.logger = scopedLogger || logger;
        this.selectors = config.selectors.login;
    }

    /**
     * Main login flow orchestration
     */
    async performLogin(credentials) {
        try {
            this.logger.info('[Login] Starting automated flow...');

            // Step 1: Click main login button
            await this.clickLoginButton();

            // Step 2: Select Mobage authentication
            await this.selectMobageAuth();

            // Step 3: Wait for Mobage login page and handle it
            await this.handleMobageLogin(credentials);

            // Step 4: Return to GBF page
            await this.returnToGBF();

            this.logger.info('[Login] ✓ Automated login completed successfully!');
            return true;
        } catch (error) {
            this.logger.error('[Error] [Login] Automation failed:', error.message);
            return false;
        }
    }

    /**
     * Click the initial login button on GBF home page
     */
    async clickLoginButton() {
        const currentUrl = this.page.url();
        if (currentUrl.includes('#authentication')) {
            this.logger.info('[Login] Already on authentication page. Skipping login button click.');
            return;
        }

        this.logger.info('[Login] Waiting for login button...');

        try {
            await this.page.waitForSelector(this.selectors.loginButton, {
                visible: true,
                timeout: 10000 // Reduced timeout since it should be fast
            });

            await sleep(1000);
            await this.page.click(this.selectors.loginButton);
            this.logger.info('[Login] Clicked login button');

            // Wait for redirect to #authentication
            await sleep(2000);
        } catch (error) {
            this.logger.info(`[Status] [Login] Login button not found. Proceeding assuming we are on auth page.`);
        }
    }

    /**
     * Select Mobage authentication option
     */
    async selectMobageAuth() {
        this.logger.info('[Login] Selecting Mobage authentication...');

        try {
            await this.page.waitForSelector(this.selectors.mobageOption, {
                visible: true,
                timeout: 10000
            });

            await sleep(1000);

            // Click Mobage - this will open a new tab
            const browser = this.page.browser();
            const newPagePromise = new Promise(resolve => {
                browser.once('targetcreated', target => resolve(target.page()));
            });

            await this.page.click(this.selectors.mobageOption);
            this.logger.info('[Login] Selected Mobage login');

            let timeoutId;
            const timeoutPromise = new Promise(resolve => {
                timeoutId = setTimeout(() => resolve(null), 10000);
            });

            // Wait for new tab to open up to 10 seconds
            const newPage = await Promise.race([
                newPagePromise,
                timeoutPromise
            ]);
            clearTimeout(timeoutId);

            if (newPage) {
                this.page = newPage;
                this.logger.info('[Login] Switched to Mobage login tab reliably');
            } else {
                // Fallback check
                const pages = await browser.pages();
                if (pages.length > 1) {
                    this.page = pages[pages.length - 1];
                    this.logger.info('[Login] Switched to Mobage login tab (fallback)');
                } else {
                    this.logger.info('[Login] Page opened in same tab');
                }
            }
        } catch (error) {
            throw new Error('Mobage login option not found');
        }
    }

    /**
     * Handle Mobage login page (might be in new tab or iframe)
     */
    async handleMobageLogin(credentials) {
        this.logger.info('[Login] Handling Mobage login page...');

        try {
            // Wait longer for page navigation
            this.logger.info('[Login] Waiting for login page to load...');

            // Wait for email field to appear (indicates login page loaded)
            await this.page.waitForSelector(this.selectors.emailField, {
                visible: true,
                timeout: 30000
            });

            this.logger.info('[Login] Mobage login page loaded');
            await sleep(3000);

            const fillField = async (selector, value, fieldName) => {

                for (let retry = 0; retry < 3; retry++) {
                    try {
                        this.logger.debug(`[Login] Attempting to fill ${fieldName} (Attempt ${retry + 1}/3)`);
                        // Ensure element is visible and interactive
                        await this.page.waitForSelector(selector, { visible: true, timeout: 5000 });

                        // Force clear existing value via DOM and set explicit focus
                        await this.page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            if (el) {
                                el.value = '';
                                el.focus();
                            }
                        }, selector);

                        await sleep(800);

                        // Type out the characters naturally
                        await this.page.type(selector, value, { delay: getRandomInRange(100, 200) });
                        await sleep(1000);

                        // Verify it stuck
                        const actualValue = await this.page.evaluate(sel => document.querySelector(sel).value, selector);
                        if (actualValue === value) {
                            this.logger.info(`[Login] Successfully filled ${fieldName}`);
                            return true;
                        }

                        // DOM Bypass Fallback if Puppeteer typing fails completely
                        this.logger.warn(`[Login] ${fieldName} value mismatch. Emitting keyboard events directly via DOM...`);
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

            // Click login button
            const loginButton = await this.page.$(this.selectors.submitButton);
            if (loginButton) {
                await loginButton.click();
                await loginButton.dispose(); // Prevent Memory Leak
                this.logger.info('[Login] Clicked login button');

                // Wait for login to process
                this.logger.info('[Login] Waiting for login to process (may require reCAPTCHA)...');
                await sleep(10000); // Longer wait for reCAPTCHA
            } else {
                throw new Error('Login button not found');
            }
        } catch (error) {
            throw new Error(`Mobage login failed: ${error.message}`);
        }
    }

    /**
     * Click close button to return to GBF
     */
    async returnToGBF() {
        this.logger.info('[Login] Returning to GBF...');

        try {
            // Look for close button (閉じる)
            const closeButton = await this.page.waitForSelector(this.selectors.closeButton, {
                timeout: 30000
            });

            if (closeButton) {
                await sleep(2000);
                await closeButton.click();
                this.logger.info('[Login] ✓ Clicked close button');
                await sleep(3000);
            }

            this.logger.info('[Login] ✓ Returned to GBF page');
        } catch (error) {
            this.logger.warn('[Status] [Login] Close button not found - login may have completed already');
        }
    }
}

export default LoginHandler;
