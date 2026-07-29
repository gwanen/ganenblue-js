#!/usr/bin/env node
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import logger from '../utils/logger.js';

// Apply stealth plugin
puppeteer.use(StealthPlugin());

async function testStealth() {
    console.log('[Test] Launching browser with stealth plugin...\n');

    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = await browser.newPage();

    console.log('[Test] Navigating to sannysoft.com detector...\n');
    console.log('[Test] Please wait for the page to load and check the results manually.\n');
    console.log('[Test] Test URL: https://bot.sannysoft.com/\n');

    // Navigate to the detector
    await page.goto('https://bot.sannysoft.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });

    // Wait a bit for the tests to run
    await new Promise(resolve => setTimeout(resolve, 8000));

    // Take screenshot
    await page.screenshot({ path: 'logs/sannysoft-result.png' });
    console.log('[Test] Screenshot saved to logs/sannysoft-result.png\n');

    // Run the detector tests and collect results
    const results = await page.evaluate(() => {
        const output = {};

        // Check navigator.webdriver directly
        output.webdriverValue = typeof navigator.webdriver !== 'undefined' ? navigator.webdriver : 'undefined';
        output.webdriverType = typeof navigator.webdriver;

        // Find all text content and look for pass/fail indicators
        const bodyText = document.body.textContent;

        // Count pass/fail indicators
        const passMatches = bodyText.match(/✓/g) || [];
        const failMatches = bodyText.match(/[✗×]/g) || [];

        output.passCount = passMatches.length;
        output.failCount = failMatches.length;

        // Check for chrome runtime
        output.chromeRuntime = typeof chrome !== 'undefined' ? 'exists' : 'undefined';
        output.chromeApp = typeof chrome !== 'undefined' && typeof chrome.app !== 'undefined' ? 'exists' : 'undefined';

        // Get all tables and their content
        const tables = document.querySelectorAll('table');
        output.tableCount = tables.length;

        // Extract table text for analysis
        const tableTexts = [];
        tables.forEach((table) => {
            tableTexts.push(table.textContent.substring(0, 500));
        });
        output.tableContent = tableTexts;

        return output;
    });

    console.log('\n========== STEALTH TEST RESULTS ==========\n');

    // Display key results
    console.log(`navigator.webdriver value: ${results.webdriverValue}`);
    console.log(`navigator.webdriver type: ${results.webdriverType}`);
    console.log(`  Status: ${results.webdriverValue === 'undefined' ? '✓ PASS' : '✗ FAIL (should be undefined)'}\n`);

    console.log(`chrome.runtime: ${results.chromeRuntime}`);
    console.log(`chrome.app: ${results.chromeApp}\n`);

    console.log(`Tables found: ${results.tableCount}`);
    console.log(`Page text - Pass indicators: ${results.passCount}, Fail indicators: ${results.failCount}\n`);

    const passCount = results.passCount;
    const failCount = results.failCount;

    console.log(`\n============================================`);
    console.log(`Total: ${passCount} PASS, ${failCount} FAIL`);
    console.log(`============================================\n`);

    if (failCount > 0) {
        console.log('[Test] Some tests failed. Your browser may be detectable.\n');
    } else if (passCount > 0) {
        console.log('[Test] All tests passed! Your browser appears stealthy.\n');
    }

    console.log('[Test] Browser window is open. Check https://bot.sannysoft.com/ visually for more details.');
    console.log('[Test] Press Ctrl+C to exit.\n');

    // Keep browser open for manual inspection
    return { browser, page, results };
}

// Run the test if called directly
testStealth().catch(async (error) => {
    logger.error('[Test] Error:', error);
    process.exit(1);
});

export default testStealth;
