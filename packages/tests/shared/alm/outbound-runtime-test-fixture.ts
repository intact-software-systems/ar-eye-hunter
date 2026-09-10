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
    type ALOutboundPlanner,
    type ResourceEntry
} from '@shared/mod.ts';
import type { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

interface OutboundTestRuntimeInput {
    readonly queueEngine?: InboxOutboxEngine;
    readonly outbox?: InMemoryQueueBox;
    readonly stores?: ALOutboundRuntimeStores;
    readonly diagnostics?: ALOutboundRuntimeDiagnosticsSink;
    readonly nowMs?: () => number;
    readonly planOutgoingMessage: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['planOutgoingMessage'];
    readonly planRepairMessage?: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['planRepairMessage'];
    readonly sendPreparedMessage: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['sendPreparedMessage'];
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

export function createDefaultOutboundTestRuntime(options: OutboundTestRuntimeInput): ALOutboundMessageRuntime<OutboundTestPayload> {
    const outbox = options.outbox ?? new InMemoryQueueBox(new Map());

    const runtime = createDefaultALOutboundMessageRuntime<OutboundTestPayload>({
        decodePreparedMessage: decodeOutboundTestPayload,
        queueEngine: options.queueEngine,
        outbox,
        stores: options.stores ?? { admissionStore: createDefaultOutboundTestAdmissionStore(outbox) },
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

export async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(predicate()).toBe(true);
}

export function createDefaultOutboundTestAdmissionStore(outbox?: InMemoryQueueBox): ALOutboundAdmissionStore {
    return createALOutboundAdmissionStore({
        namespace: 'outbound-test',
        supersedenceTrackTtlMs: 5 * 60_000,
        backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), Date.now),
        retention: normalizeALRuntimeStoreRetention()
    });
}

export function createFlakyOutboundAdmissionStore(
    inner: ALOutboundAdmissionStore,
    hooks: Partial<
        Pick<
            ALOutboundAdmissionStore,
            | 'acceptControlMessage'
            | 'claimReadyEffects'
            | 'commitBundle'
            | 'completeEffect'
            | 'rescheduleEffect'
        >
    >
): ALOutboundAdmissionStore {
    return {
        retainPendingAdmission: (input) => inner.retainPendingAdmission(input),
        namespace: inner.namespace,
        canonicalScope: inner.canonicalScope,
        workQueue: inner.workQueue,
        isMessageSuperseded: (message) => inner.isMessageSuperseded(message),
        ready: () => inner.ready(),
        readOutgoingMessage: (input) => inner.readOutgoingMessage(input),
        readRepairMessage: <TPrepared>(
            msgId: string,
            planner: ALOutboundPlanner<TPrepared>
        ) => inner.readRepairMessage<TPrepared>(msgId, planner),
        hasSentMessageAdmission: (msgId: string) => inner.hasSentMessageAdmission(msgId),
        readSentMessage: (msgId: string) => inner.readSentMessage(msgId),
        readSentMessageByOrdering: (trackKey, seq) => inner.readSentMessageByOrdering(trackKey, seq),
        readReceiptState: (msgId: string) => inner.readReceiptState(msgId),
        readPendingAck: (msgId: string) => inner.readPendingAck(msgId),
        commitBundle: (bundle, decodePrepared) =>
            hooks.commitBundle
                ? hooks.commitBundle(bundle, decodePrepared)
                : inner.commitBundle(bundle, decodePrepared),
        acceptControlMessage: (msg, decodePrepared) =>
            hooks.acceptControlMessage
                ? hooks.acceptControlMessage(msg, decodePrepared)
                : inner.acceptControlMessage(msg, decodePrepared),
        scheduleNotYetInSyncRetry: (schedule, decodePrepared) => inner.scheduleNotYetInSyncRetry(schedule, decodePrepared),
        claimReadyEffects: (input, decodePrepared) =>
            hooks.claimReadyEffects
                ? hooks.claimReadyEffects(input, decodePrepared)
                : inner.claimReadyEffects(input, decodePrepared),
        rejectEffect: (reservation) => inner.rejectEffect(reservation),
        completeEffect: (reservation) =>
            hooks.completeEffect
                ? hooks.completeEffect(reservation)
                : inner.completeEffect(reservation),
        rescheduleEffect: (input) =>
            hooks.rescheduleEffect
                ? hooks.rescheduleEffect(input)
                : inner.rescheduleEffect(input),
        peekNextEffectReadyAt: () => inner.peekNextEffectReadyAt()
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

export function createOutboundCanonicalEntry(store: ALOutboundAdmissionStore, msg: ALMessage): ResourceEntry {
    return { ...QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'), key: toALOutboundCanonicalKey(store.canonicalScope, msg) };
}

export async function computeOutboundTestAdmission(store: ALOutboundAdmissionStore, message: ALMessage) {
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
