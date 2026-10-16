import { BoundedConcurrencyAdmission } from '../../resilience/bounded-concurrency-admission.ts';
import {
    ResourceInboxLostReservationError,
    type DequeueResourceEntryRepository,
    type ResourceInboxRelease
} from '../queue-box-types.ts';
import type * as Resource from '../ResourceEntry.ts';

/** How many rows of a lost round release at once, each in its own transaction, against a pool of five. */
export const RESOURCE_INBOX_EACH_ALONE_RELEASE_CONCURRENCY = 2;

export type ResourceInboxRoundReleaser = Pick<DequeueResourceEntryRepository, 'releaseEntries'>;

export interface ResourceInboxRoundRelease {
    readonly released: ReadonlyMap<Resource.Key, Resource.ResourceEntry>;
    /** A reservation another owner took meanwhile; every other row of the round is released regardless. */
    readonly lost: ResourceInboxLostReservationError | undefined;
}

/**
 * A round releases in one transaction. A reservation lost meanwhile rolls that transaction back whole, so each row then
 * releases alone: the lost one rejects and the rest complete now instead of waiting out their leases.
 */
export async function releaseResourceInboxRound(
    repository: ResourceInboxRoundReleaser,
    releases: readonly ResourceInboxRelease[]
): Promise<ResourceInboxRoundRelease> {
    if (releases.length === 0) {
        return { released: new Map(), lost: undefined };
    }
    try {
        return { released: await repository.releaseEntries(releases), lost: undefined };
    }
    catch (error) {
        if (!(error instanceof ResourceInboxLostReservationError) || releases.length === 1) {
            throw error;
        }
    }
    return await releaseResourceInboxEachAlone(repository, releases);
}

async function releaseResourceInboxEachAlone(
    repository: ResourceInboxRoundReleaser,
    releases: readonly ResourceInboxRelease[]
): Promise<ResourceInboxRoundRelease> {
    const releasing = new BoundedConcurrencyAdmission({ maxConcurrent: RESOURCE_INBOX_EACH_ALONE_RELEASE_CONCURRENCY });
    const outcomes = await Promise.allSettled(
        releases.map((release) => releasing.admit(() => repository.releaseEntries([release])))
    );
    const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
    const unexpected = failures.find((reason) => !(reason instanceof ResourceInboxLostReservationError));
    if (unexpected !== undefined) {
        throw unexpected;
    }
    return {
        released: new Map(outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? [...outcome.value] : [])),
        lost: failures[0]
    };
}
