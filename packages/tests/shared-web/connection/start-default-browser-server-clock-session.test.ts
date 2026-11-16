import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { startDefaultBrowserServerClockSession } from '@shared-web/browser/connection/start-default-browser-server-clock-session.ts';

describe('default browser clock acquisition', () => {
    it('preserves the caller abort reason while a time request ignores cancellation', async () => {
        const entered = Promise.withResolvers<void>();
        const response = Promise.withResolvers<Response>();
        vi.stubGlobal('fetch', () => {
            entered.resolve();
            return response.promise;
        });
        const controller = new AbortController();
        const reason = new Error('User left the lobby');
        const pending = startDefaultBrowserServerClockSession({
            baseUrl: 'https://test',
            serverPeerId: 'server',
            signal: controller.signal
        });
        const rejection = expect(pending).rejects.toBe(reason);
        onTestFinished(() => {
            response.resolve(Response.json({ serverPeerId: 'server', serverNowEpochMs: Date.now() }));
            vi.unstubAllGlobals();
        });
        await entered.promise;
        controller.abort(reason);
        await rejection;
    });
});
