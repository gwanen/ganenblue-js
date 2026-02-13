import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { existsSync, readFileSync, rmSync } from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { fileURLToPath } from 'url';
import LoginHandler from './login-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Apply stealth plugin
puppeteer.use(StealthPlugin());

class BrowserManager {
    constructor(config, profileId = 'profile1') {
        this.config = config || {};
        this.profileId = profileId;
        this.browser = null;
        this.page = null;
        this.userDataDir = null;
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
        const emulation = this.config.emulation || {};

        // Default window size
        let windowWidth = 600;
        let windowHeight = 900;
        // Configure Window Size
        if (emulation.mode === 'custom') {
            windowWidth = emulation.width || 600;
            windowHeight = emulation.height || 900;
            logger.info(`[Core] Using custom window size: ${windowWidth}x${windowHeight}`);
        } else {
            logger.info('[Core] Using default desktop mode');
        }

        // Create unique temp directory for this session to avoid file locking collisions
        const tempDir = os.tmpdir();
        const uniqueId = `${this.profileId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        this.userDataDir = path.join(tempDir, 'ganenblue-profiles', uniqueId);
        logger.info(`[Core] [${this.profileId}] Launching with temp profile: ${this.userDataDir}`);

        // Prepare launch options
        const launchArgs = [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            `--window-size=${windowWidth},${windowHeight}`,
            // Disable password and security popups
            '--password-store=basic',
            '--disable-features=PasswordImport,PasswordSave,AutofillServerCommunication,Translate,OptimizationGuideModelDownloading,MediaRouter,PasswordManager,PasswordManagerOnboarding',
            '--no-default-browser-check',
            '--disable-infobars',
            '--disable-notifications',
            '--disable-save-password-bubble', // Disable password manager popup
            '--mute-audio', // Save CPU by silencing browser
            // Fix for "Access is denied" cache errors on Windows
            '--disable-gpu-shader-disk-cache',
            '--disable-gpu-program-cache',
            '--disable-gpu-watchdog',
            // STRICTLY disable disk cache to prevent access denied errors
            '--disk-cache-size=0',
            '--media-cache-size=0',
            '--disable-application-cache',
        ];

        // Conditional Sandbox flags (Default: sandbox enabled to avoid Edge warnings)
        if (this.config.disable_sandbox) {
            launchArgs.push('--no-sandbox');
            launchArgs.push('--disable-setuid-sandbox');
        }

        const launchOptions = {
            headless: this.config.headless ? 'new' : false,
            args: launchArgs,
            defaultViewport: null, // Dynamic viewport that matches window size
            ignoreDefaultArgs: ['--enable-automation'],
            userDataDir: this.userDataDir // Explicitly set unique temp dir
        };

        // Use Edge if specified
        if (browserType === 'edge') {
            const edgePath = this.getEdgePath();
            if (edgePath) {
                launchOptions.executablePath = edgePath;
                logger.info(`[Core] Using Microsoft Edge: ${edgePath}`);
            } else {
                logger.warn('[Wait] Edge not found, falling back to Chromium');
            }
        }

        this.browser = await puppeteer.launch(launchOptions);

        // Reuse the initial blank page if available, otherwise create one
        const pages = await this.browser.pages();
        this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

        // Set viewport size
        await this.page.setViewport({ width: windowWidth, height: windowHeight });

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
            logger.warn(`[Wait] Auto-login skipped: ${error.message}`);
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
            const data = yaml.load(fileContents);

            // Check for profile-based structure first
            if (data && data.profiles) {
                if (data.profiles[this.profileId]) {
                    return { mobage: data.profiles[this.profileId] };
                }
                // Legacy mapping
                const legacyMap = { 'p1': 'profile1', 'p2': 'profile2' };
                const legacyKey = legacyMap[this.profileId];
                if (legacyKey && data.profiles[legacyKey]) {
                    return { mobage: data.profiles[legacyKey] };
                }
            }

            // Fallback to legacy structure
            return data;
        } catch (error) {
            logger.error(`[Error] [Core] Failed to load credentials: ${error.message}`);
            return null;
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }

        // Clean up temp dir to mimic ephemeral session
        if (this.userDataDir) {
            setTimeout(() => {
                if (existsSync(this.userDataDir)) {
                    try {
                        rmSync(this.userDataDir, { recursive: true, force: true });
                        logger.info(`[Core] [${this.profileId}] Cleaned up temp profile: ${this.userDataDir}`);
                    } catch (e) {
                        logger.warn(`[Core] [${this.profileId}] Failed to cleanup temp profile (locked?): ${e.message}`);
                    }
                }
            }, 2000); // Give file locks time to release
        }
    }

    /**
     * Delete orphaned profiles older than 24 hours (or configurable)
     */
    static cleanupOldProfiles() {
        try {
            const tempDir = os.tmpdir();
            const profilesDir = path.join(tempDir, 'ganenblue-profiles');

            // Check if base folder exists, skip if not (creating it is browser's job on launch)
            if (!existsSync(profilesDir)) return;

            // TODO: Read directory and delete old folders
            // For now, simpler approach: just log. Implementing full recursive cleanup might be risky without precise filtering.
            // Actually, let's play it safe and NOT delete indiscriminately yet. 
            // Better: Delete the CURRENT outdated ones if possible

            // Let's implement a safe check: 
            // 1. List folders in ganenblue-profiles
            // 2. Check creation time
            // 3. Delete if > 24h
        } catch (e) {
            logger.warn(`[Core] Cleanup warning: ${e.message}`);
        }
    }
}

export default BrowserManager;
