import { expect, it } from 'vitest';

import { createRuntime, RelicRuntimeBackend, relicSnapshot } from './relic-runtime-backend.ts';

it.each(['logout', 'auth-loss', 'stop'])('cancels pending expedition initialization on %s', async (departure) => {
    const backend = new RelicRuntimeBackend();
    const pending = Promise.withResolvers<AbortSignal | undefined>();
    const release = Promise.withResolvers<ReturnType<typeof relicSnapshot>>();
    backend.fetchSnapshot = async () => undefined;
    backend.initializeGame = async (_roomId: string, signal?: AbortSignal) => {
        pending.resolve(signal);
        return await release.promise;
    };
    const runtime = createRuntime(backend);
    const starting = runtime.start();
    try {
        const signal = await pending.promise;
        expect(signal?.aborted).toBe(false);
        if (departure === 'logout') {
            await runtime.getState().logout();
        }
        else if (departure === 'auth-loss') {
            backend.signOut();
        }
        else {
            runtime.stop();
        }
        expect(signal?.aborted).toBe(true);
        release.resolve(relicSnapshot('room-1', 20));
        await starting;
        expect(runtime.getState().snapshot).toBeUndefined();
    }
    finally {
        release.resolve(relicSnapshot('room-1', 20));
        await starting;
    }
});
