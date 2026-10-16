import type { ResourceInboxClaimOrder } from '../queue-box-types.ts';
import type { Key } from '../ResourceEntry.ts';

/** The contexts one claim has taken a row from; in `oldest-per-context` order a second row of a context is refused. */
export class ResourceInboxClaimedContexts {
    private readonly claimOrder: ResourceInboxClaimOrder;
    private readonly contextIds = new Set<string>();

    constructor(claimOrder: ResourceInboxClaimOrder) {
        this.claimOrder = claimOrder;
    }

    admits(key: Key): boolean {
        return this.claimOrder === 'queue' || !this.contextIds.has(key.contextId);
    }

    record(key: Key): void {
        this.contextIds.add(key.contextId);
    }
}
