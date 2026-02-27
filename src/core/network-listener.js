import EventEmitter from 'events';
import logger from '../utils/logger.js';

class NetworkListener extends EventEmitter {
    constructor(page, scopedLogger = null) {
        super();
        this.page = page;
        this.logger = scopedLogger || logger;
        this.isListening = false;
        this.handlers = new Map();

        // Increased to 100 to allow headroom for complex monitoring
        this.setMaxListeners(100);

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
            if (url.includes('/result.json') || url.includes('/resultmulti/content/index/') || url.includes('js/view/result/empty.js')) {
                // For JSON check only if it's the result.json endpoint
                if (url.includes('.json')) {
                    const contentType = response.headers()['content-type'];
                    if (!contentType || !contentType.includes('application/json')) return;
                }

                this.logger.info(`[Network] Detected Battle Result (${url.includes('empty.js') ? 'Empty' : 'Rewards'})`);
                this.emit('battle:result', { url, time: Date.now() });
                return;
            }

            // --- Turn number (fires on every page refresh in raid) ---
            if (url.includes('/rest/multiraid/start.json')) {
                const json = await response.json().catch(() => null);
                if (json?.popup) {
                    this.logger.info('[Network] Join error detected (popup in start.json)');
                    this.emit('raid:error', { type: 'start_popup' });
                    return;
                }
                const turn = json?.turn ?? null;
                if (turn !== null) {
                    this.logger.debug(`[Network] Battle start received (turn: ${turn})`);
                    this.emit('battle:start', { turn });
                }
                return;
            }

            // --- Raid Join Validation (Detailed checks) ---
            if (url.includes('/quest/check_multi_start')) {
                const json = await response.json().catch(() => null);
                if (json && json.popup) {
                    const body = json.popup.body ? json.popup.body.toLowerCase() : '';
                    let type = 'check_multi_start';
                    if (body.includes('full')) type = 'full';
                    if (body.includes('pending')) {
                        type = 'pending';
                    } else if (body.includes('three raid battles')) {
                        type = 'concurrent_limit';
                    }

                    const logText = json.popup.body ? json.popup.body : type;
                    this.logger.info(`[Network] Join error detected: ${logText}`);
                    this.emit('raid:error', { type, body: json.popup.body });
                }
                return;
            }

            if (url.includes('/quest/raid_deck_data_create')) {
                const json = await response.json().catch(() => null);
                if (json && (json.error === true || json.error_type !== undefined)) {
                    this.logger.info(`[Network] Deck creation error detected (type: ${json.error_type || 'unknown'})`);
                    this.emit('raid:error', { type: 'deck_error' });
                }
                return;
            }

            // --- Attack/Ability/Summon result: boss death, party wipe, and turn number ---
            if (url.includes('/rest/multiraid/') && (
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
                let terminalFound = false;
                for (const entry of scenario) {
                    if (entry.cmd === 'win') {
                        // cmd:win is the definitive battle-over signal (follows cmd:die)
                        this.logger.info('[Network] Battle won (cmd:win detected)');
                        this.emit('battle:boss_died', {});
                        terminalFound = true;
                        break;
                    }
                    if (entry.cmd === 'lose') {
                        this.logger.info('[Network] Party wipe detected (cmd:lose)');
                        this.emit('battle:party_wiped', {});
                        terminalFound = true;
                        break;
                    }
                }

                if (!terminalFound) {
                    if (url.includes('summon_result.json')) {
                        this.emit('battle:summon_used');
                    } else if (url.includes('ability_result.json')) {
                        this.emit('battle:ability_used');
                    } else if (url.includes('_attack_result.json') || url.includes('normal_attack_result.json')) {
                        this.emit('battle:attack_used');
                    }
                }
                return;
            }

        } catch (error) {
            // Ignore errors reading response (e.g. navigation closing context)
        }
    }
}

export default NetworkListener;
