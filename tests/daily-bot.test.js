import { describe, test, expect } from '@jest/globals';
import { resolveDailyQuests } from '../src/bot/daily-bot.js';

const QUESTS = [
    { id: 'hard', name: 'Hard', url: 'https://game.granbluefantasy.jp/#quest/supporter/305261/28', enabled: true },
    { id: 'omega_pro', name: 'Omega Pro', url: 'https://game.granbluefantasy.jp/#quest/supporter/305441/28/0/18', enabled: false },
    { id: 'clash_pro', name: 'Clash Pro', url: 'https://game.granbluefantasy.jp/#quest/supporter/103991/28' },
    { id: 'broken', name: 'No URL' },
];

describe('resolveDailyQuests', () => {
    test('keeps enabled entries when no selection is given', () => {
        expect(resolveDailyQuests(QUESTS).map((q) => q.id)).toEqual(['hard', 'clash_pro']);
    });

    test('an explicit selection overrides the enabled flag', () => {
        expect(resolveDailyQuests(QUESTS, ['omega_pro']).map((q) => q.id)).toEqual(['omega_pro']);
    });

    test('selection keeps config order and drops unknown ids', () => {
        const ids = resolveDailyQuests(QUESTS, ['clash_pro', 'hard', 'nope']).map((q) => q.id);
        expect(ids).toEqual(['hard', 'clash_pro']);
    });

    test('entries without a URL are never runnable', () => {
        expect(resolveDailyQuests(QUESTS, ['broken'])).toEqual([]);
    });

    test('an empty selection falls back to the enabled entries', () => {
        expect(resolveDailyQuests(QUESTS, []).map((q) => q.id)).toEqual(['hard', 'clash_pro']);
    });

    test('handles a missing or non-array list', () => {
        expect(resolveDailyQuests(undefined)).toEqual([]);
        expect(resolveDailyQuests(null, ['hard'])).toEqual([]);
    });
});
