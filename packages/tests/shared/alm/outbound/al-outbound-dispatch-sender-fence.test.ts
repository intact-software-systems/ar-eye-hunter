import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import {
    computeClientStateSyncEntries,
    computeGroupStateSyncEntries
} from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { decodeALAdmissionClientRecord, decodeALOutboundMessageVersion } from '@shared/alm/al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    toALOutboundOriginMessageKey,
    toALOutboundVersionKey
} from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { hasALOutboundSenderSharedRead } from '@shared/alm/outbound/admission/al-outbound-admission-reads.ts';
import type {
    ALOutboundCommitBundle,
    ALOutboundMessageReadDto,
    ALOutboundPlanner,
    ALOutboundRepairHint
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import type { ALOutboundMessageRuntime, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundRepairRetransmission } from '@shared/alm/outbound/al-outbound-repair-retransmission.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { createDefaultALOutboundDequeueResilience } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryQueueBox, type ResourceEntry } from '@shared/mod.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createClientEventStateSync,
    createGroupDeltaStateSync
} from '../../../shared-server/rallar-system/state-sync/create-state-sync-effect-fixture.ts';
import {
    createOutboundCanonicalEntry,
    createOutboundMessage,
    createOutboundTestRuntimeFor,
    createServerReceipt,
    runOutboundWorkTask,
    toOutboundTestAck
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const OUTBOX_TYPE = 'outbox';
const NAMESPACE = 'sender-fence';
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

// Each kind of dispatch, what its decision read, and whether its commit moves its sender's version.
const DISPATCHES = [
    { dispatch: 'a receipt control, enqueued', sender: 'unmoved' }, // 1
    { dispatch: 'a receipt control, dequeued', sender: 'unmoved' }, // 2
    { dispatch: 'a handed-off control, enqueued and dequeued', sender: 'unmoved' }, // 3
    { dispatch: 'a message on no track and under no supersedence key, enqueued', sender: 'unmoved' }, // 4
    { dispatch: 'that message, dequeued', sender: 'unmoved' }, // 5
    { dispatch: 'that message, repaired', sender: 'unmoved' }, // 6
    { dispatch: 'a message with an ordering key and no sequence, on a plan that mints none', sender: 'unmoved' }, // 7
    { dispatch: 'a message minting the next sequence of a track it owns', sender: 'moved' }, // 8
    { dispatch: 'a message stating a sequence above its track\'s head', sender: 'moved' }, // 9
    { dispatch: 'a sequenced message on a shared head that records no recipient', sender: 'moved' }, // 10: the room sent floor
    { dispatch: 'a tracked row dequeued again, its positions recorded', sender: 'moved' }, // 11: reads no head, no position
    { dispatch: 'a tracked row recording its recipients\' positions at its first dequeue', sender: 'moved' }, // 12
    { dispatch: 'a tracked message, repaired', sender: 'moved' }, // 13
    { dispatch: 'a tracked message that names no deadline, minting', sender: 'moved' }, // 14: writes no track row
    { dispatch: 'a message under a supersedence key', sender: 'moved' }, // 15
    { dispatch: 'a group-state delta, first dispatched at its dequeue', sender: 'unmoved' }, // 16: names no ordering
    { dispatch: 'a client-state event, first dispatched at its dequeue', sender: 'moved' }, // 16b: holds a sequence
    { dispatch: 'a dispatch that ends its message: a spent repair budget', sender: 'moved' }, // 17
    { dispatch: 'a dispatch that ends its message: a re-plan refused for good at its dequeue', sender: 'moved' } // 18
] as const;

type DispatchName = (typeof DISPATCHES)[number]['dispatch'];

/** One sender's lane: a runtime that dequeues its own held rows, over a memory backend a test reads rows from. */
interface SenderFenceLane {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly backend: ALAdmissionWorkBackend;
    readonly planner: ALOutboundPlanner<OutboundTestPayload>;
}

/** The dispatch under test, every commit before it made: what it decides on, and the commit that runs it. */
interface ArrangedDispatch {
    readonly lane: SenderFenceLane;
    readonly dispatch: ALOutboundDispatchAdmission.Input<OutboundTestPayload>;
    run(): Promise<void>;
}

/** The two versions a dispatch's commit may move: its sender's, and its message's own. An absent row reads 0. */
interface DispatchVersions {
    readonly sender: number;
    readonly message: number;
}

/** A first admission holds its copy, so its dequeue dispatches it; every later plan sends one copy. */
function toHeldThenSentPlanner(
    extend: Partial<ReturnType<ALOutboundPlanner<OutboundTestPayload>>> = {}
): ALOutboundPlanner<OutboundTestPayload> {
    return (msg, authority) => ({
        msg,
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: authority === undefined ? [] : [{ peer: 'receiver' }],
        ...extend
    });
}

/** Every plan sends one copy at once. */
function toSentPlanner(
    extend: Partial<ReturnType<ALOutboundPlanner<OutboundTestPayload>>> = {}
): ALOutboundPlanner<OutboundTestPayload> {
    return (msg) => ({ msg, dropReasonCode: undefined, lane: 'durable', preparedMessages: [{ peer: 'receiver' }], ...extend });
}

const REPAIRED_PLANNER = toSentPlanner({ repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 1 } });

function createSenderFenceLane(
    planner: ALOutboundPlanner<OutboundTestPayload>,
    orderingHeadNamespace?: string
): SenderFenceLane {
    const outbox = new InMemoryQueueBox(new Map());
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), Date.now);
    const stores = createDefaultInMemoryALOutboundRuntimeStores({
        outboundBackend: backend,
        namespace: NAMESPACE,
        canonicalScope: NAMESPACE,
        orderingHeadNamespace,
        decodePrepared: decodeOutboundTestPayload
    });
    const runtime = createOutboundTestRuntimeFor({
        stores,
        outbox,
        decodePreparedMessage: decodeOutboundTestPayload,
        dequeue: { types: new Set([OUTBOX_TYPE]), resilience: createDefaultALOutboundDequeueResilience() },
        planOutgoingMessage: planner,
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    return { runtime, stores, backend, planner };
}

async function readDispatchVersions(lane: SenderFenceLane, msg: ALMessage): Promise<DispatchVersions> {
    const namespace = lane.stores.admissionStore.namespace;
    const { senderId, msgId } = msg.id;
    const [sender, message] = await Promise.all([
        lane.backend.read(toALOutboundVersionKey(namespace, senderId), (value) => decodeALAdmissionClientRecord(value, senderId).version),
        lane.backend.read(
            toALOutboundOriginMessageKey({ row: 'msg-version', namespace, originPeerId: senderId, msgId }),
            (value) => decodeALOutboundMessageVersion(value, msgId).version
        )
    ]);
    return { sender: sender ?? 0, message: message ?? 0 };
}

/** The read and the bundle the admission decides `dispatch` on, read from the store before it commits. */
async function readDispatchDecision(
    lane: SenderFenceLane,
    dispatch: ALOutboundDispatchAdmission.Input<OutboundTestPayload>
): Promise<{ read: ALOutboundMessageReadDto<OutboundTestPayload>; bundle: ALOutboundCommitBundle<OutboundTestPayload> | undefined; }> {
    const store = lane.stores.admissionStore;
    const read = await store.readOutgoingMessage({
        msg: dispatch.msg,
        planner: dispatch.planner,
        observedCanonicalEntry: dispatch.options.observedOutboxEntry,
        intent: dispatch.intent,
        stampsAppliedSupersedence: dispatch.intent === 'enqueue',
        repairAttempt: dispatch.options.repairBudget === undefined
            ? undefined
            : { attemptIdentity: dispatch.options.attemptIdentity!, phase: dispatch.phase }
    });
    const computed = computeALOutboundDispatch({
        read,
        outboxEntry: read.canonicalEntry ?? createOutboundCanonicalEntry(store, read.msg, Temporal.Now.instant()),
        dispatchAtMs: Date.now(),
        intent: dispatch.intent,
        phase: dispatch.phase,
        options: dispatch.options
    });
    return { read, bundle: computed.bundle };
}

function toEnqueue(lane: SenderFenceLane, msg: ALMessage): ArrangedDispatch {
    return {
        lane,
        dispatch: { msg, batchPredecessorSeqs: [], planner: lane.planner, intent: 'enqueue', phase: 'immediate', origin: 'send', options: {} },
        run: async () => {
            await lane.runtime.enqueueIfAbsent(msg);
        }
    };
}

/** The dequeue of the row `entry`, as the lane's claim hands it to the admission. */
function toDequeue(lane: SenderFenceLane, msg: ALMessage, entry: ResourceEntry): ArrangedDispatch {
    return {
        lane,
        dispatch: {
            msg,
            batchPredecessorSeqs: [],
            planner: lane.planner,
            intent: 'dequeue',
            phase: 'dequeue',
            origin: 'drain',
            options: { observedOutboxEntry: entry, claimedOutboxEntry: entry, attemptIdentity: 'sender-fence-dequeue' }
        },
        run: async () => {
            await runOutboundWorkTask(lane.runtime);
        }
    };
}

/** Admits `msg` held, then answers the dequeue of the canonical row that admission wrote. */
async function toAdmittedDequeue(lane: SenderFenceLane, msg: ALMessage): Promise<ArrangedDispatch> {
    await lane.runtime.enqueueIfAbsent(msg);
    const read = await lane.stores.admissionStore.readOutgoingMessage({
        msg,
        planner: lane.planner,
        observedCanonicalEntry: undefined,
        intent: 'dequeue',
        stampsAppliedSupersedence: false
    });
    return toDequeue(lane, read.sentSnapshot?.msg ?? msg, read.canonicalEntry!);
}

/** Writes `msg` as a raw outbox row, as a producer writes a server publication, for the lane's dequeue to admit first. */
async function toRawDequeue(lane: SenderFenceLane, msg: ALMessage): Promise<ArrangedDispatch> {
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(msg, OUTBOX_TYPE, Temporal.Now.instant());
    await lane.stores.workQueue.enqueue(entry);
    return toDequeue(lane, msg, entry);
}

/** The repair of an admitted message by a hint that names no range: the message the hint names is repaired. */
function toRepair(lane: SenderFenceLane, msg: ALMessage, attemptIdentity: string): ArrangedDispatch {
    const retransmission = new ALOutboundRepairRetransmission<OutboundTestPayload>({
        admissionStore: lane.stores.admissionStore,
        dispatchAdmission: new ALOutboundDispatchAdmission({
            lane: 'durable',
            admissionStore: lane.stores.admissionStore,
            toOutboxEntry: (planned) => QueueBoxUtilities.toResourceEntryFromMsg(planned, OUTBOX_TYPE, Temporal.Now.instant()),
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            signAdmittedMessage: undefined,
            diagnostics: undefined,
            settlements: () => {}
        }),
        planOutgoingMessage: lane.planner,
        planRepairMessage: undefined,
        hopPeerIds: undefined,
        settlements: () => {}
    });
    const hint: ALOutboundRepairHint = { trigger: 'repair', requestedByPeerId: 'peer-1', missingRanges: [], failedPeerIds: [] };
    return {
        lane,
        dispatch: {
            msg,
            batchPredecessorSeqs: [],
            planner: lane.planner,
            intent: 'repair',
            phase: 'immediate',
            origin: 'repair',
            options: { repairBudget: { requesterKey: 'peer-1', maxAttempts: 1 }, attemptIdentity }
        },
        run: async () => {
            await retransmission.retransmitFromRepairHint(msg.id.msgId, hint, attemptIdentity);
        }
    };
}

/** Admits `msg` and sends it, so its stored row is what a repair reads. */
async function admitAndSend(lane: SenderFenceLane, msg: ALMessage): Promise<ALMessage> {
    const admitted = await lane.runtime.enqueueIfAbsent(msg);
    expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
    await runOutboundWorkTask(lane.runtime);
    return admitted.message;
}

/** The WS server's receipt control to the origin of a message, which outlives the receipt's deadline. */
function createReceiptControl(): ALMessage {
    const receipt = createServerReceipt(createOutboundMessage('subject'), 'admitted', ['peer-1']);
    return { ...receipt, constraints: { expiresAtMs: Date.now() + 30_000 } };
}

function createKeyedMessage(resourceId: string, ordering: ALMessage['ordering']): ALMessage {
    return { ...createOutboundMessage(resourceId), ordering };
}

/** A room frame to `recipients` on the track `feed`, sequence `seq`. */
function createFeedFrame(resourceId: string, seq: number, recipients: readonly string[]): ALMessage {
    return {
        ...createOutboundMessage(resourceId),
        targets: { mode: 'multicast', groupRef: ROOM, recipientPeerIds: recipients, snapshotVersion: 1 },
        ordering: { orderingKey: 'feed', epoch: 1, seq }
    };
}

const SCENARIOS: Readonly<Record<DispatchName, () => Promise<ArrangedDispatch>>> = {
    'a receipt control, enqueued': async () => toEnqueue(createSenderFenceLane(toHeldThenSentPlanner()), createReceiptControl()),
    'a receipt control, dequeued': async () => await toAdmittedDequeue(createSenderFenceLane(toHeldThenSentPlanner()), createReceiptControl()),
    'a handed-off control, enqueued and dequeued': async () => {
        const ack = toOutboundTestAck(createOutboundMessage('subject'), 'server');
        const handedOff = { ...ack, constraints: { ...ack.constraints, expiresAtMs: Date.now() + 30_000 } };
        return await toAdmittedDequeue(createSenderFenceLane(toHeldThenSentPlanner()), handedOff);
    },
    'a message on no track and under no supersedence key, enqueued': async () =>
        toEnqueue(createSenderFenceLane(toSentPlanner()), createOutboundMessage('plain')),
    'that message, dequeued': async () => await toAdmittedDequeue(createSenderFenceLane(toHeldThenSentPlanner()), createOutboundMessage('plain')),
    'that message, repaired': async () => {
        const lane = createSenderFenceLane(REPAIRED_PLANNER);
        return toRepair(lane, await admitAndSend(lane, createOutboundMessage('plain')), 'repair-first');
    },
    'a message with an ordering key and no sequence, on a plan that mints none': async () =>
        toEnqueue(createSenderFenceLane(toSentPlanner()), createKeyedMessage('keyed', { orderingKey: 'feed', epoch: 1 })),
    'a message minting the next sequence of a track it owns': async () =>
        toEnqueue(createSenderFenceLane(toSentPlanner({ mintsSequence: true })), createKeyedMessage('minted', { orderingKey: 'feed', epoch: 1 })),
    'a message stating a sequence above its track\'s head': async () =>
        toEnqueue(createSenderFenceLane(toSentPlanner({ mintsSequence: true })), createKeyedMessage('stated', { orderingKey: 'feed', epoch: 1, seq: 5 })),
    'a sequenced message on a shared head that records no recipient': async () =>
        toEnqueue(
            createSenderFenceLane(toSentPlanner({ mintsSequence: true }), `${NAMESPACE}-ordering`),
            createFeedFrame('shared-head', 1, ['peer-1'])
        ),
    'a tracked row dequeued again, its positions recorded': async () => {
        const recording: ALOutboundPlanner<OutboundTestPayload> = (msg, authority) => ({
            ...toHeldThenSentPlanner()(msg, authority),
            recordsSentPositions: ['peer-1']
        });
        return await toAdmittedDequeue(createSenderFenceLane(recording), createFeedFrame('recorded', 1, ['peer-1']));
    },
    'a tracked row recording its recipients\' positions at its first dequeue': async () => {
        const recordingAtDequeue: ALOutboundPlanner<OutboundTestPayload> = (msg, authority) => ({
            ...toHeldThenSentPlanner()(msg, authority),
            recordsSentPositions: authority === undefined ? undefined : ['peer-1']
        });
        return await toAdmittedDequeue(createSenderFenceLane(recordingAtDequeue), createFeedFrame('recorded-at-dequeue', 1, ['peer-1']));
    },
    'a tracked message, repaired': async () => {
        const lane = createSenderFenceLane(REPAIRED_PLANNER);
        return toRepair(lane, await admitAndSend(lane, createKeyedMessage('tracked', { orderingKey: 'feed', epoch: 1, seq: 1 })), 'repair-first');
    },
    'a tracked message that names no deadline, minting': async () => {
        throw new Error('A message that names no deadline is refused before any bundle exists');
    },
    'a message under a supersedence key': async () =>
        toEnqueue(
            createSenderFenceLane(toSentPlanner({ supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' } })),
            createOutboundMessage('superseding')
        ),
    'a group-state delta, first dispatched at its dequeue': async () => {
        const [entry] = computeGroupStateSyncEntries(createGroupDeltaStateSync({ nowMs: Date.now(), traceId: 'trace-delta' }), 'server');
        return await toRawDequeue(createSenderFenceLane(toSentPlanner()), decodePersistedALMessage(entry!.resource));
    },
    'a client-state event, first dispatched at its dequeue': async () => {
        const [entry] = computeClientStateSyncEntries(createClientEventStateSync({ nowMs: Date.now(), traceId: 'trace-event' }), 'server');
        return await toRawDequeue(createSenderFenceLane(toSentPlanner()), entry!.message);
    },
    'a dispatch that ends its message: a spent repair budget': async () => {
        const lane = createSenderFenceLane(REPAIRED_PLANNER);
        const message = await admitAndSend(lane, createOutboundMessage('spent'));
        await toRepair(lane, message, 'repair-first').run();
        return toRepair(lane, message, 'repair-second');
    },
    'a dispatch that ends its message: a re-plan refused for good at its dequeue': async () => {
        const refusedAtDequeue: ALOutboundPlanner<OutboundTestPayload> = (msg, authority) => ({
            ...toHeldThenSentPlanner()(msg, authority),
            ...(authority === undefined ? {} : { dropReasonCode: 'no-publish-grant', dropReason: 'The grant was revoked.' })
        });
        return await toAdmittedDequeue(createSenderFenceLane(refusedAtDequeue), createOutboundMessage('refused'));
    }
};

const NO_DEADLINE: DispatchName = 'a tracked message that names no deadline, minting';

/** What a row's name says its decision read or its commit did, beyond the two versions. */
const DISPATCH_FACTS: Partial<
    Record<DispatchName, (read: ALOutboundMessageReadDto<OutboundTestPayload>, stored: ALStoredOutboundMessage | undefined) => void>
> = {
    'a sequenced message on a shared head that records no recipient': (read) => {
        expect(read.orderingHead?.roomSentFloor, 'the read reads its room sent floor').toBeDefined();
    },
    'a tracked row dequeued again, its positions recorded': (read) => {
        expect(read.orderingHead, 'the read moves no head').toBeUndefined();
        expect(read.sentPositions, 'the read records no position').toBeUndefined();
    },
    'a dispatch that ends its message: a spent repair budget': (_read, stored) => {
        expect(stored?.ended, 'the stored row reads the message ended').toBe(true);
    },
    'a dispatch that ends its message: a re-plan refused for good at its dequeue': (_read, stored) => {
        expect(stored?.ended, 'the stored row reads the message ended').toBe(true);
    }
};

describe('the sender version a dispatch\'s commit moves', () => {
    it.each(DISPATCHES.filter((row) => row.dispatch !== NO_DEADLINE))('$dispatch: the sender version is $sender', async ({ dispatch, sender }) => {
        // Pins every dispatch of a message that reads no row its sender's other messages share competing for its
        // sender's one version row, and a dispatch that reads one, or ends its message, no longer fencing on it.
        const arranged = await SCENARIOS[dispatch]();
        const { read, bundle } = await readDispatchDecision(arranged.lane, arranged.dispatch);
        const before = await readDispatchVersions(arranged.lane, arranged.dispatch.msg);

        await arranged.run();

        const after = await readDispatchVersions(arranged.lane, arranged.dispatch.msg);
        expect(bundle, 'the decision commits a bundle').toBeDefined();
        if (read.orderingHead !== undefined || read.sentPositions !== undefined) {
            expect(bundle!.fencesSender).toBe(true);
        }
        expect(bundle!.fencesSender).toBe(sender === 'moved');
        expect(after.sender - before.sender).toBe(sender === 'moved' ? 1 : 0);
        if (sender === 'unmoved') {
            // No commit the lane made for this message, its admission and its sends included, wrote its sender's row.
            expect(after.sender).toBe(0);
        }
        expect(after.message - before.message).toBe(1);
        DISPATCH_FACTS[dispatch]?.(read, await arranged.lane.stores.admissionStore.readStoredMessage(arranged.dispatch.msg.id.msgId));
    });

    it(`${NO_DEADLINE}: the read refuses it before a bundle exists`, async () => {
        // The case cannot arise: a message that names no deadline is refused by its plan's validation, so no bundle,
        // and no track row, exists for it to fence.
        const lane = createSenderFenceLane(toSentPlanner({ mintsSequence: true }));
        const keyed = createKeyedMessage('no-deadline', { orderingKey: 'feed', epoch: 1 });
        const message: ALMessage = { ...keyed, constraints: undefined, qos: undefined };

        await expect(readDispatchDecision(lane, toEnqueue(lane, message).dispatch))
            .rejects.toThrow('Outbound planned message changes original authority or deadline');
        expect((await lane.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'failed' });
        expect(await readDispatchVersions(lane, message)).toEqual({ sender: 0, message: 0 });
    });
});

describe('whether a dispatch read a row its sender\'s messages share', () => {
    it('is false for a message with no ordering key and a read with no supersedence key', () => {
        expect(hasALOutboundSenderSharedRead({ msg: createOutboundMessage('plain'), supersedence: {} })).toBe(false);
    });

    it('is true for a message that holds a sequence on a track', () => {
        const msg = createKeyedMessage('tracked', { orderingKey: 'feed', epoch: 1, seq: 1 });

        expect(hasALOutboundSenderSharedRead({ msg, supersedence: {} })).toBe(true);
    });

    it('is false for a message that names an ordering key and no sequence', () => {
        const msg = createKeyedMessage('keyed', { orderingKey: 'feed', epoch: 1 });

        expect(hasALOutboundSenderSharedRead({ msg, supersedence: {} })).toBe(false);
    });

    it('is true for a read that holds a supersedence key, whatever the message orders', () => {
        expect(hasALOutboundSenderSharedRead({ msg: createOutboundMessage('plain'), supersedence: { key: 'shared-topic' } })).toBe(true);
    });
});
