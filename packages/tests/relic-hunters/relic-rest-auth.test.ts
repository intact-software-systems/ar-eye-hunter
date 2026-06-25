import { describe, expect, it } from 'vitest';
import type { Group, GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/mod.ts';
import {
  authorizeRelicCommand,
  authorizeRelicReset,
  authorizeRelicSnapshotRead,
  readRelicRestAuthMode,
} from '../../../apps/relic-hunter-server-v1/src/relic-rest-auth.ts';

const SESSION = {
  clientId: 'alice',
  sessionId: 'alice-session',
};

describe('Relic REST auth policy', () => {
  it('keeps authenticated mode as the local default', () => {
    expect(readRelicRestAuthMode(env({}))).toBe('authenticated');
    expect(readRelicRestAuthMode(env({ RELIC_REST_AUTH_MODE: 'group-policy' })))
      .toBe('group-policy');
  });

  it('allows authenticated mode without group-policy state', () => {
    expect(() =>
      authorizeRelicSnapshotRead({
        mode: 'authenticated',
        gameId: 'room-1',
        session: SESSION,
      })
    ).not.toThrow();
    expect(() =>
      authorizeRelicCommand({
        mode: 'authenticated',
        gameId: 'room-1',
        session: SESSION,
      })
    ).not.toThrow();
    expect(() =>
      authorizeRelicReset({
        mode: 'authenticated',
        gameId: 'room-1',
        session: SESSION,
      })
    ).not.toThrow();
  });

  it('requires full group read permission for snapshot reads in group-policy mode', () => {
    expect(() =>
      authorizeRelicSnapshotRead({
        mode: 'group-policy',
        gameId: 'room-1',
        session: SESSION,
        snapshot: snapshot(),
      })
    ).not.toThrow();
    expect(() =>
      authorizeRelicSnapshotRead({
        mode: 'group-policy',
        gameId: 'room-1',
        session: { clientId: 'carol', sessionId: 'carol-session' },
        snapshot: snapshot(),
      })
    ).toThrow(/Only active group members can read full group state/);
  });

  it('requires room send permission for commands in group-policy mode', () => {
    expect(() =>
      authorizeRelicCommand({
        mode: 'group-policy',
        gameId: 'room-1',
        session: SESSION,
        snapshot: snapshot({
          activeSessions: [session('alice-session', 'alice')],
        }),
      })
    ).not.toThrow();
    expect(() =>
      authorizeRelicCommand({
        mode: 'group-policy',
        gameId: 'room-1',
        session: SESSION,
        snapshot: snapshot(),
      })
    ).toThrow(/live active group session/);
  });

  it('requires active owner/admin permission for reset in group-policy mode', () => {
    expect(() =>
      authorizeRelicReset({
        mode: 'group-policy',
        gameId: 'room-1',
        session: SESSION,
        snapshot: snapshot(),
      })
    ).not.toThrow();
    expect(() =>
      authorizeRelicReset({
        mode: 'group-policy',
        gameId: 'room-1',
        session: SESSION,
        snapshot: snapshot({
          members: [member('alice', { role: 'member' })],
        }),
      })
    ).toThrow(/owners\/admins/);
  });
});

function env(values: Record<string, string>): Pick<Deno.Env, 'get'> {
  return {
    get(key: string): string | undefined {
      return values[key];
    },
  };
}

function snapshot(
  options:
    & Partial<Group>
    & Readonly<{
      members?: readonly GroupMember[];
      activeSessions?: readonly GroupPresenceSession[];
    }> = {},
): GroupSnapshot {
  const group: Group = {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'room-1',
    displayName: 'Room 1',
    kind: 'room',
    status: 'active',
    joinMode: 'open',
    metadata: {},
    snapshotVersion: options.snapshotVersion ?? 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 1,
    created: { atEpochMs: 1, byServiceId: 'test' },
    updated: { atEpochMs: 1, byServiceId: 'test' },
    ...options,
  };
  const members = options.members ?? [member('alice', { role: 'owner' })];
  const activeSessions = options.activeSessions ?? [];

  return {
    group,
    members,
    activeSessions,
    memberCount: members.filter((entry) => entry.status === 'active').length,
    onlineMemberCount: new Set(activeSessions.map((entry) => entry.principalId)).size,
  };
}

function member(
  principalId: string,
  options: Partial<GroupMember> = {},
): GroupMember {
  return {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'room-1',
    principalId,
    role: options.role ?? 'member',
    status: options.status ?? 'active',
    joined: { atEpochMs: 1, byServiceId: 'test' },
    updated: { atEpochMs: 1, byServiceId: 'test' },
  };
}

function session(
  sessionId: string,
  principalId: string,
  options: Partial<GroupPresenceSession> = {},
): GroupPresenceSession {
  return {
    applicationId: 'rallar-server',
    workspaceId: 'default',
    groupId: 'room-1',
    sessionId,
    principalId,
    connectedAtEpochMs: 1,
    lastHeartbeatAtEpochMs: 1,
    expiresAtEpochMs: Date.now() + 60_000,
    ...options,
  };
}
