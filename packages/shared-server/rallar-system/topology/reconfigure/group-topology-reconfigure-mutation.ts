import { compareGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';

import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from '../../../postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '../../../runtime-state/optimistic-runtime-state-write.ts';
import {
  canMutateActiveGroup,
  canUpdateGroupSnapshot,
  GroupPolicyDeniedError,
} from '../../group-policy.ts';
import { GroupStateRepository } from '../../group-state/persistence/group-state-repository.ts';
import { writeRtcTopologyOutbox } from '../../services/rtc-topology-outbox-entry.ts';
import type {
  GroupTopologyPlanningAuthority,
  ReadGroupTopologyPlanningAuthorityInput,
} from '../planning/group-topology-planning-authority.ts';
import type {
  GroupTopologyReconfigureCommand,
  GroupTopologyReconfigureComputed,
  GroupTopologyReconfigureRead,
} from './group-topology-reconfigure-contracts.ts';

export interface GroupTopologyReconfigureMutationDependencies {
  readonly groupStateRepository: GroupStateRepository;
  readonly readPlanningAuthority: (
    input: ReadGroupTopologyPlanningAuthorityInput,
  ) => Promise<GroupTopologyPlanningAuthority>;
  readonly isPlatformAdmin: (principalId: string) => boolean;
}

export class GroupTopologyReconfigureMutation {
  private readonly dependencies: GroupTopologyReconfigureMutationDependencies;

  constructor(dependencies: GroupTopologyReconfigureMutationDependencies) {
    this.dependencies = dependencies;
  }

  async read(command: GroupTopologyReconfigureCommand): Promise<GroupTopologyReconfigureRead> {
    const guarded = await this.dependencies.groupStateRepository.readSnapshotWithAuthorityGuard(
      command.groupRef,
    );
    if (!guarded) {
      throw new Error(`Group snapshot not found: ${command.groupRef.groupId}`);
    }
    const authority = await this.dependencies.readPlanningAuthority({
      groupRef: command.groupRef,
      requestOptions: command.requestOptions,
      knownGroup: guarded.snapshot,
      snapshotSelection: 'prefer-current',
    });
    if (
      compareGroupCausalRevision(
        readGroupCausalRevision(authority.group),
        readGroupCausalRevision(guarded.snapshot),
      ) !== 'equal'
    ) {
      throw new RuntimeStateWriteConflictError();
    }
    return { authority, authorityGuard: guarded.authorityGuard };
  }

  compute(
    command: GroupTopologyReconfigureCommand,
    read: GroupTopologyReconfigureRead,
  ): GroupTopologyReconfigureComputed {
    const snapshot = read.authority.group;
    return {
      authorityGuard: read.authorityGuard,
      commandId: command.commandId,
      resourceId: `${command.commandId}:rtc-topology-recompute:explicit`,
      aggregateRef: command.groupRef,
      acceptedCausalRevision: snapshot.causalRevision,
      groupSnapshot: snapshot,
      effectKind: 'rtc-topology-recompute',
      payloadKind: 'group-revision',
      createdAtEpochMs: command.capturedAtEpochMs,
      expireAtEpochMs: 253_402_300_799_999,
      senderId: command.actorPrincipalId,
      requestOptions: toCanonicalGroupTopologyConfigPatch(command.requestOptions),
      publish: command.publish,
    };
  }

  validate(
    command: GroupTopologyReconfigureCommand,
    read: GroupTopologyReconfigureRead,
    computed: GroupTopologyReconfigureComputed,
  ): void {
    const lifecycle = canMutateActiveGroup({
      group: read.authority.group.group,
      nowEpochMs: read.authority.nowEpochMs,
    });
    if (!lifecycle.allowed) {
      throw new GroupPolicyDeniedError(lifecycle);
    }
    this.validateActor(command, read);
    if (!isValidReconfigureComputation(command, read, computed)) {
      throw new TypeError('Topology reconfigure computation is invalid');
    }
  }

  async write(
    transaction: PSqlTransactionSql,
    computed: GroupTopologyReconfigureComputed,
  ): Promise<void> {
    const runtime = new PSqlRuntimeStateRepository(transaction);
    const authority = await new GroupStateRepository(runtime).advanceAuthorityFence(
      computed.authorityGuard,
    );
    if (
      authority.status === 'conflict' ||
      authority.revision !== computed.authorityGuard.entry.revision + 1
    ) {
      throw new RuntimeStateWriteConflictError();
    }
    await writeRtcTopologyOutbox(transaction, computed);
  }

  private validateActor(
    command: GroupTopologyReconfigureCommand,
    read: GroupTopologyReconfigureRead,
  ): void {
    if (this.dependencies.isPlatformAdmin(command.actorPrincipalId)) {
      return;
    }
    const policy = canUpdateGroupSnapshot({
      snapshot: read.authority.group,
      actor: { principalId: command.actorPrincipalId },
      nowEpochMs: read.authority.nowEpochMs,
    });
    if (!policy.allowed) {
      throw new GroupPolicyDeniedError(policy);
    }
  }
}

function isValidReconfigureComputation(
  command: GroupTopologyReconfigureCommand,
  read: GroupTopologyReconfigureRead,
  computed: GroupTopologyReconfigureComputed,
): boolean {
  return (
    computed.commandId === command.commandId &&
    computed.groupSnapshot === read.authority.group &&
    computed.authorityGuard === read.authorityGuard &&
    JSON.stringify(computed.requestOptions) ===
      JSON.stringify(toCanonicalGroupTopologyConfigPatch(command.requestOptions)) &&
    computed.publish === command.publish
  );
}
