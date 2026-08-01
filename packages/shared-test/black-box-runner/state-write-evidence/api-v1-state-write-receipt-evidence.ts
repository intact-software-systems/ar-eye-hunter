import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { PSqlRuntimeStateRepository } from
    '@shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts';
import { ClientStateRepository } from
    '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from
    '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupTopologyConfigRepository } from
    '@shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts';
import { validateClientMutationIdempotencyRecord } from
    '@shared-server/rallar-system/services/client-state-mutations.ts';
import { validateGroupMutationCommand } from
    '@shared-server/rallar-system/services/group-state-mutations.ts';
import { validateGroupTopologyConfigMutationRecord } from
    '@shared-server/rallar-system/services/group-topology-config-mutations.ts';
import { validatePersistedAppInboxCommandIdentity } from
    '@shared-server/rallar-system/services/app-inbox-command-identity.ts';
import { AppInboxType } from
    '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import type { ApiV1StateWriteEvidenceQuery } from './api-v1-state-write-evidence-contracts.ts';
import type {
    AuthoritativeTopologyReceipt,
    ReceiptEffectIdentityKind,
} from './api-v1-state-write-result-evidence.ts';
import type { PublicResultReceiptIdentity } from
    './api-v1-state-write-group-causal-evidence.ts';
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
    readTopologyReconfigureCommand,
} from './api-v1-state-write-command-codecs.ts';

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
    readonly ri_resource: string;
    readonly result_status?: string | null;
}

export async function readPersistedCommandEvidence(
    sql: ApiV1StateWriteEvidenceQuery,
    row: InboxCommandRow,
): Promise<PersistedCommandEvidence> {
    const identity = validatePersistedAppInboxCommandIdentity({
        topicId: row.ri_topic_id,
        resource: row.ri_resource,
    });
    if (!identity.valid) {
        return invalid(row.ri_resource_id, identity.identity.operation, [], 'malformed-app-inbox-command');
    }
    const commandType = identity.command.type;
    try {
        const runtime = new PSqlRuntimeStateRepository(sql as unknown as PSqlSql);
        const requireReceipt = row.result_status === 'COMPLETED';
        if (isGeneralClientCommand(commandType)) {
            return await readClientReceipt(
                runtime,
                row,
                identity.command.data,
                commandType,
                requireReceipt,
            );
        }
        if (commandType === AppInboxType.CLIENT_AUTHORISED_WS_CONNECT ||
            commandType === AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT) {
            return await readAuthorisedWsClientReceipt(
                runtime,
                row,
                identity.command.data,
                commandType,
            );
        }
        if (commandType.startsWith('GROUP_') &&
            commandType !== AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP) {
            return await readGroupReceipt(
                runtime,
                row,
                identity.command.authority,
                commandType,
                requireReceipt,
            );
        }
        if (isTopologyConfigCommand(commandType)) {
            return await readTopologyReceipt(
                runtime,
                row,
                identity.command.authority,
                commandType,
                requireReceipt,
            );
        }
        if (commandType === AppInboxType.TOPOLOGY_RECONFIGURE) {
            const command = readTopologyReconfigureCommand(identity.command.authority);
            return {
                appInboxResourceId: row.ri_resource_id,
                valid: true,
                commandType,
                commandIds: [command.requestId],
                commandScope: command.groupRef,
            };
        }
        return {
            appInboxResourceId: row.ri_resource_id,
            valid: true,
            commandType,
            commandIds: readExactStandaloneCommandIds(
                commandType,
                identity.command.data,
                identity.command.authority,
                row.ri_resource_id,
            ),
        };
    } catch (error) {
        return invalid(
            row.ri_resource_id,
            commandType,
            [],
            error instanceof Error ? error.message : String(error),
        );
    }
}

async function readClientReceipt(
    runtime: PSqlRuntimeStateRepository,
    row: InboxCommandRow,
    data: unknown,
    commandType: AppInboxType,
    requireReceipt: boolean,
): Promise<PersistedCommandEvidence> {
    const payload = readExactRecord(data, clientPayloadKeys(commandType), 'client payload');
    const scope = readScope(payload.scope);
    const principalId = readString(payload.principalId, 'client principalId');
    const request = readRecord(payload.request, 'client request');
    const requestId = readString(request.requestId, 'client requestId');
    return await readClientReceiptByIdentity(
        runtime,
        row,
        commandType,
        { ...scope, principalId },
        requestId,
        !requireReceipt,
    );
}

async function readAuthorisedWsClientReceipt(
    runtime: PSqlRuntimeStateRepository,
    row: InboxCommandRow,
    data: unknown,
    commandType: AppInboxType,
): Promise<PersistedCommandEvidence> {
    const connection = commandType === AppInboxType.CLIENT_AUTHORISED_WS_DISCONNECT
        ? readExactRecord(data, ['connection', 'disconnectedAtEpochMs', 'reason'], 'WS disconnect')
            .connection
        : data;
    const payload = readExactRecord(connection, [
        'authSession', 'generationId', 'generationStartedAtEpochMs', 'scope', 'principalId',
        'clientInstanceId', 'displayName', 'userAgent', 'platform', 'capabilities',
        'expiresAtEpochMs',
    ], 'authorised WS client payload');
    const authSession = readRecord(payload.authSession, 'authorised WS auth session');
    const sessionId = readString(authSession.sessionId, 'authorised WS sessionId');
    const generationId = readString(payload.generationId, 'authorised WS generationId');
    const requestId = commandType === AppInboxType.CLIENT_AUTHORISED_WS_CONNECT
        ? `authorised-ws:connect:${sessionId}:${generationId}`
        : `authorised-ws:disconnect:${sessionId}:${generationId}`;
    return await readClientReceiptByIdentity(
        runtime,
        row,
        commandType,
        {
            ...readScope(payload.scope),
            principalId: readString(payload.principalId, 'authorised WS principalId'),
        },
        requestId,
        true,
    );
}

async function readClientReceiptByIdentity(
    runtime: PSqlRuntimeStateRepository,
    row: InboxCommandRow,
    commandType: AppInboxType,
    ref: Readonly<{ applicationId: string; workspaceId: string; principalId: string }>,
    requestId: string,
    allowMissing = false,
): Promise<PersistedCommandEvidence> {
    const stored = await new ClientStateRepository(runtime)
        .findIdempotentClientMutationReceipt(ref, requestId);
    if (!stored && allowMissing) {
        return {
            appInboxResourceId: row.ri_resource_id,
            valid: true,
            commandType,
            commandIds: [requestId],
        };
    }
    validateClientMutationIdempotencyRecord(stored);
    if (stored.requestId !== requestId || stored.receipt.commandId !== requestId ||
        stored.receipt.aggregateRef.applicationId !== ref.applicationId ||
        stored.receipt.aggregateRef.workspaceId !== ref.workspaceId ||
        stored.receipt.aggregateRef.principalId !== ref.principalId ||
        stored.commandHash !== stored.receipt.commandHash) {
        throw new TypeError('client authoritative receipt differs from command identity');
    }
    return {
        appInboxResourceId: row.ri_resource_id,
        valid: true,
        commandType,
        commandIds: [requestId],
        receipt: toReceipt(row.ri_resource_id, stored.receipt, 'physical-resource-id'),
    };
}

async function readGroupReceipt(
    runtime: PSqlRuntimeStateRepository,
    row: InboxCommandRow,
    authority: unknown,
    commandType: AppInboxType,
    requireReceipt: boolean,
): Promise<PersistedCommandEvidence> {
    const prepared = readExactRecord(authority, [
        'authorityProof', 'descriptor', 'command', 'facts', 'causalToken', 'queueResourceId',
    ], 'group preparation');
    validateGroupMutationCommand(prepared.command);
    const command = prepared.command;
    const requestId = readString(command.requestId, 'group requestId');
    const facts = readRecord(prepared.facts, 'group facts');
    const commandHash = readString(facts.commandHash, 'group commandHash');
    if (prepared.queueResourceId !== row.ri_resource_id) {
        throw new TypeError('group queue resource differs from physical queue identity');
    }
    if (!requireReceipt) {
        return {
            appInboxResourceId: row.ri_resource_id,
            valid: true,
            commandType,
            commandIds: [command.commandId],
        };
    }
    const stored = await new GroupStateRepository(runtime)
        .findIdempotentGroupMutationReceipt(command.aggregateRef, requestId);
    if (!stored || stored.requestId !== requestId ||
        stored.commandHash !== commandHash ||
        stored.receipt.commandHash !== commandHash ||
        stored.receipt.commandId !== command.commandId ||
        stored.aggregateRef.applicationId !== command.aggregateRef.applicationId ||
        stored.aggregateRef.workspaceId !== command.aggregateRef.workspaceId ||
        stored.aggregateRef.groupId !== command.aggregateRef.groupId) {
        throw new TypeError('group authoritative receipt differs from command identity');
    }
    return {
        appInboxResourceId: row.ri_resource_id,
        valid: true,
        commandType,
        commandIds: [command.commandId],
        receipt: toReceipt(row.ri_resource_id, stored.receipt, 'physical-resource-id'),
    };
}

async function readTopologyReceipt(
    runtime: PSqlRuntimeStateRepository,
    row: InboxCommandRow,
    authority: unknown,
    commandType: AppInboxType,
    requireReceipt: boolean,
): Promise<PersistedCommandEvidence> {
    const durableAuthority = readExactRecord(
        authority,
        ['kind', 'proof', 'command'],
        'topology authority',
    );
    const command = readExactRecord(durableAuthority.command, [
        'actor', 'groupRef', 'requestId', 'commandHash', 'capturedAtEpochMs',
        'operation', 'payload',
    ], 'topology command');
    const groupRef = readGroupRef(command.groupRef);
    const requestId = readString(command.requestId, 'topology requestId');
    const commandHash = readString(command.commandHash, 'topology commandHash');
    const expectedOperation: Readonly<Partial<Record<AppInboxType, string>>> = {
        [AppInboxType.TOPOLOGY_CONFIG_PUT]: 'putConfig',
        [AppInboxType.TOPOLOGY_CONFIG_DELETE]: 'deleteConfig',
        [AppInboxType.TOPOLOGY_OVERRIDE_PUT]: 'putOverride',
        [AppInboxType.TOPOLOGY_OVERRIDE_DELETE]: 'deleteOverride',
    };
    if (command.operation !== expectedOperation[commandType]) {
        throw new TypeError('topology command operation differs from AppInbox type');
    }
    if (!requireReceipt) {
        return {
            appInboxResourceId: row.ri_resource_id,
            valid: true,
            commandType,
            commandIds: [requestId],
        };
    }
    const stored = await new GroupTopologyConfigRepository(runtime)
        .findMutationRecord(groupRef, requestId);
    validateGroupTopologyConfigMutationRecord(stored, { groupRef, requestId });
    if (stored.commandHash !== commandHash || stored.receipt.commandHash !== commandHash) {
        throw new TypeError('topology authoritative receipt differs from command hash');
    }
    return {
        appInboxResourceId: row.ri_resource_id,
        valid: true,
        commandType,
        commandIds: [requestId],
        receipt: toReceipt(row.ri_resource_id, stored.receipt, 'logical-msg-id'),
    };
}

function toReceipt(
    appInboxResourceId: string,
    receipt: Readonly<{
        commandId: string; commandHash: string; outcome: string; outboxIds: readonly string[];
        requestId?: string | null; aggregateRef?: Readonly<{
            applicationId: string; workspaceId: string; principalId?: string; groupId?: string
        }>;
        stateRevision?: number; snapshotVersion?: number; eventId?: string | null
        causalRevision?: PublicResultReceiptIdentity['causalRevision']
        operation?: string; target?: 'config' | 'override'; groupRef?: Readonly<{
            applicationId: string; workspaceId: string; groupId: string
        }>;
        acceptedVersion?: number; acceptedStorageRevision?: number | null;
        acceptedCreatedAtEpochMs?: number | null; acceptedUpdatedAtEpochMs?: number | null;
        acceptedExpiresAtEpochMs?: number | null; acceptedConfig?: unknown;
    }>,
    identityKind: ReceiptEffectIdentityKind,
): AuthoritativeReceiptEvidence {
    return {
        appInboxResourceId,
        commandId: receipt.commandId,
        commandHash: receipt.commandHash,
        outcome: receipt.outcome,
        outboxIds: [...receipt.outboxIds],
        identityKind,
        ...(receipt.requestId !== undefined ? { requestId: receipt.requestId } : {}),
        ...(receipt.aggregateRef ? { aggregateRef: { ...receipt.aggregateRef } } : {}),
        ...(receipt.stateRevision !== undefined ? { stateRevision: receipt.stateRevision } : {}),
        ...(receipt.causalRevision ? { causalRevision: { ...receipt.causalRevision } } : {}),
        ...(receipt.snapshotVersion !== undefined
            ? { snapshotVersion: receipt.snapshotVersion }
            : {}),
        ...(receipt.eventId !== undefined ? { eventId: receipt.eventId } : {}),
        ...(receipt.operation && receipt.target && receipt.groupRef &&
                receipt.acceptedVersion !== undefined
            ? { topology: {
                operation: receipt.operation,
                target: receipt.target,
                groupRef: { ...receipt.groupRef },
                acceptedVersion: receipt.acceptedVersion,
                acceptedStorageRevision: receipt.acceptedStorageRevision ?? null,
                acceptedCreatedAtEpochMs: receipt.acceptedCreatedAtEpochMs ?? null,
                acceptedUpdatedAtEpochMs: receipt.acceptedUpdatedAtEpochMs ?? null,
                acceptedExpiresAtEpochMs: receipt.acceptedExpiresAtEpochMs ?? null,
                acceptedConfig: receipt.acceptedConfig ?? null,
            } }
            : {}),
    };
}

function invalid(
    appInboxResourceId: string,
    commandType: string,
    commandIds: readonly string[],
    failure: string,
): PersistedCommandEvidence {
    return { appInboxResourceId, valid: false, commandType, commandIds, failure };
}
