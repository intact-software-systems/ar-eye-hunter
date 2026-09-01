import type { GroupRef } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import { type AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toGroupAppInboxOperation } from '@shared-server/rallar-system/app-inbox/logical-app-inbox-command.ts';
import { toDescriptorCommand } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { decodeGroupMutationDescriptor } from '@shared-server/rallar-system/group-state/inbox/decode-group-state-inbox-authority.ts';
import {
    toGroupMutationDescriptorTargetIdentity
} from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import { assertGroupMutationCommand } from '@shared-server/rallar-system/group-state/mutation/command-validation/assert-group-mutation-command.ts';
import {
    type GroupMutationCommand,
    type GroupMutationIdempotencyRecord
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { assertGroupMutationIdempotencyRecord } from '@shared-server/rallar-system/group-state/mutation/result-validation/assert-group-mutation-result.ts';
import {
    toScopedGroupMutationCommandIdFromIdentity
} from '@shared-server/rallar-system/group-state/scoped-group-mutation-command-id.ts';
import {
    decodeJsonWireValue,
    encodeJsonWireValue,
    hashMutationCommand,
    serializeCanonicalMutationCommand,
    type JsonWireObject,
    type JsonWireValue
} from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import type { Sql } from 'postgres';

export interface ScopedGroupCommandIdentity {
    readonly requestId: string;
    readonly commandId: string;
    readonly commandHash: string;
}

export interface ScopedGroupCommandExpectation {
    readonly requestId: string;
    readonly topicId: AppInboxType;
    readonly logicalContextId: string;
    readonly groupRef: GroupRef;
    readonly actorPrincipalId: string;
}

interface PersistedScopedGroupCommandRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
    readonly ri_resource: string;
}

interface ReadScopedGroupCommandsByRequestIdInput {
    readonly sql: Sql;
    readonly expectations: readonly ScopedGroupCommandExpectation[];
}

export async function readScopedGroupCommandsByRequestId({
    sql,
    expectations
}: ReadScopedGroupCommandsByRequestIdInput): Promise<ReadonlyMap<string, ScopedGroupCommandIdentity>> {
    const expectationByPhysicalKey = new Map<string, ScopedGroupCommandExpectation>();
    for (const expectation of expectations) {
        const physicalKey = toPhysicalKey(toScopedGroupCommandQueueKey(expectation));
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
          and ri_topic_id = any(${[
        ...new Set(expectations.map((entry) => toScopedGroupCommandQueueKey(entry).topicId))
    ]})
          and fk_ext_bank_id = any(${[
        ...new Set(expectations.map((entry) => toScopedGroupCommandQueueKey(entry).contextId))
    ]})
    `;
    const identities = new Map<string, ScopedGroupCommandIdentity>();
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
        if (
            previous !== undefined &&
            (
                previous.commandId !== identity.commandId ||
                previous.commandHash !== identity.commandHash
            )
        ) {
            throw new Error(
                `Benchmark request ID resolves to multiple scoped group commands: ${identity.requestId}`
            );
        }
        identities.set(identity.requestId, identity);
    }
    return identities;
}

export async function readScopedGroupCommandIdentity(
    row: PersistedScopedGroupCommandRow,
    expectation: ScopedGroupCommandExpectation
): Promise<ScopedGroupCommandIdentity | undefined> {
    const queueKey = toScopedGroupCommandQueueKey(expectation);
    if (
        row.ri_topic_id !== queueKey.topicId ||
        row.fk_ext_bank_id !== queueKey.contextId ||
        row.ri_resource_id !== queueKey.resourceId
    ) {
        return undefined;
    }
    const prepared = decodeScopedGroupPreparation(row.ri_resource, expectation);
    return prepared ? await resolveScopedGroupCommandIdentity(prepared, expectation) : undefined;
}

interface ScopedGroupPreparation {
    readonly command: GroupMutationCommand;
    readonly descriptor: GroupMutationDescriptor;
    readonly commandHash: string;
}

function decodeScopedGroupPreparation(
    resource: string,
    expectation: ScopedGroupCommandExpectation
): ScopedGroupPreparation | undefined {
    const envelope = readJsonWireObject(resource);
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
        enqueueResource?.contextId !== expectation.logicalContextId ||
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
    const facts = asJsonWireObject(preparation.facts);
    const descriptor = asJsonWireObject(preparation.descriptor);
    const descriptorScope = asJsonWireObject(descriptor?.scope);
    const descriptorRequest = asJsonWireObject(descriptor?.request);
    if (
        authorityProof?.principalId !== expectation.actorPrincipalId || typeof facts?.commandHash !== 'string' ||
        !hasExactKeys(descriptor, ['operation', 'scope', 'groupId', 'targetPrincipalId', 'sessionId', 'request']) ||
        !hasExactKeys(descriptorScope, ['applicationId', 'workspaceId']) ||
        descriptorRequest === undefined
    ) {
        return undefined;
    }
    try {
        assertGroupMutationCommand(preparation.command);
        return {
            command: preparation.command,
            descriptor: decodeGroupMutationDescriptor(descriptor),
            commandHash: facts.commandHash
        };
    }
    catch {
        return undefined;
    }
}

async function resolveScopedGroupCommandIdentity(
    prepared: ScopedGroupPreparation,
    expectation: ScopedGroupCommandExpectation
): Promise<ScopedGroupCommandIdentity | undefined> {
    const { command, descriptor } = prepared;
    let semanticCommand: GroupMutationCommand;
    let commandHash: string;
    try {
        semanticCommand = toDescriptorCommand(descriptor, () => {
            throw new TypeError('Benchmark group mutation request ID is required');
        });
        commandHash = await hashMutationCommand(encodeJsonWireValue(semanticCommand));
    }
    catch {
        return undefined;
    }
    const target = toGroupMutationDescriptorTargetIdentity(command);
    const expectedCommandId = await toScopedGroupMutationCommandIdFromIdentity({
        operation: command.operation,
        scope: descriptor.scope,
        groupId: descriptor.groupId,
        targetPrincipalId: target.targetPrincipalId,
        targetSessionId: target.sessionId,
        callerPrincipalId: expectation.actorPrincipalId,
        requestId: expectation.requestId
    });
    if (
        descriptor.scope.applicationId !== expectation.groupRef.applicationId ||
        descriptor.scope.workspaceId !== expectation.groupRef.workspaceId ||
        descriptor.groupId !== expectation.groupRef.groupId ||
        descriptor.targetPrincipalId !== target.targetPrincipalId ||
        descriptor.sessionId !== target.sessionId ||
        descriptor.request.requestId !== expectation.requestId ||
        command.operation !== toGroupAppInboxOperation(expectation.topicId) ||
        descriptor.operation !== command.operation ||
        serializeCanonicalMutationCommand(encodeJsonWireValue(command)) !==
            serializeCanonicalMutationCommand(encodeJsonWireValue({
                ...semanticCommand,
                commandId: command.commandId
            })) ||
        prepared.commandHash !== commandHash ||
        command.requestId !== expectation.requestId ||
        command.aggregateRef.applicationId !== expectation.groupRef.applicationId ||
        command.aggregateRef.workspaceId !== expectation.groupRef.workspaceId ||
        command.aggregateRef.groupId !== expectation.groupRef.groupId ||
        command.input.actorPrincipalId !== expectation.actorPrincipalId ||
        command.commandId !== expectedCommandId
    ) {
        return undefined;
    }
    return { requestId: expectation.requestId, commandId: command.commandId, commandHash };
}

function toScopedGroupCommandQueueKey(expectation: ScopedGroupCommandExpectation): Key {
    return toAppQueueKey({
        topicId: expectation.topicId,
        resourceId: expectation.requestId,
        contextId: expectation.logicalContextId
    });
}

interface ReadValidatedGroupReceiptIdentityInput {
    readonly value: unknown;
    readonly ref: GroupRef;
    readonly scopedCommand: ScopedGroupCommandIdentity;
}

export function readValidatedGroupReceiptIdentity({
    value,
    ref,
    scopedCommand
}: ReadValidatedGroupReceiptIdentityInput): GroupMutationIdempotencyRecord | undefined {
    try {
        assertGroupMutationIdempotencyRecord(value, ref);
    }
    catch {
        return undefined;
    }
    return value.requestId === scopedCommand.commandId &&
            value.commandHash === scopedCommand.commandHash &&
            value.receipt.commandId === scopedCommand.commandId &&
            value.receipt.requestId === scopedCommand.requestId &&
            value.receipt.commandHash === scopedCommand.commandHash
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

function toPhysicalKey(input: Key): string {
    return [input.resourceId, input.topicId, input.contextId].join('\0');
}
