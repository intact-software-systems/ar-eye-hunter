import { readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
import { sendApiHttpRequest, type ApiMutationRequestOptions } from '@shared-web/browser/api/send-api-http-request.ts';
import { toStateGroupHttpPath } from '@shared-web/browser/api/state-http-path.ts';
import type { SubscribeStateGroupTopicBody } from '@shared-web/browser/api/state-mutation-http-contracts.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import type { GroupTopicSubscriptionResult } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';

/** One session's subscribe or unsubscribe; the unsubscribe body has the subscribe body's two fields. */
export interface BrowserTopicSubscriptionRequest {
    readonly roomRef: GroupRef;
    readonly sessionId: string;
    readonly body: SubscribeStateGroupTopicBody;
    /** The session's auth and the call's own request id. */
    readonly options: ApiMutationRequestOptions;
}

/** The subscription owner's REST port; a failed request throws `ApiHttpError`, as the REST layer does. */
export interface BrowserTopicSubscriptionHttpApi {
    subscribeGroupTopic(request: BrowserTopicSubscriptionRequest): Promise<GroupTopicSubscriptionResult>;
    unsubscribeGroupTopic(request: BrowserTopicSubscriptionRequest): Promise<GroupTopicSubscriptionResult>;
}

type GroupTopicSubscriptionAction = 'subscribe' | 'unsubscribe';

export function createBrowserTopicSubscriptionHttpApi(): BrowserTopicSubscriptionHttpApi {
    return {
        subscribeGroupTopic: async (request) => await writeGroupTopicSubscription(request, 'subscribe'),
        unsubscribeGroupTopic: async (request) => await writeGroupTopicSubscription(request, 'unsubscribe')
    };
}

async function writeGroupTopicSubscription(
    request: BrowserTopicSubscriptionRequest,
    action: GroupTopicSubscriptionAction
): Promise<GroupTopicSubscriptionResult> {
    const groupPath = toStateGroupHttpPath(toStateScope(request.roomRef), request.roomRef.groupId);
    const path = `${groupPath}/sessions/${encodeURIComponent(request.sessionId)}/${action}`;
    return await sendApiHttpRequest<SubscribeStateGroupTopicBody, GroupTopicSubscriptionResult>({
        baseUrl: readApiBaseUrl(),
        path: toApiMutationRequestPath(path, request.options.requestId),
        method: 'POST',
        body: request.body,
        options: request.options
    });
}
