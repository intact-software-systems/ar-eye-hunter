import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type { ALAdmissionReadSession } from '@shared/alm/al-admission-work-backend.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { TurnBatchedReads } from '@shared/resilience/turn-batched-reads.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestStores,
    createOutboundMessage,
    OUTBOUND_TEST_SEND_PLANNER,
    readOutboundTestAdmission
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

interface DispatchFixture {
    readonly admission: ALOutboundDispatchAdmission<OutboundTestPayload>;
    readonly store: ALOutboundAdmissionStore<OutboundTestPayload>;
    readonly backend: InMemoryAdmissionBackend;
    readonly diagnostics: ALOutboundRuntimeDiagnosticsEvent[];
}

/** The reads one `readWithin` session issued, by store round, and whether a group commit opened it. */
interface RecordedReadSession {
    readonly openedByCommit: boolean;
    readonly roundSizes: number[];
}

afterEach(() => vi.restoreAllMocks());

function createDispatchFixture(): DispatchFixture {
    const stores = createDefaultOutboundTestStores();
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const admission = new ALOutboundDispatchAdmission({
        lane: 'durable',
        admissionStore: stores.admissionStore,
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox', Temporal.Now.instant()),
        decodePreparedMessage: decodeOutboundTestPayload,
        clock: { nowMs: Date.now },
        browserLocks: undefined,
        diagnostics: (event) => diagnostics.push(event),
        settlements: () => {}
    });
    return { admission, store: stores.admissionStore, backend: stores.backend, diagnostics };
}

/**
 * Each session's reads of one turn answer together as one store round, as the server backend's
 * turn-batched statement answers them; a read issued after a round began waits for the next.
 */
function recordReadRounds(backend: InMemoryAdmissionBackend, isCommitting: () => boolean): RecordedReadSession[] {
    const sessions: RecordedReadSession[] = [];
    const readWithin = backend.readWithin.bind(backend);
    vi.spyOn(backend, 'readWithin').mockImplementation((read) => {
        const recorded: RecordedReadSession = { openedByCommit: isCommitting(), roundSizes: [] };
        sessions.push(recorded);
        return readWithin((session) => read(toRecordingReadSession(session, recorded)));
    });
    return sessions;
}

function toRecordingReadSession(session: ALAdmissionReadSession, recorded: RecordedReadSession): ALAdmissionReadSession {
    let issued = 0;
    const rounds = new TurnBatchedReads<number, number>({
        toKeyId: String,
        readBatch: async (reads) => {
            recorded.roundSizes.push(reads.length);
            return reads;
        }
    });
    const inRound = async <V>(read: () => Promise<V>): Promise<V> => {
        await rounds.read(issued++);
        return await read();
    };
    return {
        readWork: (key) => inRound(() => session.readWork(key)),
        read: (key, decode) => inRound(() => session.read(key, decode)),
        list: (prefix, decode) => inRound(() => session.list(prefix, decode))
    };
}

/** The decision reads of each store, by turn-batched round, and the most rounds in flight at once. */
interface DecisionStoreRounds {
    readonly state: string[][];
    readonly queue: string[][];
    peakInFlight: number;
}

/**
 * Before the group commit opens, every state read and every queue read answers in its store's turn-batched round, as
 * the server's backend and queue each answer one turn's reads in one statement on one pooled connection.
 */
function recordDecisionStoreRounds(backend: InMemoryAdmissionBackend, isCommitting: () => boolean): DecisionStoreRounds {
    const recorded: DecisionStoreRounds = { state: [], queue: [], peakInFlight: 0 };
    let inFlight = 0;
    const toRounds = (rounds: string[][]) =>
        new TurnBatchedReads<string, string>({
            toKeyId: (key) => key,
            readBatch: async (keys) => {
                rounds.push([...keys]);
                inFlight += 1;
                recorded.peakInFlight = Math.max(recorded.peakInFlight, inFlight);
                await Promise.resolve();
                inFlight -= 1;
                return keys;
            }
        });
    const stateRounds = toRounds(recorded.state);
    const queueRounds = toRounds(recorded.queue);
    const inRound = async <V>(rounds: TurnBatchedReads<string, string>, key: string, read: () => Promise<V>): Promise<V> => {
        if (!isCommitting()) {
            await rounds.read(key);
        }
        return await read();
    };
    const read = backend.read.bind(backend);
    const list = backend.list.bind(backend);
    const getItem = backend.workQueue.getItem.bind(backend.workQueue);
    vi.spyOn(backend, 'read').mockImplementation((key, decode) => inRound(stateRounds, key, () => read(key, decode)));
    vi.spyOn(backend, 'list').mockImplementation((prefix, decode) => inRound(stateRounds, prefix, () => list(prefix, decode)));
    vi.spyOn(backend.workQueue, 'getItem').mockImplementation((key) =>
        inRound(queueRounds, `${key.topicId}/${key.contextId}/${key.resourceId}`, () => getItem(key))
    );
    return recorded;
}

function toDispatch(msg: ALMessage): ALOutboundDispatchAdmission.Input<OutboundTestPayload> {
    return { msg, planner: OUTBOUND_TEST_SEND_PLANNER, intent: 'enqueue', phase: 'immediate', origin: 'send', options: {} };
}

it('reads every member of a burst at once before committing in input order and admitting a late send', async () => {
    const { admission, store } = createDispatchFixture();
    const messages = Array.from({ length: 5 }, (_, index) => ({
        ...createOutboundMessage(`burst-${index}`),
        targets: { mode: 'unicast' as const, toPeerId: `peer-${index}` }
    }));
    const gates = messages.map(() => Promise.withResolvers<void>());
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const readOutgoingMessage = store.readOutgoingMessage.bind(store);
    vi.spyOn(store, 'readOutgoingMessage').mockImplementation(async (input) => {
        const index = messages.findIndex((message) => message.id.msgId === input.msg.id.msgId);
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        try {
            await gates[index]!.promise;
            return await readOutgoingMessage(input);
        }
        finally {
            active -= 1;
        }
    });
    const writes: number[] = [];
    const commitBundles = store.commitBundles.bind(store);
    vi.spyOn(store, 'commitBundles').mockImplementation(async (bundles) => {
        writes.push(active);
        return await commitBundles(bundles);
    });
    const group = admission.commitAllSettled(messages.map(toDispatch));
    const late = admission.commit(toDispatch(createOutboundMessage('late-promotion')));
    const lateRead = vi.spyOn(store, 'readOutgoingDecision');

    try {
        await expect.poll(() => started).toEqual([0, 1, 2, 3, 4]);
        expect(writes).toEqual([]);
        expect(lateRead).not.toHaveBeenCalled();
        for (let index = 1; index < messages.length; index += 1) {
            gates[index]!.resolve();
        }
        await expect.poll(() => active).toBe(1);
        expect(writes).toEqual([]);
        expect(lateRead).not.toHaveBeenCalled();
        gates[0]!.resolve();
        const results = await group;
        expect(peak).toBe(messages.length);
        expect(writes).toEqual([0]);
        expect(results.map((result) => result.status === 'fulfilled' && result.value.committed)).toEqual([true, true, true, true, true]);
        expect(results.map((result) => result.status === 'fulfilled' && result.value.computed.msg)).toEqual(messages);
        expect((await late).committed).toBe(true);
        for (const message of messages) {
            const read = await readOutgoingMessage({ msg: message, planner: OUTBOUND_TEST_SEND_PLANNER, observedCanonicalEntry: undefined, intent: 'enqueue' });
            expect(read.storedMessage?.msgId).toBe(message.id.msgId);
            expect(read.msg).toEqual(message);
        }
    }
    finally {
        gates.forEach((gate) => gate.resolve());
        await Promise.allSettled([group, late]);
        admission.dispose();
    }
});

it.each(['rejected', 'settled'] as const)(
    'waits for every group read after a %s member before fresh ordered fallback, preserving individual results',
    async (mode) => {
        const { admission, store } = createDispatchFixture();
        const first = createOutboundMessage('first');
        const held = createOutboundMessage('held');
        const broken = createOutboundMessage('broken');
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const firstFinished = Promise.withResolvers<void>();
        const readOutgoingMessage = store.readOutgoingMessage.bind(store);
        const completed: string[] = [];
        vi.spyOn(store, 'readOutgoingMessage').mockImplementation(async (input) => {
            if (input.msg.id.msgId === first.id.msgId) {
                await entered.promise;
                firstFinished.resolve();
                if (mode === 'rejected') {
                    throw new Error('intermittent read failure');
                }
            }
            if (input.msg.id.msgId === held.id.msgId) {
                entered.resolve();
                await release.promise;
            }
            try {
                return await readOutgoingMessage(input);
            }
            finally {
                completed.push(input.msg.id.msgId);
            }
        });
        const fallback = vi.spyOn(store, 'readOutgoingDecision');
        const writes = vi.spyOn(store, 'commitBundles');
        const firstDispatch = mode === 'settled'
            ? {
                ...toDispatch(first),
                planner: (msg: ALMessage) => ({
                    msg,
                    dropReason: 'Skipping unauthorized test member',
                    dropReasonCode: 'unauthorized' as const,
                    lane: 'durable' as const,
                    preparedMessages: []
                })
            }
            : toDispatch(first);
        const brokenDispatch = {
            ...toDispatch(broken),
            planner: () => {
                throw new Error('broken member');
            }
        };
        const group = admission.commitAllSettled([firstDispatch, toDispatch(held), brokenDispatch]);

        try {
            await expect.poll(() => completed.includes(broken.id.msgId)).toBe(true);
            await firstFinished.promise;
            expect(fallback).not.toHaveBeenCalled();
            expect(writes).not.toHaveBeenCalled();
            release.resolve();
            const results = await group;
            expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
            expect(results[0]).toMatchObject({ value: { committed: mode === 'rejected' } });
            expect(results[1]).toMatchObject({ value: { committed: true, computed: { msg: held } } });
            expect(results[2]).toMatchObject({ reason: new Error('broken member') });
            expect(fallback.mock.calls.map(([input]) => input.msg.id.msgId)).toEqual([first.id.msgId, held.id.msgId, broken.id.msgId]);
            expect((await admission.commit(toDispatch(createOutboundMessage('subsequent')))).committed).toBe(true);
        }
        finally {
            entered.resolve();
            release.resolve();
            await group;
            admission.dispose();
        }
    }
);

it('serializes each sender in arrival order, releases failure, and forgets idle queues while other senders progress', async () => {
    const { admission, store, diagnostics } = createDispatchFixture();
    const first = createOutboundMessage('failing-first');
    const second = createOutboundMessage('second');
    const third = createOutboundMessage('third');
    const other = createOutboundMessage('other');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readOutgoingDecision = store.readOutgoingDecision.bind(store);
    const reads: string[] = [];
    vi.spyOn(store, 'readOutgoingDecision').mockImplementation(async (input, decide) => {
        reads.push(input.msg.id.msgId);
        if (input.msg.id.msgId === first.id.msgId) {
            entered.resolve();
            await release.promise;
            throw new Error('first failed');
        }
        return await readOutgoingDecision(input, decide);
    });
    const firstResult = Promise.allSettled([admission.commit({ ...toDispatch(first), origin: 'drain' })]);
    await entered.promise;
    const next = [second, third].map((msg) => admission.commit(toDispatch(msg)));
    try {
        const independent = await admission.commit(toDispatch({ ...other, id: { ...other.id, senderId: 'other-sender' } }));
        expect(independent.committed).toBe(true);
        expect(reads).toEqual([first.id.msgId, other.id.msgId]);
        release.resolve();
        expect((await firstResult)[0]).toMatchObject({ status: 'rejected', reason: new Error('first failed') });
        expect((await Promise.all(next)).map((result) => result.committed)).toEqual([true, true]);
        expect(reads).toEqual([first.id.msgId, other.id.msgId, second.id.msgId, third.id.msgId]);
        expect((await admission.commit(toDispatch(createOutboundMessage('reuse')))).committed).toBe(true);
        expect(
            diagnostics.filter((event) => event.kind === 'sender-queue-wait').filter((event) => event.senderId === 'self').map((event) => ({
                origin: event.origin,
                queued: event.queued,
                queuedBehindOrigin: event.queuedBehindOrigin
            }))
        ).toEqual([
            { origin: 'drain', queued: false, queuedBehindOrigin: 'none' },
            { origin: 'send', queued: true, queuedBehindOrigin: 'drain' },
            { origin: 'send', queued: true, queuedBehindOrigin: 'send' },
            { origin: 'send', queued: false, queuedBehindOrigin: 'none' }
        ]);
    }
    finally {
        release.resolve();
        await Promise.allSettled([firstResult, ...next]);
        admission.dispose();
    }
});

it('reads the commit observations of a sixteen-member group in at most two store rounds', async () => {
    const { admission, store, backend } = createDispatchFixture();
    let committing = false;
    const commitBundles = store.commitBundles.bind(store);
    vi.spyOn(store, 'commitBundles').mockImplementation(async (bundles) => {
        committing = true;
        try {
            return await commitBundles(bundles);
        }
        finally {
            committing = false;
        }
    });
    const sessions = recordReadRounds(backend, () => committing);
    const messages = Array.from({ length: 16 }, (_, index) => ({
        ...createOutboundMessage(`member-${index}`),
        targets: { mode: 'unicast' as const, toPeerId: `peer-${index}` }
    }));

    try {
        const results = await admission.commitAllSettled(messages.map(toDispatch));

        expect(results.map((result) => result.status === 'fulfilled' && result.value.committed)).toEqual(messages.map(() => true));
        const observations = sessions.filter((session) => session.openedByCommit);
        expect(observations).toHaveLength(1);
        // Every member's observation reads are still issued: they share rounds instead of queueing one member behind the next.
        expect(observations[0]!.roundSizes.reduce((sum, size) => sum + size, 0)).toBe(16 * 3);
        expect(observations[0]!.roundSizes.length).toBeLessThanOrEqual(2);
    }
    finally {
        admission.dispose();
    }
});

it('reads the decisions of a sixteen-member group in one round per read depth, two connections at most', async () => {
    const { admission, store, backend } = createDispatchFixture();
    let committing = false;
    const commitBundles = store.commitBundles.bind(store);
    vi.spyOn(store, 'commitBundles').mockImplementation(async (bundles) => {
        committing = true;
        try {
            return await commitBundles(bundles);
        }
        finally {
            committing = false;
        }
    });
    const rounds = recordDecisionStoreRounds(backend, () => committing);
    const messages = Array.from({ length: 16 }, (_, index) => ({
        ...createOutboundMessage(`member-${index}`),
        targets: { mode: 'unicast' as const, toPeerId: `peer-${index}` }
    }));

    try {
        const results = await admission.commitAllSettled(messages.map(toDispatch));

        expect(results.map((result) => result.status === 'fulfilled' && result.value.committed)).toEqual(messages.map(() => true));
        expect(rounds.state).toHaveLength(1);
        // The canonical row, then the identity row it names: each round reads that row for every member at once.
        expect(rounds.queue.map((round) => round.length)).toEqual([16, 16]);
        expect(rounds.peakInFlight).toBeLessThanOrEqual(2);
    }
    finally {
        admission.dispose();
    }
});

it('probes the pending admission each enqueue member retained through the backend\'s turn-batched work read', async () => {
    const { admission, store, backend } = createDispatchFixture();
    const messages = Array.from({ length: 4 }, (_, index) => ({
        ...createOutboundMessage(`retained-${index}`),
        targets: { mode: 'unicast' as const, toPeerId: `peer-${index}` }
    }));

    try {
        for (const message of messages) {
            await retainPendingAdmission(admission, store, message);
        }
        const unbatched = recordUnbatchedWorkQueueReads(backend);
        const results = await admission.commitAllSettled(messages.map(toDispatch));

        expect(results.map((result) => result.status === 'fulfilled' && result.value.computed.verdict))
            .toEqual(messages.map(() => ({ kind: 'pending' })));
        expect(unbatched).toEqual([]);
    }
    finally {
        admission.dispose();
    }
});

it('rejects a group commit with two corrupt member observations as corruption, not as an aggregate', async () => {
    const failure = await readGroupObservationFailure({
        'member-1': { delayMs: 5, error: () => new ALAdmissionCorruptionError('member-1', new Error('bad row')) },
        'member-2': { delayMs: 0, error: () => new ALAdmissionCorruptionError('member-2', new Error('bad row')) }
    });

    expect(failure).toBeInstanceOf(ALAdmissionCorruptionError);
    expect(failure).toMatchObject({ key: 'member-1' });
});

it('rejects a group commit with a transient and a corrupt member observation as corruption', async () => {
    const failure = await readGroupObservationFailure({
        'member-1': { delayMs: 0, error: () => new Error('connection reset') },
        'member-2': { delayMs: 5, error: () => new ALAdmissionCorruptionError('member-2', new Error('bad row')) }
    });

    expect(failure).toBeInstanceOf(ALAdmissionCorruptionError);
    expect(failure).toMatchObject({ key: 'member-2' });
});

it('rejects a group commit with two transient member observations with the first member\'s failure', async () => {
    const failure = await readGroupObservationFailure({
        'member-1': { delayMs: 5, error: () => new Error('member-1 timed out') },
        'member-2': { delayMs: 0, error: () => new Error('member-2 timed out') }
    });

    expect(failure).toMatchObject({ message: 'member-1 timed out' });
    expect(failure).not.toBeInstanceOf(AggregateError);
});

interface FailingObservation {
    readonly delayMs: number;
    readonly error: () => Error;
}

/**
 * Commits four members as one group whose named members' canonical-row observation reads fail after their delays, and
 * returns what the group commit rejected with; the members then commit alone.
 */
async function readGroupObservationFailure(failing: Readonly<Record<string, FailingObservation>>): Promise<Error> {
    const { admission, store, backend } = createDispatchFixture();
    let committing = false;
    const failures: Error[] = [];
    const commitBundles = store.commitBundles.bind(store);
    vi.spyOn(store, 'commitBundles').mockImplementation(async (bundles) => {
        committing = true;
        try {
            return await commitBundles(bundles);
        }
        catch (error) {
            failures.push(toError(error));
            throw error;
        }
        finally {
            committing = false;
        }
    });
    const readWithin = backend.readWithin.bind(backend);
    vi.spyOn(backend, 'readWithin').mockImplementation((read) => readWithin((session) => read(committing ? toFailingReadSession(session, failing) : session)));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const messages = Array.from({ length: 4 }, (_, index) => {
        const message = createOutboundMessage(`member-${index}`);
        return {
            ...message,
            id: { ...message.id, msgId: `member-${index}` },
            targets: { mode: 'unicast' as const, toPeerId: `peer-${index}` }
        };
    });
    try {
        await admission.commitAllSettled(messages.map(toDispatch));
    }
    finally {
        admission.dispose();
    }
    expect(failures).toHaveLength(1);
    return failures[0];
}

function toFailingReadSession(
    session: ALAdmissionReadSession,
    failing: Readonly<Record<string, FailingObservation>>
): ALAdmissionReadSession {
    const toFailure = (contextId: string) => Object.entries(failing).find(([member]) => contextId.includes(`${member}-3A`))?.[1];
    return {
        readWork: async (key) => {
            const failure = key.topicId === 'AL_OUTBOUND' ? toFailure(key.contextId) : undefined;
            if (failure === undefined) {
                return await session.readWork(key);
            }
            await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
            throw failure.error();
        },
        read: (key, decode) => session.read(key, decode),
        list: (prefix, decode) => session.list(prefix, decode)
    };
}

/** A competing send of the same sender wins the version fence inside the message's first commit, so it retains. */
async function retainPendingAdmission(
    admission: ALOutboundDispatchAdmission<OutboundTestPayload>,
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage
): Promise<void> {
    const competitor = await readOutboundTestAdmission({
        store,
        message: createOutboundMessage(`${message.id.msgId}-competitor`),
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: Date.now }
    });
    const commitBundle = store.commitBundle.bind(store);
    const spy = vi.spyOn(store, 'commitBundle').mockImplementationOnce(async (bundle, observation) => {
        expect(await commitBundle(competitor)).toBe('committed');
        return await commitBundle(bundle, observation);
    });
    expect((await admission.commit(toDispatch(message))).computed.verdict).toEqual({ kind: 'pending' });
    spy.mockRestore();
}

/**
 * The work-queue reads that bypass the backend's work read, which the server backend answers turn-batched in one
 * statement; the in-memory backend's work read reaches the queue synchronously, inside the call.
 */
function recordUnbatchedWorkQueueReads(backend: InMemoryAdmissionBackend): string[] {
    const unbatched: string[] = [];
    let insideWorkRead = false;
    const readWork = backend.readWork.bind(backend);
    const getItem = backend.workQueue.getItem.bind(backend.workQueue);
    vi.spyOn(backend, 'readWork').mockImplementation((key) => {
        insideWorkRead = true;
        try {
            return readWork(key);
        }
        finally {
            insideWorkRead = false;
        }
    });
    vi.spyOn(backend.workQueue, 'getItem').mockImplementation((key) => {
        if (!insideWorkRead) {
            unbatched.push(`${key.topicId}/${key.contextId}`);
        }
        return getItem(key);
    });
    return unbatched;
}
