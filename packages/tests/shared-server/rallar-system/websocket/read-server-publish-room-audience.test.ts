import { describe, expect, it } from 'vitest';

import { createServerPublishRoomAudienceReader } from '@shared-server/rallar-system/websocket/read-server-publish-room-audience.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';

import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

describe('the room audience a server publish reads (D58, Q7)', () => {
    it('reads the active members\' live sessions of the named room at its snapshot version', async () => {
        const snapshot = createGroupSnapshot(3, ['session-1', 'session-2']);
        const reader = createServerPublishRoomAudienceReader({
            readGroupSnapshot: async (ref) => ref.groupId === snapshot.group.groupId ? snapshot : undefined,
            nowEpochMs: Date.now
        });
        const message = newALBroadcastMessage(
            'server',
            newALRoute('room.snapshot', snapshot.group.groupId, 'r1'),
            'room',
            'snapshot.v1',
            {},
            {
                groupRef: snapshot.group
            }
        );

        const audience = await reader(message);

        expect(audience?.sessions.map((session) => session.sessionId)).toEqual([
            'session-1',
            'session-2'
        ]);
        expect(audience?.targets).toEqual(message.targets);
        expect(
            await reader({
                ...message,
                targets: {
                    mode: 'broadcast',
                    scope: 'room',
                    groupRef: { ...snapshot.group, groupId: 'other' }
                }
            })
        )
            .toBeUndefined();
    });
});
