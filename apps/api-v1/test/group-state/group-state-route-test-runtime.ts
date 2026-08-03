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

import { registerGroupStateRoutes } from '../../src/group-state/register-group-state-routes.ts';
import type {
  GroupStateRouteAuthSession,
  GroupStateRouteDependencies,
  GroupStateRouteService,
  ProcessGroupAppInbox,
  ResolvedGroupStateRouteDependencies,
} from '../../src/group-state/group-state-route-contracts.ts';

export const TEST_GROUP_SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

export interface GroupStateRouteTestRuntimeInput {
  readonly session?: AuthSession & GroupStateRouteAuthSession;
  readonly groupService?: Partial<GroupStateRouteService>;
  readonly requireApiAuthSession?: GroupStateRouteDependencies[
    'requireApiAuthSession'
  ];
  readonly processGroupAppInbox?: GroupStateRouteDependencies[
    'processGroupAppInbox'
  ];
  readonly hydrateStateSyncSnapshotCaches?: GroupStateRouteDependencies[
    'hydrateStateSyncSnapshotCaches'
  ];
  readonly installStateAuthentication?: boolean;
}

export interface GroupStateRouteTestRuntime {
  readonly app: Hono;
  readonly session: AuthSession & GroupStateRouteAuthSession;
}

export interface GroupStateRoutePostRequestWithHeaders {
  readonly body: Record<string, unknown>;
  readonly headers: Readonly<Record<string, string>>;
}

export function createGroupStateRouteTestRuntime(
  input: GroupStateRouteTestRuntimeInput = {},
): GroupStateRouteTestRuntime {
  const session = input.session ?? createGroupStateRouteAuthSession('alice');
  const routeDependencies = createGroupStateRouteTestDependencies({ ...input, session });
  const app = new Hono();

  if (input.installStateAuthentication ?? true) {
    app.use('/api/state/*', async (context, next) => {
      await routeDependencies.requireApiAuthSession(context.req);
      await next();
    });
  }

  registerGroupStateRoutes(app, routeDependencies);
  return { app, session };
}

export function createPredecessorGroupStateRouteTestRuntime(
  input: GroupStateRouteTestRuntimeInput = {},
): GroupStateRouteTestRuntime {
  const session = input.session ?? createPredecessorGroupStateRouteAuthSession('alice');
  const processGroupAppInbox = input.processGroupAppInbox ?? rejectUnexpectedGroupMutation;
  return createGroupStateRouteTestRuntime({ ...input, session, processGroupAppInbox });
}

export function createGroupStateRouteTestDependencies(
  input: GroupStateRouteTestRuntimeInput = {},
): ResolvedGroupStateRouteDependencies {
  const session = input.session ?? createGroupStateRouteAuthSession('alice');
  const requireApiAuthSession = input.requireApiAuthSession ?? (() => Promise.resolve(session));
  return {
    getGroupStateService: () => createGroupStateRouteService(input.groupService),
    requireApiAuthSession,
    processGroupAppInbox: input.processGroupAppInbox ?? defaultProcessGroupAppInbox,
    hydrateStateSyncSnapshotCaches: input.hydrateStateSyncSnapshotCaches ??
      (() => Promise.resolve({ clientSnapshotCount: 0, groupSnapshotCount: 0 })),
  };
}

export function createPredecessorGroupStateRouteTestDependencies(
  input: GroupStateRouteTestRuntimeInput = {},
): ResolvedGroupStateRouteDependencies {
  const session = input.session ?? createPredecessorGroupStateRouteAuthSession('alice');
  const processGroupAppInbox = input.processGroupAppInbox ?? rejectUnexpectedGroupMutation;
  return createGroupStateRouteTestDependencies({ ...input, session, processGroupAppInbox });
}

export function createGroupStateRouteAuthSession(
  clientId: string,
): AuthSession & GroupStateRouteAuthSession {
  return {
    clientId,
    accessToken: 'test-token',
    username: clientId,
    sessionId: `${clientId}-session`,
    issuedAtEpochMs: 1,
    expiresAtEpochMs: 60_000,
  };
}

export function createPredecessorGroupStateRouteAuthSession(
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

export function createPredecessorGroupStateRouteSnapshot(
  groupId: string,
  activePrincipalIds: readonly string[] = ['alice'],
): GroupSnapshot {
  const snapshot = createGroupStateRouteSnapshot(groupId, activePrincipalIds);
  const ownerPrincipalId = activePrincipalIds[0] ?? 'alice';
  return {
    ...snapshot,
    members: snapshot.members.map((member) => ({
      ...member,
      role: member.principalId === ownerPrincipalId ? 'owner' : 'member',
    })),
  };
}

export function createGroupStateRouteSnapshotWithMember(
  groupId: string,
  principalId: string,
  status: GroupMember['status'],
): GroupSnapshot {
  const snapshot = createGroupStateRouteSnapshot(groupId, status === 'active' ? [principalId] : []);
  return {
    ...snapshot,
    members: [createGroupStateRouteMemberWithStatus(groupId, principalId, status)],
    memberCount: status === 'active' ? 1 : 0,
    onlineMemberCount: 0,
  };
}

export function createDeletedGroupStateRouteSnapshot(
  groupId: string,
  principalId: string,
): GroupSnapshot {
  const snapshot = createGroupStateRouteSnapshot(groupId, [principalId]);
  return {
    ...snapshot,
    group: {
      ...snapshot.group,
      status: 'deleted',
      archived: null,
      deleted: testAuditStamp(2),
    },
  };
}

export async function withStrictGroupStateRouteReadAuth(
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

export function captureGroupStateRouteWrite(
  enqueued: unknown[],
  snapshot: GroupSnapshot,
): ProcessGroupAppInbox {
  return <V, R>(
    _authority: GroupStateRouteAuthSession,
    entry: AppInboxEnqueueInput<V>,
  ): Promise<R> => {
    enqueued.push(entry);
    return Promise.resolve(toGroupStateWritten(snapshot) as R);
  };
}

export async function postGroupStateMutation(
  app: Hono,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function putGroupStateMutation(
  app: Hono,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await app.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function postGroupStateMutationWithHeaders(
  app: Hono,
  path: string,
  request: GroupStateRoutePostRequestWithHeaders,
): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...request.headers },
    body: JSON.stringify(request.body),
  });
}

function createGroupStateRouteService(
  groupService: Partial<GroupStateRouteService> | undefined,
): GroupStateRouteService {
  const readSnapshot = groupService?.readSnapshot ?? (() => Promise.resolve(undefined));
  return {
    listSnapshots: () => Promise.resolve([]),
    readSnapshot,
    readCurrentSnapshot: groupService?.readCurrentSnapshot ?? readSnapshot,
    listEvents: () => Promise.resolve([]),
    listEventPage: () => Promise.resolve({ events: [], hasMore: false }),
    ...groupService,
  } as GroupStateRouteService;
}

const defaultProcessGroupAppInbox: ProcessGroupAppInbox = <V, R>(
  _authority: GroupStateRouteAuthSession,
  _enqueue: AppInboxEnqueueInput<V>,
): Promise<R> => Promise.resolve(toGroupStateWritten(createGroupStateRouteSnapshot('room-1')) as R);

const rejectUnexpectedGroupMutation: ProcessGroupAppInbox = () =>
  Promise.reject(new Error('Unexpected group mutation'));

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

function createGroupStateRouteMemberWithStatus(
  groupId: string,
  principalId: string,
  status: GroupMember['status'],
): GroupMember {
  const auditStamp = testAuditStamp(1);
  const joined = status === 'invited' ? null : auditStamp;
  return {
    ...TEST_GROUP_SCOPE,
    groupId,
    principalId,
    role: 'member',
    status,
    joined,
    updated: auditStamp,
    left: status === 'left' ? auditStamp : null,
    removed: status === 'removed' ? auditStamp : null,
    banned: status === 'banned' ? auditStamp : null,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
  } as GroupMember;
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
