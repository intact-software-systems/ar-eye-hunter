import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
  createAndJoinStateGroup,
  joinStateGroup,
  leaveStateGroup,
} from '@shared-web/browser/api-workflows.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body?: Record<string, unknown>;
}

describe('room group-state workflow compatibility', () => {
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

  it('creates a generated room before connecting its presence', async () => {
    stubUuids('generated-room', 'create-request', 'presence-request');
    stubSuccessfulGroupFetch(fetchCalls);

    await createAndJoinStateGroup('My Room', 'principal-1', 'session-1', 'generation-1');

    expect(fetchCalls).toEqual([
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups',
        method: 'POST',
        body: {
          groupId: 'generated-room',
          slug: 'my-room',
          displayName: 'My Room',
          kind: 'room',
          joinMode: 'invite-only',
          createdByPrincipalId: 'principal-1',
          actorPrincipalId: 'principal-1',
          actorSessionId: 'session-1',
          requestId: 'group-create:generated-room:create-request',
          metadata: {},
        },
      },
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/generated-room/sessions/session-1',
        method: 'PUT',
        body: {
          principalId: 'principal-1',
          generationId: 'generation-1',
          actorPrincipalId: 'principal-1',
          actorSessionId: 'session-1',
          requestId: 'group-presence-connect:generated-room:session-1:presence-request',
        },
      },
    ]);
  });

  it('preserves explicit room identity and every safe create field', async () => {
    stubUuids('create-request', 'presence-request');
    stubSuccessfulGroupFetch(fetchCalls);

    await createAndJoinStateGroup(
      'Rallar',
      'principal-1',
      'session-1',
      'generation-1',
      { applicationId: 'app-1', workspaceId: 'workspace-1' },
      {},
      'rallar',
      {
        description: 'Mission room',
        joinMode: 'open',
        maxMembers: 8,
        maxSessionsPerMember: 2,
        metadata: { map: 'fjord' },
        expiresAtEpochMs: 2_000,
        purgeAfterEpochMs: 3_000,
      },
    );

    expect(fetchCalls[0]).toEqual({
      url: '/api/state/apps/app-1/workspaces/workspace-1/groups',
      method: 'POST',
      body: {
        groupId: 'rallar',
        slug: 'rallar',
        displayName: 'Rallar',
        kind: 'room',
        description: 'Mission room',
        joinMode: 'open',
        maxMembers: 8,
        maxSessionsPerMember: 2,
        createdByPrincipalId: 'principal-1',
        actorPrincipalId: 'principal-1',
        actorSessionId: 'session-1',
        requestId: 'group-create:rallar:create-request',
        metadata: { map: 'fjord' },
        expiresAtEpochMs: 2_000,
        purgeAfterEpochMs: 3_000,
      },
    });
  });

  it('keeps create and presence request IDs stable across retries', async () => {
    stubUuids('retry-room', 'create-request', 'presence-request', 'unused-request');
    stubTransientGroupFetch(fetchCalls, '/groups', '/sessions/session-1');

    await createAndJoinStateGroup(
      'Retry Room',
      'principal-1',
      'session-1',
      'generation-1',
      undefined,
      { command: { maxAttempts: 2 } },
    );

    expect(readRequestIds(fetchCalls, 'POST', '/groups')).toEqual([
      'group-create:retry-room:create-request',
      'group-create:retry-room:create-request',
    ]);
    expect(readRequestIds(fetchCalls, 'PUT', '/sessions/session-1')).toEqual([
      'group-presence-connect:retry-room:session-1:presence-request',
      'group-presence-connect:retry-room:session-1:presence-request',
    ]);
  });

  it('joins membership before presence with literal intent and identity fields', async () => {
    stubUuids('join-request', 'presence-request');
    stubSuccessfulGroupFetch(fetchCalls);

    await joinStateGroup(
      'group-1',
      'principal-1',
      'session-1',
      'generation-1',
      undefined,
      {},
      { inviteToken: 'invite-1', joinCode: 'code-1' },
    );

    expect(fetchCalls).toEqual([
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/join',
        method: 'POST',
        body: {
          inviteToken: 'invite-1',
          joinCode: 'code-1',
          actorPrincipalId: 'principal-1',
          actorSessionId: 'session-1',
          requestId: 'group-join:group-1:principal-1:join-request',
        },
      },
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/session-1',
        method: 'PUT',
        body: {
          principalId: 'principal-1',
          generationId: 'generation-1',
          actorPrincipalId: 'principal-1',
          actorSessionId: 'session-1',
          requestId: 'group-presence-connect:group-1:session-1:presence-request',
        },
      },
    ]);
  });

  it('keeps join and presence request IDs stable across retries', async () => {
    stubUuids('join-request', 'presence-request', 'unused-request');
    stubTransientGroupFetch(fetchCalls, '/join', '/sessions/session-1');

    await joinStateGroup('group-1', 'principal-1', 'session-1', 'generation-1', undefined, {
      command: { maxAttempts: 2 },
    });

    expect(readRequestIds(fetchCalls, 'POST', '/join')).toEqual([
      'group-join:group-1:principal-1:join-request',
      'group-join:group-1:principal-1:join-request',
    ]);
    expect(readRequestIds(fetchCalls, 'PUT', '/sessions/session-1')).toEqual([
      'group-presence-connect:group-1:session-1:presence-request',
      'group-presence-connect:group-1:session-1:presence-request',
    ]);
  });

  it('continues leave after missing presence with exact disconnect and member requests', async () => {
    stubUuids('disconnect-request', 'member-request');
    stubLeaveFetch(fetchCalls, true);

    await leaveStateGroup('group-1', 'principal-1', 'session-1', 'generation-1');

    expect(fetchCalls).toEqual([
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/sessions/session-1/disconnect',
        method: 'POST',
        body: {
          generationId: 'generation-1',
          principalId: 'principal-1',
          actorPrincipalId: 'principal-1',
          actorSessionId: 'session-1',
          reason: 'left-group',
          requestId: 'group-presence-disconnect:group-1:session-1:disconnect-request',
        },
      },
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1/members/principal-1',
        method: 'PUT',
        body: {
          status: 'left',
          actorPrincipalId: 'principal-1',
          actorSessionId: 'session-1',
          reason: 'left-group',
          requestId: 'group-member-upsert:group-1:principal-1:member-request',
        },
      },
    ]);
  });

  it('keeps disconnect and member request IDs stable across leave retries', async () => {
    stubUuids('disconnect-request', 'member-request', 'unused-request');
    stubTransientGroupFetch(fetchCalls, '/disconnect', '/members/principal-1');

    await leaveStateGroup('group-1', 'principal-1', 'session-1', 'generation-1', undefined, {
      command: { maxAttempts: 2 },
    });

    expect(readRequestIds(fetchCalls, 'POST', '/disconnect')).toEqual([
      'group-presence-disconnect:group-1:session-1:disconnect-request',
      'group-presence-disconnect:group-1:session-1:disconnect-request',
    ]);
    expect(readRequestIds(fetchCalls, 'PUT', '/members/principal-1')).toEqual([
      'group-member-upsert:group-1:principal-1:member-request',
      'group-member-upsert:group-1:principal-1:member-request',
    ]);
  });
});

function stubUuids(...values: string[]): void {
  const spy = vi.spyOn(crypto, 'randomUUID');
  for (const value of values) {
    spy.mockReturnValueOnce(value as ReturnType<typeof crypto.randomUUID>);
  }
}

function stubSuccessfulGroupFetch(fetchCalls: FetchCall[]): void {
  stubFetch(fetchCalls, ({ url }) => jsonResponse(groupSnapshot(readGroupId(url))));
}

function stubTransientGroupFetch(
  fetchCalls: FetchCall[],
  firstSuffix: string,
  secondSuffix: string,
): void {
  const attempts = new Map<string, number>();
  stubFetch(fetchCalls, ({ url }) => {
    const key = url.endsWith(firstSuffix) ? firstSuffix : secondSuffix;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    return attempt === 1
      ? new Response('transient', { status: 503 })
      : jsonResponse(groupSnapshot(readGroupId(url)));
  });
}

function stubLeaveFetch(fetchCalls: FetchCall[], disconnectMissing: boolean): void {
  stubFetch(fetchCalls, ({ url }) =>
    disconnectMissing && url.endsWith('/disconnect')
      ? new Response('missing', { status: 404 })
      : jsonResponse(groupSnapshot(readGroupId(url))),
  );
}

function stubFetch(fetchCalls: FetchCall[], handler: (call: FetchCall) => Response): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    fetchCalls.push(call);
    return Promise.resolve(handler(call));
  });
}

function readRequestIds(
  fetchCalls: readonly FetchCall[],
  method: string,
  suffix: string,
): unknown[] {
  return fetchCalls
    .filter((call) => call.method === method && call.url.endsWith(suffix))
    .map((call) => call.body?.requestId);
}

function readGroupId(url: string): string {
  return url.match(/\/groups\/([^/]+)/)?.[1] ?? 'generated-room';
}

function groupSnapshot(groupId: string): GroupSnapshot {
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
