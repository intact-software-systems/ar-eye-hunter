import type { ALAckAlgo } from '@shared/al-contracts/al-policy.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
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

async function computeTrackedReceiptAlgo(
    ackTracking: ALOutboundAckTrackingPlan
): Promise<ALAckAlgo> {
    const { admissionStore } = createDefaultOutboundTestStores();
    const message = createOutboundMessage('tracked-receipt-algo');
    const read = await admissionStore.readOutgoingMessage({
        msg: message,
        planner: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: false,
            preparedMessages: [{ message: 'frame' }],
            ackTracking
        }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    return computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(admissionStore, read.msg),
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    }).trackedReceiptAlgo;
}

describe('the receipt an admission reports it tracks (every receipt end settles)', () => {
    it('reports the mode of a receipt its commit writes a row for', async () => {
        expect(await computeTrackedReceiptAlgo(HOP)).toBe('hop');
    });

    it.each([
        ['a qos.ack timeout of 0', { ...HOP, timeoutMs: 0 }],
        ['a hop receipt that expects nobody', { ...HOP, expectedPeerIds: [], nextHopPeerIds: [] }],
        ['a receiver receipt with named recipients and a timeout of 0', {
            ...HOP,
            mode: 'receiver' as const,
            timeoutMs: 0
        }]
    ])('reports none for %s, which no row tracks', async (_label, tracking) => {
        expect(await computeTrackedReceiptAlgo(tracking)).toBe('none');
    });

    it('keeps receiver for an empty expected set: the WS server receipt or the empty frozen audience settles it', async () => {
        expect(
            await computeTrackedReceiptAlgo({
                ...HOP,
                mode: 'receiver',
                expectedPeerIds: [],
                nextHopPeerIds: []
            })
        )
            .toBe('receiver');
    });
});
