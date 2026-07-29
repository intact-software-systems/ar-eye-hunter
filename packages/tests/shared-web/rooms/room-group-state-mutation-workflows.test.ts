import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
  archiveStateGroup,
  deleteStateGroup,
  rotateStateGroupJoinCode,
  updateStateGroupDetails,
  updateStateGroupMetadata,
} from '@shared-web/browser/api-workflows.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body?: Record<string, unknown>;
}

describe('room group-state mutation workflow compatibility', () => {
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

  it('reads and merges current metadata before writing the room update', async () => {
    stubUuids('metadata-request');
    const current = roomSnapshot('group-1', {
      keep: true,
      rallarDirector: { old: true },
    });
    stubFetch(fetchCalls, ({ method }) =>
      jsonResponse(
        method === 'GET'
          ? current
          : roomSnapshot('group-1', { keep: true, rallarDirector: { next: true } }),
      ),
    );

    await updateStateGroupMetadata(
      'group-1',
      { rallarDirector: { next: true } },
      'principal-1',
      'session-1',
    );

    expect(fetchCalls).toEqual([
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1',
        method: 'GET',
        body: undefined,
      },
      {
        url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1',
        method: 'PUT',
        body: {
          metadata: { keep: true, rallarDirector: { next: true } },
          actorPrincipalId: 'principal-1',
          actorSessionId: 'session-1',
          requestId: 'group-metadata-update:group-1:session-1:metadata-request',
        },
      },
    ]);
  });

  it('writes exact detail archive and delete mutations through the shared update path', async () => {
    stubUuids('details-request', 'archive-request', 'delete-request');
    stubFetch(fetchCalls, () => jsonResponse(roomSnapshot('group-1')));

    await updateStateGroupDetails(
      'group-1',
      {
        displayName: 'Renamed',
        description: 'Mission room',
        joinMode: 'open',
        maxMembers: 8,
        maxSessionsPerMember: 2,
        metadata: { map: 'fjord' },
      },
      'owner-1',
      'owner-session',
    );
    await archiveStateGroup('group-1', {}, 'owner-1', 'owner-session');
    await deleteStateGroup('group-1', {}, 'owner-1', 'owner-session');

    expect(fetchCalls).toEqual([
      mutationCall({
        displayName: 'Renamed',
        description: 'Mission room',
        joinMode: 'open',
        maxMembers: 8,
        maxSessionsPerMember: 2,
        metadata: { map: 'fjord' },
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'group-update:group-1:owner-session:details-request',
      }),
      mutationCall({
        status: 'archived',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'group-update:group-1:owner-session:archive-request',
      }),
      mutationCall({
        status: 'deleted',
        actorPrincipalId: 'owner-1',
        actorSessionId: 'owner-session',
        requestId: 'group-update:group-1:owner-session:delete-request',
      }),
    ]);
  });

  it('rotates a room join code with an exact scoped request', async () => {
    stubUuids('join-code-request');
    const response = {
      joinCode: 'code-1',
      expiresAtEpochMs: 2_000,
      snapshot: roomSnapshot('group-1'),
    };
    stubFetch(fetchCalls, () => jsonResponse(response));

    await expect(
      rotateStateGroupJoinCode(
        'group-1',
        { joinCode: 'code-1', expiresAtEpochMs: 2_000 },
        'owner-1',
        'owner-session',
        { applicationId: 'app-1', workspaceId: 'workspace-1' },
      ),
    ).resolves.toEqual(response);

    expect(fetchCalls).toEqual([
      {
        url: '/api/state/apps/app-1/workspaces/workspace-1/groups/group-1/join-code/rotate',
        method: 'POST',
        body: {
          joinCode: 'code-1',
          expiresAtEpochMs: 2_000,
          actorPrincipalId: 'owner-1',
          actorSessionId: 'owner-session',
          requestId: 'group-join-code-rotate:group-1:owner-1:join-code-request',
        },
      },
    ]);
  });
});

function mutationCall(body: Record<string, unknown>): FetchCall {
  return {
    url: '/api/state/apps/rallar-server/workspaces/default/groups/group-1',
    method: 'PUT',
    body,
  };
}

function stubUuids(...values: string[]): void {
  const spy = vi.spyOn(crypto, 'randomUUID');
  for (const value of values) {
    spy.mockReturnValueOnce(value as ReturnType<typeof crypto.randomUUID>);
  }
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

function roomSnapshot(groupId: string, metadata: Record<string, unknown> = {}): GroupSnapshot {
  const snapshot = createGroupSnapshotFixture({
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId,
    sessionIds: [],
  });
  return { ...snapshot, group: { ...snapshot.group, metadata } };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
