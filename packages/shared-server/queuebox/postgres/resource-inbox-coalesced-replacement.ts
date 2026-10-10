import {
    COMPLETED_STATUSES,
    EntityStatus,
    isFailed,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlSql } from '../../postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from './p-sql-resource-inbox-entry-repository.ts';
import { toDomain, type ResourceInboxRow } from './resource-inbox-row-codec.ts';

export interface ResourceInboxCoalescedReplacement {
    readonly operation: 'replace-pending' | 'replace-finished';
    readonly key: Key;
    readonly typeId: string;
    readonly expectedStatus: EntityStatus;
    readonly expectedResource: string;
    readonly expectedGeneration: number;
    readonly expectedAttempts: number;
    readonly resource: string;
    readonly status: EntityStatus;
    readonly nextAt: string | null;
    readonly expiresAt: string;
}

export interface ResourceInboxCoalescedReplacementCandidate {
    readonly entry: ResourceEntry;
    readonly nextAt: string | null;
    readonly expiresAt: string;
}

export function computeResourceInboxCoalescedReplacement(
    expected: ResourceEntry,
    candidate: ResourceInboxCoalescedReplacementCandidate,
    expectedGeneration: number
): ResourceInboxCoalescedReplacement {
    const next = candidate.entry;
    const finished = COMPLETED_STATUSES.has(expected.status) || isFailed(expected.status);
    if (
        expected.key.topicId !== next.key.topicId ||
        expected.key.resourceId !== next.key.resourceId ||
        expected.key.contextId !== next.key.contextId ||
        expected.typeId !== next.typeId ||
        (!finished && expected.status !== EntityStatus.NEW && expected.status !== EntityStatus.RETRY) ||
        (next.status !== EntityStatus.NEW && next.status !== EntityStatus.RETRY) ||
        next.dequeueAudit.attempts !== (finished ? 0 : expected.dequeueAudit.attempts) ||
        !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1
    ) {
        throw new ResourceInboxInvariantCorruptionError(
            next.key,
            'Resource inbox coalesced replacement identity or lifecycle differs'
        );
    }
    return {
        operation: finished ? 'replace-finished' : 'replace-pending',
        key: { ...expected.key },
        typeId: expected.typeId,
        expectedStatus: expected.status,
        expectedResource: expected.resource,
        expectedGeneration,
        expectedAttempts: expected.dequeueAudit.attempts,
        resource: next.resource,
        status: next.status,
        nextAt: candidate.nextAt,
        expiresAt: candidate.expiresAt
    };
}

/** An exact content/status/generation CAS; a miss leaves the observed row intact. */
export async function writeResourceInboxCoalescedReplacement(
    transaction: PSqlSql,
    computed: ResourceInboxCoalescedReplacement
): Promise<ResourceEntry | null> {
    const rows = computed.operation === 'replace-finished'
        ? await writeFinishedCoalescedReplacement(transaction, computed)
        : await writePendingCoalescedReplacement(transaction, computed);
    if (rows.length === 0) {
        return null;
    }
    if (rows.length !== 1) {
        throw new ResourceInboxInvariantCorruptionError(
            computed.key,
            'Resource inbox coalesced replacement returned an unexpected row count'
        );
    }
    const updated = toDomain(rows[0]);
    if (
        updated.resource !== computed.resource || updated.status !== computed.status ||
        updated.typeId !== computed.typeId
    ) {
        throw new ResourceInboxInvariantCorruptionError(
            computed.key,
            'Resource inbox coalesced replacement returned different content'
        );
    }
    return updated;
}

function writeFinishedCoalescedReplacement(
    transaction: PSqlSql,
    computed: ResourceInboxCoalescedReplacement
): Promise<ResourceInboxRow[]> {
    return transaction<ResourceInboxRow[]>`
            update resource_inbox
            set ri_resource = ${computed.resource},
                ri_status = ${computed.status},
                next_ts = ${computed.nextAt},
                ri_attempts = 0,
                start_ts = null,
                end_ts = null,
                expire_ts = ${computed.expiresAt}
            where ri_topic_id = ${computed.key.topicId}
              and ri_resource_id = ${computed.key.resourceId}
              and fk_ext_bank_id = ${computed.key.contextId}
              and ri_type_id = ${computed.typeId}
              and ri_status = ${computed.expectedStatus}
              and ri_resource = ${computed.expectedResource}
              and (((ri_resource::jsonb #>> '{payload,resource}')::jsonb
                    #>> '{data,__rallarCoalescedWork,generation}')::bigint) =
                  ${computed.expectedGeneration}
            returning *
        `;
}

function writePendingCoalescedReplacement(
    transaction: PSqlSql,
    computed: ResourceInboxCoalescedReplacement
): Promise<ResourceInboxRow[]> {
    return transaction<ResourceInboxRow[]>`
            update resource_inbox
            set ri_resource = ${computed.resource},
                ri_status = ${computed.status},
                next_ts = ${computed.nextAt}
            where ri_topic_id = ${computed.key.topicId}
              and ri_resource_id = ${computed.key.resourceId}
              and fk_ext_bank_id = ${computed.key.contextId}
              and ri_type_id = ${computed.typeId}
              and ri_status = ${computed.expectedStatus}
              and ri_resource = ${computed.expectedResource}
              and (((ri_resource::jsonb #>> '{payload,resource}')::jsonb
                    #>> '{data,__rallarCoalescedWork,generation}')::bigint) =
                  ${computed.expectedGeneration}
              and ri_attempts = ${computed.expectedAttempts}
            returning *
        `;
}
