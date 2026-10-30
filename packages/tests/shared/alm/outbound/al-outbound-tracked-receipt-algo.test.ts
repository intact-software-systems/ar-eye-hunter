import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import type { ALAckAlgo } from '@shared/al-contracts/al-policy.ts';
import type { ALOutboundAckTrackingPlan, ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import type { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestStores,
    createOutboundCanonicalEntry,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';

const HOP: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 2_000,
    maxAttempts: 3,
    expectedPeerIds: ['peer-1'],
    nextHopPeerIds: ['peer-1'],
    mode: 'hop'
};

async function readTrackedReceiptAlgo(
    ackTracking: ALOutboundAckTrackingPlan,
    creationNow: QueueBoxUtilities.CreationClock,
    clock: ALOutboundMessageRuntime.Clock
): Promise<ALAckAlgo> {
    const { admissionStore } = createDefaultOutboundTestStores();
    const message = createOutboundMessage('tracked-receipt-algo');
    const read = await admissionStore.readOutgoingMessage({
        msg: message,
        planner: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ message: 'frame' }],
            ackTracking,
            admittedConnectionGenerationIds: undefined
        }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    return computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(admissionStore, read.msg, creationNow()),
        dispatchAtMs: clock.nowMs(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    }).trackedReceiptAlgo;
}

describe('outbound admission tracked receipt algorithm', () => {
    it('reports hop when timeout and audience permit a pending receipt', async () => {
        expect(await readTrackedReceiptAlgo(HOP, Temporal.Now.instant, { nowMs: Date.now })).toBe('hop');
    });

    it.each([
        ['a qos.ack timeout of 0', { ...HOP, timeoutMs: 0 }],
        ['a hop receipt that expects nobody', { ...HOP, expectedPeerIds: [], nextHopPeerIds: [] }],
        ['a receiver receipt with named recipients and a timeout of 0', {
            ...HOP,
            mode: 'receiver' as const,
            timeoutMs: 0
        }]
    ])('reports none for %s', async (_label, tracking) => {
        expect(await readTrackedReceiptAlgo(tracking, Temporal.Now.instant, { nowMs: Date.now })).toBe('none');
    });

    it('keeps receiver for an empty expected set: the WS server receipt or the empty frozen audience settles it', async () => {
        expect(
            await readTrackedReceiptAlgo(
                {
                    ...HOP,
                    mode: 'receiver',
                    expectedPeerIds: [],
                    nextHopPeerIds: []
                },
                Temporal.Now.instant,
                { nowMs: Date.now }
            )
        )
            .toBe('receiver');
    });
});
