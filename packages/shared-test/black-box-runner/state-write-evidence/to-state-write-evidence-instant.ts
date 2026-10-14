import { Temporal } from '@js-temporal/polyfill';

import { toInstant } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';

/** SQL text contains UTC wall-clock fields; driver Date values already carry an absolute epoch. */
export function toStateWriteEvidenceInstant(
    timestamp: Date | string
): Temporal.Instant {
    return timestamp instanceof Date
        ? Temporal.Instant.fromEpochMilliseconds(timestamp.getTime())
        : toInstant(timestamp);
}
