import { isClientSnapshotSessionLive } from '@shared-server/rallar-system/presence/snapshot-presence.ts';
import type { RallarServerWsRouterOptions } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { computeServerRoomPublicationAudience } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from '../db/api-v1-database-lifecycle.ts';
import { createPostgresLiveWsNoticeTransport } from '../db/create-postgres-live-ws-notice-transport.ts';
import { myPublisherId } from '../runtime/runtime-identity.ts';

export interface CreateApiV1WsLivePublicationInput {
    readonly mode: ApiV1DatabaseConfiguration['pubSub'];
    readonly notification: ApiV1DatabaseNotificationPort | null;
    readonly nowEpochMs: () => number;
    readonly readGroupSnapshot: (ref: GroupRef) => Promise<GroupSnapshot | undefined>;
    readonly readClientSnapshot: (ref: ClientPrincipalRef) => Promise<ClientSnapshot | undefined>;
}

export function createApiV1WsLivePublication(
    input: CreateApiV1WsLivePublicationInput
): RallarServerWsRouterOptions['livePublication'] {
    if (input.mode !== 'postgres') {
        return undefined;
    }
    if (!input.notification) {
        throw new TypeError('PostgreSQL live WS publication requires the database notification port.');
    }
    return {
        transport: createPostgresLiveWsNoticeTransport(input.notification, input.nowEpochMs),
        channel: 'ws-channel',
        publisherId: myPublisherId,
        readServerRoomAudience: async (message: ALMessage, ref: GroupRef) =>
            computeServerRoomPublicationAudience(
                await input.readGroupSnapshot(ref),
                message,
                input.nowEpochMs()
            ),
        readPrincipalSessionIds: async (ref: ClientPrincipalRef) => {
            const snapshot = await input.readClientSnapshot(ref);
            if (
                !snapshot || snapshot.principal.status !== 'active' ||
                snapshot.principal.applicationId !== ref.applicationId ||
                snapshot.principal.workspaceId !== ref.workspaceId ||
                snapshot.principal.principalId !== ref.principalId
            ) {
                return undefined;
            }
            const now = input.nowEpochMs();
            return snapshot.activeSessions
                .filter((session) =>
                    session.applicationId === ref.applicationId &&
                    session.workspaceId === ref.workspaceId &&
                    session.principalId === ref.principalId &&
                    isClientSnapshotSessionLive(session, now)
                )
                .map((session) => session.sessionId);
        }
    };
}
