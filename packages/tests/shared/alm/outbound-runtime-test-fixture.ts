import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { expect, onTestFinished, vi } from 'vitest';

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

import type {
    ALOutboundEffectSnapshot,
    ALOutboundPlanner,
    ALOutboundPreparedMessageDecoder
} from '@shared/alm/outbound/al-outbound-admission-store.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    readALOutboundWorkReadyAt,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    createALWorkQueuePort,
    type ALWorkOutcome,
    type ALWorkQueuePort
} from '@shared/alm/work/al-work-queue-port.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';

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
        const registration = includeTask.mock.calls.find(([name]) => name.startsWith('al-outbound:'))?.[1];
        if (!registration) {
            throw new Error('Expected the outbound runtime to have registered its own work task');
        }
        await registration.runnable();
    };
}

/** Admits a message and runs the one batch its owner owes for the work the admission committed. */
export async function enqueueOutboundOrThrow(
    runtime: Pick<ALOutboundMessageRuntime<OutboundTestPayload>, 'enqueueIfAbsent' | 'drainWork'>,
    msg: ALMessage
): Promise<readonly ResourceEntry[]> {
    const enqueued = await runtime.enqueueIfAbsent(msg);
    if (enqueued.status === 'failed') {
        throw new Error(enqueued.reason);
    }
    await runtime.drainWork();

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

/** Claims and decodes work the way the owner's batch does. */
export async function claimOutboundTestWork<TPrepared>(
    stores: ALOutboundRuntimeStores<TPrepared>,
    maxCount: number
): Promise<readonly ALOutboundEffectSnapshot<TPrepared>[]> {
    const port = createOutboundWorkPort(stores.workQueue, stores.admissionStore.namespace);
    const claims = await port.claim({ maxCount, observedEntries: undefined });
    return await Promise.all(claims.map((claim) => stores.admissionStore.readWorkSnapshot(claim.entry)));
}

/** Releases one claimed row the way the owner's attempt does. */
export async function releaseOutboundTestWork<TPrepared>(
    stores: ALOutboundRuntimeStores<TPrepared>,
    entry: ResourceEntry,
    outcome: ALWorkOutcome
): Promise<void> {
    const port = createOutboundWorkPort(stores.workQueue, stores.admissionStore.namespace);
    await port.release({ entry, attempts: entry.dequeueAudit.attempts, leaseUntilMs: Date.now() }, outcome);
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
    planner: ALOutboundPlanner<TPrepared> = (msg) => ({ msg, persist: true, preparedMessages: [] })
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
        throw new Error(`Expected outbound admission, received ${computed.status}`);
    }
    return computed.bundle;
}
