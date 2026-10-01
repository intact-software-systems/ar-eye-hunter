import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { expect, onTestFinished, vi } from 'vitest';

import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALDeliveryCarrier, ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID, type ALStorageResetListeners } from '@shared/alm/open-indexed-db-admission-database.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { computeALOutboundDispatch, type ALOutboundComputeIntent } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import {
    ALOutboundMessageRuntime,
    createALOutboundAdmissionStore,
    createInMemoryALAdmissionState,
    EntityStatus,
    InMemoryQueueBox,
    newALUnicastMessage,
    QueueBoxUtilities,
    type ALMessage,
    type ALOutboundAdmissionStore,
    type ResourceEntry
} from '@shared/mod.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import type {
    ALOutboundEffectSnapshot,
    ALOutboundPlanner,
    ALOutboundPreparedMessageDecoder
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    readALOutboundWorkReadyAt,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';
import {
    createALWorkQueuePort,
    type ALWorkOutcome,
    type ALWorkQueuePort
} from '@shared/alm/work/al-work-queue-port.ts';
import type { IndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';

import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

/**
 * How long after its lease end an outbound lane recovers a crashed lease or an exhausted row at worst:
 * a sweep closes its window for 1.25 leases (the limiter counts in quarter-window buckets), then the
 * remembered readiness answer ages for 3 s and the idle engine waits at most 3.6 s for its next pass.
 */
export const OUTBOUND_LEASE_RECOVERY_BOUND_MS = 19_100;

interface OutboundTestRuntimeInput<TPrepared> {
    readonly queueEngine?: InboxOutboxEngine;
    readonly outbox?: InMemoryQueueBox;
    readonly stores?: ALOutboundRuntimeStores<TPrepared>;
    /** The memory pair a volatile plan is admitted to; absent, every admission uses `stores`. */
    readonly volatileStores?: ALVolatileOutboundRuntimeStores<TPrepared>;
    readonly dequeue?: ALOutboundMessageRuntime.DequeueSource;
    readonly diagnostics?: ALOutboundRuntimeDiagnosticsSink;
    /** The carrier every settlement this runtime states is stamped with; `ws` unless a test says otherwise. */
    readonly carrier?: ALDeliveryCarrier;
    readonly settlements?: ALDeliverySettlementSink;
    readonly nowMs?: () => number;
    readonly planOutgoingMessage: ALOutboundMessageRuntime.Dependencies<TPrepared>['planOutgoingMessage'];
    readonly planRepairMessage?: ALOutboundMessageRuntime.Dependencies<TPrepared>['planRepairMessage'];
    readonly afterDequeueAdmission?: ALOutboundMessageRuntime.Dependencies<TPrepared>['afterDequeueAdmission'];
    readonly sendPreparedMessage: ALOutboundMessageRuntime.Dependencies<TPrepared>['sendPreparedMessage'];
}

interface OutboundTestRuntimeInputFor<TPrepared> extends OutboundTestRuntimeInput<TPrepared> {
    readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
    readonly stores: ALOutboundRuntimeStores<TPrepared>;
}

/** Wakes a caller-supplied engine and runs one pass, forcing a registered task's due work now. */
export async function drainEngine(engine: InboxOutboxEngine): Promise<void> {
    engine.wake();
    await engine.executeOnce();
}

/**
 * Spies on a caller-supplied, not-yet-constructed engine and returns a function that invokes the
 * outbound runtime's own registered task exactly once, direct, the way the deleted `dequeueOutbox`/
 * `dequeue` methods did. `InboxOutboxEngine.executeOnce` instead loops a task's `runnable` while its
 * own `isWork()` stays true, which can drive extra attempts a single-attempt assertion does not
 * expect; call this before constructing the runtime so the `includeTask` registration is observed.
 */
export function captureOutboundWorkRunnable(engine: InboxOutboxEngine): () => Promise<void> {
    const includeTask = vi.spyOn(engine, 'includeTask');
    return async () => {
        const registrations = includeTask.mock.calls.filter(([name]) => name.startsWith('al-outbound:'));
        if (registrations.length === 0) {
            throw new Error('Expected the outbound runtime to have registered its own work task');
        }
        for (const [, registration] of registrations) {
            await registration.runnable();
        }
    };
}

/**
 * The outbound work task each fixture-built runtime registered, so a test can run one batch of that
 * runtime's own work directly. The runtime owns no drain method: the engine task is the only entry.
 */
const outboundWorkBatches = new WeakMap<object, () => Promise<void>>();

/** Runs one batch of this runtime's registered work task, the way an engine tick would. */
export async function runOutboundWorkTask(runtime: object): Promise<void> {
    const runBatch = outboundWorkBatches.get(runtime);
    if (runBatch === undefined) {
        throw new Error('Expected a fixture-built outbound runtime with a registered work task');
    }
    await runBatch();
}

/** Admits a message and runs the one batch its owner owes for the work the admission committed. */
export async function enqueueOutboundOrThrow(
    runtime: Pick<ALOutboundMessageRuntime<OutboundTestPayload>, 'enqueueIfAbsent'>,
    msg: ALMessage
): Promise<readonly ResourceEntry[]> {
    const enqueued = await runtime.enqueueIfAbsent(msg);
    const { verdict } = enqueued;
    if (verdict.kind === 'failed' || (verdict.kind === 'refused' && verdict.reason !== 'unauthorized')) {
        throw new Error(enqueued.reason);
    }
    await runOutboundWorkTask(runtime);

    return enqueued.entries;
}

export async function reserveOutbox(outbox: InMemoryQueueBox): Promise<readonly ResourceEntry[]> {
    return [
        ...(
            await outbox.reserveEntries({ typeIds: new Set(['outbox']), statusIds: new Set([EntityStatus.NEW]), reservationInput: 10 })
        ).values()
    ];
}

export function createDefaultOutboundTestRuntime(
    options: OutboundTestRuntimeInput<OutboundTestPayload>
): ALOutboundMessageRuntime<OutboundTestPayload> {
    const outbox = options.outbox ?? new InMemoryQueueBox(new Map());
    return createOutboundTestRuntimeFor({
        ...options,
        outbox,
        stores: options.stores ?? createDefaultOutboundTestStores(outbox),
        decodePreparedMessage: decodeOutboundTestPayload
    });
}

/** The same runtime for a caller whose stores carry another prepared contract (browser transport copies). */
export function createOutboundTestRuntimeFor<TPrepared>(
    options: OutboundTestRuntimeInputFor<TPrepared>
): ALOutboundMessageRuntime<TPrepared> {
    const runtime = createOutboundRuntimeWithWorkTask(() =>
        createDefaultALOutboundMessageRuntime<TPrepared>({
            decodePreparedMessage: options.decodePreparedMessage,
            queueEngine: options.queueEngine,
            outbox: options.outbox ?? new InMemoryQueueBox(new Map()),
            stores: options.stores,
            volatileStores: options.volatileStores,
            dequeue: options.dequeue,
            diagnostics: options.diagnostics,
            carrier: options.carrier ?? 'ws',
            settlements: options.settlements,
            nowMs: options.nowMs ?? Date.now,
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            planOutgoingMessage: options.planOutgoingMessage,
            planRepairMessage: options.planRepairMessage,
            afterDequeueAdmission: options.afterDequeueAdmission,
            sendPreparedMessage: options.sendPreparedMessage
        })
    );
    onTestFinished(() => runtime.dispose());
    return runtime;
}

/**
 * Builds a runtime whose registered work task `runOutboundWorkTask` can run. Spying on the prototype
 * keeps the runtime's own engine ownership intact, which supplying an engine would not; a test that
 * constructs its runtime directly wraps that construction in this.
 */
export function createOutboundRuntimeWithWorkTask<TPrepared>(
    create: () => ALOutboundMessageRuntime<TPrepared>
): ALOutboundMessageRuntime<TPrepared> {
    const runnables: (() => void | Promise<void>)[] = [];
    const includeTask = InboxOutboxEngine.prototype.includeTask;
    const spy = vi.spyOn(InboxOutboxEngine.prototype, 'includeTask').mockImplementation(function (
        this: InboxOutboxEngine,
        id,
        task
    ) {
        if (id.startsWith('al-outbound:')) {
            runnables.push(task.runnable);
        }
        return includeTask.call(this, id, task);
    });
    let runtime: ALOutboundMessageRuntime<TPrepared>;
    try {
        runtime = create();
    }
    finally {
        spy.mockRestore();
    }
    if (runnables.length === 0) {
        throw new Error('Expected the outbound runtime to register its own work task');
    }
    // Every lane in registration order: the durable lane first, then the volatile one.
    outboundWorkBatches.set(runtime, async () => {
        for (const runnable of runnables) {
            await runnable();
        }
    });
    return runtime;
}

/** The work port an outbound owner builds for one admission scope, for tests that drive work directly. */
export function createOutboundWorkPort(
    workQueue: QueueBoxResourceEntryRepository,
    namespace: string,
    dequeueTypes: ReadonlySet<string> = new Set<string>()
): ALWorkQueuePort {
    return createALWorkQueuePort({
        queue: workQueue,
        workTypes: new Set([toALOutboundWorkType(namespace), ...dequeueTypes]),
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        nowMs: Date.now,
        random: Math.random,
        leaseRecovery: createLimitedALWorkLeaseRecovery(AL_OUTBOUND_WORK_LEASE_MS, Date.now())
    });
}

/** The readiness the outbound owner advertises with every gate open: undefined once work is drained. */
export async function peekOutboundWorkReadyAt(
    workQueue: QueueBoxResourceEntryRepository,
    namespace: string
): Promise<number | undefined> {
    return await readALOutboundWorkReadyAt(
        createOutboundWorkPort(workQueue, namespace),
        Date.now(),
        {
            dequeue: { types: new Set<string>(), readyAtMs: undefined },
            leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true }
        }
    );
}

/** Claims and decodes work the way the owner's batch does. */
export async function claimOutboundTestWork<TPrepared>(
    stores: ALOutboundRuntimeStores<TPrepared>,
    maxCount: number
): Promise<readonly ALOutboundEffectSnapshot<TPrepared>[]> {
    const port = createOutboundWorkPort(stores.workQueue, stores.admissionStore.namespace);
    const claims = await port.claim({ maxCount, observedEntries: undefined });
    return await Promise.all(claims.map((claim) => stores.admissionStore.readWorkSnapshot(claim.entry, undefined)));
}

/** Releases one claimed row the way the owner's attempt does. */
export async function releaseOutboundTestWork<TPrepared>(
    stores: ALOutboundRuntimeStores<TPrepared>,
    entry: ResourceEntry,
    outcome: ALWorkOutcome
): Promise<void> {
    const port = createOutboundWorkPort(stores.workQueue, stores.admissionStore.namespace);
    await port.releaseAll([{ claim: { entry, attempts: entry.dequeueAudit.attempts, leaseUntilMs: Date.now() }, outcome: outcome }]);
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(predicate()).toBe(true);
}

/** The store bundle plus the backend it was built over, so a test can fail one commit at its source. */
export interface OutboundTestStores extends ALOutboundRuntimeStores<OutboundTestPayload> {
    readonly backend: InMemoryAdmissionBackend;
}

/** The memory pair a runtime routes its volatile admissions to. */
export function createVolatileOutboundTestStores(): ALVolatileOutboundRuntimeStores<OutboundTestPayload> {
    return createVolatileALOutboundRuntimeStores({ decodePrepared: decodeOutboundTestPayload }, undefined);
}

export function createDefaultOutboundTestStores(outbox?: InMemoryQueueBox): OutboundTestStores {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), Date.now);
    return {
        admissionStore: createALOutboundAdmissionStore({
            decodePrepared: decodeOutboundTestPayload,
            nowMs: Date.now,
            namespace: 'outbound-test',
            canonicalScope: 'outbound-test',
            supersedenceTrackTtlMs: 5 * 60_000,
            backend,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue,
        backend
    };
}

const HELD_CLAIM_QUIET_ATTEMPT_LIMIT = 50;

/**
 * Holds every claim the queue can offer, so a runtime commits work it never drains. The spy is the
 * queue's own reservation, which is the only place a claim can be denied.
 */
export function holdOutboundClaims<TPrepared>(
    stores: ALOutboundRuntimeStores<TPrepared>
): { release(): Promise<void>; } {
    const reserved = vi.spyOn(stores.workQueue, 'reserveEntries').mockResolvedValue(new Map());
    const recovered = vi.spyOn(stores.workQueue, 'reserveTimeoutEntries').mockResolvedValue(new Map());
    return {
        /**
         * Restores real claims only once no held batch is still asking for work: a batch that
         * claimed after the restore would strand its rows in a reservation nobody releases.
         */
        release: async () => {
            let observed = -1;
            for (
                let attempt = 0;
                attempt < HELD_CLAIM_QUIET_ATTEMPT_LIMIT && observed !== reserved.mock.calls.length;
                attempt += 1
            ) {
                observed = reserved.mock.calls.length;
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            expect(reserved.mock.calls.length).toBe(observed);
            reserved.mockRestore();
            recovered.mockRestore();
        }
    };
}

export function createOutboundMessage(
    resourceId: string,
    options?: { ttlMs?: number; }
) {
    return newALUnicastMessage(
        'self',
        {
            topicId: 'chat',
            resourceId,
            contextId: 'conversation-1'
        },
        'peer-1',
        'chat.private-text.v1',
        {
            text: resourceId
        },
        { ttlMs: options?.ttlMs ?? 30_000 }
    );
}

export function firstValue<K, V>(map: Map<K, V>): V {
    const first = map.values().next().value;
    if (first === undefined) {
        throw new Error('Expected at least one map value');
    }
    return first;
}

export function createOutboundCanonicalEntry<TPrepared>(
    store: ALOutboundAdmissionStore<TPrepared>,
    msg: ALMessage
): ResourceEntry {
    return { ...QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'), key: toALOutboundCanonicalKey(store.canonicalScope, msg) };
}

export async function computeOutboundTestAdmission<TPrepared>(
    store: ALOutboundAdmissionStore<TPrepared>,
    message: ALMessage,
    planner: ALOutboundPlanner<TPrepared> = (msg) => ({ msg, dropReasonCode: undefined, persist: true, preparedMessages: [] })
) {
    const read = await store.readOutgoingMessage({
        msg: message,
        planner,
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    const computed = computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(store, read.msg),
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    });
    if (!computed.bundle) {
        throw new Error(`Expected outbound admission, received ${computed.verdict.kind}`);
    }
    return computed.bundle;
}

/** A `hop` receipt expecting these peers, each its own next hop. */
export function trackOutboundTestAcks(expectedPeerIds: readonly string[]): ALOutboundAckTrackingPlan {
    return { enabled: true, timeoutMs: 60_000, maxAttempts: 3, expectedPeerIds, nextHopPeerIds: expectedPeerIds, mode: 'hop' };
}

/** A v2 ACK one peer states for a message `self` originated over WS. */
export function toOutboundTestAck(message: ALMessage, fromPeerId: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `control-${fromPeerId}`, ts: 1, senderId: fromPeerId },
        {
            ackedMsgId: message.id.msgId,
            originPeerId: 'self',
            logicalRecipientPeerId: fromPeerId,
            fromPeerId,
            toPeerId: 'self',
            status: 'accepted',
            observedAtEpochMs: 1,
            carrier: 'ws'
        }
    );
}

export interface IndexedDbOutboundTestStoresInput {
    readonly observer: IndexedDbOperationObserver;
    /** The admission namespace and canonical scope of the pair. */
    readonly namespace: string;
    /** A database another pair shares, as a second tab would; absent, the pair opens one of its own. */
    readonly dbName?: string;
    readonly storageResets?: ALStorageResetListeners;
}

/** A durable outbound pair over fake-indexeddb, reporting every logical operation to `observer`. */
export function createIndexedDbOutboundTestStores(
    input: IndexedDbOutboundTestStoresInput
): ALOutboundRuntimeStores<OutboundTestPayload> {
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: input.dbName ?? `${input.namespace}-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: input.observer
    });
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: input.namespace,
            decodePrepared: decodeOutboundTestPayload,
            namespace: input.namespace,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue,
        storageResets: input.storageResets
    };
}

/** One durable copy to a single peer, with no ack, retry or supersedence tracking. */
export const OUTBOUND_TEST_SEND_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    persist: true,
    preparedMessages: [{ peer: 'receiver' }]
});

/**
 * A runtime that sends with `OUTBOUND_TEST_SEND_PLANNER` and records each canonical message its
 * carrier ran; like every fixture-built runtime it is disposed when the test finishes.
 */
export function createRecordingOutboundTestRuntime(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    sent: ALMessage[]
): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores,
        planOutgoingMessage: OUTBOUND_TEST_SEND_PLANNER,
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage);
            return { status: 'sent', submissionAttempted: true };
        }
    });
}
