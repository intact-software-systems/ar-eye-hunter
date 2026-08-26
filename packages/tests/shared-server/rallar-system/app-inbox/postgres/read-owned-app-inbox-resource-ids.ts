import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { validatePersistedAppInboxCommandIdentity } from '@shared-server/rallar-system/app-inbox/app-inbox-command-identity.ts';
import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

interface ReadOwnedAppInboxResourceIdsInput {
    readonly sql: PSqlSql;
    readonly scope: StateScope;
    readonly requestIds: readonly string[];
}

interface AppInboxResourceRow {
    readonly ri_resource_id: string;
    readonly ri_resource: string;
    readonly ri_topic_id: string;
}

interface AppInboxRequestIdentity {
    readonly scope: StateScope;
    readonly requestId: string;
}

export function toOwnedAppInboxResourceIds(requestIds: readonly string[]): readonly string[] {
    return requestIds.map(
        (requestId) => toAppQueueKey({ resourceId: requestId, topicId: '', contextId: '' }).resourceId
    );
}

export async function readOwnedAppInboxResourceIds(
    input: ReadOwnedAppInboxResourceIdsInput
): Promise<readonly string[]> {
    const rows = await input.sql<AppInboxResourceRow[]>`
    select ri_resource_id, ri_resource, ri_topic_id
    from resource_inbox
    where ri_type_id = ${EnqueuedType.APP_INBOX}
      and position(${input.scope.applicationId} in ri_resource) > 0
  `;
    const requestIds = new Set(input.requestIds);
    const resourceIdByRequestId = new Map<string, string>();
    for (const row of rows) {
        const validation = validatePersistedAppInboxCommandIdentity({
            topicId: row.ri_topic_id,
            resource: row.ri_resource
        });
        if (!validation.valid) {
            continue;
        }
        const identity = decodeAppInboxRequestIdentity(validation.command.data);
        if (!identity || !isSameScope(identity.scope, input.scope)) {
            continue;
        }
        if (!requestIds.has(identity.requestId)) {
            continue;
        }
        if (resourceIdByRequestId.has(identity.requestId)) {
            throw new Error(`Duplicate AppInbox resource for request: ${identity.requestId}`);
        }
        resourceIdByRequestId.set(identity.requestId, row.ri_resource_id);
    }
    return input.requestIds.map((requestId) => {
        const resourceId = resourceIdByRequestId.get(requestId);
        if (!resourceId) {
            throw new Error(`Missing AppInbox resource for request: ${requestId}`);
        }
        return resourceId;
    });
}

function decodeAppInboxRequestIdentity(value: JsonWireValue): AppInboxRequestIdentity | null {
    if (!isJsonWireObject(value) || !isJsonWireObject(value.scope) || !isJsonWireObject(value.request)) {
        return null;
    }
    const { applicationId, workspaceId } = value.scope;
    const { requestId } = value.request;
    if (
        typeof applicationId !== 'string' ||
        typeof workspaceId !== 'string' ||
        typeof requestId !== 'string'
    ) {
        return null;
    }
    return { scope: { applicationId, workspaceId }, requestId };
}

function isSameScope(left: StateScope, right: StateScope): boolean {
    return left.applicationId === right.applicationId && left.workspaceId === right.workspaceId;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
