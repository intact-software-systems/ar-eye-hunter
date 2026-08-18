import { describe, expect, it } from 'vitest';

import type {
  AuditStamp,
  Group,
  GroupMember,
  GroupPresenceSession,
  GroupPresenceSummary,
} from '@shared/api/group-types.ts';
import {
  assembleGroupStateSnapshot,
  type GroupStateSnapshotAssemblyInput,
} from '@shared-server/rallar-system/group-state/persistence/assemble-group-state-snapshot.ts';
import { canSendRoomMessage } from '@shared-server/rallar-system/group-policy.ts';
import { isGroupSnapshotPresenceFresh } from '@shared-server/rallar-system/snapshot-presence.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

const REF = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  groupId: 'room-1',
} as const;
const TRANSITION_AT_EPOCH_MS = 1_000;
const FROZEN_LEASE_EXPIRES_AT_EPOCH_MS = TRANSITION_AT_EPOCH_MS + 120_000;
const IDLE_OBSERVED_AT_EPOCH_MS = TRANSITION_AT_EPOCH_MS + 600_000;

describe('assembleGroupStateSnapshot session lease fields', () => {
  it('carries authoritative leases so an idle group stays live, fresh, and send-authorized', () => {
    const snapshot = assembleGroupStateSnapshot(
      createAssemblyInput({
        sessionLeaseFields: 'authoritative',
        authoritativeLeaseExpiresAtEpochMs: IDLE_OBSERVED_AT_EPOCH_MS + 60_000,
      }),
      (storageKey, message) => new Error(`${message}: ${storageKey}`),
    );

    expect(snapshot.activeSessions).toHaveLength(1);
    expect(snapshot.activeSessions[0]).toMatchObject({
      lastHeartbeatAtEpochMs: IDLE_OBSERVED_AT_EPOCH_MS - 10_000,
      expiresAtEpochMs: IDLE_OBSERVED_AT_EPOCH_MS + 60_000,
    });
    expect(snapshot.onlineMemberCount).toBe(1);
    expect(isGroupSnapshotPresenceFresh(snapshot, IDLE_OBSERVED_AT_EPOCH_MS)).toBe(true);
    expect(
      canSendRoomMessage({
        snapshot,
        senderSessionId: 'session-alice',
        actor: { principalId: 'alice' },
        nowEpochMs: IDLE_OBSERVED_AT_EPOCH_MS,
      }).allowed,
    ).toBe(true);
  });

  it('drops the session under summary-frozen leases once the frozen lease lapses', () => {
    const snapshot = assembleGroupStateSnapshot(
      createAssemblyInput({
        sessionLeaseFields: 'summary-frozen',
        authoritativeLeaseExpiresAtEpochMs: IDLE_OBSERVED_AT_EPOCH_MS + 60_000,
      }),
      (storageKey, message) => new Error(`${message}: ${storageKey}`),
    );

    expect(snapshot.activeSessions).toHaveLength(0);
    expect(snapshot.onlineMemberCount).toBe(0);
  });

  it('drops the session under authoritative leases once the authoritative lease lapses', () => {
    const snapshot = assembleGroupStateSnapshot(
      createAssemblyInput({
        sessionLeaseFields: 'authoritative',
        authoritativeLeaseExpiresAtEpochMs: IDLE_OBSERVED_AT_EPOCH_MS - 1,
      }),
      (storageKey, message) => new Error(`${message}: ${storageKey}`),
    );

    expect(snapshot.activeSessions).toHaveLength(0);
    expect(snapshot.onlineMemberCount).toBe(0);
  });
});

function createAssemblyInput(
  input: Readonly<{
    sessionLeaseFields: GroupStateSnapshotAssemblyInput['sessionLeaseFields'];
    authoritativeLeaseExpiresAtEpochMs: number;
  }>,
): GroupStateSnapshotAssemblyInput {
  const frozenSession = createSession({
    lastHeartbeatAtEpochMs: TRANSITION_AT_EPOCH_MS,
    expiresAtEpochMs: FROZEN_LEASE_EXPIRES_AT_EPOCH_MS,
  });
  const authoritativeSession = createSession({
    lastHeartbeatAtEpochMs: IDLE_OBSERVED_AT_EPOCH_MS - 10_000,
    expiresAtEpochMs: input.authoritativeLeaseExpiresAtEpochMs,
  });
  const summary: GroupPresenceSummary = {
    ...REF,
    causalRevision: { groupRevision: 1, presenceRevision: 1 },
    activePrincipalIds: ['alice'],
    activeSessionIds: ['session-alice'],
    activeSessions: [frozenSession],
    activePrincipalCount: 1,
    activeSessionCount: 1,
    computedAtEpochMs: TRANSITION_AT_EPOCH_MS,
  };
  return {
    group: createGroup(),
    members: [createMember()],
    summary,
    authoritativeSessions: [authoritativeSession],
    groupRevision: 1,
    observedAtEpochMs: IDLE_OBSERVED_AT_EPOCH_MS,
    sessionLeaseFields: input.sessionLeaseFields,
  };
}

function createSession(
  lease: Readonly<{ lastHeartbeatAtEpochMs: number; expiresAtEpochMs: number }>,
): GroupPresenceSession {
  return {
    ...REF,
    principalId: 'alice',
    sessionId: 'session-alice',
    generationId: 'generation-alice',
    generationVersion: 1,
    status: 'active',
    disconnectedAtEpochMs: null,
    disconnectReason: null,
    connectedAtEpochMs: TRANSITION_AT_EPOCH_MS,
    lastHeartbeatAtEpochMs: lease.lastHeartbeatAtEpochMs,
    expiresAtEpochMs: lease.expiresAtEpochMs,
  };
}

function createGroup(): Group {
  const audit = createAuditStamp();
  return createTestGroup({
    ...REF,
    displayName: 'Room 1',
    activeMemberCount: 1,
    ownerPrincipalId: 'alice',
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 1,
    created: audit,
    updated: audit,
  });
}

function createMember(): GroupMember {
  const audit = createAuditStamp();
  return {
    ...REF,
    principalId: 'alice',
    role: 'owner',
    status: 'active',
    joined: audit,
    updated: audit,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
    left: null,
    removed: null,
    banned: null,
  };
}

function createAuditStamp(): AuditStamp {
  return {
    atEpochMs: 1,
    actor: { kind: 'service', serviceId: 'test' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
