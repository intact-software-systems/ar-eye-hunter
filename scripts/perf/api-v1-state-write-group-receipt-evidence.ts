import type { GroupRef } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

import { validateGroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts';
import {
    toScopedGroupMutationCommandIdFromIdentity
} from '@shared-server/rallar-system/group-state/scoped-group-mutation-command-id.ts';
import {
    validateGroupMutationIdempotencyRecord,
    type GroupMutationIdempotencyRecord
} from '@shared-server/rallar-system/services/group-state-mutations.ts';
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';

import type { Sql } from 'postgres';

export interface ScopedGroupCommandIdentity {
    readonly requestId: string;
    readonly commandId: string;
}

export interface ScopedGroupCommandExpectation {
    readonly requestId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly groupRef: GroupRef;
    readonly actorPrincipalId: string;
}

interface PersistedScopedGroupCommandRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
    readonly ri_resource: string;
}

interface ReadScopedGroupCommandIdsByRequestIdInput {
    readonly sql: Sql;
    readonly expectations: readonly ScopedGroupCommandExpectation[];
}

export async function readScopedGroupCommandIdsByRequestId({
    sql,
    expectations
}: ReadScopedGroupCommandIdsByRequestIdInput): Promise<ReadonlyMap<string, string>> {
    const expectationByPhysicalKey = new Map<string, ScopedGroupCommandExpectation>();
    for (const expectation of expectations) {
        const physicalKey = toPhysicalKey({
            resourceId: toAppQueueKey({
                topicId: expectation.topicId,
                resourceId: expectation.requestId,
                contextId: expectation.contextId
            }).resourceId,
            topicId: expectation.topicId,
            contextId: expectation.contextId
        });
        if (expectationByPhysicalKey.has(physicalKey)) {
            throw new Error(`Benchmark group command expectation is duplicated: ${expectation.requestId}`);
        }
        expectationByPhysicalKey.set(physicalKey, expectation);
    }
    if (expectationByPhysicalKey.size === 0) {
        return new Map();
    }
    const rows = await sql<readonly PersistedScopedGroupCommandRow[]>`
        select ri_resource_id, ri_topic_id, fk_ext_bank_id, ri_resource
        from resource_inbox
        where ri_type_id = 'APP_INBOX'
          and ri_topic_id = any(${[...new Set(expectations.map((entry) => entry.topicId))]})
          and fk_ext_bank_id = any(${[...new Set(expectations.map((entry) => entry.contextId))]})
    `;
    const identities = new Map<string, string>();
    for (const row of rows) {
        const expectation = expectationByPhysicalKey.get(toPhysicalKey({
            resourceId: row.ri_resource_id,
            topicId: row.ri_topic_id,
            contextId: row.fk_ext_bank_id
        }));
        if (expectation === undefined) {
            continue;
        }
        const identity = await readScopedGroupCommandIdentity(row, expectation);
        if (identity === undefined) {
            throw new TypeError(
                `Benchmark scoped group command differs from its exact expected identity: ${expectation.requestId}`
            );
        }
        const previous = identities.get(identity.requestId);
        if (previous !== undefined && previous !== identity.commandId) {
            throw new Error(
                `Benchmark request ID resolves to multiple scoped group commands: ${identity.requestId}`
            );
        }
        identities.set(identity.requestId, identity.commandId);
    }
    return identities;
}

export async function readScopedGroupCommandIdentity(
    row: PersistedScopedGroupCommandRow,
    expectation: ScopedGroupCommandExpectation
): Promise<ScopedGroupCommandIdentity | undefined> {
    if (
        row.ri_topic_id !== expectation.topicId ||
        row.fk_ext_bank_id !== expectation.contextId ||
        row.ri_resource_id !== toAppQueueKey({
                topicId: expectation.topicId,
                resourceId: expectation.requestId,
                contextId: expectation.contextId
            }).resourceId
    ) {
        return undefined;
    }
    const envelope = readJsonWireObject(row.ri_resource);
    const payload = asJsonWireObject(envelope?.payload);
    const enqueueResource = typeof payload?.resource === 'string'
        ? readJsonWireObject(payload.resource)
        : undefined;
    const preparation = asJsonWireObject(enqueueResource?.authority);
    if (
        payload?.typeId !== expectation.topicId ||
        enqueueResource?.type !== expectation.topicId ||
        enqueueResource?.topicId !== expectation.topicId ||
        enqueueResource?.resourceId !== expectation.requestId ||
        enqueueResource?.contextId !== expectation.contextId ||
        !hasExactKeys(preparation, [
            'authorityProof',
            'descriptor',
            'command',
            'facts',
            'causalToken',
            'queueResourceId'
        ])
    ) {
        return undefined;
    }
    const authorityProof = asJsonWireObject(preparation.authorityProof);
    const descriptor = asJsonWireObject(preparation.descriptor);
    const command = preparation.command;
    if (
        authorityProof?.principalId !== expectation.actorPrincipalId ||
        !hasExactKeys(descriptor, [
            'operation',
            'scope',
            'groupId',
            'targetPrincipalId',
            'sessionId',
            'request'
        ])
    ) {
        return undefined;
    }
    try {
        validateGroupMutationCommand(command);
    }
    catch {
        return undefined;
    }
    const descriptorScope = asJsonWireObject(descriptor.scope);
    const descriptorRequest = asJsonWireObject(descriptor.request);
    const targetPrincipalId = 'targetPrincipalId' in command ? command.targetPrincipalId : null;
    const targetSessionId = 'sessionId' in command ? command.sessionId : null;
    if (
        !hasExactKeys(descriptorScope, ['applicationId', 'workspaceId']) ||
        descriptorScope.applicationId !== expectation.groupRef.applicationId ||
        descriptorScope.workspaceId !== expectation.groupRef.workspaceId ||
        descriptor.groupId !== expectation.groupRef.groupId ||
        descriptor.targetPrincipalId !== targetPrincipalId ||
        descriptor.sessionId !== targetSessionId ||
        descriptorRequest?.requestId !== expectation.requestId ||
        descriptor.operation !== command.operation ||
        command.requestId !== expectation.requestId ||
        command.aggregateRef.applicationId !== expectation.groupRef.applicationId ||
        command.aggregateRef.workspaceId !== expectation.groupRef.workspaceId ||
        command.aggregateRef.groupId !== expectation.groupRef.groupId ||
        command.input.actorPrincipalId !== expectation.actorPrincipalId ||
        command.commandId !== await toScopedGroupMutationCommandIdFromIdentity({
                operation: command.operation,
                scope: {
                    applicationId: command.aggregateRef.applicationId,
                    workspaceId: command.aggregateRef.workspaceId
                },
                groupId: command.aggregateRef.groupId,
                targetPrincipalId,
                targetSessionId,
                callerPrincipalId: expectation.actorPrincipalId,
                requestId: expectation.requestId
            })
    ) {
        return undefined;
    }
    return { requestId: expectation.requestId, commandId: command.commandId };
}

interface IsValidatedGroupReceiptIdentityInput {
    readonly value: Parameters<typeof validateGroupMutationIdempotencyRecord>[0];
    readonly ref: GroupRef;
    readonly scopedCommandId: string;
    readonly requestId: string;
}

export function readValidatedGroupReceiptIdentity({
    value,
    ref,
    scopedCommandId,
    requestId
}: IsValidatedGroupReceiptIdentityInput): GroupMutationIdempotencyRecord | undefined {
    try {
        validateGroupMutationIdempotencyRecord(value, ref);
    }
    catch {
        return undefined;
    }
    return value.requestId === scopedCommandId &&
            value.receipt.commandId === scopedCommandId &&
            value.receipt.requestId === requestId
        ? value
        : undefined;
}

function readJsonWireObject(value: string): JsonWireObject | undefined {
    try {
        return asJsonWireObject(decodeJsonWireValue(JSON.parse(value), 'Benchmark AppInbox resource'));
    }
    catch {
        return undefined;
    }
}

function asJsonWireObject(value: JsonWireValue | undefined): JsonWireObject | undefined {
    return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonWireObject
        : undefined;
}

function hasExactKeys(value: JsonWireObject | undefined, keys: readonly string[]): value is JsonWireObject {
    return value !== undefined &&
        Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function toPhysicalKey(
    input: Readonly<{
        resourceId: string;
        topicId: string;
        contextId: string;
    }>
): string {
    return [input.resourceId, input.topicId, input.contextId].join('\0');
}
