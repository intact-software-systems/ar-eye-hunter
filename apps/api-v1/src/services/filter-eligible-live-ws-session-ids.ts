import type { LiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { readAuthorisedWsConnectionEligibility } from '../runtime/rtc-topology/authorised-ws-connection-registry.ts';

export interface FilterEligibleLiveWsSessionIdsInput {
    readonly socketServer: JsonWebSocketServer;
    readonly candidateSessionIds: readonly string[];
    readonly notice: LiveWsNotice;
    readonly nowMs: number;
}

export function filterEligibleLiveWsSessionIds(input: FilterEligibleLiveWsSessionIdsInput): readonly string[] {
    const eligible: string[] = [];
    for (const sessionId of new Set(input.candidateSessionIds)) {
        const connection = input.socketServer.connections.get(sessionId);
        if (!connection?.isOpen) {
            continue;
        }
        const facts = readAuthorisedWsConnectionEligibility(connection);
        if (!facts || facts.expiresAtEpochMs <= input.nowMs) {
            continue;
        }
        const audience = input.notice.delivery === 'inline' ? input.notice.audience : undefined;
        const isBroad = input.notice.delivery === 'inline'
            ? input.notice.audience.mode === 'broad'
            : input.notice.audienceMode === 'broad';
        const scope = input.notice.scope;
        if (
            !isBroad &&
            (!scope || facts.scope.applicationId !== scope.applicationId ||
                facts.scope.workspaceId !== scope.workspaceId)
        ) {
            continue;
        }
        if (audience?.mode === 'principal' && facts.principalId !== audience.principalRef.principalId) {
            continue;
        }
        eligible.push(sessionId);
    }
    return eligible;
}
