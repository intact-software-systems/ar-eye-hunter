import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { decodeViewResync } from '@shared/api/views/view-invalidation.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import type { RallarMessageHandler } from '../messages/rallar-message-contracts.ts';
import type { RallarMessageSelectorInput } from '../messages/rallar-message-selectors.ts';
import type { RallarWsFacade } from '../rallar-realtime-facade.ts';

export namespace SubscribeViewRecovery {
    export interface Browser {
        readonly messages: {
            readonly ws: {
                onMessage(
                    selector: RallarMessageSelectorInput,
                    handler: RallarMessageHandler<ApiJsonValue>
                ): () => void;
            };
        };
        readonly ws: Pick<RallarWsFacade, 'onLifecycle'>;
        session(): AuthSession | undefined;
    }
    export interface Input {
        readonly browser: Browser;
        readonly changed: () => void;
    }
}

/** Repairs canonical views after connection or cluster subscriber loss. */
export function subscribeViewRecovery(input: SubscribeViewRecovery.Input): () => void {
    const subscriptions = new SubscriptionScope();
    subscriptions.add(input.browser.messages.ws.onMessage({ topicId: AppTopics.viewResync }, (message) => {
        if (
            message.transport !== 'ws' || message.topicId !== AppTopics.viewResync ||
            message.typeId !== AppTopics.viewResync || input.browser.session() === undefined
        ) {
            return;
        }
        try {
            decodeViewResync(message.payload);
        }
        catch {
            return;
        }
        input.changed();
    }));
    subscriptions.add(input.browser.ws.onLifecycle((event) => {
        if ((event.kind === 'open' || event.kind === 'connected') && input.browser.session() !== undefined) {
            input.changed();
        }
    }, { emitCurrent: false }));
    return () => subscriptions.unsubscribe();
}
