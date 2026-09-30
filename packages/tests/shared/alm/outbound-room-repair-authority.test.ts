import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { newALBroadcastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundDispatchPlan, ALOutboundRepairRequest } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    runOutboundWorkTask,
    type OutboundTestStores
} from './outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from './outbound-test-payload.ts';

const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };

describe('retained room authority through repair scheduling', () => {
    it.each(['ack-timeout', 'nack'] as const)('carries a direct physical key and captured policy into %s repair', async (trigger) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const stores = createDefaultOutboundTestStores();
        const message = newALBroadcastMessage('self', { topicId: 'raw-snapshot', resourceId: 'room', contextId: trigger }, 'room', 'snapshot.v1', {}, {
            ttlMs: 30_000,
            groupRef: { ...SCOPE, groupId: 'room' }
        });
        const entry = await admitDirect(stores, message, trigger === 'ack-timeout' ? 5 : 60_000);
        const requests: ALOutboundRepairRequest[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: (msg) => toPlan(msg, 60_000),
            planRepairMessage: async (msg, request) => {
                requests.push(request);
                return toPlan(msg, 60_000);
            },
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        await runOutboundWorkTask(runtime);
        if (trigger === 'ack-timeout') {
            vi.setSystemTime(Date.now() + 6);
        }
        if (trigger === 'nack') {
            await runtime.acceptControlMessage(
                newALNackControlMessage({ v: 2, msgId: 'nack', senderId: 'frozen-session', ts: 1 }, {
                    msgId: message.id.msgId,
                    fromPeerId: 'frozen-session',
                    toPeerId: 'self',
                    reason: 'gap',
                    observedAtEpochMs: 1
                }),
                'peer'
            );
        }
        await expect.poll(async () => {
            await runOutboundWorkTask(runtime);
            return requests.length;
        }).toBe(trigger === 'nack' ? 2 : 1);
        for (const request of requests) {
            expect(request).toMatchObject({
                trigger,
                referenceKey: entry.key,
                admittedAudience: ['frozen-session']
            });
        }
    });
});

function toPlan(msg: ALMessage, timeoutMs: number): ALOutboundDispatchPlan<OutboundTestPayload> {
    return {
        msg,
        persist: true,
        dropReasonCode: undefined,
        preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
        admittedAudience: ['frozen-session'],
        ackTracking: { enabled: true, timeoutMs, maxAttempts: 1, expectedPeerIds: ['frozen-session'], nextHopPeerIds: ['frozen-session'], mode: 'receiver' },
        repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 2 }
    };
}

async function admitDirect(stores: OutboundTestStores, message: ALMessage, timeoutMs: number) {
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox');
    const read = await stores.admissionStore.readOutgoingMessage({
        msg: message,
        observedCanonicalEntry: entry,
        intent: 'dequeue',
        planner: (msg) => toPlan(msg, timeoutMs)
    });
    const computed = computeALOutboundDispatch({
        read,
        outboxEntry: entry,
        dispatchAtMs: Date.now(),
        intent: 'dequeue',
        phase: 'dequeue',
        options: { observedOutboxEntry: entry }
    });
    if (!computed.bundle || await stores.admissionStore.commitBundle(computed.bundle) !== 'committed') {
        throw new Error('Direct room fixture admission failed');
    }
    return entry;
}
