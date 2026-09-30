import { describe, expect, it } from 'vitest';

import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import {
    isAcceptedRoomLayoutOverlay,
    isRoomLayoutOverlay
} from '@shared/repository/is-accepted-room-layout-overlay.ts';

const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const ACCEPTED: GroupLayoutIdentity = {
    groupRevision: 1,
    presenceRevision: 3,
    version: 7,
    state: 'active'
};
const ROOM = { ...ROOM_REF, acceptedLayoutIdentity: ACCEPTED };

describe('the room layout an overlay slot holds', () => {
    it('is a live server publication for the same room', () => {
        expect(isRoomLayoutOverlay(createOverlay(), ROOM_REF)).toBe(true);
    });

    it.each<[string, OverlayInfo | undefined]>([
        ['an empty slot', undefined],
        ['a bootstrap layout', createOverlay({ provenance: 'bootstrap' })],
        ['a removed layout', createOverlay({ state: 'removed' })],
        ['another room', createOverlay({ groupRef: { ...ROOM_REF, groupId: 'other-room' } })],
        [
            'the same room id in another workspace',
            createOverlay({ groupRef: { ...ROOM_REF, workspaceId: 'other' } })
        ]
    ])('is not %s', (_name, overlay) => {
        expect(isRoomLayoutOverlay(overlay, ROOM_REF)).toBe(false);
        expect(isAcceptedRoomLayoutOverlay(overlay, ROOM)).toBe(false);
    });

    it('is accepted only while it holds the exact layout the room names as accepted', () => {
        expect(isAcceptedRoomLayoutOverlay(createOverlay(), ROOM)).toBe(true);
        expect(isAcceptedRoomLayoutOverlay(createOverlay({ overlayVersion: 8 }), ROOM)).toBe(false);
        expect(
            isAcceptedRoomLayoutOverlay(
                createOverlay({
                    sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 4 }
                }),
                ROOM
            )
        ).toBe(false);
        expect(
            isAcceptedRoomLayoutOverlay(createOverlay(), { ...ROOM, acceptedLayoutIdentity: null })
        ).toBe(false);
    });
});

function createOverlay(overrides: Partial<OverlayInfo> = {}): OverlayInfo {
    return {
        overlayId: toScopedOverlayId(ROOM_REF),
        groupRef: ROOM_REF,
        provenance: 'server',
        state: 'active',
        topology: 'tree',
        name: 'room',
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 3 },
        nextHopSessionIds: ['peer-1'],
        degreeLimit: 3,
        overlayVersion: 7,
        createdByClientId: 'self',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        ...overrides
    };
}
