import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import {
    AL_VOLATILE_STORE_EVICTION_INTERVAL_MS,
    normalizeALRuntimeStoreRetention
} from '@shared/alm/ALStoreRetention.ts';
import {
    toALOutboundMessageOwnerKey,
    toALOutboundSentMessageKey
} from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { createVolatileALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

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
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

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

    it('sweeps its memory pair on its own round once per eviction interval, and the sweep shrinks the admission map', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const startedAtMs = Date.now();
        const lane = createObservedVolatileStores();
        const runtime = createDefaultOutboundTestRuntime({
            volatileStores: lane.stores,
            planOutgoingMessage: planVolatileSend,
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('expiring', { ttlMs: 1_000 });
        await enqueueOutboundOrThrow(runtime, message);
        const rowKeys = [
            toALOutboundMessageOwnerKey('lane-eviction', message.id.msgId),
            toALOutboundSentMessageKey('lane-eviction', message.id.msgId)
        ];
        expect(rowKeys.map((key) => lane.state.data.has(key))).toEqual([true, true]);
        // The bootstrap round sweeps first; the admission's own round falls inside the interval.
        expect(lane.evictExpired).toHaveBeenCalledTimes(1);
        const rowsAfterSend = lane.state.data.size;
        expect(rowsAfterSend).toBeGreaterThan(0);

        vi.setSystemTime(startedAtMs + AL_VOLATILE_STORE_EVICTION_INTERVAL_MS - 1);
        await runOutboundWorkTask(runtime);
        expect(lane.evictExpired, 'no sweep before the interval elapsed').toHaveBeenCalledTimes(1);

        vi.setSystemTime(startedAtMs + AL_VOLATILE_STORE_EVICTION_INTERVAL_MS);
        await runOutboundWorkTask(runtime);
        expect(lane.evictExpired, 'one sweep once the interval elapsed').toHaveBeenCalledTimes(2);

        // The sent and owner rows keep the 1 s deadline plus the receipt grace (D74), gone well before this round.
        vi.setSystemTime(startedAtMs + 2 * AL_VOLATILE_STORE_EVICTION_INTERVAL_MS);
        await runOutboundWorkTask(runtime);
        expect(lane.evictExpired).toHaveBeenCalledTimes(3);
        expect(lane.state.data.size).toBeLessThan(rowsAfterSend);
        expect(rowKeys.map((key) => lane.state.data.has(key))).toEqual([false, false]);
    });
});

/** A memory pair whose admission map and sweep the test can observe; `read` and `list` would expire lazily. */
function createObservedVolatileStores() {
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const evictExpired = vi.fn(() => backend.evictExpired());
    const stores: ALVolatileOutboundRuntimeStores<OutboundTestPayload> = {
        admissionStore: createVolatileALOutboundAdmissionStore({
            nowMs: Date.now,
            namespace: 'lane-eviction',
            canonicalScope: 'lane-eviction',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention(),
            decodePrepared: decodeOutboundTestPayload
        }),
        workQueue: backend.workQueue,
        evictExpired,
        budget: undefined
    };
    return { state, evictExpired, stores };
}
