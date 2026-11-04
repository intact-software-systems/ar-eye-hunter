import { AppTopics } from '@shared/api/api-config.ts';
import { matchesGroupMoveChangedRecipient } from '@shared/api/mutation/group-move-changed.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { subscribeViewRecovery, type SubscribeViewRecovery } from '../../api/subscribe-view-recovery.ts';

export namespace SubscribeRoomMoveChanges {
    export interface Input extends SubscribeViewRecovery.Input {
        readonly scope: StateScope;
    }
}

/** Move consent remains session-bound; account history notices only wake an authorized read. */
export function subscribeRoomMoveChanges(input: SubscribeRoomMoveChanges.Input): () => void {
    const subscriptions = new SubscriptionScope();
    subscriptions.add(input.browser.messages.ws.onMessage({ topicId: AppTopics.groupMoveChanged }, (message) => {
        const session = input.browser.session();
        if (message.transport !== 'ws' || message.topicId !== AppTopics.groupMoveChanged || session === undefined) {
            return;
        }
        if (matchesGroupMoveChangedRecipient(message.raw, input.scope, session.clientId)) {
            input.changed();
        }
    }));
    subscriptions.add(subscribeViewRecovery(input));
    return () => subscriptions.unsubscribe();
}
