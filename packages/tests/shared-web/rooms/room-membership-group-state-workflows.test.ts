import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import * as legacyWorkflows from '@shared-web/browser/api-workflows.ts';
import * as membershipWorkflows from '@shared-web/browser/rooms/room-membership-group-state-workflows.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly rawBody?: string;
  readonly body?: Record<string, unknown>;
}

const workflowPaths = [
  { path: 'legacy', workflows: legacyWorkflows },
  { path: 'owning', workflows: membershipWorkflows },
] as const;

describe.each(workflowPaths)(
  '$path room membership group-state workflow compatibility',
  ({ workflows }) => {
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

      await workflows.createStateGroupInvite(
        'group-1',
        'member-1',
        {
          invitationExpiresAtEpochMs: 2_000,
          reason: 'join us',
          traceId: 'invite-trace',
        },
        'owner-1',
        'owner-session',
      );
      await legacyWorkflows.revokeStateGroupInvite(
        'group-1',
        'member-1',
        {},
        'owner-1',
        'owner-session',
      );

      expect(fetchCalls).toEqual([
        {
          url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/member-1',
          method: 'POST',
          rawBody:
            '{"invitationExpiresAtEpochMs":2000,"reason":"join us",' +
            '"traceId":"invite-trace","actorPrincipalId":"owner-1",' +
            '"actorSessionId":"owner-session",' +
            '"requestId":"group-invite-create:group-1:member-1:invite-request"}',
          body: {
            invitationExpiresAtEpochMs: 2_000,
            reason: 'join us',
            traceId: 'invite-trace',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'group-invite-create:group-1:member-1:invite-request',
          },
        },
        {
          url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/member-1/revoke',
          method: 'POST',
          rawBody:
            '{"actorPrincipalId":"owner-1","actorSessionId":"owner-session",' +
            '"requestId":"group-invite-revoke:group-1:member-1:revoke-request"}',
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

      await workflows.acceptStateGroupInvite(
        'group-1',
        'member-1',
        'member-session',
        'generation-1',
      );

      expect(fetchCalls).toEqual([
        {
          url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/invites/accept',
          method: 'POST',
          rawBody:
            '{"actorPrincipalId":"member-1","actorSessionId":"member-session",' +
            '"requestId":"group-invite-accept:group-1:member-1:accept-request"}',
          body: {
            actorPrincipalId: 'member-1',
            actorSessionId: 'member-session',
            requestId: 'group-invite-accept:group-1:member-1:accept-request',
          },
        },
        {
          url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/member-session',
          method: 'PUT',
          rawBody:
            '{"principalId":"member-1","generationId":"generation-1",' +
            '"actorPrincipalId":"member-1","actorSessionId":"member-session",' +
            '"requestId":"group-presence-connect:group-1:member-session:presence-request"}',
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

      await runMembershipGovernanceWorkflows(workflows);

      expect(fetchCalls).toEqual([
        {
          url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/remove',
          method: 'POST',
          rawBody:
            '{"reason":"remove","traceId":"remove-trace",' +
            '"actorPrincipalId":"owner-1","actorSessionId":"owner-session",' +
            '"requestId":"group-member-remove:group-1:member-1:remove-request"}',
          body: {
            reason: 'remove',
            traceId: 'remove-trace',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'group-member-remove:group-1:member-1:remove-request',
          },
        },
        {
          url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/ban',
          method: 'POST',
          rawBody:
            '{"reason":"ban","traceId":"ban-trace",' +
            '"actorPrincipalId":"owner-1","actorSessionId":"owner-session",' +
            '"requestId":"group-member-ban:group-1:member-1:ban-request"}',
          body: {
            reason: 'ban',
            traceId: 'ban-trace',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'group-member-ban:group-1:member-1:ban-request',
          },
        },
        {
          url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/unban',
          method: 'POST',
          rawBody:
            '{"reason":"unban","traceId":"unban-trace",' +
            '"actorPrincipalId":"owner-1","actorSessionId":"owner-session",' +
            '"requestId":"group-member-unban:group-1:member-1:unban-request"}',
          body: {
            reason: 'unban',
            traceId: 'unban-trace',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'group-member-unban:group-1:member-1:unban-request',
          },
        },
        {
          url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/members/member-1/role',
          method: 'PUT',
          rawBody:
            '{"role":"admin","reason":"promote","traceId":"role-trace",' +
            '"actorPrincipalId":"owner-1","actorSessionId":"owner-session",' +
            '"requestId":"group-member-role:group-1:member-1:role-request"}',
          body: {
            role: 'admin',
            reason: 'promote',
            traceId: 'role-trace',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'group-member-role:group-1:member-1:role-request',
          },
        },
        {
          url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/owner/transfer',
          method: 'POST',
          rawBody:
            '{"newOwnerPrincipalId":"member-1","reason":"handoff",' +
            '"traceId":"owner-trace","actorPrincipalId":"owner-1",' +
            '"actorSessionId":"owner-session",' +
            '"requestId":"group-ownership-transfer:group-1:member-1:owner-request"}',
          body: {
            newOwnerPrincipalId: 'member-1',
            reason: 'handoff',
            traceId: 'owner-trace',
            actorPrincipalId: 'owner-1',
            actorSessionId: 'owner-session',
            requestId: 'group-ownership-transfer:group-1:member-1:owner-request',
          },
        },
      ]);
    });
  },
);

async function runMembershipGovernanceWorkflows(
  workflows: typeof membershipWorkflows,
): Promise<void> {
  await workflows.removeStateGroupMember(
    'group-1',
    'member-1',
    { reason: 'remove', traceId: 'remove-trace' },
    'owner-1',
    'owner-session',
  );
  await workflows.banStateGroupMember(
    'group-1',
    'member-1',
    { reason: 'ban', traceId: 'ban-trace' },
    'owner-1',
    'owner-session',
  );
  await workflows.unbanStateGroupMember(
    'group-1',
    'member-1',
    { reason: 'unban', traceId: 'unban-trace' },
    'owner-1',
    'owner-session',
  );
  await workflows.setStateGroupMemberRole(
    'group-1',
    'member-1',
    { role: 'admin', reason: 'promote', traceId: 'role-trace' },
    'owner-1',
    'owner-session',
  );
  await workflows.transferStateGroupOwnership(
    'group-1',
    { newOwnerPrincipalId: 'member-1', reason: 'handoff', traceId: 'owner-trace' },
    'owner-1',
    'owner-session',
  );
}

function stubUuids(...values: string[]): void {
  const spy = vi.spyOn(crypto, 'randomUUID');
  for (const value of values) {
    spy.mockReturnValueOnce(value as ReturnType<typeof crypto.randomUUID>);
  }
}

function stubSuccessfulFetch(fetchCalls: FetchCall[]): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = init?.body ? String(init.body) : undefined;
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      rawBody,
      body: rawBody ? JSON.parse(rawBody) : undefined,
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
