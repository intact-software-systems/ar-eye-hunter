import { computeGroupStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { describe, expect, it } from 'vitest';

import { resolveStateSyncRecipients } from '@shared-server/rallar-system/state-sync/state-sync-routing.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { AuditStamp, GroupEvent, GroupMember, GroupMemberStatus, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createTestGroup } from '../../../create-test-group.ts';

const NOW = 1_000;

describe('state-sync routing group visibility', () => {
    it('routes group snapshots by visibility and events by their persisted audience', () => {
        const server = createWebSocketServer([
            'alice-session',
            'bob-session',
            'carol-session',
            'dave-session'
        ]);
        const snapshot = createGroupSnapshot([
            { principalId: 'alice', sessionId: 'alice-session', status: 'active' },
            { principalId: 'bob', sessionId: 'bob-session', status: 'invited' },
            { principalId: 'carol', sessionId: 'carol-session', status: 'banned' }
        ]);
        const clients = [
            createClientSnapshot('alice', 'alice-session'),
            createClientSnapshot('bob', 'bob-session'),
            createClientSnapshot('carol', 'carol-session'),
            createClientSnapshot('dave', 'dave-session')
        ];
        const eventSnapshot = createGroupSnapshot([
            { principalId: 'alice', sessionId: 'alice-session', status: 'active' }
        ]);

        const snapshotRecipients = resolveStateSyncRecipients(
            server,
            toGroupSnapshotMessage(snapshot, AppTopics.groupStateSnapshot),
            { findGroupSnapshotByRef: () => snapshot, readClientSnapshots: () => clients, now: () => NOW }
        );
        const eventRecipients = resolveStateSyncRecipients(
            server,
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateEvent, 'room-1', 'event-1'),
                'room',
                AppTopics.groupStateEvent,
                createGroupEventEnvelope(eventSnapshot, ['alice-session']),
                { groupRef: eventSnapshot.group }
            ),
            {
                findGroupSnapshotByRef: () => snapshot,
                readClientSnapshots: () => clients,
                now: () => NOW
            }
        );

        expect(connectionIds(snapshotRecipients)).toEqual(['alice-session']);
        expect(connectionIds(eventRecipients)).toEqual(['alice-session']);
    });

    it('does not route full directory snapshots to directory-only non-members', () => {
        const server = createWebSocketServer(['alice-session', 'bob-session']);
        const snapshot = createGroupSnapshot([
            { principalId: 'alice', sessionId: 'alice-session', status: 'active' }
        ]);
        const clients = [
            createClientSnapshot('alice', 'alice-session'),
            createClientSnapshot('bob', 'bob-session')
        ];

        const recipients = resolveStateSyncRecipients(
            server,
            toGroupSnapshotMessage(snapshot, AppTopics.groupDirectorySnapshot),
            { findGroupSnapshotByRef: () => snapshot, readClientSnapshots: () => clients, now: () => NOW }
        );

        expect(connectionIds(recipients)).toEqual(['alice-session']);
    });

    it('fails closed when a persisted logical group audience differs from its payload', () => {
        const server = createWebSocketServer(['alice-session']);
        const snapshot = createGroupSnapshot([
            { principalId: 'alice', sessionId: 'alice-session', status: 'active' }
        ]);
        const valid = toGroupSnapshotMessage(snapshot, AppTopics.groupStateSnapshot);
        const message = {
            ...valid,
            targets: { mode: 'broadcast' as const, scope: 'room' as const, groupRef: { ...snapshot.group, groupId: 'different-room' } }
        };

        expect(resolveStateSyncRecipients(server, message, {
            readClientSnapshots: () => [
                createClientSnapshot('alice', 'alice-session')
            ],
            now: () => NOW
        })).toEqual([]);
    });
});

function connectionIds(
    recipients: ReturnType<typeof resolveStateSyncRecipients>
): readonly string[] {
    return (recipients ?? [])
        .map((recipient) => recipient.connectionId)
        .sort();
}

function createGroupEventEnvelope(
    snapshot: GroupSnapshot,
    audienceSessionIds: readonly string[]
): GroupStateDeltaEnvelope {
    return {
        event: {
            ...createGroupEvent('event-1'),
            snapshotVersion: snapshot.group.snapshotVersion,
            causalRevision: snapshot.causalRevision
        },
        predecessorCausalRevision: snapshot.causalRevision,
        resultingCausalRevision: snapshot.causalRevision,
        members: [],
        removedMemberPrincipalIds: [],
        sessions: snapshot.activeSessions,
        removedSessionIds: [],
        activeSessionIds: snapshot.activeSessions.map((session) => session.sessionId),
        group: snapshot.group,
        memberCount: snapshot.memberCount,
        onlineMemberCount: snapshot.onlineMemberCount,
        audienceSessionIds
    };
}

function createWebSocketServer(sessionIds: readonly string[]): JsonWebSocketServer {
    const server = new JsonWebSocketServer();
    for (const sessionId of sessionIds) {
        server.addConnection(new ConnectionContext({ id: sessionId, socket: new OpenSocket() }));
    }
    return server;
}

class OpenSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = WebSocket.OPEN;
    readonly url = 'ws://state-sync-routing-test';
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;

    close(): void {}

    send(): void {}
}

function createClientSnapshot(
    principalId: string,
    sessionId: string
): ClientSnapshot {
    const audit = createAuditStamp();
    return {
        stateRevision: 1,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            username: principalId,
            displayName: principalId,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            profileVersion: 1,
            presenceVersion: 1,
            snapshotVersion: 1,
            created: audit,
            updated: audit,
            lastSeenAtEpochMs: NOW
        },
        instances: [],
        activeSessions: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId,
                clientInstanceId: 'browser',
                sessionId,
                generationId: `${sessionId}-generation`,
                generationVersion: 1,
                status: 'active',
                disconnectedAtEpochMs: null,
                disconnectReason: null,
                presenceState: 'online',
                transport: 'ws',
                connectionId: sessionId,
                authenticatedAtEpochMs: 1,
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: NOW,
                expiresAtEpochMs: NOW + 60_000
            }
        ],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: NOW
    };
}

interface GroupRoutingFixtureMember {
    readonly principalId: string;
    readonly sessionId: string;
    readonly status: GroupMemberStatus;
}

function createGroupSnapshot(members: readonly GroupRoutingFixtureMember[]): GroupSnapshot {
    const activeMembers = members.filter((member) => member.status === 'active');
    const audit = createAuditStamp();
    return {
        causalRevision: { groupRevision: 1, presenceRevision: members.length },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            displayName: 'room-1',
            activeMemberCount: activeMembers.length,
            ownerPrincipalId: 'alice',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: members.length,
            created: audit,
            updated: audit
        }),
        members: members.map(toGroupMember),
        activeSessions: activeMembers.map(toGroupPresenceSession),
        memberCount: members.filter((member) => member.status === 'active').length,
        onlineMemberCount: activeMembers.length
    };
}

function toGroupMember(input: GroupRoutingFixtureMember): GroupMember {
    const role: GroupMember['role'] = input.principalId === 'alice'
        ? 'owner'
        : 'member';
    const common = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        principalId: input.principalId,
        role,
        joined: createAuditStamp(),
        updated: createAuditStamp(),
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
    if (input.status === 'left') {
        return { ...common, status: 'left', left: createAuditStamp(), removed: null, banned: null };
    }
    if (input.status === 'removed') {
        return { ...common, status: 'removed', left: null, removed: createAuditStamp(), banned: null };
    }
    if (input.status === 'banned') {
        return { ...common, status: 'banned', left: null, removed: null, banned: createAuditStamp() };
    }
    if (input.status === 'invited') {
        return { ...common, status: 'invited', joined: null, left: null, removed: null, banned: null };
    }
    return { ...common, status: 'active', left: null, removed: null, banned: null };
}

function toGroupPresenceSession(input: GroupRoutingFixtureMember): GroupPresenceSession {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        principalId: input.principalId,
        sessionId: input.sessionId,
        generationId: `${input.sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: NOW,
        expiresAtEpochMs: NOW + 60_000
    };
}

function createGroupEvent(eventId: string): GroupEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        eventId,
        eventType: 'group-updated',
        snapshotVersion: 2,
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        occurredAtEpochMs: NOW,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {}
    };
}

function createAuditStamp(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

function toGroupSnapshotMessage(snapshot: GroupSnapshot, topicId: string) {
    const entries = computeGroupStateSyncEntries({
        commandId: 'routing-snapshot',
        aggregateRef: snapshot.group,
        acceptedCausalRevision: snapshot.causalRevision,
        audience: { kind: 'group', applicationId: snapshot.group.applicationId, workspaceId: snapshot.group.workspaceId, resourceId: snapshot.group.groupId },
        createdAtEpochMs: NOW,
        expireAtEpochMs: NOW + 60_000,
        effects: [{ effectKind: topicId === AppTopics.groupDirectorySnapshot ? 'scope-directory' : 'member-state', payloadKind: 'snapshot', payload: snapshot }]
    }, 'server-1');
    return decodePersistedALMessage(entries[0].resource);
}
