import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';

import { type AppInboxEnqueueInput, type AppInboxMessageContext } from '../../app-inbox/app-inbox-contracts.ts';
import type { AppInboxMutationTransactionWriter } from '../../app-inbox/handler/app-inbox-transaction-writer.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { PersistedAuthSession } from '../../auth/persistence/persisted-auth-session.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import { requireExactKeys, requireString } from '../../protocol/exact-object-decoding.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { GroupTopologyConfigMutationService } from '../config/group-topology-config-mutation-service.ts';
import { toTopologyConfigMutationResult } from '../config/mutation/to-topology-config-mutation-result.ts';

import { readTopologyConfigReceiptBoundary } from '../config/mutation/topology-config-mutation-boundary.ts';
import {
    decodeStoredGroupTopologyConfig,
    decodeStoredGroupTopologyOverride
} from '../config/persistence/decode-stored-group-topology-config.ts';
import { GroupTopologyConfigIdempotencyConflictError } from '../group-topology-errors.ts';
import type { GroupTopologyReconfigureCommand } from '../reconfigure/group-topology-reconfigure-contracts.ts';
import type { GroupTopologyReconfigureMutation } from '../reconfigure/group-topology-reconfigure-mutation.ts';
import {
    createAuthenticatedTopologyEnqueue,
    createAuthenticatedTopologyEnqueueFromValidatedSession,
    decodeTopologyAppInboxAuthority,
    validateCurrentTopologySession,
    verifyTopologyAppInboxAuthority
} from './topology-app-inbox-authority.ts';
import { toTopologyConfigMutationCommand } from './topology-app-inbox-command.ts';
import type { TopologyReconfigureAppInboxAuthority } from './topology-app-inbox-contracts.ts';

export interface TopologyAppInboxHandlerDependencies {
    readonly groupStateService: Pick<GroupStateService, 'readIssuedAuthSession'>;
    readonly transactionWriter: Pick<AppInboxMutationTransactionWriter, 'writeMutation'>;
    readonly nowEpochMs: () => number;
    readonly wakeQueue?: () => void;
}

export interface TopologyAppInboxMutationOwners {
    readonly configMutationService: Pick<GroupTopologyConfigMutationService, 'read' | 'compute' | 'validate' | 'write'>;
    readonly reconfigureMutation: Pick<GroupTopologyReconfigureMutation, 'read' | 'compute' | 'validate' | 'write'>;
}

export type TopologyConfigInboxResult = ReturnType<typeof toTopologyConfigMutationResult>;

export interface TopologyReconfigureInboxResult {
    readonly status: 'queued';
    readonly groupRef: GroupTopologyReconfigureCommand['groupRef'];
    readonly requestId: string;
    readonly outboxId: string;
}

export type TopologyAppInboxResult = TopologyConfigInboxResult | TopologyReconfigureInboxResult;

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

    async validateCurrentSession(
        principalId: string,
        claimedAuthority: IssuedAuthSession
    ): Promise<PersistedAuthSession> {
        return await validateCurrentTopologySession({
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
        if (authority.kind === 'topology-reconfigure') {
            return await this.processTopologyReconfigureMutation(
                context,
                authority,
                owners.reconfigureMutation
            );
        }
        const command = toTopologyConfigMutationCommand(authority.command);
        const read = await owners.configMutationService.read(command);
        const attemptCount = context.entry.dequeueAudit.attempts;
        const computed = owners.configMutationService.compute(command, read, attemptCount);
        owners.configMutationService.validate({ command, read, attemptCount, computed });
        if (computed.outcome === 'idempotency-conflict') {
            throw new GroupTopologyConfigIdempotencyConflictError(
                computed.existingCommandHash,
                computed.receivedCommandHash
            );
        }
        const result = await this.dependencies.transactionWriter.writeMutation(
            context,
            async (transaction) => {
                if (computed.outcome === 'write' || computed.outcome === 'claim') {
                    await owners.configMutationService.write(transaction, computed);
                }
                return toTopologyConfigMutationResult(computed);
            }
        );
        if (computed.outcome === 'write') {
            this.dependencies.wakeQueue?.();
        }
        return result;
    }

    private async processTopologyReconfigureMutation(
        context: AppInboxMessageContext<TopologyAppInboxResult>,
        authority: TopologyReconfigureAppInboxAuthority,
        mutation: TopologyAppInboxMutationOwners['reconfigureMutation']
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
        const computed = mutation.compute(command, read);
        mutation.validate(command, read, computed);
        const result = await this.dependencies.transactionWriter.writeMutation(
            context,
            async (transaction) => {
                await mutation.write(transaction, computed);
                return {
                    status: 'queued',
                    groupRef: command.groupRef,
                    requestId: command.commandId,
                    outboxId: computed.resourceId
                } as const;
            }
        );
        this.dependencies.wakeQueue?.();
        return result;
    }
}
