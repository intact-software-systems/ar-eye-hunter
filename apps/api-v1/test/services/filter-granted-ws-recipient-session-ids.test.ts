import assert from 'node:assert/strict';

import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import { newALBroadcastMessage, newALEventRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupMember, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import {
    filterGrantedWsRecipientSessionIds,
    type FilterGrantedWsRecipientSessionIdsInput
} from '../../src/services/filter-granted-ws-recipient-session-ids.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const GRANTED_TOPIC = 'room.feed';
const SERVER_PEER_ID = 'ws-server';

Deno.test('a members-topic row keeps the durable filter result unchanged and reads no snapshot', async () => {
    let reads = 0;
    const eligible = await filterGrantedWsRecipientSessionIds({
        ...portInput(feedMessage('alice', 'room.chat'), ['bob', 'carol']),
        readCurrentSnapshot: () => {
            reads += 1;
            return Promise.resolve(grantedSnapshot());
        }
    });

    assert.deepEqual(eligible, ['bob', 'carol']);
    assert.equal(reads, 0);
});

Deno.test('a granted row from a publish-granted session reaches the durable eligible subscribers alone', async () => {
    const eligible = await filterGrantedWsRecipientSessionIds(portInput(feedMessage('alice'), ['bob', 'carol']));

    // carol holds no subscribe grant; dave subscribes but the durable filter found no current socket for him.
    assert.deepEqual(eligible, ['bob']);
});

Deno.test('a granted row whose publisher lost its publish grant reaches nobody', async () => {
    const eligible = await filterGrantedWsRecipientSessionIds({
        ...portInput(feedMessage('alice'), ['bob', 'carol']),
        readCurrentSnapshot: () => Promise.resolve(grantedSnapshot({ alice: { publish: false, subscribe: false } }))
    });

    assert.deepEqual(eligible, []);
});

Deno.test('a server-origin granted row re-checks the subscribe half only', async () => {
    const eligible = await filterGrantedWsRecipientSessionIds({
        ...portInput(feedMessage(SERVER_PEER_ID), ['alice', 'bob', 'carol']),
        readCurrentSnapshot: () => Promise.resolve(grantedSnapshot({ bob: { publish: false, subscribe: false } }))
    });

    assert.deepEqual(eligible, ['alice']);
});

Deno.test('a granted row rejects when the snapshot read fails or finds no room, so its step sends nothing and retries', async () => {
    for (const read of [() => Promise.reject(new Error('probe failed')), () => Promise.resolve(undefined)]) {
        await assert.rejects(
            filterGrantedWsRecipientSessionIds({ ...portInput(feedMessage('alice'), ['bob']), readCurrentSnapshot: read })
        );
    }
});

function portInput(message: ALMessage, durableEligibleSessionIds: readonly string[]): FilterGrantedWsRecipientSessionIdsInput {
    const grantedTopics = new WsGrantedTopicSet();
    grantedTopics.add(GRANTED_TOPIC);
    return {
        message,
        candidateSessionIds: ['alice', 'bob', 'carol', 'dave'],
        recipientScope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId },
        durableEligibleSessionIds,
        grantedTopics,
        serverPeerId: SERVER_PEER_ID,
        readCurrentSnapshot: () => Promise.resolve(grantedSnapshot()),
        nowEpochMs: Date.now()
    };
}

function feedMessage(senderId: string, topicId = GRANTED_TOPIC): ALMessage {
    return newALBroadcastMessage(senderId, newALEventRoute(topicId, ROOM.groupId, 'feed'), 'room', 'feed.v1', { n: 1 }, {
        groupRef: ROOM,
        reliability: 'at-least-once',
        ack: 'receiver',
        ttlMs: 30_000
    });
}

type Permissions = Readonly<{ publish: boolean; subscribe: boolean; }>;

/** Alice publishes and subscribes, Bob and Dave subscribe, Carol holds nothing; `overrides` replaces a principal's row. */
function grantedSnapshot(overrides: Readonly<Record<string, Permissions>> = {}): GroupSnapshot {
    const principalIds = ['alice', 'bob', 'carol', 'dave'];
    const permissions: Readonly<Record<string, Permissions>> = {
        alice: { publish: true, subscribe: true },
        bob: { publish: false, subscribe: true },
        dave: { publish: false, subscribe: true },
        ...overrides
    };
    const group = createTestGroup({ ...ROOM, snapshotVersion: 4, presenceVersion: 1, activeMemberCount: principalIds.length });
    return {
        causalRevision: { groupRevision: 4, presenceRevision: 1 },
        group,
        members: principalIds.map((principalId): GroupMember => ({
            ...ROOM,
            principalId,
            role: principalId === 'alice' ? 'owner' : 'member',
            status: 'active',
            joined: group.created,
            updated: group.updated,
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        })),
        activeSessions: principalIds.map((sessionId): GroupPresenceSession => ({
            ...ROOM,
            principalId: sessionId,
            sessionId,
            generationId: `generation-${sessionId}`,
            connectionGenerationId: `ws-generation-${sessionId}`,
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 2,
            expiresAtEpochMs: 4_000_000_000_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: principalIds.length,
        onlineMemberCount: principalIds.length,
        publicationGrants: Object.entries(permissions)
            .filter(([, granted]) => granted.publish || granted.subscribe)
            .map(([principalId, granted]) => ({
                ...ROOM,
                principalId,
                topics: { [GRANTED_TOPIC]: granted },
                updated: group.updated
            }))
    };
}
