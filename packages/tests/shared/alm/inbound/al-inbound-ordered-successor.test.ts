import '../../../setup-browser-indexeddb.ts';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALPeerControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALInboundLocalDeliveryEffectId, toALInboundReleaseEffectId } from '@shared/alm/inbound/al-inbound-effect-intent.ts';
import { AL_INBOUND_COMPLETED_OFF_TRACK } from '@shared/alm/inbound/al-inbound-ordered-delivery.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { AL_INBOUND_HAND_ON_BATCH_AGE_MS, toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { toALInboundSuccessionResult } from '@shared/alm/inbound/lane/claim-al-inbound-ordered-successor.ts';
import { AL_INBOUND_WORK_PAGE_SIZE } from '@shared/alm/inbound/read-al-inbound-work-selection.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus, toKeyAsString } from '@shared/queuebox/ResourceEntry.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    readInboundTestAdmission,
    readInboundTestWorkRows,
    runInboundWorkDueNow,
    type InboundTestRuntime
} from '../inbound-runtime-test-fixture.ts';

type EffectDrain = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'effect-drain'; }>;
type InboundTestStorage = 'memory' | 'indexeddb';

const TRACK_KEY = toALOrderingTrackKey(createInboundTestMessage({ msgId: 'track', seq: 1 }))!;

describe('the batch that completed an ordered delivery', () => {
    // Pins the hand-on itself: the successor admitted while its predecessor's delivery was held runs in the batch that
    // completed the predecessor, once, without waiting for a later rotation.
    it.each(['memory', 'indexeddb'] as const)(
        'runs the waiting successor of a held completion in the same batch (%s)',
        async (storage) => {
            const hold = createDispatchHold(1);
            const fixture = createRuntime(`successor-held-${storage}`, storage, { gateDispatch: hold.gate });
            const [first, second] = [toMessage(1), toMessage(2)];
            await admit(fixture, first);
            await hold.entered;
            await admit(fixture, second);
            // Message 2 is not claimed while message 1's delivery is held: its row is untouched when the hold goes.
            expect(await readWorkRow(fixture, toDispatchId(second))).toMatchObject({
                status: EntityStatus.NEW,
                dequeueAudit: { attempts: 0 }
            });

            hold.release();
            await runInboundWorkDueNow(fixture);

            expect(readReceivedSeqs(fixture)).toEqual([1, 2]);
            const drains = readClaimingDrains(fixture);
            expect(drains.map((drain) => drain.claimedEffectIds)).toEqual([[toDispatchId(first), toDispatchId(second)]]);
            expect(drains[0]).toMatchObject({ claimedCount: 2, promoted: 1 });
            for (const msg of [first, second]) {
                expect(await readWorkRow(fixture, toDispatchId(msg))).toMatchObject({
                    status: EntityStatus.COMPLETED,
                    dequeueAudit: { attempts: 1 }
                });
            }
            expect(await readWorkStatuses(fixture)).not.toContain(EntityStatus.RETRY);
        }
    );

    // Pins the page bound: a held predecessor with 63 successors waiting drains in batches of at most a page, and every
    // batch hands on all but the delivery its page claimed.
    it('drains a 64-message in-order backlog in batches of at most a page', async () => {
        const hold = createDispatchHold(1);
        const fixture = createRuntime('successor-page-bound', 'memory', { gateDispatch: hold.gate });
        await admit(fixture, toMessage(1));
        await hold.entered;
        for (let seq = 2; seq <= 64; seq += 1) {
            await admit(fixture, toMessage(seq));
        }

        hold.release();
        await runInboundWorkDueNow(fixture);

        expect(readReceivedSeqs(fixture)).toEqual(toSequence(1, 64));
        const drains = readClaimingDrains(fixture);
        expect(drains.every((drain) => drain.claimedCount <= AL_INBOUND_WORK_PAGE_SIZE)).toBe(true);
        expect(drains.reduce((sum, drain) => sum + drain.promoted, 0)).toBe(64 - drains.length);
        expect(drains.map((drain) => drain.claimedCount)).toEqual([16, 16, 16, 16]);
        expect(drains.map((drain) => drain.promoted)).toEqual([15, 15, 15, 15]);
    });

    // Pins the run order of a batch that holds several claims and hands on: every hand-on runs after the claims the
    // batch already held, in the order their predecessors completed, so a busy track does not push other tracks' and
    // unordered deliveries back behind its own.
    it('runs handed-on deliveries after the claims its batch had already picked up', async () => {
        let canDispatch = false;
        const fixture = createRuntime('successor-after-batch', 'memory', { canDispatchMessage: () => canDispatch });
        const [a1, a2, a3] = [toTrackMessage('a', 1), toTrackMessage('a', 2), toTrackMessage('a', 3)];
        const [b1, b2] = [toTrackMessage('b', 1), toTrackMessage('b', 2)];
        const unordered = createInboundTestMessage({ msgId: 'unordered' });
        for (const msg of [a1, a2, a3, b1, b2, unordered]) {
            await admit(fixture, msg);
        }

        canDispatch = true;
        await runInboundWorkDueNow(fixture);

        const drains = readClaimingDrains(fixture);
        expect(drains.map((drain) => drain.claimedEffectIds)).toEqual([
            [a1, b1, unordered, a2, b2, a3].map(toDispatchId)
        ]);
        expect(drains[0]!.promoted).toBe(3);
        expect(fixture.deliveredMessages.map((msg) => msg.id.msgId)).toEqual(['a-1', 'b-1', 'unordered', 'a-2', 'b-2', 'a-3']);
    });

    // Pins that a completion with nothing admitted after it hands nothing on, and that a later admission's own commit
    // delivers it: the engine is never run here, so only each commit's own batch can deliver.
    it('hands nothing on when the next message is not admitted yet', async () => {
        const fixture = createRuntime('successor-not-admitted', 'memory', {});
        await admit(fixture, toMessage(1));
        await vi.waitFor(() => expect(readClaimingDrains(fixture)).toHaveLength(1));
        const [firstDrain] = readClaimingDrains(fixture);
        expect(firstDrain).toMatchObject({ claimedCount: 1, promoted: 0 });

        await admit(fixture, toMessage(2));
        await vi.waitFor(() => expect(readClaimingDrains(fixture)).toHaveLength(2));

        expect(readReceivedSeqs(fixture)).toEqual([1, 2]);
        expect(readClaimingDrains(fixture).map((drain) => [drain.claimedCount, drain.promoted])).toEqual([[1, 0], [1, 0]]);
    });

    // Pins the release promotion (D190) as one case of the rule: the dispatch that closed a gap hands on the first
    // release, which hands on the next.
    it('hands on a buffered release like any other successor', async () => {
        const fixture = createRuntime('successor-release', 'memory', {});
        await admit(fixture, toMessage(2));
        await admit(fixture, toMessage(3));
        await runInboundWorkDueNow(fixture);
        const before = fixture.diagnostics.length;

        const first = toMessage(1);
        await admit(fixture, first);
        await runInboundWorkDueNow(fixture);

        expect(readReceivedSeqs(fixture)).toEqual([1, 2, 3]);
        const drains = readClaimingDrains(fixture, before);
        expect(drains.map((drain) => drain.claimedEffectIds)).toEqual([[
            toDispatchId(first),
            toALInboundReleaseEffectId(TRACK_KEY, 2),
            toALInboundReleaseEffectId(TRACK_KEY, 3)
        ]]);
        expect(drains[0]!.promoted).toBe(2);
    });

    // Pins that an expired successor is not handed on, and that the copy after it is still answered by the rotation as
    // it is without a hand-on. Here the queue no longer returns the expired row, so the hand-on finds none to reserve; the
    // claim's own expiry check is pinned at the selector. A hand-on cannot skip to message 3 either: its readiness waits
    // on message 2.
    it('hands on no expired successor, and the copy after it is answered resync-required', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const admittedAtMs = Date.now();
        const hold = createDispatchHold(1);
        const fixture = createRuntime('successor-expired', 'memory', { gateDispatch: hold.gate });
        const [first, third] = [toMessage(1), toMessage(3)];
        const second = withExpiry(toMessage(2), admittedAtMs + 5_000);
        await admit(fixture, first);
        await hold.entered;
        await admit(fixture, second);
        await admit(fixture, third);

        // Message 2's row expires before the hold goes.
        const expiring = await readWorkRow(fixture, toDispatchId(second));
        expect(expiring?.audit.expiryTs.epochMilliseconds).toBeLessThanOrEqual(admittedAtMs + 6_000);
        vi.setSystemTime(admittedAtMs + 6_000);
        hold.release();
        await runInboundWorkDueNow(fixture);

        expect(readReceivedSeqs(fixture)).toEqual([1]);
        const drain = readClaimingDrains(fixture).find((event) => event.claimedEffectIds.includes(toDispatchId(first)))!;
        expect(drain.claimedEffectIds).not.toContain(toDispatchId(second));
        expect(drain.promoted).toBe(0);
        expect(readNackReasons(fixture, third.id.msgId)).toEqual(['resync-required']);
    });
});

describe('a batch that hands on', () => {
    // Pins the batch age bound: a completion once the batch has run half its lease hands nothing on, so the rows the
    // batch completed early are released before their lease ends; the deliveries it did not hand on stay untouched
    // until the next batch delivers them, in order.
    it('hands nothing on once it has run half its lease, and the next batch delivers the rest', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        let canDispatch = false;
        const [first, second, third] = [toMessage(1), toMessage(2), toMessage(3)];
        const fixture = createRuntime('successor-batch-age', 'memory', {
            canDispatchMessage: () => canDispatch,
            // The batch passes half its lease while it delivers message 2, after message 1 handed message 2 on.
            gateDispatch: async (msg) => {
                if (msg.ordering?.seq === 2) {
                    vi.setSystemTime(Date.now() + AL_INBOUND_HAND_ON_BATCH_AGE_MS + 1);
                }
            }
        });
        for (const msg of [first, second, third]) {
            await admit(fixture, msg);
        }
        const flush = holdReleaseFlushOf(fixture, toDispatchId(first));

        canDispatch = true;
        const draining = runInboundWorkDueNow(fixture);
        await flush.entered;
        // The first batch's releases are being written: message 3 was neither claimed nor tried by it.
        expect(await readWorkRow(fixture, toDispatchId(third))).toMatchObject({
            status: EntityStatus.NEW,
            dequeueAudit: { attempts: 0 }
        });
        flush.release();
        await draining;

        expect(readReceivedSeqs(fixture)).toEqual([1, 2, 3]);
        const drains = readClaimingDrains(fixture);
        expect(drains.map((drain) => drain.claimedEffectIds)).toEqual([
            [toDispatchId(first), toDispatchId(second)],
            [toDispatchId(third)]
        ]);
        expect(drains.map((drain) => [drain.claimedCount, drain.promoted])).toEqual([[2, 1], [1, 0]]);
    });

    // Pins the page bound on the inbound lane: a selection that already holds a page hands nothing on, and the
    // successor's row stays as it was until a later batch claims it.
    it('hands nothing on from a selection that already holds a page', async () => {
        const hold = createMessageHold('prime');
        const fixture = createRuntime('successor-full-page', 'memory', { gateDispatch: hold.gate });
        const [first, second] = [toMessage(1), toMessage(2)];
        // Their work rows come before the track's in queue order, so the page is these and message 1, and message 2's
        // row is the first one past it.
        const unordered = toSequence(1, AL_INBOUND_WORK_PAGE_SIZE - 1)
            .map((index) => createInboundTestMessage({ msgId: `a-${String(index).padStart(2, '0')}` }));
        await admit(fixture, createInboundTestMessage({ msgId: 'prime' }));
        await hold.entered;
        // Admitted behind the held batch, so the batch its commits owe reads them from the head of NEW together.
        for (const msg of [first, ...unordered, second]) {
            await admit(fixture, msg);
        }
        const flush = holdReleaseFlushOf(fixture, toDispatchId(first));

        hold.release();
        const draining = runInboundWorkDueNow(fixture);
        await flush.entered;
        // The full page's releases are being written: message 2 was neither claimed nor tried by its batch.
        expect(await readWorkRow(fixture, toDispatchId(second))).toMatchObject({
            status: EntityStatus.NEW,
            dequeueAudit: { attempts: 0 }
        });
        flush.release();
        await draining;

        const drains = readClaimingDrains(fixture);
        expect(drains.map((drain) => drain.claimedEffectIds)).toEqual([
            [toDispatchId(createInboundTestMessage({ msgId: 'prime' }))],
            [...unordered, first].map(toDispatchId),
            [toDispatchId(second)]
        ]);
        expect(drains.map((drain) => drain.promoted)).toEqual([0, 0, 0]);
        expect(readReceivedSeqs(fixture).filter((seq) => seq !== undefined)).toEqual([1, 2]);
    });

    // Pins that a control send the batch already holds runs before the delivery its batch hands on: on this durable
    // lane the control send runs after the page's deliveries, and the hand-on still waits behind it.
    it('runs a control send its selection holds before a handed-on delivery', async () => {
        const hold = createMessageHold('prime');
        const fixture = createRuntime('successor-after-control', 'memory', { gateDispatch: hold.gate });
        const first = createInboundTestMessage({ msgId: 'm-1', seq: 1, acknowledged: true });
        const second = toMessage(2);
        await admit(fixture, createInboundTestMessage({ msgId: 'prime' }));
        await hold.entered;
        await admit(fixture, first);
        await admit(fixture, second);

        hold.release();
        await runInboundWorkDueNow(fixture);

        const controlSendIds = (await readInboundTestWorkRows(fixture.stores))
            .flatMap((row) => row.payload.kind === 'send-control' ? [row.effectId] : []);
        expect(controlSendIds).toHaveLength(1);
        const drains = readClaimingDrains(fixture);
        expect(drains.map((drain) => drain.claimedEffectIds)).toEqual([
            [toDispatchId(createInboundTestMessage({ msgId: 'prime' }))],
            [toDispatchId(first), controlSendIds[0], toDispatchId(second)]
        ]);
        expect(drains.map((drain) => drain.promoted)).toEqual([0, 1]);
        expect(readReceivedSeqs(fixture).filter((seq) => seq !== undefined)).toEqual([1, 2]);
    });
});

describe('ALInboundAdmissionStore.readOrderedSuccessor', () => {
    // Pins the one read the hand-on rests on: the delivery row and carrier the track's slot after a position names.
    it.each(['memory', 'indexeddb'] as const)('names the delivery row of the slot after a position (%s)', async (storage) => {
        const { admissionStore } = createInboundTestStores({
            namespace: `successor-read-${storage}`,
            storage,
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const commit = async (msg: ALMessage) =>
            expect(await admissionStore.commitBundle(await readInboundTestAdmission(admissionStore, msg))).toBe('committed');
        const first = toMessage(1);

        expect(await admissionStore.readOrderedSuccessor(TRACK_KEY, 0)).toBeUndefined();
        await commit(first);
        expect(await admissionStore.readOrderedSuccessor(TRACK_KEY, 0)).toEqual({
            effectId: toDispatchId(first),
            carrier: 'ws'
        });
        await commit(toMessage(3));
        expect(await admissionStore.readOrderedSuccessor(TRACK_KEY, 1)).toBeUndefined();
        // A copy buffered behind a gap has a slot and no delivery row until the gap closes: the slot names none.
        const buffered = await admissionStore.readBufferedRelease({ trackKey: TRACK_KEY, seq: 3, nowMs: Date.now() });
        expect(buffered?.snapshot.seq).toBe(3);
        expect(buffered?.snapshot.delivery).toBeUndefined();
        expect(await admissionStore.readOrderedSuccessor(TRACK_KEY, 2)).toBeUndefined();
        await commit(toMessage(2));
        expect(await admissionStore.readOrderedSuccessor(TRACK_KEY, 2)).toEqual({
            effectId: toALInboundReleaseEffectId(TRACK_KEY, 3),
            carrier: 'ws'
        });
    });
});

describe('toALInboundSuccessionResult', () => {
    // Pins the one place a delivery's answer becomes its claim's result: only a completion on a track names a
    // succession, and it names that completion's own position.
    it('answers a completion on a track with its position as the succession', () => {
        const position = { trackKey: TRACK_KEY, completedThrough: 3 };
        const result = toALInboundSuccessionResult({ kind: 'completed', position });

        expect(result).toEqual({ status: 'completed-with-succession', succession: position });
        expect(result.status === 'completed-with-succession' ? result.succession : undefined).toBe(position);
    });

    // Pins that a completion on no ordering track hands nothing on: it answers a plain completion.
    it('answers a completion off any track as completed', () => {
        expect(toALInboundSuccessionResult(AL_INBOUND_COMPLETED_OFF_TRACK)).toEqual({ status: 'completed' });
    });

    // Pins that a delivery handed back is retried and names no succession.
    it('answers retry as retry', () => {
        expect(toALInboundSuccessionResult('retry')).toEqual({ status: 'retry' });
    });
});

interface DispatchHold {
    readonly gate: (msg: ALMessage) => Promise<void>;
    /** Settles when the held message's dispatch has started. */
    readonly entered: Promise<void>;
    readonly release: () => void;
}

/** Holds the first dispatch of the message at `seq`, and so its claim's completion, until released. */
function createDispatchHold(seq: number): DispatchHold {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let held = false;
    onTestFinished(() => released.resolve());
    return {
        gate: async (msg) => {
            if (!held && msg.ordering?.seq === seq) {
                held = true;
                entered.resolve();
                await released.promise;
            }
        },
        entered: entered.promise,
        release: () => released.resolve()
    };
}

interface ReleaseFlushHold {
    /** Settles when the batch that claimed the row starts writing its releases. */
    readonly entered: Promise<void>;
    readonly release: () => void;
}

/** Holds the release write that releases the work row of `effectId`: the end of the batch that claimed it. */
function holdReleaseFlushOf(fixture: InboundTestRuntime, effectId: string): ReleaseFlushHold {
    const { workQueue, admissionStore } = fixture.stores;
    const key = toKeyAsString(toALInboundWorkKey(admissionStore.namespace, effectId));
    const releaseEntries = workQueue.releaseEntries.bind(workQueue);
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    onTestFinished(() => released.resolve());
    vi.spyOn(workQueue, 'releaseEntries').mockImplementation(async (entries) => {
        if (entries.some((release) => toKeyAsString(release.entry.key) === key)) {
            entered.resolve();
            await released.promise;
        }
        return await releaseEntries(entries);
    });
    return { entered: entered.promise, release: () => released.resolve() };
}

/** Holds the first dispatch of the message `msgId`, and so its batch, until released. */
function createMessageHold(msgId: string): DispatchHold {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let held = false;
    onTestFinished(() => released.resolve());
    return {
        gate: async (msg) => {
            if (!held && msg.id.msgId === msgId) {
                held = true;
                entered.resolve();
                await released.promise;
            }
        },
        entered: entered.promise,
        release: () => released.resolve()
    };
}

function createRuntime(
    namespace: string,
    storage: InboundTestStorage,
    ports: Pick<Parameters<typeof createInboundTestRuntime>[0], 'gateDispatch' | 'canDispatchMessage'>
): InboundTestRuntime {
    return createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({ namespace, storage, observer: createPassThroughIndexedDbOperationObserver() }),
        effectWorkerId: `al-inbound:${namespace}`,
        ...ports
    });
}

async function admit(fixture: InboundTestRuntime, msg: ALMessage): Promise<void> {
    expect((await fixture.runtime.admitIncomingMessage(msg, INBOUND_TEST_SOURCE)).right?.kind).toBe('admitted');
}

function toMessage(seq: number): ALMessage {
    return createInboundTestMessage({ msgId: `m-${seq}`, seq });
}

function toTrackMessage(orderingKey: string, seq: number): ALMessage {
    const message = createInboundTestMessage({ msgId: `${orderingKey}-${seq}`, seq });
    return { ...message, ordering: { orderingKey, seq } };
}

function withExpiry(msg: ALMessage, expiresAtMs: number): ALMessage {
    return { ...msg, constraints: { ...msg.constraints, expiresAtMs } };
}

function toDispatchId(msg: ALMessage): string {
    return toALInboundLocalDeliveryEffectId(msg, false);
}

function readReceivedSeqs(fixture: InboundTestRuntime): readonly (number | undefined)[] {
    return fixture.deliveredMessages.map((msg) => msg.ordering?.seq);
}

function readClaimingDrains(fixture: InboundTestRuntime, from = 0): readonly EffectDrain[] {
    return fixture.diagnostics.slice(from).filter((event): event is EffectDrain => event.kind === 'effect-drain' && event.claimedCount > 0);
}

async function readWorkRow(fixture: InboundTestRuntime, effectId: string) {
    return await fixture.stores.workQueue.getItem(toALInboundWorkKey(fixture.stores.admissionStore.namespace, effectId));
}

async function readWorkStatuses(fixture: InboundTestRuntime): Promise<readonly EntityStatus[]> {
    const { workQueue } = fixture.stores;
    const rows = await Promise.all((await workQueue.getAllKeys()).map(async (key) => await workQueue.getItem(key)));
    return rows.flatMap((row) => row === undefined || row === null ? [] : [row.status]);
}

function readNackReasons(fixture: InboundTestRuntime, msgId: string): readonly string[] {
    return fixture.controlSends.flat().flatMap((msg) => {
        const control = decodeALPeerControlMessage(msg).right;
        return control?.type === 'nack' && control.payload.msgId === msgId ? [control.payload.reason] : [];
    });
}

function toSequence(from: number, to: number): number[] {
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
