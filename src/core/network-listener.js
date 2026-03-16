import EventEmitter from 'events';
import logger from '../utils/logger.js';

class NetworkListener extends EventEmitter {
    constructor(page, scopedLogger = null) {
        super();
        this.page = page;
        this.logger = scopedLogger || logger;
        this.isListening = false;

        // Increased to 100 to allow headroom for complex monitoring
        this.setMaxListeners(150);

        // Memory leak detection: Track listener additions
        this.on('newListener', (eventName) => {
            const count = this.listenerCount(eventName);
            if (count > 20) {
                this.logger.warn(`[Memory] High listener count for '${eventName}': ${count}`);
            }
            if (this.listenerCount('battle:result') > 50) {
                this.logger.warn('[Memory] Potential listener leak detected on battle:result');
            }
        });

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

    /**
     * Returns true if the URL belongs to either the solo quest (/rest/raid/)
     * or co-op raid (/rest/multiraid/) endpoint family.
     */
    _isRaidUrl(url) {
        return url.includes('/rest/multiraid/') || url.includes('/rest/raid/');
    }

    /**
     * Returns true if any battle-related listener is active.
     * Used as a guard to skip expensive response.json() parsing
     * when no one is subscribed (e.g. during lobby/menu phases).
     */
    _hasBattleListeners() {
        return (
            this.listenerCount('battle:boss_died') > 0 ||
            this.listenerCount('battle:party_wiped') > 0 ||
            this.listenerCount('battle:attack_used') > 0 ||
            this.listenerCount('battle:summon_used') > 0 ||
            this.listenerCount('battle:ability_used') > 0
        );
    }

    async _handleResponse(response) {
        try {
            const url = response.url();

            // Fast pre-filter: bail out immediately for everything outside GBF.
            // This runs before resourceType() (which has more overhead) to keep
            // non-GBF responses (fonts, analytics, CDNs) essentially free.
            if (!url.includes('granbluefantasy.jp')) return;

            const type = response.request().resourceType();

            // Accept only fetch/XHR/script. Certain end-state signals like empty.js need 'script'.
            if (type !== 'fetch' && type !== 'xhr' && type !== 'script') return;

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

            // --- Turn number (fires on every page refresh in raid/quest) ---
            if (this._isRaidUrl(url) && url.includes('/start.json')) {
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
            // Matches both /rest/raid/ (solo quest) and /rest/multiraid/ (co-op raid)
            if (this._isRaidUrl(url) && (
                url.includes('_attack_result.json') ||
                url.includes('ability_result.json') ||
                url.includes('summon_result.json') ||
                url.includes('fatal_chain_result.json')
            )) {
                // Guard: skip expensive JSON parsing when no battle listeners are active.
                // During lobby/menu phases this saves deserializing 500KB+ responses.
                if (!this._hasBattleListeners()) return;

                const json = await response.json().catch(() => null);
                if (!json) return;

                // Extraction: Honor/Points
                const honor = json?.status?.point ?? json?.status?.points ?? json?.point ?? null;

                // Check Scenario for Win/Lose signals.
                // Array.find() short-circuits on the first match — crucial for large raid scenarios
                // where the step array can be hundreds of entries long.
                if (json.scenario && Array.isArray(json.scenario)) {
                    const terminal = json.scenario.find(s =>
                        s.cmd === 'win' || (s.cmd === 'die' && (s.to === 'enemy' || s.to === 'boss')) || s.cmd === 'lose'
                    );
                    if (terminal) {
                        if (terminal.cmd === 'win' || (terminal.cmd === 'die' && (terminal.to === 'enemy' || terminal.to === 'boss'))) {
                            this.emit('battle:boss_died', { honor });
                        } else {
                            this.emit('battle:party_wiped', { honor });
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
                } else if (url.includes('_attack_result.json')) {
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
