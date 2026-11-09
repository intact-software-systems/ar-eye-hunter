import assert from 'node:assert/strict';

import type { GroupPublicationAuthority } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import { newALBroadcastMessage, newALEventRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupMember, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import {
    filterDurablyLiveWsSessionIds,
    type FilterDurablyLiveWsSessionIdsInput
} from '../../src/services/filter-durably-live-ws-session-ids.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const GRANTED_TOPIC = 'room.feed';
const MEMBERS_TOPIC = 'room.chat';
const SERVER_PEER_ID = 'ws-server';
const PRINCIPAL_IDS = ['alice', 'bob', 'carol', 'dave'];
const PRINCIPAL: ClientPrincipalRef = { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId, principalId: 'erin' };

Deno.test('a granted row keeps the candidates whose live subscription asserts the captured generation, reading the authority once', async () => {
    let reads = 0;
    const eligible = await filterDurablyLiveWsSessionIds({
        ...durableInput(feedMessage('alice'), ['alice', 'bob', 'carol', 'dave']),
        // alice re-subscribed under a new generation after the row was routed; carol holds no subscribe; dave was captured with none.
        capturedConnectionGenerationIds: { alice: 'client-generation-alice-before', bob: 'client-generation-bob', carol: 'client-generation-carol' },
        readPublicationAuthority: () => {
            reads += 1;
            return Promise.resolve(createAuthority());
        }
    });

    assert.deepEqual(eligible, ['bob']);
    assert.equal(reads, 1);
});

Deno.test('a room row keeps the candidates with a live generation wherever their socket is, and nobody when the room has no snapshot', async () => {
    const live = await filterDurablyLiveWsSessionIds({
        ...durableInput(feedMessage('alice', MEMBERS_TOPIC), ['bob', 'carol', 'dave']),
        readPublicationAuthority: () => Promise.resolve(createAuthority(['bob', 'carol']))
    });
    const absent = await filterDurablyLiveWsSessionIds({
        ...durableInput(feedMessage('alice', MEMBERS_TOPIC), ['bob', 'carol', 'dave']),
        readPublicationAuthority: () => Promise.resolve(undefined)
    });

    assert.deepEqual(live, ['bob', 'carol']);
    assert.deepEqual(absent, []);
});

Deno.test('a principal row keeps the principal\'s live sessions', async () => {
    const message = principalMessage();
    const live = await filterDurablyLiveWsSessionIds({
        ...durableInput(message, ['s1', 's3']),
        readPrincipalLiveSessionIds: (ref: ClientPrincipalRef) => {
            assert.deepEqual(ref, PRINCIPAL);
            return Promise.resolve(['s1', 's2']);
        }
    });
    const absent = await filterDurablyLiveWsSessionIds({
        ...durableInput(message, ['s1', 's3']),
        readPrincipalLiveSessionIds: () => Promise.resolve(undefined)
    });

    assert.deepEqual(live, ['s1']);
    assert.deepEqual(absent, []);
});

Deno.test('a row naming no group and no principal keeps its candidates', async () => {
    const message = newALUnicastMessage('alice', newALEventRoute('app.direct', 'direct', 'note'), 'bob', 'note.v1', { n: 1 }, {
        reliability: 'at-least-once',
        ack: 'receiver'
    });

    assert.deepEqual(await filterDurablyLiveWsSessionIds(durableInput(message, ['bob'])), ['bob']);
});

/** Both durable reads reject unless a test names the one its row reads. */
function durableInput(message: ALMessage, candidateSessionIds: readonly string[]): FilterDurablyLiveWsSessionIdsInput {
    const grantedTopics = new WsGrantedTopicSet();
    grantedTopics.add(GRANTED_TOPIC);
    return {
        message,
        candidateSessionIds,
        recipientScope: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId },
        capturedConnectionGenerationIds: Object.fromEntries(PRINCIPAL_IDS.map((sessionId) => [sessionId, `client-generation-${sessionId}`])),
        grantedTopics,
        serverPeerId: SERVER_PEER_ID,
        readPublicationAuthority: () => Promise.reject(new Error('this row reads no publication authority')),
        readPrincipalLiveSessionIds: () => Promise.reject(new Error('this row reads no principal sessions')),
        nowEpochMs: Date.now()
    };
}

/** The granted snapshot, every session subscribed under its one client generation; only `liveSessionIds` hold a live one. */
function createAuthority(liveSessionIds: readonly string[] = PRINCIPAL_IDS): GroupPublicationAuthority {
    return {
        snapshot: grantedSnapshot(),
        subscriptions: PRINCIPAL_IDS.map((sessionId): GroupTopicSubscription => ({
            sessionId,
            principalId: sessionId,
            topicId: GRANTED_TOPIC,
            connectionGenerationId: `client-generation-${sessionId}`,
            leaseExpiresAtEpochMs: Date.now() + 120_000
        })),
        liveSessionGenerations: Object.fromEntries(liveSessionIds.map((sessionId) => [sessionId, [`client-generation-${sessionId}`]]))
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

/** A server's principal broadcast, as state sync addresses one: no room, only the principal. */
function principalMessage(): ALMessage {
    const base = newALBroadcastMessage(SERVER_PEER_ID, newALEventRoute('app.client-state', 'principal', 'event'), 'world', 'event.v1', {}, {
        reliability: 'at-least-once',
        ack: 'receiver'
    });
    return { ...base, targets: { mode: 'broadcast', scope: 'principal', principalRef: PRINCIPAL } };
}

/** Alice publishes and subscribes, Bob and Dave subscribe, Carol holds nothing. */
function grantedSnapshot(): GroupSnapshot {
    const permissions = {
        alice: { publish: true, subscribe: true },
        bob: { publish: false, subscribe: true },
        dave: { publish: false, subscribe: true }
    };
    const group = createTestGroup({ ...ROOM, snapshotVersion: 4, presenceVersion: 1, activeMemberCount: PRINCIPAL_IDS.length });
    return {
        causalRevision: { groupRevision: 4, presenceRevision: 1 },
        group,
        members: PRINCIPAL_IDS.map((principalId): GroupMember => ({
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
        activeSessions: PRINCIPAL_IDS.map((sessionId): GroupPresenceSession => ({
            ...ROOM,
            principalId: sessionId,
            sessionId,
            generationId: `generation-${sessionId}`,
            connectionGenerationId: `ws-generation-${sessionId}`,
            publicationKey: null,
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 2,
            expiresAtEpochMs: 4_000_000_000_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: PRINCIPAL_IDS.length,
        onlineMemberCount: PRINCIPAL_IDS.length,
        publicationGrants: Object.entries(permissions).map(([principalId, granted]) => ({
            ...ROOM,
            principalId,
            topics: { [GRANTED_TOPIC]: granted },
            updated: group.updated
        }))
    };
}
