import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { AL_FALLBACK_NOT_READY_ATTEMPTS } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';

import {
    acknowledgeAtOrigin,
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM,
    readSentTargets,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

type AttemptSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-settled'; }>>;

describe('a room-naming RTC unicast at its origin, through the unchanged overlay manager (Q11)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('sends straight to an addressee that is directly ready and its overlay next hop, and completes on its ACK', async () => {
        const fixture = createRoomUnicastFixture(['b'], ['b']);
        const message = createRoomUnicast('direct', 'b');

        const admitted = await enqueueAndDrain(fixture.manager, message);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(readSentTargets(fixture.channels.b!)).toEqual([{
            mode: 'unicast',
            toPeerId: 'b',
            groupRef: ORIGIN_ROOM
        }]);
        await acknowledgeAtOrigin(fixture.manager, {
            msgId: message.id.msgId,
            fromPeerId: 'b',
            logicalRecipientPeerId: 'b',
            status: 'delivered'
        });
        expect(
            fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)
        )
            .toMatchObject({ mode: 'receiver', complete: true, unconfirmedRecipientPeerIds: [] });
    });

    it('refuses it at admission as unroutable no-route when the addressee is missing from a non-empty ready set', async () => {
        const fixture = createRoomUnicastFixture(['b', 'c'], ['b', 'c']);

        const admitted = await enqueueAndDrain(fixture.manager, createRoomUnicast('missing', 'd'));

        expect(admitted.verdict).toMatchObject({ kind: 'unroutable', reason: 'no-route' });
        expect(fixture.channels.d!.sent).toEqual([]);
    });

    it('settles every attempt not-ready when the addressee is directly ready but not the overlay next hop', async () => {
        const fixture = createRoomUnicastFixture(['b', 'c', 'd'], ['b', 'c']);
        const message = createRoomUnicast('off-tree', 'd');

        const admitted = await enqueueAndDrain(fixture.manager, message);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        const outcomes = fixture.settlements
            .filter((settlement): settlement is AttemptSettlement => settlement.kind === 'attempt-settled')
            .filter((settlement) => settlement.msgId === message.id.msgId)
            .map((settlement) => settlement.outcome);
        expect(outcomes.length).toBeGreaterThanOrEqual(AL_FALLBACK_NOT_READY_ATTEMPTS);
        expect(new Set(outcomes)).toEqual(new Set(['not-ready']));
        expect(fixture.channels.d!.sent).toEqual([]);
    });
});

/** The origin `a` in a four-session room: `readyPeerIds` hold open channels, the server tree gives it `nextHopPeerIds`. */
function createRoomUnicastFixture(
    readyPeerIds: readonly string[],
    nextHopPeerIds: readonly string[]
): RtcOriginOverlayFixture {
    const fixture = createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b', 'c', 'd'], 4),
        nextHopPeerIds: readyPeerIds
    });
    // A unicast finds its overlay by the scoped room key, the key the product overlay cache uses.
    fixture.overlays.accept(toScopedOverlayId(ORIGIN_ROOM), createOriginOverlay(nextHopPeerIds));
    return fixture;
}

function createRoomUnicast(resourceId: string, toPeerId: string): ALMessage {
    return newALUnicastMessage(
        'a',
        { topicId: 'room.director.intent', resourceId, contextId: 'room' },
        toPeerId,
        'room.director.intent.v1',
        { intent: resourceId },
        {
            groupRef: ORIGIN_ROOM,
            reliability: 'at-least-once',
            ack: 'receiver',
            ownership: 'shared',
            ttlMs: 30_000
        }
    );
}
