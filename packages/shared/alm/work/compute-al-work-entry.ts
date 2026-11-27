import { Temporal } from '@js-temporal/polyfill';

import { EntityStatus, type Key, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';

export interface ALWorkEntryInput {
    readonly key: Key;
    readonly typeId: string;
    readonly resource: string;
    readonly observedAtMs: number;
    readonly readyAtMs: number;
    readonly expireAtTimestamp: number;
}

export function computeALWorkEntry(input: ALWorkEntryInput): ResourceEntry {
    const createdTs = Temporal.Instant.fromEpochMilliseconds(input.observedAtMs).toZonedDateTimeISO('UTC');
    return {
        key: input.key,
        typeId: input.typeId,
        resource: input.resource,
        audit: {
            createdBy: 'ALM',
            createdTs: createdTs.toPlainDateTime(),
            date: createdTs.toPlainTime(),
            expiryTs: Temporal.Instant.fromEpochMilliseconds(input.expireAtTimestamp)
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0, nextTs: Temporal.Instant.fromEpochMilliseconds(input.readyAtMs) },
        db: undefined
    };
}
