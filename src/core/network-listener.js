import EventEmitter from 'events';
import logger from '../utils/logger.js';

class NetworkListener extends EventEmitter {
    constructor(page) {
        super();
        this.page = page;
        this.isListening = false;
        this.handlers = new Map();

        // Bind handler context
        this._handleResponse = this._handleResponse.bind(this);
    }

    start() {
        if (this.isListening) return;
        this.page.on('response', this._handleResponse);
        this.isListening = true;
        logger.info('[Network] Listener started');
    }

    stop() {
        if (!this.isListening) return;
        this.page.off('response', this._handleResponse);
        this.isListening = false;
        logger.info('[Network] Listener stopped');
    }

    async _handleResponse(response) {
        try {
            const url = response.url();

            // Filter for game APIs only
            if (!url.includes('granbluefantasy.jp')) return;

            // Emit raw event for specific URLs if needed
            // this.emit('response', response);

            // Detailed handling for JSON APIs
            const contentType = response.headers()['content-type'];
            if (contentType && contentType.includes('application/json')) {

                // Result JSON (Battle End)
                if (url.includes('/result.json')) {
                    logger.info('[Network] Detected Result JSON');
                    // Clone response to avoid body consumption issues if multiple listeners
                    // However, Puppeteer response body can only be read once. 
                    // We need to be careful. For now, just signaling the event is enough.
                    this.emit('battle:result', { url, time: Date.now() });
                }

                // Process JSON (Turn Processing)
                else if (url.includes('/process.json')) {
                    // logger.debug('[Network] Detected Process JSON');
                    this.emit('battle:process', { url, time: Date.now() });
                }

                // Start JSON (Battle Start)
                else if (url.includes('/start.json')) {
                    logger.info('[Network] Detected Start JSON');
                    this.emit('battle:start', { url, time: Date.now() });
                }
            }
        } catch (error) {
            // Ignore errors reading response (e.g. navigation closing context)
        }
    }
}

export default NetworkListener;
