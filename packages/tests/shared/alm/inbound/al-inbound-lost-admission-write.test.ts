// A lost write leaves no stored trace, so where a case must count attempts its record is the list its own seam appends
// to; every other fact is read from stored state after a positive stored fact shows the step ran.
import { afterEach, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { ALStorageUnavailableError } from '@shared/alm/storage/al-storage-unavailable.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    createInboundTestRoomMessage,
    toInboundTestForgedCopy
} from '../create-inbound-test-room-message.ts';
import {
    createInboundTestAdmission,
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    planInboundTestMessage,
    readInboundTestWorkRows,
    runInboundWorkDueNow,
    type InboundTestRuntime
} from '../inbound-runtime-test-fixture.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const FIRST = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
const SECOND = createInboundTestMessage({ msgId: 'message-2', seq: 2 });
const TRACK_KEY = toALOrderingTrackKey(FIRST)!;

function createRuntime(name: string, plan?: (msg: ALMessage) => void): InboundTestRuntime {
    return createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: `inbound-lost-admission-write-${name}`,
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: `al-inbound:lost-admission-write-${name}`,
        plan: plan === undefined ? undefined : (planned, msg) => {
            plan(msg);
            return planned;
        }
    });
}

/** The store's next `count` admission writes lose, as a write whose observations moved does; the rest are its own. */
function loseNextAdmissionWrites(admissionStore: ALInboundAdmissionStore, count: number): void {
    const spy = vi.spyOn(admissionStore, 'commitBundle');
    for (let lost = 0; lost < count; lost += 1) {
        spy.mockResolvedValueOnce('conflict');
    }
}

/** Each retained `admit-message` row the lane's store holds: the message it keeps and the row's status. */
async function readRetainedAdmissions(stores: ALInboundRuntimeStores) {
    return (await readInboundTestWorkRows(stores)).flatMap((row) =>
        row.payload.kind === 'admit-message' ? [{ msgId: row.payload.msg.id.msgId, status: row.entry.status }] : []
    );
}

function readDeliveredIds(fixture: InboundTestRuntime): readonly string[] {
    return fixture.deliveredMessages.map((message) => message.id.msgId);
}

// An ordered arrival whose predecessor completed inside its read-to-commit window lost its write and was parked, its
// track's later messages buffered behind it until a replay ran seconds later.
it('admits an ordered message whose predecessor completed during its admission, without parking it', async () => {
    const fixture = createRuntime('predecessor');
    const { admissionStore } = fixture.stores;
    expect((await fixture.runtime.admitIncomingMessage(FIRST, INBOUND_TEST_SOURCE)).right).toEqual({ kind: 'admitted' });
    const readIncomingMessage = admissionStore.readIncomingMessage.bind(admissionStore);
    let held = false;
    vi.spyOn(admissionStore, 'readIncomingMessage').mockImplementation(async (request) => {
        const read = await readIncomingMessage(request);
        if (request.msg.id.msgId === SECOND.id.msgId && !held) {
            held = true;
            await runInboundWorkDueNow(fixture);
            expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 2)).completedThrough).toBe(1);
        }
        return read;
    });

    expect((await fixture.runtime.admitIncomingMessage(SECOND, INBOUND_TEST_SOURCE)).right).toEqual({ kind: 'admitted' });

    expect(await readRetainedAdmissions(fixture.stores)).toEqual([]);
    await runInboundWorkDueNow(fixture);
    expect(readDeliveredIds(fixture)).toEqual(['message-1', 'message-2']);
    expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 3)).completedThrough).toBe(2);
});

// The bound holds: a fourth attempt would reach the store and commit, and no arrival would be parked any more.
it('parks an admission that loses exactly three writes', async () => {
    const fixture = createRuntime('three-losses');
    loseNextAdmissionWrites(fixture.stores.admissionStore, 3);

    expect((await fixture.runtime.admitIncomingMessage(FIRST, INBOUND_TEST_SOURCE)).right)
        .toEqual({ kind: 'pending-admission' });

    expect(await readRetainedAdmissions(fixture.stores)).toEqual([{ msgId: 'message-1', status: EntityStatus.NEW }]);
    expect(fixture.delivered).toEqual([]);
});

// The last of the bounded attempts still reads, decides and writes.
it('admits an admission that loses exactly two writes', async () => {
    const fixture = createRuntime('two-losses');
    loseNextAdmissionWrites(fixture.stores.admissionStore, 2);

    expect((await fixture.runtime.admitIncomingMessage(FIRST, INBOUND_TEST_SOURCE)).right).toEqual({ kind: 'admitted' });

    expect(await readRetainedAdmissions(fixture.stores)).toEqual([]);
    await runInboundWorkDueNow(fixture);
    expect(readDeliveredIds(fixture)).toEqual(['message-1']);
});

// A readmission that waits for the first copy's delivery wrote nothing: answered as a lost write, it was read and
// decided twice more for the same answer before it was retained.
it('answers a readmission that waits for its first delivery as waiting, and retains it after one attempt', async () => {
    const plans: string[] = [];
    const fixture = createRuntime('waiting', (msg) => plans.push(`plan ${msg.id.msgId}`));
    const wsArrival: ALInboundMessageRuntime.Source = { kind: 'trusted-server' };
    // Admitted over RTC, which this WS runtime never claims, so the forged copy's delivery stays queued.
    const rtcArrival: ALInboundMessageRuntime.Source = { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID };
    const origin = createInboundTestRoomMessage('queued-first', 'receiver', 'volatile');
    expect((await fixture.runtime.admitIncomingMessage(toInboundTestForgedCopy(origin), rtcArrival)).right)
        .toEqual({ kind: 'admitted' });

    const attempt = await createInboundTestAdmission(fixture.stores).attempt(origin, wsArrival, planInboundTestMessage);
    expect(attempt.right?.kind).toBe('waiting');
    plans.length = 0;

    expect((await fixture.runtime.admitIncomingMessage(origin, wsArrival)).right).toEqual({ kind: 'pending-admission' });
    expect(await readRetainedAdmissions(fixture.stores)).toEqual([{ msgId: 'queued-first', status: EntityStatus.NEW }]);
    // One attempt plans twice, before its read and against it; a lane that attempted again would plan twice more.
    expect(plans).toEqual(['plan queued-first', 'plan queued-first']);
});

// A store failure that is no conflict was swallowed as a lost write, or arrived wrapped by the retry primitive when the
// third attempt threw it.
it('answers a store failure that is no conflict as the lane answers it today, at the first attempt and at the third', async () => {
    const failure = new Error('admission storage unavailable');
    const first = createRuntime('failure-first');
    vi.spyOn(first.stores.admissionStore, 'commitBundle').mockRejectedValueOnce(failure);
    const third = createRuntime('failure-third');
    loseNextAdmissionWrites(third.stores.admissionStore, 2);
    vi.spyOn(third.stores.admissionStore, 'commitBundle').mockRejectedValueOnce(failure);

    for (const fixture of [first, third]) {
        await expect(fixture.runtime.admitIncomingMessage(FIRST, INBOUND_TEST_SOURCE)).rejects.toBe(failure);
        expect(await readRetainedAdmissions(fixture.stores)).toEqual([]);
    }
});

// A storage failure arriving at the third attempt wrapped by the retry primitive would no longer read as storage, and
// would reject the arrival where at the first attempt it is answered not admitted.
it('answers a storage failure as storage-unavailable, at the first attempt and at the third', async () => {
    const failure = new ALStorageUnavailableError({ cause: 'transaction-failed', detail: 'admission write aborted' });
    const first = createRuntime('storage-failure-first');
    vi.spyOn(first.stores.admissionStore, 'commitBundle').mockRejectedValueOnce(failure);
    const third = createRuntime('storage-failure-third');
    loseNextAdmissionWrites(third.stores.admissionStore, 2);
    vi.spyOn(third.stores.admissionStore, 'commitBundle').mockRejectedValueOnce(failure);

    for (const fixture of [first, third]) {
        expect((await fixture.runtime.admitIncomingMessage(FIRST, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'not-admitted', reason: 'storage-unavailable' });
        expect(await readRetainedAdmissions(fixture.stores)).toEqual([]);
    }
});

// A fresh attempt that wrote its lost bundle again, rather than reading, would meet the same fence and be parked.
it('answers duplicate when its own message was admitted during its lost write', async () => {
    const fixture = createRuntime('own-message');
    const { admissionStore } = fixture.stores;
    const commitBundle = admissionStore.commitBundle.bind(admissionStore);
    vi.spyOn(admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
        expect(await commitBundle(bundle)).toBe('committed');
        return 'conflict';
    });

    expect((await fixture.runtime.admitIncomingMessage(FIRST, INBOUND_TEST_SOURCE)).right).toEqual({ kind: 'duplicate' });

    expect(await readRetainedAdmissions(fixture.stores)).toEqual([]);
    await runInboundWorkDueNow(fixture);
    expect(readDeliveredIds(fixture)).toEqual(['message-1']);
});

// An owner that kept attempting after its disposal would plan again for a lane that is going away, and one that dropped
// what a single lost write retains would lose the message.
it('makes no further attempt once its runtime is disposed, and retains its lost write as before', async () => {
    const steps: string[] = [];
    const fixture = createRuntime('disposed', (msg) => steps.push(`plan ${msg.id.msgId}`));
    const { admissionStore } = fixture.stores;
    let disposing: Promise<void> | undefined;
    vi.spyOn(admissionStore, 'commitBundle').mockImplementationOnce(async () => {
        steps.push('disposed');
        disposing = fixture.runtime.dispose();
        return 'conflict';
    });

    expect((await fixture.runtime.admitIncomingMessage(FIRST, INBOUND_TEST_SOURCE)).right)
        .toEqual({ kind: 'pending-admission' });
    await disposing;

    expect(await readRetainedAdmissions(fixture.stores)).toEqual([{ msgId: 'message-1', status: EntityStatus.NEW }]);
    expect(steps).toEqual(['plan message-1', 'plan message-1', 'disposed']);
});
