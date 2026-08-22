import type { StateScope } from '@shared/api/state-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state-storage-keys.ts';

import type { JsonWireValue } from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import type { Sql } from 'postgres';

import type { ProductionReceiptEvidence } from './api-v1-state-write-receipt-evidence.ts';
import { mapWithConcurrency } from './map-with-concurrency.ts';

export interface StateWriteOutboxCommand {
    readonly commandId: string;
    readonly kind:
        | 'profile-instance'
        | 'membership'
        | 'presence-connect'
        | 'presence-heartbeat'
        | 'presence-disconnect'
        | 'config'
        | 'topology-source';
}

export interface StateWriteResourceOutboxEvidence {
    readonly effectId: string;
    readonly resourceId: string;
    readonly outboxId: string;
    readonly commandId: string;
    readonly effectKind: string;
    readonly typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
    readonly topicId: string;
}

interface ProductionOutboxRecord {
    readonly resourceId: string;
    readonly outboxId: string;
    readonly typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
    readonly topicId: string;
    readonly effectKind: string;
    readonly canonicalCommandId?: string;
    readonly commandIds: readonly string[];
}

interface ProductionOutboxRepository {
    find(outboxId: string): Promise<Readonly<{ record: ProductionOutboxRecord; }> | undefined>;
}

export async function readReferencedProductionOutboxRecords(
    repository: ProductionOutboxRepository,
    outboxIds: readonly string[]
): Promise<readonly ProductionOutboxRecord[]> {
    const records = await mapWithConcurrency(
        [...new Set(outboxIds)],
        25,
        async (outboxId) => await repository.find(outboxId)
    );
    return records.flatMap((entry) => (entry ? [entry.record] : []));
}

export function createProductionOutboxRepository(sql: Sql): ProductionOutboxRepository {
    return {
        find: async (outboxId) => {
            const rows = await sql<
                readonly {
                    ri_resource_id: string;
                    ri_topic_id: string;
                    ri_type_id: string;
                    ri_resource: string;
                    outbox_id: string;
                }[]
            >`
        select ri_resource_id, ri_topic_id, ri_type_id, ri_resource,
               ri_resource::jsonb #>> '{id,msgId}' as outbox_id
        from resource_inbox
        where ri_resource_id = ${outboxId}
      `;
            const row = rows[0];
            if (!row) {
                return undefined;
            }
            return {
                record: {
                    resourceId: row.ri_resource_id,
                    outboxId: row.outbox_id,
                    typeId: requireOutboxType(row.ri_type_id),
                    topicId: row.ri_topic_id,
                    effectKind: readResourceEffectKind(row),
                    canonicalCommandId: readCanonicalEffectCommandId(row.ri_resource),
                    commandIds: readAllCommandIds(row.ri_resource)
                }
            };
        }
    };
}

export function readAllCommandIds(resource: string): string[] {
    try {
        const parsed: JsonWireValue = JSON.parse(resource);
        return [...new Set(findCommandIds(parsed))];
    }
    catch {
        return [];
    }
}

export function readCanonicalEffectCommandId(resource: string): string | undefined {
    try {
        const envelope: JsonWireValue = JSON.parse(resource);
        return readCanonicalMessageId(envelope);
    }
    catch {
        return undefined;
    }
}

function readCanonicalMessageId(value: JsonWireValue): string | undefined {
    if (!isJsonWireObject(value)) {
        return undefined;
    }
    const id = value.id;
    if (!isJsonWireObject(id)) {
        return undefined;
    }
    return effectIdentityCommandIds(id.msgId)[0];
}

function findCommandIds(value: JsonWireValue): string[] {
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try {
            const parsed: JsonWireValue = JSON.parse(value);
            return findCommandIds(parsed);
        }
        catch {
            return [];
        }
    }
    if (!isJsonWireObject(value)) {
        return [];
    }
    return [
        ...(typeof value.commandId === 'string' ? [value.commandId] : []),
        ...(typeof value.requestId === 'string' ? [value.requestId] : []),
        ...effectIdentityCommandIds(value.msgId),
        ...effectIdentityCommandIds(value.resourceId),
        ...Object.values(value).flatMap(findCommandIds)
    ];
}

function isJsonWireObject(
    value: JsonWireValue | undefined
): value is Readonly<Record<string, JsonWireValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function effectIdentityCommandIds(value: JsonWireValue | undefined): string[] {
    if (typeof value !== 'string') {
        return [];
    }
    for (
        const marker of [
            ':rtc-topology-recompute:',
            ':group-presence-summary:',
            ':principal-state:'
        ]
    ) {
        const index = value.indexOf(marker);
        if (index > 0) {
            return [value.slice(0, index)];
        }
    }
    return [];
}

export interface ProductionOutboxLookupIdsInput {
    readonly command: StateWriteOutboxCommand;
    readonly scope: StateScope;
    readonly groupCount: number;
    readonly receiptOutboxIds: readonly string[];
}

export function computeProductionOutboxLookupIds({
    command,
    scope,
    groupCount,
    receiptOutboxIds
}: ProductionOutboxLookupIdsInput): readonly string[] {
    if (command.kind !== 'topology-source') {
        return receiptOutboxIds;
    }
    const clientIndex = Number(command.commandId.slice(command.commandId.lastIndexOf(':') + 1));
    if (!Number.isSafeInteger(clientIndex) || clientIndex < 0) {
        return [];
    }
    const contextId = groupStateGroupStorageKey({
        ...scope,
        groupId: `group-${clientIndex % groupCount}`
    });
    return receiptOutboxIds.map(
        (resourceId) =>
            toAppQueueKey({
                topicId: 'app-outbox.rtc-topology',
                resourceId,
                contextId
            }).resourceId
    );
}

export function productionCommandIdsForRaw(command: StateWriteOutboxCommand): readonly string[] {
    return command.kind === 'profile-instance'
        ? [`${command.commandId}-profile`, `${command.commandId}-instance`]
        : [command.commandId];
}

export interface ProjectProductionOutboxEvidenceInput {
    readonly commands: readonly StateWriteOutboxCommand[];
    readonly receipts: readonly ProductionReceiptEvidence[];
    readonly records: readonly ProductionOutboxRecord[];
}

export function computeProductionOutboxEvidence({
    commands,
    receipts,
    records
}: ProjectProductionOutboxEvidenceInput): readonly StateWriteResourceOutboxEvidence[] {
    const rawByProductionId = new Map(
        [
            ...commands.flatMap((command) =>
                productionCommandIdsForRaw(command).map(
                    (productionId) => [productionId, command.commandId] as const
                )
            ),
            ...receipts.flatMap((receipt) =>
                receipt.receiptIds.map((receiptId) => [receiptId, receipt.commandId] as const)
            )
        ]
    );
    const receiptByCommand = new Map(receipts.map((receipt) => [receipt.commandId, receipt]));
    const known = new Set(commands.map((command) => command.commandId));
    return records.flatMap((record) => {
        const commandId = record.canonicalCommandId === undefined
            ? undefined
            : rawByProductionId.get(record.canonicalCommandId);
        const receipt = commandId === undefined ? undefined : receiptByCommand.get(commandId);
        const effectId = receipt?.identityKind === 'logical-msg-id' ? record.outboxId : record.resourceId;
        if (!commandId || !known.has(commandId) || !receipt?.outboxIds.includes(effectId)) {
            return [];
        }
        return [
            {
                effectId,
                resourceId: record.resourceId,
                outboxId: record.outboxId,
                commandId,
                effectKind: record.effectKind,
                typeId: record.typeId,
                topicId: record.topicId
            }
        ];
    });
}

function requireOutboxType(value: string): 'APP_OUTBOX' | 'WS_OUTBOX' {
    if (value !== 'APP_OUTBOX' && value !== 'WS_OUTBOX') {
        throw new Error(`Receipt references non-outbox ResourceInbox row: ${value}`);
    }
    return value;
}

export function readResourceEffectKind(
    row: Readonly<{
        ri_resource_id: string;
        ri_topic_id: string;
        ri_type_id: string;
        ri_resource: string;
    }>
): string {
    if (row.ri_topic_id === 'app-outbox.group-presence-summary') {
        return 'group-presence-summary';
    }
    if (row.ri_topic_id === 'app-outbox.rtc-topology') {
        return 'rtc-topology-recompute';
    }
    if (row.ri_type_id === 'WS_OUTBOX') {
        if (row.ri_topic_id === 'client-state.snapshot') {
            return 'principal-state:snapshot';
        }
        if (row.ri_topic_id === 'client-state.event') {
            return 'principal-state:event';
        }
    }
    throw new Error(`Unrecognized final ResourceInbox effect ${row.ri_type_id}:${row.ri_topic_id}`);
}
