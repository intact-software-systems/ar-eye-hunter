import { describe, expect, it } from 'vitest';

import {
    newALMulticastMessage,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    computeRtcOutboundCarrierAvailability,
    toRtcCarrierGapFrozenMessage
} from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';

import {
    createOriginOverlay,
    createOriginSnapshot,
    ORIGIN_ROOM
} from './rtc-origin-overlay-fixture.ts';

const NOW_MS = Date.parse('2026-01-01T00:00:00Z');

describe('computeRtcOutboundCarrierAvailability', () => {
    it('makes the exact accepted server overlay of a flowing room available', () => {
        const availability = computeFor({
            room: createRoom(),
            overlay: createOriginOverlay(['b'])
        });

        expect(availability).toMatchObject({
            kind: 'available',
            admission: { kind: 'authorized', memberPeerIds: ['a', 'b', 'c'] },
            context: { overlayId: 'room', overlay: { overlayVersion: 1 } }
        });
    });

    it.each(
        [
            [
                'no room snapshot',
                undefined,
                createOriginOverlay(['b']),
                'RTC room authority is not observed yet'
            ],
            [
                'a halted room',
                halted(createRoom()),
                createOriginOverlay(['b']),
                'RTC room transport is halted'
            ],
            [
                'no accepted layout',
                withIdentity(createRoom(), null),
                createOriginOverlay(['b']),
                'RTC room has no accepted layout'
            ],
            [
                'a removed accepted layout',
                withIdentity(createRoom(), {
                    groupRevision: 1,
                    presenceRevision: 1,
                    version: 1,
                    state: 'removed'
                }),
                createOriginOverlay(['b']),
                'RTC room has no accepted layout'
            ],
            [
                'no cached overlay',
                createRoom(),
                undefined,
                'RTC room has no cached overlay that is its exact accepted layout'
            ],
            [
                'a bootstrap overlay',
                createRoom(),
                { ...createOriginOverlay(['b']), provenance: 'bootstrap' },
                'RTC room has no cached overlay that is its exact accepted layout'
            ],
            [
                'an overlay of another layout version',
                createRoom(),
                { ...createOriginOverlay(['b']), overlayVersion: 2 },
                'RTC room has no cached overlay that is its exact accepted layout'
            ]
        ] as const
    )('reads %s as a carrier gap', (_gap, room, overlay, reason) => {
        expect(computeFor({ room, overlay })).toMatchObject({ kind: 'unavailable', reason });
    });

    it.each(
        [
            ['a removed overlay', createRoom(), {
                ...createOriginOverlay(['b']),
                state: 'removed'
            }],
            ['an overlay of another scope', createRoom(), {
                ...createOriginOverlay(['b']),
                groupRef: { ...ORIGIN_ROOM, workspaceId: 'other' }
            }],
            ['an expired room', {
                ...createRoom(),
                group: { ...createRoom().group, expiresAtEpochMs: NOW_MS }
            }, createOriginOverlay(['b'])]
        ] as const
    )('refuses %s as unauthorized', (_refusal, room, overlay) => {
        expect(computeFor({ room, overlay: overlay as OverlayInfo })).toMatchObject({
            kind: 'unauthorized',
            cause: 'authority-rejected'
        });
    });

    it('keeps a missing sender session on the exact overlay a pending room authority', () => {
        const room = createRoom();
        const withoutSender = {
            ...room,
            activeSessions: room.activeSessions.filter((session) => session.sessionId !== 'a')
        };

        expect(computeFor({ room: withoutSender, overlay: createOriginOverlay(['b']) }))
            .toMatchObject({ kind: 'pending' });
    });

    it('passes a message without a room through as available without an overlay context', () => {
        const message = newALUntargetedMessage(
            'a',
            { topicId: 'chat', resourceId: 'bare', contextId: 'room' },
            'chat.message.v1',
            {}
        );

        expect(computeFor({ room: undefined, overlay: undefined, message })).toEqual({
            kind: 'available',
            admission: { kind: 'not-room' },
            context: undefined
        });
    });
});

describe('toRtcCarrierGapFrozenMessage', () => {
    it('freezes a held origin multicast to the sessions its room authority admits, without the origin', () => {
        const message = createRoomMulticast();
        const availability = computeFor({ room: createRoom(), overlay: undefined, message });

        expect(toRtcCarrierGapFrozenMessage(message, availability, 'a')?.targets).toEqual({
            mode: 'multicast',
            groupRef: ORIGIN_ROOM,
            recipientPeerIds: ['b', 'c'],
            snapshotVersion: 4
        });
    });

    it('leaves the audience to the overlay plan when the carrier is available or the room is unobserved', () => {
        const message = createRoomMulticast();

        expect(
            toRtcCarrierGapFrozenMessage(
                message,
                computeFor({ room: createRoom(), overlay: createOriginOverlay(['b']), message }),
                'a'
            )
        )
            .toBeUndefined();
        expect(
            toRtcCarrierGapFrozenMessage(
                message,
                computeFor({ room: undefined, overlay: undefined, message }),
                'a'
            )
        )
            .toBeUndefined();
    });
});

interface ComputeForInput {
    readonly room: GroupSnapshot | undefined;
    readonly overlay: OverlayInfo | undefined;
    readonly message?: ALMessage;
}

function computeFor(input: ComputeForInput) {
    return computeRtcOutboundCarrierAvailability({
        message: input.message ?? createRoomMulticast(),
        observation: {
            overlayId: input.overlay === undefined ? undefined : 'room',
            room: input.room,
            overlay: input.overlay,
            connectedPeerIds: ['b', 'c'],
            nowMs: NOW_MS
        },
        selfPeerId: 'a'
    });
}

function createRoom(): GroupSnapshot {
    const snapshot = createOriginSnapshot(['a', 'b', 'c'], 4);
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({
            ...session,
            expiresAtEpochMs: NOW_MS + 600_000
        }))
    };
}

function halted(room: GroupSnapshot): GroupSnapshot {
    return { ...room, group: { ...room.group, transportState: 'halted' } };
}

function withIdentity(
    room: GroupSnapshot,
    identity: GroupSnapshot['group']['acceptedLayoutIdentity']
): GroupSnapshot {
    return { ...room, group: { ...room.group, acceptedLayoutIdentity: identity } };
}

function createRoomMulticast(): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'chat', resourceId: 'availability', contextId: 'room' },
        ORIGIN_ROOM,
        'chat.message.v1',
        {},
        { reliability: 'at-least-once', ttlMs: 30_000 }
    );
}
