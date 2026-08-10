import { resolveOverrideExpiresAtEpochMs } from './group-topology-config.ts';
import type { GroupTopologyServerOptions } from './group-topology-config.ts';
import { computeTopologyConfigMutation } from './mutation/compute-topology-config-mutation.ts';
import type * as mutationContracts from './mutation/group-topology-config-mutation-contracts.ts';
import { readTopologyConfigMutation } from './mutation/read-topology-config-mutation.ts';
import {
  probeTopologyConfigMutationIdempotency,
  validateTopologyConfigMutationIdempotency,
} from './mutation/topology-config-mutation-idempotency.ts';
import { validateTopologyConfigMutation } from './mutation/validate-topology-config-mutation.ts';
// prettier-ignore
import type {
  GroupTopologyConfigGenerationReadiness,
} from './maintenance/group-topology-config-generation-readiness.ts';
// prettier-ignore
import type {
  GroupTopologyConfigRepository,
} from './persistence/group-topology-config-repository.ts';
import type { GroupStateRepository } from '../../group-state/persistence/group-state-repository.ts';

export interface GroupTopologyConfigMutationServiceDependencies {
  readonly readiness: Pick<GroupTopologyConfigGenerationReadiness, 'ensure'>;
  readonly configRepository?: GroupTopologyConfigRepository;
  readonly groupStateRepository?: GroupStateRepository;
  readonly serverDefaults?: GroupTopologyServerOptions;
  readonly nowEpochMs: () => number;
  readonly isPlatformAdmin: (principalId: string) => boolean;
}

export interface GroupTopologyConfigMutationPreparation {
  readonly command: mutationContracts.GroupTopologyConfigMutationCommand;
  readonly stableFacts: mutationContracts.GroupTopologyConfigMutationStableFacts;
}

export interface GroupTopologyConfigMutationAttemptRead {
  readonly state: Awaited<ReturnType<typeof readTopologyConfigMutation>>;
  readonly policyNowEpochMs: number;
}

export class GroupTopologyConfigMutationService {
  private readonly dependencies: GroupTopologyConfigMutationServiceDependencies;

  constructor(dependencies: GroupTopologyConfigMutationServiceDependencies) {
    this.dependencies = dependencies;
  }

  async prepare(input: {
    readonly command: mutationContracts.GroupTopologyConfigMutationCommand;
    readonly commandHash: string;
    readonly capturedAtEpochMs: number;
  }): Promise<GroupTopologyConfigMutationPreparation> {
    return {
      command: input.command,
      stableFacts: {
        requestedAtEpochMs: input.capturedAtEpochMs,
        commandHash: input.commandHash,
        resolvedOverrideExpiresAtEpochMs:
          input.command.operation === 'putOverride'
            ? resolveOverrideExpiresAtEpochMs({
                nowEpochMs: input.capturedAtEpochMs,
                ttlMs: input.command.input.ttlMs ?? undefined,
                expiresAtEpochMs: input.command.input.expiresAtEpochMs ?? undefined,
              })
            : null,
      },
    };
  }

  async read(
    command: mutationContracts.GroupTopologyConfigMutationCommand,
  ): Promise<GroupTopologyConfigMutationAttemptRead> {
    await this.dependencies.readiness.ensure(command.aggregateRef);
    return {
      state: await readTopologyConfigMutation(
        this.requireConfigRepository(),
        this.requireGroupStateRepository(),
        command,
      ),
      policyNowEpochMs: this.dependencies.nowEpochMs(),
    };
  }

  compute(
    preparation: GroupTopologyConfigMutationPreparation,
    read: GroupTopologyConfigMutationAttemptRead,
    attemptCount: number,
  ): mutationContracts.GroupTopologyConfigMutationComputed {
    const idempotency = probeTopologyConfigMutationIdempotency(
      preparation.command,
      read.state,
      preparation.stableFacts.commandHash,
    );
    if (idempotency.outcome !== 'miss') {
      return idempotency;
    }
    return computeTopologyConfigMutation({
      command: preparation.command,
      read: read.state,
      facts: this.toFacts(preparation, read, attemptCount),
      serverDefaults: this.dependencies.serverDefaults ?? {},
    });
  }

  validate(
    preparation: GroupTopologyConfigMutationPreparation,
    read: GroupTopologyConfigMutationAttemptRead,
    attemptCount: number,
    computed: mutationContracts.GroupTopologyConfigMutationComputed,
  ): void {
    if (computed.outcome === 'replay' || computed.outcome === 'idempotency-conflict') {
      validateTopologyConfigMutationIdempotency({
        command: preparation.command,
        read: read.state,
        commandHash: preparation.stableFacts.commandHash,
        authorityFacts: {
          isPlatformAdmin: this.dependencies.isPlatformAdmin(
            preparation.command.input.updatedByPrincipalId,
          ),
        },
        computed,
      });
      return;
    }
    validateTopologyConfigMutation({
      command: preparation.command,
      read: read.state,
      facts: this.toFacts(preparation, read, attemptCount),
      serverDefaults: this.dependencies.serverDefaults ?? {},
      computed,
    });
  }

  private toFacts(
    preparation: GroupTopologyConfigMutationPreparation,
    read: GroupTopologyConfigMutationAttemptRead,
    attemptCount: number,
  ): mutationContracts.GroupTopologyConfigMutationFacts {
    return {
      ...preparation.stableFacts,
      isPlatformAdmin: this.dependencies.isPlatformAdmin(
        preparation.command.input.updatedByPrincipalId,
      ),
      policyNowEpochMs: read.policyNowEpochMs,
      attemptCount,
    };
  }

  private requireConfigRepository(): GroupTopologyConfigRepository {
    if (!this.dependencies.configRepository) {
      throw new Error('Group topology config repository is not configured');
    }
    return this.dependencies.configRepository;
  }

  private requireGroupStateRepository(): GroupStateRepository {
    if (!this.dependencies.groupStateRepository) {
      throw new TypeError('Topology config mutations require a production group-state repository');
    }
    return this.dependencies.groupStateRepository;
  }
}
