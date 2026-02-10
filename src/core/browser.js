import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { existsSync, readFileSync } from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import LoginHandler from './login-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Apply stealth plugin
puppeteer.use(StealthPlugin());

class BrowserManager {
    constructor(config) {
        this.config = config || {};
        this.browser = null;
        this.page = null;
    }

    /**
     * Detect Edge browser executable path on Windows
     */
    getEdgePath() {
        const possiblePaths = [
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe'
        ];

        for (const path of possiblePaths) {
            if (existsSync(path)) {
                return path;
            }
        }

        return null;
    }

    async launch() {
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });
        const browserType = this.config.browser_type || 'chromium';

        // Prepare launch options
        const launchOptions = {
            headless: this.config.headless ? 'new' : false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--window-size=500,850', // Optimized height for GBF
                // Disable password and security popups
                '--password-store=basic',
                '--disable-features=PasswordImport,PasswordSave,AutofillServerCommunication,Translate,OptimizationGuideModelDownloading,MediaRouter,PasswordManager,PasswordManagerOnboarding',
                '--no-default-browser-check',
                '--disable-infobars',
                '--disable-notifications',
                '--disable-save-password-bubble', // Disable password manager popup
            ],
            defaultViewport: null, // Dynamic viewport that matches window size
            ignoreDefaultArgs: ['--enable-automation'],
        };

        // Use Edge if specified
        if (browserType === 'edge') {
            const edgePath = this.getEdgePath();
            if (edgePath) {
                launchOptions.executablePath = edgePath;
                console.log('Using Microsoft Edge:', edgePath);
            } else {
                console.warn('Edge not found, falling back to Chromium');
            }
        }

        this.browser = await puppeteer.launch(launchOptions);

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

    /**
     * Navigate to GBF and perform auto-login
     */
    async navigateAndLogin(url) {
        if (!this.page) {
            throw new Error('Browser not launched. Call launch() first.');
        }

        await this.page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // Load credentials and perform auto-login
        try {
            const credentials = this.loadCredentials();
            if (credentials && credentials.mobage) {
                const loginHandler = new LoginHandler(this.page);
                await loginHandler.performLogin(credentials.mobage);
            }
        } catch (error) {
            console.warn('Auto-login skipped:', error.message);
        }
    }

    /**
     * Load credentials from config file
     */
    loadCredentials() {
        const credPath = path.join(__dirname, '../../config/credentials.yaml');

        if (!existsSync(credPath)) {
            return null;
        }

        try {
            const fileContents = readFileSync(credPath, 'utf8');
            return yaml.load(fileContents);
        } catch (error) {
            console.error('Failed to load credentials:', error.message);
            return null;
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}

export default BrowserManager;
