import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';

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

interface ReadScopedGroupCommandIdsByRequestIdInput {
    readonly sql: Sql;
    readonly scope: StateScope;
}

export async function readScopedGroupCommandIdsByRequestId({
    sql,
    scope
}: ReadScopedGroupCommandIdsByRequestIdInput): Promise<ReadonlyMap<string, string>> {
    const rows = await sql<readonly { ri_resource: string; }[]>`
        select ri_resource
        from resource_inbox
        where ri_type_id = 'APP_INBOX'
          and ri_resource like ${`%${scope.applicationId}%`}
    `;
    const identities = new Map<string, string>();
    for (const row of rows) {
        const identity = readScopedGroupCommandIdentity(row.ri_resource);
        if (identity === undefined) {
            continue;
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

export function readScopedGroupCommandIdentity(resource: string): ScopedGroupCommandIdentity | undefined {
    const envelope = readJsonWireObject(resource);
    const payload = asJsonWireObject(envelope?.payload);
    const enqueueResource = typeof payload?.resource === 'string'
        ? readJsonWireObject(payload.resource)
        : undefined;
    const authority = asJsonWireObject(enqueueResource?.authority);
    const command = asJsonWireObject(authority?.command);
    const requestId = enqueueResource?.resourceId;
    const commandRequestId = command?.requestId;
    const commandId = command?.commandId;
    if (
        typeof requestId !== 'string' || requestId.length === 0 ||
        commandRequestId !== requestId || typeof commandId !== 'string' ||
        !/^group-app-inbox:[0-9a-f]{64}$/.test(commandId)
    ) {
        return undefined;
    }
    return { requestId, commandId };
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
