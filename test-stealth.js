import BrowserManager from './src/core/browser.js';
import logger from './src/utils/logger.js';

async function testStealth() {
    logger.info('Starting stealth test...');
    const browserManager = new BrowserManager({ headless: false });

    try {
        const page = await browserManager.launch();
        logger.info('Browser launched');

        await page.goto('https://bot.sannysoft.com/');
        logger.info('Navigated to bot detection test');

        // Wait for tests to run
        await new Promise(r => setTimeout(r, 5000));

        // Evaluate detection metrics
        const metrics = await page.evaluate(() => {
            return {
                webdriverValue: String(navigator.webdriver),
                webdriverType: typeof navigator.webdriver,
                isWebdriverDefined: 'webdriver' in navigator,
                chrome: window.chrome ? 'Defined' : 'Undefined',
                plugins: navigator.plugins.length,
                languages: navigator.languages,
                permissions: navigator.permissions.query({ name: 'notifications' }).then(p => p.state)
            };
        });

        logger.info('Detection Metrics:', metrics);

        await page.screenshot({ path: 'stealth_test_result.png', fullPage: true });
        logger.info('Screenshot saved as stealth_test_result.png');

        await browserManager.close();
        logger.info('Test completed');
    } catch (error) {
        logger.error('Test failed:', error);
        if (browserManager.browser) await browserManager.close();
    }
}

testStealth();
