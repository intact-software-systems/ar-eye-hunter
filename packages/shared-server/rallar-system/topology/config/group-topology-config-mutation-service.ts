import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import type { GroupStateRepository } from '../../group-state/persistence/group-state-repository.ts';
import type { RtcTopologyOutboxWriter } from '../mutation/rtc-topology-outbox-writer.ts';
import {
    computeOverrideExpiresAtEpochMs,
    type GroupTopologyServerOptions
} from './group-topology-config.ts';
import { computeTopologyConfigMutation } from './mutation/compute-topology-config-mutation.ts';
import type * as mutationContracts from './mutation/group-topology-config-mutation-contracts.ts';
import { readTopologyConfigMutation } from './mutation/read-topology-config-mutation.ts';
import {
    probeTopologyConfigMutationIdempotency,
    validateTopologyConfigMutationIdempotency
} from './mutation/topology-config-mutation-idempotency.ts';
import { validateTopologyConfigMutation } from './mutation/validate-topology-config-mutation.ts';
import { writeTopologyConfigMutation } from './mutation/write-topology-config-mutation.ts';
import type { GroupTopologyConfigRepository } from './persistence/group-topology-config-repository.ts';

export interface GroupTopologyConfigMutationServiceDependencies {
    readonly configRepository: GroupTopologyConfigRepository;
    readonly groupStateRepository: GroupStateRepository;
    readonly serverDefaults?: GroupTopologyServerOptions;
    readonly nowEpochMs: () => number;
    readonly isPlatformAdmin: (principalId: string) => boolean;
    readonly outboxWriter: RtcTopologyOutboxWriter;
}

export interface GroupTopologyConfigMutationAttemptRead {
    readonly state: Awaited<ReturnType<typeof readTopologyConfigMutation>>;
    readonly policyNowEpochMs: number;
    readonly isPlatformAdmin: boolean;
    readonly serverDefaults: GroupTopologyServerOptions;
}

export interface GroupTopologyConfigMutationValidation {
    readonly command: mutationContracts.GroupTopologyConfigMutationCommand;
    readonly read: GroupTopologyConfigMutationAttemptRead;
    readonly attemptCount: number;
    readonly computed: mutationContracts.GroupTopologyConfigMutationComputed;
}

export class GroupTopologyConfigMutationService {
    private readonly dependencies: GroupTopologyConfigMutationServiceDependencies;

    constructor(dependencies: GroupTopologyConfigMutationServiceDependencies) {
        this.dependencies = dependencies;
    }

    async read(
        command: mutationContracts.GroupTopologyConfigMutationCommand
    ): Promise<GroupTopologyConfigMutationAttemptRead> {
        return {
            state: await readTopologyConfigMutation(
                this.dependencies.configRepository,
                this.dependencies.groupStateRepository,
                command
            ),
            policyNowEpochMs: this.dependencies.nowEpochMs(),
            isPlatformAdmin: this.dependencies.isPlatformAdmin(
                command.input.updatedByPrincipalId
            ),
            serverDefaults: { ...(this.dependencies.serverDefaults ?? {}) }
        };
    }

    compute(
        command: mutationContracts.GroupTopologyConfigMutationCommand,
        read: GroupTopologyConfigMutationAttemptRead,
        attemptCount: number
    ): mutationContracts.GroupTopologyConfigMutationComputed {
        const idempotency = probeTopologyConfigMutationIdempotency(
            command,
            read.state,
            command.commandHash
        );
        if (idempotency.outcome !== 'miss') {
            return idempotency;
        }
        return computeTopologyConfigMutation({
            command,
            read: read.state,
            facts: toTopologyConfigMutationFacts(command, read, attemptCount),
            serverDefaults: read.serverDefaults
        });
    }

    validate(validation: GroupTopologyConfigMutationValidation): void {
        const { command, read, attemptCount, computed } = validation;
        if (computed.outcome === 'replay' || computed.outcome === 'idempotency-conflict') {
            validateTopologyConfigMutationIdempotency({
                command,
                read: read.state,
                commandHash: command.commandHash,
                authorityFacts: {
                    isPlatformAdmin: read.isPlatformAdmin,
                    policyNowEpochMs: read.policyNowEpochMs
                },
                computed
            });
            return;
        }
        validateTopologyConfigMutation({
            command,
            read: read.state,
            facts: toTopologyConfigMutationFacts(command, read, attemptCount),
            serverDefaults: read.serverDefaults,
            computed
        });
    }

    async write(
        transaction: PSqlSql,
        computed: Extract<mutationContracts.GroupTopologyConfigMutationComputed, { outcome: 'write' | 'claim'; }>
    ): Promise<GroupTopologyConfigMutationReceipt> {
        return await writeTopologyConfigMutation({
            transaction,
            computed,
            outboxWriter: this.dependencies.outboxWriter
        });
    }

    recordCommittedWrite(): void {
        this.dependencies.outboxWriter.recordCommittedWrites(1);
    }
}

function toTopologyConfigMutationFacts(
    command: mutationContracts.GroupTopologyConfigMutationCommand,
    read: GroupTopologyConfigMutationAttemptRead,
    attemptCount: number
): mutationContracts.GroupTopologyConfigMutationFacts {
    return {
        resolvedOverrideExpiresAtEpochMs: command.operation === 'putOverride'
            ? computeOverrideExpiresAtEpochMs({
                nowEpochMs: command.capturedAtEpochMs,
                ttlMs: command.input.ttlMs ?? undefined,
                expiresAtEpochMs: command.input.expiresAtEpochMs ?? undefined
            })
            : null,
        isPlatformAdmin: read.isPlatformAdmin,
        policyNowEpochMs: read.policyNowEpochMs,
        attemptCount
    };
}
