import { afterEach, expect, it, vi } from 'vitest';
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores
} from '../outbound-runtime-test-fixture.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it('default outbound disposal joins an owned engine readiness read with no batch running', async () => {
    vi.useFakeTimers();
    const stores = createDefaultOutboundTestStores();
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [], admittedConnectionGenerationIds: undefined }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    await runtime.ready();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readPages = stores.workQueue.readWorkPages.bind(stores.workQueue);
    let readFinished = false;
    vi.spyOn(stores.workQueue, 'readWorkPages').mockImplementation(async (queries) => {
        entered.resolve();
        await release.promise;
        const pages = await readPages(queries);
        readFinished = true;
        return pages;
    });
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    let disposed = false;
    const disposal = runtime.dispose().then(() => {
        disposed = true;
    });
    try {
        // Flush callbacks; the real storage-read gate, rather than elapsed time, owns completion.
        await vi.advanceTimersByTimeAsync(0);
        expect(readFinished).toBe(false);
        expect(disposed, 'Default owner disposal completed before its scheduled storage read').toBe(false);
    }
    finally {
        release.resolve();
        await disposal;
    }
    expect(readFinished).toBe(true);
    expect(disposed).toBe(true);
});
