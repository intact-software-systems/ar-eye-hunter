import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { UpsertGroupMemberRequest } from '@shared/api/state-types.ts';
import {
  canReadGroupSnapshot,
  canUpdateGroupSnapshot,
  GroupPolicyDeniedError,
} from '@shared-server/rallar-system/group-policy.ts';

import type {
  GroupStateRouteAuthSession,
  GroupStateRouteDependencies,
  GroupStateRouteRequest,
} from './group-state-route-contracts.ts';

export interface GroupStateRouteAuthorization {
  readStrictAuthSession(
    request: GroupStateRouteRequest,
  ): Promise<GroupStateRouteAuthSession | undefined>;
  assertCanReadGroupRef(
    request: GroupStateRouteRequest,
    ref: GroupRef,
  ): Promise<void>;
  assertCanReadGroupState(
    request: GroupStateRouteRequest,
    snapshot: GroupSnapshot,
  ): Promise<void>;
  assertAuthenticatedCanReadGroupState(
    session: GroupStateRouteAuthSession | undefined,
    snapshot: GroupSnapshot,
  ): void;
  assertCanUpdateGroup(principalId: string, ref: GroupRef): Promise<void>;
  assertSelfPrincipal(clientId: string, principalId: string): void;
  assertSelfSession(
    session: GroupStateRouteAuthSession,
    sessionId: string,
  ): void;
  assertSelfServiceMemberStatus(
    status: UpsertGroupMemberRequest['status'],
  ): void;
}

export function isGroupStateRouteSnapshotReadable(
  snapshot: GroupSnapshot,
  principalId: string,
): boolean {
  return canReadGroupSnapshot({
    snapshot,
    actor: { principalId },
  }).allowed;
}

export function createGroupStateRouteAuthorization(
  dependencies: GroupStateRouteDependencies,
): GroupStateRouteAuthorization {
  return {
    readStrictAuthSession: (request) => readStrictAuthSession(request, dependencies),
    assertCanReadGroupRef: (request, ref) => assertCanReadGroupRef(request, ref, dependencies),
    assertCanReadGroupState: (request, snapshot) =>
      assertCanReadGroupState(request, snapshot, dependencies),
    assertAuthenticatedCanReadGroupState: (session, snapshot) => {
      if (session) assertCanReadGroupSnapshot(session.clientId, snapshot);
    },
    assertCanUpdateGroup: (principalId, ref) =>
      assertCanUpdateGroup(principalId, ref, dependencies),
    assertSelfPrincipal,
    assertSelfSession,
    assertSelfServiceMemberStatus,
  };
}

async function assertCanReadGroupRef(
  request: GroupStateRouteRequest,
  ref: GroupRef,
  dependencies: GroupStateRouteDependencies,
): Promise<void> {
  const authSession = await readStrictAuthSession(request, dependencies);
  if (!authSession) {
    return;
  }

  const snapshot = await dependencies.groupStateService.readCurrentSnapshot(ref);
  if (!snapshot) {
    throw new Error(`Group not found: ${ref.groupId}`);
  }

  assertCanReadGroupSnapshot(authSession.clientId, snapshot);
}

async function assertCanReadGroupState(
  request: GroupStateRouteRequest,
  snapshot: GroupSnapshot,
  dependencies: GroupStateRouteDependencies,
): Promise<void> {
  const authSession = await readStrictAuthSession(request, dependencies);
  if (!authSession) {
    return;
  }

  assertCanReadGroupSnapshot(authSession.clientId, snapshot);
}

function assertCanReadGroupSnapshot(principalId: string, snapshot: GroupSnapshot): void {
  const result = canReadGroupSnapshot({
    snapshot,
    actor: { principalId },
  });
  if (!result.allowed) {
    throw new GroupPolicyDeniedError(result);
  }
}

async function assertCanUpdateGroup(
  principalId: string,
  ref: GroupRef,
  dependencies: GroupStateRouteDependencies,
): Promise<void> {
  const snapshot = await dependencies.groupStateService.readSnapshot(ref);
  if (!snapshot) {
    throw new Error(`Group not found: ${ref.groupId}`);
  }

  const result = canUpdateGroupSnapshot({
    snapshot,
    actor: { principalId },
  });
  if (result.allowed) {
    return;
  }

  if (result.code === 'member-not-active') {
    throw new Error('Forbidden: only active group owners/admins can update groups');
  }

  if (result.code === 'forbidden-role') {
    throw new Error('Forbidden: only group owners/admins can update groups');
  }

  throw new GroupPolicyDeniedError(result);
}

function assertSelfPrincipal(clientId: string, principalId: string): void {
  if (clientId !== principalId) {
    throw new Error('Forbidden: principal id does not match authenticated client');
  }
}

function assertSelfSession(
  session: GroupStateRouteAuthSession,
  sessionId: string,
): void {
  if (session.sessionId !== sessionId) {
    throw new Error('Forbidden: session id does not match authenticated session');
  }
}

function assertSelfServiceMemberStatus(
  status: UpsertGroupMemberRequest['status'],
): void {
  if (status !== 'active' && status !== 'left') {
    throw new Error(
      'Forbidden: self-service membership changes only support active/left',
    );
  }
}

async function readStrictAuthSession(
  request: GroupStateRouteRequest,
  dependencies: GroupStateRouteDependencies,
): Promise<GroupStateRouteAuthSession | undefined> {
  return isStrictReadAuthEnabled() ? await dependencies.requireApiAuthSession(request) : undefined;
}

function isStrictReadAuthEnabled(): boolean {
  const value = Deno.env.get('RALLAR_STATE_STRICT_READ_AUTH');
  if (value === undefined || value.trim() === '') {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
