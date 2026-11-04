import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import {
    decodeGroupSessionPage,
    decodeGroupSessionPreview
} from '@shared/api/group-sessions/decode-group-session-preview.ts';
import type {
    GroupSessionChange,
    GroupSessionPage,
    GroupSessionPreview
} from '@shared/api/group-sessions/group-session-schedule.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { decodeSessionPreviewWatchResult, type SessionPreviewWatchResult } from '@shared/api/views/view-watch.ts';
import { Command } from '@shared/cache/Command.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { ApiHttpError } from '../../api/http-error.ts';
import { readApiView } from '../../api/read-api-view.ts';
import type { SelectedViewWatch } from '../../api/selected-view-watch.ts';
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
    { scope, after, session, signal }: RallarScheduledSessions.ListInput
): Promise<GroupSessionPage> {
    const query = after === null ? '' : `?after=${encodeURIComponent(after)}`;
    const response = await readApiView({
        timeoutMs: 10000,
        baseUrl: readApiBaseUrl(),
        path: `${toStateScopeHttpPath(scope)}/group-sessions${query}`,
        session,
        signal
    });
    return decodeGroupSessionPage(response);
}

async function readSession(
    ref: GroupRef,
    session: AuthSession,
    signal: AbortSignal
): Promise<GroupSessionPreview | null> {
    try {
        const response = await readApiView({
            timeoutMs: 10000,
            baseUrl: readApiBaseUrl(),
            path: `${toStateGroupHttpPath(ref, ref.groupId)}/session`,
            session,
            signal
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
    { scope, request, session, signal }: RallarScheduledSessions.CreateInput
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
    }, { signal, timeoutMs: 15_000, maxAttempts: 2, errorOnNull: false }).run();
    return { ...scope, groupId: request.groupId };
}

async function changeSession({ ref, request, session, signal }: RallarScheduledSessions.ChangeInput): Promise<void> {
    if (!request.requestId) {
        throw new TypeError('Session mutation requires a stable request identity');
    }
    const requestId = request.requestId;
    await new Command(async (attemptSignal) => {
        const response = await sendApiHttpRequest<GroupSessionChange, ApiJsonValue>({
            baseUrl: readApiBaseUrl(),
            path: toApiMutationRequestPath(`${toStateGroupHttpPath(ref, ref.groupId)}/session`, requestId),
            method: 'POST',
            body: {
                action: request.action,
                expectedScheduleRevision: request.expectedScheduleRevision,
                startsAtEpochMs: request.startsAtEpochMs
            },
            options: { authSession: session, signal: attemptSignal }
        });
        if (
            response === null || typeof response !== 'object' || Object.keys(response).length !== 1 ||
            !('accepted' in response) || response.accepted !== true
        ) {
            throw new TypeError('Session mutation returned an invalid acknowledgement');
        }
    }, { signal, timeoutMs: 15_000, maxAttempts: 2, errorOnNull: false }).run();
}

/** Retrying a lost response keeps the same command key and conditional predecessor. */
export async function changeSessionPreviewWatch(
    scope: StateScope,
    input: SelectedViewWatch.ChangeInput
): Promise<SessionPreviewWatchResult> {
    return await new Command(async (signal) => {
        const response = await sendApiHttpRequest<SelectedViewWatch.ChangeInput['request'], ApiJsonValue>({
            baseUrl: readApiBaseUrl(),
            path: toApiMutationRequestPath(
                `${toStateScopeHttpPath(scope)}/view-watches/session-preview`,
                input.requestId
            ),
            method: 'POST',
            body: input.request,
            options: { authSession: input.session, signal }
        });
        return decodeSessionPreviewWatchResult(response);
    }, { signal: input.signal, timeoutMs: 10_000, maxAttempts: 2, errorOnNull: false }).run();
}
