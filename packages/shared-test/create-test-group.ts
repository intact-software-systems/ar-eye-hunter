import type { AuditStamp, Group } from '@shared/api/group-types.ts';

/**
 * The one place tests construct a `Group`. The defaults below are annotated
 * `Group`, so a new required field on the aggregate fails to compile here
 * instead of failing at runtime in every construction site that omits it.
 */
export function createTestGroup(overrides: Partial<Group> = {}): Group {
  const audit: AuditStamp = {
    atEpochMs: 1,
    actor: { kind: 'principal', principalId: 'alice' },
    reason: null,
    traceId: null,
    requestId: null,
  };

  const defaults: Group = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
    slug: null,
    displayName: 'Room 1',
    description: null,
    kind: 'room',
    status: 'active',
    joinMode: 'open',
    maxMembers: null,
    maxSessionsPerMember: null,
    metadata: {},
    activeMemberCount: 1,
    ownerPrincipalId: 'alice',
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    created: audit,
    updated: audit,
    archived: null,
    deleted: null,
    expiresAtEpochMs: null,
    emptySinceEpochMs: null,
    purgeAfterEpochMs: null,
    lifecycleState: 'active',
  };

  // `Group` correlates `status` with `archived`/`deleted`, and a spread of
  // `Partial<Group>` cannot carry that correlation through the type system.
  return { ...defaults, ...overrides } as Group;
}
