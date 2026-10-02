import { LatestRepository } from '../../cache/LatestRepository.ts';
import type { ALStorageOpening } from '../open-indexed-db-admission-database.ts';

/** One store of a connect, opening a database the connect's other stores share. */
export interface ALStorageConnectStoreOpening {
    readonly openings: ALStorageConnectOpenings;
    readonly storeNamespace: string;
}

interface ALStorageConnectRenewal {
    readonly opening: ALStorageOpening;
    readonly storeNamespaces: readonly string[];
}

/**
 * The creations, resets and evictions one connect's stores found, by database. The stores of a session
 * share one database, so the store whose open found one is not the only store it is new to: each store
 * of the connect reports it once, at its first open after it. A later connect has its own and reads the
 * database as it is.
 */
export class ALStorageConnectOpenings {
    private readonly renewals = new LatestRepository<string, ALStorageConnectRenewal>();

    /** Answers what the store reports: its own open's finding, or the connect's renewal it has not read yet. */
    recordStoreOpening(dbName: string, storeNamespace: string, found: ALStorageOpening): ALStorageOpening {
        if (found.kind !== 'existing') {
            this.renewals.set(dbName, { opening: found, storeNamespaces: [storeNamespace] });
            return found;
        }
        const renewal = this.renewals.read(dbName);
        if (renewal === undefined || renewal.storeNamespaces.includes(storeNamespace)) {
            return found;
        }
        this.renewals.set(dbName, { ...renewal, storeNamespaces: [...renewal.storeNamespaces, storeNamespace] });
        return renewal.opening;
    }
}
