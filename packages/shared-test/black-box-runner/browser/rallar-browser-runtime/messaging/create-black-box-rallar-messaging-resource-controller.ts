import type { BlackBoxRallarGenerationPort } from '../ports.ts';

export interface BlackBoxRallarMessagingLease {
    readonly generation: number;
}

export interface BlackBoxRallarMessagingResourceController {
    lease(): BlackBoxRallarMessagingLease;
    assertCurrent(lease: BlackBoxRallarMessagingLease, message: string): void;
    ensureWsSubscription(key: string, subscribe: () => () => void): void;
    cleanupWsSubscriptions(): number;
}

export function createBlackBoxRallarMessagingResourceController(
    generations: BlackBoxRallarGenerationPort
): BlackBoxRallarMessagingResourceController {
    const wsSubscriptions = new Map<string, () => void>();

    return {
        lease: () => ({ generation: generations.generation() }),
        assertCurrent: (lease, message) => {
            if (!generations.isCurrent(lease.generation)) {
                throw new Error(message);
            }
        },
        ensureWsSubscription: (key, subscribe) => {
            if (!wsSubscriptions.has(key)) {
                wsSubscriptions.set(key, subscribe());
            }
        },
        cleanupWsSubscriptions: () => {
            const subscriptions = [...wsSubscriptions.values()];
            wsSubscriptions.clear();
            for (const unsubscribe of subscriptions) {
                unsubscribe();
            }
            return subscriptions.length;
        }
    };
}
