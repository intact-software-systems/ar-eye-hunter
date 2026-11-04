import type { AuthSession } from '@shared/api/api-config.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeGroupMove } from '@shared/api/mutation/decode-group-move.ts';
import type { GroupMove, GroupMoveRequest } from '@shared/api/mutation/group-move.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { readApiView } from '../../api/read-api-view.ts';
import { sendApiHttpRequest, type ApiMutationRequestOptions } from '../../api/send-api-http-request.ts';
import { toStateScopeHttpPath } from '../../api/state-http-path.ts';

export async function listMoves(
    scope: StateScope,
    session: AuthSession,
    signal: AbortSignal
): Promise<readonly GroupMove[]> {
    const value = await readApiView({
        baseUrl: readApiBaseUrl(),
        path: `${toStateScopeHttpPath(scope)}/group-moves`,
        session,
        signal,
        timeoutMs: 10000
    });
    if (!Array.isArray(value)) {
        throw new TypeError('Room move list must be an array');
    }
    return Array.from(value, decodeGroupMove);
}

export async function mutateMove(
    request: GroupMoveRequest,
    session: AuthSession,
    signal: AbortSignal
): Promise<GroupMove> {
    return await new Command(async (attemptSignal) => {
        const options: ApiMutationRequestOptions = {
            authSession: session,
            signal: attemptSignal,
            requestId: request.requestId
        };
        const value = await sendApiHttpRequest({
            baseUrl: readApiBaseUrl(),
            path: toApiMutationRequestPath(`${toStateScopeHttpPath(request.source)}/group-moves`, request.requestId),
            method: 'POST',
            body: request,
            options
        });
        return decodeGroupMove(value);
    }, { signal, timeoutMs: 15000, maxAttempts: 2 }).run();
}
