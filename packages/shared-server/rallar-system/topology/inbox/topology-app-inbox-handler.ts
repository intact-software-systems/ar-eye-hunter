import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { type AppInboxEnqueueInput, type AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
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
import { requireExactKeys, requireString } from '../../protocol/exact-object-decoding.ts';
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

export interface TopologyReconfigureInboxResult {
    readonly status: 'queued';
    readonly groupRef: GroupTopologyReconfigureCommand['groupRef'];
    readonly requestId: string;
    readonly outboxId: string;
}

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

export function decodeTopologyAppInboxResult(value: JsonWireValue): TopologyAppInboxResult {
    const result = readJsonRecord(value, 'Topology AppInbox result');
    if (result.status === 'queued') {
        return decodeTopologyReconfigureInboxResult(result);
    }

    const receiptRecord = readJsonRecord(result.receipt, 'Topology config AppInbox receipt');
    const groupRef = readExactGroupRef(receiptRecord.groupRef);
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

export function decodeTopologyReconfigureInboxResult(
    value: JsonWireValue
): TopologyReconfigureInboxResult {
    const result = readJsonRecord(value, 'Topology reconfigure AppInbox result');
    requireExactKeys(
        result,
        ['status', 'groupRef', 'requestId', 'outboxId'],
        'Topology reconfigure AppInbox result'
    );
    if (result.status !== 'queued') {
        throw new TypeError('Topology reconfigure status is invalid');
    }
    const groupRef = readExactGroupRef(result.groupRef);
    requireString(result.requestId, 'Topology reconfigure requestId');
    requireString(result.outboxId, 'Topology reconfigure outboxId');
    return { status: 'queued', groupRef, requestId: result.requestId, outboxId: result.outboxId };
}

function readExactGroupRef(value: JsonWireValue): TopologyReconfigureInboxResult['groupRef'] {
    const groupRef = readJsonRecord(value, 'Topology AppInbox groupRef');
    requireExactKeys(
        groupRef,
        ['applicationId', 'workspaceId', 'groupId'],
        'Topology AppInbox groupRef'
    );
    requireString(groupRef.applicationId, 'Topology AppInbox applicationId');
    requireString(groupRef.workspaceId, 'Topology AppInbox workspaceId');
    requireString(groupRef.groupId, 'Topology AppInbox groupId');
    return {
        applicationId: groupRef.applicationId,
        workspaceId: groupRef.workspaceId,
        groupId: groupRef.groupId
    };
}

function readJsonRecord(value: JsonWireValue, label: string): Record<string, JsonWireValue> {
    if (!isJsonRecord(value)) {
        throw new TypeError(`${label} must be an exact object`);
    }
    return value;
}

function isJsonRecord(value: JsonWireValue): value is Readonly<Record<string, JsonWireValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class TopologyAppInboxHandler {
    private readonly dependencies: TopologyAppInboxHandlerDependencies;

    constructor(dependencies: TopologyAppInboxHandlerDependencies) {
        this.dependencies = dependencies;
    }

    async createAuthenticatedEnqueue(
        enqueue: AppInboxEnqueueInput,
        authority: IssuedAuthSession
    ): Promise<AppInboxEnqueueInput> {
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
        enqueue: AppInboxEnqueueInput,
        currentSession: PersistedAuthSession
    ): Promise<AppInboxEnqueueInput> {
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
            return await this.processTopologyReconfigureMutation(
                context,
                authority,
                owners.reconfigureMutation,
                completionFacts
            );
        }
        const command = toTopologyConfigMutationCommand(authority.command);
        const read = await owners.configMutationService.read(command);
        const attemptCount = context.entry.dequeueAudit.attempts;
        const computed = this.computeTopologyConfigOperation(
            command,
            read,
            attemptCount,
            completionFacts,
            owners.configMutationService
        );
        this.validateTopologyConfigOperation(
            command,
            read,
            attemptCount,
            completionFacts,
            owners.configMutationService,
            computed
        );
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
                    await owners.configMutationService.write(transaction, computed.mutation);
                }
            }
        );
        if (computed.mutation.outcome === 'write') {
            owners.configMutationService.recordCommittedWrite();
            this.dependencies.wakeQueue?.();
        }
        return result;
    }

    private async processTopologyReconfigureMutation(
        context: AppInboxMessageContext<TopologyAppInboxResult>,
        authority: TopologyReconfigureAppInboxAuthority,
        mutation: TopologyAppInboxMutationOwners['reconfigureMutation'],
        completionFacts: AppInboxCompletionFacts
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
        const read = await mutation.read(command);
        const computed = this.computeTopologyReconfigureOperation(
            command,
            read,
            completionFacts,
            mutation
        );
        this.validateTopologyReconfigureOperation(
            command,
            read,
            completionFacts,
            mutation,
            computed
        );
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
        command: GroupTopologyConfigMutationCommand,
        read: GroupTopologyConfigMutationAttemptRead,
        attemptCount: number,
        completionFacts: AppInboxCompletionFacts,
        mutation: TopologyAppInboxMutationOwners['configMutationService']
    ): TopologyConfigOperationComputed {
        const mutationComputed = mutation.compute(command, read, attemptCount);
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
        command: GroupTopologyConfigMutationCommand,
        read: GroupTopologyConfigMutationAttemptRead,
        attemptCount: number,
        completionFacts: AppInboxCompletionFacts,
        mutation: TopologyAppInboxMutationOwners['configMutationService'],
        computed: TopologyConfigOperationComputed
    ): void {
        mutation.validate({
            command,
            read,
            attemptCount,
            computed: computed.mutation
        });
        if (computed.outcome === 'idempotency-conflict') {
            return;
        }
        if (
            !jsonEquals(
                computed.durableResult,
                toTopologyConfigMutationResult(computed.mutation)
            )
        ) {
            throw new TypeError('Topology config result differs from its computed mutation');
        }
        const completionInput = {
            ...completionFacts,
            durableResult: computed.durableResult,
            status: EntityStatus.COMPLETED
        } as const;
        const issues = validateAppInboxCompletion(completionInput, computed.completion);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
    }

    private computeTopologyReconfigureOperation(
        command: GroupTopologyReconfigureCommand,
        read: GroupTopologyReconfigureRead,
        completionFacts: AppInboxCompletionFacts,
        mutation: TopologyAppInboxMutationOwners['reconfigureMutation']
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
        command: GroupTopologyReconfigureCommand,
        read: GroupTopologyReconfigureRead,
        completionFacts: AppInboxCompletionFacts,
        mutation: TopologyAppInboxMutationOwners['reconfigureMutation'],
        computed: TopologyReconfigureOperationComputed
    ): void {
        mutation.validate(command, read, computed.mutation);
        const expectedResult = {
            status: 'queued',
            groupRef: command.groupRef,
            requestId: command.commandId,
            outboxId: computed.mutation.resourceId
        } as const;
        if (!jsonEquals(computed.durableResult, expectedResult)) {
            throw new TypeError('Topology reconfigure result differs from its computed mutation');
        }
        const completionInput = {
            ...completionFacts,
            durableResult: computed.durableResult,
            status: EntityStatus.COMPLETED
        } as const;
        const issues = validateAppInboxCompletion(completionInput, computed.completion);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
    }
}
