import { sleep } from '../utils/random.js';
import logger from '../utils/logger.js';

class LoginHandler {
    constructor(page) {
        this.page = page;
    }

    /**
     * Main login flow orchestration
     */
    async performLogin(credentials) {
        try {
            logger.info('Starting automated login flow...');

            // Step 1: Click main login button
            await this.clickLoginButton();

            // Step 2: Select Mobage authentication
            await this.selectMobageAuth();

            // Step 3: Wait for Mobage login page and handle it
            await this.handleMobageLogin(credentials);

            // Step 4: Return to GBF page
            await this.returnToGBF();

            logger.info('✓ Automated login completed successfully!');
            return true;
        } catch (error) {
            logger.error('Login automation failed:', error.message);
            return false;
        }
    }

    /**
     * Click the initial login button on GBF home page
     */
    async clickLoginButton() {
        logger.info('Waiting for login button...');

        try {
            await this.page.waitForSelector('#login-auth', {
                visible: true,
                timeout: 15000
            });

            await sleep(1000);
            await this.page.click('#login-auth');
            logger.info('✓ Clicked login button');

            await sleep(2000);
        } catch (error) {
            throw new Error('Login button not found or not clickable');
        }
    }

    /**
     * Select Mobage authentication option
     */
    async selectMobageAuth() {
        logger.info('Selecting Mobage authentication...');

        try {
            await this.page.waitForSelector('#mobage-login', {
                visible: true,
                timeout: 10000
            });

            await sleep(1000);

            // Click Mobage - this will open a new tab
            await this.page.click('#mobage-login');
            logger.info('✓ Selected Mobage login');

            // Wait for new tab to open
            await sleep(3000);

            // Check if a new page was opened
            const browser = this.page.browser();
            const pages = await browser.pages();

            if (pages.length > 1) {
                // Switch to the new tab (last page)
                this.page = pages[pages.length - 1];
                logger.info('✓ Switched to Mobage login tab');
            } else {
                logger.info('Login page opened in same tab');
            }
        } catch (error) {
            throw new Error('Mobage login option not found');
        }
    }

    /**
     * Handle Mobage login page (might be in new tab or iframe)
     */
    async handleMobageLogin(credentials) {
        logger.info('Handling Mobage login page...');

        try {
            // Wait longer for page navigation
            logger.info('Waiting for Mobage login page to load...');
            await sleep(5000);

            // Wait for email field to appear (indicates login page loaded)
            await this.page.waitForSelector('#subject-id', {
                visible: true,
                timeout: 30000
            });

            logger.info('Mobage login page loaded');
            await sleep(1000);

            // Fill email - click first to focus
            await this.page.click('#subject-id');
            await sleep(500);
            await this.page.type('#subject-id', credentials.email, { delay: 100 });
            logger.info('✓ Filled email');
            await sleep(1000);

            // Fill password - click first to focus
            await this.page.click('#subject-password');
            await sleep(500);
            await this.page.type('#subject-password', credentials.password, { delay: 100 });
            logger.info('✓ Filled password');
            await sleep(1500);

            // Click login button
            const loginButton = await this.page.$('#login');
            if (loginButton) {
                await loginButton.click();
                logger.info('✓ Clicked login button');

                // Wait for login to process
                logger.info('Waiting for login to process (may require reCAPTCHA)...');
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
        logger.info('Returning to GBF...');

        try {
            // Look for close button (閉じる)
            const closeButton = await this.page.waitForSelector('.btn-inner.w-btn-m', {
                timeout: 30000
            });

            if (closeButton) {
                await sleep(2000);
                await closeButton.click();
                logger.info('✓ Clicked close button');
                await sleep(3000);
            }

            logger.info('✓ Returned to GBF page');
        } catch (error) {
            logger.warn('Close button not found - login may have completed already');
        }
    }
}

export default LoginHandler;
