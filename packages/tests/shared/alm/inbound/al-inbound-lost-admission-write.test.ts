// A lost write leaves no stored trace, so where a case must count attempts its record is the list its own seam appends
// to; every other fact is read from stored state after a positive stored fact shows the step ran.
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    loseNextInboundAdmissionWritesOf,
    planInboundTestMessage,
    readInboundTestWorkRows,
    restoreInboundWritesOnRetention,
    runInboundWorkDueNow,
    setNextInboundAdmissionParked,
    toInboundTestAdmissionOutcomes,
    type CreateInboundTestRuntimeInput,
    type InboundTestRuntime
} from '../inbound-runtime-test-fixture.ts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const FIRST = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
const SECOND = createInboundTestMessage({ msgId: 'message-2', seq: 2 });
const TRACK_KEY = toALOrderingTrackKey(FIRST)!;

type ReplayDependencies = Pick<CreateInboundTestRuntimeInput, 'readPendingAdmissionAuthority' | 'onReplayAdmitted'>;

function createRuntime(name: string, plan?: (msg: ALMessage) => void, replay: ReplayDependencies = {}): InboundTestRuntime {
    return createInboundTestRuntime({
        ...replay,
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
        row.payload.kind === 'admit-message'
            ? [{ msgId: row.payload.msg.id.msgId, status: row.entry.status, attempts: row.entry.dequeueAudit.attempts }]
            : []
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

    expect(await readRetainedAdmissions(fixture.stores)).toEqual([{ msgId: 'message-1', status: EntityStatus.NEW, attempts: 0 }]);
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
    expect(await readRetainedAdmissions(fixture.stores)).toEqual([{ msgId: 'queued-first', status: EntityStatus.NEW, attempts: 0 }]);
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

    expect(await readRetainedAdmissions(fixture.stores)).toEqual([{ msgId: 'message-1', status: EntityStatus.NEW, attempts: 0 }]);
    expect(steps).toEqual(['plan message-1', 'plan message-1', 'disposed']);
});

describe('a replay of a retained admission', () => {
    // A replay that lost once went back to the work queue as a retry, where the rotation left it for tens of seconds
    // while its track's later messages waited behind it.
    it('a replay whose write is lost admits its message in the same claim and hands it to its owner once', async () => {
        const replay = createReplayRuntime('replay-one-loss');
        await retainForReplay(replay, FIRST, () => loseNextInboundAdmissionWritesOf(replay.fixture.stores.admissionStore, { msg: FIRST, count: 1 }));

        await runInboundWorkDueNow(replay.fixture);

        expect(await readRetainedAdmissions(replay.fixture.stores))
            .toEqual([{ msgId: 'message-1', status: EntityStatus.COMPLETED, attempts: 1 }]);
        expect(readDeliveredIds(replay.fixture)).toEqual(['message-1']);
        expect(replay.handedOver).toEqual(['message-1']);
        // Each attempt asks the authority again: the one whose write was lost and the one that admitted.
        expect(replay.authorityReads).toEqual(['message-1', 'message-1']);
    });

    // The bound holds for a replay: a fourth attempt would commit, and a replay that lost three writes would admit.
    it('a replay that loses three writes goes back as retry and states pending again', async () => {
        const replay = createReplayRuntime('replay-three-losses');
        await retainForReplay(replay, FIRST, () => loseNextInboundAdmissionWritesOf(replay.fixture.stores.admissionStore, { msg: FIRST, count: 3 }));

        // One round only: the row it retries is due at once, and the next claim's write is the store's own.
        await replay.fixture.queueEngine.executeOnce();

        // The round's claim is released after the round answers; nothing else can claim it.
        await expect.poll(async () => await readRetainedAdmissions(replay.fixture.stores))
            .toEqual([{ msgId: 'message-1', status: EntityStatus.RETRY, attempts: 1 }]);
        expect(readVerdicts(replay.fixture, FIRST)).toEqual([
            { outcome: 'pending', reason: 'pending-admission' },
            { outcome: 'pending', reason: 'pending-admission' }
        ]);
        expect(replay.fixture.delivered).toEqual([]);
        expect(replay.handedOver).toEqual([]);
        expect(replay.authorityReads).toEqual(['message-1', 'message-1', 'message-1']);
    });

    // The last of a replay's bounded attempts still asks, reads, decides and writes.
    it('a replay that loses two writes admits its message in the same claim and delivers it once', async () => {
        const replay = createReplayRuntime('replay-two-losses');
        await retainForReplay(replay, FIRST, () => loseNextInboundAdmissionWritesOf(replay.fixture.stores.admissionStore, { msg: FIRST, count: 2 }));

        await runInboundWorkDueNow(replay.fixture);

        expect(await readRetainedAdmissions(replay.fixture.stores))
            .toEqual([{ msgId: 'message-1', status: EntityStatus.COMPLETED, attempts: 1 }]);
        expect(readDeliveredIds(replay.fixture)).toEqual(['message-1']);
        expect(replay.handedOver).toEqual(['message-1']);
    });

    // A fresh attempt that kept the authorization its first attempt was given would admit a message its authority
    // now refuses.
    it('a replay whose authority rejects the message after its first lost write answers the rejection', async () => {
        const replay = createReplayRuntime('replay-rejected');
        await retainForReplay(replay, FIRST, () =>
            loseNextInboundAdmissionWritesOf(replay.fixture.stores.admissionStore, {
                msg: FIRST,
                count: 1,
                onLoss: () => {
                    replay.authority.next = { kind: 'rejected' };
                }
            }));

        await runInboundWorkDueNow(replay.fixture);

        expect(await readRetainedAdmissions(replay.fixture.stores))
            .toEqual([{ msgId: 'message-1', status: EntityStatus.COMPLETED, attempts: 1 }]);
        // The lost attempt stated nothing: the arrival's pending, then the replay's one verdict.
        expect(readVerdicts(replay.fixture, FIRST)).toEqual([
            { outcome: 'pending', reason: 'pending-admission' },
            { outcome: 'unauthorized', reason: 'unauthorized' }
        ]);
        expect(await replay.fixture.stores.admissionStore.readDeliverySurface(FIRST.id, Date.now())).toBeUndefined();
        expect(replay.fixture.delivered).toEqual([]);
        expect(replay.handedOver).toEqual([]);
        expect(replay.authorityReads).toEqual(['message-1', 'message-1']);
    });

    // The same kept authorization: an authority that cannot judge the message yet must hold the fresh attempt back.
    it('a replay whose authority asks for a retry after its first lost write answers not-ready and admits nothing', async () => {
        const replay = createReplayRuntime('replay-not-ready');
        await retainForReplay(replay, FIRST, () =>
            loseNextInboundAdmissionWritesOf(replay.fixture.stores.admissionStore, {
                msg: FIRST,
                count: 1,
                onLoss: () => {
                    replay.authority.next = { kind: 'retry', retryAfterMs: 60_000 };
                }
            }));

        await runInboundWorkDueNow(replay.fixture);

        // The claim's second attempt asked the authority, which answered that it cannot judge the message yet.
        expect(replay.authorityReads).toEqual(['message-1', 'message-1']);
        // A row not ready yet gives its claim back, so it counts no attempt; a lost write would have counted one.
        expect(await readRetainedAdmissions(replay.fixture.stores))
            .toEqual([{ msgId: 'message-1', status: EntityStatus.RETRY, attempts: 0 }]);
        expect(readVerdicts(replay.fixture, FIRST)).toEqual([{ outcome: 'pending', reason: 'pending-admission' }]);
        expect(await replay.fixture.stores.admissionStore.readDeliverySurface(FIRST.id, Date.now())).toBeUndefined();
        expect(replay.fixture.delivered).toEqual([]);
        expect(replay.handedOver).toEqual([]);
    });

    // A fresh attempt that kept its first attempt's deadline check would admit a message past its deadline.
    it('a replay whose deadline passes during its lost write answers expired', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_800_000_000_000);
        const message = createInboundTestMessage({ msgId: 'expiring', seq: 1 });
        const replay = createReplayRuntime('replay-expired');
        await retainForReplay(replay, message, () =>
            loseNextInboundAdmissionWritesOf(replay.fixture.stores.admissionStore, {
                msg: message,
                count: 1,
                onLoss: () => {
                    // Past the message's 60 s lifetime.
                    vi.setSystemTime(Date.now() + 120_000);
                }
            }));

        await runInboundWorkDueNow(replay.fixture);

        expect(readVerdicts(replay.fixture, message)).toEqual([
            { outcome: 'pending', reason: 'pending-admission' },
            { outcome: 'rejected', reason: 'expired' }
        ]);
        // The verdict shows the claim ran; its row, past its deadline, is gone with it.
        expect(await readRetainedAdmissions(replay.fixture.stores)).toEqual([]);
        expect(replay.fixture.delivered).toEqual([]);
        expect(replay.handedOver).toEqual([]);
    });

    // An owner that kept attempting after its disposal would ask, plan and write again for a lane going away.
    it('a replay cut short by disposal during its lost write makes no further attempt and states nothing', async () => {
        const replay = createReplayRuntime('replay-disposed');
        let disposing: Promise<void> | undefined;
        await retainForReplay(replay, FIRST, () =>
            loseNextInboundAdmissionWritesOf(replay.fixture.stores.admissionStore, {
                msg: FIRST,
                count: 1,
                onLoss: () => {
                    replay.steps.push('disposed');
                    disposing = replay.fixture.runtime.dispose();
                }
            }));
        replay.steps.length = 0;

        await runInboundWorkDueNow(replay.fixture);
        await disposing;

        // One attempt plans twice, before its read and against it; a replay that attempted again would plan twice more.
        expect(replay.steps).toEqual(['plan message-1', 'plan message-1', 'disposed']);
        expect(replay.authorityReads).toEqual(['message-1']);
        expect(readVerdicts(replay.fixture, FIRST)).toEqual([{ outcome: 'pending', reason: 'pending-admission' }]);
        expect(replay.fixture.delivered).toEqual([]);
    });

    // A replay that went back to the work queue after one lost write left its track's buffered successor waiting
    // behind it for another claim; one that released twice, or out of order, would deliver it twice or first.
    it('delivers a buffered successor once and in order after its predecessor\'s replay admits on its second attempt', async () => {
        const replay = createReplayRuntime('replay-buffered-successor');
        const { admissionStore } = replay.fixture.stores;
        // The successor is admitted first and buffered behind the gap its predecessor leaves; the predecessor is then
        // retained, so the successor can be released only after the predecessor's replay commits.
        expect((await replay.fixture.runtime.admitIncomingMessage(SECOND, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        expect(readDeliveredIds(replay.fixture)).toEqual([]);
        await retainForReplay(replay, FIRST, () => loseNextInboundAdmissionWritesOf(admissionStore, { msg: FIRST, count: 1 }));

        await runInboundWorkDueNow(replay.fixture);

        // One claim admitted the predecessor; the row is finished, not retained for another.
        expect(await readRetainedAdmissions(replay.fixture.stores))
            .toEqual([{ msgId: 'message-1', status: EntityStatus.COMPLETED, attempts: 1 }]);
        expect(readDeliveredIds(replay.fixture)).toEqual(['message-1', 'message-2']);
        expect((await admissionStore.readOrderedDelivery(TRACK_KEY, 3)).completedThrough).toBe(2);
        expect(replay.handedOver).toEqual(['message-1']);
    });
});

interface ReplayRuntime {
    readonly fixture: InboundTestRuntime;
    /** One entry per ask of the replay's authority, recorded by the authority this case composes. */
    readonly authorityReads: string[];
    /** Each message handed to the replay's owner, recorded by the owner this case composes. */
    readonly handedOver: string[];
    /** Each plan the runtime made and each step a case's seam took, in order. */
    readonly steps: string[];
    /** What the authority answers next; `undefined` authorizes the source the message was kept under. */
    readonly authority: { next: ALInboundMessageRuntime.PendingAuthority | undefined; };
}

function createReplayRuntime(name: string): ReplayRuntime {
    const authorityReads: string[] = [];
    const handedOver: string[] = [];
    const steps: string[] = [];
    const authority: ReplayRuntime['authority'] = { next: undefined };
    const fixture = createRuntime(name, (msg) => steps.push(`plan ${msg.id.msgId}`), {
        readPendingAdmissionAuthority: async (msg, source) => {
            authorityReads.push(msg.id.msgId);
            return authority.next ?? { kind: 'authorized', source };
        },
        onReplayAdmitted: async (admitted) => {
            handedOver.push(admitted.msg.id.msgId);
        }
    });
    return { fixture, authorityReads, handedOver, steps, authority };
}

/**
 * Retains `msg`'s arrival, every attempt's write lost, and runs `arrangeReplay` as its row is written, once the store's
 * own commit is back: what the replay's writes meet is what the case arranges.
 */
async function retainForReplay(replay: ReplayRuntime, msg: ALMessage, arrangeReplay: () => void): Promise<void> {
    const { stores, runtime } = replay.fixture;
    const restoreWrites = setNextInboundAdmissionParked(stores.admissionStore);
    restoreInboundWritesOnRetention(stores, () => {
        restoreWrites();
        arrangeReplay();
    });

    expect((await runtime.admitIncomingMessage(msg, INBOUND_TEST_SOURCE)).right).toEqual({ kind: 'pending-admission' });
}

/** The verdicts stated about `msg`, in the order they were stated: each `admission-outcome`'s outcome and reason. */
function readVerdicts(fixture: InboundTestRuntime, msg: ALMessage) {
    return toInboundTestAdmissionOutcomes(fixture.diagnostics, msg).map(({ outcome, reason }) => ({ outcome, reason }));
}
