import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { existsSync, readFileSync, rmSync, readdirSync, statSync } from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import logger, { createScopedLogger } from '../utils/logger.js';
import LoginHandler from './login-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Apply puppeteer-extra stealth plugin for bot detection evasion
puppeteer.use(StealthPlugin());

/**
 * Manages browser lifecycle, profile persistence, and stealth configuration.
 * Automatically detects installed browsers and prepares optimized launch arguments.
 */
class BrowserManager {
    /**
     * @param {object} config - Configuration object.
     * @param {string} [profileId='profile1'] - Unique identifier for the profile.
     */
    constructor(config, profileId = 'profile1') {
        this.config = config || {};
        this.profileId = profileId;
        this.logger = createScopedLogger(profileId);
        this.browser = null;
        this.page = null;
        this.userDataDir = null;
    }

    // --- Executable Detection ---

    /**
     * Searches for Microsoft Edge executable paths on Windows.
     * @returns {string|null} Path to msedge.exe or null if not found.
     */
    getEdgePath() {
        const possiblePaths = [
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe'
        ];

        for (const path of possiblePaths) {
            if (existsSync(path)) return path;
        }
        return null;
    }

    /**
     * Searches for Brave Browser executable paths on Windows.
     * @returns {string|null} Path to brave.exe or null if not found.
     */
    getBravePath() {
        const possiblePaths = [
            'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
            'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
            process.env.LOCALAPPDATA + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        ];

        for (const path of possiblePaths) {
            if (existsSync(path)) return path;
        }
        return null;
    }

    /**
     * Searches for Google Chrome executable paths on Windows.
     * @returns {string|null} Path to chrome.exe or null if not found.
     */
    getChromePath() {
        const possiblePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
        ];

        for (const path of possiblePaths) {
            if (existsSync(path)) return path;
        }
        return null;
    }

    /**
     * Searches for Mozilla Firefox executable paths on Windows.
     * @returns {string|null} Path to firefox.exe or null if not found.
     */
    getFirefoxPath() {
        const possiblePaths = [
            'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
            'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
            process.env.LOCALAPPDATA + '\\Mozilla Firefox\\firefox.exe'
        ];

        for (const path of possiblePaths) {
            if (existsSync(path)) return path;
        }
        return null;
    }

    // --- Lifecycle Management ---

    /**
     * Launches the browser with optimized arguments and stealth configuration.
     * @returns {Promise<import('puppeteer').Page>} The primary browser page.
     */
    async launch() {
        const userAgent = new UserAgent({ deviceCategory: 'desktop' });
        const browserType = this.config.browser_type || 'chromium';
        const emulation = this.config.emulation || {};
        const saveProfile = this.config.save_profile || false;

        let windowWidth = 600;
        let windowHeight = 850;

        if (emulation.mode === 'custom') {
            windowWidth = emulation.width || 600;
            windowHeight = emulation.height || 850;
            this.logger.info(`[Core] Viewport resolution: ${windowWidth}x${windowHeight}`);
        } else {
            this.logger.info('[Core] Device mode: Desktop (Default)');
        }

        // Initialize profile directory
        const tempDir = os.tmpdir();
        if (saveProfile) {
            this.userDataDir = path.join(tempDir, 'ganenblue-profiles', 'persistent', this.profileId);
            this.logger.info(`[Core] Using persistent profile: ${this.userDataDir}`);
        } else {
            // Unique ID to prevent file locking collisions between concurrent profiles
            const uniqueId = `${this.profileId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            this.userDataDir = path.join(tempDir, 'ganenblue-profiles', uniqueId);
            this.logger.info(`[Core] Launching with temporary profile: ${this.userDataDir}`);
        }

        const launchArgs = [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            `--window-size=${windowWidth},${windowHeight}`,

            // Component and extension optimizations
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--no-first-run',
            '--disable-sync',
            '--disable-component-update',
            '--disable-client-side-phishing-detection',

            // Security and popup suppression
            '--password-store=basic',
            '--disable-features=PasswordImport,PasswordSave,AutofillServerCommunication,Translate,OptimizationGuideModelDownloading,MediaRouter,PasswordManager,PasswordManagerOnboarding,PasswordLeakDetection,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ThrottleDisplayNoneAndVisibilityHiddenFrame',
            '--no-default-browser-check',
            '--disable-infobars',
            '--disable-notifications',
            '--disable-save-password-bubble',
            '--mute-audio',

            // Graphics and hardware acceleration
            '--ignore-gpu-blocklist',
            '--enable-gpu-rasterization',
            '--enable-zero-copy',
            '--enable-parallel-downloading',

            // Background performance fixes
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-networking',

            // Process and memory management
            '--disable-ipc-flooding-protection',
            '--process-per-site',
            '--js-flags="--max-old-space-size=512 --expose-gc"',
            '--disable-new-id-entities-details',
            '--disable-checker-imaging',
        ];

        if (emulation.x !== undefined && emulation.y !== undefined) {
            launchArgs.push(`--window-position=${emulation.x},${emulation.y}`);
        }

        if (this.config.disable_sandbox) {
            launchArgs.push('--no-sandbox');
            launchArgs.push('--disable-setuid-sandbox');
        }

        const launchOptions = {
            headless: this.config.headless ? 'new' : false,
            args: launchArgs,
            defaultViewport: null,
            ignoreDefaultArgs: ['--enable-automation'],
            userDataDir: this.userDataDir
        };

        // Determine executable path based on preference or auto-detection
        if (this.config.executable_path) {
            launchOptions.executablePath = this.config.executable_path;
            this.logger.info(`[Core] Browser executable: ${this.config.executable_path}`);
            if (this.config.executable_path.toLowerCase().includes('firefox')) {
                launchOptions.browser = 'firefox';
            }
        } else if (browserType === 'edge') {
            const edgePath = this.getEdgePath();
            if (edgePath) {
                launchOptions.executablePath = edgePath;
                this.logger.info('[Core] Browser: Microsoft Edge');
            } else {
                this.logger.warn('[Core] Browser detection: Edge not found (Falling back to Chromium)');
            }
        } else if (browserType === 'brave') {
            const bravePath = this.getBravePath();
            if (bravePath) {
                launchOptions.executablePath = bravePath;
                this.logger.info('[Core] Browser: Brave Browser');
            } else {
                this.logger.warn('[Core] Browser detection: Brave not found (Falling back to Chromium)');
            }
        } else if (browserType === 'chrome') {
            const chromePath = this.getChromePath();
            if (chromePath) {
                launchOptions.executablePath = chromePath;
                this.logger.info('[Core] Browser: Google Chrome');
            } else {
                this.logger.warn('[Core] Browser detection: Chrome not found (Falling back to Chromium)');
            }
        } else if (browserType === 'firefox') {
            const firefoxPath = this.getFirefoxPath();
            if (firefoxPath) {
                launchOptions.executablePath = firefoxPath;
                launchOptions.browser = 'firefox';
                this.logger.info('[Core] Browser: Mozilla Firefox');
            } else {
                this.logger.warn('[Core] Browser detection: Firefox not found (Falling back to Chromium)');
            }
        }

        this.browser = await puppeteer.launch(launchOptions);

        const pages = await this.browser.pages();
        this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

        await this.page.setUserAgent(userAgent.toString());
        this.logger.info(`[Core] User Agent applied: ${userAgent.toString()}`);

        return this.page;
    }

    /**
     * Sets the browser viewport dimensions.
     * @param {number} width - Target width.
     * @param {number} height - Target height.
     */
    async setViewport(width, height) {
        if (this.page) {
            await this.page.setViewport({ width, height });
        }
    }

    /**
     * Navigates to the specified URL and initiates auto-login.
     * @param {string} url - Target game URL.
     */
    async navigateAndLogin(url) {
        if (!this.page) throw new Error('Browser not launched. Call launch() first.');

        try {
            await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        } catch (error) {
            this.logger.error(`[Error] Core: Navigation failure (${error.message})`);
            return false;
        }

        // Perform login if credentials exist for the current profile
        try {
            const credentials = this.loadCredentials();
            if (credentials && credentials.mobage) {
                const loginHandler = new LoginHandler(this.page, this.logger);
                await loginHandler.performLogin(credentials.mobage);
            }
        } catch (error) {
            this.logger.warn(`[Warn] Core: Auto-login bypassed (${error.message})`);
        }
    }

    /**
     * Loads game credentials from the local YAML storage.
     * @returns {object|null} Credential object or null if not found.
     */
    loadCredentials() {
        const credPath = path.join(__dirname, '../../config/credentials.yaml');
        if (!existsSync(credPath)) return null;

        try {
            const fileContents = readFileSync(credPath, 'utf8');
            const data = yaml.load(fileContents);

            if (data && data.profiles) {
                if (data.profiles[this.profileId]) {
                    return { mobage: data.profiles[this.profileId] };
                }
                // Legacy profile mapping
                const legacyMap = { 'p1': 'profile1', 'p2': 'profile2' };
                const legacyKey = legacyMap[this.profileId];
                if (legacyKey && data.profiles[legacyKey]) {
                    return { mobage: data.profiles[legacyKey] };
                }
            }
            return data;
        } catch (error) {
            this.logger.error(`[Error] Storage: Credential load failure (${error.message})`);
            return null;
        }
    }

    /**
     * Closes the browser and purges temporary profile data unless persistence is enabled.
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }

        if (this.config.save_profile) {
            this.logger.info(`[Core] Keeping profile (save_profile enabled): ${this.userDataDir}`);
            return;
        }

        if (this.userDataDir && existsSync(this.userDataDir)) {
            try {
                rmSync(this.userDataDir, { recursive: true, force: true });
                this.logger.info(`[Core] Profile directory purged: ${this.userDataDir}`);
            } catch (e) {
                this.logger.warn(`[Warn] Core: Profile purge failure (${e.message})`);
            }
        }
    }

    /**
     * Scans and deletes orphaned profile directories older than 24 hours.
     */
    static cleanupOldProfiles() {
        try {
            const tempDir = os.tmpdir();
            const profilesDir = path.join(tempDir, 'ganenblue-profiles');

            if (!existsSync(profilesDir)) return;

            const entries = readdirSync(profilesDir, { withFileTypes: true });
            const cutoffTime = Date.now() - (24 * 60 * 60 * 1000);

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const fullPath = path.join(profilesDir, entry.name);
                try {
                    const stat = statSync(fullPath);
                    if (stat.mtimeMs < cutoffTime) {
                        rmSync(fullPath, { recursive: true, force: true });
                        logger.info(`[System] Cleaned up old profile: ${fullPath}`);
                    }
                } catch (e) {
                    logger.warn(`[System] Could not clean ${fullPath}: ${e.message}`);
                }
            }
        } catch (e) {
            logger.warn(`[System] Cleanup warning: ${e.message}`);
        }
    }
}

export default BrowserManager;

