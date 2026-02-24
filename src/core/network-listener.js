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

            // Fast pre-filter: Only process GBF API endpoints.
            if (!url.includes('granbluefantasy.jp')) return;

            // --- Battle end (existing) ---
            if (url.includes('/result.json')) {
                const contentType = response.headers()['content-type'];
                if (contentType && contentType.includes('application/json')) {
                    this.logger.info('[Network] Detected Result JSON');
                    this.emit('battle:result', { url, time: Date.now() });
                }
                return;
            }

            // --- Turn number (fires on every page refresh in raid) ---
            if (url.includes('/rest/multiraid/start.json')) {
                const json = await response.json().catch(() => null);
                const turn = json?.turn ?? null;
                if (turn !== null) {
                    this.logger.debug(`[Network] Battle start received (turn: ${turn})`);
                    this.emit('battle:start', { turn });
                }
                return;
            }

            // --- Attack/Ability/Summon result: boss death, party wipe, and turn number ---
            if ((url.includes('/rest/multiraid/') || url.includes('/rest/raid/')) && (
                url.includes('_attack_result.json') ||
                url.includes('ability_result.json') ||
                url.includes('summon_result.json')
            )) {
                const json = await response.json().catch(() => null);
                if (!json) return;

                // Turn number is also in status.turn of attack results
                const statusTurn = json?.status?.turn ?? null;
                if (statusTurn !== null) {
                    this.emit('battle:start', { turn: statusTurn });
                }

                const scenario = json?.scenario ?? [];
                for (const entry of scenario) {
                    if (entry.cmd === 'win') {
                        // cmd:win is the definitive battle-over signal (follows cmd:die)
                        this.logger.info('[Network] Battle won (cmd:win detected)');
                        this.emit('battle:boss_died', {});
                        break;
                    }
                    if (entry.cmd === 'lose') {
                        this.logger.info('[Network] Party wipe detected (cmd:lose)');
                        this.emit('battle:party_wiped', {});
                        break;
                    }
                }

                // If regular attack was used, signal that payload was safely parsed
                // (Used by FA to know it's safe to refresh the page without aborting the request)
                if (url.includes('_attack_result.json')) {
                    this.emit('battle:attack_result');
                }
                return;
            }

        } catch (error) {
            // Ignore errors reading response (e.g. navigation closing context)
        }
    }
}

export default NetworkListener;
