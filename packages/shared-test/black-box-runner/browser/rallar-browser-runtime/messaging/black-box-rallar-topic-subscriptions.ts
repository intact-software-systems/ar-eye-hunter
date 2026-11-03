import type {
    RallarTopicSubscription,
    RallarTopicSubscriptionStatus
} from '@shared-web/browser/messages/rallar-message-contracts.ts';

import type { BlackBoxRallarConnectionConfig } from '../black-box-rallar-operation-contracts.ts';
import { blackBoxRallarRoomRefOf } from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxBrowserProductSocketDependency } from '../browser-rallar-runtime-composition.ts';
import { resolveBlackBoxRallarTypeId } from '../connection/black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarTypedChannels, TypedChannelRoute } from './black-box-rallar-typed-channels.ts';
import type { BlackBoxRallarMessagingResourceController } from './create-black-box-rallar-messaging-resource-controller.ts';

export namespace BlackBoxRallarTopicSubscriptions {
    export interface Input {
        readonly typedChannels: BlackBoxRallarTypedChannels;
        readonly resources: BlackBoxRallarMessagingResourceController;
        readonly productSocket: Pick<BlackBoxBrowserProductSocketDependency, 'readConnectionGenerationId'>;
        readonly delay: (ms: number) => Promise<void>;
        requireConfig(): BlackBoxRallarConnectionConfig;
    }

    export interface SubscribeInput {
        readonly connection: string;
        readonly subscriptionId: string;
        /** How long the page waits for the token to leave `pending` before it reports the status it holds. */
        readonly timeoutMs: number;
    }

    export interface UnsubscribeInput {
        readonly connection: string;
        readonly subscriptionId: string;
    }

    export interface ReadInput {
        readonly connection: string;
    }

    export interface Diagnostics {
        readonly subscriptionId: string;
        readonly status: RallarTopicSubscriptionStatus;
    }

    export interface Entry extends Diagnostics {
        readonly topicId: string;
    }

    export interface Readout {
        readonly connectionGenerationId: string | null;
        readonly subscriptions: readonly Entry[];
    }

    /** The connect's granted selector topic, which every token of the page elects. */
    export interface GrantedRoute extends TypedChannelRoute {
        readonly topicId: string;
    }

    /** A token the page holds under the recipe's id, beside the topic it elected. */
    export interface HeldToken {
        readonly topicId: string;
        readonly token: RallarTopicSubscription;
    }
}

/**
 * The tokens `messages.subscribe` takes on the connect's granted selector topic. Their handler does nothing: the
 * connect's own subscription records every delivery, so the inbound ledger stays the one evidence of arrival. A
 * subscriptionId names one election: subscribing it again once its token was refused or lapsed takes a new token.
 */
export class BlackBoxRallarTopicSubscriptions {
    readonly #input: BlackBoxRallarTopicSubscriptions.Input;

    constructor(input: BlackBoxRallarTopicSubscriptions.Input) {
        this.#input = input;
    }

    subscribe = async (
        subscribe: BlackBoxRallarTopicSubscriptions.SubscribeInput
    ): Promise<BlackBoxRallarTopicSubscriptions.Diagnostics> => {
        const { subscriptionId } = subscribe;
        const held = this.#input.resources.getTopicSubscription(subscriptionId)?.token.status();
        if (held === 'pending' || held === 'active') {
            throw new TypeError(
                `messages.subscribe names subscriptionId ${subscriptionId}, whose token is still ${held}.`
            );
        }
        const config = this.#input.requireConfig();
        const route = toGrantedTopicRoute(config);
        const token = this.#input.typedChannels.open(config, route).subscribe(() => undefined);
        this.#input.resources.setTopicSubscription(subscriptionId, { topicId: route.topicId, token });
        await Promise.race([token.wait(), this.#input.delay(subscribe.timeoutMs)]);
        return { subscriptionId, status: token.status() };
    };

    unsubscribe = async (
        unsubscribe: BlackBoxRallarTopicSubscriptions.UnsubscribeInput
    ): Promise<BlackBoxRallarTopicSubscriptions.Diagnostics> => {
        const { subscriptionId } = unsubscribe;
        const held = this.#input.resources.getTopicSubscription(subscriptionId);
        if (held === undefined) {
            throw new TypeError(
                `messages.unsubscribe names subscriptionId ${subscriptionId}, which the page does not hold.`
            );
        }
        await held.token.unsubscribe();
        return { subscriptionId, status: held.token.status() };
    };

    read = async (): Promise<BlackBoxRallarTopicSubscriptions.Readout> => ({
        connectionGenerationId: (await this.#input.productSocket.readConnectionGenerationId()) ?? null,
        subscriptions: [...this.#input.resources.listTopicSubscriptions()].map(([subscriptionId, held]) => ({
            subscriptionId,
            topicId: held.topicId,
            status: held.token.status()
        }))
    });
}

/** The connect's granted selector names the topic; the channel carries the connect's type, as its sends do. */
function toGrantedTopicRoute(
    config: BlackBoxRallarConnectionConfig
): BlackBoxRallarTopicSubscriptions.GrantedRoute {
    const selector = config.rallar.messageSelector;
    if (selector?.access !== 'granted' || selector.topicId === undefined) {
        throw new TypeError('messages.subscribe needs a connection whose message selector names a granted topic.');
    }
    return {
        typeId: resolveBlackBoxRallarTypeId(config),
        topicId: selector.topicId,
        roomRef: blackBoxRallarRoomRefOf(config),
        access: 'granted',
        durability: undefined,
        onStorageUnavailable: undefined,
        purpose: 'notification',
        publication: undefined,
        recovery: undefined
    };
}
