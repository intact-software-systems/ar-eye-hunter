import { GroupTopologyConfigRepository } from '@shared-server/mod.ts';
import {
    decodeAdminPruneCommand,
    type AdminPruneCommand
} from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import {
    ADMIN_APP_INBOX_TOPIC,
    assertAdminPruneStoredIdentity,
    toAdminPruneContextId,
    toAdminPruneJobId
} from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-inbox-identity.ts';
import * as AppInboxCommandIdentity from '@shared-server/rallar-system/app-inbox/app-inbox-command-identity.ts';
import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { validateClientMutationIdempotencyRecord } from '@shared-server/rallar-system/client-state/persistence/validate-persisted-client-state.ts';
import { validateGroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts';
import type { GroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import {
    groupMutationIdempotencyKey
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-idempotency-key.ts';
import { GroupStateRepositoryReads } from '@shared-server/rallar-system/group-state/persistence/group-state-repository-reads.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { InMemoryClientStateEventStore } from '@shared-server/rallar-system/state-events/in-memory-client-state-event-store.ts';
import * as TopologyMutation from '@shared-server/rallar-system/topology/config/mutation/topology-config-mutation-boundary.ts';
import { readRuntimeStateBatch } from '@shared-server/runtime-state/postgres/read-runtime-state-batch.ts';
import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupRef, GroupScope } from '@shared/api/group-types.ts';
import { toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

import {
    clientPayloadKeys,
    isGeneralClientCommand,
    isTopologyConfigCommand,
    readExactRecord,
    readExactStandaloneCommandIds,
    readGroupRef,
    readRecord,
    readScope,
    readString,
    readTopologyReconfigureCommand
} from './api-v1-state-write-command-codecs.ts';
import type { ApiV1StateWriteEvidenceQuery } from './api-v1-state-write-evidence-contracts.ts';
import type { PublicResultReceiptIdentity } from './api-v1-state-write-group-causal-evidence.ts';
import { toAuthoritativeReceiptEvidence } from './api-v1-state-write-receipt-projection.ts';
import type { AuthoritativeTopologyReceipt, ReceiptEffectIdentityKind } from './api-v1-state-write-result-evidence.ts';

export interface AuthoritativeReceiptEvidence extends PublicResultReceiptIdentity {
    readonly appInboxResourceId: string;
    readonly commandId: string;
    readonly commandHash: string;
    readonly outcome: string;
    readonly outboxIds: readonly string[];
    readonly identityKind: ReceiptEffectIdentityKind;
    readonly topology?: AuthoritativeTopologyReceipt;
}

export interface PersistedCommandEvidence {
    readonly appInboxResourceId: string;
    readonly appInboxTopicId: string;
    readonly appInboxContextId: string;
    readonly valid: boolean;
    readonly commandType: string;
    readonly commandIds: readonly string[];
    readonly commandScope?: GroupScope & Partial<Pick<GroupRef, 'groupId'>>;
    readonly adminPruneCommand?: AdminPruneCommand;
    readonly receipt?: AuthoritativeReceiptEvidence;
    readonly failure?: string;
}

interface InboxCommandRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
    readonly ri_resource: string;
    readonly result_status?: string | null;
}

interface RuntimeStateEvidenceRow {
    readonly store_key: string;
    readonly store_value: string;
    readonly updated_ts: string | Date;
    readonly expire_at_ts: string | Date;
    readonly revision: number | string;
}

function createStateWriteEvidenceRuntimeStateRepository(
    sql: ApiV1StateWriteEvidenceQuery
): RuntimeStateRepositoryLike {
    return {
        findEntry: async (namespace, key) => {
            const rows = await sql<readonly RuntimeStateEvidenceRow[]>`
        select store_key, store_value, updated_ts, expire_at_ts, revision
        from runtime_state_store
        where store_namespace = ${namespace}
          and store_key = ${key}
        limit 1
      `;
            return rows[0] ? toRuntimeStateEvidenceEntry(rows[0]) : undefined;
        },
        findAllEntries: async () => {
            throw unsupportedRuntimeStateEvidenceOperation('findAllEntries');
        },
        findEntriesByPrefixPage: async () => {
            throw unsupportedRuntimeStateEvidenceOperation('findEntriesByPrefixPage');
        },
        readRuntimeStateBatch: async (
            selectors: readonly RuntimeStateReadBatchSelector[]
        ): Promise<readonly RuntimeStateReadBatchSelection[]> => await readRuntimeStateBatch(sql, selectors),
        upsert: async () => {
            throw unsupportedRuntimeStateEvidenceOperation('upsert');
        },
        deleteByKey: async () => {
            throw unsupportedRuntimeStateEvidenceOperation('deleteByKey');
        },
        deleteExpired: async () => {
            throw unsupportedRuntimeStateEvidenceOperation('deleteExpired');
        }
    };
}

function toRuntimeStateEvidenceEntry(row: RuntimeStateEvidenceRow): RuntimeStateEntry {
    return {
        key: row.store_key,
        value: row.store_value,
        expireAtTimestamp: readRuntimeStateEvidenceDate(row.expire_at_ts, 'expiry').getTime(),
        updatedTimestamp: readRuntimeStateEvidenceDate(row.updated_ts, 'update').toISOString(),
        revision: readRuntimeStateEvidenceRevision(row.revision)
    };
}

function readRuntimeStateEvidenceDate(value: string | Date, label: string): Date {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new TypeError(`runtime state ${label} timestamp is invalid`);
    }
    return date;
}

function readRuntimeStateEvidenceRevision(value: number | string): number {
    const revision = typeof value === 'number'
        ? value
        : typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value)
        ? Number(value)
        : Number.NaN;
    if (!Number.isSafeInteger(revision) || revision < 0 || Object.is(revision, -0)) {
        throw new TypeError('runtime state revision is invalid');
    }
    return revision;
}

function unsupportedRuntimeStateEvidenceOperation(operation: string): Error {
    return new Error(`State-write evidence does not support runtime state ${operation}`);
}

export async function readPersistedCommandEvidence(
    sql: ApiV1StateWriteEvidenceQuery,
    row: InboxCommandRow
): Promise<PersistedCommandEvidence> {
    const identity = AppInboxCommandIdentity.validatePersistedAppInboxCommandIdentity({
        topicId: row.ri_topic_id,
        resource: row.ri_resource
    });
    if (!identity.valid) {
        return invalid(row, {
            commandType: identity.identity.operation,
            commandIds: [],
            failure: 'malformed-app-inbox-command'
        });
    }
    try {
        const receipt = await readMutationReceiptEvidence({
            runtime: createStateWriteEvidenceRuntimeStateRepository(sql),
            row,
            command: identity.command
        });
        return receipt ?? await readStandaloneCommandEvidence(row, identity.command);
    }
    catch (error) {
        return invalid(row, {
            commandType: identity.command.type,
            commandIds: [],
            failure: error instanceof Error ? error.message : String(error)
        });
    }
}

interface ReadMutationReceiptEvidenceInput {
    readonly runtime: RuntimeStateRepositoryLike;
    readonly row: InboxCommandRow;
    readonly command: AppInboxEnqueueInput;
}

async function readMutationReceiptEvidence({
    runtime,
    row,
    command
}: ReadMutationReceiptEvidenceInput): Promise<PersistedCommandEvidence | undefined> {
    const commandType = command.type;
    const requireReceipt = row.result_status === 'COMPLETED';
    if (isGeneralClientCommand(commandType)) {
        return await readClientReceipt({ runtime, row, data: command.data, commandType, requireReceipt });
    }
    if (
        commandType === AppInboxType.CLIENT_AUTHORISED_WS_CONNECT ||
        commandType === AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT
    ) {
        return await readAuthorisedWsClientReceipt({ runtime, row, data: command.data, commandType });
    }
    if (commandType.startsWith('GROUP_') && commandType !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP) {
        return await readGroupReceipt({
            runtime,
            row,
            authority: command.authority,
            logicalResourceId: readString(command.resourceId, 'group AppInbox resourceId'),
            commandType,
            requireReceipt
        });
    }
    if (isTopologyConfigCommand(commandType)) {
        return await readTopologyReceipt({ runtime, row, authority: command.authority, commandType, requireReceipt });
    }
    return undefined;
}

async function readStandaloneCommandEvidence(
    row: InboxCommandRow,
    command: AppInboxEnqueueInput
): Promise<PersistedCommandEvidence> {
    const commandType = command.type;
    if (commandType === AppInboxType.TOPOLOGY_RECONFIGURE) {
        const topologyCommand = readTopologyReconfigureCommand(command.authority);
        return {
            ...toPersistedCommandIdentity(row),
            valid: true,
            commandType,
            commandIds: [topologyCommand.requestId],
            commandScope: topologyCommand.groupRef
        };
    }
    if (commandType === AppInboxType.ADMIN_PRUNE_EXPIRED) {
        return await readAdminPruneEvidence(
            row,
            {
                topicId: command.topicId,
                resourceId: command.resourceId,
                contextId: command.contextId,
                senderId: command.senderId,
                data: decodeJsonWireValue(command.data, 'Admin prune evidence command')
            },
            commandType
        );
    }
    return {
        ...toPersistedCommandIdentity(row),
        valid: true,
        commandType,
        commandIds: readExactStandaloneCommandIds({
            type: commandType,
            data: command.data,
            authority: command.authority,
            defaultCommandId: row.ri_resource_id
        })
    };
}

interface ReadClientReceiptInput {
    readonly runtime: RuntimeStateRepositoryLike;
    readonly row: InboxCommandRow;
    readonly data: unknown;
    readonly commandType: AppInboxType;
    readonly requireReceipt: boolean;
}

async function readClientReceipt(input: ReadClientReceiptInput): Promise<PersistedCommandEvidence> {
    const { runtime, row, data, commandType, requireReceipt } = input;
    const payload = readExactRecord(data, clientPayloadKeys(commandType), 'client payload');
    const scope = readScope(payload.scope);
    const principalId = readString(payload.principalId, 'client principalId');
    const request = readRecord(payload.request, 'client request');
    const requestId = readString(request.requestId, 'client requestId');
    return await readClientReceiptByIdentity({
        runtime,
        row,
        commandType,
        ref: { ...scope, principalId },
        requestId,
        allowMissing: !requireReceipt
    });
}

interface ReadAuthorisedWsClientReceiptInput {
    readonly runtime: RuntimeStateRepositoryLike;
    readonly row: InboxCommandRow;
    readonly data: unknown;
    readonly commandType: AppInboxType;
}

async function readAuthorisedWsClientReceipt(
    input: ReadAuthorisedWsClientReceiptInput
): Promise<PersistedCommandEvidence> {
    const { runtime, row, data, commandType } = input;
    const connection = commandType === AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT
        ? readExactRecord(data, ['connection', 'disconnectedAtEpochMs', 'reason'], 'WS disconnect')
            .connection
        : data;
    const payload = readExactRecord(
        connection,
        [
            'authSession',
            'generationId',
            'generationStartedAtEpochMs',
            'scope',
            'principalId',
            'clientInstanceId',
            'displayName',
            'userAgent',
            'platform',
            'capabilities',
            'expiresAtEpochMs'
        ],
        'authorised WS client payload'
    );
    const authSession = readRecord(payload.authSession, 'authorised WS auth session');
    const sessionId = readString(authSession.sessionId, 'authorised WS sessionId');
    const generationId = readString(payload.generationId, 'authorised WS generationId');
    const requestId = commandType === AppInboxType.CLIENT_AUTHORISED_WS_CONNECT
        ? `authorised-ws:connect:${sessionId}:${generationId}`
        : `authorised-ws:disconnect:${sessionId}:${generationId}`;
    return await readClientReceiptByIdentity({
        runtime,
        row,
        commandType,
        ref: {
            ...readScope(payload.scope),
            principalId: readString(payload.principalId, 'authorised WS principalId')
        },
        requestId,
        allowMissing: true
    });
}

interface ReadClientReceiptByIdentityInput {
    readonly runtime: RuntimeStateRepositoryLike;
    readonly row: InboxCommandRow;
    readonly commandType: AppInboxType;
    readonly ref: ClientPrincipalRef;
    readonly requestId: string;
    readonly allowMissing?: boolean;
}

async function readClientReceiptByIdentity(
    input: ReadClientReceiptByIdentityInput
): Promise<PersistedCommandEvidence> {
    const { runtime, row, commandType, ref, requestId, allowMissing = false } = input;
    const stored = await new ClientStateRepository(
        runtime,
        new InMemoryClientStateEventStore()
    ).findIdempotentClientMutationReceipt(ref, requestId);
    if (!stored && allowMissing) {
        return {
            ...toPersistedCommandIdentity(row),
            valid: true,
            commandType,
            commandIds: [requestId]
        };
    }
    validateClientMutationIdempotencyRecord(stored);
    if (
        stored.requestId !== requestId ||
        stored.receipt.commandId !== requestId ||
        stored.receipt.aggregateRef.applicationId !== ref.applicationId ||
        stored.receipt.aggregateRef.workspaceId !== ref.workspaceId ||
        stored.receipt.aggregateRef.principalId !== ref.principalId ||
        stored.commandHash !== stored.receipt.commandHash
    ) {
        throw new TypeError('client authoritative receipt differs from command identity');
    }
    return {
        ...toPersistedCommandIdentity(row),
        valid: true,
        commandType,
        commandIds: [requestId],
        receipt: toAuthoritativeReceiptEvidence(row.ri_resource_id, stored.receipt, 'physical-resource-id')
    };
}

interface ReadGroupReceiptInput {
    readonly runtime: RuntimeStateRepositoryLike;
    readonly row: InboxCommandRow;
    readonly authority: unknown;
    readonly logicalResourceId: string;
    readonly commandType: AppInboxType;
    readonly requireReceipt: boolean;
}

async function readGroupReceipt(input: ReadGroupReceiptInput): Promise<PersistedCommandEvidence> {
    const { runtime, row, authority, logicalResourceId, commandType, requireReceipt } = input;
    const { command, requestId, idempotencyKey, commandHash } = decodeGroupReceiptPreparation(authority);
    const physicalResourceId = toAppQueueKey({
        topicId: row.ri_topic_id,
        resourceId: logicalResourceId,
        contextId: ''
    }).resourceId;
    if (physicalResourceId !== row.ri_resource_id) {
        throw new TypeError('group queue resource differs from physical queue identity');
    }
    if (!requireReceipt) {
        return {
            ...toPersistedCommandIdentity(row),
            valid: true,
            commandType,
            commandIds: [command.commandId]
        };
    }
    const stored = await new GroupStateRepositoryReads(runtime).findIdempotentGroupMutationReceipt(
        command.aggregateRef,
        idempotencyKey
    );
    if (
        !stored ||
        stored.requestId !== idempotencyKey ||
        stored.commandHash !== commandHash ||
        stored.receipt.commandHash !== commandHash ||
        stored.receipt.commandId !== command.commandId ||
        stored.receipt.requestId !== requestId ||
        stored.aggregateRef.applicationId !== command.aggregateRef.applicationId ||
        stored.aggregateRef.workspaceId !== command.aggregateRef.workspaceId ||
        stored.aggregateRef.groupId !== command.aggregateRef.groupId
    ) {
        throw new TypeError('group authoritative receipt differs from command identity');
    }
    return {
        ...toPersistedCommandIdentity(row),
        valid: true,
        commandType,
        commandIds: [command.commandId],
        receipt: toAuthoritativeReceiptEvidence(
            row.ri_resource_id,
            stored.receipt,
            'physical-resource-id'
        )
    };
}

interface GroupReceiptPreparation {
    readonly command: GroupMutationCommand;
    readonly requestId: string;
    readonly idempotencyKey: string;
    readonly commandHash: string;
}

function decodeGroupReceiptPreparation(authority: unknown): GroupReceiptPreparation {
    const prepared = readExactRecord(
        authority,
        ['authorityProof', 'descriptor', 'command', 'facts', 'causalToken', 'queueResourceId'],
        'group preparation'
    );
    const commandIssues = validateGroupMutationCommand(prepared.command);
    if (commandIssues.length > 0) {
        throw commandIssues[0].cause;
    }
    const command = prepared.command as unknown as GroupMutationCommand;
    const requestId = readString(command.requestId, 'group requestId');
    const idempotencyKey = groupMutationIdempotencyKey(command);
    if (idempotencyKey === null) {
        throw new TypeError('Group AppInbox command is missing its idempotency identity');
    }
    const facts = readRecord(prepared.facts, 'group facts');
    return { command, requestId, idempotencyKey, commandHash: readString(facts.commandHash, 'group commandHash') };
}

interface ReadTopologyReceiptInput {
    readonly runtime: RuntimeStateRepositoryLike;
    readonly row: InboxCommandRow;
    readonly authority: unknown;
    readonly commandType: AppInboxType;
    readonly requireReceipt: boolean;
}

async function readTopologyReceipt(
    input: ReadTopologyReceiptInput
): Promise<PersistedCommandEvidence> {
    const { runtime, row, authority, commandType, requireReceipt } = input;
    const durableAuthority = readExactRecord(
        authority,
        ['kind', 'proof', 'command'],
        'topology authority'
    );
    const command = readExactRecord(
        durableAuthority.command,
        ['actor', 'groupRef', 'requestId', 'commandHash', 'capturedAtEpochMs', 'operation', 'payload'],
        'topology command'
    );
    const groupRef = readGroupRef(command.groupRef);
    const requestId = readString(command.requestId, 'topology requestId');
    const commandHash = readString(command.commandHash, 'topology commandHash');
    const expectedOperation: Readonly<Partial<Record<AppInboxType, string>>> = {
        [AppInboxType.TOPOLOGY_CONFIG_PUT]: 'putConfig',
        [AppInboxType.TOPOLOGY_CONFIG_DELETE]: 'deleteConfig',
        [AppInboxType.TOPOLOGY_OVERRIDE_PUT]: 'putOverride',
        [AppInboxType.TOPOLOGY_OVERRIDE_DELETE]: 'deleteOverride'
    };
    if (command.operation !== expectedOperation[commandType]) {
        throw new TypeError('topology command operation differs from AppInbox type');
    }
    if (!requireReceipt) {
        return {
            ...toPersistedCommandIdentity(row),
            valid: true,
            commandType,
            commandIds: [requestId]
        };
    }
    const stored = await new GroupTopologyConfigRepository(runtime).findMutationRecord(
        groupRef,
        requestId
    );
    const record = TopologyMutation.readTopologyConfigMutationRecordBoundary(stored, {
        groupRef,
        requestId
    });
    if (record.commandHash !== commandHash || record.receipt.commandHash !== commandHash) {
        throw new TypeError('topology authoritative receipt differs from command hash');
    }
    return {
        ...toPersistedCommandIdentity(row),
        valid: true,
        commandType,
        commandIds: [requestId],
        receipt: toAuthoritativeReceiptEvidence(row.ri_resource_id, record.receipt, 'logical-msg-id')
    };
}

interface InvalidEvidenceInput {
    readonly commandType: string;
    readonly commandIds: readonly string[];
    readonly failure: string;
}

async function readAdminPruneEvidence(
    row: InboxCommandRow,
    enqueue: Readonly<{
        readonly topicId?: string;
        readonly resourceId?: string;
        readonly contextId?: string;
        readonly senderId?: string;
        readonly data: Parameters<typeof decodeAdminPruneCommand>[0];
    }>,
    commandType: AppInboxType
): Promise<PersistedCommandEvidence> {
    const command = decodeAdminPruneCommand(enqueue.data);
    const key = {
        resourceId: row.ri_resource_id,
        topicId: row.ri_topic_id,
        contextId: row.fk_ext_bank_id
    };
    const expectedCurrentKey = toStrictAppInboxQueueKey({
        resourceId: row.ri_resource_id,
        topicId: ADMIN_APP_INBOX_TOPIC,
        contextId: toAdminPruneContextId(command.requestedBy, command.appData)
    });
    const currentIdentity = row.ri_resource_id === expectedCurrentKey.resourceId &&
        row.ri_topic_id === expectedCurrentKey.topicId &&
        row.fk_ext_bank_id === expectedCurrentKey.contextId &&
        command.jobId === (await toAdminPruneJobId(key));
    if (!currentIdentity) {
        throw new TypeError('Admin prune queue identity differs from physical queue identity');
    }
    await assertAdminPruneStoredIdentity(key, enqueue, command);
    return {
        ...toPersistedCommandIdentity(row),
        valid: true,
        commandType,
        commandIds: [command.jobId],
        adminPruneCommand: command
    };
}

function toPersistedCommandIdentity(
    row: InboxCommandRow
): Pick<PersistedCommandEvidence, 'appInboxResourceId' | 'appInboxTopicId' | 'appInboxContextId'> {
    return {
        appInboxResourceId: row.ri_resource_id,
        appInboxTopicId: row.ri_topic_id,
        appInboxContextId: row.fk_ext_bank_id
    };
}

function invalid(row: InboxCommandRow, input: InvalidEvidenceInput): PersistedCommandEvidence {
    const { commandType, commandIds, failure } = input;
    return {
        ...toPersistedCommandIdentity(row),
        valid: false,
        commandType,
        commandIds,
        failure
    };
}
