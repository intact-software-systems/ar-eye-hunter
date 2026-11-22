import type { RallarJoinRoomOptions } from '../rallar-room-contracts.ts';
import { requireExactKeys, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { toApiMutationRequestPath } from '@shared/api/mutation/api-mutation-request.ts';
import { sendApiHttpRequest } from '../../api/send-api-http-request.ts';
import { toStateGroupHttpPath } from '../../api/state-http-path.ts';
import { DEFAULT_ROOM_LOBBY_POLICY } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import { isSameGroupRef, isSameGroupScope } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeRoomLobbyAccountView, decodeRoomLobbyPolicy, type RoomLobby, type RoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';
import { decodeStateScope, type StateScope } from '@shared/api/state-types.ts';
import { decodeExactGroupRef } from '@shared/encoding/decode-exact-group-ref.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { readApiBaseUrl } from '../../api-client-config.ts';
import { AuthenticatedResource } from '../../api/authenticated-resource.ts';
import { readApiView } from '../../api/read-api-view.ts';
import { subscribeViewInvalidations } from '../../api/subscribe-view-invalidations.ts';
import type { SubscribeViewRecovery } from '../../api/subscribe-view-recovery.ts';
import { BrowserActivity } from '../../browser-activity.ts';
import type { RallarAuthFacade } from '../../session/rallar-auth-facade.ts';
import { roomGroupStateHttpApi } from '../room-group-state-http-api.ts';

export namespace RallarRoomLobby {
    export interface Browser extends SubscribeViewRecovery.Browser {
        readonly auth: Pick<RallarAuthFacade, 'onChange'>;
    }
    export interface Command {
        readonly roomRef: GroupRef;
        readonly roomLobby: RoomLobby.Mutation;
    }
}

/** The account owns this observation across room changes. Explicit release and room entry remain independent. */
export class RallarRoomLobby extends AuthenticatedResource<RoomLobbyAccountView, RallarRoomLobby.Command> {
    private readonly scope: StateScope;

    constructor(browser: RallarRoomLobby.Browser, scope: StateScope) {
        const accountScope = decodeStateScope(scope);
        super({
            auth: { session: () => browser.session(), onChange: (listener, options) => browser.auth.onChange(listener, options) },
            activity: new BrowserActivity(), timers: createDefaultTimers(), createId: () => crypto.randomUUID()
        }, {
            scope: accountScope, changeResult: 'read',
            subscribeRefresh: changed => subscribeViewInvalidations({ browser, scope: accountScope, resource: 'room-lobby', changed })
        }, {
            read: readOwnSeat,
            change: writeLobbyCommand
        });
        this.scope = accountScope;
    }

    configure(roomRef: GroupRef, policy: RoomLobby.Policy | null = DEFAULT_ROOM_LOBBY_POLICY): Promise<void> {
        return this.act({
            roomRef: this.roomInScope(roomRef), roomLobby: { operation: 'configure', policy: policy === null ? null : decodeRoomLobbyPolicy(policy) }
        });
    }

    wait(roomRef: GroupRef, options: Pick<RallarJoinRoomOptions, 'joinCode'> = {}): Promise<void> {
        return this.act({ roomRef: this.roomInScope(roomRef), roomLobby: {
            operation: 'wait', ...(options.joinCode === undefined ? {} : { joinCode: options.joinCode })
        } });
    }

    release(roomRef: GroupRef): Promise<void> {
        return this.act({ roomRef: this.roomInScope(roomRef), roomLobby: { operation: 'release' } });
    }

    private roomInScope(roomRef: GroupRef): GroupRef {
        const room = decodeExactGroupRef(roomRef, 'Room lobby command');
        if (!isSameGroupScope(room, this.scope)) throw new TypeError('Lobby room belongs to another scope');
        return room;
    }
}

async function readOwnSeat({ scope, session, signal }: AuthenticatedResource.ReadInput): Promise<RoomLobbyAccountView> {
    const view = decodeRoomLobbyAccountView(await readApiView({
        baseUrl: readApiBaseUrl(),
        path: `/api/room-lobbies/apps/${encodeURIComponent(scope.applicationId)}/workspaces/${encodeURIComponent(scope.workspaceId)}`,
        session, signal, timeoutMs: 10_000
    }));
    if (!isSameGroupScope(view.scope, scope) || view.principalId !== session.clientId) {
        throw new TypeError('Lobby view belongs to another scope or account');
    }
    return view;
}

async function writeLobbyCommand({ scope, session, request, signal, requestId }:
    AuthenticatedResource.ChangeInput<RallarRoomLobby.Command>): Promise<null> {
    if (!isSameGroupScope(request.roomRef, scope)) throw new TypeError('Lobby room belongs to another scope');
    const body = { actorPrincipalId: session.clientId, actorSessionId: session.sessionId, roomLobby: request.roomLobby };
    const options = { authSession: session, requestId, signal };
    let acknowledged: GroupRef;
    if (request.roomLobby.operation === 'configure') {
        const snapshot = await roomGroupStateHttpApi.updateGroup({ groupId: request.roomRef.groupId, scope, request: { ...body, roomLobby: request.roomLobby }, options });
        validateAuthoritativeGroupSnapshot(snapshot, scope);
        acknowledged = snapshot.group;
    }
    else {
        const result = await sendApiHttpRequest<typeof body, unknown>({
            baseUrl: readApiBaseUrl(), method: 'PUT', body, options,
            path: toApiMutationRequestPath(toStateGroupHttpPath(scope, request.roomRef.groupId), requestId)
        });
        const ack = requireRecord(result, 'Private lobby acknowledgement');
        requireExactKeys(ack, ['roomRef'], 'Private lobby acknowledgement');
        acknowledged = decodeExactGroupRef(ack.roomRef, 'Acknowledged lobby');
    }
    if (!isSameGroupRef(request.roomRef, acknowledged)) throw new TypeError('Lobby acknowledgement belongs to another room');
    return null;
}
