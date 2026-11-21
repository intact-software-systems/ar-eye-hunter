import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { startDefaultBrowserServerClockSession } from '@shared-web/browser/connection/server-clock/start-default-browser-server-clock-session.ts';
import { replyToSocketClockRequest } from '@shared/websocket/socket-clock.ts';

class ClockSocket extends EventTarget {
    readonly readyState: WebSocket['readyState'];
    readonly requests: string[] = [];

    constructor(readyState: WebSocket['readyState']) {
        super();
        this.readyState = readyState;
    }

    send(text: string): void {
        this.requests.push(text);
        const data = replyToSocketClockRequest(text, 'server', () => Date.now());
        this.dispatchEvent(new MessageEvent('message', { data }));
    }
}

function stubTimeEndpoint(): { readonly reads: () => number; } {
    let reads = 0;
    vi.stubGlobal('fetch', async () => {
        reads += 1;
        return Response.json({ serverPeerId: 'server', serverNowEpochMs: Date.now() });
    });
    return { reads: () => reads };
}

function useFakeClock(): void {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    onTestFinished(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });
}

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
            readSocket: () => undefined,
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

describe('default browser clock renewal', () => {
    // A tab whose socket another tab of the same session replaced must keep its clock over HTTP.
    it.each([
        ['no socket', undefined],
        ['a closed socket', new ClockSocket(3)]
    ])('renews over HTTP past the clock age when the connection has %s', async (_name, socket) => {
        useFakeClock();
        const endpoint = stubTimeEndpoint();
        const session = await startDefaultBrowserServerClockSession({
            baseUrl: 'https://test',
            readSocket: () => socket,
            serverPeerId: 'server',
            signal: undefined
        });
        onTestFinished(() => session.close());

        await vi.advanceTimersByTimeAsync(35_000);

        expect(endpoint.reads()).toBeGreaterThan(1);
        expect(socket?.requests ?? []).toEqual([]);
        expect(session.readWindow().right).toBeDefined();
        expect(session.signal.aborted).toBe(false);
    });

    it('renews over the open socket without reading the HTTP time endpoint', async () => {
        useFakeClock();
        const endpoint = stubTimeEndpoint();
        const socket = new ClockSocket(1);
        const session = await startDefaultBrowserServerClockSession({
            baseUrl: 'https://test',
            readSocket: () => socket,
            serverPeerId: 'server',
            signal: undefined
        });
        onTestFinished(() => session.close());
        expect(endpoint.reads()).toBe(1);

        await vi.advanceTimersByTimeAsync(35_000);

        expect(socket.requests).toHaveLength(1);
        expect(endpoint.reads()).toBe(1);
        expect(session.readWindow().right).toBeDefined();
    });
});
