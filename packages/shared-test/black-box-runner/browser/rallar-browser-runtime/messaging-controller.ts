import type { BlackBoxRallarGenerationPort } from './ports.ts';

export type BlackBoxRallarMessagingLease = Readonly<{
    generation: number;
}>;

export type BlackBoxRallarMessagingController = Readonly<{
    lease(): BlackBoxRallarMessagingLease;
    assertCurrent(lease: BlackBoxRallarMessagingLease, message: string): void;
    ensureWsSubscription(key: string, subscribe: () => () => void): void;
    cleanupWsSubscriptions(): number;
}>;

export type CreateBlackBoxRallarMessagingControllerOptions = BlackBoxRallarGenerationPort;

export function createBlackBoxRallarMessagingController(
    options: CreateBlackBoxRallarMessagingControllerOptions,
): BlackBoxRallarMessagingController {
    const wsSubscriptions = new Map<string, () => void>();

    return {
        lease: () => ({ generation: options.generation() }),
        assertCurrent: (lease, message) => {
            if (!options.isCurrent(lease.generation)) {
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
        },
    };
}
