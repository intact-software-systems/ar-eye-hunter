import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ExpectedConnectionHolds } from '@shared/websocket/expected-connection-holds.ts';
import { HeldSendChain } from '@shared/websocket/held-send-chain.ts';

const EXPIRES_AT_MS = 60_000;

function createHolds(...awaited: readonly string[]): ExpectedConnectionHolds {
    const holds = new ExpectedConnectionHolds({ isOpen: () => false, nowEpochMs: () => 1_000 });
    for (const id of awaited) {
        holds.expect({ id, generationId: 'generation', expiresAtEpochMs: EXPIRES_AT_MS });
    }
    return holds;
}

/** Holds one send per deferred for `id`; each send records its start and settles with its deferred. */
function holdSends(
    chain: HeldSendChain,
    holds: ExpectedConnectionHolds,
    input: { readonly id: string; readonly deferreds: readonly PromiseWithResolvers<void>[]; readonly started: string[]; }
): void {
    input.deferreds.forEach((deferred, index) => {
        chain.holdForAudience(holds, [input.id], {
            expiresAtEpochMs: EXPIRES_AT_MS,
            send: async (sessionId) => {
                input.started.push(`${sessionId}:${index}`);
                await deferred.promise;
            }
        });
    });
}

describe('HeldSendChain', () => {
    it('runs one session\'s held sends in hold order', async () => {
        const chain = new HeldSendChain();
        const holds = createHolds('a');
        const deferreds = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const started: string[] = [];
        holdSends(chain, holds, { id: 'a', deferreds, started });

        holds.open({ id: 'a', generationId: 'generation' });

        await vi.waitFor(() => expect(started).toEqual(['a:0']));
        deferreds[0]!.resolve();
        await vi.waitFor(() => expect(started).toEqual(['a:0', 'a:1']));
        deferreds[1]!.resolve();
        await vi.waitFor(() => expect(started).toEqual(['a:0', 'a:1', 'a:2']));
    });

    it('logs a failed send and runs the next', async () => {
        const loggedErrors: (readonly [string, Error])[] = [];
        const consoleError = vi.spyOn(console, 'error').mockImplementation((message: string, error: Error) => {
            loggedErrors.push([message, error]);
        });
        onTestFinished(() => consoleError.mockRestore());
        const chain = new HeldSendChain();
        const holds = createHolds('a');
        const deferreds = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
        const started: string[] = [];
        holdSends(chain, holds, { id: 'a', deferreds, started });
        const failure = new Error('held send failed');

        holds.open({ id: 'a', generationId: 'generation' });
        deferreds[0]!.reject(failure);

        await vi.waitFor(() => expect(started).toEqual(['a:0', 'a:1']));
        expect(loggedErrors).toEqual([['Held WebSocket send failed:', failure]]);
    });

    it('keeps two sessions\' sends independent', async () => {
        const chain = new HeldSendChain();
        const holds = createHolds('a', 'b');
        const started: string[] = [];
        holdSends(chain, holds, { id: 'a', deferreds: [Promise.withResolvers<void>()], started });
        holdSends(chain, holds, { id: 'b', deferreds: [Promise.withResolvers<void>()], started });

        holds.open({ id: 'a', generationId: 'generation' });
        await vi.waitFor(() => expect(started).toEqual(['a:0']));
        holds.open({ id: 'b', generationId: 'generation' });

        await vi.waitFor(() => expect(started).toEqual(['a:0', 'b:0']));
    });

    it('returns the holds\' counts', () => {
        const chain = new HeldSendChain();
        const holds = createHolds('awaited');

        const hold = chain.holdForAudience(holds, ['awaited', 'open'], {
            expiresAtEpochMs: EXPIRES_AT_MS,
            send: async () => undefined
        });

        expect(hold).toEqual({ heldCount: 1, evictedCount: 0 });
    });
});
