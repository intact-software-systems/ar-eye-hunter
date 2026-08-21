import { describe, expect, it } from 'vitest';

// prettier-ignore
import { toScopedGroupMutationCommandId } from
  '@shared-server/rallar-system/group-state/scoped-group-mutation-command-id.ts';
import type {
  GroupMutationAuthorityProof,
  GroupMutationDescriptor,
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';

const descriptor: GroupMutationDescriptor = {
  operation: 'updateGroup',
  scope: { applicationId: 'scope-app', workspaceId: 'scope-workspace' },
  groupId: 'scope-group',
  targetPrincipalId: null,
  sessionId: null,
  request: {
    displayName: 'Scoped group',
    actorPrincipalId: 'owner',
    actorSessionId: 'owner-session-1',
    requestId: 'same-logical-request-001',
  },
};

const authority: GroupMutationAuthorityProof = {
  version: 1,
  principalId: 'owner',
  sessionId: 'owner-session-1',
  sessionIssuedAtEpochMs: 1_000,
  sessionExpiresAtEpochMs: 61_000,
  commandMac: 'a'.repeat(64),
};

describe('scoped group AppInbox command identity', () => {
  it('survives an authenticated session renewal for the same stable principal', async () => {
    const renewedAuthority: GroupMutationAuthorityProof = {
      ...authority,
      sessionId: 'owner-session-2',
      sessionIssuedAtEpochMs: 2_000,
      sessionExpiresAtEpochMs: 62_000,
      commandMac: 'b'.repeat(64),
    };

    await expect(toScopedGroupMutationCommandId(descriptor, renewedAuthority)).resolves.toBe(
      await toScopedGroupMutationCommandId(descriptor, authority),
    );
  });

  it('isolates operation, caller, target, and group scope with a bounded opaque key', async () => {
    const baseline = await toScopedGroupMutationCommandId(descriptor, authority);
    const variants = await Promise.all([
      toScopedGroupMutationCommandId({ ...descriptor, operation: 'appointDirector' }, authority),
      toScopedGroupMutationCommandId(descriptor, { ...authority, principalId: 'other-owner' }),
      toScopedGroupMutationCommandId(
        { ...descriptor, targetPrincipalId: 'target-principal' },
        authority,
      ),
      toScopedGroupMutationCommandId({ ...descriptor, groupId: 'other-group' }, authority),
    ]);

    expect(baseline).toMatch(/^group-app-inbox:[0-9a-f]{64}$/);
    expect(baseline.length).toBeLessThanOrEqual(128);
    expect(new Set([baseline, ...variants])).toHaveLength(variants.length + 1);
  });
});
