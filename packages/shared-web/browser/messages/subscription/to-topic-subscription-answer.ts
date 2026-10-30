import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { GroupTopicSubscriptionResult } from '@shared/api/group-publication/group-topic-subscriptions.ts';
import type { Either } from '@shared/resilience/Either.ts';

/** How one remote subscribe ended, as the token statuses read it. */
export type TopicSubscriptionAnswer = 'active' | 'refused' | 'stale-generation' | 'unchanged' | 'unauthorized';

/**
 * A 403 is the server's denial, except `stale-generation` (a generation read raced a reopen) and `no-live-session`
 * (the session's socket is between connections); a 400 or 404 names a request or room that can never succeed.
 */
export function toTopicSubscriptionAnswer(
    subscribed: Either<Error, GroupTopicSubscriptionResult>
): TopicSubscriptionAnswer {
    if (subscribed.right !== undefined) {
        return subscribed.right.outcome === 'subscribed' || subscribed.right.outcome === 'renewed' ? 'active' : 'unchanged';
    }
    const error = subscribed.left;
    if (!(error instanceof ApiHttpError)) {
        return 'unchanged';
    }
    if (error.status === 401) {
        return 'unauthorized';
    }
    if (error.status !== 403) {
        return error.status === 400 || error.status === 404 ? 'refused' : 'unchanged';
    }
    const code = error.mutationFailure?.code ?? error.policyError?.code;
    return code === 'stale-generation' ? 'stale-generation' : code === 'no-live-session' ? 'unchanged' : 'refused';
}
