import EventEmitter from 'events';
import logger from '../utils/logger.js';

/**
 * Monitors network traffic to detect Granblue Fantasy game signals.
 * Emits events based on intercepted API responses for combat, raids, and navigation.
 */
class NetworkListener extends EventEmitter {
    /**
     * @param {import('puppeteer').Page} page - The Puppeteer page instance to monitor.
     * @param {import('winston').Logger} [scopedLogger] - Optional scoped logger instance.
     */
    constructor(page, scopedLogger = null) {
        super();
        this.page = page;
        this.logger = scopedLogger || logger;
        this.isListening = false;

        // Increased to allow headroom for complex monitoring across multiple concurrent listeners
        this.setMaxListeners(150);

        // --- Memory Management ---

        // Track listener additions to detect potential leaks early
        this.on('newListener', (eventName) => {
            const count = this.listenerCount(eventName);
            if (count > 20) {
                this.logger.warn(`[Warn] Core: High listener count for '${eventName}' (Count: ${count})`);
            }
            if (this.listenerCount('battle:result') > 50) {
                this.logger.warn('[Warn] Core: Potential listener leak detected (battle:result)');
            }
        });

        // Bind handler context for Puppeteer event listeners
        this._handleResponse = this._handleResponse.bind(this);
    }

    /**
     * Starts monitoring network responses.
     */
    start() {
        if (this.isListening) return;
        this.page.on('response', this._handleResponse);
        this.isListening = true;
        this.logger.info('[Core] Listener state: Active');
    }

    /**
     * Stops monitoring network responses.
     */
    stop() {
        if (!this.isListening) return;
        this.page.off('response', this._handleResponse);
        this.isListening = false;
        this.logger.info('[Core] Listener state: Inactive');
    }

    /**
     * Removes all internal event listeners.
     */
    clearAllListeners() {
        this.removeAllListeners();
        this.logger.debug('[Core] Signal: Internal listeners cleared');
    }

    /**
     * Checks if a URL belongs to a raid or solo quest endpoint.
     * @param {string} url - The URL to check.
     * @returns {boolean} True if the URL relates to a raid/quest endpoint.
     * @private
     */
    _isRaidUrl(url) {
        return url.includes('/rest/multiraid/') || url.includes('/rest/raid/');
    }

    /**
     * Determines if any battle-related listeners are active.
     * Used to skip expensive response parsing when idling in menus.
     * @returns {boolean} True if battle monitoring is required.
     * @private
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

    /**
     * Main response handler for intercepted network traffic.
     * @param {import('puppeteer').HTTPResponse} response - The intercepted response object.
     * @private
     */
    async _handleResponse(response) {
        try {
            const url = response.url();

            // Fast pre-filter: bail out immediately for everything outside GBF domains.
            // This runs before resourceType() to keep non-game responses (CDNs, analytics) essentially free.
            if (!url.includes('granbluefantasy.jp')) return;

            const type = response.request().resourceType();

            // Accept only fetch, XHR, or script (used for end-state signals like empty.js).
            if (type !== 'fetch' && type !== 'xhr' && type !== 'script') return;

            // --- Battle Result Detection ---

            const isDetailUrl = url.includes('/resultmulti/content/detail/') || url.includes('/result/content/detail/');
            const isResultPattern = url.includes('/result.json') || url.includes('/resultmulti/content/index/') || url.includes('/result/content/index/') || url.includes('js/view/result/empty.js') || isDetailUrl;

            if (isResultPattern && !url.includes('.css')) {
                // Ensure JSON integrity for specific result endpoints
                if (url.includes('.json')) {
                    const contentType = response.headers()['content-type'];
                    if (!contentType || !contentType.includes('application/json')) return;
                }

                this.logger.debug(`[Status] Signal: Combat Result (${url.includes('empty.js') ? 'Empty' : 'Rewards'}) detected`);
                const isIndexUrl = url.includes('/resultmulti/content/index/') || url.includes('/result/content/index/');
                let rewards = null;

                if (isDetailUrl || isIndexUrl || url.includes('.json')) {
                    const endpointLabel = isDetailUrl ? 'Result detail' : isIndexUrl ? 'Result index' : 'result.json';
                    this.logger.debug(`[Loot] ${endpointLabel} endpoint detected — attempting to parse rewards`);

                    const json = await response.json().catch((e) => {
                        this.logger.warn(`[Loot] Failed to parse ${endpointLabel} response: ${e?.message ?? e}`);
                        return null;
                    });

                    rewards = json?.option?.result_data?.rewards ?? null;
                    if (!rewards) {
                        this.logger.debug(`[Loot] ${endpointLabel} parsed but rewards not found`);
                    } else {
                        this.logger.debug('[Loot] Rewards parsed successfully — emitting');
                    }
                }

                this.emit('battle:result', { url, time: Date.now(), rewards });
                return;
            }

            // --- Combat Synchronization (Turn Number) ---

            if (this._isRaidUrl(url) && url.includes('/start.json')) {
                const json = await response.json().catch(() => null);

                // Handle join errors manifested as popups in the start response
                if (json?.popup) {
                    this.logger.info('[Status] Signal: Join error detected (popup in start.json)');
                    this.emit('raid:error', { type: 'start_popup' });
                    return;
                }

                const turn = json?.turn ?? null;
                if (turn !== null) {
                    this.logger.debug(`[Status] Signal: Combat synchronization received (Turn: ${turn})`);
                    this.emit('battle:start', { turn });
                }
                return;
            }

            // --- Raid Entry Validation ---

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
                    this.logger.info(`[Status] Signal: Join error detected (Message: ${logText})`);
                    this.emit('raid:error', { type, body: json.popup.body });
                }
                return;
            }

            if (url.includes('/quest/raid_deck_data_create')) {
                const json = await response.json().catch(() => null);
                if (json && (json.error === true || json.error_type !== undefined)) {
                    this.logger.info(`[Status] Signal: Deck configuration error (Type: ${json.error_type || 'unknown'})`);
                    this.emit('raid:error', { type: 'deck_error' });
                }
                return;
            }

            // --- Battle Action Results ---

            if (this._isRaidUrl(url) && (
                url.includes('_attack_result.json') ||
                url.includes('ability_result.json') ||
                url.includes('summon_result.json') ||
                url.includes('fatal_chain_result.json')
            )) {
                // Guard: skip deserialization when no combat listeners are active to save resources
                if (!this._hasBattleListeners()) return;

                const json = await response.json().catch(() => null);
                if (!json) return;

                const honor = json?.status?.point ?? json?.status?.points ?? json?.point ?? null;

                // Check scenario for win/loss signals (Array.find for performance)
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

                // Map results to specific action events
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

            // --- Navigation Signals ---

            if (url.includes('/rest/sound/quest_supporter_bgm') || url.includes('/quest/content/supporter/')) {
                this.logger.debug(`[Status] Signal: Supporter screen detected (Source: ${url.includes('sound') ? 'BGM' : 'Content'})`);
                this.emit('raid:supporter_screen');
                return;
            }

        } catch (error) {
            // Silently ignore errors during response parsing (e.g., context closure during navigation)
        }
    }
}

export default NetworkListener;

