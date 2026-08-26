import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import type { RallarCrdtPrincipalSnapshotRef } from '@shared-server/rallar-system/websocket/targets/ws-server-target-resolution-options.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { RALLAR_CRDT_UPDATE_TYPE_ID } from '@shared/crdt/mod.ts';
import { ConnectionContext, JsonWebSocketServer, newALRoute, newALUnicastMessage } from '@shared/mod.ts';
import { describe, expect, it } from 'vitest';
import { createOpenTestWebSocket } from '../test-support/open-test-websocket.ts';

describe('CRDT principal post-commit routing', () => {
    it('resolves a logical principal target to every active session', () => {
        const { resolver } = principalResolver({
            openConnectionIds: ['session-a', 'session-b'],
            workspaceId: 'workspace-a'
        });

        expect(resolver.resolvePeerRecipients?.('alice', principalMessage('workspace-a'))).toEqual([
            { peerId: 'session-a', connectionId: 'session-a' },
            { peerId: 'session-b', connectionId: 'session-b' }
        ]);
    });

    it('expands a logical principal before interpreting a colliding direct session ID', () => {
        const { resolver } = principalResolver({
            openConnectionIds: ['alice', 'session-a', 'session-b'],
            workspaceId: 'workspace-a'
        });

        expect(resolver.resolvePeerRecipients?.('alice', principalMessage('workspace-a'))).toEqual([
            { peerId: 'session-a', connectionId: 'session-a' },
            { peerId: 'session-b', connectionId: 'session-b' }
        ]);
    });

    it('passes an absent workspace through the exact principal reference', () => {
        const seen: RallarCrdtPrincipalSnapshotRef[] = [];
        const { resolver } = principalResolver({
            openConnectionIds: ['session-a', 'session-b'],
            workspaceId: undefined,
            onRef: (ref) => seen.push(ref)
        });

        expect(resolver.resolvePeerRecipients?.('alice', principalMessage(undefined))).toHaveLength(2);
        expect(seen).toEqual([{
            applicationId: 'app-1',
            principalId: 'alice'
        }]);
    });

    it('fails closed for a cold snapshot and uses only the current live snapshot', () => {
        let current = false;
        const { resolver } = principalResolver({
            openConnectionIds: ['session-a', 'session-b'],
            workspaceId: 'workspace-a',
            isCurrent: () => current
        });
        const message = principalMessage('workspace-a');

        expect(resolver.resolvePeerRecipients?.('alice', message)).toEqual([]);
        current = true;
        expect(resolver.resolvePeerRecipients?.('alice', message)).toEqual([
            { peerId: 'session-a', connectionId: 'session-a' },
            { peerId: 'session-b', connectionId: 'session-b' }
        ]);
    });
});

function principalResolver(
    input: Readonly<{
        openConnectionIds: readonly string[];
        workspaceId: string | undefined;
        onRef?: (ref: RallarCrdtPrincipalSnapshotRef) => void;
        isCurrent?: () => boolean;
    }>
) {
    const now = 10_000;
    const server = new JsonWebSocketServer();
    for (const connectionId of input.openConnectionIds) {
        server.addConnection(new ConnectionContext(connectionId, createOpenTestWebSocket()));
    }
    const resolver = createWsServerTargetResolver(server, {
        findClientSnapshotByRef: (ref) => {
            input.onRef?.(ref);
            if (input.isCurrent && !input.isCurrent()) {
                return undefined;
            }
            return createPrincipalSnapshot(input.workspaceId ?? 'workspace-a', now);
        },
        now: () => now
    });
    return { resolver };
}

function principalMessage(workspaceId: string | undefined) {
    return newALUnicastMessage(
        'server-1',
        newALRoute('rallar.crdt', 'alice', 'message-1'),
        'alice',
        RALLAR_CRDT_UPDATE_TYPE_ID,
        {
            document: {
                applicationId: 'app-1',
                ...(workspaceId === undefined ? {} : { workspaceId }),
                scope: 'principal',
                principalId: 'alice'
            }
        }
    );
}

function createPrincipalSnapshot(workspaceId: string, nowEpochMs: number): ClientSnapshot {
    const audit = {
        atEpochMs: 1,
        actor: { kind: 'service' as const, serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
    const session = (sessionId: string) => ({
        applicationId: 'app-1',
        workspaceId,
        principalId: 'alice',
        clientInstanceId: `${sessionId}-instance`,
        sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: 1,
        presenceState: 'online' as const,
        transport: 'ws' as const,
        connectionId: sessionId,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: nowEpochMs,
        expiresAtEpochMs: nowEpochMs + 60_000,
        status: 'active' as const,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    });
    return {
        stateRevision: 1,
        principal: {
            applicationId: 'app-1',
            workspaceId,
            principalId: 'alice',
            username: 'alice',
            displayName: 'Alice',
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: audit,
            updated: audit,
            lastSeenAtEpochMs: nowEpochMs
        },
        instances: [],
        activeSessions: [session('session-a'), session('session-b')],
        isOnline: true,
        activeSessionCount: 2,
        lastSeenAtEpochMs: nowEpochMs
    };
}
