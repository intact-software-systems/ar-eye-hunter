import { vi } from 'vitest';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '../create-test-group.ts';

export function createClientSnapshot(stateRevision: number): ClientSnapshot {
  const audit = createAuditStamp(stateRevision);
  return {
    stateRevision,
    principal: {
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      principalId: 'alice',
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: null,
      authProvider: null,
      externalSubjectId: null,
      status: 'active',
      disabled: null,
      deleted: null,
      roles: [],
      metadata: {},
      snapshotVersion: stateRevision,
      profileVersion: stateRevision,
      presenceVersion: stateRevision,
      created: audit,
      updated: audit,
      lastSeenAtEpochMs: null,
    },
    instances: [],
    activeSessions: [],
    isOnline: false,
    activeSessionCount: 0,
    lastSeenAtEpochMs: null,
  };
}

export function createGroupSnapshot(
  groupRevision: number,
  presenceRevision: number,
): GroupSnapshot {
  const audit = createAuditStamp(Math.max(groupRevision, presenceRevision));
  return {
    stateRevision: Math.max(groupRevision, presenceRevision),
    causalRevision: { groupRevision, presenceRevision },
    group: createTestGroup({
      applicationId: 'app-1',
      workspaceId: 'workspace-1',
      groupId: 'group-1',
      displayName: 'Group 1',
      snapshotVersion: groupRevision,
      metadataVersion: groupRevision,
      rosterVersion: groupRevision,
      presenceVersion: presenceRevision,
      activeMemberCount: 0,
      ownerPrincipalId: 'alice',
      created: audit,
      updated: audit,
    }),
    members: [],
    activeSessions: [],
    memberCount: 0,
    onlineMemberCount: 0,
  };
}

export function createClientCache(initial?: ClientSnapshot) {
  let current = initial;
  return {
    peek: vi.fn(() => current),
    observe: vi.fn((snapshot: ClientSnapshot) => {
      if (!current || snapshot.stateRevision > current.stateRevision) {
        const outcome = current ? 'advanced' : 'inserted';
        current = snapshot;
        return outcome;
      }
      return snapshot === current ? 'duplicate' : 'stale';
    }),
    evictIfUnchanged: vi.fn((_ref, expected: ClientSnapshot) => {
      if (current !== expected) return false;
      current = undefined;
      return true;
    }),
    publish(snapshot: ClientSnapshot) {
      current = snapshot;
    },
    current: () => current,
  };
}

export function createGroupCache(initial?: GroupSnapshot) {
  let current = initial;
  return {
    peek: vi.fn(() => current),
    observe: vi.fn((snapshot: GroupSnapshot) => {
      current = snapshot;
      return 'advanced' as const;
    }),
    evictIfUnchanged: vi.fn((_ref, expected: GroupSnapshot) => {
      if (current !== expected) return false;
      current = undefined;
      return true;
    }),
    publish(snapshot: GroupSnapshot) {
      current = snapshot;
    },
    current: () => current,
  };
}

function createAuditStamp(atEpochMs: number): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
