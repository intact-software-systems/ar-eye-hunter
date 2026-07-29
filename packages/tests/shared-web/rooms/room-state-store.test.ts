import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { createRallarBrowserFacadeRuntimeContext } from '@shared-web/browser/rallar-runtime-context.ts';
import { createRoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';

import {
  createActiveGroupMemberFixture,
  createActiveGroupPresenceSessionFixture,
  createClientSnapshotFixture,
  createGroupSnapshotFixture,
} from '../authoritative-group-fixtures.ts';

const stateMocks = vi.hoisted(() => ({
  session: {
    clientId: 'principal-1',
    sessionId: 'session-1',
    username: 'principal-1',
    accessToken: 'token-1',
    expiresAtEpochMs: Date.now() + 60_000,
  },
  groups: [] as GroupSnapshot[],
  clients: [] as ClientSnapshot[],
  repositoriesConfigured: false,
}));

vi.mock('@shared/api/auth.ts', () => ({
  clearSession: vi.fn(),
  isLoggedIn: vi.fn(() => true),
  readSession: vi.fn(() => stateMocks.session),
  writeSession: vi.fn(),
}));

vi.mock('@shared/repository/client-state-snapshots-repository.ts', () => ({
  findClientStateSnapshotByPrincipalId: (principalId: string) => {
    requireConfiguredRepositories();
    return stateMocks.clients.find((snapshot) => snapshot.principal.principalId === principalId);
  },
  getAllClientStateSnapshots: () => {
    requireConfiguredRepositories();
    return [...stateMocks.clients];
  },
}));

vi.mock('@shared/repository/group-state-snapshots-repository.ts', () => ({
  findFirstGroupStateSnapshotRefSessionIdIsIn: (sessionId: string) => {
    requireConfiguredRepositories();
    return stateMocks.groups.find((snapshot) =>
      snapshot.activeSessions.some((session) => session.sessionId === sessionId),
    )?.group;
  },
  findGroupStateSnapshotByRef: (roomRef: GroupRef) => {
    requireConfiguredRepositories();
    return stateMocks.groups.find(
      (snapshot) =>
        snapshot.group.applicationId === roomRef.applicationId &&
        snapshot.group.workspaceId === roomRef.workspaceId &&
        snapshot.group.groupId === roomRef.groupId,
    );
  },
  getAllGroupStateSnapshots: () => {
    requireConfiguredRepositories();
    return [...stateMocks.groups];
  },
}));

describe('room state store compatibility', () => {
  void createRoomStateStore;

  beforeEach(() => {
    stateMocks.groups.length = 0;
    stateMocks.clients.length = 0;
    stateMocks.repositoriesConfigured = false;
  });

  it('returns empty room state before cache repositories are configured', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();
    const listener = vi.fn();

    expect(facade.rooms.state().rooms).toEqual([]);
    expect(facade.rooms.state().members).toEqual([]);
    expect(facade.rooms.state()).toEqual({
      rooms: [],
      currentRoomId: undefined,
      currentRoomRef: undefined,
      currentRoom: undefined,
      members: [],
    });

    facade.rooms.onChange(listener);

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ rooms: [], members: [] }));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      rooms: [],
      currentRoomId: undefined,
      currentRoomRef: undefined,
      currentRoom: undefined,
      members: [],
    });
  });

  it('filters room state by application and workspace scope', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();
    const selected = createRoomSnapshot('selected-room', 'Selected Room');
    const otherApplication = createRoomSnapshot('other-app-room', 'Other App', {
      applicationId: 'other-app',
    });
    const otherWorkspace = createRoomSnapshot('other-workspace-room', 'Other Workspace', {
      workspaceId: 'other-workspace',
    });
    stateMocks.repositoriesConfigured = true;
    stateMocks.groups.push(otherApplication, otherWorkspace, selected);

    facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

    expect(facade.rooms.state().rooms.map((room) => room.roomId)).toEqual(['selected-room']);
    expect(facade.rooms.state().currentRoomRef).toEqual({
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'selected-room',
      slug: null,
      displayName: 'Selected Room',
      description: null,
      kind: 'room',
      status: 'active',
      joinMode: 'open',
      maxMembers: null,
      maxSessionsPerMember: null,
      metadata: {},
      activeMemberCount: 1,
      ownerPrincipalId: 'session-1',
      snapshotVersion: 1,
      metadataVersion: 1,
      rosterVersion: 1,
      presenceVersion: 1,
      created: selected.group.created,
      updated: selected.group.updated,
      archived: null,
      deleted: null,
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
    });
  });

  it('orders active room summaries by display name and omits archived rooms', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();
    const current = createRoomSnapshot('z-room', 'Beta Room');
    const first = createRoomSnapshot('a-room', 'Alpha Room', {}, []);
    const archivedBase = createRoomSnapshot('archived-room', 'Archived Room', {}, []);
    const archived: GroupSnapshot = {
      ...archivedBase,
      group: {
        ...archivedBase.group,
        status: 'archived',
        archived: archivedBase.group.updated,
      },
    };
    stateMocks.repositoriesConfigured = true;
    stateMocks.groups.push(current, archived, first);

    facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

    const state = facade.rooms.state();

    expect(
      state.rooms.map(({ roomId, name, isJoined, isCurrent }) => ({
        roomId,
        name,
        isJoined,
        isCurrent,
      })),
    ).toEqual([
      { roomId: 'a-room', name: 'Alpha Room', isJoined: false, isCurrent: false },
      { roomId: 'z-room', name: 'Beta Room', isJoined: true, isCurrent: true },
    ]);
    expect(state.currentRoomId).toBe('z-room');
    expect(state.currentRoomRef).toEqual(current.group);
    expect(state.currentRoom).toEqual(current);
  });

  it('preserves complete summary and current-room state fields', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();
    const current = createRoomSnapshot('z-room', 'Beta Room');
    stateMocks.repositoriesConfigured = true;
    stateMocks.groups.push(current);
    facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

    expect(facade.rooms.state()).toEqual({
      rooms: [
        {
          roomId: 'z-room',
          roomRef: current.group,
          name: 'Beta Room',
          status: 'active',
          kind: 'room',
          joinMode: 'open',
          memberCount: 1,
          onlineMemberCount: 1,
          isJoined: true,
          isCurrent: true,
          snapshot: current,
        },
      ],
      currentRoomId: 'z-room',
      currentRoomRef: current.group,
      currentRoom: current,
      members: [
        {
          principalId: 'session-1',
          username: 'session-1',
          displayName: undefined,
          role: 'owner',
          status: 'active',
          isOwner: true,
          isOnline: true,
          sessionIds: ['session-1'],
          client: undefined,
        },
      ],
    });
  });

  it('projects active members and orders display names before username fallbacks', async () => {
    const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
    const facade = createRallarFacade();
    const current = createMemberRoomSnapshot();
    const aliceClient = createClient('alice', 'Zulu Display');
    const bobClient = createClient('bob', null);
    stateMocks.repositoriesConfigured = true;
    stateMocks.groups.push(current);
    stateMocks.clients.push(bobClient, aliceClient);

    facade.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });

    expect(facade.rooms.state().members).toEqual([
      {
        principalId: 'bob',
        username: 'Alpha Username',
        displayName: undefined,
        role: 'member',
        status: 'active',
        isOwner: false,
        isOnline: false,
        sessionIds: [],
        client: bobClient,
      },
      {
        principalId: 'charlie',
        username: 'charlie',
        displayName: undefined,
        role: 'member',
        status: 'left',
        isOwner: false,
        isOnline: false,
        sessionIds: [],
        client: undefined,
      },
      {
        principalId: 'alice',
        username: 'alice',
        displayName: 'Zulu Display',
        role: 'owner',
        status: 'active',
        isOwner: true,
        isOnline: true,
        sessionIds: ['session-1'],
        client: aliceClient,
      },
    ]);
  });

  it('preserves the selected current room when defaults move to another scope', () => {
    const runtime = createRallarBrowserFacadeRuntimeContext();
    const current = createRoomSnapshot('scope-a-room', 'Scope A Room');
    const visible = createRoomSnapshot(
      'scope-b-room',
      'Scope B Room',
      { applicationId: 'app-2', workspaceId: 'workspace-2' },
      [],
    );
    const groups = [current, visible];
    const store = createRoomStateStore({
      runtime,
      readSession: () => stateMocks.session,
      readCachedGroupSnapshots: () => groups,
      findCachedGroupSnapshotByRef: (roomRef) =>
        groups.find((snapshot) => snapshot.group === roomRef),
      findFirstCachedGroupRefForSession: () => current.group,
      readCachedClientSnapshots: () => [],
      onCacheChange: () => () => undefined,
    });
    runtime.setDefaults({ applicationId: 'app-1', workspaceId: 'workspace-1' });
    runtime.setCurrentRoom(current);
    const before = store.state();

    runtime.setDefaults({ applicationId: 'app-2', workspaceId: 'workspace-2' });
    const after = store.state();

    expect(before.rooms.map((room) => room.roomId)).toEqual(['scope-a-room']);
    expect(before.currentRoom).toBe(current);
    expect(after.rooms.map((room) => room.roomId)).toEqual(['scope-b-room']);
    expect(after.currentRoomRef).toBe(before.currentRoomRef);
    expect(after.currentRoomId).toBe(before.currentRoomId);
    expect(after.currentRoom).toBe(before.currentRoom);
    expect(after.members).toEqual(before.members);
  });
});

function requireConfiguredRepositories(): void {
  if (!stateMocks.repositoriesConfigured) {
    throw new Error('Repository not found: shared.repository.test-snapshots');
  }
}

function createRoomSnapshot(
  groupId: string,
  displayName: string,
  scope: Readonly<{ applicationId?: string; workspaceId?: string }> = {},
  sessionIds: readonly string[] = ['session-1'],
): GroupSnapshot {
  const snapshot = createGroupSnapshotFixture({
    applicationId: scope.applicationId ?? 'app-1',
    workspaceId: scope.workspaceId ?? 'workspace-1',
    groupId,
    sessionIds,
  });
  return { ...snapshot, group: { ...snapshot.group, displayName } };
}

function createMemberRoomSnapshot(): GroupSnapshot {
  const snapshot = createRoomSnapshot('room-1', 'Room One', {}, []);
  const scope = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
  const alice = createActiveGroupMemberFixture({
    ...scope,
    principalId: 'alice',
    role: 'owner',
    actorPrincipalId: 'alice',
  });
  const bob = createActiveGroupMemberFixture({
    ...scope,
    principalId: 'bob',
    role: 'member',
    actorPrincipalId: 'alice',
  });
  const inactive = {
    ...createActiveGroupMemberFixture({
      ...scope,
      principalId: 'charlie',
      role: 'member',
      actorPrincipalId: 'alice',
    }),
    status: 'left' as const,
    left: snapshot.group.updated,
    joined: snapshot.group.created,
  };
  return {
    ...snapshot,
    group: { ...snapshot.group, ownerPrincipalId: 'alice', activeMemberCount: 2 },
    members: [alice, inactive, bob],
    activeSessions: [
      createActiveGroupPresenceSessionFixture({
        ...scope,
        principalId: 'alice',
        sessionId: 'session-1',
      }),
    ],
    memberCount: 2,
    onlineMemberCount: 1,
  };
}

function createClient(principalId: string, displayName: string | null): ClientSnapshot {
  const snapshot = createClientSnapshotFixture({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    principalId,
  });
  return {
    ...snapshot,
    principal: {
      ...snapshot.principal,
      username: principalId === 'bob' ? 'Alpha Username' : principalId,
      displayName,
    },
  };
}
