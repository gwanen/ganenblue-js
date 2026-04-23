import logger from './logger.js';
import config from './config.js';

/**
 * Handles external notifications (e.g., Discord Webhooks) for critical bot events.
 */
class Notifier {
    constructor() {
        this.webhookUrl = null;
        this.enabled = false;
        this.loadSettings();
    }

    /**
     * Initializes notification settings from the central configuration.
     * @private
     */
    loadSettings() {
        try {
            this.webhookUrl = config.get('notifications.discord_webhook');
            this.enabled = !!this.webhookUrl;
        } catch (e) {
            this.enabled = false;
        }
    }

    /**
     * Sends a raw message and/or embeds to the configured Discord webhook.
     * @param {string} content - The text message content.
     * @param {Array<object>} [embeds=[]] - Optional list of Discord embeds.
     * @returns {Promise<void>}
     */
    async sendDiscordMessage(content, embeds = []) {
        if (!this.enabled || !this.webhookUrl) return;

        try {
            const body = {
                content: content,
                username: 'GANENBLUE Bot',
                avatar_url: 'https://raw.githubusercontent.com/jscad/jscad/master/packages/web/gh-pages/img/logo.png' 
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

    /**
     * Sends an error notification embed.
     * @param {string} profileId - The profile identifier where the error occurred.
     * @param {string} errorMsg - The error message or stack trace.
     * @returns {Promise<void>}
     */
    async notifyError(profileId, errorMsg) {
        return this.sendDiscordMessage('', [{
            title: `⚠️ Error Detected - [${profileId}]`,
            description: `\`\`\`${errorMsg}\`\`\``,
            color: 0xef4444, // Red
            timestamp: new Date().toISOString()
        }]);
    }

    /**
     * Sends a critical captcha detected notification.
     * @param {string} profileId - The profile identifier where the captcha appeared.
     * @returns {Promise<void>}
     */
    async notifyCaptcha(profileId) {
        return this.sendDiscordMessage(`@everyone 🆘 **CAPTCHA DETECTED** on [${profileId}]!`, [{
            title: 'Human Intervention Required',
            description: 'The bot has stopped due to access verification.',
            color: 0xf59e0b, 
            timestamp: new Date().toISOString()
        }]);
    }
}

export default new Notifier();
