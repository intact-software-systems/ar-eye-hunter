import { Temporal } from '@js-temporal/polyfill';

import { Either } from '../resilience/Either.ts';
import {
    ResourceInboxInvalidReleaseDispositionError,
    type ResourceInboxReleaseDisposition
} from './queue-box-types.ts';
import { EntityStatus, type ResourceEntry } from './ResourceEntry.ts';

export function computeResourceInboxRelease(
    reserved: ResourceEntry,
    disposition: ResourceInboxReleaseDisposition,
    releasedAt: Temporal.Instant
): ResourceEntry {
    const notReady = disposition.status === EntityStatus.RETRY && disposition.reason === 'not-ready';
    const attempts = notReady
        ? reserved.dequeueAudit.attempts - 1
        : reserved.dequeueAudit.attempts;
    const retryAt = disposition.delayMs !== null ? releasedAt.add({ milliseconds: disposition.delayMs }) : undefined;
    const nextTs = notReady && retryAt !== undefined && Temporal.Instant.compare(retryAt, reserved.audit.expiryTs) > 0
        ? reserved.audit.expiryTs
        : retryAt;
    return {
        ...reserved,
        status: disposition.status,
        dequeueAudit: {
            startTs: reserved.dequeueAudit.startTs,
            endTs: releasedAt,
            nextTs,
            attempts
        }
    };
}

export function validateResourceInboxReleaseDisposition(
    input: ResourceInboxReleaseDisposition
): Either<ResourceInboxInvalidReleaseDispositionError, ResourceInboxReleaseDisposition> {
    if (typeof input !== 'object' || input === null) {
        return Either.ofLeft(new ResourceInboxInvalidReleaseDispositionError());
    }
    const status = 'status' in input ? input.status : undefined;
    const delayMs = 'delayMs' in input ? input.delayMs : undefined;
    const reason = 'reason' in input ? input.reason : undefined;
    if (
        status === EntityStatus.RETRY &&
        typeof delayMs === 'number' &&
        Number.isSafeInteger(delayMs) &&
        delayMs >= 1 &&
        (reason === undefined || reason === 'not-ready')
    ) {
        return Either.ofRight(reason === 'not-ready' ? { status, delayMs, reason } : { status, delayMs });
    }

    if (delayMs === null && reason === undefined) {
        switch (status) {
            case EntityStatus.COMPLETED:
            case EntityStatus.FAILED:
            case EntityStatus.ABORTED:
            case EntityStatus.NON_RETRYABLE:
            case EntityStatus.PARTITIONED:
            case EntityStatus.MERGED:
                return Either.ofRight({ status, delayMs });
        }
    }

    return Either.ofLeft(new ResourceInboxInvalidReleaseDispositionError());
}
