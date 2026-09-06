import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRallarRemoteBrowserRtcProvider } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';

function emptySnapshot(): Response {
    return Response.json({ runId: 'observation-run', results: [], events: [] });
}

function waitInteraction() {
    return {
        request: { connection: 'alice', timeoutMs: 10 },
        response: { message: { topic: 'expected' } }
    };
}

describe('remote-browser observation lifecycle', () => {
    afterEach(() => vi.useRealTimers());

    it('surfaces a polling failure through the owning wait', async () => {
        vi.useFakeTimers();
        let initial = true;
        const provider = createRallarRemoteBrowserRtcProvider({
            pollIntervalMs: 5,
            fetch: async () => {
                if (initial) {
                    initial = false;
                    return emptySnapshot();
                }
                throw new Error('Control polling disconnected');
            }
        });

        const waiting = provider.wait(waitInteraction(), { interaction: { request: {} } }, { rtcMessages: {} });
        const outcome = waiting.then((result) => ({ result }), (error) => ({ error }));
        await vi.advanceTimersByTimeAsync(100);
        expect(await outcome).toEqual({ error: new Error('Control polling disconnected') });
    });

    it('finishes in-flight observation work before returning from the wait', async () => {
        vi.useFakeTimers();
        const pendingRead = Promise.withResolvers<Response>();
        let initial = true;
        const provider = createRallarRemoteBrowserRtcProvider({
            pollIntervalMs: 5,
            fetch: async () => {
                if (initial) {
                    initial = false;
                    return emptySnapshot();
                }
                return pendingRead.promise;
            }
        });
        let settled = false;
        const waiting = provider.wait(waitInteraction(), { interaction: { request: {} } }, { rtcMessages: {} })
            .finally(() => {
                settled = true;
            });

        try {
            await vi.advanceTimersByTimeAsync(100);
            expect(settled).toBe(false);
        }
        finally {
            pendingRead.resolve(emptySnapshot());
            await waiting;
        }
        expect(settled).toBe(true);
    });
});
