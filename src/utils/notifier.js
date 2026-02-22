import logger from './logger.js';
import config from './config.js';

class Notifier {
    constructor() {
        this.webhookUrl = null;
        this.enabled = false;
        this.loadSettings();
    }

    loadSettings() {
        try {
            this.webhookUrl = config.get('notifications.discord_webhook');
            this.enabled = !!this.webhookUrl;
        } catch (e) {
            this.enabled = false;
        }
    }

    async sendDiscordMessage(content, embeds = []) {
        if (!this.enabled || !this.webhookUrl) return;

        try {
            const body = {
                content: content,
                username: 'GANENBLUE Bot',
                avatar_url: 'https://raw.githubusercontent.com/jscad/jscad/master/packages/web/gh-pages/img/logo.png' // Default placeholder
            };

            if (embeds.length > 0) {
                body.embeds = embeds;
            }

            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const text = await response.text();
                logger.error(`[System] Discord webhook failed: ${response.status} ${text}`);
            }
        } catch (error) {
            logger.error(`[System] Error sending Discord message: ${error.message}`);
        }
    }

    async notifySessionStart(profileId, mode) {
        return this.sendDiscordMessage('', [{
            title: `🚀 Session Started - [${profileId}]`,
            description: `Bot mode: **${mode.toUpperCase()}**`,
            color: 0x3b82f6, // Blue
            timestamp: new Date().toISOString()
        }]);
    }

    async notifySessionComplete(profileId, stats) {
        return this.sendDiscordMessage('', [{
            title: `✅ Session Complete - [${profileId}]`,
            fields: [
                { name: 'Completed', value: (stats.completedQuests || stats.raidsCompleted || 0).toString(), inline: true },
                { name: 'Avg Battle', value: (stats.avgBattleTime / 1000).toFixed(1) + 's', inline: true },
                { name: 'Avg Turns', value: (stats.avgTurns || 0).toString(), inline: true }
            ],
            color: 0x10b981, // Green
            timestamp: new Date().toISOString()
        }]);
    }

    async notifyError(profileId, errorMsg) {
        return this.sendDiscordMessage('', [{
            title: `⚠️ Error Detected - [${profileId}]`,
            description: `\`\`\`${errorMsg}\`\`\``,
            color: 0xef4444, // Red
            timestamp: new Date().toISOString()
        }]);
    }

    async notifyCaptcha(profileId) {
        return this.sendDiscordMessage(`@everyone 🆘 **CAPTCHA DETECTED** on [${profileId}]!`, [{
            title: 'Human Intervention Required',
            description: 'The bot has stopped due to access verification.',
            color: 0xf59e0b, // Yellow
            timestamp: new Date().toISOString()
        }]);
    }
}

export default new Notifier();
