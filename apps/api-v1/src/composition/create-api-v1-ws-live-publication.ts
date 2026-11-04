import { readPrincipalSessionIds } from '@shared-server/rallar-system/websocket/read-principal-session-ids.ts';
import type { RallarServerWsRouterOptions } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { ClientPrincipalRef, ClientSnapshot } from '@shared/api/client-types.ts';

import type { ApiV1DatabaseConfiguration } from '../configuration/api-v1-configuration.ts';
import type { ApiV1DatabaseNotificationPort } from '../db/api-v1-database-lifecycle.ts';
import { API_V1_LIVE_WS_NOTICE_CHANNEL } from '../db/api-v1-live-ws-notice-transport.ts';
import { createPostgresLiveWsNoticeTransport } from '../db/create-postgres-live-ws-notice-transport.ts';
import { myPublisherId } from '../runtime/runtime-identity.ts';

export interface CreateApiV1WsLivePublicationInput {
    readonly mode: ApiV1DatabaseConfiguration['pubSub'];
    readonly notification: ApiV1DatabaseNotificationPort | null;
    readonly nowEpochMs: () => number;
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
        channel: API_V1_LIVE_WS_NOTICE_CHANNEL,
        publisherId: myPublisherId,
        readPrincipalSessionIds: (ref) => readPrincipalSessionIds(ref, input)
    };
}
