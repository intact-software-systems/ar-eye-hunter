import { describe, expect, it } from 'vitest';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type {
    AuditStamp,
    GroupEvent,
    GroupMember,
    GroupMemberStatus,
    GroupPresenceSession,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import {
    resolveStateSyncRecipients,
    sendStateSyncMessage,
} from '@shared-server/rallar-system/state-sync-routing.ts';

const NOW = 1_000;

describe('state-sync routing group visibility', () => {
    it('routes full group snapshots and events only to full-read members', () => {
        const server = createWebSocketServer([
            'alice-session',
            'bob-session',
            'carol-session',
            'dave-session',
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
            createClientSnapshot('dave', 'dave-session'),
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

    it('sends state-sync messages directly to resolved recipients', () => {
        const server = createCountingWebSocketServer([
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
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.groupStateSnapshot,
                snapshot.group.groupId,
                snapshot.group.groupId,
            ),
            'all',
            AppTopics.groupStateSnapshot,
            snapshot,
        );

        const sent = sendStateSyncMessage(server, message, {
            readClientSnapshots: () => clients,
            now: () => NOW,
        });

        expect(sent).toBe(1);
        expect(server.encodeCalls).toBe(1);
        expect(server.broadcastCalls).toBe(0);
        expect(server.sentConnectionIds).toEqual(['alice-session']);
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

type CountingWebSocketServer = JsonWebSocketServer & Readonly<{
    encodeCalls: number;
    broadcastCalls: number;
    sentConnectionIds: readonly string[];
}>;

function createCountingWebSocketServer(
    sessionIds: readonly string[],
): CountingWebSocketServer {
    const sentConnectionIds: string[] = [];
    const counters = {
        encodeCalls: 0,
        broadcastCalls: 0,
    };
    return {
        connections: new Map(
            sessionIds.map((sessionId) => [
                sessionId,
                { id: sessionId, isOpen: true },
            ]),
        ),
        get encodeCalls() {
            return counters.encodeCalls;
        },
        get broadcastCalls() {
            return counters.broadcastCalls;
        },
        sentConnectionIds,
        encode: (message: unknown) => {
            counters.encodeCalls += 1;
            return { text: JSON.stringify(message) };
        },
        sendEncoded: (connectionId: string) => {
            sentConnectionIds.push(connectionId);
        },
        broadcast: () => {
            counters.broadcastCalls += 1;
            return 0;
        },
    } as unknown as CountingWebSocketServer;
}

function createClientSnapshot(
    principalId: string,
    sessionId: string,
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
            lastSeenAtEpochMs: NOW,
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
                expiresAtEpochMs: NOW + 60_000,
            },
        ],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: NOW,
    };
}

function createGroupSnapshot(
    members: readonly Readonly<{
        principalId: string;
        sessionId: string;
        status: GroupMemberStatus;
    }>[],
): GroupSnapshot {
    const activeMembers = members.filter((member) => member.status === 'active');
    const audit = createAuditStamp();
    return {
        stateRevision: 1,
        causalRevision: { groupRevision: 1, presenceRevision: members.length },
        group: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
            slug: null,
            displayName: 'room-1',
            description: null,
            kind: 'room',
            status: 'active',
            archived: null,
            deleted: null,
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            activeMemberCount: activeMembers.length,
            ownerPrincipalId: 'alice',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: members.length,
            created: audit,
            updated: audit,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
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
    const role: GroupMember['role'] = 'member';
    const common = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1',
        principalId: input.principalId,
        role,
        joined: createAuditStamp(),
        updated: createAuditStamp(),
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
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
    return { ...common, status: input.status, left: null, removed: null, banned: null };
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
        generationId: `${input.sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
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
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        occurredAtEpochMs: NOW,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
    };
}

function createAuditStamp(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
