import { describe, expect, it } from 'vitest';
import type { AuditStamp, Group, GroupMember, GroupRef } from '@shared/api/group-types.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/compute-group-mutation.ts';
import type {
  GroupMutationCommand,
  GroupMutationFacts,
  GroupMutationRead,
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { groupStateGroupStorageKey, groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import { decodeCanonicalGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { Temporal } from '@js-temporal/polyfill';
import { parseTemporalPlainDateTime, toPgTimestamp } from '@shared-server/postgres/resource-inbox/repository-utils.ts';

const ref: GroupRef = {
  applicationId: 'cross-process-app',
  workspaceId: 'cross-process-workspace',
  groupId: 'cross-process-group',
};
const seedAudit: AuditStamp = {
  atEpochMs: 1_000,
  actor: { kind: 'principal', principalId: 'owner' },
  reason: null,
  traceId: null,
  requestId: 'seed',
};

describe('group presence-summary causal identity', () => {
  it('preserves UTC wall-clock fields returned as Date values by postgres', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      const canonical = Temporal.PlainDateTime.from('2026-07-26T18:01:26.954');
      expect(toPgTimestamp(canonical)).toBe('2026-07-26T18:01:26.954Z');
      expect(parseTemporalPlainDateTime(new Date('2026-07-26T09:01:26.954Z')).toString()).toBe(canonical.toString());
    } finally {
      process.env.TZ = previousTimezone;
    }
  });

  it('uses the snapshot version when another process advanced storage revision', () => {
    const command: GroupMutationCommand = {
      operation: 'upsertMember',
      aggregateRef: ref,
      targetPrincipalId: 'member',
      commandId: 'cross-process-member',
      requestId: 'cross-process-member',
      input: {
        role: null,
        status: 'active',
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        actorPrincipalId: 'member',
        actorSessionId: 'member-session',
        reason: null,
        traceId: null,
      },
    };
    const computed = computeGroupMutation({
      command,
      read: mutationRead(40),
      facts: mutationFacts(),
    });

    expect(computed.outcome).toBe('write');
    if (computed.outcome !== 'write') throw new Error('Expected a durable group write');
    expect(computed.receipt.causalRevision).toEqual({ groupRevision: 2, presenceRevision: 0 });
    expect(computed.receipt.snapshotVersion).toBe(2);
    const effect = decodeCanonicalGroupPresenceSummaryEntry(computed.outboxEntries[0]);
    expect(effect.acceptedCausalRevision).toEqual(computed.receipt.causalRevision);
    expect(effect.event.snapshotVersion).toBe(computed.receipt.snapshotVersion);
  });
});

function mutationRead(storageRevision: number): GroupMutationRead {
  const group: Group = {
    ...ref,
    slug: null,
    displayName: 'Cross-process group',
    description: null,
    kind: 'room',
    status: 'active',
    joinMode: 'open',
    maxMembers: 100,
    maxSessionsPerMember: 4,
    metadata: {},
    activeMemberCount: 1,
    ownerPrincipalId: 'owner',
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    created: seedAudit,
    updated: seedAudit,
    archived: null,
    deleted: null,
    expiresAtEpochMs: null,
    emptySinceEpochMs: null,
    purgeAfterEpochMs: null,
  };
  const owner = member('owner', 'owner');
  return {
    idempotency: null,
    group: stored(groupStateGroupStorageKey(ref), group, storageRevision),
    expiredGroupEntry: null,
    actorMember: null,
    targetMember: null,
    authorityMember: owner,
    directorMember: null,
    actorMemberEntry: null,
    targetMemberEntry: null,
    authorityMemberEntry: stored(groupStateMemberStorageKey({ ...ref, principalId: owner.principalId }), owner, 0),
    directorMemberEntry: null,
    targetPresence: null,
    expiredTargetPresenceEntry: null,
    targetAdmission: null,
    authorityAdmission: null,
    directorAdmission: null,
    authorityPresenceSessions: [],
    authorityPresenceSessionEntries: [],
    presenceSummary: null,
  } as GroupMutationRead;
}

function member(principalId: string, role: GroupMember['role']): GroupMember {
  return {
    ...ref,
    principalId,
    role,
    status: 'active',
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
    joined: seedAudit,
    updated: seedAudit,
    left: null,
    removed: null,
    banned: null,
  };
}

function stored<T>(key: string, value: T, revision: number) {
  return {
    entry: {
      key,
      value: JSON.stringify(value),
      expireAtTimestamp: Number.MAX_SAFE_INTEGER,
      updatedTimestamp: new Date(0).toISOString(),
      revision,
    },
    value,
  };
}

function mutationFacts(): GroupMutationFacts {
  return {
    nowEpochMs: 2_000,
    expireAtEpochMs: 253_402_300_799_999,
    serviceId: 'consumer-service',
    eventId: 'cross-process-event',
    commandHash: `sha256:${'a'.repeat(64)}`,
    attemptCount: 1,
    resolvedJoinCode: null,
    joinCodeVerifier: null,
    internalAuthority: 'none',
    authenticatedAuthority: {
      principalId: 'member',
      sessionId: 'member-session',
    },
  };
}
