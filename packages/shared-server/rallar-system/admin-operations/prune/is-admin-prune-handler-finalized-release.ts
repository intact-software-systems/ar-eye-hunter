import { Temporal } from '@js-temporal/polyfill';

import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceInboxReleaseDisposition } from '@shared/queuebox/queue-box-types.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    isKeysEqual,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import {
    ADMIN_PRUNE_APP_OUTBOX_TOPIC,
    decodeAdminPruneOutboxMessage,
    decodeAdminPruneWork
} from './admin-prune-page-codec.ts';

/** Recognizes only the same admin page atomically completed by its reservation owner. */
export function isAdminPruneHandlerFinalizedRelease(
    current: ResourceEntry,
    reserved: ResourceEntry,
    disposition: ResourceInboxReleaseDisposition
): boolean {
    try {
        if (
            reserved.typeId !== EnqueuedType.APP_OUTBOX || current.typeId !== reserved.typeId ||
            reserved.key.topicId !== ADMIN_PRUNE_APP_OUTBOX_TOPIC || current.key.topicId !== reserved.key.topicId ||
            disposition.status !== EntityStatus.COMPLETED || disposition.delayMs !== null ||
            reserved.status !== EntityStatus.RESERVED || current.status !== EntityStatus.COMPLETED ||
            !isKeysEqual(current.key, reserved.key) || current.resource !== reserved.resource ||
            current.db?.id !== reserved.db?.id ||
            !Number.isSafeInteger(reserved.dequeueAudit.attempts) || reserved.dequeueAudit.attempts < 1 ||
            current.dequeueAudit.attempts !== reserved.dequeueAudit.attempts
        ) {
            return false;
        }
        if (!hasCanonicalAdminPruneTimestamps(current) || !hasCanonicalAdminPruneTimestamps(reserved)) {
            return false;
        }
        if (
            !reserved.dequeueAudit.startTs || !current.dequeueAudit.startTs || !current.dequeueAudit.endTs ||
            current.dequeueAudit.nextTs !== undefined ||
            !Temporal.Instant.prototype.equals.call(current.dequeueAudit.startTs, reserved.dequeueAudit.startTs) ||
            current.audit.createdBy !== reserved.audit.createdBy ||
            !Temporal.PlainDateTime.prototype.equals.call(current.audit.createdTs, reserved.audit.createdTs) ||
            !Temporal.PlainTime.prototype.equals.call(current.audit.date, reserved.audit.date) ||
            !Temporal.PlainTime.prototype.equals.call(
                reserved.audit.date,
                Temporal.PlainDateTime.prototype.toPlainTime.call(reserved.audit.createdTs)
            ) ||
            !Temporal.Instant.prototype.equals.call(current.audit.expiryTs, reserved.audit.expiryTs) ||
            isExpiredResourceEntry(current)
        ) {
            return false;
        }
        decodeAdminPruneWork(reserved);
        decodeAdminPruneOutboxMessage(current);
        return true;
    }
    catch {
        return false;
    }
}

function hasCanonicalAdminPruneTimestamps(entry: ResourceEntry): boolean {
    // Temporal prototype methods verify the internal brand even when a
    // malformed value spoofs its prototype or overrides equality/string output.
    return entry.audit.date instanceof Temporal.PlainTime &&
        entry.audit.createdTs instanceof Temporal.PlainDateTime &&
        Temporal.PlainTime.prototype.equals.call(entry.audit.date, entry.audit.date) &&
        Temporal.PlainDateTime.prototype.equals.call(entry.audit.createdTs, entry.audit.createdTs) &&
        isCanonicalAdminPruneInstant(entry.audit.expiryTs) &&
        (entry.dequeueAudit.startTs === undefined || isCanonicalAdminPruneInstant(entry.dequeueAudit.startTs)) &&
        (entry.dequeueAudit.endTs === undefined || isCanonicalAdminPruneInstant(entry.dequeueAudit.endTs)) &&
        (entry.dequeueAudit.nextTs === undefined || isCanonicalAdminPruneInstant(entry.dequeueAudit.nextTs));
}

function isCanonicalAdminPruneInstant(value: Temporal.Instant): boolean {
    return value instanceof Temporal.Instant && Temporal.Instant.prototype.equals.call(value, value);
}
