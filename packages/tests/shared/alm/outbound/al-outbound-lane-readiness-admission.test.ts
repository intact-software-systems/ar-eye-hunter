import { describe, expect, it, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createVolatileALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundEnqueueResult,
    ALVolatileOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

describe('an outbound admission waits only for the lane it is admitted to', () => {
    it('admits a volatile send while the durable store is still opening, and holds a durable send until it opens', async () => {
        const durableStores = createDefaultOutboundTestStores();
        const durableOpen = Promise.withResolvers<void>();
        const openDurable = durableStores.admissionStore.ready.bind(durableStores.admissionStore);
        vi.spyOn(durableStores.admissionStore, 'ready').mockImplementation(async () => {
            await durableOpen.promise;
            await openDurable();
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores: durableStores,
            volatileStores: createVolatileStores(),
            planOutgoingMessage: planByResource,
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });

        const volatile = await runtime.enqueueIfAbsent(createOutboundMessage('volatile-pose'));
        const durable = trackSettled(runtime.enqueueIfAbsent(createOutboundMessage('durable-chat')));
        await Promise.resolve();

        expect(volatile.verdict).toMatchObject({ kind: 'admitted', durable: false });
        expect(durable.settled).toBe(false);

        durableOpen.resolve();
        expect((await durable.result).verdict).toMatchObject({ kind: 'admitted', durable: true });
        await runtime.dispose();
    });
});

/** Volatile for a `volatile-` resource, as a live channel's plan is; durable otherwise. */
function planByResource(msg: ALMessage): ALOutboundDispatchPlan<OutboundTestPayload> {
    const lane = msg.route.resourceId.startsWith('volatile-') ? 'volatile' : 'durable';
    return { msg, dropReasonCode: undefined, lane, preparedMessages: [{ kind: 'send' }] };
}

function createVolatileStores(): ALVolatileOutboundRuntimeStores<OutboundTestPayload> {
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    return {
        admissionStore: createVolatileALOutboundAdmissionStore({
            nowMs: Date.now,
            namespace: 'lane-readiness-volatile',
            canonicalScope: 'lane-readiness-volatile',
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention(),
            decodePrepared: decodeOutboundTestPayload
        }, 'volatile'),
        workQueue: backend.workQueue,
        evictExpired: () => backend.evictExpired(),
        budget: undefined
    };
}

function trackSettled(pending: Promise<ALOutboundEnqueueResult>): {
    readonly result: Promise<ALOutboundEnqueueResult>;
    readonly settled: boolean;
} {
    const tracked = { result: pending, settled: false };
    void pending.finally(() => {
        tracked.settled = true;
    });
    return tracked;
}
