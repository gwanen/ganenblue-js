import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

/**
 * Manages application configuration by loading and merging YAML files,
 * selectors, and environment variable overrides.
 */
class Config {
    constructor() {
        this.config = this.loadYaml('config/default.yaml');
        this.selectors = this.loadYaml('config/selectors.yaml');
        // Secrets live in the git-ignored credentials.yaml; absent on fresh clones.
        this.credentials = this.loadYamlSafe('config/credentials.yaml') || {};
        this.mergeEnvVariables();
    }

    /**
     * Loads and parses a YAML file from the project root.
     * @param {string} filepath - Path to the YAML file relative to project root.
     * @returns {object} Parsed YAML content.
     */
    loadYaml(filepath) {
        const fullPath = path.join(projectRoot, filepath);
        const fileContents = fs.readFileSync(fullPath, 'utf8');
        return yaml.load(fileContents);
    }

    /**
     * Like loadYaml but returns null instead of throwing when the file is
     * missing or unparseable (used for optional, git-ignored files).
     * @param {string} filepath - Path to the YAML file relative to project root.
     * @returns {object|null} Parsed YAML content, or null.
     */
    loadYamlSafe(filepath) {
        try {
            return this.loadYaml(filepath);
        } catch {
            return null;
        }
    }

    /**
     * Overrides internal configuration with available process.env variables.
     * @private
     */
    mergeEnvVariables() {
        if (process.env.QUEST_URL) {
            if (!this.config.bot) this.config.bot = {};
            this.config.bot.quest_url = process.env.QUEST_URL;
        }
        if (process.env.HEADLESS) {
            if (!this.config.browser) this.config.browser = {};
            this.config.browser.headless = process.env.HEADLESS === 'true';
        }
    }

    /**
     * Retrieves a configuration value using a dot-notation key.
     * @param {string} key - The dot-notation key (e.g., "browser.headless").
     * @param {*} [defaultValue=null] - Value to return if the key is missing.
     * @returns {*} The configuration value.
     */
    get(key, defaultValue = null) {
        const keys = key.split('.');
        let value = this.config;

        for (const k of keys) {
            value = value?.[k];
        }

        return value !== undefined ? value : defaultValue;
    }

    /**
     * Retrieves a secret from credentials.yaml using a dot-notation key.
     * Kept separate from get() so secrets never live in the committed config.
     * @param {string} key - The dot-notation key (e.g., "discord_webhook").
     * @param {*} [defaultValue=null] - Value to return if the key is missing.
     * @returns {*} The credential value.
     */
    getCredential(key, defaultValue = null) {
        const keys = key.split('.');
        let value = this.credentials;

        for (const k of keys) {
            value = value?.[k];
        }

        return value !== undefined ? value : defaultValue;
    }

    /**
     * Updates an internal configuration value.
     * @param {string} key - The dot-notation key to update.
     * @param {*} value - The new value to set.
     */
    set(key, value) {
        const keys = key.split('.');
        let obj = this.config;

        for (let i = 0; i < keys.length - 1; i++) {
            if (!obj[keys[i]]) obj[keys[i]] = {};
            obj = obj[keys[i]];
        }

        obj[keys[keys.length - 1]] = value;
    }
}

export default new Config();
