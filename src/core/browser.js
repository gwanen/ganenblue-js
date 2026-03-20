import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { existsSync, readFileSync, rmSync, readdirSync, statSync } from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import os from 'os';
import logger, { createScopedLogger } from '../utils/logger.js';

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
        this.logger = createScopedLogger(profileId); // Scoped logger for all browser-level logs
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

    /**
     * Detect Brave browser executable path on Windows
     */
    getBravePath() {
        const possiblePaths = [
            'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
            'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
            process.env.LOCALAPPDATA + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        ];

        for (const path of possiblePaths) {
            if (existsSync(path)) {
                return path;
            }
        }

        return null;
    }

    /**
     * Detect Chrome browser executable path on Windows
     */
    getChromePath() {
        const possiblePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
        ];

        for (const path of possiblePaths) {
            if (existsSync(path)) {
                return path;
            }
        }

        return null;
    }

    /**
     * Detect Firefox browser executable path on Windows
     */
    getFirefoxPath() {
        const possiblePaths = [
            'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
            'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
            process.env.LOCALAPPDATA + '\\Mozilla Firefox\\firefox.exe'
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
        let windowHeight = 850;
        // Configure Window Size
        if (emulation.mode === 'custom') {
            windowWidth = emulation.width || 600;
            windowHeight = emulation.height || 850;
            this.logger.info(`[Core] Viewport resolution: ${windowWidth}x${windowHeight}`);
        } else {
            this.logger.info('[Core] Device mode: Desktop (Default)');
        }

        // Create unique temp directory for this session to avoid file locking collisions
        const tempDir = os.tmpdir();
        const uniqueId = `${this.profileId}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        this.userDataDir = path.join(tempDir, 'ganenblue-profiles', uniqueId);
        this.logger.info(`[Core] Browser process initialized (Profile: ${this.userDataDir})`);


        // Prepare launch options
        const launchArgs = [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            `--window-size=${windowWidth},${windowHeight}`,

            // Lighter: Memory and process optimization flags
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--no-first-run',
            '--disable-sync',
            '--disable-component-update', // Save CPU: stop background component updates
            '--disable-client-side-phishing-detection', // Save CPU: skip safety checks

            // Disable password and security popups
            '--password-store=basic',
            '--disable-features=PasswordImport,PasswordSave,AutofillServerCommunication,Translate,OptimizationGuideModelDownloading,MediaRouter,PasswordManager,PasswordManagerOnboarding,PasswordLeakDetection,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ThrottleDisplayNoneAndVisibilityHiddenFrame',
            '--no-default-browser-check',
            '--disable-infobars',
            '--disable-notifications',
            '--disable-save-password-bubble', // Disable password manager popup
            '--mute-audio', // Save CPU by silencing browser

            // Performance: Enable hardware acceleration and shared memory
            '--ignore-gpu-blocklist',
            '--enable-gpu-rasterization',
            '--enable-zero-copy',
            '--enable-parallel-downloading',

            // Lighter: Fix for Virtual Desktop sluggishness (Prevent Background Throttling)
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-networking',

            // Safer: IPC and process optimizations
            '--disable-ipc-flooding-protection',
            '--process-per-site', // Consolidate game processes

            // Modern V8 and Graphics Optimizations
            '--js-flags="--max-old-space-size=512 --expose-gc"', // Limit JS heap memory and expose manual GC
            '--disable-new-id-entities-details',
            '--disable-checker-imaging', // Skip unnecessary image checks to save CPU
        ];

        // Apply Window Position (Auto-Tiling)
        if (emulation.x !== undefined && emulation.y !== undefined) {
            launchArgs.push(`--window-position=${emulation.x},${emulation.y}`);
        }

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

        // Custom Browser Executable (e.g., portable Chromium or Firefox)
        if (this.config.executable_path) {
            launchOptions.executablePath = this.config.executable_path;
            this.logger.info(`[Core] Browser executable: ${this.config.executable_path}`);

            // Puppeteer needs to be told to explicitly drive Firefox instead of CDXP/Chromium
            if (this.config.executable_path.toLowerCase().includes('firefox')) {
                launchOptions.browser = 'firefox'; // or 'product: firefox' in older puppeteer versions
            }
        }
        // Use Edge if specified
        else if (browserType === 'edge') {
            const edgePath = this.getEdgePath();
            if (edgePath) {
                launchOptions.executablePath = edgePath;
                this.logger.info('[Core] Browser: Microsoft Edge');
            } else {
                this.logger.warn('[Core] Browser detection: Edge not found (Falling back to Chromium)');
            }
        }
        // Use Brave if specified
        else if (browserType === 'brave') {
            const bravePath = this.getBravePath();
            if (bravePath) {
                launchOptions.executablePath = bravePath;
                this.logger.info('[Core] Browser: Brave Browser');
            } else {
                this.logger.warn('[Core] Browser detection: Brave not found (Falling back to Chromium)');
            }
        }
        // Use Chrome if specified
        else if (browserType === 'chrome') {
            const chromePath = this.getChromePath();
            if (chromePath) {
                launchOptions.executablePath = chromePath;
                this.logger.info('[Core] Browser: Google Chrome');
            } else {
                this.logger.warn('[Core] Browser detection: Chrome not found (Falling back to Chromium)');
            }
        }
        // Use Firefox if specified
        else if (browserType === 'firefox') {
            const firefoxPath = this.getFirefoxPath();
            if (firefoxPath) {
                launchOptions.executablePath = firefoxPath;
                launchOptions.browser = 'firefox'; // Explicitly tell puppeteer
                this.logger.info('[Core] Browser: Mozilla Firefox');
            } else {
                this.logger.warn('[Core] Browser detection: Firefox not found (Falling back to Chromium)');
            }
        }

        this.browser = await puppeteer.launch(launchOptions);

        // Reuse the initial blank page if available, otherwise create one
        const pages = await this.browser.pages();
        this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

        return this.page;
    }

    async setViewport(width, height) {
        if (this.page) {
            await this.page.setViewport({ width, height });
        }
    }

    /**
     * Navigate to GBF and perform auto-login
     */
    async navigateAndLogin(url) {
        if (!this.page) {
            throw new Error('Browser not launched. Call launch() first.');
        }

        try {
            await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        } catch (error) {
            this.logger.error(`[Error] Core: Navigation failure (Fault: ${error.message})`);
            return false;
        }

        // Load credentials and perform auto-login
        try {
            const credentials = this.loadCredentials();
            if (credentials && credentials.mobage) {
                const loginHandler = new LoginHandler(this.page, this.logger);
                await loginHandler.performLogin(credentials.mobage);
            }
        } catch (error) {
            this.logger.warn(`[Warn] Core: Auto-login bypass (Reason: ${error.message})`);
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
            this.logger.error(`[Error] Storage: Credential load failure (Fault: ${error.message})`);
            return null;
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }

        // Fix #3: Synchronous cleanup — avoids setTimeout firing after process exits on Windows
        if (this.userDataDir && existsSync(this.userDataDir)) {
            try {
                rmSync(this.userDataDir, { recursive: true, force: true });
                this.logger.info(`[Core] Profile directory purged: ${this.userDataDir}`);
            } catch (e) {
                this.logger.warn(`[Warn] Core: Profile purge failure (Fault: ${e.message})`);
            }
        }
    }

    /**
     * Delete orphaned profiles older than 24 hours (or configurable)
     */
    /**
     * Delete orphaned profiles older than 24 hours
     * Fix #4: Was a no-op stub. Now implemented.
     */
    static cleanupOldProfiles() {
        try {
            const tempDir = os.tmpdir();
            const profilesDir = path.join(tempDir, 'ganenblue-profiles');

            if (!existsSync(profilesDir)) return;

            const entries = readdirSync(profilesDir, { withFileTypes: true });
            const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago

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
