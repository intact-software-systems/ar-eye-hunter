// prettier-ignore
import type { GroupStateRepository }
  from '../../../group-state/persistence/group-state-repository.ts';
// prettier-ignore
import type { GroupTopologyConfigRepository }
  from '../persistence/group-topology-config-repository.ts';
// prettier-ignore
import { RuntimeStateWriteConflictError }
  from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import type {
  GroupTopologyConfigMutationCommand,
  GroupTopologyConfigMutationRead,
} from './group-topology-config-mutation-contracts.ts';

export async function readTopologyConfigMutation(
  repository: GroupTopologyConfigRepository,
  groupStateRepository: GroupStateRepository,
  command: GroupTopologyConfigMutationCommand,
): Promise<GroupTopologyConfigMutationRead> {
  const exact = await repository.readMutationExactEntries(command.aggregateRef, command.requestId);
  if (exact.status === 'fallback') {
    return await readTopologyConfigMutationSequentially(repository, groupStateRepository, command);
  }

  const groupObservation = await groupStateRepository.readSnapshotWithAuthorityGuard(
    command.aggregateRef,
  );
  const invariantAfter = await repository.findInvariantGenerationEntry(command.aggregateRef);
  if (!groupObservation) {
    throw new Error(`Group snapshot not found: ${command.aggregateRef.groupId}`);
  }
  if (!sameTopologyInvariantGeneration(exact.invariant ?? undefined, invariantAfter)) {
    throw new RuntimeStateWriteConflictError();
  }
  return {
    config: exact.config,
    override: exact.override,
    configGeneration: exact.configGeneration,
    overrideGeneration: exact.overrideGeneration,
    invariantGeneration: invariantAfter ?? null,
    idempotency: exact.idempotency,
    groupSnapshot: groupObservation.snapshot,
    groupAuthorityGuard: groupObservation.authorityGuard,
  };
}

async function readTopologyConfigMutationSequentially(
  repository: GroupTopologyConfigRepository,
  groupStateRepository: GroupStateRepository,
  command: GroupTopologyConfigMutationCommand,
): Promise<GroupTopologyConfigMutationRead> {
  const invariantBefore = await repository.findInvariantGenerationEntry(command.aggregateRef);
  const [config, override, configGeneration, overrideGeneration, idempotency, groupObservation] =
    await Promise.all([
      repository.findConfigEntry(command.aggregateRef),
      repository.findOverrideEntry(command.aggregateRef),
      repository.findGenerationEntry(command.aggregateRef, 'config'),
      repository.findGenerationEntry(command.aggregateRef, 'override'),
      command.requestId === null
        ? Promise.resolve(undefined)
        : repository.findMutationRecordEntry(command.aggregateRef, command.requestId),
      groupStateRepository.readSnapshotWithAuthorityGuard(command.aggregateRef),
    ]);
  const invariantAfter = await repository.findInvariantGenerationEntry(command.aggregateRef);
  if (!groupObservation) {
    throw new Error(`Group snapshot not found: ${command.aggregateRef.groupId}`);
  }
  if (!sameTopologyInvariantGeneration(invariantBefore, invariantAfter)) {
    throw new RuntimeStateWriteConflictError();
  }
  return {
    config: config ?? null,
    override: override ?? null,
    configGeneration: configGeneration ?? null,
    overrideGeneration: overrideGeneration ?? null,
    invariantGeneration: invariantAfter ?? null,
    idempotency: idempotency ?? null,
    groupSnapshot: groupObservation.snapshot,
    groupAuthorityGuard: groupObservation.authorityGuard,
  };
}

export function sameTopologyInvariantGeneration(
  left: Awaited<ReturnType<GroupTopologyConfigRepository['findInvariantGenerationEntry']>>,
  right: Awaited<ReturnType<GroupTopologyConfigRepository['findInvariantGenerationEntry']>>,
): boolean {
  if (!left || !right) return left === right;
  return left.entry.revision === right.entry.revision && left.value.version === right.value.version;
}
