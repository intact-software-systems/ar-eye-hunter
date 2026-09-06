import { expect, onTestFinished } from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALOutboundRuntimeDiagnosticsSink, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
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

import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

interface OutboundTestRuntimeInput {
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
            await outbox.reserveEntries(
                new Set(['outbox']),
                new Set([EntityStatus.NEW]),
                10
            )
        ).values()
    ];
}

export function createDefaultOutboundTestRuntime(options: OutboundTestRuntimeInput): ALOutboundMessageRuntime<OutboundTestPayload> {
    const outbox = options.outbox ?? new InMemoryQueueBox(new Map());

    const runtime = createDefaultALOutboundMessageRuntime<OutboundTestPayload>({
        decodePreparedMessage: decodeOutboundTestPayload,
        outbox,
        stores: options.stores ?? { admissionStore: createDefaultOutboundTestAdmissionStore() },
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

export function createDefaultOutboundTestAdmissionStore(): ALOutboundAdmissionStore {
    return createALOutboundAdmissionStore({
        namespace: 'outbound-test',
        supersedenceTrackTtlMs: 5 * 60_000,
        backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now),
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
        ready: () => inner.ready(),
        readOutgoingMessage: <TPrepared>(
            msg: ALMessage,
            planner: ALOutboundPlanner<TPrepared>
        ) => inner.readOutgoingMessage<TPrepared>(msg, planner),
        readRepairMessage: <TPrepared>(
            msgId: string,
            planner: ALOutboundPlanner<TPrepared>
        ) => inner.readRepairMessage<TPrepared>(msgId, planner),
        getSentMessage: (msgId: string) => inner.getSentMessage(msgId),
        getAllSentMessages: () => inner.getAllSentMessages(),
        getPendingAck: (msgId: string) => inner.getPendingAck(msgId),
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
        completeEffect: (effectId, leaseOwner, decodePrepared) =>
            hooks.completeEffect
                ? hooks.completeEffect(effectId, leaseOwner, decodePrepared)
                : inner.completeEffect(effectId, leaseOwner, decodePrepared),
        rescheduleEffect: (input, decodePrepared) =>
            hooks.rescheduleEffect
                ? hooks.rescheduleEffect(input, decodePrepared)
                : inner.rescheduleEffect(input, decodePrepared),
        peekNextEffectReadyAt: (decodePrepared) => inner.peekNextEffectReadyAt(decodePrepared)
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
        options
    );
}

export function firstValue<K, V>(map: Map<K, V>): V {
    const first = map.values().next().value;
    if (first === undefined) {
        throw new Error('Expected at least one map value');
    }
    return first;
}
