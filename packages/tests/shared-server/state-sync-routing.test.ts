import { describe, expect, it } from 'vitest';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type {
    GroupEvent,
    GroupMember,
    GroupMemberStatus,
    GroupPresenceSession,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { resolveStateSyncRecipients } from '@shared-server/rallar-system/state-sync-routing.ts';

const NOW = 1_000;

describe('state-sync routing group visibility', () => {
    it('routes full group snapshots and events only to full-read members', () => {
        const server = createWebSocketServer([
            'alice-session',
            'bob-session',
            'carol-session',
        ]);
        const snapshot = createGroupSnapshot([
            { principalId: 'alice', sessionId: 'alice-session', status: 'active' },
            { principalId: 'bob', sessionId: 'bob-session', status: 'invited' },
            { principalId: 'carol', sessionId: 'carol-session', status: 'banned' },
        ]);
        const clients = [
            createClientSnapshot('alice', 'alice-session'),
            createClientSnapshot('bob', 'bob-session'),
            createClientSnapshot('carol', 'carol-session'),
        ];

        const snapshotRecipients = resolveStateSyncRecipients(
            server,
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(
                    AppTopics.groupStateSnapshot,
                    snapshot.group.groupId,
                    snapshot.group.groupId,
                ),
                'all',
                AppTopics.groupStateSnapshot,
                snapshot,
            ),
            { readClientSnapshots: () => clients, now: () => NOW },
        );
        const eventRecipients = resolveStateSyncRecipients(
            server,
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateEvent, 'room-1', 'event-1'),
                'all',
                AppTopics.groupStateEvent,
                createGroupEvent('event-1'),
            ),
            {
                findGroupSnapshotByRef: () => snapshot,
                readClientSnapshots: () => clients,
                now: () => NOW,
            },
        );

        expect(connectionIds(snapshotRecipients)).toEqual(['alice-session']);
        expect(connectionIds(eventRecipients)).toEqual(['alice-session']);
    });

    it('does not route full directory snapshots to directory-only non-members', () => {
        const server = createWebSocketServer(['alice-session', 'bob-session']);
        const snapshot = createGroupSnapshot([
            { principalId: 'alice', sessionId: 'alice-session', status: 'active' },
        ]);
        const clients = [
            createClientSnapshot('alice', 'alice-session'),
            createClientSnapshot('bob', 'bob-session'),
        ];

        const recipients = resolveStateSyncRecipients(
            server,
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(
                    AppTopics.groupDirectorySnapshot,
                    snapshot.group.groupId,
                    snapshot.group.groupId,
                ),
                'all',
                AppTopics.groupDirectorySnapshot,
                snapshot,
            ),
            { readClientSnapshots: () => clients, now: () => NOW },
        );

        expect(connectionIds(recipients)).toEqual(['alice-session']);
    });
});

function connectionIds(
    recipients: ReturnType<typeof resolveStateSyncRecipients>,
): readonly string[] {
    return (recipients ?? [])
        .map((recipient) => recipient.connectionId)
        .sort();
}

function createWebSocketServer(sessionIds: readonly string[]): JsonWebSocketServer {
    return {
        connections: new Map(
            sessionIds.map((sessionId) => [
                sessionId,
                { id: sessionId, isOpen: true },
            ]),
        ),
    } as unknown as JsonWebSocketServer;
}

function createClientSnapshot(
    principalId: string,
    sessionId: string,
): ClientSnapshot {
    return {
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            username: principalId,
            displayName: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            profileVersion: 1,
            presenceVersion: 1,
            snapshotVersion: 1,
            created: { atEpochMs: 1, byServiceId: 'test' },
            updated: { atEpochMs: 1, byServiceId: 'test' },
        },
        instances: [],
        activeSessions: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId,
                clientInstanceId: 'browser',
                sessionId,
                status: 'active',
                presenceState: 'online',
                transport: 'ws',
                authenticatedAtEpochMs: 1,
                connectedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: NOW,
                expiresAtEpochMs: NOW + 60_000,
            },
        ],
        isOnline: true,
        activeSessionCount: 1,
    };
}

function createGroupSnapshot(
    members: readonly Readonly<{
        principalId: string;
        sessionId: string;
        status: GroupMemberStatus;
    }>[],
): GroupSnapshot {
    return {
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            displayName: 'room-1',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: members.length,
            created: { atEpochMs: 1, byServiceId: 'test' },
            updated: { atEpochMs: 1, byServiceId: 'test' },
        },
        members: members.map(toGroupMember),
        activeSessions: members.map(toGroupPresenceSession),
        memberCount: members.filter((member) => member.status === 'active').length,
        onlineMemberCount: members.length,
    };
}

function toGroupMember(
    input: Readonly<{
        principalId: string;
        status: GroupMemberStatus;
    }>,
): GroupMember {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        principalId: input.principalId,
        role: 'member',
        status: input.status,
        joined: { atEpochMs: 1, byServiceId: 'test' },
        updated: { atEpochMs: 1, byServiceId: 'test' },
    };
}

function toGroupPresenceSession(
    input: Readonly<{
        principalId: string;
        sessionId: string;
    }>,
): GroupPresenceSession {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        principalId: input.principalId,
        sessionId: input.sessionId,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: NOW,
        expiresAtEpochMs: NOW + 60_000,
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
        occurredAtEpochMs: NOW,
        actor: { serviceId: 'test' },
    };
}
