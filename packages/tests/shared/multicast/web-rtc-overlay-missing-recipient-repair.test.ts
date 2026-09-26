import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import { computeMissingRecipientRepair } from '@shared/multicast/web-rtc-overlay-missing-recipient-repair.ts';

import {
    acknowledgeAtOrigin,
    createOriginOverlay,
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    readSentTargets,
    toOriginFrozenTargets
} from './rtc-origin-overlay-fixture.ts';
import { createRtcRelayOverlayFixture } from './rtc-relay-overlay-fixture.ts';

const ACK_TIMEOUT_MS = 2_000;
/** The default `at-least-once` retry budget of a receipt. */
const RETRY_BUDGET = 3;

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

    it('retries only through the relay that still leads to a missing recipient, whose answer completes the receipt', async () => {
        const snapshot = createOriginSnapshot(['a', 'r', 'b', 'c'], 4);
        const fixture = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['r', 'c'] });
        const relay = createRtcRelayOverlayFixture({ selfPeerId: 'r', snapshot, neighbourPeerIds: ['a', 'b'] });
        const message = createOriginReceiverMulticast('missing-b');
        await enqueueAndDrain(fixture.manager, message);
        await relay.receive(fixture.channels.r!.sent[0]!, 'a');
        // `b` delivers behind `r`; `r` relays its ACK and ends its subtree, but the r -> a leg loses both.
        await relay.receive(createLeafAck({ msgId: message.id.msgId, fromPeerId: 'b', toPeerId: 'r' }), 'b');
        const lost = readAckTuples(await relay.readSent('a'));
        expect(lost.toSorted()).toEqual([['b', 'forwarded'], ['r', 'subtree-complete']]);
        // `c` is a leaf: its own delivered ACK completes its hop.
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

        await relay.receive(fixture.channels.r!.sent[1]!, 'a');
        const answer = (await relay.readSent('a')).filter(isAck).slice(lost.length);
        expect(readAckTuples(answer).toSorted()).toEqual([['b', 'forwarded'], ['r', 'subtree-complete']]);
        for (const ack of answer) {
            await fixture.manager.acceptControlMessage(ack);
        }

        expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
            .toBeUndefined();
        const settled = fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1);
        expect(settled).toMatchObject({
            mode: 'receiver',
            complete: true,
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['r', 'b', 'c'],
            unconfirmedRecipientPeerIds: []
        });
        expect(settled?.kind === 'acknowledgement' && settled.confirmedRecipientPeerIds.toSorted()).toEqual(['b', 'c', 'r']);
    });

    it('names the relay as its confirmed hop and the recipient behind it as its confirmed recipient (R-S2c-ii-6)', async () => {
        const fixture = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a', 'r', 'b'], 4), nextHopPeerIds: ['r'] });
        const message = createOriginReceiverMulticast('hop-and-recipient');
        await enqueueAndDrain(fixture.manager, message);
        const acknowledgements = () => fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement');

        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'r',
            logicalRecipientPeerId: 'b',
            status: 'forwarded'
        });
        expect(acknowledgements().at(-1)).toMatchObject({
            mode: 'receiver',
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: ['r'],
            expectedRecipientPeerIds: ['r', 'b'],
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: ['r'],
            complete: false
        });

        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'r',
            logicalRecipientPeerId: 'r',
            status: 'subtree-complete'
        });
        expect(acknowledgements().at(-1)).toMatchObject({
            confirmedHopPeerIds: ['r'],
            unconfirmedHopPeerIds: [],
            confirmedRecipientPeerIds: ['b', 'r'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
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

    it('resends to a hop outside the frozen audience on every retry, bounded by the receipt retry budget', async () => {
        const fixture = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(['a', 'b'], 4), nextHopPeerIds: ['b'] });
        const message = createOriginReceiverMulticast('outside-hop');
        await enqueueAndDrain(fixture.manager, message);
        // `d` joins after the freeze and becomes the only hop; `b` now sits behind it and never answers.
        fixture.groups.accept('room', createOriginSnapshot(['a', 'b', 'd'], 5));
        fixture.overlays.accept('room', createOriginOverlay(['d']));
        fixture.ready.peerIds = ['d'];
        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'd',
            logicalRecipientPeerId: 'd',
            status: 'subtree-complete'
        });

        await vi.advanceTimersByTimeAsync(20 * ACK_TIMEOUT_MS);
        const retried = fixture.channels.d!.sent.length;
        await vi.advanceTimersByTimeAsync(20 * ACK_TIMEOUT_MS);

        expect(retried).toBe(RETRY_BUDGET);
        expect(fixture.channels.d!.sent).toHaveLength(RETRY_BUDGET);
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
                expectedRecipientPeerIds: [],
                confirmedRecipientPeerIds: [],
                unconfirmedRecipientPeerIds: [],
                complete: true
            })
        ]);
    });
});

describe('the RTC origin verdict when it owns no child (R-S2c-ii-9a)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    // An origin with room members but no copy to send has no route: `no-route` is the verdict a fallback
    // carrier takes over, where it used to be skipped as a planner drop.
    it.each(
        [
            {
                shape: 'room members but no overlay next hop',
                sessions: ['a', 'b', 'c'],
                frozen: undefined,
                nextHopPeerIds: [],
                verdict: { kind: 'unroutable', reason: 'no-route' }
            },
            {
                shape: 'a frozen audience that has since left the room',
                sessions: ['a'],
                frozen: ['b', 'c'],
                nextHopPeerIds: [],
                verdict: { kind: 'unroutable', reason: 'no-route' }
            },
            {
                shape: 'an origin alone in its room',
                sessions: ['a'],
                frozen: undefined,
                nextHopPeerIds: [],
                verdict: { kind: 'admitted' }
            },
            {
                shape: 'a room with next hops',
                sessions: ['a', 'b', 'c'],
                frozen: undefined,
                nextHopPeerIds: ['b', 'c'],
                verdict: { kind: 'admitted' }
            }
        ] as const
    )('settles $verdict.kind for $shape', async ({ sessions, frozen, nextHopPeerIds, verdict }) => {
        const fixture = createRtcOriginOverlayFixture({ snapshot: createOriginSnapshot(sessions, 5), nextHopPeerIds });
        const original = createOriginReceiverMulticast(`verdict-${sessions.length}-${nextHopPeerIds.length}`);
        const message = frozen === undefined
            ? original
            : toALFrozenMulticastMessage(original, { recipientPeerIds: frozen, snapshotVersion: 4 });

        const admitted = await enqueueAndDrain(fixture.manager, message);

        expect(admitted.verdict).toMatchObject(verdict);
    });
});

interface LeafAckInput {
    readonly msgId: string;
    readonly fromPeerId: string;
    readonly toPeerId: string;
}

function createLeafAck(input: LeafAckInput): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${input.fromPeerId}`, senderId: input.fromPeerId, ts: Date.now() },
        {
            ackedMsgId: input.msgId,
            fromPeerId: input.fromPeerId,
            toPeerId: input.toPeerId,
            originPeerId: 'a',
            logicalRecipientPeerId: input.fromPeerId,
            carrier: 'rtc',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

function isAck(message: ALMessage): boolean {
    return parseALControlMessage(message)?.type === 'ack';
}

function readAckTuples(messages: readonly ALMessage[]): readonly (readonly [string, string])[] {
    return messages.flatMap((message) => {
        const control = parseALControlMessage(message);
        return control?.type === 'ack' ? [[control.payload.logicalRecipientPeerId, control.payload.status] as const] : [];
    });
}
