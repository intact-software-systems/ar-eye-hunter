import { Hono } from 'jsr:@hono/hono@4.11.9';

import type { AuthSession } from '@shared/api/api-config.ts';
import type { AuditStamp, ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { ClientStateWritten } from '@shared-server/rallar-system/services/client-state-service.ts';

import type { GroupStateRouteAuthSession } from '../../src/group-state/group-state-route-contracts.ts';
import * as clientStateRoutes from '../../src/routes/client-state-routes.ts';

export const TEST_SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

export function createClientRouteApp(
  deps: ReturnType<typeof createClientRouteDeps>,
): Hono {
  const app = new Hono();
  installClientStateRouteAuthMiddleware(app, deps.requireApiAuthSession);
  clientStateRoutes.registerClientStateRoutes(app, deps);
  return app;
}

export function installClientStateRouteAuthMiddleware(
  app: Hono,
  requireApiAuthSession: (
    req: { header(name: string): string | undefined },
  ) => Promise<Pick<AuthSession, 'clientId' | 'sessionId'>>,
): void {
  app.use('/api/state/*', async (c, next) => {
    await requireApiAuthSession(c.req);
    await next();
  });
}

export function createClientRouteDeps(
  input: Readonly<{
    session: AuthSession & GroupStateRouteAuthSession;
    clientService: Partial<clientStateRoutes.ClientStateRouteService>;
    hydrateStateSyncSnapshotCaches?: clientStateRoutes.ClientStateRouteDependencies[
      'hydrateStateSyncSnapshotCaches'
    ];
    processClientAppInbox?: clientStateRoutes.ClientStateRouteDependencies[
      'processClientAppInbox'
    ];
    readClientSnapshot?: clientStateRoutes.ClientStateRouteDependencies[
      'readClientSnapshot'
    ];
  }>,
):
  & Required<clientStateRoutes.ClientStateRouteDependencies>
  & Readonly<{
    authCallCount(): number;
  }> {
  let authCalls = 0;
  return {
    clientStateService: {
      listSnapshots: () => Promise.resolve([]),
      readSnapshot: () => Promise.resolve(undefined),
      readPresenceSnapshot: () => Promise.resolve(undefined),
      listEvents: () => Promise.resolve([]),
      listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
      ...input.clientService,
    } as clientStateRoutes.ClientStateRouteService,
    requireApiAuthSession: () => {
      authCalls += 1;
      return Promise.resolve(input.session);
    },
    processClientAppInbox: input.processClientAppInbox ??
      (() => Promise.reject(new Error('Unexpected client mutation route call'))),
    hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
      (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
    readClientSnapshot: input.readClientSnapshot ?? (async (ref) => {
      const snapshot = await input.clientService.readSnapshot?.(ref);
      return snapshot
        ? { status: 'found', source: 'durable', snapshot }
        : { status: 'not-found', source: 'durable' };
    }),
    authCallCount: () => authCalls,
  };
}

export function toClientStateWritten(snapshot: ClientSnapshot): ClientStateWritten {
  return {
    status: 'ok',
    result: Either.ofRight({ snapshot, event: null }),
  };
}
export async function withStrictReadAuth(
  enabled: boolean,
  action: () => Promise<void>,
): Promise<void> {
  const previous = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
  Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', enabled ? 'true' : 'false');
  try {
    await action();
  } finally {
    if (previous === undefined) {
      Deno.env.delete('RALLAR_STATE_STRICT_READ_AUTH');
    } else {
      Deno.env.set('RALLAR_STATE_STRICT_READ_AUTH', previous);
    }
  }
}

export function createAuthSession(
  clientId: string,
): AuthSession & GroupStateRouteAuthSession {
  return {
    clientId,
    accessToken: 'token',
    username: clientId,
    sessionId: `${clientId}-session`,
    issuedAtEpochMs: Date.now() - 1_000,
    expiresAtEpochMs: Date.now() + 60_000,
  };
}

export function createClientSnapshot(principalId: string): ClientSnapshot {
  return {
    stateRevision: 1,
    principal: {
      ...TEST_SCOPE,
      principalId,
      username: principalId,
      displayName: principalId,
      avatarUrl: null,
      authProvider: null,
      externalSubjectId: null,
      status: 'active',
      roles: [],
      metadata: {},
      snapshotVersion: 1,
      profileVersion: 1,
      presenceVersion: 0,
      created: testAuditStamp(1),
      updated: testAuditStamp(1),
      disabled: null,
      deleted: null,
      lastSeenAtEpochMs: null,
    },
    instances: [],
    activeSessions: [],
    isOnline: false,
    activeSessionCount: 0,
    lastSeenAtEpochMs: null,
  };
}

export function createClientEvent(eventId: string): ClientEvent {
  return {
    ...TEST_SCOPE,
    principalId: 'alice',
    eventId,
    eventType: 'principal-updated',
    snapshotVersion: 1,
    occurredAtEpochMs: 1,
    clientInstanceId: null,
    sessionId: null,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
  };
}

function testAuditStamp(atEpochMs: number): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
