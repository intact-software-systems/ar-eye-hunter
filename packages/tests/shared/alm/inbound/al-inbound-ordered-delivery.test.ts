import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALInboundDeliveryCompletion } from '@shared/alm/inbound/admission/al-inbound-delivery-progress.ts';
import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestOrderedDelivery,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    readInboundTestAdmission,
    readInboundTestWorkRows,
    runInboundWorkDueNow
} from '../inbound-runtime-test-fixture.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

// A completion runs after the application was handed the message, so a lost write is read and decided again; only
// when every bounded attempt loses does the work go back, to be dispatched again as after a crash.
it('hands the work back when every attempt of its completion conflicts', async () => {
    const { admissionStore } = createInboundTestStores({
        namespace: 'inbound-ordered-delivery',
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const message = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
    const trackKey = toALOrderingTrackKey(message)!;
    expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, message))).toBe('committed');
    // The wrapper's own list is the only record of a write that lost: a lost write leaves no stored trace.
    const attempted: ALInboundDeliveryCompletion[] = [];
    vi.spyOn(admissionStore, 'commitDeliveryCompletion').mockImplementation(async (completion) => {
        attempted.push(completion);
        return 'conflict';
    });

    expect(await createInboundTestOrderedDelivery(admissionStore).complete(message)).toBe('retry');

    expect(attempted.map((completion) => completion.completesThrough)).toEqual([1, 1, 1]);
    expect((await admissionStore.readOrderedDelivery(trackKey, 2)).completedThrough).toBe(0);
    expect(await admissionStore.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() })).toBeDefined();
});

// A copy records its carrier on the slot only while its sequence is held behind a gap, and the release answers that
// pair `delivered`; a copy that arrives on another carrier while a delivered message's completion is in flight finds
// the sequence no longer held, so it cannot move the slot the completion guards on, and it is answered `delivered` on
// its own carrier, as the pair would have been.
it('hands an ordered message to the application once when a copy on another carrier arrives during its completion', async () => {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: 'inbound-ordered-delivery-copy',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: 'inbound-ordered-delivery-copy'
    });
    const { admissionStore } = fixture.stores;
    const message = createInboundTestMessage({ msgId: 'message-1', seq: 1, acknowledged: true });
    const trackKey = toALOrderingTrackKey(message)!;
    const completionRead = Promise.withResolvers<void>();
    const releaseCompletion = Promise.withResolvers<void>();
    const readBufferedRelease = admissionStore.readBufferedRelease.bind(admissionStore);
    vi.spyOn(admissionStore, 'readBufferedRelease').mockImplementationOnce(async (input) => {
        const read = await readBufferedRelease(input);
        completionRead.resolve();
        await releaseCompletion.promise;
        return read;
    });
    onTestFinished(() => releaseCompletion.resolve());
    expect((await fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right?.kind).toBe('admitted');
    const draining = runInboundWorkDueNow(fixture);
    await completionRead.promise;
    const read = await readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() });

    const copy = await fixture.runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });
    expect(copy.right?.kind).toBe('duplicate');
    expect((await readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() }))?.snapshot).toEqual(read?.snapshot);
    releaseCompletion.resolve();
    await draining;
    await runInboundWorkDueNow(fixture);

    expect(fixture.deliveredMessages.map((delivered) => delivered.id.msgId)).toEqual(['message-1']);
    expect((await admissionStore.readOrderedDelivery(trackKey, 2)).completedThrough).toBe(1);
    expect(await readStoredAcks(fixture.stores)).toEqual([
        { carrier: 'ws', toPeerId: INBOUND_TEST_SENDER_PEER_ID, status: 'delivered' },
        { carrier: 'rtc', toPeerId: INBOUND_TEST_SENDER_PEER_ID, status: 'delivered' }
    ]);
});

/** Each ACK the store holds a `send-control` row for: its carrier, recipient and status. */
async function readStoredAcks(stores: ALInboundRuntimeStores) {
    return (await readInboundTestWorkRows(stores)).flatMap((row) => {
        const parsed = row.payload.kind === 'send-control' ? parseALControlMessage(row.payload.msg) : undefined;
        return parsed?.type === 'ack'
            ? [{ carrier: row.carrier, toPeerId: parsed.payload.toPeerId, status: parsed.payload.status }]
            : [];
    });
}
