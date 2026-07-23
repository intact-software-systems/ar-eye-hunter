import { describe, expect, it } from 'vitest';
import { ConnectionContext, JsonWebSocketServer } from '@shared/mod.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';

describe('CRDT principal post-commit routing', () => {
  it('resolves a logical principal target to every active session', () => {
    const now = 10_000;
    const server = new JsonWebSocketServer();
    for (const sessionId of ['session-a', 'session-b']) {
      server.addConnection(
        new ConnectionContext(sessionId, {
          readyState: WebSocket.OPEN,
          addEventListener: () => undefined,
          send: () => undefined,
        } as WebSocket),
      );
    }
    const session = {
      sessionId: 'session-a',
      connectionId: 'session-a',
      serverId: 'server-1',
      status: 'active',
      connectedAtEpochMs: 1,
      lastSeenAtEpochMs: now,
      expiresAtEpochMs: now + 60_000,
      disconnectedAtEpochMs: null,
    };
    const resolver = createWsServerTargetResolver(server, {
      findClientSnapshotByRef: () => ({
        principal: {
          principalId: 'alice',
          username: 'alice',
          createdAtEpochMs: 1,
          updatedAtEpochMs: 1,
          expiresAtEpochMs: now + 60_000,
        },
        scope: { applicationId: 'app-1', workspaceId: 'workspace-a' },
        activeSessions: [session, {
          ...session,
          sessionId: 'session-b',
          connectionId: 'session-b',
        }],
        activeSessionCount: 2,
        latestConnectionAtEpochMs: 1,
        snapshotVersion: 1,
        refreshedAtEpochMs: 1,
      } as never),
      now: () => now,
    });
    const message = {
      payload: {
        typeId: 'rallar.crdt.update.v1',
        resource: JSON.stringify({
          document: {
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            scope: 'principal',
            principalId: 'alice',
          },
        }),
      },
    } as never;

    expect(resolver.resolvePeerRecipients?.('alice', message)).toEqual([
      { peerId: 'session-a', connectionId: 'session-a' },
      { peerId: 'session-b', connectionId: 'session-b' },
    ]);
  });
});
