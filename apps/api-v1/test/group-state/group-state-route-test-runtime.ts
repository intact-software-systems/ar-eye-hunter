import { Hono } from 'jsr:@hono/hono@4.11.9';
import type { AuthSession } from '@shared/api/api-config.ts';
import type {
  AuditStamp,
  GroupEvent,
  GroupMember,
  GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { AppInboxEnqueueInput } from '@shared-server/rallar-system/services/AppInboxService.ts';
import type { GroupStateWritten } from '@shared-server/rallar-system/services/group-state-service.ts';

import * as groupStateRoutes from '../../src/routes/group-state-routes.ts';

export const TEST_GROUP_SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

export interface GroupStateRouteTestRuntimeInput {
  readonly session?: AuthSession & groupStateRoutes.GroupStateRouteAuthSession;
  readonly groupService?: Partial<groupStateRoutes.GroupStateRouteService>;
  readonly requireApiAuthSession?: groupStateRoutes.GroupStateRouteDependencies[
    'requireApiAuthSession'
  ];
  readonly processGroupAppInbox?: groupStateRoutes.GroupStateRouteDependencies[
    'processGroupAppInbox'
  ];
  readonly hydrateStateSyncSnapshotCaches?: groupStateRoutes.GroupStateRouteDependencies[
    'hydrateStateSyncSnapshotCaches'
  ];
  readonly installStateAuthentication?: boolean;
}

export interface GroupStateRouteTestRuntime {
  readonly app: Hono;
  readonly session: AuthSession & groupStateRoutes.GroupStateRouteAuthSession;
}

export function createGroupStateRouteTestRuntime(
  input: GroupStateRouteTestRuntimeInput = {},
): GroupStateRouteTestRuntime {
  const session = input.session ?? createGroupStateRouteAuthSession('alice');
  const requireApiAuthSession = input.requireApiAuthSession ?? (() => Promise.resolve(session));
  const routeDependencies: groupStateRoutes.GroupStateRouteDependencies = {
    getGroupStateService: () => createGroupStateRouteService(input.groupService),
    requireApiAuthSession,
    processGroupAppInbox: input.processGroupAppInbox ?? defaultProcessGroupAppInbox,
    hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
      (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
  };
  const app = new Hono();

  if (input.installStateAuthentication ?? true) {
    app.use('/api/state/*', async (context, next) => {
      await requireApiAuthSession(context.req);
      await next();
    });
  }

  groupStateRoutes.init(app, routeDependencies);
  return { app, session };
}

export function createGroupStateRouteAuthSession(
  clientId: string,
): AuthSession & groupStateRoutes.GroupStateRouteAuthSession {
  return {
    clientId,
    accessToken: 'test-token',
    username: clientId,
    sessionId: `${clientId}-session`,
    issuedAtEpochMs: 1,
    expiresAtEpochMs: 60_000,
  };
}

export function createGroupStateRouteSnapshot(
  groupId: string,
  activePrincipalIds: readonly string[] = ['alice'],
): GroupSnapshot {
  return {
    stateRevision: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    group: {
      ...TEST_GROUP_SCOPE,
      groupId,
      slug: null,
      displayName: groupId,
      description: null,
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      maxMembers: null,
      maxSessionsPerMember: null,
      metadata: {},
      activeMemberCount: activePrincipalIds.length,
      ownerPrincipalId: activePrincipalIds[0] ?? 'alice',
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 0,
      created: testAuditStamp(1),
      updated: testAuditStamp(1),
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
      archived: null,
      deleted: null,
    },
    members: activePrincipalIds.map((principalId) =>
      createGroupStateRouteMember(groupId, principalId)
    ),
    activeSessions: [],
    memberCount: activePrincipalIds.length,
    onlineMemberCount: 0,
  };
}

export function createGroupStateRouteEvent(eventId: string): GroupEvent {
  return {
    ...TEST_GROUP_SCOPE,
    groupId: 'room-1',
    eventId,
    eventType: 'group-updated',
    snapshotVersion: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    occurredAtEpochMs: 1,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
    payload: {},
  };
}

export function toGroupStateWritten(snapshot: GroupSnapshot): GroupStateWritten {
  return {
    status: 'ok',
    result: Either.ofRight({ snapshot, event: null }),
  };
}

function createGroupStateRouteService(
  groupService: Partial<groupStateRoutes.GroupStateRouteService> | undefined,
): groupStateRoutes.GroupStateRouteService {
  const readSnapshot = groupService?.readSnapshot ?? (() => Promise.resolve(undefined));
  return {
    listSnapshots: () => Promise.resolve([]),
    readSnapshot,
    readCurrentSnapshot: groupService?.readCurrentSnapshot ?? readSnapshot,
    listEvents: () => Promise.resolve([]),
    listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
    ...groupService,
  } as groupStateRoutes.GroupStateRouteService;
}

const defaultProcessGroupAppInbox: groupStateRoutes.ProcessGroupAppInbox = <V, R>(
  _authority: groupStateRoutes.GroupStateRouteAuthSession,
  _enqueue: AppInboxEnqueueInput<V>,
): Promise<R> => Promise.resolve(toGroupStateWritten(createGroupStateRouteSnapshot('room-1')) as R);

function createGroupStateRouteMember(groupId: string, principalId: string): GroupMember {
  return {
    ...TEST_GROUP_SCOPE,
    groupId,
    principalId,
    role: principalId === 'alice' ? 'owner' : 'member',
    status: 'active',
    joined: testAuditStamp(1),
    updated: testAuditStamp(1),
    left: null,
    removed: null,
    banned: null,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
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
