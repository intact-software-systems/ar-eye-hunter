import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from '../outbound-test-payload.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it('default outbound disposal joins an owned engine readiness read with no batch running', async () => {
    vi.useFakeTimers();
    const stores = createDefaultOutboundTestStores();
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
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

it('releases an outbound claim after authority time ends during its transport attempt', async () => {
    vi.useFakeTimers();
    const epochMs = Date.now();
    let calibrated = true;
    const nowMs = (): number => {
        if (!calibrated) {
            throw new Error('Authority clock expired');
        }
        return epochMs;
    };
    const volatileStores = createVolatileALOutboundRuntimeStores({
        nowMs,
        workNowMs: () => epochMs,
        decodePrepared: decodeOutboundTestPayload,
        namespace: 'retiring-outbound'
    }, undefined);
    const queue = volatileStores.workQueue;
    if (!(queue instanceof InMemoryQueueBox)) {
        throw new Error('Volatile work must use its memory queue');
    }
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let attempts = 0;
    const settlements: ALDeliverySettlement[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        nowMs,
        workNowMs: () => epochMs,
        volatileStores,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ resourceId: msg.route.resourceId }]
        }),
        sendPreparedMessage: async () => {
            attempts += 1;
            entered.resolve();
            await release.promise;
            return { status: 'sent', submissionAttempted: true };
        }
    });
    onTestFinished(() => {
        release.resolve();
    });
    const admission = await runtime.enqueueIfAbsent(createOutboundMessage('retiring'));
    expect(admission.verdict.kind).toBe('admitted');
    await entered.promise;
    const reservedKeys = queue.peekKeys().filter((key) => queue.peek(key)?.status === 'RESERVED');
    expect(reservedKeys).toHaveLength(1);

    calibrated = false;
    const disposal = runtime.dispose();
    release.resolve();
    await disposal;
    const rows = reservedKeys.map((key) => queue.peek(key));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).not.toBe('RESERVED');
    expect(attempts).toBe(1);
    expect(settlements).toContainEqual(expect.objectContaining({ kind: 'attempt-settled', atMs: epochMs }));
    expect((await runtime.enqueueIfAbsent(createOutboundMessage('after-retirement'))).verdict)
        .toMatchObject({ kind: 'skipped', reason: 'disposed' });
});
