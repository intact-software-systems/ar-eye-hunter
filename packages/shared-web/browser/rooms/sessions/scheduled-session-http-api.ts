import type { AuthSession } from '@shared/api/api-config.ts';
import {
    decodeGroupSessionPage,
    decodeGroupSessionPreview
} from '@shared/api/group-sessions/decode-group-session-preview.ts';
import type {
    ChangeGroupSessionRequest,
    GroupSessionPage,
    GroupSessionPreview
} from '@shared/api/group-sessions/group-session-schedule.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Command } from '@shared/cache/Command.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { ApiHttpError } from '../../api/http-error.ts';
import { sendApiHttpRequest } from '../../api/send-api-http-request.ts';
import { toStateGroupHttpPath, toStateScopeHttpPath } from '../../api/state-http-path.ts';
import { roomGroupStateHttpApi } from '../room-group-state-http-api.ts';
import type { RallarScheduledSessions } from './rallar-scheduled-sessions.ts';

export const scheduledSessionHttpApi: RallarScheduledSessions.Api = {
    list: listSessions,
    read: readSession,
    create: createSession,
    change: changeSession
};

async function listSessions(
    scope: StateScope,
    after: string | null,
    session: AuthSession,
    signal: AbortSignal
): Promise<GroupSessionPage> {
    const query = after === null ? '' : `?after=${encodeURIComponent(after)}`;
    const response = await sendApiHttpRequest<never, unknown>({
        baseUrl: readApiBaseUrl(),
        path: `${toStateScopeHttpPath(scope)}/group-sessions${query}`,
        method: 'GET',
        body: undefined,
        options: { authSession: session, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }
    });
    return decodeGroupSessionPage(response);
}

async function readSession(
    ref: GroupRef,
    session: AuthSession,
    signal: AbortSignal
): Promise<GroupSessionPreview | null> {
    try {
        const response = await sendApiHttpRequest<never, unknown>({
            baseUrl: readApiBaseUrl(),
            path: `${toStateGroupHttpPath(ref, ref.groupId)}/session`,
            method: 'GET',
            body: undefined,
            options: { authSession: session, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }
        });
        return decodeGroupSessionPreview(response);
    }
    catch (error) {
        if (error instanceof ApiHttpError && error.status === 404) {
            return null;
        }
        throw error;
    }
}

async function createSession(
    scope: StateScope,
    request: RallarScheduledSessions.CreateRequest,
    session: AuthSession,
    signal: AbortSignal
): Promise<GroupRef> {
    await new Command(async (attemptSignal) => {
        await roomGroupStateHttpApi.createGroup({
            scope,
            request: {
                groupId: request.groupId,
                displayName: request.displayName,
                kind: 'room',
                joinMode: 'open',
                directoryListing: 'unlisted',
                retention: { mode: 'temporary', reconnectGraceMs: 600_000 },
                maxMembers: request.maxPlayers,
                maxSpectators: 16,
                scheduledStartAtEpochMs: request.startsAtEpochMs,
                createdByPrincipalId: session.clientId
            },
            options: { authSession: session, signal: attemptSignal, requestId: request.requestId }
        });
    }, { signal, timeoutMs: 15_000, maxAttempts: 2 }).run();
    return { ...scope, groupId: request.groupId };
}

async function changeSession(
    ref: GroupRef,
    request: ChangeGroupSessionRequest,
    session: AuthSession,
    signal: AbortSignal
): Promise<void> {
    if (!request.requestId) {
        throw new TypeError('Session mutation requires a stable request identity');
    }
    const requestId = request.requestId;
    await new Command(async (attemptSignal) => {
        const response = await sendApiHttpRequest<ChangeGroupSessionRequest, unknown>({
            baseUrl: readApiBaseUrl(),
            path: toApiMutationRequestPath(`${toStateGroupHttpPath(ref, ref.groupId)}/session`, requestId),
            method: 'POST',
            body: request,
            options: { authSession: session, signal: attemptSignal }
        });
        if (
            response === null || typeof response !== 'object' || Object.keys(response).length !== 1 ||
            !('accepted' in response) || response.accepted !== true
        ) {
            throw new TypeError('Session mutation returned an invalid acknowledgement');
        }
    }, { signal, timeoutMs: 15_000, maxAttempts: 2 }).run();
}
