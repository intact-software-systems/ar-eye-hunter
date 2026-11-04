import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
    decodeViewInvalidationMessage,
    decodeViewResync,
    type ViewInvalidation
} from '@shared/api/view-invalidation.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import type { RallarMessageHandler } from '../messages/rallar-message-contracts.ts';
import type { RallarMessageSelectorInput } from '../messages/rallar-message-selectors.ts';
import type { RallarWsFacade } from '../rallar-realtime-facade.ts';

export namespace SubscribeViewInvalidations {
    export interface Browser {
        readonly messages: {
            readonly ws: {
                onMessage(selector: RallarMessageSelectorInput, handler: RallarMessageHandler<unknown>): () => void;
            };
        };
        readonly ws: Pick<RallarWsFacade, 'onLifecycle'>;
        session(): AuthSession | undefined;
    }
    export interface Input {
        readonly browser: Browser;
        readonly scope: StateScope;
        readonly resource: ViewInvalidation['resource'];
        readonly changed: () => void;
    }
}

/** Reserved server topics wake canonical reads; account authority is sampled on every delivery. */
export function subscribeViewInvalidations(input: SubscribeViewInvalidations.Input): () => void {
    const subscriptions = new SubscriptionScope();
    subscriptions.add(input.browser.messages.ws.onMessage({ topicId: AppTopics.viewInvalidated }, (message) => {
        if (message.transport !== 'ws' || message.topicId !== AppTopics.viewInvalidated) {
            return;
        }
        let notice: ViewInvalidation;
        try {
            notice = decodeViewInvalidationMessage(message.raw);
        }
        catch {
            return;
        }
        if (
            notice.resource === input.resource &&
            (notice.scope === null || isSameGroupScope(notice.scope, input.scope)) &&
            notice.principalId === input.browser.session()?.clientId
        ) {
            input.changed();
        }
    }));
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
