import type { BlackBoxRallarGenerationPort } from '../ports.ts';
import type { BlackBoxRallarTopicSubscriptions } from './black-box-rallar-topic-subscriptions.ts';

export interface BlackBoxRallarMessagingLease {
    readonly generation: number;
}

export interface BlackBoxRallarMessagingResourceController {
    lease(): BlackBoxRallarMessagingLease;
    assertCurrent(lease: BlackBoxRallarMessagingLease, message: string): void;
    ensureWsSubscription(key: string, subscribe: () => () => void): void;
    cleanupWsSubscriptions(): number;
    setTopicSubscription(subscriptionId: string, held: BlackBoxRallarTopicSubscriptions.HeldToken): void;
    getTopicSubscription(subscriptionId: string): BlackBoxRallarTopicSubscriptions.HeldToken | undefined;
    /** In the order the recipe took them. */
    listTopicSubscriptions(): ReadonlyMap<string, BlackBoxRallarTopicSubscriptions.HeldToken>;
    /** Releases every held token, so a next connect on the same page inherits no election. */
    cleanupTopicSubscriptions(): number;
}

export function createBlackBoxRallarMessagingResourceController(
    generations: BlackBoxRallarGenerationPort
): BlackBoxRallarMessagingResourceController {
    const wsSubscriptions = new Map<string, () => void>();
    const topicSubscriptions = new Map<string, BlackBoxRallarTopicSubscriptions.HeldToken>();

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
        },
        setTopicSubscription: (subscriptionId, held) => {
            topicSubscriptions.set(subscriptionId, held);
        },
        getTopicSubscription: (subscriptionId) => topicSubscriptions.get(subscriptionId),
        listTopicSubscriptions: () => topicSubscriptions,
        cleanupTopicSubscriptions: () => {
            const held = [...topicSubscriptions.values()];
            topicSubscriptions.clear();
            for (const { token } of held) {
                void token.unsubscribe();
            }
            return held.length;
        }
    };
}
