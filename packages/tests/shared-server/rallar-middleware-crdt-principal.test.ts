import { createWsServerTargetResolver } from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/mod.ts';
import { describe, expect, it } from 'vitest';

describe('CRDT principal post-commit routing', () => {
    it('resolves a logical principal target to every active session', () => {
        const now = 10_000;
        const server = new JsonWebSocketServer();
        for (const sessionId of ['session-a', 'session-b']) {
            server.addConnection(new ConnectionContext(sessionId, openTestSocket()));
        }
        const session = {
            sessionId: 'session-a',
            connectionId: 'session-a',
            serverId: 'server-1',
            status: 'active',
            connectedAtEpochMs: 1,
            lastSeenAtEpochMs: now,
            expiresAtEpochMs: now + 60_000,
            disconnectedAtEpochMs: null
        };
        const resolver = createWsServerTargetResolver(server, {
            findClientSnapshotByRef: () => ({
                principal: {
                    principalId: 'alice',
                    username: 'alice',
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 1,
                    expiresAtEpochMs: now + 60_000
                },
                scope: { applicationId: 'app-1', workspaceId: 'workspace-a' },
                activeSessions: [session, {
                    ...session,
                    sessionId: 'session-b',
                    connectionId: 'session-b'
                }],
                activeSessionCount: 2,
                latestConnectionAtEpochMs: 1,
                snapshotVersion: 1,
                refreshedAtEpochMs: 1
            } as never),
            now: () => now
        });
        const message = {
            payload: {
                typeId: 'rallar.crdt.update.v1',
                resource: JSON.stringify({
                    document: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-a',
                        scope: 'principal',
                        principalId: 'alice'
                    }
                })
            }
        } as never;

        expect(resolver.resolvePeerRecipients?.('alice', message)).toEqual([
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
        const seen: unknown[] = [];
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
        onRef?: (ref: unknown) => void;
        isCurrent?: () => boolean;
    }>
) {
    const now = 10_000;
    const server = new JsonWebSocketServer();
    for (const connectionId of input.openConnectionIds) {
        server.addConnection(new ConnectionContext(connectionId, openTestSocket()));
    }
    const session = {
        sessionId: 'session-a',
        connectionId: 'session-a',
        serverId: 'server-1',
        status: 'active',
        connectedAtEpochMs: 1,
        lastSeenAtEpochMs: now,
        expiresAtEpochMs: now + 60_000,
        disconnectedAtEpochMs: null
    };
    const resolver = createWsServerTargetResolver(server, {
        findClientSnapshotByRef: (ref) => {
            input.onRef?.(ref);
            if (input.isCurrent && !input.isCurrent()) {
                return undefined;
            }
            return {
                principal: {
                    principalId: 'alice',
                    username: 'alice',
                    createdAtEpochMs: 1,
                    updatedAtEpochMs: 1,
                    expiresAtEpochMs: now + 60_000
                },
                scope: {
                    applicationId: 'app-1',
                    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId })
                },
                activeSessions: [session, {
                    ...session,
                    sessionId: 'session-b',
                    connectionId: 'session-b'
                }],
                activeSessionCount: 2,
                latestConnectionAtEpochMs: 1,
                snapshotVersion: 1,
                refreshedAtEpochMs: 1
            } as never;
        },
        now: () => now
    });
    return { resolver };
}

function openTestSocket(): WebSocket {
    const socket: Pick<WebSocket, 'readyState' | 'addEventListener' | 'send'> = {
        readyState: WebSocket.OPEN,
        addEventListener: () => undefined,
        send: () => undefined
    };

    return socket as WebSocket;
}

function principalMessage(workspaceId: string | undefined) {
    return {
        payload: {
            typeId: 'rallar.crdt.update.v1',
            resource: JSON.stringify({
                document: {
                    applicationId: 'app-1',
                    ...(workspaceId === undefined ? {} : { workspaceId }),
                    scope: 'principal',
                    principalId: 'alice'
                }
            })
        }
    } as never;
}
