import { describe, expect, it } from 'vitest';

import { readSocketClockSample } from '@shared-web/browser/connection/server-clock/read-socket-clock-sample.ts';
import { replyToSocketClockRequest } from '@shared/websocket/socket-clock.ts';

class ClockSocket extends EventTarget {
    readonly readyState = 1;
    request = '';

    send(text: string): void {
        this.request = text;
    }

    reply(request: string, peerId: string): void {
        const data = replyToSocketClockRequest(request, peerId, () => 10_000);
        this.dispatchEvent(new MessageEvent('message', { data }));
    }
}

describe('connection-local server clock sample', () => {
    it('bounds the full round trip and ignores an unrelated response from the same server', async () => {
        const socket = new ClockSocket();
        let now = 20;
        const pending = readSocketClockSample({
            readSocket: () => socket, expectedServerPeerId: 'node', nowMonotonicMs: () => now,
            signal: AbortSignal.timeout(1_000)
        });
        socket.reply('rallar.clock.request.v1 ' + crypto.randomUUID(), 'node');
        await Promise.resolve();
        now = 57;
        socket.reply(socket.request, 'node');
        expect((await pending).right).toEqual({
            remoteEpochMs: 10_000, requestStartedAtMonotonicMs: 20, responseReceivedAtMonotonicMs: 57
        });
    });

    it.each(['wrong peer', 'replacement', 'cancellation', 'closed'] as const)('rejects %s during renewal', async failure => {
        const original = new ClockSocket();
        let current = original;
        const lifetime = new AbortController();
        const pending = readSocketClockSample({
            readSocket: () => current, expectedServerPeerId: 'server', nowMonotonicMs: () => 0, signal: lifetime.signal
        });
        if (failure === 'replacement') current = new ClockSocket();
        if (failure === 'cancellation') lifetime.abort();
        if (failure === 'closed') original.dispatchEvent(new Event('close'));
        original.reply(original.request, failure === 'wrong peer' ? 'different-node' : 'server');
        expect((await pending).right).toBeUndefined();
    });
});
