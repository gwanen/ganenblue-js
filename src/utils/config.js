import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

class Config {
    constructor() {
        this.config = this.loadYaml('config/default.yaml');
        this.selectors = this.loadYaml('config/selectors.yaml');
        this.mergeEnvVariables();
    }

    loadYaml(filepath) {
        const fullPath = path.join(projectRoot, filepath);
        const fileContents = fs.readFileSync(fullPath, 'utf8');
        return yaml.load(fileContents);
    }

    mergeEnvVariables() {
        // Override with environment variables
        if (process.env.QUEST_URL) {
            if (!this.config.bot) this.config.bot = {};
            this.config.bot.quest_url = process.env.QUEST_URL;
        }
        if (process.env.HEADLESS) {
            if (!this.config.browser) this.config.browser = {};
            this.config.browser.headless = process.env.HEADLESS === 'true';
        }
    }

    get(key, defaultValue = null) {
        const keys = key.split('.');
        let value = this.config;

        for (const k of keys) {
            value = value?.[k];
        }

        return value !== undefined ? value : defaultValue;
    }

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
