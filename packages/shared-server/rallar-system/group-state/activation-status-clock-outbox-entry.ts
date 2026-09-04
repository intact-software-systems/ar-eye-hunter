import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupActivationCondition } from '@shared/api/group-lifecycle/activation-status/compute-group-activation-condition.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { fnv1a64, toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { AppOutboxType } from '../app-outbox/app-outbox-type.ts';
import { groupStateGroupStorageKey } from './persistence/aggregate/group-aggregate-storage-keys.ts';

export const APP_OUTBOX_ACTIVATION_STATUS_CLOCK_TOPIC = 'app-outbox.activation-status-clock';

/**
 * The durable time leg of the observed status (product decision 19). A band
 * that is reachable only with the dwell satisfied is not published by the
 * evidence that implied it; this entry is armed instead, and its handler
 * re-reads and publishes only if the band still holds.
 *
 * Entries are inserted with `dequeueAudit.nextTs` at their due time, so the
 * queue's own visibility filter (`next_ts <= now()`) keeps them invisible
 * until then -- no polling, and no in-process timer to lose when the arming
 * node dies.
 */
export const GROUP_ACTIVATION_STATUS_CLOCK_KINDS = ['dwell', 'evidence-expiry'] as const;

export type GroupActivationStatusClockKind = (typeof GROUP_ACTIVATION_STATUS_CLOCK_KINDS)[number];

export type GroupActivationStatusClockWork = Readonly<{
    /**
     * `dwell` confirms a band only a clock may publish. `evidence-expiry` is
     * the heartbeat that lets a quiet group report decay at all: coverage falls
     * when measurements age out of the freshness window, and that is the
     * absence of evidence, so nothing else would ever wake the group.
     */
    kind: GroupActivationStatusClockKind;
    groupRef: GroupRef;
    /** With the basis, the causal series this dwell belongs to. */
    formationEpoch: number;
    coverageBasisLayoutIdentity: GroupLayoutIdentity;
    /**
     * The band a `dwell` exists to confirm; a different band is a fresh
     * series. Null for `evidence-expiry`, which confirms nothing and only
     * asks the group to look again.
     */
    candidateCondition: GroupActivationCondition | null;
    dueAtEpochMs: number;
}>;

export interface ComputeActivationStatusClockEntryInput {
    readonly work: GroupActivationStatusClockWork;
    readonly senderId: string;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
}

/**
 * The key is the series and the band, which makes a second arming inside one
 * dwell a duplicate rather than a reset. That is the semantic the product
 * wants: a dwell measures how long a band has held *continuously*, so a
 * reading that re-observes the same band must not push the deadline out. It
 * also makes the arm idempotent across a cluster -- N nodes observing the
 * same dip write one row, not N.
 */
export function computeActivationStatusClockEntry(
    input: ComputeActivationStatusClockEntryInput
): ResourceEntry {
    const work = input.work;
    const contextId = groupStateGroupStorageKey(work.groupRef);
    const seriesIdentity = fnv1a64(
        `${contextId}:${work.coverageBasisLayoutIdentity.groupRevision}:` +
            `${work.coverageBasisLayoutIdentity.presenceRevision}:${work.coverageBasisLayoutIdentity.version}:` +
            `${work.coverageBasisLayoutIdentity.state}`
    );
    const key = toAppQueueKey({
        topicId: APP_OUTBOX_ACTIVATION_STATUS_CLOCK_TOPIC,
        resourceId: `as-${
            work.kind === 'dwell' ? work.candidateCondition : 'expiry'
        }-${work.formationEpoch}-${seriesIdentity}`,
        contextId
    });
    const createdBy = toAppQueueCreatedBy(input.senderId);
    const createdTs = Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        typeId: EnqueuedType.APP_OUTBOX,
        resource: JSON.stringify(toActivationStatusClockMessage(input, work, key, createdBy)),
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy,
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(input.expireAtEpochMs)
        },
        dequeueAudit: {
            attempts: 0,
            nextTs: Temporal.Instant.fromEpochMilliseconds(work.dueAtEpochMs)
        }
    };
}

function toActivationStatusClockMessage(
    input: ComputeActivationStatusClockEntryInput,
    work: GroupActivationStatusClockWork,
    key: ReturnType<typeof toAppQueueKey>,
    createdBy: string
): ALMessage {
    return {
        id: { v: 2, msgId: key.resourceId, ts: input.createdAtEpochMs, senderId: createdBy },
        route: key,
        constraints: { expiresAtMs: input.expireAtEpochMs },
        ordering: { orderingKey: key.contextId, epoch: work.formationEpoch, seq: 0 },
        delivery: { ownership: 'exclusive', reliability: 'at-least-once', ack: 'none' },
        payload: {
            typeId: AppOutboxType.ACTIVATION_STATUS_CLOCK,
            contentType: 'application/json',
            resource: JSON.stringify(work)
        }
    };
}

/** Decodes the armed clock from its durable entry. */
export function decodeActivationStatusClockWork(resource: string): GroupActivationStatusClockWork {
    const message = JSON.parse(resource) as { payload?: { resource?: unknown; }; };
    const payloadResource = message.payload?.resource;
    if (typeof payloadResource !== 'string') {
        throw new TypeError('Activation status clock message payload is invalid');
    }
    return JSON.parse(payloadResource) as GroupActivationStatusClockWork;
}
