import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    type ResourceInboxReleaseDisposition,
    toResourceInboxReleaseDisposition,
} from '@shared/queuebox/QueueBoxTypes.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { type ResourceInboxRow, toDomain } from './repository-utils.ts';

export async function requeueObservedResourceInboxDeliveryFailure(
    sql: PSqlSql,
    observed: ResourceEntry,
    releaseInput: ResourceInboxReleaseDisposition,
): Promise<ResourceEntry | null> {
    const disposition = toResourceInboxReleaseDisposition(releaseInput);
    const releasedAt = new Date();
    const nextTs = disposition.delayMs === null
        ? null
        : new Date(releasedAt.getTime() + disposition.delayMs);
    const rows = await sql<ResourceInboxRow[]>`
        update resource_inbox
        set ri_status = ${disposition.status}, end_ts = ${releasedAt}, next_ts = ${nextTs}
        where ri_topic_id = ${observed.key.topicId}
          and ri_resource_id = ${observed.key.resourceId}
          and fk_ext_bank_id = ${observed.key.contextId}
          and ri_type_id = ${observed.typeId}
          and ri_resource = ${observed.resource}
          and ri_attempts = ${observed.dequeueAudit.attempts}
          and (ri_status = ${EntityStatus.RESERVED} or ri_status = ${EntityStatus.COMPLETED})
          and expire_ts > (now() at time zone 'UTC')
        returning *
    `;
    return rows.length === 1 ? toDomain(rows[0]) : null;
}
