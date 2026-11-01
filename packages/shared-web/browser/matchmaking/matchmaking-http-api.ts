import { decodeMatchmakingMutationResult } from '@shared/api/matchmaking/matchmaking-request.ts';
import { decodeMatchmakingSnapshot } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { readApiBaseUrl } from '../api-client-config.ts';
import { sendApiHttpRequest } from '../api/send-api-http-request.ts';
import type { RallarMatchmaking } from './rallar-matchmaking.ts';

export const matchmakingHttpApi: RallarMatchmaking.Api = {
    async read({ scope, session, signal }) {
        const response = await sendApiHttpRequest({
            baseUrl: readApiBaseUrl(),
            path: matchmakingPath(scope),
            method: 'GET',
            body: undefined,
            options: { authSession: session, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }
        });
        return decodeMatchmakingSnapshot(response);
    },
    async change({ scope, request, requestId, session, signal }) {
        return await new Command(async (attemptSignal) => {
            const response = await sendApiHttpRequest({
                baseUrl: readApiBaseUrl(),
                path: toApiMutationRequestPath(matchmakingPath(scope), requestId),
                method: 'POST',
                body: request,
                options: { authSession: session, signal: attemptSignal }
            });
            return decodeMatchmakingMutationResult(response);
        }, { signal, timeoutMs: 15000, maxAttempts: 2, errorOnNull: true }).run();
    }
};

function matchmakingPath(scope: StateScope): string {
    return `/api/matchmaking/apps/${encodeURIComponent(scope.applicationId)}/workspaces/${
        encodeURIComponent(scope.workspaceId)
    }`;
}
