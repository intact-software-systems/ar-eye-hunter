import type { WsGrantedTopicSet } from '@shared-server/rallar-system/websocket/room-publication/ws-granted-topic-set.ts';
import type { WsCapturedRecipientEligibilityFilters } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import {
    filterDurablyLiveWsSessionIds,
    type FilterDurablyLiveWsSessionIdsInput
} from '../services/filter-durably-live-ws-session-ids.ts';
import { filterEligibleDurableWsSessionIds } from '../services/filter-eligible-live-ws-session-ids.ts';
import { filterGrantedWsRecipientSessionIds } from '../services/filter-granted-ws-recipient-session-ids.ts';

export interface CreateApiV1CapturedRecipientEligibilityFiltersInput {
    readonly socketServer: JsonWebSocketServer;
    readonly grantedTopics: WsGrantedTopicSet;
    readonly serverPeerId: string;
    readonly readPublicationAuthority: FilterDurablyLiveWsSessionIdsInput['readPublicationAuthority'];
    readonly readPrincipalSessions: FilterDurablyLiveWsSessionIdsInput['readPrincipalSessions'];
    readonly nowEpochMs: () => number;
}

/** Durable presence judges a captured row at the dequeue and the retry; this instance's open sockets judge it at send. */
export function createApiV1CapturedRecipientEligibilityFilters(
    input: CreateApiV1CapturedRecipientEligibilityFiltersInput
): WsCapturedRecipientEligibilityFilters {
    const { socketServer, grantedTopics, serverPeerId, readPublicationAuthority, readPrincipalSessions } = input;
    return {
        durable: async (captured) =>
            await filterDurablyLiveWsSessionIds({
                ...captured,
                grantedTopics,
                serverPeerId,
                readPublicationAuthority,
                readPrincipalSessions,
                nowEpochMs: input.nowEpochMs()
            }),
        local: async (captured) => {
            const nowEpochMs = input.nowEpochMs();
            return await filterGrantedWsRecipientSessionIds({
                ...captured,
                durableEligibleSessionIds: filterEligibleDurableWsSessionIds({
                    ...captured,
                    socketServer,
                    nowMs: nowEpochMs
                }),
                grantedTopics,
                serverPeerId,
                readPublicationAuthority,
                nowEpochMs
            });
        }
    };
}
