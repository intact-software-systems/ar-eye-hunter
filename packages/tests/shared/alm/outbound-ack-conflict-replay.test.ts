import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    expect,
    it,
    onTestFinished,
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
    type ALOutboundAdmissionStore,
    type ALOutboundCommitBundle
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundPreparedSendResult
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import type { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createOutboundCanonicalEntry,
    createOutboundTestRuntimeFor,
    runOutboundWorkTask,
    waitUntil
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

import { toTestALAckPayload } from '../../al-control-test-payloads.ts';

interface ReadRepairBundleInput {
    readonly attemptIdentity: string;
    readonly creationNow: QueueBoxUtilities.CreationClock;
}

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
        onTestFinished(() => registry.releaseAll());
        const handle = registry.open({ message: message, carrier: 'rtc', readDeadlineEpochMs: clock });
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
            trackedReceiptAlgo: admitted.trackedReceiptAlgo,
            traceId: 'trace-outbound-ack-conflict-replay'
        });
        await runOutboundWorkTask(runtime);
        expect(handle.lifecycle().state).toBe('transport-accepted');

        // The repair commits after the ACK's read but before its CAS. Both use production writes.
        const repairBundle = await readRepairBundle(admissionStore, message, { attemptIdentity: 'initial-conflict', creationNow: Temporal.Now.instant });
        const write = backend.write.bind(backend);
        vi.spyOn(backend, 'write').mockImplementationOnce(async (operation, deadline) => {
            expect(await admissionStore.commitBundle(repairBundle)).toBe('committed');
            return await write(operation, deadline);
        });
        // What is pinned is the conflict replay, not the proof: the ACK's speaker is taken as its carrier authenticates it.
        const control = createTestALOutboundControlAdmission({
            admissionStore,
            workQueue,
            nowMs: clock,
            carrier: 'rtc',
            recipientAuthentication: { kind: 'carrier' },
            settlements: () => {
                throw new Error('A conflicted ACK must not settle before replay');
            }
        });
        const ack = newALAckControlMessage(
            { v: 4, msgId: 'ack', senderId: 'receiver', ts: nowMs, traceId: 'trace-outbound-ack-conflict-replay' },
            toTestALAckPayload({
                ackedMsgId: message.id.msgId,
                originPeerId: 'sender',
                logicalRecipientPeerId: 'receiver',
                fromPeerId: 'receiver',
                toPeerId: 'sender',
                status: 'delivered',
                observedAtEpochMs: nowMs,
                carrier: 'rtc'
            })
        );
        expect(await control.admit(ack, 'peer')).toEqual({ kind: 'pending-control' });
        const page = await workQueue.readWorkPage({
            typeId: toALOutboundWorkType(admissionStore.namespace),
            status: EntityStatus.NEW,
            maxToRead: 10,
            order: 'key',
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
        const competingReplayRepair = await readRepairBundle(admissionStore, message, {
            attemptIdentity: 'replay-conflict',
            creationNow: Temporal.Now.instant
        });
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

// One lost commit is the inline admission's; each further one is a replay's inside the batch.
it.each([{ lostCommits: 1 }, { lostCommits: 3 }])(
    'commits a parked ACK that lost $lostCommits commits before the claims queued behind the in-flight one of its batch',
    async ({ lostCommits }) => {
        const nowMs = 10_000;
        const clock = () => nowMs;
        vi.spyOn(Date, 'now').mockImplementation(clock);
        const workQueue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs));
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(workQueue), clock);
        const admissionStore = createALOutboundAdmissionStore({
            backend,
            nowMs: clock,
            namespace: 'parked-ack-in-flight-batch',
            canonicalScope: 'parked-ack-in-flight-batch',
            decodePrepared: decodeOutboundTestPayload,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const message = createTrackedMessage();
        const held = { ...createTrackedMessage(), id: { ...message.id, msgId: 'held' } };
        const registry = new BrowserRallarDeliveryRegistry({
            nowMs: clock,
            retainTerminalMs: 60_000,
            maxEntries: 10,
            cancel() {}
        });
        onTestFinished(() => registry.releaseAll());
        const handle = registry.open({ message, carrier: 'rtc', readDeadlineEpochMs: clock });
        // Each copy of the held message keeps its claim in flight until its gate opens: the batch's slowness.
        const gates = new Map<string, () => void>();
        const runtime = createOutboundTestRuntimeFor({
            stores: { admissionStore, workQueue },
            queueEngine: new InboxOutboxEngine(),
            nowMs: clock,
            carrier: 'rtc',
            decodePreparedMessage: decodeOutboundTestPayload,
            planOutgoingMessage: (msg) =>
                msg.id.msgId === held.id.msgId
                    ? { ...planTrackedSend(msg), preparedMessages: [{ copy: 'first' }, { copy: 'second' }] }
                    : planTrackedSend(msg),
            settlements: (settlement) => registry.record(settlement),
            sendPreparedMessage: (prepared) =>
                prepared.copy === undefined
                    ? Promise.resolve({ status: 'sent', submissionAttempted: true })
                    : new Promise<ALOutboundPreparedSendResult>((resolve) => {
                        gates.set(prepared.copy!, () => resolve({ status: 'sent', submissionAttempted: true }));
                    })
        });
        onTestFinished(() => [...gates.values()].forEach((open) => open()));
        const admitted = await runtime.enqueueIfAbsent(message);
        registry.record({
            kind: 'admission',
            msgId: message.id.msgId,
            carrier: 'rtc',
            atMs: nowMs,
            verdict: admitted.verdict,
            trackedReceiptAlgo: admitted.trackedReceiptAlgo,
            traceId: 'trace-outbound-ack-conflict-replay'
        });
        await runOutboundWorkTask(runtime);
        expect(handle.lifecycle().state).toBe('transport-accepted');

        await runtime.enqueueIfAbsent(held);
        await waitUntil(() => gates.has('first'));
        // Each lost commit is a competing repair committed after the ACK's read and before its write.
        const write = backend.write.bind(backend);
        let competingRepairs = 0;
        let competing = false;
        vi.spyOn(backend, 'write').mockImplementation(async (operation, deadline) => {
            if (!competing && competingRepairs < lostCommits) {
                competing = true;
                competingRepairs += 1;
                const repairBundle = await readRepairBundle(admissionStore, message, {
                    attemptIdentity: `in-flight-conflict-${competingRepairs}`,
                    creationNow: Temporal.Now.instant
                });
                expect(await admissionStore.commitBundle(repairBundle)).toBe('committed');
                competing = false;
            }
            return await write(operation, deadline);
        });
        expect(await runtime.acceptControlMessage(toDeliveredAck(message, nowMs), 'peer'))
            .toEqual({ kind: 'pending-control' });
        expect(handle.lifecycle().state).toBe('transport-accepted');

        gates.get('first')!();
        await waitUntil(() => gates.has('second'));

        expect(handle.lifecycle()).toMatchObject({
            state: 'acknowledged',
            evidence: { confirmedRecipientPeerIds: ['receiver'] }
        });
        expect(competingRepairs).toBe(lostCommits);
    }
);

function toDeliveredAck(message: ALMessage, nowMs: number): ALMessage {
    return newALAckControlMessage(
        { v: 4, msgId: 'ack', senderId: 'receiver', ts: nowMs, traceId: 'trace-outbound-ack-conflict-replay' },
        toTestALAckPayload({
            ackedMsgId: message.id.msgId,
            originPeerId: 'sender',
            logicalRecipientPeerId: 'receiver',
            fromPeerId: 'receiver',
            toPeerId: 'sender',
            status: 'delivered',
            observedAtEpochMs: nowMs,
            carrier: 'rtc'
        })
    );
}

async function readRepairBundle(
    admissionStore: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage,
    input: ReadRepairBundleInput
): Promise<ALOutboundCommitBundle<OutboundTestPayload>> {
    const read = await admissionStore.readOutgoingMessage({
        msg: message,
        planner: planTrackedSend,
        observedCanonicalEntry: undefined,
        intent: 'repair'
    });
    const computed = computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(admissionStore, message, input.creationNow()),
        dispatchAtMs: read.nowMs,
        intent: 'repair',
        phase: 'immediate',
        options: { attemptIdentity: input.attemptIdentity }
    });
    if (!computed.bundle) {
        throw new Error('Expected a competing repair candidate');
    }
    return computed.bundle;
}

function createTrackedMessage(): ALMessage {
    return {
        id: { v: 4, msgId: 'data', senderId: 'sender', ts: 10_000, traceId: 'trace-outbound-ack-conflict-replay' },
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
        lane: 'durable',
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
