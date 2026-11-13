import { test } from 'bun:test';
import assert from 'node:assert/strict';

import type { GroupPublicationAuthority } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import { createApiV1CapturedRecipientEligibilityFilters } from '../../src/composition/create-api-v1-captured-recipient-eligibility-filters.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

test('the durable filter judges a room row by the room\'s live generations and the local filter by this instance\'s sockets', async () => {
    // Bob is live in the room, with no socket on this instance.
    const filters = createApiV1CapturedRecipientEligibilityFilters({
        socketServer: new JsonWebSocketServer(),
        grantedTopics: new WsGrantedTopicSet(),
        serverPeerId: 'ws-server',
        readPublicationAuthority: () => Promise.resolve(createAuthority(['bob'])),
        readPrincipalSessions: () => Promise.reject(new Error('a room row reads no principal sessions')),
        nowEpochMs: Date.now
    });
    const captured = {
        message: newALBroadcastMessage('alice', newALEventRoute('room.chat', ROOM.groupId, 'chat'), 'room', 'chat.v1', {}, { groupRef: ROOM }),
        candidateSessionIds: ['bob', 'carol'],
        recipientScope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId },
        capturedConnectionGenerationIds: null
    };

    assert.deepEqual(await filters.durable(captured), ['bob']);
    assert.deepEqual(await filters.local(captured), []);
});

function createAuthority(liveSessionIds: readonly string[]): GroupPublicationAuthority {
    const group = createTestGroup(ROOM);
    return {
        snapshot: {
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
            group,
            members: [],
            activeSessions: [],
            memberCount: 0,
            onlineMemberCount: 0,
            publicationGrants: []
        },
        subscriptions: [],
        liveSessionGenerations: Object.fromEntries(liveSessionIds.map((sessionId) => [sessionId, [`generation-${sessionId}`]]))
    };
}
