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

export type ExpectedDirectResourceOutboxEvidence = Readonly<{
    resourceId: string;
    topicId: string;
    typeId: string;
    status: string;
    payloadIncludes: readonly string[];
}>;

export type ExpectedAppOutboxWsLink = Readonly<{
    appResourceId: string;
    wsResourceId: string;
    linkIdentity?: string;
}>;

export type DirectResourceOutboxLifecycleExpectation = Readonly<{
    entries: readonly ExpectedDirectResourceOutboxEvidence[];
    appToWsLinks: readonly ExpectedAppOutboxWsLink[];
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

export function expectDirectResourceOutboxEvidence(
    entries: readonly DirectResourceOutboxEvidence[],
    expectedEntries: readonly ExpectedDirectResourceOutboxEvidence[],
): void {
    const byResourceId = new Map(entries.map((entry) => [entry.resourceId, entry]));
    for (const expected of expectedEntries) {
        const entry = byResourceId.get(expected.resourceId);
        if (!entry) throw new Error(`Missing direct outbox entry: ${expected.resourceId}`);
        if (entry.typeId !== expected.typeId) {
            throw new Error(`Unexpected direct outbox type for ${expected.resourceId}: ${entry.typeId}`);
        }
        if (entry.topicId !== expected.topicId) {
            throw new Error(`Unexpected direct outbox topic for ${expected.resourceId}: ${entry.topicId}`);
        }
        if (entry.status !== expected.status) {
            throw new Error(`Unexpected direct outbox status for ${expected.resourceId}: ${entry.status}`);
        }
        for (const payload of expected.payloadIncludes) {
            if (!entry.resource.includes(payload)) {
                throw new Error(`Direct outbox payload does not bind ${payload}`);
            }
        }
    }
}

export function expectAppOutboxWsLink(
    appEntry: DirectResourceOutboxEvidence,
    wsEntry: DirectResourceOutboxEvidence,
    linkIdentity = appEntry.resourceId,
): void {
    if (appEntry.typeId !== EnqueuedType.APP_OUTBOX) {
        throw new Error(`Expected APP_OUTBOX: ${appEntry.resourceId}`);
    }
    if (wsEntry.typeId !== EnqueuedType.WS_OUTBOX) {
        throw new Error(`Expected WS_OUTBOX: ${wsEntry.resourceId}`);
    }
    if (!wsEntry.resource.includes(linkIdentity)) {
        throw new Error(`WS_OUTBOX does not link APP_OUTBOX identity: ${linkIdentity}`);
    }
}

export function expectDirectResourceOutboxLifecycle(
    entries: readonly DirectResourceOutboxEvidence[],
    expected: DirectResourceOutboxLifecycleExpectation,
): void {
    expectDirectResourceOutboxEvidence(entries, expected.entries);
    const byResourceId = new Map(entries.map((entry) => [entry.resourceId, entry]));
    for (const link of expected.appToWsLinks) {
        const appEntry = byResourceId.get(link.appResourceId);
        const wsEntry = byResourceId.get(link.wsResourceId);
        if (!appEntry || !wsEntry) {
            throw new Error(`Missing APP_OUTBOX/WS_OUTBOX link: ${link.appResourceId}`);
        }
        expectAppOutboxWsLink(appEntry, wsEntry, link.linkIdentity);
    }
}
