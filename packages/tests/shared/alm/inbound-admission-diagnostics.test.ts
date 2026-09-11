import {
    expect,
    it,
    onTestFinished
} from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling, type ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import {
    ALInboundMessageRuntime,
    type ALInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import '../../setup-browser-indexeddb.ts';

type AdmissionOutcomeEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'admission-outcome'; }>;
type EffectDrainEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'effect-drain'; }>;

const SELF_PEER_ID = 'receiver';
const SENDER_PEER_ID = 'sender';

function createStores(kind: 'memory' | 'indexeddb'): ALInboundRuntimeStores {
    const backend = kind === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `inbound-admission-diagnostics-${crypto.randomUUID()}`,
            storeName: 'entries',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
    return {
        admissionStore: createALInboundAdmissionStore({
            nowMs: Date.now,
            namespace: 'inbound-admission-diagnostics',
            backend,
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue
    };
}

interface InboundDiagnosticsFixtureInput {
    readonly kind: 'memory' | 'indexeddb';
    readonly plan?: (plan: ALMessageHandlingPlan) => ALMessageHandlingPlan;
    readonly canDispatchMessage?: (msg: ALMessage) => boolean;
}

function createRuntime(input: InboundDiagnosticsFixtureInput) {
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const delivered: string[] = [];
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: SELF_PEER_ID,
        stores: createStores(input.kind),
        queueEngine: new InboxOutboxEngine(),
        toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
    });
    const runtime = new ALInboundMessageRuntime({
        ...resources,
        planIncomingMessage: (msg, _source, observations) => {
            const plan = planALMessageHandling(msg, {
                ...observations,
                selfPeerId: SELF_PEER_ID,
                fromPeerId: SENDER_PEER_ID
            });
            return input.plan?.(plan) ?? plan;
        },
        canDispatchMessage: input.canDispatchMessage,
        dispatchInboxEntry: async () => {
            delivered.push('dispatched');
        },
        sendControlMessage: async () => {},
        diagnostics: (event) => diagnostics.push(event),
        effectWorkerId: 'inbound-diagnostics-worker'
    });
    onTestFinished(() => runtime.dispose());
    return { runtime, diagnostics, delivered };
}

function createIncomingMessage(msgId: string): ALMessage {
    return newALUnicastMessage(
        SENDER_PEER_ID,
        { topicId: 'chat', resourceId: msgId, contextId: 'room' },
        SELF_PEER_ID,
        'chat.private-text.v1',
        { text: 'inbound diagnostics' },
        { ttlMs: 60_000 }
    );
}

function admissionOutcomesOf(
    diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]
): readonly AdmissionOutcomeEvent[] {
    return diagnostics.filter((event): event is AdmissionOutcomeEvent => event.kind === 'admission-outcome');
}

function drainsOf(diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]): readonly EffectDrainEvent[] {
    return diagnostics.filter((event): event is EffectDrainEvent => event.kind === 'effect-drain');
}

it.each(['memory', 'indexeddb'] as const)(
    'names the message an ingress committed and the drain that delivered it over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({ kind });
        const message = createIncomingMessage('committed-delivery');

        await runtime.ready();
        const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: SENDER_PEER_ID });

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(admissionOutcomesOf(diagnostics)).toEqual([{
            kind: 'admission-outcome',
            workerId: 'inbound-diagnostics-worker',
            msgId: message.id.msgId,
            typeId: 'chat.private-text.v1',
            outcome: 'committed',
            reason: 'admitted'
        }]);

        await expect.poll(() => delivered).toEqual(['dispatched']);
        // Only batches that touched work report; the rotation's empty rounds stay silent.
        const claimed = drainsOf(diagnostics);
        expect(claimed.map((event) => ({
            workerId: event.workerId,
            claimedCount: event.claimedCount,
            completedCount: event.completedCount,
            rescheduledCount: event.rescheduledCount,
            rejectedCount: event.rejectedCount
        }))).toEqual([{
            workerId: 'inbound-diagnostics-worker',
            claimedCount: 1,
            completedCount: 1,
            rescheduledCount: 0,
            rejectedCount: 0
        }]);
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'names an unauthorized drop that writes nothing, sends no NACK and returns no error over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({
            kind,
            plan: (plan) => ({
                ...plan,
                dropReason: 'unauthorized',
                dropReasonCode: 'unauthorized',
                localDelivery: { enabled: false, persist: false, deferred: false },
                nack: { enabled: false, reason: 'unauthorized', missingSeqs: [] }
            })
        });
        const message = createIncomingMessage('unauthorized-drop');

        await runtime.ready();
        const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: SENDER_PEER_ID });

        // Without this event the drop is indistinguishable from a delivery still on its way.
        expect(admitted.right).toEqual({ kind: 'not-admitted', reason: 'unauthorized' });
        expect(admissionOutcomesOf(diagnostics)).toEqual([{
            kind: 'admission-outcome',
            workerId: 'inbound-diagnostics-worker',
            msgId: message.id.msgId,
            typeId: 'chat.private-text.v1',
            outcome: 'unauthorized',
            reason: 'unauthorized'
        }]);
        expect(delivered).toEqual([]);
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'separates a committed admission no consumer claims from one that was never admitted over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({ kind, canDispatchMessage: () => false });
        const message = createIncomingMessage('no-inbox-consumer');

        await runtime.ready();
        const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: SENDER_PEER_ID });

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(admissionOutcomesOf(diagnostics).map((event) => event.outcome)).toEqual(['committed']);

        // The ingress committed, so the row exists; no drain ever selects it while the consumer is
        // absent, and a batch that touched nothing reports nothing.
        await expect.poll(() => delivered).toEqual([]);
        expect(drainsOf(diagnostics)).toEqual([]);
    }
);
