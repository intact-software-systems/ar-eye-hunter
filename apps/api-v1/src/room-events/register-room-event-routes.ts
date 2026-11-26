import type { Context, Hono } from 'hono';
import { readRoomGuestRequest, readRoomGuestSession } from '@shared-server/http/room-guest-request.ts';
import { hashAuthSecret } from '@shared-server/rallar-system/auth/credentials/hash-auth-secret.ts';
import { ROOM_GUEST_TOKEN_PREFIX, toEventCourtGuestCredential } from '@shared-server/rallar-system/auth/credentials/room-guest-credential.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type { TemporaryEventService } from '@shared-server/rallar-system/room-events/temporary-event-service.ts';
import { isApiJsonObject, type ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { assertApiMutationRequestId } from '@shared/api/mutation/api-mutation-request.ts';
import { decodeRoomEventCommand } from '@shared/api/room-events/decode-room-event.ts';
import { isGuestInvitationVerifier } from '@shared/api/room-guests/invitation.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { toApiMutationFailureResponse, toApiMutationRouteFailure } from '../routes/api-mutation-route-failure.ts';
import { readApiRequestTraceId } from '../services/read-api-request-trace-id.ts';

export interface RoomEventRouteDependencies {
    readonly events: Pick<TemporaryEventService, 'read'> & { readonly mutate: Pick<TemporaryEventService['mutate'], 'submit'> };
    readonly readRoom: (room: GroupRef) => Promise<GroupSnapshot | undefined>;
    readonly nowEpochMs: () => number;
    readonly requireSession: (request: {header(name: string): string | undefined}) => Promise<IssuedAuthSession>;
}

function lobbyRef(context: Context): GroupRef {
    return { applicationId: context.req.param('applicationId')!, workspaceId: context.req.param('workspaceId')!,
        groupId: context.req.param('groupId')! };
}

async function roomEventSession(context: Context, lobby: GroupRef, dependencies: RoomEventRouteDependencies) {
    return await readRoomGuestSession({ request: context.req, roomRef: lobby, readSnapshot: dependencies.readRoom,
        nowEpochMs: dependencies.nowEpochMs }) ?? await dependencies.requireSession(context.req);
}

const EVENT_PATH = '/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/event';

export function registerRoomEventRoutes(app: Hono, dependencies: RoomEventRouteDependencies): void {
    app.get(EVENT_PATH, async context => {
        context.header('Cache-Control', 'no-store');
        try {
            const lobby = lobbyRef(context);
            const session = await roomEventSession(context, lobby, dependencies);
            return context.json(await dependencies.events.read(lobby, { principalId: session.clientId, sessionId: session.sessionId }));
        } catch (error) {
            return toApiMutationFailureResponse(context, toError(error));
        }
    });
    app.post(EVENT_PATH + '/requests/:requestId', async context => {
        context.header('Cache-Control', 'no-store');
        try {
            return await changeEvent(context, dependencies);
        } catch (error) {
            return toApiMutationFailureResponse(context, toError(error));
        }
    });
}

async function changeEvent(context: Context, dependencies: RoomEventRouteDependencies): Promise<Response> {
    const lobby = lobbyRef(context);
    const requestId = assertApiMutationRequestId(context.req.param('requestId'));
    const requestBody = await context.req.json<ApiJsonValue>();
    if (!isApiJsonObject(requestBody)) throw new TypeError('Expected an event mutation object.');
    const { courtSecret, ...body } = requestBody;
    const command = decodeRoomEventCommand(body);
    if (command.action === 'settle' || (command.action !== 'claim' && courtSecret !== undefined)) throw new TypeError('Invalid public event action.');
    const incoming = command.action === 'release' ? await readRoomGuestRequest(context.req) : undefined;
    const scope = command.action === 'release' && incoming?.roomRef.groupId === command.groupId
        ? { ...lobby, groupId: command.groupId } : lobby;
    const session = await roomEventSession(context, scope, dependencies);
    const guest = session.accessToken.startsWith(ROOM_GUEST_TOKEN_PREFIX);
    if (!guest && courtSecret !== undefined) throw new TypeError('Registered players use their issued session.');
    const claim = command.action === 'claim' && guest
        ? await courtClaimCredential({ ...lobby, groupId: command.groupId }, session.clientId, courtSecret)
        : undefined;
    const result = await dependencies.events.mutate.submit({
        command: { lobby, principalId: session.clientId, sessionId: session.sessionId, requestId, command,
            ...(claim && { courtTransport: { sessionId: claim.credential.sessionId, accessTokenDigest: await hashAuthSecret(claim.credential.accessToken) } }) },
        traceId: readApiRequestTraceId(context)
    });
    if (result.left) throw toApiMutationRouteFailure(result.left);
    if (!claim) return context.json(command.action === 'claim'
        ? { ...result.right!, room: { ...lobby, groupId: command.groupId } } : result.right!);
    const request = new Headers({ authorization: 'Bearer ' + claim.credential.accessToken, 'x-client-id': session.clientId });
    const access = await readRoomGuestSession({ request: { header: name => request.get(name) ?? undefined },
        roomRef: claim.room, readSnapshot: dependencies.readRoom, nowEpochMs: dependencies.nowEpochMs });
    if (!access) throw new TypeError('Court admission did not issue a credential.');
    return context.json({ ...result.right!, room: claim.room, access: { ...claim.credential,
        issuedAtEpochMs: access.issuedAtEpochMs, expiresAtEpochMs: access.expiresAtEpochMs } });
}

async function courtClaimCredential(room: GroupRef, player: string, secret: ApiJsonValue | undefined) {
    if (!isGuestInvitationVerifier(secret)) throw new TypeError('Claim requires an independent court secret.');
    return { room, credential: await toEventCourtGuestCredential(room, player, secret) };
}
