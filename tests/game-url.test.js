import { describe, test, expect } from '@jest/globals';
import {
    isResultUrl,
    isRaidUrl,
    isQuestIndexUrl,
    isBattleEndUrl,
} from '../src/utils/game-url.js';

const BASE = 'https://game.granbluefantasy.jp/';

describe('isResultUrl', () => {
    test('matches hash result', () => {
        expect(isResultUrl(BASE + '#result/123456')).toBe(true);
    });

    test('matches path-based solo result', () => {
        expect(isResultUrl(BASE + 'result/content/index/1')).toBe(true);
    });

    test('matches path-based multi result', () => {
        expect(isResultUrl(BASE + 'result_multi/content/index/1')).toBe(true);
    });

    test('does not match battle or menu pages', () => {
        expect(isResultUrl(BASE + '#raid/123')).toBe(false);
        expect(isResultUrl(BASE + '#mypage')).toBe(false);
    });

    test('is null/undefined/empty safe', () => {
        expect(isResultUrl('')).toBe(false);
        expect(isResultUrl(undefined)).toBe(false);
        expect(isResultUrl(null)).toBe(false);
    });
});

describe('isRaidUrl', () => {
    test('matches solo raid hash', () => {
        expect(isRaidUrl(BASE + '#raid/123456')).toBe(true);
    });

    test('matches multi raid hash', () => {
        expect(isRaidUrl(BASE + '#raid_multi/123456')).toBe(true);
    });

    test('does NOT match supporter_raid (party-select screen)', () => {
        // Regression guard: the old bare "_raid" substring check matched this.
        expect(isRaidUrl(BASE + '#supporter_raid/foo')).toBe(false);
    });

    test('does not match result or menu pages', () => {
        expect(isRaidUrl(BASE + '#result/1')).toBe(false);
        expect(isRaidUrl(BASE + '#mypage')).toBe(false);
    });

    test('is empty safe', () => {
        expect(isRaidUrl('')).toBe(false);
        expect(isRaidUrl(undefined)).toBe(false);
    });
});

describe('isQuestIndexUrl', () => {
    test('matches hash and path forms', () => {
        expect(isQuestIndexUrl(BASE + '#quest/index/1')).toBe(true);
        expect(isQuestIndexUrl(BASE + 'quest/index/content/index/1')).toBe(true);
    });

    test('does not match a quest scene', () => {
        expect(isQuestIndexUrl(BASE + '#quest/scene/123')).toBe(false);
    });
});

describe('isBattleEndUrl', () => {
    test('true for result pages', () => {
        expect(isBattleEndUrl(BASE + '#result/1')).toBe(true);
        expect(isBattleEndUrl(BASE + 'result_multi/content/index/1')).toBe(true);
    });

    test('true for quest-index pages', () => {
        expect(isBattleEndUrl(BASE + '#quest/index/1')).toBe(true);
    });

    test('false while still in a raid battle', () => {
        expect(isBattleEndUrl(BASE + '#raid/1')).toBe(false);
    });
});
