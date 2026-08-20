import type { GroupRef } from '@shared/api/group-types.ts';
// prettier-ignore
import type {
  GroupTopologyConfigMutationReceipt,
} from '@shared/api/graph-topology-management-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
// prettier-ignore
import {
  PSqlRuntimeStateRepository,
} from '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
// prettier-ignore
import {
  ClientStateRepository,
} from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
// prettier-ignore
import {
  GroupStateRepository,
} from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
  type ClientMutationIdempotencyRecord,
  validateClientMutationIdempotencyRecord,
} from '@shared-server/rallar-system/services/client-state-mutations.ts';
import {
  type GroupMutationIdempotencyRecord,
  validateGroupMutationIdempotencyRecord,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';
// prettier-ignore
import {
  GroupTopologyConfigRepository,
} from '@shared-server/rallar-system/topology/config/persistence/\
group-topology-config-repository.ts';
// prettier-ignore
import {
  readTopologyConfigMutationRecordBoundary,
} from '@shared-server/rallar-system/topology/config/mutation/\
topology-config-mutation-boundary.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/services/timing.ts';
import type { Sql } from 'postgres';

import { toPSqlSql } from '../../apps/api-v1/src/db/to-p-sql-sql.ts';
import {
  parsePersistedResult,
  readAppInboxCommandType,
} from './api-v1-state-write-attempt-evidence.ts';
import { mapWithConcurrency } from './map-with-concurrency.ts';
import {
  type ProductionReceiptEvidence,
  projectClientReceiptEvidence,
  projectGroupReceiptEvidence,
  projectTopologyReceiptEvidence,
} from './api-v1-state-write-receipt-evidence.ts';
import {
  createProductionOutboxRepository,
  computeProductionOutboxLookupIds,
  computeProductionOutboxEvidence,
  productionCommandIdsForRaw,
  readAllCommandIds,
  readReferencedProductionOutboxRecords,
  type StateWriteResourceOutboxEvidence,
} from './api-v1-state-write-outbox-evidence.ts';

export type StateWriteBenchmarkCommand = Readonly<{
  commandId: string;
  kind:
    | 'profile-instance'
    | 'membership'
    | 'presence-connect'
    | 'presence-heartbeat'
    | 'presence-disconnect'
    | 'config'
    | 'topology-source';
  latencyMs: number;
  stackIndex: number;
  status: 'accepted' | 'exhausted';
}>;

export type StateWriteDurableEvidence = Readonly<{
  appInbox: readonly AppInboxAttemptEvidence[];
  receipts: readonly ProductionReceiptEvidence[];
  resourceOutbox: readonly StateWriteResourceOutboxEvidence[];
  intermediateMutationIntents: readonly [];
  atomicCompletionFailures: number;
}>;

type AppInboxAttemptEvidence = Readonly<{
  commandId: string;
  operationId: string;
  resourceId: string;
  topicId: string;
  status: string;
  resultStatus: string;
  attempts: number;
  retryDelayMs: number;
  dueAgeMs: number;
  selectedLane: 'fast' | 'fairness' | 'timeout';
  transactionDurationMs: number;
  commandType: string;
  durableResult: ReturnType<typeof parsePersistedResult>;
}>;

export type QueryStateWriteDurableEvidenceInput = Readonly<{
  sql: Sql;
  scope: StateScope;
  commands: readonly StateWriteBenchmarkCommand[];
  groupCount: number;
  timingEvents: readonly RallarTimingEvent[];
}>;

export async function queryStateWriteDurableEvidence({
  sql,
  scope,
  commands,
  groupCount,
  timingEvents,
}: QueryStateWriteDurableEvidenceInput): Promise<StateWriteDurableEvidence> {
  const runtime = new PSqlRuntimeStateRepository(toPSqlSql(sql));
  const clients = new ClientStateRepository(runtime);
  const groups = new GroupStateRepository(runtime);
  const topology = new GroupTopologyConfigRepository(runtime);
  const outbox = createProductionOutboxRepository(sql);
  const acceptedCommands = commands.filter((command) => command.status === 'accepted');
  const receiptResults = await mapWithConcurrency(
    acceptedCommands,
    25,
    async (command): Promise<ProductionReceiptEvidence | undefined> => {
      const clientIndex = Number(command.commandId.slice(command.commandId.lastIndexOf(':') + 1));
      if (!Number.isSafeInteger(clientIndex) || clientIndex < 0) {
        throw new Error(`Benchmark command ID has no client index: ${command.commandId}`);
      }
      const productionCommandIds = productionCommandIdsForRaw(command);

      if (command.kind === 'profile-instance') {
        const receipts = await Promise.all(
          productionCommandIds.map(
            async (requestId) =>
              await clients.findIdempotentClientMutationReceipt(
                { ...scope, principalId: `client-${clientIndex}` },
                requestId,
              ),
          ),
        );
        if (
          !receipts.every((receipt, index) =>
            isValidProductionReceipt(receipt, productionCommandIds[index]!),
          )
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
          command.commandId,
        );
        return receipt ? projectTopologyReceiptEvidence(command.commandId, receipt) : undefined;
      }
      const groupRef = { ...scope, groupId: `group-${clientIndex % groupCount}` };
      const receipt = await groups.findIdempotentGroupMutationReceipt(groupRef, command.commandId);
      return isValidatedReceiptIdentity(receipt, groupRef, command.commandId)
        ? projectGroupReceiptEvidence(command.commandId, receipt)
        : undefined;
    },
  );
  const receipts = receiptResults.filter(
    (receipt): receipt is ProductionReceiptEvidence => receipt !== undefined,
  );
  const receiptsByCommand = new Map(receipts.map((receipt) => [receipt.commandId, receipt]));
  const productionRecords = await readReferencedProductionOutboxRecords(
    outbox,
    commands.flatMap((command) =>
      computeProductionOutboxLookupIds({
        command,
        scope,
        groupCount,
        receiptOutboxIds: receiptsByCommand.get(command.commandId)?.outboxIds ?? [],
      }),
    ),
  );
  const appInbox = await readAppInboxEvidence({ sql, scope, commands, timingEvents });
  const resourceOutbox = computeProductionOutboxEvidence({
    commands,
    receipts,
    records: productionRecords,
  });

  return {
    appInbox: appInbox.toSorted((left, right) => left.resourceId.localeCompare(right.resourceId)),
    receipts: receipts.toSorted((left, right) => left.commandId.localeCompare(right.commandId)),
    resourceOutbox: resourceOutbox.toSorted((left, right) =>
      left.effectId.localeCompare(right.effectId),
    ),
    intermediateMutationIntents: [],
    atomicCompletionFailures: 0,
  };
}

type ReadAppInboxEvidenceInput = Readonly<{
  sql: Sql;
  scope: StateScope;
  commands: readonly StateWriteBenchmarkCommand[];
  timingEvents: readonly RallarTimingEvent[];
}>;

async function readAppInboxEvidence({
  sql,
  scope,
  commands,
  timingEvents,
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
              operationId:
                command.kind === 'profile-instance'
                  ? index === 0
                    ? 'profile'
                    : 'instance'
                  : 'command',
            },
          ] as const,
      ),
    ),
  );

  return rows.flatMap((row) => {
    const ids = readAllCommandIds(row.ri_resource);
    const link = ids.map((id) => byProductionId.get(id)).find((entry) => entry !== undefined);
    if (!link) return [];
    const transaction = timingEvents
      .filter(
        (event) =>
          event.component === 'app-inbox-phase' &&
          event.operation === 'transaction' &&
          (event.requestId === row.ri_resource_id || ids.includes(event.requestId ?? '')),
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
        durableResult: parsePersistedResult(row.result_resource),
      },
    ];
  });
}

export function isValidProductionReceipt(
  value: Parameters<typeof validateClientMutationIdempotencyRecord>[0],
  requestId: string,
): value is ClientMutationIdempotencyRecord {
  try {
    validateClientMutationIdempotencyRecord(value);
  } catch {
    return false;
  }
  return value.requestId === requestId && value.receipt.commandId === requestId;
}

function isValidatedReceiptIdentity(
  value: Parameters<typeof validateGroupMutationIdempotencyRecord>[0],
  ref: GroupRef,
  requestId: string,
): value is GroupMutationIdempotencyRecord {
  try {
    validateGroupMutationIdempotencyRecord(value, ref);
  } catch {
    return false;
  }
  return value.requestId === requestId && value.receipt.commandId === requestId;
}

function readValidatedTopologyMutationReceipt(
  value: Parameters<typeof readTopologyConfigMutationRecordBoundary>[0],
  groupRef: GroupRef,
  requestId: string,
): GroupTopologyConfigMutationReceipt | undefined {
  try {
    const record = readTopologyConfigMutationRecordBoundary(value, { groupRef, requestId });
    return record.requestId === requestId && record.receipt.commandId === requestId
      ? record.receipt
      : undefined;
  } catch {
    return undefined;
  }
}
