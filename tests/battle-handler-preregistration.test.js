/**
 * Tests for the pre-registration pattern introduced in executeBattle()
 *
 * The fix: listeners for summon_used / boss_died / party_wiped are registered
 * BEFORE handleFullAuto() runs, so an instant quick-summon (fired the moment FA
 * activates) isn't missed due to the gap between handleFullAuto() returning and
 * waitForBattleEnd() registering its own handlers.
 *
 * These tests verify the mechanism without spinning up the full BattleHandler
 * (which requires page/browser context). We replicate the exact pattern from
 * executeBattle() using a plain EventEmitter.
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import EventEmitter from 'events';

// ---------------------------------------------------------------------------
// Replicates the pre-registration block inside executeBattle()
// ---------------------------------------------------------------------------
function setupPreListeners(network, ctx) {
    ctx._preSummonUsed = false;
    ctx._preBossDied = false;
    ctx._prePartyWiped = false;
    ctx._preNetworkTurn = 0;
    ctx._preNetworkTurnReady = false;
    ctx._preNetworkFinished = false;

    const _onPreSummon = () => { ctx._preSummonUsed = true; };
    const _onPreBoss = () => { ctx._preBossDied = true; };
    const _onPreWipe = () => { ctx._prePartyWiped = true; };
    const _onPreStart = ({ turn }) => {
        ctx._preNetworkTurn = turn;
        ctx._preNetworkTurnReady = true;
    };
    const _onPreResult = () => { ctx._preNetworkFinished = true; };

    network.on('battle:summon_used', _onPreSummon);
    network.on('battle:boss_died', _onPreBoss);
    network.on('battle:party_wiped', _onPreWipe);
    network.on('battle:start', _onPreStart);
    network.once('battle:result', _onPreResult);

    // Return cleanup fn (called after handleFullAuto finishes)
    return () => {
        network.off('battle:summon_used', _onPreSummon);
        network.off('battle:boss_died', _onPreBoss);
        network.off('battle:party_wiped', _onPreWipe);
        network.off('battle:start', _onPreStart);
        network.off('battle:result', _onPreResult);
    };
}

// Replicates the flag seeding inside waitForBattleEnd()
function seedFromPreFlags(ctx) {
    const summonUsed = ctx._preSummonUsed || false;
    const bossDied = ctx._preBossDied || false;
    const partyWiped = ctx._prePartyWiped || false;
    const networkTurn = ctx._preNetworkTurn || 0;
    const networkTurnReady = ctx._preNetworkTurnReady || false;
    const networkFinished = ctx._preNetworkFinished || false;

    ctx._preSummonUsed = false;
    ctx._preBossDied = false;
    ctx._prePartyWiped = false;
    ctx._preNetworkTurn = 0;
    ctx._preNetworkTurnReady = false;
    ctx._preNetworkFinished = false;

    return { summonUsed, bossDied, partyWiped, networkTurn, networkTurnReady, networkFinished };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pre-registration — capture during handleFullAuto window', () => {
    test('summon_used fired during FA → _preSummonUsed = true', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);

        // Simulate: quick summon fires while handleFullAuto is running
        network.emit('battle:summon_used', { honor: null });

        cleanup();

        expect(ctx._preSummonUsed).toBe(true);
        expect(ctx._preBossDied).toBe(false);
        expect(ctx._prePartyWiped).toBe(false);
    });

    test('boss_died fired during FA → _preBossDied = true', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);

        network.emit('battle:boss_died', { honor: null });

        cleanup();

        expect(ctx._preBossDied).toBe(true);
        expect(ctx._preSummonUsed).toBe(false);
        expect(ctx._prePartyWiped).toBe(false);
    });

    test('party_wiped fired during FA → _prePartyWiped = true', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);

        network.emit('battle:party_wiped', { honor: null });

        cleanup();

        expect(ctx._prePartyWiped).toBe(true);
        expect(ctx._preSummonUsed).toBe(false);
        expect(ctx._preBossDied).toBe(false);
    });

    test('no events during FA → all pre-flags stay false', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);

        // handleFullAuto ran, nothing happened
        cleanup();

        expect(ctx._preSummonUsed).toBe(false);
        expect(ctx._preBossDied).toBe(false);
        expect(ctx._prePartyWiped).toBe(false);
    });
});

describe('Pre-registration — listener isolation after cleanup', () => {
    test('events fired AFTER cleanup are NOT captured (no double-fire)', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);
        cleanup(); // remove listeners immediately

        // Event fires AFTER cleanup — must not set flag
        network.emit('battle:summon_used', { honor: null });

        expect(ctx._preSummonUsed).toBe(false);
    });

    test('pre-listeners do NOT interfere with waitForBattleEnd own listeners', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);

        network.emit('battle:summon_used', {}); // captured by pre-listener
        cleanup();

        // waitForBattleEnd seeds from pre-flags, then registers its own handler
        const battleFlags = seedFromPreFlags(ctx);
        let ownSummonFired = false;
        network.on('battle:summon_used', () => { ownSummonFired = true; });

        // Seed confirms the pre-captured flag
        expect(battleFlags.summonUsed).toBe(true);

        // Pre-flags are cleared after seeding
        expect(ctx._preSummonUsed).toBe(false);

        // Own listener works normally for future events
        network.emit('battle:summon_used', {});
        expect(ownSummonFired).toBe(true);
    });
});

describe('Pre-registration — flag seeding into waitForBattleEnd', () => {
    test('summonUsed starts true when pre-flag was set', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);
        network.emit('battle:summon_used', {});
        cleanup();

        const { summonUsed, bossDied, partyWiped } = seedFromPreFlags(ctx);

        expect(summonUsed).toBe(true);
        expect(bossDied).toBe(false);
        expect(partyWiped).toBe(false);
    });

    test('seeding clears pre-flags (idempotent across battles)', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);
        network.emit('battle:boss_died', {});
        cleanup();

        seedFromPreFlags(ctx); // first battle seeding

        // Second battle: no early event
        const cleanup2 = setupPreListeners(network, ctx);
        cleanup2();
        const second = seedFromPreFlags(ctx);

        // Must be false — flags were cleared after first seed
        expect(second.bossDied).toBe(false);
        expect(second.summonUsed).toBe(false);
    });

    test('all three flags can be set simultaneously (summon kills boss)', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);

        // Boss-killing summon: both summon_used and boss_died fire
        network.emit('battle:summon_used', {});
        network.emit('battle:boss_died', {});

        cleanup();

        const { summonUsed, bossDied, partyWiped } = seedFromPreFlags(ctx);

        expect(summonUsed).toBe(true);
        expect(bossDied).toBe(true);
        expect(partyWiped).toBe(false);
    });

    test('battle:start captured during transition → networkTurn updated', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);

        network.emit('battle:start', { turn: 5 });

        cleanup();

        const { networkTurn, networkTurnReady } = seedFromPreFlags(ctx);

        expect(networkTurn).toBe(5);
        expect(networkTurnReady).toBe(true);
    });

    test('battle:result captured during transition → networkFinished = true', () => {
        const network = new EventEmitter();
        const ctx = {};
        const cleanup = setupPreListeners(network, ctx);

        network.emit('battle:result', {});

        cleanup();

        const { networkFinished } = seedFromPreFlags(ctx);

        expect(networkFinished).toBe(true);
    });
});
