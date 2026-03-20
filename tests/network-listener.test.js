/**
 * Mock tests for NetworkListener
 *
 * Uses a fake response factory — no real browser needed.
 * Run: npm test -- --testPathPattern=network-listener
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import NetworkListener from '../src/core/network-listener.js';

// ---------------------------------------------------------------------------
// Mock response factory
// ---------------------------------------------------------------------------

const noop = { info: () => { }, warn: () => { }, error: () => { }, debug: () => { } };

function makeResponse({ url, type = 'fetch', json = null, headers = {}, jsonSpy = null }) {
    const jsonFn = jsonSpy
        ? async () => { jsonSpy(); return json; }
        : async () => json;

    return {
        url: () => url,
        request: () => ({ resourceType: () => type }),
        json: jsonFn,
        headers: () => ({ 'content-type': 'application/json', ...headers }),
    };
}

function makeListener() {
    const page = { on: () => { }, off: () => { } };
    const nl = new NetworkListener(page, noop);
    nl.start = () => { nl.isListening = true; };  // skip page.on
    return nl;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function once(emitter, event) {
    return new Promise(resolve => emitter.once(event, resolve));
}

async function handle(nl, responseObj) {
    await nl._handleResponse(responseObj);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NetworkListener — pre-filters', () => {
    test('non-GBF URL bails early — json() never called', async () => {
        const spy = jest.fn();
        const nl = makeListener();
        const res = makeResponse({ url: 'https://google.com/foo.json', jsonSpy: spy });
        await handle(nl, res);
        expect(spy).not.toHaveBeenCalled();
    });

    test('non-XHR resource type bails early', async () => {
        const spy = jest.fn();
        const nl = makeListener();
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/rest/multiraid/summon_result.json',
            type: 'image',
            jsonSpy: spy,
        });
        await handle(nl, res);
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('NetworkListener — listener-count guard', () => {
    test('no battle listeners: json() skipped for attack result', async () => {
        const spy = jest.fn();
        const nl = makeListener();
        // no listeners attached
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/rest/multiraid/normal_attack_result.json',
            jsonSpy: spy,
        });
        await handle(nl, res);
        expect(spy).not.toHaveBeenCalled();
    });

    test('with battle listener: json() IS called', async () => {
        const spy = jest.fn();
        const nl = makeListener();
        nl.on('battle:attack_used', () => { });  // add a listener
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/rest/multiraid/normal_attack_result.json',
            json: { scenario: [] },
            jsonSpy: spy,
        });
        await handle(nl, res);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe('NetworkListener — boss death detection', () => {
    async function bossDiedScenario(cmd, to, urlSuffix = 'normal_attack_result.json') {
        const nl = makeListener();
        nl.on('battle:boss_died', () => { });  // activate guard
        const waitBossDied = once(nl, 'battle:boss_died');
        const res = makeResponse({
            url: `https://game.granbluefantasy.jp/rest/multiraid/${urlSuffix}`,
            json: { scenario: [{ cmd, to }] },
        });
        await handle(nl, res);
        return waitBossDied;
    }

    test('die → to: boss (summon_result) → emits battle:boss_died', async () => {
        const nl = makeListener();
        nl.on('battle:boss_died', () => { });
        const waiting = once(nl, 'battle:boss_died');
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/rest/multiraid/summon_result.json',
            json: { scenario: [{ cmd: 'die', to: 'boss' }] },
        });
        await handle(nl, res);
        await expect(waiting).resolves.toBeDefined();
    });

    test('die → to: enemy (attack_result) → emits battle:boss_died', async () => {
        const result = await bossDiedScenario('die', 'enemy');
        expect(result).toBeDefined();
    });

    test('win cmd → emits battle:boss_died', async () => {
        const result = await bossDiedScenario('win', null);
        expect(result).toBeDefined();
    });
});

describe('NetworkListener — party wipe detection', () => {
    test('lose cmd → emits battle:party_wiped', async () => {
        const nl = makeListener();
        nl.on('battle:party_wiped', () => { });
        const waiting = once(nl, 'battle:party_wiped');
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/rest/multiraid/normal_attack_result.json',
            json: { scenario: [{ cmd: 'lose' }] },
        });
        await handle(nl, res);
        await expect(waiting).resolves.toBeDefined();
    });
});

describe('NetworkListener — action events', () => {
    async function actionEmit(urlSuffix, event) {
        const nl = makeListener();
        nl.on(event, () => { });
        const waiting = once(nl, event);
        const res = makeResponse({
            url: `https://game.granbluefantasy.jp/rest/multiraid/${urlSuffix}`,
            json: { scenario: [] },
        });
        await handle(nl, res);
        return waiting;
    }

    test('summon_result.json → emits battle:summon_used', async () => {
        await expect(actionEmit('summon_result.json', 'battle:summon_used')).resolves.toBeDefined();
    });

    test('ability_result.json → emits battle:ability_used', async () => {
        await expect(actionEmit('ability_result.json', 'battle:ability_used')).resolves.toBeDefined();
    });

    test('fatal_chain_result.json → emits battle:ability_used', async () => {
        await expect(actionEmit('fatal_chain_result.json', 'battle:ability_used')).resolves.toBeDefined();
    });

    test('normal_attack_result.json → emits battle:attack_used', async () => {
        await expect(actionEmit('normal_attack_result.json', 'battle:attack_used')).resolves.toBeDefined();
    });
});

describe('NetworkListener — battle result', () => {
    test('result.json → emits battle:result', async () => {
        const nl = makeListener();
        const waiting = once(nl, 'battle:result');
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/result.json',
            type: 'fetch',
            headers: { 'content-type': 'application/json' },
        });
        await handle(nl, res);
        await expect(waiting).resolves.toBeDefined();
    });

    test('result/content/index → emits battle:result', async () => {
        const nl = makeListener();
        const waiting = once(nl, 'battle:result');
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/result/content/index/1959222574',
            type: 'fetch',
        });
        await handle(nl, res);
        await expect(waiting).resolves.toBeDefined();
    });
});

describe('NetworkListener — start.json', () => {
    test('start.json with turn → emits battle:start', async () => {
        const nl = makeListener();
        const waiting = once(nl, 'battle:start');
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/rest/multiraid/start.json',
            json: { turn: 3 },
        });
        await handle(nl, res);
        const data = await waiting;
        expect(data.turn).toBe(3);
    });

    test('start.json with popup → emits raid:error', async () => {
        const nl = makeListener();
        const waiting = once(nl, 'raid:error');
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/rest/multiraid/start.json',
            json: { popup: { body: 'Error' } },
        });
        await handle(nl, res);
        const data = await waiting;
        expect(data.type).toBe('start_popup');
    });
});

describe('NetworkListener — Replicard signals', () => {
    test('replicard supporter content → emits raid:supporter_screen', async () => {
        const nl = makeListener();
        let emitted = false;
        nl.on('raid:supporter_screen', () => { emitted = true; });
        
        const res = makeResponse({
            url: 'https://game.granbluefantasy.jp/quest/content/supporter/819221/25/0',
            type: 'fetch',
        });
        await handle(nl, res);
        expect(emitted).toBe(true);
    });
});
