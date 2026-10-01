import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    createOutboundCanonicalEntry,
    createOutboundTestRuntimeFor,
    runOutboundWorkTask
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

afterEach(() => vi.restoreAllMocks());

it.each(
    [
        { replayAtMs: 10_999, expectedState: 'acknowledged', confirmed: ['receiver'] },
        { replayAtMs: 11_000, expectedState: 'expired', confirmed: [] }
    ] as const
)(
    'settles retained ACK replay at $replayAtMs as $expectedState after a competing repair commit',
    async ({ replayAtMs, expectedState, confirmed }) => {
        let nowMs = 10_000;
        const clock = () => nowMs;
        vi.spyOn(Date, 'now').mockImplementation(clock);
        const workQueue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs));
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(workQueue), clock);
        const admissionStore = createALOutboundAdmissionStore({
            backend,
            nowMs: clock,
            namespace: 'ack-conflict-replay',
            canonicalScope: 'ack-conflict-replay',
            decodePrepared: decodeOutboundTestPayload,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const message = createTrackedMessage();
        const registry = new BrowserRallarDeliveryRegistry({
            nowMs: clock,
            retainTerminalMs: 60_000,
            maxEntries: 10,
            cancel() {}
        });
        const handle = registry.open(message, 'rtc');
        const runtime = createOutboundTestRuntimeFor({
            stores: { admissionStore, workQueue },
            queueEngine: new InboxOutboxEngine(),
            nowMs: clock,
            carrier: 'rtc',
            decodePreparedMessage: decodeOutboundTestPayload,
            planOutgoingMessage: planTrackedSend,
            settlements: (settlement) => registry.record(settlement),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const admitted = await runtime.enqueueIfAbsent(message);
        expect(admitted.verdict, JSON.stringify(admitted.verdict)).toMatchObject({ kind: 'admitted' });
        registry.record({
            kind: 'admission',
            msgId: message.id.msgId,
            carrier: 'rtc',
            atMs: nowMs,
            verdict: admitted.verdict,
            trackedReceiptAlgo: admitted.trackedReceiptAlgo
        });
        await runOutboundWorkTask(runtime);
        expect(handle.lifecycle().state).toBe('transport-accepted');

        // The repair commits after the ACK's read but before its CAS. Both use production writes.
        const repairBundle = await readRepairBundle(admissionStore, message, 'initial-conflict');
        const write = backend.write.bind(backend);
        vi.spyOn(backend, 'write').mockImplementationOnce(async (operation, deadline) => {
            expect(await admissionStore.commitBundle(repairBundle)).toBe('committed');
            return await write(operation, deadline);
        });
        const control = createTestALOutboundControlAdmission({
            admissionStore,
            workQueue,
            nowMs: clock,
            carrier: 'rtc',
            settlements: () => {
                throw new Error('A conflicted ACK must not settle before replay');
            }
        });
        const ack = newALAckControlMessage(
            { v: 2, msgId: 'ack', senderId: 'receiver', ts: nowMs },
            {
                ackedMsgId: message.id.msgId,
                originPeerId: 'sender',
                logicalRecipientPeerId: 'receiver',
                fromPeerId: 'receiver',
                toPeerId: 'sender',
                status: 'delivered',
                observedAtEpochMs: nowMs,
                carrier: 'rtc'
            }
        );
        expect(await control.admit(ack, 'peer')).toEqual({ kind: 'pending-control' });
        const page = await workQueue.readWorkPage({
            typeId: toALOutboundWorkType(admissionStore.namespace),
            status: EntityStatus.NEW,
            maxToRead: 10,
            cursor: null
        });
        const pending = [];
        for (const entry of page.entries) {
            const work = await admissionStore.readWorkSnapshot(entry, undefined);
            if (work.payload.kind === 'admit-control') {
                pending.push(entry);
            }
        }
        expect(pending).toHaveLength(1);
        expect(handle.lifecycle().state).toBe('transport-accepted');

        nowMs = 10_001;
        const competingReplayRepair = await readRepairBundle(admissionStore, message, 'replay-conflict');
        vi.spyOn(backend, 'write').mockImplementationOnce(async (operation, deadline) => {
            expect(await admissionStore.commitBundle(competingReplayRepair)).toBe('committed');
            return await write(operation, deadline);
        });
        await runOutboundWorkTask(runtime);
        expect(await workQueue.getItem(pending[0]!.key)).toMatchObject({
            status: EntityStatus.RETRY,
            dequeueAudit: { attempts: 1 }
        });
        expect(handle.lifecycle().state).toBe('transport-accepted');
        // A second engine turn at the same time cannot consume the queued retry's backoff.
        await runOutboundWorkTask(runtime);
        expect((await workQueue.getItem(pending[0]!.key))?.dequeueAudit.attempts).toBe(1);

        nowMs = replayAtMs;
        await runOutboundWorkTask(runtime);

        expect(handle.lifecycle()).toMatchObject({
            state: expectedState,
            expiresAtMs: 11_000,
            evidence: { confirmedRecipientPeerIds: confirmed }
        });
        expect(await workQueue.getItem(pending[0]!.key)).toMatchObject({
            status: EntityStatus.COMPLETED,
            dequeueAudit: { attempts: 2 }
        });
        expect(message.constraints?.expiresAtMs).toBe(11_000);
    }
);

async function readRepairBundle(
    admissionStore: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage,
    attemptIdentity: string
) {
    const read = await admissionStore.readOutgoingMessage({
        msg: message,
        planner: planTrackedSend,
        observedCanonicalEntry: undefined,
        intent: 'repair'
    });
    const computed = computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(admissionStore, message),
        dispatchAtMs: read.nowMs,
        intent: 'repair',
        phase: 'immediate',
        options: { attemptIdentity }
    });
    if (!computed.bundle) {
        throw new Error('Expected a competing repair candidate');
    }
    return computed.bundle;
}

function createTrackedMessage(): ALMessage {
    return {
        id: { v: 2, msgId: 'data', senderId: 'sender', ts: 10_000 },
        route: { topicId: 'chat', resourceId: 'data', contextId: 'conversation' },
        payload: { typeId: 'chat.text', resource: '{}' },
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        constraints: { expiresAtMs: 11_000 }
    };
}

function planTrackedSend(msg: ALMessage): ALOutboundDispatchPlan<OutboundTestPayload> {
    return {
        msg,
        dropReasonCode: undefined,
        persist: true,
        preparedMessages: [{ kind: 'send' }],
        ackTracking: {
            enabled: true,
            mode: 'receiver',
            timeoutMs: 2_000,
            maxAttempts: 3,
            expectedPeerIds: ['receiver'],
            nextHopPeerIds: ['receiver']
        }
    };
}
