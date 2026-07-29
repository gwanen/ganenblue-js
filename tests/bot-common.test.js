import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import {
    computeRate,
    averageBattleTime,
    applyPerformanceOptions,
    checkBattleCaptcha,
} from '../src/bot/bot-common.js';

describe('computeRate', () => {
    test('returns 0.0/h when startTime is missing', () => {
        expect(computeRate(null, 5)).toBe('0.0/h');
        expect(computeRate(undefined, 5)).toBe('0.0/h');
    });

    test('returns 0.0/h for zero completions', () => {
        expect(computeRate(Date.now() - 3_600_000, 0)).toBe('0.0/h');
    });

    test('computes completions per hour', () => {
        // started exactly 2h ago, 10 done -> 5.0/h
        expect(computeRate(Date.now() - 2 * 3_600_000, 10)).toBe('5.0/h');
    });

    test('does not divide by zero for a just-started session', () => {
        // startTime === now -> uptime 0 -> guarded
        expect(computeRate(Date.now(), 3)).toBe('0.0/h');
    });
});

describe('averageBattleTime', () => {
    test('returns 0 for empty', () => {
        expect(averageBattleTime([])).toBe(0);
        expect(averageBattleTime()).toBe(0);
    });

    test('rounds the mean', () => {
        expect(averageBattleTime([100, 200, 301])).toBe(200); // 200.33 -> 200
    });
});

describe('applyPerformanceOptions', () => {
    let controller;
    let logger;

    beforeEach(() => {
        controller = {
            enableResourceBlocking: jest.fn().mockResolvedValue(),
            enableTurboCSS: jest.fn().mockResolvedValue(),
        };
        logger = { info: jest.fn(), warn: jest.fn() };
    });

    test('honors explicit blockResources=true and turboMode=true', () => {
        applyPerformanceOptions({ controller, logger, options: { blockResources: true, turboMode: true } });
        expect(controller.enableResourceBlocking).toHaveBeenCalledTimes(1);
        expect(controller.enableTurboCSS).toHaveBeenCalledTimes(1);
    });

    test('skips resource blocking when explicitly false', () => {
        applyPerformanceOptions({ controller, logger, options: { blockResources: false, turboMode: false } });
        expect(controller.enableResourceBlocking).not.toHaveBeenCalled();
        expect(controller.enableTurboCSS).not.toHaveBeenCalled();
    });
});

describe('checkBattleCaptcha', () => {
    function makeBot({ popup, header }) {
        return {
            profileId: 'p1',
            logger: { error: jest.fn(), debug: jest.fn() },
            pause: jest.fn(),
            controller: {
                elementExists: jest.fn().mockResolvedValue(popup),
                getText: jest.fn().mockResolvedValue(header),
            },
        };
    }

    test('detects the Access Verification captcha and pauses', async () => {
        const bot = makeBot({ popup: true, header: 'Access Verification required' });
        const result = await checkBattleCaptcha(bot);
        expect(result).toBe(true);
        expect(bot.pause).toHaveBeenCalledTimes(1);
    });

    test('returns false when no popup present', async () => {
        const bot = makeBot({ popup: false, header: '' });
        expect(await checkBattleCaptcha(bot)).toBe(false);
        expect(bot.pause).not.toHaveBeenCalled();
    });

    test('returns false for an unrelated popup header', async () => {
        const bot = makeBot({ popup: true, header: 'Some other dialog' });
        expect(await checkBattleCaptcha(bot)).toBe(false);
        expect(bot.pause).not.toHaveBeenCalled();
    });
});
