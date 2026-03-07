import { jest, describe, test, expect } from '@jest/globals';

// 1. Setup Mocks with exact paths relative to the project root
// Jest unstable_mockModule requires exact resolution matches.
jest.unstable_mockModule('../utils/config.js', () => ({
    default: {
        get: jest.fn((key) => {
            if (key === 'profile_id') return 'p1';
            return null;
        }),
        selectors: {
            raid: { raidEntry: '.raid', unclaimedRaidEntry: '.unclaimed' },
            battle: {}
        }
    }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    createScopedLogger: jest.fn(() => ({
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
    }))
}));

jest.unstable_mockModule('../utils/notifier.js', () => ({
    default: { notifyError: jest.fn() }
}));

jest.unstable_mockModule('./battle-handler.js', () => {
    return {
        default: class MockBattleHandler {
            constructor(page, options) {
                this.receivedOptions = options;
            }
        }
    };
});

// 2. Import RaidBot AFTER mocks
const { default: RaidBot } = await import('../src/bot/raid-bot.js');

describe('RaidBot Options Propagation', () => {
    test('should pass summonRefresh: false to BattleHandler when provided', async () => {
        const mockPage = { url: () => 'http://game.granbluefantasy.jp' };
        const options = {
            summonRefresh: false,
            fastRefresh: true,
            profileId: 'p1'
        };

        const instance = new RaidBot(mockPage, options);

        // Verify propagation
        expect(instance.battle.receivedOptions.summonRefresh).toBe(false);
        expect(instance.battle.receivedOptions.fastRefresh).toBe(true);
    });

    test('should default summonRefresh: true when omitted', async () => {
        const mockPage = { url: () => 'http://game.granbluefantasy.jp' };
        const options = { fastRefresh: false };

        const instance = new RaidBot(mockPage, options);

        expect(instance.battle.receivedOptions.summonRefresh).toBe(true);
    });
});
