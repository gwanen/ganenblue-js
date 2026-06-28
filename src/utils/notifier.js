import logger from './logger.js';
import config from './config.js';

/**
 * Handles external notifications (e.g., Discord Webhooks) for critical bot events.
 */
class Notifier {
    /**
     * Resolves the Discord webhook for a profile from credentials.yaml.
     * Each profile (p1, p2, ...) carries its own optional webhook.
     * @param {string} profileId - The profile identifier.
     * @returns {string|null} The webhook URL, or null if not configured.
     * @private
     */
    getWebhook(profileId) {
        try {
            return config.getCredential(`profiles.${profileId}.discord_webhook`) || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Sends a raw message and/or embeds to a profile's Discord webhook.
     * @param {string} profileId - The profile whose webhook to use.
     * @param {string} content - The text message content.
     * @param {Array<object>} [embeds=[]] - Optional list of Discord embeds.
     * @returns {Promise<void>}
     */
    async sendDiscordMessage(profileId, content, embeds = []) {
        const webhookUrl = this.getWebhook(profileId);
        if (!webhookUrl) return;

        try {
            const body = {
                content: content,
                username: 'GANENBLUE Bot',
                avatar_url: 'https://raw.githubusercontent.com/jscad/jscad/master/packages/web/gh-pages/img/logo.png' 
            };

            if (embeds.length > 0) {
                body.embeds = embeds;
            }

            const response = await fetch(webhookUrl, {
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
        return this.sendDiscordMessage(profileId, '', [{
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
        return this.sendDiscordMessage(profileId, `@everyone 🆘 **CAPTCHA DETECTED** on [${profileId}]!`, [{
            title: 'Human Intervention Required',
            description: 'The bot has stopped due to access verification.',
            color: 0xf59e0b, 
            timestamp: new Date().toISOString()
        }]);
    }
}

export default new Notifier();
