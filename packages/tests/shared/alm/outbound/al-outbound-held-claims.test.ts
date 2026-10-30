import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { afterEach, expect, it, vi } from 'vitest';
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    holdOutboundClaims,
    runOutboundWorkTask
} from '../outbound-runtime-test-fixture.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it('held reservations stay denied until the active owner and its owed follow-up finish', async () => {
    vi.useFakeTimers();
    const stores = createDefaultOutboundTestStores();
    const sent: string[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        queueEngine: new InboxOutboxEngine(),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'durable',
            preparedMessages: [{ message: msg.id.msgId }],
            admittedConnectionGenerationIds: undefined
        }),
        sendPreparedMessage: async (prepared) => {
            sent.push(prepared.message ?? 'missing');
            return { status: 'sent', submissionAttempted: true };
        }
    });
    await runtime.ready();
    const held = holdOutboundClaims(stores);
    const firstEntered = Promise.withResolvers<void>();
    const firstAllowed = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const secondAllowed = Promise.withResolvers<void>();
    vi.mocked(stores.workQueue.reserveEntries)
        .mockImplementationOnce(async () => {
            firstEntered.resolve();
            await firstAllowed.promise;
            return new Map();
        })
        .mockImplementationOnce(async () => {
            secondEntered.resolve();
            await secondAllowed.promise;
            return new Map();
        });
    const first = createOutboundMessage('first-held');
    const second = createOutboundMessage('owed-held');
    expect((await runtime.enqueueIfAbsent(first)).verdict.kind).toBe('admitted');
    await firstEntered.promise;
    expect((await runtime.enqueueIfAbsent(second)).verdict.kind).toBe('admitted');
    let restored = false;
    const restoring = held.release(runtime).then(() => {
        restored = true;
    });
    try {
        await vi.advanceTimersByTimeAsync(1);
        expect(restored, 'Reservations restored while the owning batch was blocked').toBe(false);
        firstAllowed.resolve();
        await secondEntered.promise;
        await vi.advanceTimersByTimeAsync(1);
        expect(restored, 'Reservations restored while an owed follow-up batch was blocked').toBe(false);
        expect(sent).toEqual([]);
        secondAllowed.resolve();
        await restoring;
        await runOutboundWorkTask(runtime);
        expect(sent).toEqual([first.id.msgId, second.id.msgId]);
    }
    finally {
        const disposing = runtime.dispose();
        firstAllowed.resolve();
        secondAllowed.resolve();
        await Promise.all([disposing, restoring]);
    }
});
