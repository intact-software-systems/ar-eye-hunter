import { AppTopics } from '@shared/api/api-config.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import {
    decodeViewInvalidationMessage,
    type ViewInvalidation
} from '@shared/api/views/view-invalidation.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';

import { subscribeViewRecovery, type SubscribeViewRecovery } from './subscribe-view-recovery.ts';

export namespace SubscribeViewInvalidations {
    export interface Input {
        readonly browser: SubscribeViewRecovery.Browser;
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
            input.browser.session() !== undefined &&
            (notice.principalId === null || notice.principalId === input.browser.session()?.clientId)
        ) {
            input.changed();
        }
    }));
    subscriptions.add(subscribeViewRecovery(input));
    return () => subscriptions.unsubscribe();
}
