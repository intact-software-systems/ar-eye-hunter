import { describe, expect, it } from 'vitest';

import { computeClientStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { resolveStateSyncRecipients } from '@shared-server/rallar-system/state-sync/state-sync-routing.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createTestGroup } from '../../../create-test-group.ts';
import { createOpenTestWebSocket } from '../websocket/test-support/open-test-websocket.ts';

const NOW_EPOCH_MS = 1_800_000_000_000;

describe('principal state-sync audience', () => {
    it('stamps principal-audience rows with the principal scope', () => {
        const [entry] = computeClientStateSyncEntries(
            createComputedClientSnapshotStateSync(createClientSnapshot('alice', ['alice-session-1'])),
            'server-1'
        );
        const message = decodePersistedALMessage(entry!.resource);

        expect(message.targets).toEqual({
            mode: 'broadcast',
            scope: 'principal',
            principalRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId: 'alice'
            }
        });
    });

    it('resolves principal rows to own sessions plus co-group sessions, never strangers', () => {
        const message = toPrincipalStampedMessage('alice', ['alice-session-1', 'alice-session-2']);
        const webSocketServer = createOpenConnections([
            'alice-session-1',
            'alice-session-2',
            'bob-session',
            'carol-session'
        ]);

        const recipients = resolveStateSyncRecipients(webSocketServer, message, {
            readClientSnapshots: () => [
                createClientSnapshot('alice', ['alice-session-1', 'alice-session-2']),
                createClientSnapshot('bob', ['bob-session']),
                createClientSnapshot('carol', ['carol-session'])
            ],
            readGroupSnapshots: () => [
                createGroupSnapshot(['alice', 'bob'], {
                    alice: 'alice-session-1',
                    bob: 'bob-session'
                })
            ],
            now: () => NOW_EPOCH_MS
        });

        expect(recipients).toBeDefined();
        expect([...new Set(recipients!.map((recipient) => recipient.connectionId))].sort()).toEqual([
            'alice-session-1',
            'alice-session-2',
            'bob-session'
        ]);
    });

    // Regression: in a cluster, the connect mutation can commit on a server other
    // than the one hosting the socket. That host's cache then still predates the
    // row, and resolving from the cache alone drops the snapshot that would have
    // installed it (observed as the api-v1-rtc-topology-convergence CI flake).
    it('delivers producer-authorized own-session carriers when the local cache lags the mutation', () => {
        const messages = computeClientStateSyncEntries(createComputedClientSnapshotStateSync(createClientSnapshot('alice', ['alice-session-1'])), 'server-1')
            .map((entry) => decodePersistedALMessage(entry.resource));
        const webSocketServer = createOpenConnections(['alice-session-1']);

        const recipients = messages.flatMap((message) =>
            resolveStateSyncRecipients(webSocketServer, message, {
                readClientSnapshots: () => [],
                readGroupSnapshots: () => [],
                now: () => NOW_EPOCH_MS
            }) ?? []
        );

        expect(recipients).toBeDefined();
        expect(recipients!.map((recipient) => recipient.connectionId)).toEqual(['alice-session-1']);
    });

    it('routes client event rows only to the targeted principal sessions', () => {
        const message = toPrincipalStampedEventMessage('alice');
        const webSocketServer = createOpenConnections(['alice-session', 'bob-session']);

        const recipients = resolveStateSyncRecipients(webSocketServer, message, {
            readClientSnapshots: () => [
                createClientSnapshot('alice', ['alice-session']),
                createClientSnapshot('bob', ['bob-session'])
            ],
            readGroupSnapshots: () => [],
            now: () => NOW_EPOCH_MS
        });

        expect(recipients?.map((recipient) => recipient.connectionId)).toEqual([
            'alice-session'
        ]);
    });

    it('ignores a payload snapshot whose principal differs from the stamped target', () => {
        const message = toPrincipalStampedMessage('alice', ['alice-session-1']);
        const forged: ALMessage = {
            ...message,
            targets: {
                mode: 'broadcast',
                scope: 'principal',
                principalRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    principalId: 'bob'
                }
            }
        };
        const webSocketServer = createOpenConnections(['alice-session-1']);

        const recipients = resolveStateSyncRecipients(webSocketServer, forged, {
            readClientSnapshots: () => [],
            readGroupSnapshots: () => [],
            now: () => NOW_EPOCH_MS
        });

        expect(recipients).toBeDefined();
        expect(recipients).toEqual([]);
    });

    it('rejects an unknown payload type on a recognized state-sync route', () => {
        const message = toPrincipalStampedMessage('alice', ['alice-session-1']);
        const forged: ALMessage = {
            ...message,
            payload: { ...message.payload, typeId: 'unknown.topic.v1' }
        };
        const webSocketServer = createOpenConnections(['alice-session-1', 'carol-session']);

        const recipients = resolveStateSyncRecipients(webSocketServer, forged, {
            readClientSnapshots: () => [
                createClientSnapshot('alice', ['alice-session-1']),
                createClientSnapshot('carol', ['carol-session'])
            ],
            readGroupSnapshots: () => [],
            now: () => NOW_EPOCH_MS
        });

        expect(recipients).toEqual([]);
    });

    it('leaves non-state-sync messages to their owning router', () => {
        const message = toPrincipalStampedMessage('alice', ['alice-session-1']);
        const unrelated: ALMessage = {
            ...message,
            route: { ...message.route, topicId: 'app.cursor' },
            payload: { ...message.payload, typeId: 'cursor.position.v1' }
        };

        expect(resolveStateSyncRecipients(createOpenConnections([]), unrelated)).toBeUndefined();
    });
});

function toPrincipalStampedMessage(principalId: string, sessionIds: readonly string[]): ALMessage {
    const [entry] = computeClientStateSyncEntries(
        createComputedClientSnapshotStateSync(createClientSnapshot(principalId, sessionIds)),
        'server-1'
    );
    return decodePersistedALMessage(entry!.resource);
}

function toPrincipalStampedEventMessage(principalId: string): ALMessage {
    const [entry] = computeClientStateSyncEntries(
        createComputedClientEventStateSync(createClientEvent(principalId)),
        'server-1'
    );
    return decodePersistedALMessage(entry!.resource);
}

function createOpenConnections(connectionIds: readonly string[]): JsonWebSocketServer {
    const server = new JsonWebSocketServer();
    for (const connectionId of connectionIds) {
        server.connections.set(
            connectionId,
            new ConnectionContext({ id: connectionId, socket: createOpenTestWebSocket() })
        );
    }
    return server;
}

function createComputedClientSnapshotStateSync(snapshot: ClientSnapshot) {
    return {
        commandId: `command-${snapshot.principal.principalId}`,
        aggregateRef: snapshot.principal,
        acceptedCausalRevision: snapshot.stateRevision,
        audience: {
            kind: 'principal' as const,
            applicationId: snapshot.principal.applicationId,
            workspaceId: snapshot.principal.workspaceId,
            resourceId: snapshot.principal.principalId
        },
        createdAtEpochMs: NOW_EPOCH_MS,
        expireAtEpochMs: NOW_EPOCH_MS + 60_000,
        effects: [
            {
                effectKind: 'principal-state' as const,
                payloadKind: 'snapshot' as const,
                payload: snapshot
            }
        ]
    };
}

function createComputedClientEventStateSync(event: ClientEvent) {
    return {
        commandId: `command-${event.principalId}`,
        aggregateRef: event,
        acceptedCausalRevision: event.snapshotVersion,
        audience: {
            kind: 'principal' as const,
            applicationId: event.applicationId,
            workspaceId: event.workspaceId,
            resourceId: event.principalId
        },
        createdAtEpochMs: NOW_EPOCH_MS,
        expireAtEpochMs: NOW_EPOCH_MS + 60_000,
        effects: [
            {
                effectKind: 'principal-state' as const,
                payloadKind: 'event' as const,
                payload: event
            }
        ]
    };
}

function createClientEvent(principalId: string): ClientEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId,
        eventId: `client-event-${principalId}`,
        eventType: 'session-connected',
        snapshotVersion: 5,
        clientInstanceId: `${principalId}-instance`,
        sessionId: `${principalId}-session`,
        occurredAtEpochMs: NOW_EPOCH_MS,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: `command-${principalId}`,
        payload: {}
    };
}

function createClientSnapshot(principalId: string, sessionIds: readonly string[]): ClientSnapshot {
    const audit = createAuditStamp();
    return {
        stateRevision: 5,
        principal: createClientPrincipal(principalId),
        instances: sessionIds.map((sessionId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            clientInstanceId: `${sessionId}-instance`,
            platform: 'web' as const,
            deviceLabel: null,
            appVersion: null,
            userAgent: null,
            capabilities: [],
            registered: audit,
            updated: audit,
            status: 'active' as const,
            revoked: null
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId,
            clientInstanceId: `${sessionId}-instance`,
            sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: 1,
            presenceState: 'online' as const,
            transport: 'ws' as const,
            connectionId: sessionId,
            authenticatedAtEpochMs: NOW_EPOCH_MS - 1_000,
            connectedAtEpochMs: NOW_EPOCH_MS - 1_000,
            lastHeartbeatAtEpochMs: NOW_EPOCH_MS,
            expiresAtEpochMs: NOW_EPOCH_MS + 60_000,
            status: 'active' as const,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        isOnline: sessionIds.length > 0,
        activeSessionCount: sessionIds.length,
        lastSeenAtEpochMs: sessionIds.length > 0 ? NOW_EPOCH_MS : null
    };
}

function createClientPrincipal(principalId: string): ClientSnapshot['principal'] {
    const audit = createAuditStamp();
    return {
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
        snapshotVersion: 5,
        profileVersion: 5,
        presenceVersion: 1,
        created: audit,
        updated: audit,
        lastSeenAtEpochMs: null
    };
}

function createGroupSnapshot(
    principalIds: readonly string[],
    sessionByPrincipalId: Readonly<Record<string, string>>
): GroupSnapshot {
    const audit = createAuditStamp();
    const ref = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1'
    };
    return {
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        group: createTestGroup({
            ...ref,
            displayName: 'Room 1',
            activeMemberCount: principalIds.length,
            ownerPrincipalId: principalIds[0]!,
            snapshotVersion: 2,
            metadataVersion: 2,
            rosterVersion: 2,
            presenceVersion: 1,
            created: audit,
            updated: audit
        }),
        members: principalIds.map((principalId, index) => ({
            ...ref,
            principalId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: audit,
            updated: audit,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        })),
        activeSessions: principalIds.map((principalId) => ({
            ...ref,
            principalId,
            sessionId: sessionByPrincipalId[principalId]!,
            generationId: `generation-${principalId}`,
            generationVersion: 1,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
            connectedAtEpochMs: NOW_EPOCH_MS - 1_000,
            lastHeartbeatAtEpochMs: NOW_EPOCH_MS,
            expiresAtEpochMs: NOW_EPOCH_MS + 60_000
        })),
        memberCount: principalIds.length,
        onlineMemberCount: principalIds.length
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
