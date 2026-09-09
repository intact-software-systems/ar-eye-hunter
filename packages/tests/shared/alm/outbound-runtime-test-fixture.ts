import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { expect, onTestFinished } from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALOutboundRuntimeDiagnosticsSink, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
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
import type { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import type { ALOutboundPreparedMessageDecoder } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    readALOutboundWorkReadyAt,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    createALWorkQueuePort,
    type ALWorkClaim,
    type ALWorkOutcome,
    type ALWorkQueuePort
} from '@shared/alm/work/al-work-queue-port.ts';

import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

interface OutboundTestRuntimeInput<TPrepared> {
    readonly queueEngine?: InboxOutboxEngine;
    readonly outbox?: InMemoryQueueBox;
    readonly stores?: ALOutboundRuntimeStores<TPrepared>;
    readonly dequeue?: ALOutboundMessageRuntime.DequeueSource;
    readonly diagnostics?: ALOutboundRuntimeDiagnosticsSink;
    readonly nowMs?: () => number;
    readonly planOutgoingMessage: ALOutboundMessageRuntime.Dependencies<TPrepared>['planOutgoingMessage'];
    readonly planRepairMessage?: ALOutboundMessageRuntime.Dependencies<TPrepared>['planRepairMessage'];
    readonly sendPreparedMessage: ALOutboundMessageRuntime.Dependencies<TPrepared>['sendPreparedMessage'];
}

interface OutboundTestRuntimeInputFor<TPrepared> extends OutboundTestRuntimeInput<TPrepared> {
    readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
    readonly stores: ALOutboundRuntimeStores<TPrepared>;
}

export async function enqueueOutboundOrThrow(
    runtime: Pick<ALOutboundMessageRuntime<OutboundTestPayload>, 'enqueueIfAbsent'>,
    msg: ALMessage
): Promise<readonly ResourceEntry[]> {
    const enqueued = await runtime.enqueueIfAbsent(msg);
    if (enqueued.status === 'failed') {
        throw new Error(enqueued.reason);
    }

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
    const runtime = createDefaultALOutboundMessageRuntime<TPrepared>({
        decodePreparedMessage: options.decodePreparedMessage,
        queueEngine: options.queueEngine,
        outbox: options.outbox ?? new InMemoryQueueBox(new Map()),
        stores: options.stores,
        dequeue: options.dequeue,
        diagnostics: options.diagnostics,
        nowMs: options.nowMs ?? Date.now,
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: options.planOutgoingMessage,
        planRepairMessage: options.planRepairMessage,
        sendPreparedMessage: options.sendPreparedMessage
    });
    onTestFinished(() => runtime.dispose());
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
        random: Math.random
    });
}

/** The readiness the outbound owner advertises: undefined once its work is drained. */
export async function peekOutboundWorkReadyAt(
    workQueue: QueueBoxResourceEntryRepository,
    namespace: string
): Promise<number | undefined> {
    return await readALOutboundWorkReadyAt(createOutboundWorkPort(workQueue, namespace), Date.now());
}

/** Claims work the way the owner does, decoding each row through the store. */
export async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(predicate()).toBe(true);
}

/** Test-only index from a store to the queue its owner would build a work port over. */
const workQueuesByStore = new WeakMap<object, QueueBoxResourceEntryRepository>();

export function rememberOutboundTestWorkQueue<TPrepared>(
    stores: ALOutboundRuntimeStores<TPrepared>
): ALOutboundRuntimeStores<TPrepared> {
    workQueuesByStore.set(stores.admissionStore, stores.workQueue);
    return stores;
}

function readOutboundTestWorkQueue<TPrepared>(
    store: ALOutboundAdmissionStore<TPrepared>
): QueueBoxResourceEntryRepository {
    const queue = workQueuesByStore.get(store);
    if (queue === undefined) {
        throw new Error('Outbound test store was not created through the fixture');
    }
    return queue;
}

/** The stores bundle an owner needs, recovered from a store the fixture created. */
export function toOutboundTestStores<TPrepared>(
    admissionStore: ALOutboundAdmissionStore<TPrepared>
): ALOutboundRuntimeStores<TPrepared> {
    return { admissionStore, workQueue: readOutboundTestWorkQueue(admissionStore) };
}

/** The readiness the owner would advertise for this store: undefined once its work is drained. */
export async function peekOutboundTestWorkReadyAt<TPrepared>(
    store: ALOutboundAdmissionStore<TPrepared>
): Promise<number | undefined> {
    return await peekOutboundWorkReadyAt(readOutboundTestWorkQueue(store), store.namespace);
}

/** Claims and decodes work the way the owner does. */
export async function claimOutboundTestWork<TPrepared>(
    store: ALOutboundAdmissionStore<TPrepared>,
    maxCount: number
): Promise<readonly ALWorkClaim[]> {
    const port = createOutboundWorkPort(readOutboundTestWorkQueue(store), store.namespace);
    return await port.claim({ maxCount, observedEntries: undefined });
}

export async function releaseOutboundTestWork<TPrepared>(
    store: ALOutboundAdmissionStore<TPrepared>,
    claim: ALWorkClaim,
    outcome: ALWorkOutcome
): Promise<void> {
    const port = createOutboundWorkPort(readOutboundTestWorkQueue(store), store.namespace);
    await port.release(claim, outcome);
}

export function createDefaultOutboundTestStores(
    outbox?: InMemoryQueueBox
): ALOutboundRuntimeStores<OutboundTestPayload> {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), Date.now);
    return rememberOutboundTestWorkQueue({
        admissionStore: createALOutboundAdmissionStore({
            decodePrepared: decodeOutboundTestPayload,
            nowMs: Date.now,
            namespace: 'outbound-test',
            canonicalScope: 'outbound-test',
            supersedenceTrackTtlMs: 5 * 60_000,
            backend,
            retention: normalizeALRuntimeStoreRetention(),
        }),
        workQueue: backend.workQueue
    });
}

export function createDefaultOutboundTestAdmissionStore(
    outbox?: InMemoryQueueBox
): ALOutboundAdmissionStore<OutboundTestPayload> {
    return createDefaultOutboundTestStores(outbox).admissionStore;
}

export function createFlakyOutboundAdmissionStore(
    inner: ALOutboundAdmissionStore<OutboundTestPayload>,
    hooks: Partial<
        Pick<
            ALOutboundAdmissionStore<OutboundTestPayload>,
            'commitBundle' | 'readWorkSnapshot'
        >
    >
): ALOutboundAdmissionStore<OutboundTestPayload> {
    return {
        retainPendingAdmission: (input) => inner.retainPendingAdmission(input),
        namespace: inner.namespace,
        canonicalScope: inner.canonicalScope,
        isMessageSuperseded: (message) => inner.isMessageSuperseded(message),
        ready: () => inner.ready(),
        readOutgoingMessage: (input) => inner.readOutgoingMessage(input),
        readRepairMessage: (msgId, planner) => inner.readRepairMessage(msgId, planner),
        readSentMessage: (msgId: string) => inner.readSentMessage(msgId),
        readSentMessageByOrdering: (trackKey, seq) => inner.readSentMessageByOrdering(trackKey, seq),
        readReceiptState: (msgId: string) => inner.readReceiptState(msgId),
        readPendingAck: (msgId: string) => inner.readPendingAck(msgId),
        readWorkSnapshot: (entry) =>
            hooks.readWorkSnapshot ? hooks.readWorkSnapshot(entry) : inner.readWorkSnapshot(entry),
        commitBundle: (bundle) => hooks.commitBundle ? hooks.commitBundle(bundle) : inner.commitBundle(bundle),
        createControlAdmission: (port, clock) => inner.createControlAdmission(port, clock)
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
    message: ALMessage
) {
    const read = await store.readOutgoingMessage({
        msg: message,
        planner: (msg) => ({ msg, persist: true, preparedMessages: [] }),
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
        throw new Error(`Expected outbound admission, received ${computed.status}`);
    }
    return computed.bundle;
}
