import { describe, expect, it } from 'vitest';

// prettier-ignore
import {
  canCommandGroupLifecycleTransition,
} from '@shared-server/rallar-system/group-policy.ts';
// prettier-ignore
import {
  resolveGroupLifecyclePolicyPreset,
} from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { Group, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

function member(principalId: string, role: GroupMember['role']): GroupMember {
  const audit = {
    atEpochMs: 1,
    actor: { kind: 'principal' as const, principalId },
    reason: null,
    traceId: null,
    requestId: null,
  };
  return {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
    principalId,
    role,
    status: 'active',
    joined: audit,
    updated: audit,
    left: null,
    removed: null,
    banned: null,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
  };
}

function snapshot(overrides: Partial<Group>, members: readonly GroupMember[]): GroupSnapshot {
  const group = createTestGroup(overrides);
  return {
    stateRevision: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    group,
    members,
    activeSessions: [],
    memberCount: members.length,
    onlineMemberCount: 0,
  };
}

function withInitiator(
  policy: GroupLifecyclePolicy,
  establishment: Partial<GroupLifecyclePolicy['establishment']>,
  manager: Partial<GroupLifecyclePolicy['manager']> = {},
): GroupLifecyclePolicy {
  return {
    ...policy,
    establishment: { ...policy.establishment, ...establishment },
    manager: { ...policy.manager, ...manager },
  };
}

const OPTIMISTIC = resolveGroupLifecyclePolicyPreset('optimistic');
const MANAGED = resolveGroupLifecyclePolicyPreset('managed');
const MATCH = resolveGroupLifecyclePolicyPreset('match');
const DROP_IN = resolveGroupLifecyclePolicyPreset('drop-in-social');

describe('canCommandGroupLifecycleTransition', () => {
  it('lets any active member start establishment under any-member', () => {
    const result = canCommandGroupLifecycleTransition({
      snapshot: snapshot({ lifecycleState: 'forming' }, [member('alice', 'owner'), member('bob', 'member')]),
      actor: { principalId: 'bob' },
      policy: OPTIMISTIC,
      transition: 'start-establishment',
    });
    expect(result).toEqual({ allowed: true });
  });

  it('requires an active membership before any policy question', () => {
    const result = canCommandGroupLifecycleTransition({
      snapshot: snapshot({ lifecycleState: 'forming' }, [member('alice', 'owner')]),
      actor: { principalId: 'mallory' },
      policy: OPTIMISTIC,
      transition: 'start-establishment',
    });
    expect(result).toMatchObject({ allowed: false, code: 'member-not-active' });
  });

  it('derives the manager from the owner under managed (selection creator)', () => {
    const members = [member('alice', 'owner'), member('bob', 'admin')];
    const forming = snapshot({ lifecycleState: 'forming', ownerPrincipalId: 'alice' }, members);
    expect(canCommandGroupLifecycleTransition({
      snapshot: forming,
      actor: { principalId: 'alice' },
      policy: MANAGED,
      transition: 'start-establishment',
    })).toEqual({ allowed: true });
    expect(canCommandGroupLifecycleTransition({
      snapshot: forming,
      actor: { principalId: 'bob' },
      policy: MANAGED,
      transition: 'start-establishment',
    })).toMatchObject({ allowed: false, code: 'forbidden-role' });
  });

  it('derives assigned managers from the policy list', () => {
    const policy = withInitiator(MANAGED, {}, {
      selection: 'assigned',
      assignedPrincipalIds: ['bob'],
    });
    const members = [member('alice', 'owner'), member('bob', 'member')];
    const forming = snapshot({ lifecycleState: 'forming' }, members);
    expect(canCommandGroupLifecycleTransition({
      snapshot: forming,
      actor: { principalId: 'bob' },
      policy,
      transition: 'start-establishment',
    })).toEqual({ allowed: true });
    expect(canCommandGroupLifecycleTransition({
      snapshot: forming,
      actor: { principalId: 'alice' },
      policy,
      transition: 'start-establishment',
    })).toMatchObject({ allowed: false, code: 'forbidden-role' });
  });

  it('reports elected managers as unavailable until election lands', () => {
    const result = canCommandGroupLifecycleTransition({
      snapshot: snapshot({ lifecycleState: 'forming' }, [member('alice', 'owner')]),
      actor: { principalId: 'alice' },
      policy: MATCH,
      transition: 'start-establishment',
    });
    expect(result).toMatchObject({
      allowed: false,
      code: 'lifecycle-manager-unavailable',
    });
  });

  it('denies principal commands under server-auto', () => {
    const result = canCommandGroupLifecycleTransition({
      snapshot: snapshot({ lifecycleState: 'forming' }, [member('alice', 'owner')]),
      actor: { principalId: 'alice' },
      policy: DROP_IN,
      transition: 'start-establishment',
    });
    expect(result).toMatchObject({ allowed: false, code: 'forbidden-role' });
  });

  it('folds state validity into the same decision', () => {
    const result = canCommandGroupLifecycleTransition({
      snapshot: snapshot({ lifecycleState: 'active' }, [member('alice', 'owner')]),
      actor: { principalId: 'alice' },
      policy: OPTIMISTIC,
      transition: 'start-establishment',
    });
    expect(result).toMatchObject({
      allowed: false,
      code: 'lifecycle-transition-invalid',
    });
  });

  it('authorizes activate and reopen-establishment against their own source states', () => {
    const members = [member('alice', 'owner')];
    expect(canCommandGroupLifecycleTransition({
      snapshot: snapshot({ lifecycleState: 'establishing' }, members),
      actor: { principalId: 'alice' },
      policy: OPTIMISTIC,
      transition: 'activate',
    })).toEqual({ allowed: true });
    expect(canCommandGroupLifecycleTransition({
      snapshot: snapshot({ lifecycleState: 'active' }, members),
      actor: { principalId: 'alice' },
      policy: OPTIMISTIC,
      transition: 'reopen-establishment',
    })).toEqual({ allowed: true });
  });
});
