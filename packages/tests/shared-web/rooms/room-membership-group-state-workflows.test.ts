import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
  acceptStateGroupInvite,
  banStateGroupMember,
  createStateGroupInvite,
  removeStateGroupMember,
  revokeStateGroupInvite,
  setStateGroupMemberRole,
  transferStateGroupOwnership,
  unbanStateGroupMember,
} from '@shared-web/browser/api-workflows.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body?: Record<string, unknown>;
}

describe('room membership group-state workflow compatibility', () => {
  const fetchCalls: FetchCall[] = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    configureApiClient({ apiBaseUrl: '' });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    configureApiClient({ apiBaseUrl: '' });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates and revokes room invitations with exact request literals', async () => {
    stubUuids('invite-request', 'revoke-request');
    stubSuccessfulFetch(fetchCalls);

    await createStateGroupInvite(
      'group-1',
      'member-1',
      { invitationExpiresAtEpochMs: 2_000 },
      'owner-1',
      'owner-session',
    );
    await revokeStateGroupInvite('group-1', 'member-1', {}, 'owner-1', 'owner-session');

    expect(fetchCalls).toEqual([
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/member-1',
        method: 'POST',
        body: {
          invitationExpiresAtEpochMs: 2_000,
          actorPrincipalId: 'owner-1',
          actorSessionId: 'owner-session',
          requestId: 'group-invite-create:group-1:member-1:invite-request',
        },
      },
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/member-1/revoke',
        method: 'POST',
        body: {
          actorPrincipalId: 'owner-1',
          actorSessionId: 'owner-session',
          requestId: 'group-invite-revoke:group-1:member-1:revoke-request',
        },
      },
    ]);
  });

  it('accepts a room invitation before connecting member presence', async () => {
    stubUuids('accept-request', 'presence-request');
    stubSuccessfulFetch(fetchCalls);

    await acceptStateGroupInvite('group-1', 'member-1', 'member-session', 'generation-1');

    expect(fetchCalls).toEqual([
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/accept',
        method: 'POST',
        body: {
          actorPrincipalId: 'member-1',
          actorSessionId: 'member-session',
          requestId: 'group-invite-accept:group-1:member-1:accept-request',
        },
      },
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/member-session',
        method: 'PUT',
        body: {
          principalId: 'member-1',
          generationId: 'generation-1',
          actorPrincipalId: 'member-1',
          actorSessionId: 'member-session',
          requestId: 'group-presence-connect:group-1:member-session:presence-request',
        },
      },
    ]);
  });

  it('runs room membership governance in order with operation-specific requests', async () => {
    stubUuids('remove-request', 'ban-request', 'unban-request', 'role-request', 'owner-request');
    stubSuccessfulFetch(fetchCalls);

    await removeStateGroupMember('group-1', 'member-1', {}, 'owner-1', 'owner-session');
    await banStateGroupMember('group-1', 'member-1', {}, 'owner-1', 'owner-session');
    await unbanStateGroupMember('group-1', 'member-1', {}, 'owner-1', 'owner-session');
    await setStateGroupMemberRole(
      'group-1',
      'member-1',
      { role: 'admin' },
      'owner-1',
      'owner-session',
    );
    await transferStateGroupOwnership(
      'group-1',
      { newOwnerPrincipalId: 'member-1' },
      'owner-1',
      'owner-session',
    );

    expect(fetchCalls).toEqual([
      governanceCall('members/member-1/remove', 'POST', {
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'group-member-remove:group-1:member-1:remove-request',
      }),
      governanceCall('members/member-1/ban', 'POST', {
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'group-member-ban:group-1:member-1:ban-request',
      }),
      governanceCall('members/member-1/unban', 'POST', {
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'group-member-unban:group-1:member-1:unban-request',
      }),
      governanceCall('members/member-1/role', 'PUT', {
        role: 'admin',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'group-member-role:group-1:member-1:role-request',
      }),
      governanceCall('owner/transfer', 'POST', {
        newOwnerPrincipalId: 'member-1',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'group-ownership-transfer:group-1:member-1:owner-request',
      }),
    ]);
  });
});

function governanceCall(suffix: string, method: string, body: Record<string, unknown>): FetchCall {
  return {
    url: `/api/state/apps/rallar-server/workspaces/default/groups/group-1/${suffix}`,
    method,
    body,
  };
}

function stubUuids(...values: string[]): void {
  const spy = vi.spyOn(crypto, 'randomUUID');
  for (const value of values) {
    spy.mockReturnValueOnce(value as ReturnType<typeof crypto.randomUUID>);
  }
}

function stubSuccessfulFetch(fetchCalls: FetchCall[]): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    fetchCalls.push(call);
    return Promise.resolve(jsonResponse(roomSnapshot('group-1')));
  });
}

function roomSnapshot(groupId: string): GroupSnapshot {
  return createGroupSnapshotFixture({
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId,
    sessionIds: [],
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
