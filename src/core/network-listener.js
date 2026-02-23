import EventEmitter from 'events';
import logger from '../utils/logger.js';

class NetworkListener extends EventEmitter {
    constructor(page, scopedLogger = null) {
        super();
        this.page = page;
        this.logger = scopedLogger || logger;
        this.isListening = false;
        this.handlers = new Map();

        // Prevent Node.js EventEmitter memory leak warnings for battle:result listeners
        // Each battle registers one .once() listener, so 20 is a safe ceiling.
        this.setMaxListeners(20);

        // Bind handler context
        this._handleResponse = this._handleResponse.bind(this);
    }

    start() {
        if (this.isListening) return;
        this.page.on('response', this._handleResponse);
        this.isListening = true;
        this.logger.info('[Network] Listener started');
    }

    stop() {
        if (!this.isListening) return;
        this.page.off('request', this._handleResponse); // Just in case
        this.page.off('response', this._handleResponse);
        this.isListening = false;
        this.logger.info('[Network] Listener stopped');
    }

    clearAllListeners() {
        this.removeAllListeners();
        this.logger.debug('[Network] All internal listeners cleared');
    }


    async _handleResponse(response) {
        try {
            const url = response.url();

            // Fast pre-filter: Only process GBF result endpoints.
            // This avoids calling response.headers() on every CDN image/font/stylesheet response,
            // which was causing significant CPU overhead when 2+ profiles ran simultaneously.
            if (!url.includes('granbluefantasy.jp')) return;
            if (!url.includes('/result.json')) return;

            // Only now do we confirm by checking the content type header
            const contentType = response.headers()['content-type'];
            if (contentType && contentType.includes('application/json')) {
                this.logger.info('[Network] Detected Result JSON');
                this.emit('battle:result', { url, time: Date.now() });
            }
        } catch (error) {
            // Ignore errors reading response (e.g. navigation closing context)
        }
    }
}

export default NetworkListener;
