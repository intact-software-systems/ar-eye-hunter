import { Either } from '../../resilience/Either.ts';
import type { ALStorageOpening } from '../open-indexed-db-admission-database.ts';
import type { ALStorageRecoveryOutcome } from './al-storage-event.ts';
import type { ALStorageHealth } from './al-storage-health.ts';
import type { ALStorageUnavailable } from './al-storage-unavailable.ts';

type ALStorageRecovery = Either<ALStorageUnavailable, ALStorageRecoveryOutcome>;

interface ALStorageBootstrap {
    readonly claimedCount: number;
    readonly expiredCount: number;
}

/**
 * Reports one lane's recovery of a durable store for this connect; only a pair whose backend opened
 * IndexedDB has one. A store two lanes share has one reporter per lane.
 */
export interface ALStorageRecoveryReporter {
    /** The lane's first work batch ended: its claims are what the lane restored. Later batches report nothing. */
    reportFirstBatch(claimedCount: number): void;
}

/** One lane of a store two lanes share: its outcome names it, and counts only the rows of its own work type. */
export interface ALStorageRecoveryLane {
    readonly name: string;
    readonly workTypeId: string;
}

export interface CreateALStorageRecoveryReporterInput {
    /** What the store's latest open found; undefined before its first open. */
    readonly getStorageOpening: () => ALStorageOpening | undefined;
    /** The expired rows the lane's reservations deleted, up to the report. */
    readonly getReservationExpiredDeleteCount: () => number;
    /** The store's health: a recovery is stated through it, and an eviction is a failure of it. */
    readonly storageHealth: ALStorageHealth;
    /** The lane named on the outcome; `undefined` for a store one lane owns. */
    readonly lane: string | undefined;
}

export function createALStorageRecoveryReporter(
    input: CreateALStorageRecoveryReporterInput
): ALStorageRecoveryReporter {
    let reported = false;
    return {
        reportFirstBatch(claimedCount) {
            const opening = input.getStorageOpening();
            if (reported || opening === undefined) {
                return;
            }
            reported = true;
            const expiredCount = input.getReservationExpiredDeleteCount();
            computeALStorageRecovery(opening, { claimedCount, expiredCount }).fold(
                (failure) => input.storageHealth.recordFailure(failure),
                (outcome) => input.storageHealth.recordRecovery(outcome, input.lane)
            );
        }
    };
}

/** A reset wins over the creation it caused; only a database that already existed restores anything. */
function computeALStorageRecovery(opening: ALStorageOpening, bootstrap: ALStorageBootstrap): ALStorageRecovery {
    switch (opening.kind) {
        case 'reset':
            return Either.ofRight({ kind: 'storage-reset', reason: opening.reason });
        case 'created':
            return Either.ofRight({ kind: 'storage-created' });
        case 'evicted':
            return Either.ofLeft({
                cause: 'evicted',
                detail: 'A database this document opened was created again without a versionchange.'
            });
        case 'existing':
            return Either.ofRight(computeALStorageRestoredOutcome(bootstrap));
    }
}

function computeALStorageRestoredOutcome(bootstrap: ALStorageBootstrap): ALStorageRecoveryOutcome {
    return bootstrap.claimedCount === 0 && bootstrap.expiredCount > 0
        ? { kind: 'expired-at-recovery', expired: bootstrap.expiredCount }
        : { kind: 'restored', claimed: bootstrap.claimedCount, expired: bootstrap.expiredCount };
}
