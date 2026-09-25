import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { computeMissingRecipientRepair } from '@shared/multicast/web-rtc-overlay-missing-recipient-repair.ts';

import {
    acknowledgeAtOrigin,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    readSentTargets,
    toOriginFrozenTargets
} from './rtc-origin-overlay-fixture.ts';

const ACK_TIMEOUT_MS = 2_000;

describe('computeMissingRecipientRepair', () => {
    it('addresses a missing direct recipient and every hop whose subtree has not completed', () => {
        expect(computeMissingRecipientRepair({
            frozen: ['r', 'b', 'c', 'e'],
            confirmed: ['c'],
            tree: { nextHopPeerIds: ['r', 'c', 'e'], completedHopPeerIds: ['c'] }
        })).toEqual({ nextHopPeerIds: ['r', 'e'] });
    });

    it('never addresses a complete hop, so a leaf whose ACK counted gets no copy', () => {
        expect(computeMissingRecipientRepair({
            frozen: ['r', 'b', 'c'],
            confirmed: ['r', 'c'],
            tree: { nextHopPeerIds: ['r', 'c'], completedHopPeerIds: ['c'] }
        })).toEqual({ nextHopPeerIds: ['r'] });
    });

    it('addresses nobody once every frozen recipient is confirmed', () => {
        expect(computeMissingRecipientRepair({
            frozen: ['r', 'b'],
            confirmed: ['b', 'r'],
            tree: { nextHopPeerIds: ['r', 'x'], completedHopPeerIds: [] }
        })).toEqual({ nextHopPeerIds: [] });
    });
});

describe('the RTC origin retry of a receiver receipt', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('retries only through the relay that still leads to a missing recipient, then completes', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'r', 'b', 'c'], 4),
            nextHopPeerIds: ['r', 'c']
        });
        const message = createOriginReceiverMulticast('missing-b');
        await enqueueAndDrain(fixture.manager, message);
        // `c` is a leaf: its own delivered ACK completes its hop. `b` sits behind `r`, and its ACK is lost.
        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'c',
            logicalRecipientPeerId: 'c',
            status: 'delivered'
        });

        await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 100);

        expect(readSentTargets(fixture.channels.r!)).toEqual([
            toOriginFrozenTargets(['r', 'b', 'c'], 4),
            toOriginFrozenTargets(['r', 'b', 'c'], 4)
        ]);
        expect(fixture.channels.c!.sent).toHaveLength(1);
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['r', 'b', 'c'], ackedPeerIds: ['c'] });

        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'r',
            logicalRecipientPeerId: 'b',
            status: 'forwarded'
        });
        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'r',
            logicalRecipientPeerId: 'r',
            status: 'subtree-complete'
        });

        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1))
            .toMatchObject({ mode: 'receiver', complete: true, unconfirmedHopPeerIds: [] });
    });

    it('never counts the terminal ACK of a relay outside the frozen audience as a logical confirmation', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 4),
            nextHopPeerIds: ['b']
        });
        const message = createOriginReceiverMulticast('late-relay');
        await enqueueAndDrain(fixture.manager, message);

        // `d` joined after the freeze: `b` relays its terminal ACK upward, and `d` may speak for itself.
        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'b',
            logicalRecipientPeerId: 'd',
            status: 'forwarded'
        });
        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'd',
            logicalRecipientPeerId: 'd',
            status: 'subtree-complete'
        });

        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toMatchObject({ mode: 'receiver', expectedPeerIds: ['b'], ackedPeerIds: [] });
    });

    it('acknowledges an origin alone in its room at once, with an empty frozen audience', async () => {
        const fixture = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a'], 4), nextHopPeerIds: [] });
        const message = createOriginReceiverMulticast('alone');

        const admitted = await enqueueAndDrain(fixture.manager, message);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets([], 4));
        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([
            expect.objectContaining({
                msgId: message.id.msgId,
                mode: 'receiver',
                confirmedHopPeerIds: [],
                unconfirmedHopPeerIds: [],
                complete: true
            })
        ]);
    });
});
