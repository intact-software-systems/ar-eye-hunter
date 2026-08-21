import { COMPLETED_STATUSES, EntityStatus, isFailed, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { PSqlTransactionSql } from '../PostgresSqlClient.ts';
import { toDomain, toPgTimestamp, type ResourceInboxRow } from './repository-utils.ts';
import { ResourceInboxInvariantCorruptionError } from './ResourceInboxRepository.ts';

export interface ReplaceFinishedResourceEntryInput {
    readonly expected: ResourceEntry;
    readonly next: ResourceEntry;
    readonly expectedGeneration: number;
}

/**
 * Revives a terminally finished coalesced APP_OUTBOX row in place: an exact
 * content, status, and stored-generation compare-and-set that resets the
 * dequeue lifecycle to a fresh attempt. A miss returns null so the caller can
 * fall back to a successor queue identity.
 */
export async function replaceFinishedResourceEntryIfMatch(
    sql: PSqlTransactionSql,
    input: ReplaceFinishedResourceEntryInput
): Promise<ResourceEntry | null> {
    const { expected, next, expectedGeneration } = input;
    if (
        expected.key.topicId !== next.key.topicId ||
        expected.key.resourceId !== next.key.resourceId ||
        expected.key.contextId !== next.key.contextId ||
        expected.typeId !== next.typeId ||
        !(COMPLETED_STATUSES.has(expected.status) || isFailed(expected.status)) ||
        !([EntityStatus.NEW, EntityStatus.RETRY] as readonly EntityStatus[])
            .includes(next.status) ||
        next.dequeueAudit.attempts !== 0 ||
        !Number.isSafeInteger(expectedGeneration) ||
        expectedGeneration < 1
    ) {
        throw new ResourceInboxInvariantCorruptionError(
            next.key,
            'Resource inbox finished replacement identity or lifecycle differs'
        );
    }

    const rows = await sql<ResourceInboxRow[]>`
        update resource_inbox
        set ri_resource = ${next.resource},
            ri_status = ${next.status},
            next_ts = ${
        next.dequeueAudit.nextTs
            ? toPgTimestamp(next.dequeueAudit.nextTs)
            : null
    },
            ri_attempts = 0,
            start_ts = null,
            end_ts = null,
            expire_ts = ${toPgTimestamp(next.audit.expiryTs)}
        where ri_topic_id = ${expected.key.topicId}
          and ri_resource_id = ${expected.key.resourceId}
          and fk_ext_bank_id = ${expected.key.contextId}
          and ri_type_id = ${expected.typeId}
          and ri_status = ${expected.status}
          and ri_resource = ${expected.resource}
          and (((ri_resource::jsonb #>> '{payload,resource}')::jsonb
                #>> '{data,__rallarCoalescedWork,generation}')::bigint) =
              ${expectedGeneration}
        returning *
    `;

    if (rows.length === 0) {
        return null;
    }
    if (rows.length !== 1) {
        throw new ResourceInboxInvariantCorruptionError(
            next.key,
            'Resource inbox finished replacement returned an unexpected row count'
        );
    }

    const revived = toDomain(rows[0]);
    if (
        revived.resource !== next.resource ||
        revived.status !== next.status ||
        revived.typeId !== next.typeId
    ) {
        throw new ResourceInboxInvariantCorruptionError(
            next.key,
            'Resource inbox finished replacement returned different content'
        );
    }
    return revived;
}
