import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '@shared/alm/ALStoreRetention.ts';
import type { ALOutboundDispatchPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    createVolatileOutboundTestStores,
    enqueueOutboundOrThrow,
    runOutboundWorkTask,
    toOutboundTestAck,
    trackOutboundTestAcks
} from './outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound store lanes (S3a, D54)', () => {
    function planVolatileSend(msg: ALMessage): ALOutboundDispatchPlan<OutboundTestPayload> {
        return {
            msg,
            dropReasonCode: undefined,
            persist: false,
            preparedMessages: [{ kind: 'send' }]
        };
    }

    it('admits a durable plan to the durable pair and a volatile plan to the memory pair', async () => {
        const durable = createDefaultOutboundTestStores();
        const volatileStores = createVolatileOutboundTestStores();
        const fleeting = createOutboundMessage('fleeting');
        const kept = createOutboundMessage('kept');
        const runtime = createDefaultOutboundTestRuntime({
            stores: durable,
            volatileStores,
            planOutgoingMessage: (msg) => ({
                ...planVolatileSend(msg),
                persist: msg.id.msgId === kept.id.msgId
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });

        await enqueueOutboundOrThrow(runtime, fleeting);
        await enqueueOutboundOrThrow(runtime, kept);

        expect(await volatileStores.admissionStore.hasSentMessageAdmission(fleeting.id.msgId)).toBe(
            true
        );
        expect(await durable.admissionStore.hasSentMessageAdmission(fleeting.id.msgId)).toBe(false);
        expect(await durable.admissionStore.hasSentMessageAdmission(kept.id.msgId)).toBe(true);
        expect(await volatileStores.admissionStore.hasSentMessageAdmission(kept.id.msgId)).toBe(
            false
        );
    });

    it('routes an acknowledgement to the lane that owns its message', async () => {
        const durable = createDefaultOutboundTestStores();
        const volatileStores = createVolatileOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores: durable,
            volatileStores,
            planOutgoingMessage: (msg) => ({
                ...planVolatileSend(msg),
                ackTracking: trackOutboundTestAcks(['peer-1'])
            }),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('acknowledged-in-memory');
        await enqueueOutboundOrThrow(runtime, message);

        const admitted = await runtime.acceptControlMessage(
            toOutboundTestAck(message, 'peer-1'),
            'peer'
        );

        expect(admitted.kind).toBe('committed');
        expect(
            await volatileStores.admissionStore.readPendingAck({
                originPeerId: 'self',
                msgId: message.id.msgId
            })
        )
            .toBeUndefined();
        expect(await durable.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
    });

    it('evicts its expired rows on the first round past the eviction interval, with no timer of its own', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const volatileStores = createVolatileOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            volatileStores,
            planOutgoingMessage: planVolatileSend,
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        await enqueueOutboundOrThrow(runtime, createOutboundMessage('expiring', { ttlMs: 1_000 }));
        expect((await volatileStores.workQueue.getAllKeys()).length).toBeGreaterThan(0);

        vi.setSystemTime(Date.now() + AL_VOLATILE_STORE_EVICTION_INTERVAL_MS + 1_000);
        await runOutboundWorkTask(runtime);

        expect(await volatileStores.workQueue.getAllKeys()).toEqual([]);
    });
});
