import {
    expect,
    it,
    onTestFinished
} from 'vitest';

import { newALReceiptControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import {
    createALOutboundReceiptWorkEvidence,
    type ALOutboundReceiptWorkObservation
} from '@shared/alm/outbound/lane/al-outbound-receipt-observation.ts';
import { ALWorkBatchObservations } from '@shared/alm/work/al-work-batch-observations.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { TestWebSocket } from '../../websocket/test-web-socket.ts';
import { drainEngine } from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from '../outbound-test-payload.ts';

it.each(['enabled', 'absent', 'construction-throws', 'batch-construction-throws'] as const)(
    'preserves sent receipt bytes and completed work with %s receipt capture',
    async (capture) => {
        const queue = new InMemoryQueueBox();
        const engine = new InboxOutboxEngine();
        const socket = new TestWebSocket('ws://origin.invalid');
        socket.open();
        onTestFinished(() => {
            socket.close();
            TestWebSocket.instances.splice(TestWebSocket.instances.indexOf(socket), 1);
        });
        const observations: ALOutboundReceiptWorkObservation[] = [];
        const releasedAtObservation: string[][] = [];
        const transportReleaseStatuses: string[][] = [];
        const resources = createDefaultALOutboundRuntimeResources({
            decodePrepared: decodeOutboundTestPayload,
            canonicalQueue: queue,
            queueEngine: engine
        });
        function recordTransportObservation(): void {
            transportReleaseStatuses.push(getWorkStatuses(queue, resources.admissionStore.namespace));
        }
        const receipt = {
            ...newALReceiptControlMessage(
                { v: 3, msgId: 'complete-receipt', senderId: 'server', ts: Date.now() },
                {
                    msgId: 'subject',
                    originPeerId: 'origin',
                    phase: 'complete',
                    expectedRecipientPeerIds: ['recipient'],
                    confirmedRecipientPeerIds: ['recipient'],
                    snapshotVersion: 7,
                    observedAtEpochMs: 1000
                }
            ),
            constraints: { expiresAtMs: Date.now() + 30_000 }
        };
        const plan = () => ({ msg: receipt, dropReasonCode: undefined, lane: 'durable' as const, preparedMessages: [{ text: 'receipt-frame' }] });
        const runtime = new ALOutboundMessageRuntime({
            ...resources,
            carrier: 'ws',
            dequeue: { types: new Set<string>(), resilience: createDefaultALOutboundDequeueResilience() },
            receiptWorkCapture: capture === 'absent' ? undefined : {
                batchObservations: capture === 'batch-construction-throws' ? FailedObservationBatch : ALWorkBatchObservations,
                createEvidence: capture === 'construction-throws'
                    ? () => {
                        throw new Error('diagnostic construction');
                    }
                    : createALOutboundReceiptWorkEvidence,
                observer: (observation: ALOutboundReceiptWorkObservation) => {
                    observations.push(observation);
                    releasedAtObservation.push(getWorkStatuses(queue, resources.admissionStore.namespace));
                }
            },
            toOutboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'receipt-test'),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            planOutgoingMessage: plan,
            planDequeuedMessage: plan,
            decodePreparedMessage: decodeOutboundTestPayload,
            sendPreparedMessage: async (prepared, _phase, lifecycle) => {
                socket.send(prepared.text!);
                lifecycle.deferReceiptObservation?.(recordTransportObservation);
                return { status: 'sent', submissionAttempted: true };
            },
            afterDequeueAdmission: undefined,
            planRepairMessage: undefined,
            diagnostics: undefined,
            settlements: undefined
        });
        onTestFinished(() => runtime.dispose());
        expect((await runtime.enqueueIfAbsent(receipt)).verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 1 });
        await drainEngine(engine);
        await expect.poll(async () =>
            (await queue.readWorkPage({
                typeId: toALOutboundWorkType(resources.admissionStore.namespace),
                status: EntityStatus.COMPLETED,
                maxToRead: 10,
                cursor: null
            })).entries.length
        ).toBe(1);
        const completed = await queue.readWorkPage({
            typeId: toALOutboundWorkType(resources.admissionStore.namespace),
            status: EntityStatus.COMPLETED,
            maxToRead: 10,
            cursor: null
        });
        expect(completed.entries).toHaveLength(1);
        expect(completed.entries[0]?.dequeueAudit.attempts).toBe(1);
        expect(socket.sent).toEqual(['receipt-frame']);
        expect(transportReleaseStatuses).toEqual(capture === 'absent' || capture === 'batch-construction-throws' ? [] : [[EntityStatus.COMPLETED]]);
        expect((await resources.admissionStore.readSentMessage('complete-receipt'))?.msg.id.msgId).toBe('complete-receipt');
        if (capture === 'enabled') {
            expect(observations).toEqual([expect.objectContaining({
                kind: 'receipt-work',
                receiptControlMsgId: 'complete-receipt',
                effectKind: 'send-prepared',
                callbackOutcome: 'completed',
                stage: 'send',
                receipt: {
                    msgId: 'subject',
                    originPeerId: 'origin',
                    phase: 'complete',
                    expectedRecipientPeerIds: ['recipient'],
                    confirmedRecipientPeerIds: ['recipient'],
                    snapshotVersion: 7,
                    observedAtEpochMs: 1000
                }
            })]);
            expect(releasedAtObservation).toEqual([[EntityStatus.COMPLETED]]);
            expect(Object.isFrozen(observations[0])).toBe(true);
            expect(Object.isFrozen(observations[0]?.receipt.expectedRecipientPeerIds)).toBe(true);
        }
        else {
            expect(observations).toEqual([]);
        }
    }
);

function getWorkStatuses(queue: InMemoryQueueBox, namespace: string): string[] {
    return queue.peekKeys().map((key) => queue.peek(key)!)
        .filter((entry) => entry.typeId === toALOutboundWorkType(namespace))
        .map((entry) => entry.status);
}

class FailedObservationBatch extends ALWorkBatchObservations {
    constructor() {
        super();
        throw new Error('batch observation construction');
    }
}
