import type { GroupRef } from '@shared/api/group-types.ts';

import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { PSqlRuntimeStateRepository } from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';

import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';

import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import {
    validateClientMutationIdempotencyRecord,
    type ClientMutationIdempotencyRecord
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/\
group-topology-config-repository.ts';

import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import { readTopologyConfigMutationRecordBoundary } from '@shared-server/rallar-system/topology/config/mutation/\
topology-config-mutation-boundary.ts';
import type { Sql } from 'postgres';

import { toPSqlSql } from '../../apps/api-v1/src/db/to-p-sql-sql.ts';
import { parsePersistedResult, readAppInboxCommandType } from './api-v1-state-write-attempt-evidence.ts';
import {
    readScopedGroupCommandIdsByRequestId,
    readValidatedGroupReceiptIdentity,
    type ScopedGroupCommandExpectation
} from './api-v1-state-write-group-receipt-evidence.ts';
import {
    computeProductionOutboxEvidence,
    computeProductionOutboxExpectations,
    createProductionOutboxRepository,
    productionCommandIdsForRaw,
    readAllCommandIds,
    readReferencedProductionOutboxRecords,
    type StateWriteResourceOutboxEvidence
} from './api-v1-state-write-outbox-evidence.ts';
import {
    projectClientReceiptEvidence,
    projectGroupReceiptEvidence,
    projectTopologyReceiptEvidence,
    type ProductionReceiptEvidence
} from './api-v1-state-write-receipt-evidence.ts';
import { mapWithConcurrency } from './map-with-concurrency.ts';

export interface StateWriteBenchmarkCommand {
    readonly commandId: string;
    readonly kind:
        | 'profile-instance'
        | 'membership'
        | 'presence-connect'
        | 'presence-heartbeat'
        | 'presence-disconnect'
        | 'config'
        | 'topology-source';
    readonly latencyMs: number;
    readonly stackIndex: number;
    readonly status: 'accepted' | 'exhausted';
}

export interface StateWriteDurableEvidence {
    readonly appInbox: readonly AppInboxAttemptEvidence[];
    readonly receipts: readonly ProductionReceiptEvidence[];
    readonly resourceOutbox: readonly StateWriteResourceOutboxEvidence[];
    readonly intermediateMutationIntents: readonly [];
    readonly atomicCompletionFailures: number;
}

interface AppInboxAttemptEvidence {
    readonly commandId: string;
    readonly operationId: string;
    readonly resourceId: string;
    readonly topicId: string;
    readonly status: string;
    readonly resultStatus: string;
    readonly attempts: number;
    readonly retryDelayMs: number;
    readonly dueAgeMs: number;
    readonly selectedLane: 'fast' | 'fairness' | 'timeout';
    readonly transactionDurationMs: number;
    readonly commandType: string;
    readonly durableResult: ReturnType<typeof parsePersistedResult>;
}

export interface QueryStateWriteDurableEvidenceInput {
    readonly sql: Sql;
    readonly scope: StateScope;
    readonly commands: readonly StateWriteBenchmarkCommand[];
    readonly groupCount: number;
    readonly timingEvents: readonly RallarTimingEvent[];
}

export async function queryStateWriteDurableEvidence({
    sql,
    scope,
    commands,
    groupCount,
    timingEvents
}: QueryStateWriteDurableEvidenceInput): Promise<StateWriteDurableEvidence> {
    const runtime = new PSqlRuntimeStateRepository(toPSqlSql(sql));
    const clients = new ClientStateRepository(runtime);
    const groups = new GroupStateRepository(runtime);
    const topology = new GroupTopologyConfigRepository(runtime);
    const outbox = createProductionOutboxRepository(sql);
    const acceptedCommands = commands.filter((command) => command.status === 'accepted');
    const scopedGroupCommandIds = await readScopedGroupCommandIdsByRequestId({
        sql,
        expectations: createScopedGroupCommandExpectations(acceptedCommands, scope, groupCount)
    });
    const receiptResults = await mapWithConcurrency(
        acceptedCommands,
        25,
        async (command): Promise<ProductionReceiptEvidence | undefined> => {
            const clientIndex = readBenchmarkClientIndex(command.commandId);
            const productionCommandIds = productionCommandIdsForRaw(command);

            if (command.kind === 'profile-instance') {
                const receipts = await Promise.all(
                    productionCommandIds.map(
                        async (requestId) =>
                            await clients.findIdempotentClientMutationReceipt(
                                { ...scope, principalId: `client-${clientIndex}` },
                                requestId
                            )
                    )
                );
                if (
                    !receipts.every((receipt, index) => isValidProductionReceipt(receipt, productionCommandIds[index]!))
                ) {
                    return undefined;
                }
                return projectClientReceiptEvidence(command.commandId, receipts);
            }
            if (command.kind === 'topology-source') {
                const groupRef = { ...scope, groupId: `group-${clientIndex % groupCount}` };
                const receipt = readValidatedTopologyMutationReceipt(
                    await topology.findMutationRecord(groupRef, command.commandId),
                    groupRef,
                    command.commandId
                );
                return receipt ? projectTopologyReceiptEvidence(command.commandId, receipt) : undefined;
            }
            const groupRef = { ...scope, groupId: `group-${clientIndex % groupCount}` };
            const scopedCommandId = scopedGroupCommandIds.get(command.commandId);
            if (scopedCommandId === undefined) {
                return undefined;
            }
            const receipt = await groups.findIdempotentGroupMutationReceipt(groupRef, scopedCommandId);
            const validatedReceipt = readValidatedGroupReceiptIdentity({
                value: receipt,
                ref: groupRef,
                scopedCommandId,
                requestId: command.commandId
            });
            return validatedReceipt !== undefined
                ? projectGroupReceiptEvidence(command.commandId, validatedReceipt)
                : undefined;
        }
    );
    const receipts = receiptResults.filter(
        (receipt): receipt is ProductionReceiptEvidence => receipt !== undefined
    );
    const productionRecords = await readReferencedProductionOutboxRecords(
        outbox,
        computeProductionOutboxExpectations(commands, receipts)
    );
    const appInbox = await readAppInboxEvidence({ sql, scope, commands, timingEvents });
    const resourceOutbox = computeProductionOutboxEvidence({
        commands,
        receipts,
        records: productionRecords
    });

    return {
        appInbox: appInbox.toSorted((left, right) => left.resourceId.localeCompare(right.resourceId)),
        receipts: receipts.toSorted((left, right) => left.commandId.localeCompare(right.commandId)),
        resourceOutbox: resourceOutbox.toSorted((left, right) => left.effectId.localeCompare(right.effectId)),
        intermediateMutationIntents: [],
        atomicCompletionFailures: 0
    };
}

function createScopedGroupCommandExpectations(
    commands: readonly StateWriteBenchmarkCommand[],
    scope: StateScope,
    groupCount: number
): readonly ScopedGroupCommandExpectation[] {
    const topicByKind: Readonly<Partial<Record<StateWriteBenchmarkCommand['kind'], AppInboxType>>> = {
        membership: AppInboxType.GROUP_MEMBER_UPSERT,
        'presence-connect': AppInboxType.GROUP_PRESENCE_CONNECT,
        'presence-heartbeat': AppInboxType.GROUP_PRESENCE_HEARTBEAT,
        'presence-disconnect': AppInboxType.GROUP_PRESENCE_DISCONNECT,
        config: AppInboxType.GROUP_UPDATE
    };
    return commands.flatMap((command) => {
        const topicId = topicByKind[command.kind];
        if (topicId === undefined) {
            return [];
        }
        const clientIndex = readBenchmarkClientIndex(command.commandId);
        const groupIndex = clientIndex % groupCount;
        const groupId = `group-${groupIndex}`;
        return [{
            requestId: command.commandId,
            topicId,
            contextId: [scope.applicationId, scope.workspaceId, groupId]
                .map(encodeURIComponent)
                .join(':'),
            groupRef: { ...scope, groupId },
            actorPrincipalId: command.kind === 'config'
                ? `owner-${groupIndex}`
                : `client-${clientIndex}`
        }];
    });
}

function readBenchmarkClientIndex(commandId: string): number {
    const clientIndex = Number(commandId.slice(commandId.lastIndexOf(':') + 1));
    if (!Number.isSafeInteger(clientIndex) || clientIndex < 0) {
        throw new Error(`Benchmark command ID has no client index: ${commandId}`);
    }
    return clientIndex;
}

interface ReadAppInboxEvidenceInput {
    readonly sql: Sql;
    readonly scope: StateScope;
    readonly commands: readonly StateWriteBenchmarkCommand[];
    readonly timingEvents: readonly RallarTimingEvent[];
}

async function readAppInboxEvidence({
    sql,
    scope,
    commands,
    timingEvents
}: ReadAppInboxEvidenceInput): Promise<AppInboxAttemptEvidence[]> {
    const rows = await sql<
        readonly {
            ri_resource_id: string;
            ri_topic_id: string;
            ri_resource: string;
            ri_status: string;
            ri_attempts: number | string;
            retry_delay_ms: number | string;
            due_age_ms: number | string;
            result_status: string | null;
            result_resource: string | null;
        }[]
    >`
    select i.ri_resource_id, i.ri_topic_id, i.ri_resource, i.ri_status, i.ri_attempts,
           coalesce(
             greatest(0, extract(epoch from (i.next_ts - i.end_ts)) * 1000), 0
           )::float8 as retry_delay_ms,
           coalesce(
             greatest(0, extract(epoch from (now() - i.next_ts)) * 1000), 0
           )::float8 as due_age_ms,
           r.ris_status as result_status, r.ris_resource as result_resource
    from resource_inbox i
    left join resource_inbox_results r
      on r.fk_ext_bank_id = i.fk_ext_bank_id
     and r.ris_resource_id = i.ri_resource_id
     and r.ris_topic_id = i.ri_topic_id
    where i.ri_type_id = 'APP_INBOX'
      and i.ri_resource like ${`%${scope.applicationId}%`}
  `;
    const byProductionId = new Map(
        commands.flatMap((command) =>
            productionCommandIdsForRaw(command).map(
                (productionId, index) =>
                    [
                        productionId,
                        {
                            commandId: command.commandId,
                            operationId: command.kind === 'profile-instance'
                                ? index === 0
                                    ? 'profile'
                                    : 'instance'
                                : 'command'
                        }
                    ] as const
            )
        )
    );

    return rows.flatMap((row) => {
        const ids = readAllCommandIds(row.ri_resource);
        const link = ids.map((id) => byProductionId.get(id)).find((entry) => entry !== undefined);
        if (!link) {
            return [];
        }
        const transaction = timingEvents
            .filter(
                (event) =>
                    event.component === 'app-inbox-phase' &&
                    event.operation === 'transaction' &&
                    (event.requestId === row.ri_resource_id || ids.includes(event.requestId ?? ''))
            )
            .at(-1);
        const dueAgeMs = Number(transaction?.details?.dueAgeMs ?? row.due_age_ms);
        return [
            {
                ...link,
                resourceId: row.ri_resource_id,
                topicId: row.ri_topic_id,
                status: row.ri_status,
                resultStatus: row.result_status ?? 'MISSING',
                attempts: Number(row.ri_attempts),
                retryDelayMs: Number(row.retry_delay_ms),
                dueAgeMs,
                selectedLane: dueAgeMs >= 30_000 ? ('fairness' as const) : ('fast' as const),
                transactionDurationMs: transaction?.durationMs ?? 0,
                commandType: readAppInboxCommandType(row.ri_resource),
                durableResult: parsePersistedResult(row.result_resource)
            }
        ];
    });
}

export function isValidProductionReceipt(
    value: Parameters<typeof validateClientMutationIdempotencyRecord>[0],
    requestId: string
): value is ClientMutationIdempotencyRecord {
    try {
        validateClientMutationIdempotencyRecord(value);
    }
    catch {
        return false;
    }
    return value.requestId === requestId && value.receipt.commandId === requestId;
}

function readValidatedTopologyMutationReceipt(
    value: Parameters<typeof readTopologyConfigMutationRecordBoundary>[0],
    groupRef: GroupRef,
    requestId: string
): GroupTopologyConfigMutationReceipt | undefined {
    try {
        const record = readTopologyConfigMutationRecordBoundary(value, { groupRef, requestId });
        return record.requestId === requestId && record.receipt.commandId === requestId
            ? record.receipt
            : undefined;
    }
    catch {
        return undefined;
    }
}
