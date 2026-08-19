import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type {
  GroupTopologyConfigMutationCommand,
  GroupTopologyConfigMutationFacts,
  GroupTopologyConfigMutationRead,
} from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import { createTestGroup } from '../../../../../create-test-group.ts';

export interface CreateTopologyConfigMutationTestInput {
  readonly operation?: 'putConfig' | 'putOverride';
  readonly commandId?: string | null;
  readonly config?: GroupTopologyConfigPatch;
  readonly durableDegreeLimit?: number;
  readonly overrideDegreeLimit?: number | null;
  readonly requestId?: string | null;
}

export function createTopologyConfigMutationTestInput(
  settings: CreateTopologyConfigMutationTestInput = {},
) {
  const operation = settings.operation ?? 'putConfig';
  const groupRef = createTopologyTestGroupRef();
  const requestId = settings.requestId === undefined ? `request-${operation}` : settings.requestId;
  const commandId =
    settings.commandId === undefined ? (requestId ?? `command-${operation}`) : settings.commandId;
  const read = createTopologyConfigMutationRead({
    durableDegreeLimit: settings.durableDegreeLimit,
    overrideDegreeLimit: settings.overrideDegreeLimit,
  });
  const command: GroupTopologyConfigMutationCommand = {
    operation,
    aggregateRef: groupRef,
    commandId: commandId ?? `command-${operation}`,
    requestId,
    input: {
      config: settings.config ?? { topologyKind: 'tree' },
      updatedByPrincipalId: 'owner',
      ttlMs: operation === 'putOverride' ? 5_000 : null,
      expiresAtEpochMs: null,
    },
  };
  const facts: GroupTopologyConfigMutationFacts = {
    requestedAtEpochMs: 1_000,
    policyNowEpochMs: 1_000,
    commandHash: `sha256:${'c'.repeat(64)}`,
    attemptCount: 1,
    isPlatformAdmin: false,
    resolvedOverrideExpiresAtEpochMs: operation === 'putOverride' ? 6_000 : null,
  };
  return { command, read, facts, serverDefaults: {} } as const;
}

export function createTopologyTestGroupRef() {
  return {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
  };
}

export function createTopologyTestGroupSnapshot(): GroupSnapshot {
  const groupRef = createTopologyTestGroupRef();
  return {
    stateRevision: 1,
    causalRevision: { groupRevision: 1, presenceRevision: 0 },
    group: createTestGroup({
      ...groupRef,
      displayName: 'Room 1',
      snapshotVersion: 1,
      metadataVersion: 0,
      rosterVersion: 1,
      presenceVersion: 0,
      activeMemberCount: 1,
      ownerPrincipalId: 'owner',
      created: topologyTestAuditStamp(),
      updated: topologyTestAuditStamp(),
    }),
    members: [
      {
        ...groupRef,
        principalId: 'owner',
        role: 'owner',
        status: 'active',
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
        joined: topologyTestAuditStamp(),
        updated: topologyTestAuditStamp(),
      },
    ],
    activeSessions: [],
    memberCount: 1,
    onlineMemberCount: 0,
  };
}

export function createTopologyTestAuthorityGuard(revision = 0) {
  const group = createTopologyTestGroupSnapshot().group;
  return {
    groupRef: createTopologyTestGroupRef(),
    causalGroupRevision: 1,
    entry: {
      key: 'group-authority',
      value: JSON.stringify(group),
      expireAtTimestamp: Number.MAX_SAFE_INTEGER,
      updatedTimestamp: new Date(0).toISOString(),
      revision,
    },
  };
}

export function deepFreezeTopologyTestValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeTopologyTestValue(nested);
    }
  }
  return value;
}

function createTopologyConfigMutationRead(settings: {
  readonly durableDegreeLimit?: number;
  readonly overrideDegreeLimit?: number | null;
}): GroupTopologyConfigMutationRead {
  const durable =
    settings.durableDegreeLimit === undefined
      ? null
      : storedTopologyConfig(settings.durableDegreeLimit, 'durable');
  const override =
    settings.overrideDegreeLimit === undefined || settings.overrideDegreeLimit === null
      ? null
      : {
          ...storedTopologyConfig(settings.overrideDegreeLimit, 'override'),
          expiresAtEpochMs: 10_000,
        };
  return {
    config: durable === null ? null : runtimeEntry('config', durable),
    override: override === null ? null : runtimeEntry('override', override),
    configGeneration: null,
    overrideGeneration: null,
    invariantGeneration: null,
    idempotency: null,
    groupSnapshot: createTopologyTestGroupSnapshot(),
    groupAuthorityGuard: createTopologyTestAuthorityGuard(),
  };
}

function storedTopologyConfig(degreeLimit: number, requestId: string) {
  return {
    groupRef: createTopologyTestGroupRef(),
    config: {
      topologyKind: 'auto' as const,
      degreeLimit,
      treeMinSize: 5,
      meshMinSize: 16,
      meshParamK: 2,
    },
    version: 1,
    createdAtEpochMs: 500,
    updatedAtEpochMs: 500,
    updatedByPrincipalId: 'owner',
    requestId,
  };
}

function runtimeEntry<T>(key: string, value: T) {
  return {
    key,
    value,
    entry: {
      key,
      value: JSON.stringify(value),
      expireAtTimestamp:
        typeof value === 'object' && value !== null && 'expiresAtEpochMs' in value
          ? Number(value.expiresAtEpochMs)
          : Number.MAX_SAFE_INTEGER,
      updatedTimestamp: new Date(0).toISOString(),
      revision: 0,
    },
  };
}

function topologyTestAuditStamp() {
  return {
    atEpochMs: 1,
    actor: { kind: 'principal' as const, principalId: 'owner' },
    reason: null,
    traceId: null,
    requestId: null,
  };
}
