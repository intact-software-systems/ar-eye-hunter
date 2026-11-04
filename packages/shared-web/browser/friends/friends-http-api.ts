import { decodeFriendsMutationResult, type FriendsRequest } from '@shared/api/friends/friends-request.ts';
import { decodeFriendsView } from '@shared/api/friends/friends-view.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { Command } from '@shared/cache/Command.ts';
import { readApiBaseUrl } from '../api-client-config.ts';
import { readApiView } from '../api/read-api-view.ts';
import { sendApiHttpRequest } from '../api/send-api-http-request.ts';
import type { RallarFriends } from './rallar-friends.ts';

export const friendsHttpApi: RallarFriends.Api = {
    async read({ scope, session, signal }) {
        const response = await readApiView({
            timeoutMs: 10000,
            baseUrl: readApiBaseUrl(),
            path: `/api/friends/apps/${encodeURIComponent(scope.applicationId)}/workspaces/${
                encodeURIComponent(scope.workspaceId)
            }`,
            session,
            signal
        });
        return decodeFriendsView(response);
    },
    async change({ request, requestId, session, signal }) {
        return await new Command(async (attemptSignal) => {
            const response = await sendApiHttpRequest<FriendsRequest, unknown>({
                baseUrl: readApiBaseUrl(),
                path: toApiMutationRequestPath('/api/friends', requestId),
                method: 'POST',
                body: request,
                options: { authSession: session, signal: attemptSignal }
            });
            return decodeFriendsMutationResult(response);
        }, { signal, timeoutMs: 15_000, maxAttempts: 2, errorOnNull: true }).run();
    }
};
