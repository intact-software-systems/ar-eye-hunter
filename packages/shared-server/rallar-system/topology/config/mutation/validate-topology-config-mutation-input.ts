import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
  canMutateActiveGroup,
  canUpdateGroupSnapshot,
  GroupPolicyDeniedError,
} from '../../../group-policy.ts';
import {
  resolveOverrideExpiresAtEpochMs,
  validateGroupTopologyConfigPatch,
} from '../group-topology-config.ts';
import type {
  GroupTopologyConfigMutationCommand,
  GroupTopologyConfigMutationFacts,
  GroupTopologyConfigMutationRead,
  TopologyConfigMutationInput,
} from './group-topology-config-mutation-contracts.ts';
import {
  requireTopologyString,
  sameTopologyGroupRef,
  validateTopologyGroupRef,
  validateTopologyPositiveInteger,
  validateTopologyStorageRevision,
} from './topology-config-mutation-boundary.ts';
import {
  validateGroupTopologyConfigGeneration,
  validateGroupTopologyConfigInvariantGeneration,
  validateGroupTopologyConfigMutationRecord,
  validateStoredGroupTopologyConfig,
  validateStoredGroupTopologyOverride,
} from './validate-topology-config-records.ts';

export function validateTopologyConfigMutationInput(
  topologyMutation: TopologyConfigMutationInput,
): void {
  validateTopologyConfigCommand(topologyMutation.command);
  validateTopologyConfigRead(topologyMutation.read, topologyMutation.command);
  validateTopologyConfigFacts(topologyMutation.facts);
  validateTopologyConfigAuthority(
    topologyMutation.read.groupSnapshot,
    topologyMutation.command,
    topologyMutation.facts,
  );
}

export function validateTopologyConfigIdempotencyInput(
  command: GroupTopologyConfigMutationCommand,
  read: GroupTopologyConfigMutationRead,
  authorityFacts: Readonly<{ isPlatformAdmin: boolean }>,
): void {
  validateTopologyConfigCommand(command);
  validateTopologyConfigRead(read, command);
  if (typeof authorityFacts.isPlatformAdmin !== 'boolean') {
    throw new TypeError('Topology config admin fact is invalid');
  }
  validateTopologyConfigAuthority(read.groupSnapshot, command, authorityFacts);
}

export function requireTopologyConfigPatch(
  command: GroupTopologyConfigMutationCommand,
): GroupTopologyConfigPatch {
  if (command.input.config === null) {
    throw new TypeError('Topology config command patch is required');
  }
  return command.input.config;
}

export function requireTopologyConfigRequestId(
  command: GroupTopologyConfigMutationCommand,
): string {
  if (command.requestId === null) {
    throw new TypeError('Topology config request id is required');
  }
  return command.requestId;
}

function validateTopologyConfigCommand(command: GroupTopologyConfigMutationCommand): void {
  if (!command || typeof command !== 'object' || 'commandHash' in command) {
    throw new TypeError('Topology config command is invalid');
  }
  if (!['putConfig', 'deleteConfig', 'putOverride', 'deleteOverride'].includes(command.operation)) {
    throw new TypeError('Topology config operation is invalid');
  }
  validateTopologyGroupRef(command.aggregateRef, 'Topology config command groupRef');
  requireTopologyString(command.commandId, 'Topology config commandId');
  if (command.requestId !== null) {
    requireTopologyString(command.requestId, 'Topology config requestId');
  }
  requireTopologyString(command.input.updatedByPrincipalId, 'Topology config updated principal');
  const isPut = command.operation === 'putConfig' || command.operation === 'putOverride';
  if (isPut) {
    validateGroupTopologyConfigPatch(requireTopologyConfigPatch(command));
  }
  if (isPut !== (command.input.config !== null)) {
    throw new TypeError('Topology config command patch does not match operation');
  }
}

function validateTopologyConfigRead(
  read: GroupTopologyConfigMutationRead,
  command: GroupTopologyConfigMutationCommand,
): void {
  validateTopologyConfigReadAuthority(read, command);
  if (read.config) {
    validateStoredGroupTopologyConfig(read.config.value, command.aggregateRef);
    validateTopologyStorageRevision(read.config.entry.revision, 'config');
  }
  if (read.override) {
    validateStoredGroupTopologyOverride(read.override.value, command.aggregateRef);
    validateTopologyStorageRevision(read.override.entry.revision, 'override');
  }
  validateTopologyConfigReadGenerations(read, command);
  if (read.idempotency) {
    if (command.requestId === null) {
      throw new TypeError('Topology config command without requestId read a claim');
    }
    validateGroupTopologyConfigMutationRecord(read.idempotency.value, {
      groupRef: command.aggregateRef,
      requestId: command.requestId,
    });
    validateTopologyStorageRevision(read.idempotency.entry.revision, 'idempotency');
  }
}

function validateTopologyConfigReadAuthority(
  read: GroupTopologyConfigMutationRead,
  command: GroupTopologyConfigMutationCommand,
): void {
  if (!sameTopologyGroupRef(read.groupSnapshot.group, command.aggregateRef)) {
    throw new TypeError('Topology config group snapshot has the wrong scope');
  }
  if (
    !read.groupAuthorityGuard ||
    !sameTopologyGroupRef(read.groupAuthorityGuard.groupRef, command.aggregateRef) ||
    read.groupAuthorityGuard.causalGroupRevision !== read.groupSnapshot.causalRevision.groupRevision
  ) {
    throw new TypeError('Topology config group authority guard differs from its snapshot');
  }
}

function validateTopologyConfigReadGenerations(
  read: GroupTopologyConfigMutationRead,
  command: GroupTopologyConfigMutationCommand,
): void {
  if (read.configGeneration) {
    validateGroupTopologyConfigGeneration(
      read.configGeneration.value,
      command.aggregateRef,
      'config',
    );
    validateTopologyStorageRevision(read.configGeneration.entry.revision, 'config generation');
  }
  if (read.overrideGeneration) {
    validateGroupTopologyConfigGeneration(
      read.overrideGeneration.value,
      command.aggregateRef,
      'override',
    );
    validateTopologyStorageRevision(read.overrideGeneration.entry.revision, 'override generation');
  }
  if (read.invariantGeneration) {
    validateGroupTopologyConfigInvariantGeneration(
      read.invariantGeneration.value,
      command.aggregateRef,
    );
    validateTopologyStorageRevision(
      read.invariantGeneration.entry.revision,
      'topology config invariant generation',
    );
  }
}

function validateTopologyConfigFacts(facts: GroupTopologyConfigMutationFacts): void {
  validateTopologyStorageRevision(facts.requestedAtEpochMs, 'request fact time');
  validateTopologyStorageRevision(facts.policyNowEpochMs, 'policy fact time');
  validateTopologyPositiveInteger(facts.attemptCount, 'attempt fact count');
  if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
    throw new TypeError('Topology config command hash is invalid');
  }
  if (typeof facts.isPlatformAdmin !== 'boolean') {
    throw new TypeError('Topology config admin fact is invalid');
  }
  if (facts.resolvedOverrideExpiresAtEpochMs !== null) {
    validateTopologyStorageRevision(facts.resolvedOverrideExpiresAtEpochMs, 'override expiry fact');
    resolveOverrideExpiresAtEpochMs({
      nowEpochMs: facts.policyNowEpochMs,
      expiresAtEpochMs: facts.resolvedOverrideExpiresAtEpochMs,
    });
  }
}

function validateTopologyConfigAuthority(
  snapshot: GroupSnapshot,
  command: GroupTopologyConfigMutationCommand,
  facts: Readonly<{ isPlatformAdmin: boolean; policyNowEpochMs?: number }>,
): void {
  const lifecyclePolicy = canMutateActiveGroup({
    group: snapshot.group,
    nowEpochMs: facts.policyNowEpochMs,
  });
  if (!lifecyclePolicy.allowed) {
    throw new GroupPolicyDeniedError(lifecyclePolicy);
  }
  if (facts.isPlatformAdmin) {
    return;
  }
  const policy = canUpdateGroupSnapshot({
    snapshot,
    actor: { principalId: command.input.updatedByPrincipalId },
    nowEpochMs: facts.policyNowEpochMs,
  });
  if (!policy.allowed) {
    throw new GroupPolicyDeniedError(policy);
  }
}
