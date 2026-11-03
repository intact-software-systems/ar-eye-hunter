import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { decodePartyMutationResult } from '@shared/api/parties/party-request.ts';
import { decodePartyView } from '@shared/api/parties/party-view.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { readApiBaseUrl } from '../api-client-config.ts';
import { sendApiHttpRequest } from '../api/send-api-http-request.ts';
import type { RallarParty } from './rallar-party.ts';

export const partyHttpApi: RallarParty.Api = {
    async read({ scope, session, signal }) {
        const response = await sendApiHttpRequest({
            baseUrl: readApiBaseUrl(),
            path: partyPath(scope),
            method: 'GET',
            body: undefined,
            options: { authSession: session, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }
        });
        return decodePartyView(response);
    },
    async change({ scope, request, requestId, session, signal }) {
        return await new Command(async (attemptSignal) => {
            const response = await sendApiHttpRequest({
                baseUrl: readApiBaseUrl(),
                path: toApiMutationRequestPath(partyPath(scope), requestId),
                method: 'POST',
                body: request,
                options: { authSession: session, signal: attemptSignal }
            });
            return decodePartyMutationResult(response);
        }, { signal, timeoutMs: 15000, maxAttempts: 2, errorOnNull: true }).run();
    }
};

function partyPath(scope: StateScope): string {
    return `/api/parties/apps/${encodeURIComponent(scope.applicationId)}/workspaces/${
        encodeURIComponent(scope.workspaceId)
    }`;
}
