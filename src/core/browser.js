import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';

// Apply stealth plugin
puppeteer.use(StealthPlugin());

class BrowserManager {
    constructor(config) {
        this.config = config || {};
        this.browser = null;
        this.page = null;
    }

    async launch() {
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });

        this.browser = await puppeteer.launch({
            headless: this.config.headless ? 'new' : false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--window-size=1920,1080',
                // Disable password and security popups
                '--password-store=basic',
                '--disable-features=PasswordImport,PasswordSave,AutofillServerCommunication,Translate,OptimizationGuideModelDownloading,MediaRouter',
                '--no-default-browser-check',
                '--disable-infobars',
                '--disable-notifications',
            ],
            defaultViewport: { width: 1920, height: 1080 },
            ignoreDefaultArgs: ['--enable-automation'],
        });

        this.page = await this.browser.newPage();

        // Additional stealth measures
        await this.applyStealth();

        return this.page;
    }

    async setViewport(width, height) {
        if (this.page) {
            await this.page.setViewport({ width, height });
        }
    }

    async applyStealth() {
        // Force webdriver to undefined (stealth plugin might set it to false)
        await this.page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        // Remove CDC variables (Chrome DevTools Protocol)
        await this.page.evaluateOnNewDocument(() => {
            const newProto = navigator.__proto__;
            delete newProto.webdriver;
            navigator.__proto__ = newProto;

            // Remove cdc_ variables
            for (const key of Object.keys(window)) {
                if (key.startsWith('cdc_')) {
                    delete window[key];
                }
            }
        });
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}

export default BrowserManager;
