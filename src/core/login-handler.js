import { sleep } from '../utils/random.js';
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
        this.logger.info('[Login] Waiting for login button...');

        try {
            await this.page.waitForSelector(this.selectors.loginButton, {
                visible: true,
                timeout: 15000
            });

            await sleep(1000);
            await this.page.click(this.selectors.loginButton);
            this.logger.info('[Login] ✓ Clicked login button');

            await sleep(2000);
        } catch (error) {
            throw new Error(`Login button (${this.selectors.loginButton}) not found or not clickable`);
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
            await this.page.click(this.selectors.mobageOption);
            this.logger.info('[Login] ✓ Selected Mobage login');

            // Wait for new tab to open
            await sleep(3000);

            // Check if a new page was opened
            const browser = this.page.browser();
            const pages = await browser.pages();

            if (pages.length > 1) {
                // Switch to the new tab (last page)
                this.page = pages[pages.length - 1];
                this.logger.info('[Login] ✓ Switched to Mobage login tab');
            } else {
                this.logger.info('[Login] Page opened in same tab');
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
            await sleep(1000);

            // Fill email - click first to focus
            await this.page.click(this.selectors.emailField);
            await sleep(500);
            await this.page.type(this.selectors.emailField, credentials.email, { delay: 100 });
            this.logger.info('[Login] ✓ Filled email');
            await sleep(1000);

            // Fill password - click first to focus
            await this.page.click(this.selectors.passwordField);
            await sleep(500);
            await this.page.type(this.selectors.passwordField, credentials.password, { delay: 100 });
            this.logger.info('[Login] ✓ Filled password');
            await sleep(1500);

            // Click login button
            const loginButton = await this.page.$(this.selectors.submitButton);
            if (loginButton) {
                await loginButton.click();
                this.logger.info('[Login] ✓ Clicked login button');

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
            this.logger.warn('[Wait] [Login] Close button not found - login may have completed already');
        }
    }
}

export default LoginHandler;
