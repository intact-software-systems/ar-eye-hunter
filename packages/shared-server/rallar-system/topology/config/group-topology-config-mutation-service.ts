import type { GroupStateRepository } from '../../group-state/persistence/group-state-repository.ts';
import type { RtcTopologyOutboxWriter } from '../mutation/rtc-topology-outbox-writer.ts';
import { resolveOverrideExpiresAtEpochMs } from './group-topology-config.ts';
import type { GroupTopologyServerOptions } from './group-topology-config.ts';
import { computeTopologyConfigMutation } from './mutation/compute-topology-config-mutation.ts';
import type * as mutationContracts from './mutation/group-topology-config-mutation-contracts.ts';
import { readTopologyConfigMutation } from './mutation/read-topology-config-mutation.ts';
import {
    probeTopologyConfigMutationIdempotency,
    validateTopologyConfigMutationIdempotency
} from './mutation/topology-config-mutation-idempotency.ts';
import { validateTopologyConfigMutation } from './mutation/validate-topology-config-mutation.ts';
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
    readonly state: mutationContracts.GroupTopologyConfigMutationRead;
    readonly policyNowEpochMs: number;
    readonly actorIsPlatformAdmin: boolean;
    readonly serverDefaults: GroupTopologyServerOptions;
}

export interface GroupTopologyConfigMutationAttempt {
    readonly commandHash: string;
    readonly capturedAtEpochMs: number;
    readonly count: number;
}

export interface TopologyConfigMutationAttemptValidationInput {
    readonly command: mutationContracts.GroupTopologyConfigMutationCommand;
    readonly read: GroupTopologyConfigMutationAttemptRead;
    readonly attempt: GroupTopologyConfigMutationAttempt;
}

export interface TopologyConfigMutationAttemptValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
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
            actorIsPlatformAdmin: this.dependencies.isPlatformAdmin(
                command.input.updatedByPrincipalId
            ),
            serverDefaults: { ...this.dependencies.serverDefaults }
        };
    }

    recordCommitted(): void {
        this.dependencies.outboxWriter.recordCommitted();
    }
}

export function computeTopologyConfigMutationAttempt(
    command: mutationContracts.GroupTopologyConfigMutationCommand,
    read: GroupTopologyConfigMutationAttemptRead,
    attempt: GroupTopologyConfigMutationAttempt
): mutationContracts.GroupTopologyConfigMutationComputed {
    const idempotency = probeTopologyConfigMutationIdempotency(
        command,
        read.state,
        attempt.commandHash
    );
    if (idempotency.outcome !== 'miss') {
        return idempotency;
    }
    return computeTopologyConfigMutation({
        command,
        read: read.state,
        facts: toTopologyConfigMutationFacts(command, read, attempt),
        serverDefaults: read.serverDefaults
    });
}

export function validateTopologyConfigMutationAttempt(
    input: TopologyConfigMutationAttemptValidationInput,
    computed: mutationContracts.GroupTopologyConfigMutationComputed
): readonly TopologyConfigMutationAttemptValidationIssue[] {
    const { command, read, attempt } = input;
    try {
        if (computed.outcome === 'replay' || computed.outcome === 'idempotency-conflict') {
            validateTopologyConfigMutationIdempotency({
                command,
                read: read.state,
                commandHash: attempt.commandHash,
                authorityFacts: { isPlatformAdmin: read.actorIsPlatformAdmin },
                computed
            });
        }
        else {
            validateTopologyConfigMutation({
                command,
                read: read.state,
                facts: toTopologyConfigMutationFacts(command, read, attempt),
                serverDefaults: read.serverDefaults,
                computed
            });
        }
        return [];
    }
    catch (caught) {
        const cause = caught instanceof Error ? caught : new Error(String(caught));
        return [{ path: 'mutation', message: cause.message, cause }];
    }
}

function toTopologyConfigMutationFacts(
    command: mutationContracts.GroupTopologyConfigMutationCommand,
    read: GroupTopologyConfigMutationAttemptRead,
    attempt: GroupTopologyConfigMutationAttempt
): mutationContracts.GroupTopologyConfigMutationFacts {
    return {
        requestedAtEpochMs: attempt.capturedAtEpochMs,
        commandHash: attempt.commandHash,
        resolvedOverrideExpiresAtEpochMs: command.operation === 'putOverride'
            ? resolveOverrideExpiresAtEpochMs({
                nowEpochMs: attempt.capturedAtEpochMs,
                ttlMs: command.input.ttlMs ?? undefined,
                expiresAtEpochMs: command.input.expiresAtEpochMs ?? undefined
            })
            : null,
        isPlatformAdmin: read.actorIsPlatformAdmin,
        policyNowEpochMs: read.policyNowEpochMs,
        attemptCount: attempt.count
    };
}
