import assert from 'node:assert/strict';

import type { GroupPublicationAuthority } from '@shared-server/rallar-system/group-state/persistence/subscription/read-group-topic-subscriptions.ts';
import { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import { newALBroadcastMessage, newALEventRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupTopicSubscription } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupMember, GroupPresenceSession, GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createTestGroup } from '../../../../packages/tests/create-test-group.ts';
import {
    filterGrantedWsRecipientSessionIds,
    type FilterGrantedWsRecipientSessionIdsInput
} from '../../src/services/filter-granted-ws-recipient-session-ids.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const GRANTED_TOPIC = 'room.feed';
const SERVER_PEER_ID = 'ws-server';
const PRINCIPAL_IDS = ['alice', 'bob', 'carol', 'dave'];

Deno.test('a members row passes the durable filter only', async () => {
    const eligible = await filterGrantedWsRecipientSessionIds({
        ...portInput(feedMessage('alice', 'room.chat'), ['bob', 'carol']),
        capturedConnectionGenerationIds: null,
        readPublicationAuthority: () => Promise.reject(new Error('a members row reads no publication authority'))
    });

    assert.deepEqual(eligible, ['bob', 'carol']);
});

Deno.test('a captured generation equal to the current one is kept, a differing or absent one is dropped', async () => {
    const eligible = await filterGrantedWsRecipientSessionIds({
        ...portInput(feedMessage('alice'), ['alice', 'bob', 'dave']),
        // alice re-subscribed under a new generation after the row was routed; dave was captured with none.
        capturedConnectionGenerationIds: { alice: 'client-generation-alice-before', bob: 'client-generation-bob' }
    });

    assert.deepEqual(eligible, ['bob']);
});

Deno.test('a granted row without captured generations reaches nobody and reads no publication authority', async () => {
    const eligible = await filterGrantedWsRecipientSessionIds({
        ...portInput(feedMessage('alice'), ['bob']),
        capturedConnectionGenerationIds: null,
        readPublicationAuthority: () => Promise.reject(new Error('a row captured without generations reads nothing'))
    });

    assert.deepEqual(eligible, []);
});

Deno.test('a granted row reaches a durable eligible subscriber only while its live subscription stands', async () => {
    const authority = grantedAuthority();
    const eligible = await filterGrantedWsRecipientSessionIds({
        ...portInput(feedMessage('alice'), ['bob', 'dave']),
        readPublicationAuthority: () => Promise.resolve({ ...authority, subscriptions: authority.subscriptions.filter((row) => row.sessionId !== 'bob') })
    });

    assert.deepEqual(eligible, ['dave']);
});

Deno.test('a granted row from a publish-granted session reaches the durable eligible subscribers alone', async () => {
    const eligible = await filterGrantedWsRecipientSessionIds(portInput(feedMessage('alice'), ['bob', 'carol']));

    // carol holds no subscribe grant; dave subscribes but the durable filter found no current socket for him.
    assert.deepEqual(eligible, ['bob']);
});

Deno.test('a granted row whose publisher lost its publish grant reaches nobody', async () => {
    const eligible = await filterGrantedWsRecipientSessionIds({
        ...portInput(feedMessage('alice'), ['bob', 'carol']),
        readPublicationAuthority: () => Promise.resolve(grantedAuthority({ alice: { publish: false, subscribe: false } }))
    });

    assert.deepEqual(eligible, []);
});

Deno.test('a server-origin granted row re-checks the subscribe half only', async () => {
    const eligible = await filterGrantedWsRecipientSessionIds({
        ...portInput(feedMessage(SERVER_PEER_ID), ['alice', 'bob', 'carol']),
        readPublicationAuthority: () => Promise.resolve(grantedAuthority({ bob: { publish: false, subscribe: false } }))
    });

    assert.deepEqual(eligible, ['alice']);
});

Deno.test('a granted row rejects when the authority read fails, so its step sends nothing and retries', async () => {
    await assert.rejects(
        filterGrantedWsRecipientSessionIds({
            ...portInput(feedMessage('alice'), ['bob']),
            readPublicationAuthority: () => Promise.reject(new Error('probe failed'))
        })
    );
});

Deno.test('a granted row whose read finds no current snapshot of its room, or a foreign one, reaches nobody', async () => {
    const foreign = grantedAuthority();
    for (
        const read of [
            () => Promise.resolve(undefined),
            () => Promise.resolve({ ...foreign, snapshot: { ...foreign.snapshot, group: { ...foreign.snapshot.group, groupId: 'other-room' } } })
        ]
    ) {
        assert.deepEqual(
            await filterGrantedWsRecipientSessionIds({ ...portInput(feedMessage('alice'), ['bob']), readPublicationAuthority: read }),
            []
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
        capturedConnectionGenerationIds: Object.fromEntries(PRINCIPAL_IDS.map((sessionId) => [sessionId, `client-generation-${sessionId}`])),
        durableEligibleSessionIds,
        grantedTopics,
        serverPeerId: SERVER_PEER_ID,
        readPublicationAuthority: () => Promise.resolve(grantedAuthority()),
        nowEpochMs: Date.now()
    };
}

/** The granted snapshot, with every session's live subscription asserted by its one live client generation. */
function grantedAuthority(overrides: Readonly<Record<string, Permissions>> = {}): GroupPublicationAuthority {
    const snapshot = grantedSnapshot(overrides);
    return {
        snapshot,
        subscriptions: PRINCIPAL_IDS.map((sessionId): GroupTopicSubscription => ({
            sessionId,
            principalId: sessionId,
            topicId: GRANTED_TOPIC,
            connectionGenerationId: `client-generation-${sessionId}`,
            leaseExpiresAtEpochMs: Date.now() + 120_000,
            admittedAtGroupRevision: snapshot.group.snapshotVersion
        })),
        liveSessionGenerations: Object.fromEntries(PRINCIPAL_IDS.map((sessionId) => [sessionId, [`client-generation-${sessionId}`]]))
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
    const principalIds = PRINCIPAL_IDS;
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
