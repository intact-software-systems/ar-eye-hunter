import { GroupTopologyConfigRepository } from '@shared-server/mod.ts';
import { decodeAdminPruneCommand } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import {
    ADMIN_APP_INBOX_TOPIC,
    LEGACY_ADMIN_APP_INBOX_TOPIC,
    toAdminPruneContextId,
    toAdminPruneJobId
} from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-inbox-identity.ts';
import {
    groupMutationIdempotencyKey
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-idempotency-key.ts';
import * as ClientState from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import * as GroupState from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import * as AppInboxCommandIdentity from '@shared-server/rallar-system/services/app-inbox-command-identity.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import { toStrictAppInboxQueueKey } from '@shared-server/rallar-system/services/app-inbox-queue-key.ts';
import * as ClientMutations from '@shared-server/rallar-system/services/client-state-mutations.ts';
import * as GroupMutations from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import * as TopologyMutation from '@shared-server/rallar-system/topology/config/mutation/topology-config-mutation-boundary.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateRepositoryLike
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
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
    readonly commandScope?: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId?: string;
    }>;
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
    const commandType = identity.command.type;
    try {
        const runtime = createStateWriteEvidenceRuntimeStateRepository(sql);
        const requireReceipt = row.result_status === 'COMPLETED';
        if (isGeneralClientCommand(commandType)) {
            return await readClientReceipt({
                runtime,
                row,
                data: identity.command.data,
                commandType,
                requireReceipt
            });
        }
        if (
            commandType === AppInboxType.CLIENT_AUTHORISED_WS_CONNECT ||
            commandType === AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT
        ) {
            return await readAuthorisedWsClientReceipt({
                runtime,
                row,
                data: identity.command.data,
                commandType
            });
        }
        if (
            commandType.startsWith('GROUP_') &&
            commandType !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP
        ) {
            return await readGroupReceipt({
                runtime,
                row,
                authority: identity.command.authority,
                logicalResourceId: readString(
                    identity.command.resourceId,
                    'group AppInbox resourceId'
                ),
                commandType,
                requireReceipt
            });
        }
        if (isTopologyConfigCommand(commandType)) {
            return await readTopologyReceipt({
                runtime,
                row,
                authority: identity.command.authority,
                commandType,
                requireReceipt
            });
        }
        if (commandType === AppInboxType.TOPOLOGY_RECONFIGURE) {
            const command = readTopologyReconfigureCommand(identity.command.authority);
            return {
                ...toPersistedCommandIdentity(row),
                valid: true,
                commandType,
                commandIds: [command.requestId],
                commandScope: command.groupRef
            };
        }
        if (commandType === AppInboxType.ADMIN_PRUNE_EXPIRED) {
            return await readAdminPruneEvidence(
                row,
                decodeJsonWireValue(identity.command.data, 'Admin prune evidence command'),
                commandType
            );
        }
        return {
            ...toPersistedCommandIdentity(row),
            valid: true,
            commandType,
            commandIds: readExactStandaloneCommandIds({
                type: commandType,
                data: identity.command.data,
                authority: identity.command.authority,
                fallback: row.ri_resource_id
            })
        };
    }
    catch (error) {
        return invalid(row, {
            commandType,
            commandIds: [],
            failure: error instanceof Error ? error.message : String(error)
        });
    }
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
    readonly ref: Readonly<{ applicationId: string; workspaceId: string; principalId: string; }>;
    readonly requestId: string;
    readonly allowMissing?: boolean;
}

async function readClientReceiptByIdentity(
    input: ReadClientReceiptByIdentityInput
): Promise<PersistedCommandEvidence> {
    const { runtime, row, commandType, ref, requestId, allowMissing = false } = input;
    const stored = await new ClientState.ClientStateRepository(
        runtime
    ).findIdempotentClientMutationReceipt(ref, requestId);
    if (!stored && allowMissing) {
        return {
            ...toPersistedCommandIdentity(row),
            valid: true,
            commandType,
            commandIds: [requestId]
        };
    }
    ClientMutations.validateClientMutationIdempotencyRecord(stored);
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
        receipt: toAuthoritativeReceiptEvidence(
            row.ri_resource_id,
            stored.receipt,
            'physical-resource-id'
        )
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
    const prepared = readExactRecord(
        authority,
        ['authorityProof', 'descriptor', 'command', 'facts', 'causalToken', 'queueResourceId'],
        'group preparation'
    );
    GroupMutations.validateGroupMutationCommand(prepared.command);
    const command = prepared.command;
    const requestId = readString(command.requestId, 'group requestId');
    const idempotencyKey = groupMutationIdempotencyKey(command);
    if (idempotencyKey === null) {
        throw new TypeError('Group AppInbox command is missing its idempotency identity');
    }
    const facts = readRecord(prepared.facts, 'group facts');
    const commandHash = readString(facts.commandHash, 'group commandHash');
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
    const stored = await new GroupState.GroupStateRepository(
        runtime
    ).findIdempotentGroupMutationReceipt(command.aggregateRef, idempotencyKey);
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
    data: Parameters<typeof decodeAdminPruneCommand>[0],
    commandType: AppInboxType
): Promise<PersistedCommandEvidence> {
    const command = decodeAdminPruneCommand(data);
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
    const legacyIdentity = row.ri_topic_id === LEGACY_ADMIN_APP_INBOX_TOPIC &&
        row.fk_ext_bank_id === command.requestedBy &&
        command.jobId === row.ri_resource_id;
    if (!currentIdentity && !legacyIdentity) {
        throw new TypeError('Admin prune queue identity differs from physical queue identity');
    }
    return {
        ...toPersistedCommandIdentity(row),
        valid: true,
        commandType,
        commandIds: [command.jobId]
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
