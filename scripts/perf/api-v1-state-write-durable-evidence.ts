import type { GroupRef } from '@shared/api/group-types.ts';

import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { type ClientMutationIdempotencyRecord } from '@shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts';
import { validateClientMutationIdempotencyRecord } from '@shared-server/rallar-system/client-state/persistence/validate-persisted-client-state.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { GroupTopologyConfigRepository } from '@shared-server/rallar-system/topology/config/persistence/group-topology-config-repository.ts';

import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { readTopologyConfigMutationRecordBoundary } from '@shared-server/rallar-system/topology/config/mutation/topology-config-mutation-boundary.ts';
import type { Sql } from 'postgres';

import { toApiV1PostgresClient } from '../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';
import { parsePersistedResult } from './api-v1-state-write-attempt-evidence.ts';
import {
    readScopedGroupCommandsByRequestId,
    readValidatedGroupReceiptIdentity,
    type ScopedGroupCommandExpectation,
    type ScopedGroupCommandIdentity
} from './api-v1-state-write-group-receipt-evidence.ts';
import { countStateWriteAtomicCompletionFailures } from './api-v1-state-write-outbox-contract.mjs';
import {
    computeProductionOutboxEvidence,
    productionCommandIdsForRaw,
    type StateWriteResourceOutboxEvidence
} from './api-v1-state-write-outbox-evidence.ts';
import { computeProductionOutboxExpectations } from './api-v1-state-write-outbox-expectations.ts';
import {
    createProductionOutboxRepository,
    readReferencedProductionOutboxRecords,
    type ProductionOutboxRepository
} from './api-v1-state-write-outbox-repository.ts';
import {
    projectClientReceiptEvidence,
    projectGroupReceiptEvidence,
    projectTopologyReceiptEvidence,
    type ProductionReceiptEvidence
} from './api-v1-state-write-receipt-evidence.ts';
import { mapWithConcurrency } from './map-with-concurrency.ts';
import {
    readStateWriteAppInboxIdentity,
    readStateWriteBenchmarkClientIndex,
    toStateWriteAppInboxExpectations,
    toStateWriteBenchmarkGroupContextId,
    type StateWriteAppInboxExpectation
} from './state-write/api-v1-state-write-app-inbox-evidence.ts';

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
    readonly contextId: string;
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

export async function queryStateWriteDurableEvidence(
    input: QueryStateWriteDurableEvidenceInput
): Promise<StateWriteDurableEvidence> {
    return await new StateWriteDurableEvidenceReader(input).read();
}

class StateWriteDurableEvidenceReader {
    private readonly input: QueryStateWriteDurableEvidenceInput;
    private readonly clients: ClientStateRepository;
    private readonly groups: GroupStateRepository;
    private readonly topology: GroupTopologyConfigRepository;
    private readonly outbox: ProductionOutboxRepository;

    constructor(input: QueryStateWriteDurableEvidenceInput) {
        this.input = input;
        const database = toApiV1PostgresClient(input.sql);
        const runtime = new PSqlRuntimeStateRepository(database);
        this.clients = new ClientStateRepository(runtime, new PSqlClientStateEventRepository(database));
        this.groups = new GroupStateRepository(runtime, new PSqlGroupStateEventRepository(database));
        this.topology = new GroupTopologyConfigRepository(runtime);
        this.outbox = createProductionOutboxRepository(input.sql);
    }

    async read(): Promise<StateWriteDurableEvidence> {
        const { sql, scope, commands, groupCount, timingEvents } = this.input;
        const acceptedCommands = commands.filter((command) => command.status === 'accepted');
        const appInboxExpectations = toStateWriteAppInboxExpectations(acceptedCommands, scope, groupCount);
        const scopedGroupCommands = await readScopedGroupCommandsByRequestId({
            sql,
            expectations: createScopedGroupCommandExpectations(acceptedCommands, scope, groupCount)
        });
        const receiptResults = await mapWithConcurrency(
            acceptedCommands,
            25,
            async (command) => await this.readReceipt(command, scopedGroupCommands)
        );
        const receipts = receiptResults.filter((receipt): receipt is ProductionReceiptEvidence =>
            receipt !== undefined
        );
        const records = await readReferencedProductionOutboxRecords(
            this.outbox,
            computeProductionOutboxExpectations(commands, receipts)
        );
        const appInbox = await readAppInboxEvidence({ sql, expectations: appInboxExpectations, timingEvents });
        const resourceOutbox = computeProductionOutboxEvidence({ commands, receipts, records });
        return {
            appInbox: appInbox.toSorted((left, right) => left.resourceId.localeCompare(right.resourceId)),
            receipts: receipts.toSorted((left, right) => left.commandId.localeCompare(right.commandId)),
            resourceOutbox: resourceOutbox.toSorted((left, right) => left.effectId.localeCompare(right.effectId)),
            intermediateMutationIntents: [],
            atomicCompletionFailures: countStateWriteAtomicCompletionFailures(commands, {
                appInbox,
                receipts,
                resourceOutbox
            })
        };
    }

    private async readReceipt(
        command: StateWriteBenchmarkCommand,
        scopedGroupCommands: ReadonlyMap<string, ScopedGroupCommandIdentity>
    ): Promise<ProductionReceiptEvidence | undefined> {
        const { scope, groupCount } = this.input;
        const clientIndex = readStateWriteBenchmarkClientIndex(command.commandId);
        if (command.kind === 'profile-instance') {
            return await this.readClientReceipt(command, clientIndex);
        }
        const groupRef = { ...scope, groupId: `group-${clientIndex % groupCount}` };
        if (command.kind === 'topology-source') {
            const receipt = readValidatedTopologyMutationReceipt(
                await this.topology.findMutationRecord(groupRef, command.commandId),
                groupRef,
                command.commandId
            );
            return receipt ? projectTopologyReceiptEvidence(command.commandId, receipt) : undefined;
        }
        const scopedCommand = scopedGroupCommands.get(command.commandId);
        if (scopedCommand === undefined) {
            return undefined;
        }
        const receipt = await this.groups.findIdempotentGroupMutationReceipt(groupRef, scopedCommand.commandId);
        const validatedReceipt = readValidatedGroupReceiptIdentity({ value: receipt, ref: groupRef, scopedCommand });
        return validatedReceipt === undefined
            ? undefined
            : projectGroupReceiptEvidence(command.commandId, validatedReceipt);
    }

    private async readClientReceipt(
        command: StateWriteBenchmarkCommand,
        clientIndex: number
    ): Promise<ProductionReceiptEvidence | undefined> {
        const productionCommandIds = productionCommandIdsForRaw(command);
        const ref = { ...this.input.scope, principalId: `client-${clientIndex}` };
        const receipts = await Promise.all(productionCommandIds.map(
            async (requestId) => await this.clients.findIdempotentClientMutationReceipt(ref, requestId)
        ));
        if (!receipts.every((receipt, index) => isValidProductionReceipt(receipt, productionCommandIds[index]!))) {
            return undefined;
        }
        return projectClientReceiptEvidence(command.commandId, receipts);
    }
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
        const clientIndex = readStateWriteBenchmarkClientIndex(command.commandId);
        const groupIndex = clientIndex % groupCount;
        const groupId = `group-${groupIndex}`;
        return [{
            requestId: command.commandId,
            topicId,
            logicalContextId: toStateWriteBenchmarkGroupContextId(scope, groupId),
            groupRef: { ...scope, groupId },
            actorPrincipalId: command.kind === 'config'
                ? `owner-${groupIndex}`
                : `client-${clientIndex}`
        }];
    });
}

interface ReadAppInboxEvidenceInput {
    readonly sql: Sql;
    readonly expectations: readonly StateWriteAppInboxExpectation[];
    readonly timingEvents: readonly RallarTimingEvent[];
}

async function readAppInboxEvidence({
    sql,
    expectations,
    timingEvents
}: ReadAppInboxEvidenceInput): Promise<AppInboxAttemptEvidence[]> {
    if (expectations.length === 0) {
        return [];
    }
    const rows = await readAppInboxRows(sql, expectations);
    const expectationByPhysicalKey = new Map(
        expectations.map((expectation) => [toPhysicalKey(expectation.physicalKey), expectation])
    );

    return rows.flatMap((row) => {
        const expectation = expectationByPhysicalKey.get(toPhysicalKey({
            resourceId: row.ri_resource_id,
            topicId: row.ri_topic_id,
            contextId: row.fk_ext_bank_id
        }));
        if (expectation === undefined) {
            return [];
        }
        return [computeAppInboxEvidence(row, expectation, timingEvents)];
    });
}

interface PersistedAppInboxEvidenceRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
    readonly ri_resource: string;
    readonly ri_status: string;
    readonly ri_attempts: number | string;
    readonly retry_delay_ms: number | string;
    readonly due_age_ms: number | string;
    readonly result_status: string | null;
    readonly result_resource: string | null;
}

async function readAppInboxRows(
    sql: Sql,
    expectations: readonly StateWriteAppInboxExpectation[]
): Promise<readonly PersistedAppInboxEvidenceRow[]> {
    return await sql<readonly PersistedAppInboxEvidenceRow[]>`
    select i.ri_resource_id, i.ri_topic_id, i.fk_ext_bank_id, i.ri_resource,
           i.ri_status, i.ri_attempts,
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
      and i.ri_resource_id = any(${[...new Set(expectations.map((entry) => entry.physicalKey.resourceId))]})
      and i.ri_topic_id = any(${[...new Set(expectations.map((entry) => entry.physicalKey.topicId))]})
      and i.fk_ext_bank_id = any(${[...new Set(expectations.map((entry) => entry.physicalKey.contextId))]})
  `;
}

function computeAppInboxEvidence(
    row: PersistedAppInboxEvidenceRow,
    expectation: StateWriteAppInboxExpectation,
    timingEvents: readonly RallarTimingEvent[]
): AppInboxAttemptEvidence {
    const identity = readStateWriteAppInboxIdentity(row, expectation);
    if (identity === undefined) {
        throw new TypeError(
            `Benchmark AppInbox row differs from its expected command identity: ${expectation.commandId}`
        );
    }
    const transaction = timingEvents
        .filter(
            (event) =>
                event.component === 'app-inbox-phase' &&
                event.operation === 'transaction' &&
                (
                    event.requestId === row.ri_resource_id ||
                    event.requestId === expectation.logicalResourceId
                )
        )
        .at(-1);
    const dueAgeMs = Number(transaction?.details?.dueAgeMs ?? row.due_age_ms);
    return {
        commandId: identity.commandId,
        operationId: identity.operationId,
        resourceId: row.ri_resource_id,
        topicId: row.ri_topic_id,
        contextId: row.fk_ext_bank_id,
        status: row.ri_status,
        resultStatus: row.result_status ?? 'MISSING',
        attempts: Number(row.ri_attempts),
        retryDelayMs: Number(row.retry_delay_ms),
        dueAgeMs,
        selectedLane: dueAgeMs >= 30_000 ? ('fairness' as const) : ('fast' as const),
        transactionDurationMs: transaction?.durationMs ?? 0,
        commandType: identity.commandType,
        durableResult: parsePersistedResult(row.result_resource)
    };
}

function toPhysicalKey(
    input: Readonly<{ resourceId: string; topicId: string; contextId: string; }>
): string {
    return [input.resourceId, input.topicId, input.contextId].join('\0');
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
