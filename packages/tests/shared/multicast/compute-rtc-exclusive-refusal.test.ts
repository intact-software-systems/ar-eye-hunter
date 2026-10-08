import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';

import {
    createOriginPrincipalSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_PRINCIPAL_REF,
    ORIGIN_ROOM,
    readSentTargets,
    toOriginFrozenTargets,
    type RtcOriginOverlayFixture
} from './rtc-origin-overlay-fixture.ts';

type ExclusiveAudience = 'room multicast' | 'room broadcast' | 'principal' | 'list' | 'room unicast';

type SendOwnership =
    | { readonly ownership: 'shared' | 'exclusive'; }
    | { readonly qos: { readonly ownership: { readonly algo: 'exclusive'; }; }; };

const EXCLUSIVE_DETAIL = 'RTC cannot arbitrate an exclusive claim: an exclusive send is unsupported';

describe('the RTC origin of an exclusive send', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each<ExclusiveAudience>(['room multicast', 'room broadcast', 'principal', 'list', 'room unicast'])(
        'refuses an exclusive %s send as unsupported with the targets its sender gave, sending nothing and expecting no receipt',
        async (audience) => {
            const fixture = createRoomFixture();
            const message = createPickupSend(audience, { ownership: 'exclusive' });

            const admitted = await enqueueLegAndDrain(fixture, message, 'hold');

            expect(admitted.verdict).toEqual({ kind: 'refused', reason: 'unsupported', detail: EXCLUSIVE_DETAIL });
            expect(admitted.message.targets).toEqual(message.targets);
            expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
            expect(await fixture.resources.admissionStore.readPendingAck({ originPeerId: 'a', msgId: message.id.msgId }))
                .toBeUndefined();
        }
    );

    it('refuses a room send that asks for exclusive ownership by quality of service alone as unsupported', async () => {
        const fixture = createRoomFixture();
        const message = createPickupSend('room multicast', { qos: { ownership: { algo: 'exclusive' } } });

        const admitted = await enqueueLegAndDrain(fixture, message, 'hold');

        expect(admitted.verdict).toEqual({ kind: 'refused', reason: 'unsupported', detail: EXCLUSIVE_DETAIL });
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('refuses an exclusive room send on a hand-over leg with RTC available as unsupported with the targets its sender gave', async () => {
        const fixture = createRoomFixture();
        const message = createPickupSend('room multicast', { ownership: 'exclusive' });

        const handedOver = await enqueueLegAndDrain(fixture, message, 'hand-over');

        expect(handedOver.verdict).toEqual({ kind: 'refused', reason: 'unsupported', detail: EXCLUSIVE_DETAIL });
        expect(handedOver.message.targets).toEqual(message.targets);
        expect([...fixture.channels.b!.sent, ...fixture.channels.c!.sent]).toEqual([]);
    });

    it('admits and sends a shared room send on the same resource', async () => {
        const fixture = createRoomFixture();
        const message = createPickupSend('room multicast', { ownership: 'shared' });

        const admitted = await enqueueLegAndDrain(fixture, message, 'hold');

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(readSentTargets(fixture.channels.b!)).toEqual([toOriginFrozenTargets(['b', 'c', 'd'], 4)]);
    });
});

/** The room of `a`, `b`, `c` and `d` (`a`, `b` and `d` sessions of one principal), `b` and `c` the next hops. */
function createRoomFixture(): RtcOriginOverlayFixture {
    return createRtcOriginOverlayFixture({ snapshot: createOriginPrincipalSnapshot(), nextHopPeerIds: ['b', 'c'] });
}

function createPickupSend(audience: ExclusiveAudience, ownership: SendOwnership): ALMessage {
    const route = { topicId: 'room.pickup', resourceId: 'pickup-1', contextId: ORIGIN_ROOM.groupId };
    const options = { ack: 'all-logical-recipients', reliability: 'at-least-once', ttlMs: 30_000, ...ownership } as const;
    switch (audience) {
        case 'room multicast':
            return newALMulticastMessage('a', route, ORIGIN_ROOM, 'room.pickup.v1', {}, options);
        case 'room broadcast':
            return newALBroadcastMessage('a', route, 'room', 'room.pickup.v1', {}, { ...options, groupRef: ORIGIN_ROOM });
        case 'principal':
            return newALPrincipalBroadcastMessage(
                'a',
                route,
                { groupRef: ORIGIN_ROOM, principalRef: ORIGIN_PRINCIPAL_REF },
                'room.pickup.v1',
                {},
                options
            );
        case 'list':
            return newALBroadcastMessage('a', route, 'room', 'room.pickup.v1', {}, {
                ...options,
                groupRef: ORIGIN_ROOM,
                recipientPeerIds: ['b', 'c']
            });
        case 'room unicast':
            return newALUnicastMessage('a', route, 'b', 'room.pickup.v1', {}, { ...options, ack: 'receiver', groupRef: ORIGIN_ROOM });
    }
}

async function enqueueLegAndDrain(
    fixture: RtcOriginOverlayFixture,
    message: ALMessage,
    carrierGap: RtcCarrierGapAdmission
) {
    const result = await fixture.manager.enqueueLegIfAbsent(message, carrierGap);
    await vi.advanceTimersByTimeAsync(0);
    return result;
}
