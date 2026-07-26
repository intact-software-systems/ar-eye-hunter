import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';

type DirectOutboxRow = Readonly<{
    ri_resource_id: string;
    ri_topic_id: string;
    ri_type_id: string;
    ri_status: string;
    ri_resource: string;
}>;

export type DirectResourceOutboxEvidence = Readonly<{
    resourceId: string;
    topicId: string;
    typeId: string;
    status: string;
    resource: string;
}>;

export async function findDirectResourceOutboxEvidence(
    sql: PSqlSql,
    resourceIds: readonly string[],
): Promise<readonly DirectResourceOutboxEvidence[]> {
    const uniqueResourceIds = [...new Set(resourceIds)];
    const rows = await Promise.all(uniqueResourceIds.map(async (resourceId) =>
        await sql<DirectOutboxRow[]>`
            select ri_resource_id, ri_topic_id, ri_type_id, ri_status, ri_resource
            from resource_inbox
            where ri_resource_id = ${resourceId}
        `
    ));
    return rows.flat().map((row) => ({
        resourceId: row.ri_resource_id,
        topicId: row.ri_topic_id,
        typeId: row.ri_type_id,
        status: row.ri_status,
        resource: row.ri_resource,
    }));
}

export function expectPendingDirectResourceOutboxEvidence(
    entries: readonly DirectResourceOutboxEvidence[],
    resourceIds: readonly string[],
): void {
    const byResourceId = new Map(entries.map((entry) => [entry.resourceId, entry]));
    for (const resourceId of resourceIds) {
        const entry = byResourceId.get(resourceId);
        if (!entry) throw new Error(`Missing direct outbox entry: ${resourceId}`);
        if (entry.typeId !== EnqueuedType.APP_OUTBOX) {
            throw new Error(`Unexpected direct outbox type for ${resourceId}: ${entry.typeId}`);
        }
        if (entry.status !== EntityStatus.NEW) {
            throw new Error(`Unexpected direct outbox status for ${resourceId}: ${entry.status}`);
        }
        if (!entry.resource.includes(resourceId)) {
            throw new Error(`Direct outbox payload does not bind ${resourceId}`);
        }
    }
}
