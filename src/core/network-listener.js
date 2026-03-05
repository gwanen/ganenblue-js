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
            const request = response.request();
            const type = request.resourceType();
            const url = response.url();

            // Filter for API/XHR only. Assets like .png/.css are ignored here.
            // Certain end-state signals like empty.js require 'script'.
            if (type !== 'fetch' && type !== 'xhr' && type !== 'script') return;

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

            // --- Attack/Ability/Summon/FatalChain result: boss death, party wipe, and turn number ---
            if (url.includes('/rest/multiraid/') && (
                url.includes('_attack_result.json') ||
                url.includes('ability_result.json') ||
                url.includes('summon_result.json') ||
                url.includes('fatal_chain_result.json')
            )) {
                const json = await response.json().catch(() => null);
                if (!json) return;

                // Extraction: Honor/Points
                const honor = json?.status?.point ?? json?.status?.points ?? json?.point ?? null;

                // Check Scenario for Win/Lose signals
                if (json.scenario && Array.isArray(json.scenario)) {
                    for (const step of json.scenario) {
                        if (step.cmd === 'win' || (step.cmd === 'die' && step.to === 'enemy')) {
                            this.emit('battle:boss_died', { honor });
                            break;
                        } else if (step.cmd === 'lose') {
                            this.emit('battle:party_wiped', { honor });
                            break;
                        }
                    }
                }

                // Action Mapping
                if (url.includes('summon_result.json')) {
                    this.emit('battle:summon_used', { honor });
                } else if (url.includes('fatal_chain_result.json')) {
                    this.emit('battle:ability_used', { honor });
                } else if (url.includes('ability_result.json')) {
                    this.emit('battle:ability_used', { honor });
                } else if (url.includes('_attack_result.json') || url.includes('normal_attack_result.json')) {
                    this.emit('battle:attack_used', { honor });
                }
                return;
            }

            // --- Supporter screen detection ---
            if (url.includes('/rest/sound/quest_supporter_bgm')) {
                this.logger.debug('[Network] Supporter BGM detected -> On supporter selection page');
                this.emit('raid:supporter_screen');
                return;
            }

        } catch (error) {
            // Ignore errors reading response (e.g. navigation closing context)
        }
    }
}

export default NetworkListener;
