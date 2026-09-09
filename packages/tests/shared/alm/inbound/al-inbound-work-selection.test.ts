import { Temporal } from '@js-temporal/polyfill';
import { createTestALInboundWorkPort } from '@shared-test/shared/create-test-al-inbound-work-port.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundAdmittedDelivery } from '@shared/alm/inbound/al-inbound-admitted-delivery.ts';
import { toALInboundPendingAdmissionId } from '@shared/alm/inbound/al-inbound-pending-admission.ts';
import { computeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import {
    AL_INBOUND_WORK_PAGE_SIZE,
    createALInboundWorkSelector,
    type ALInboundWorkSelector
} from '@shared/alm/inbound/read-al-inbound-work-selection.ts';
import type { ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { describe, expect, it } from 'vitest';

const NOW_MS = 1_800_000_000_000;

describe('ALInboundWorkSelector readiness', () => {
    it('advertises no readiness from a batch that claimed nothing', async () => {
        const fixture = createSelectorFixture();

        // Two full NEW -> RETRY -> RESERVED rotations: an unfinished scan is due to the probe alone,
        // so no batch of it may hand the engine a time that puts the next batch on the same tick.
        for (let batch = 0; batch < 6; batch += 1) {
            const selection = await fixture.selector.selectReady(fixture.port, AL_INBOUND_WORK_PAGE_SIZE);
            expect(selection.claims).toEqual([]);
            expect(selection.nextReadyAtMs).toBeUndefined();
        }
    });

    it('reports the page it can claim as ready now', async () => {
        const fixture = createSelectorFixture();
        await fixture.port.retainIfAbsent(createPendingAdmissionEntry(fixture.namespace));

        expect(await fixture.selector.readNextReadyAtMs(fixture.port)).toBe(NOW_MS);

        const selection = await fixture.selector.selectReady(fixture.port, AL_INBOUND_WORK_PAGE_SIZE);
        expect(selection.claims).toHaveLength(1);
        expect(selection.nextReadyAtMs).toBe(NOW_MS);
    });
});

interface SelectorFixture {
    readonly namespace: string;
    readonly port: ALWorkQueuePort;
    readonly selector: ALInboundWorkSelector;
}

function createSelectorFixture(): SelectorFixture {
    const namespace = 'inbound-selection';
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(NOW_MS))
    );
    const admissionStore = createALInboundAdmissionStore({
        nowMs: () => NOW_MS,
        namespace,
        backend: new InMemoryAdmissionBackend(state, () => NOW_MS),
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const delivery = new ALInboundAdmittedDelivery({
        admissionStore,
        planIncomingMessage: (msg, source, observations) =>
            planALMessageHandling(msg, {
                selfPeerId: 'self',
                fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
                ...observations
            }),
        dispatchInboxEntry: async () => {},
        sendControlMessage: async () => {},
        clock: { nowMs: () => NOW_MS },
        effectPreparation: {
            newControlId: () => 'selector-control',
            selfPeerId: 'self',
            createInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
        }
    });
    return {
        namespace,
        port: createTestALInboundWorkPort({
            admissionStore,
            workQueue: state.workQueue,
            nowMs: () => NOW_MS
        }),
        selector: createALInboundWorkSelector({ delivery, namespace, nowMs: () => NOW_MS })
    };
}

function createPendingAdmissionEntry(namespace: string) {
    const original = newALUnicastMessage(
        'peer-1',
        { topicId: 'chat', resourceId: 'selection', contextId: 'chat-1' },
        'self',
        'chat.private-text.v1',
        { text: 'claimable' },
        { ttlMs: 60_000 }
    );
    const msg = { ...original, constraints: { ...original.constraints, expiresAtMs: NOW_MS + 60_000 } };
    return computeALInboundWorkEntry({
        namespace,
        effectId: toALInboundPendingAdmissionId(msg),
        payload: { kind: 'admit-message', msg, source: { kind: 'ws-client', peerId: 'peer-1' } },
        observedAtMs: NOW_MS,
        expireAtTimestamp: NOW_MS + 60_000
    }).entry;
}
