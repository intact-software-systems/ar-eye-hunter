import type { ResourceInboxContextClaim } from '../queue-box-types.ts';
import type { Key } from '../ResourceEntry.ts';

/** The contexts a context claim may no longer take a row from: those its caller excluded and those it has taken. */
export class ResourceInboxClaimedContexts {
    private readonly contextIds: Set<string>;

    constructor(claim: ResourceInboxContextClaim) {
        this.contextIds = new Set(claim.excludedContextIds);
    }

    admits(key: Key): boolean {
        return !this.contextIds.has(key.contextId);
    }

    record(key: Key): void {
        this.contextIds.add(key.contextId);
    }
}
