import {
    decodeExactGroupRef,
    decodeTopologyReconfigureInboxResult,
    type TopologyReconfigureInboxResult
} from '@shared/api/admin-rooms/decode-topology-inbox-result.ts';
import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { requireExactKeys } from '@shared/api/exact-object-decoding.ts';
import {
    toAppInboxCommandAttempt,
    type AppInboxCommandAttempt,
    type AppInboxEnqueue,
    type AppInboxMessageContext
} from '../../app-inbox/app-inbox-contracts.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '../../auth/persistence/persisted-auth-session.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type {
    GroupTopologyConfigMutationAttemptRead,
    GroupTopologyConfigMutationService
} from '../config/group-topology-config-mutation-service.ts';
import type {
    GroupTopologyConfigMutationCommand,
    GroupTopologyConfigMutationComputed
} from '../config/mutation/group-topology-config-mutation-contracts.ts';
import { toTopologyConfigMutationResult } from '../config/mutation/to-topology-config-mutation-result.ts';

import { readTopologyConfigReceiptBoundary } from '../config/mutation/topology-config-mutation-boundary.ts';
import {
    decodeStoredGroupTopologyConfig,
    decodeStoredGroupTopologyOverride
} from '../config/persistence/decode-stored-group-topology-config.ts';
import { GroupTopologyConfigIdempotencyConflictError } from '../group-topology-errors.ts';
import type {
    GroupTopologyReconfigureCommand,
    GroupTopologyReconfigureComputed,
    GroupTopologyReconfigureRead
} from '../reconfigure/group-topology-reconfigure-contracts.ts';
import type { GroupTopologyReconfigureMutation } from '../reconfigure/group-topology-reconfigure-mutation.ts';
import {
    createAuthenticatedTopologyEnqueue,
    createAuthenticatedTopologyEnqueueFromValidatedSession,
    decodeTopologyAppInboxAuthority,
    readAndValidateCurrentTopologySession,
    verifyTopologyAppInboxAuthority
} from './topology-app-inbox-authority.ts';
import { toTopologyConfigMutationCommand } from './topology-app-inbox-command.ts';
import type { TopologyReconfigureAppInboxAuthority } from './topology-app-inbox-contracts.ts';

export interface TopologyAppInboxHandlerDependencies {
    readonly groupStateService: Pick<GroupStateService, 'readIssuedAuthSession'>;
    readonly transactionWriter: Pick<
        AppInboxMutationTransactionWriter,
        'readCompletionFacts' | 'writeComputedMutation'
    >;
    readonly nowEpochMs: () => number;
    readonly wakeQueue?: () => void;
}

export interface TopologyAppInboxMutationOwners {
    readonly configMutationService: Pick<
        GroupTopologyConfigMutationService,
        'read' | 'compute' | 'validate' | 'write' | 'recordCommittedWrite'
    >;
    readonly reconfigureMutation: Pick<
        GroupTopologyReconfigureMutation,
        'read' | 'compute' | 'validate' | 'write' | 'recordCommittedWrite'
    >;
}

export type TopologyConfigInboxResult = ReturnType<typeof toTopologyConfigMutationResult>;

export type TopologyAppInboxResult = TopologyConfigInboxResult | TopologyReconfigureInboxResult;

type TopologyConfigOperationComputed =
    | Readonly<{
        outcome: 'idempotency-conflict';
        mutation: Extract<GroupTopologyConfigMutationComputed, { outcome: 'idempotency-conflict'; }>;
    }>
    | Readonly<{
        outcome: 'completed';
        mutation: Exclude<GroupTopologyConfigMutationComputed, { outcome: 'idempotency-conflict'; }>;
        durableResult: TopologyConfigInboxResult;
        completion: AppInboxCompletionComputed<TopologyConfigInboxResult>;
    }>;

interface TopologyReconfigureOperationComputed {
    readonly mutation: GroupTopologyReconfigureComputed;
    readonly durableResult: TopologyReconfigureInboxResult;
    readonly completion: AppInboxCompletionComputed<TopologyReconfigureInboxResult>;
}

interface TopologyOperationValidationIssue {
    readonly cause: Error;
}

export function decodeTopologyAppInboxResult(value: JsonWireValue): TopologyAppInboxResult {
    const result = decodeJsonRecord(value, 'Topology AppInbox result');
    if (result.status === 'queued') {
        return decodeTopologyReconfigureInboxResult(result);
    }

    const receiptRecord = decodeJsonRecord(result.receipt, 'Topology config AppInbox receipt');
    const groupRef = decodeExactGroupRef(receiptRecord.groupRef);
    const receipt = readTopologyConfigReceiptBoundary(receiptRecord, groupRef);
    if (receipt.operation === 'putConfig') {
        requireExactKeys(result, ['receipt', 'config'], 'Topology config AppInbox result');
        return { receipt, config: decodeStoredGroupTopologyConfig(result.config, groupRef) };
    }
    if (receipt.operation === 'putOverride') {
        requireExactKeys(result, ['receipt', 'override'], 'Topology override AppInbox result');
        return { receipt, override: decodeStoredGroupTopologyOverride(result.override, groupRef) };
    }
    requireExactKeys(result, ['receipt'], 'Topology delete AppInbox result');
    return { receipt };
}

function decodeJsonRecord(value: JsonWireValue, label: string): Record<string, JsonWireValue> {
    if (!isJsonRecord(value)) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isJsonRecord(value: JsonWireValue): value is Readonly<Record<string, JsonWireValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export namespace TopologyAppInboxHandler {
    export interface ConfigMutationInput {
        readonly context: AppInboxMessageContext<TopologyAppInboxResult>;
        readonly command: GroupTopologyConfigMutationCommand;
        readonly mutation: TopologyAppInboxMutationOwners['configMutationService'];
        readonly completionFacts: AppInboxCompletionFacts;
    }

    export interface ReconfigureMutationInput {
        readonly context: AppInboxMessageContext<TopologyAppInboxResult>;
        readonly authority: TopologyReconfigureAppInboxAuthority;
        readonly mutation: TopologyAppInboxMutationOwners['reconfigureMutation'];
        readonly completionFacts: AppInboxCompletionFacts;
    }

    export interface ConfigOperationInput {
        readonly command: GroupTopologyConfigMutationCommand;
        readonly read: GroupTopologyConfigMutationAttemptRead;
        readonly attempt: AppInboxCommandAttempt;
        readonly completionFacts: AppInboxCompletionFacts;
        readonly mutation: TopologyAppInboxMutationOwners['configMutationService'];
    }

    export interface ReconfigureOperationInput {
        readonly command: GroupTopologyReconfigureCommand;
        readonly read: GroupTopologyReconfigureRead;
        readonly completionFacts: AppInboxCompletionFacts;
        readonly mutation: TopologyAppInboxMutationOwners['reconfigureMutation'];
    }
}

export class TopologyAppInboxHandler {
    private readonly dependencies: TopologyAppInboxHandlerDependencies;

    constructor(dependencies: TopologyAppInboxHandlerDependencies) {
        this.dependencies = dependencies;
    }

    async createAuthenticatedEnqueue(
        enqueue: AppInboxEnqueue,
        authority: IssuedAuthSession
    ): Promise<AppInboxEnqueue> {
        return await createAuthenticatedTopologyEnqueue({
            enqueue,
            claimedAuthority: authority,
            groupStateService: this.dependencies.groupStateService,
            nowEpochMs: this.dependencies.nowEpochMs
        });
    }

    async readAndValidateCurrentSession(
        principalId: string,
        claimedAuthority: IssuedAuthSession
    ): Promise<PersistedAuthSession> {
        return await readAndValidateCurrentTopologySession({
            principalId,
            claimedAuthority,
            groupStateService: this.dependencies.groupStateService,
            nowEpochMs: this.dependencies.nowEpochMs
        });
    }

    async createAuthenticatedEnqueueFromValidatedSession(
        enqueue: AppInboxEnqueue,
        currentSession: PersistedAuthSession
    ): Promise<AppInboxEnqueue> {
        return await createAuthenticatedTopologyEnqueueFromValidatedSession({
            enqueue,
            currentSession
        });
    }

    async processMutation(
        context: AppInboxMessageContext<TopologyAppInboxResult>,
        owners: TopologyAppInboxMutationOwners
    ): Promise<TopologyAppInboxResult> {
        const authority = decodeTopologyAppInboxAuthority(context.enqueue.authority);
        await verifyTopologyAppInboxAuthority({
            authority,
            groupStateService: this.dependencies.groupStateService,
            nowEpochMs: this.dependencies.nowEpochMs
        });
        const completionFacts = this.dependencies.transactionWriter.readCompletionFacts(context);
        if (authority.kind === 'topology-reconfigure') {
            return await this.processTopologyReconfigureMutation({
                context,
                authority,
                mutation: owners.reconfigureMutation,
                completionFacts
            });
        }
        return await this.processTopologyConfigMutation({
            context,
            command: toTopologyConfigMutationCommand(authority.command),
            mutation: owners.configMutationService,
            completionFacts
        });
    }

    private async processTopologyConfigMutation(
        { context, command, mutation, completionFacts }: TopologyAppInboxHandler.ConfigMutationInput
    ): Promise<TopologyAppInboxResult> {
        const read = await mutation.read(command);
        const attempt = toAppInboxCommandAttempt(context);
        const operation = { command, read, attempt, completionFacts, mutation };
        const computed = this.computeTopologyConfigOperation(operation);
        const validationIssues = this.validateTopologyConfigOperation(operation, computed);
        if (validationIssues[0] !== undefined) {
            throw validationIssues[0].cause;
        }
        if (computed.outcome === 'idempotency-conflict') {
            throw new GroupTopologyConfigIdempotencyConflictError(
                computed.mutation.existingCommandHash,
                computed.mutation.receivedCommandHash
            );
        }
        const result = await this.dependencies.transactionWriter.writeComputedMutation(
            context,
            computed.completion,
            async (transaction) => {
                if (
                    computed.mutation.outcome === 'write' ||
                    computed.mutation.outcome === 'claim'
                ) {
                    await mutation.write(transaction, computed.mutation);
                }
            }
        );
        if (computed.mutation.outcome === 'write') {
            mutation.recordCommittedWrite();
            this.dependencies.wakeQueue?.();
        }
        return result;
    }

    private async processTopologyReconfigureMutation(
        { context, authority, mutation, completionFacts }: TopologyAppInboxHandler.ReconfigureMutationInput
    ): Promise<TopologyReconfigureInboxResult> {
        if (authority.command.payload.operation !== 'reconfigureTopology') {
            throw new TypeError('Topology reconfigure authority operation is invalid');
        }
        const command: GroupTopologyReconfigureCommand = {
            groupRef: authority.command.groupRef,
            commandId: authority.command.requestId,
            actorPrincipalId: authority.command.actor.principalId,
            capturedAtEpochMs: authority.command.capturedAtEpochMs,
            requestOptions: fromCanonicalGroupTopologyConfigPatch(
                authority.command.payload.requestOptions
            ),
            publish: authority.command.payload.publish
        };
        const read = await mutation.read(command, toAppInboxCommandAttempt(context));
        const operation = { command, read, completionFacts, mutation };
        const computed = this.computeTopologyReconfigureOperation(operation);
        const validationIssues = this.validateTopologyReconfigureOperation(operation, computed);
        if (validationIssues[0] !== undefined) {
            throw validationIssues[0].cause;
        }
        const result = await this.dependencies.transactionWriter.writeComputedMutation(
            context,
            computed.completion,
            async (transaction) => {
                await mutation.write(transaction, computed.mutation);
            }
        );
        mutation.recordCommittedWrite();
        this.dependencies.wakeQueue?.();
        return result;
    }

    private computeTopologyConfigOperation(
        { command, read, attempt, completionFacts, mutation }: TopologyAppInboxHandler.ConfigOperationInput
    ): TopologyConfigOperationComputed {
        const mutationComputed = mutation.compute(command, read, attempt);
        if (mutationComputed.outcome === 'idempotency-conflict') {
            return { outcome: 'idempotency-conflict', mutation: mutationComputed };
        }
        const durableResult = toTopologyConfigMutationResult(mutationComputed);
        const completionInput = {
            ...completionFacts,
            durableResult,
            status: EntityStatus.COMPLETED
        } as const;
        return {
            outcome: 'completed',
            mutation: mutationComputed,
            durableResult,
            completion: computeAppInboxCompletion(completionInput)
        };
    }

    private validateTopologyConfigOperation(
        { command, read, attempt, completionFacts, mutation }: TopologyAppInboxHandler.ConfigOperationInput,
        computed: TopologyConfigOperationComputed
    ): readonly TopologyOperationValidationIssue[] {
        const validation = {
            command,
            read,
            attempt,
            computed: computed.mutation
        };
        const mutationIssues = mutation.validate(validation);
        if (mutationIssues[0] !== undefined) {
            return mutationIssues;
        }
        if (computed.outcome === 'idempotency-conflict') {
            return [];
        }
        const issues: TopologyOperationValidationIssue[] = [];
        if (
            !jsonEquals(
                computed.durableResult,
                toTopologyConfigMutationResult(computed.mutation)
            )
        ) {
            issues.push({
                cause: new TypeError('Topology config result differs from its computed mutation')
            });
        }
        const completionInput = {
            ...completionFacts,
            durableResult: computed.durableResult,
            status: EntityStatus.COMPLETED
        } as const;
        return [
            ...issues,
            ...validateAppInboxCompletion(completionInput, computed.completion)
        ];
    }

    private computeTopologyReconfigureOperation(
        { command, read, completionFacts, mutation }: TopologyAppInboxHandler.ReconfigureOperationInput
    ): TopologyReconfigureOperationComputed {
        const mutationComputed = mutation.compute(command, read);
        const durableResult = {
            status: 'queued',
            groupRef: command.groupRef,
            requestId: command.commandId,
            outboxId: mutationComputed.resourceId
        } as const;
        const completionInput = {
            ...completionFacts,
            durableResult,
            status: EntityStatus.COMPLETED
        } as const;
        return {
            mutation: mutationComputed,
            durableResult,
            completion: computeAppInboxCompletion(completionInput)
        };
    }

    private validateTopologyReconfigureOperation(
        { command, read, completionFacts, mutation }: TopologyAppInboxHandler.ReconfigureOperationInput,
        computed: TopologyReconfigureOperationComputed
    ): readonly TopologyOperationValidationIssue[] {
        const mutationIssues = mutation.validate(command, read, computed.mutation);
        if (mutationIssues[0] !== undefined) {
            return mutationIssues;
        }
        const issues: TopologyOperationValidationIssue[] = [];
        const expectedResult = {
            status: 'queued',
            groupRef: command.groupRef,
            requestId: command.commandId,
            outboxId: computed.mutation.resourceId
        } as const;
        if (!jsonEquals(computed.durableResult, expectedResult)) {
            issues.push({
                cause: new TypeError('Topology reconfigure result differs from its computed mutation')
            });
        }
        const completionInput = {
            ...completionFacts,
            durableResult: computed.durableResult,
            status: EntityStatus.COMPLETED
        } as const;
        return [
            ...issues,
            ...validateAppInboxCompletion(completionInput, computed.completion)
        ];
    }
}
