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

            // Detailed handling for JSON APIs
            const contentType = response.headers()['content-type'];
            if (contentType && contentType.includes('application/json')) {

                // Result JSON (Battle End)
                if (url.includes('/result.json')) {
                    logger.info('[Network] Detected Result JSON');
                    this.emit('battle:result', { url, time: Date.now() });
                }
            }
        } catch (error) {
            // Ignore errors reading response (e.g. navigation closing context)
        }
    }
}

export default NetworkListener;
