import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import notifier from '../src/utils/notifier.js';
import config from '../src/utils/config.js';

// Mock config
jest.spyOn(config, 'get').mockImplementation((key) => {
    if (key === 'notifications.discord_webhook') return 'https://discord.com/api/webhooks/mock';
    return null;
});

describe('Notifier Discord Cleanup Verification', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Manually reload settings because it's a singleton
        notifier.loadSettings();
        
        // Mock global fetch
        global.fetch = jest.fn(() =>
            Promise.resolve({
                ok: true,
                text: () => Promise.resolve('ok'),
            })
        );
    });

    test('notifyCaptcha should still send Discord message', async () => {
        await notifier.notifyCaptcha('p1');
        
        expect(global.fetch).toHaveBeenCalledWith(
            'https://discord.com/api/webhooks/mock',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('CAPTCHA DETECTED')
            })
        );
    });

    test('notifyError should still send Discord message', async () => {
        await notifier.notifyError('p1', 'Test Error');
        
        expect(global.fetch).toHaveBeenCalledWith(
            'https://discord.com/api/webhooks/mock',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('Error Detected')
            })
        );
    });

    test('notifySessionComplete should be removed (should not exist)', () => {
        expect(notifier.notifySessionComplete).toBeUndefined();
    });

    test('notifySessionStart should be removed (should not exist)', () => {
        expect(notifier.notifySessionStart).toBeUndefined();
    });
});
