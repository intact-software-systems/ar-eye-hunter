import { describe, expect, it } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { readRtcOutboundObservation } from '@shared/multicast/read-rtc-outbound-observation.ts';

import {
    createOriginOverlay,
    createOriginSnapshot,
    ORIGIN_ROOM
} from './rtc-origin-overlay-fixture.ts';

const SCOPED_ID = toScopedOverlayId(ORIGIN_ROOM);

describe('readRtcOutboundObservation', () => {
    it.each(
        [
            ['the explicit overlay over the scoped and group-keyed ones', [
                'explicit',
                SCOPED_ID,
                'room'
            ], 'explicit'],
            ['the scoped overlay over the group-keyed one', [SCOPED_ID, 'room'], SCOPED_ID],
            ['the group-keyed overlay when it is the only one', ['room'], 'room']
        ] as const
    )('selects %s', (_case, cachedIds, selectedId) => {
        const overlays = new LatestRepository<string, OverlayInfo>();
        for (const overlayId of cachedIds) {
            overlays.accept(overlayId, { ...createOriginOverlay(['b']), overlayId });
        }

        const observation = readFor(overlays, { forwarding: { overlayId: 'explicit' } });

        expect(observation.overlayId).toBe(selectedId);
        expect(observation.overlay?.overlayId).toBe(selectedId);
        expect(observation.room?.group.groupId).toBe('room');
    });

    it('names the explicit overlay id and no overlay when nothing is cached', () => {
        const observation = readFor(new LatestRepository<string, OverlayInfo>(), {
            forwarding: { overlayId: 'explicit' }
        });

        expect(observation).toMatchObject({ overlayId: 'explicit', overlay: undefined });
    });

    it('names the scoped overlay id when the message names none and nothing is cached', () => {
        expect(readFor(new LatestRepository<string, OverlayInfo>(), {})).toMatchObject({
            overlayId: SCOPED_ID,
            overlay: undefined
        });
    });
});

function readFor(overlays: LatestRepository<string, OverlayInfo>, extra: Partial<ALMessage>) {
    const groups = new LatestRepository<string, GroupSnapshot>();
    groups.accept('any-key', createOriginSnapshot(['a', 'b'], 1));
    const message: ALMessage = {
        ...newALMulticastMessage(
            'a',
            { topicId: 'chat', resourceId: 'observe', contextId: 'room' },
            ORIGIN_ROOM,
            'chat.message.v1',
            {}
        ),
        ...extra
    };
    return readRtcOutboundObservation({
        message,
        groupCache: groups,
        overlayCache: overlays,
        connectedPeerIds: ['b'],
        nowMs: 1
    });
}
