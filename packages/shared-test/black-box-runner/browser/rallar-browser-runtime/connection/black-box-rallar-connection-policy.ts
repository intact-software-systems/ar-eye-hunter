import type { RallarMessageSelectorInput } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarTransport
} from '../black-box-rallar-operation-contracts.ts';
import {
    blackBoxRallarAuthenticationIdentityOf,
    blackBoxRallarConnectionTargetOf,
    blackBoxRallarRoomRefOf,
    blackBoxRallarScopeOf,
    decideBlackBoxRallarLifecycleRequest
} from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from '../browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';
const DEFAULT_LANE_ID = 'realtime';
export function resolveBlackBoxRallarTransport(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport {
    return config.rallar.transport ?? 'realtime';
}
export function resolveBlackBoxRallarLaneId(config: BlackBoxRallarConnectionConfig): string {
    return config.rallar.laneId ?? DEFAULT_LANE_ID;
}
export function isBlackBoxRallarTypedMessagesTransport(transport: BlackBoxRallarTransport): boolean {
    return transport === 'messages.rtc' || transport === 'messages.ws';
}
export function resolveBlackBoxRallarTypeId(config: BlackBoxRallarConnectionConfig): string {
    const typeId = config.rallar.typeId;
    if (!typeId) {
        throw new Error('rallar.typeId is required for messages.rtc and messages.ws transports.');
    }

    return typeId;
}
export function resolveBlackBoxRallarTopicId(config: BlackBoxRallarConnectionConfig): string | undefined {
    return config.rallar.topicId ?? config.rallar.typeId;
}
export function toBlackBoxRallarDefaults(
    config: BlackBoxRallarConnectionConfig
): Parameters<BlackBoxBrowserRallarRuntimeDependency['setDefaults']>[0] {
    const scope = blackBoxRallarScopeOf(config);
    const roomRef = blackBoxRallarRoomRefOf(config);
    const roomId = config.roomId ?? roomRef?.groupId;
    if (!scope?.applicationId) {
        return undefined;
    }

    const room = roomId || roomRef
        ? {
            ...(roomId ? { roomId } : {}),
            ...(roomRef ? { roomRef } : {})
        }
        : undefined;

    return {
        applicationId: scope.applicationId,
        ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
        ...(room ? { room } : {}),
        realtime: {
            laneId: resolveBlackBoxRallarLaneId(config),
            ...(config.rallar.openTimeoutMs !== undefined ? { openTimeoutMs: config.rallar.openTimeoutMs } : {})
        },
        rtc: {
            ...(config.rallar.dataChannelLanes !== undefined
                ? { dataChannelLanes: config.rallar.dataChannelLanes }
                : {})
        }
    };
}
export function resolveBlackBoxRallarMessageSelector(
    config: BlackBoxRallarConnectionConfig
): RallarMessageSelectorInput {
    if (config.rallar.messageSelector) {
        return config.rallar.messageSelector;
    }

    return {
        typeId: resolveBlackBoxRallarTypeId(config),
        topicId: config.rallar.topicId
    };
}
export function toBlackBoxRallarSessionDiagnostic(
    session: BlackBoxRallarConnectionState.Session
): BlackBoxRallarConnectionState.Session {
    return {
        clientId: session.clientId,
        sessionId: session.sessionId,
        username: session.username
    };
}
export function toBlackBoxRallarAuthenticationKey(
    config: BlackBoxRallarConnectionConfig,
    username = config.rallar.username ?? ''
): string {
    return JSON.stringify(
        blackBoxRallarAuthenticationIdentityOf({
            apiBaseUrl: config.rallar.apiBaseUrl,
            username
        })
    );
}

export function toConnectedTargetRejection(
    state: BlackBoxRallarConnectionState.Value | undefined,
    config: BlackBoxRallarConnectionConfig
): Error | undefined {
    if (!state) {
        return undefined;
    }
    const decision = decideBlackBoxRallarLifecycleRequest(
        { status: 'connected', activeTarget: blackBoxRallarConnectionTargetOf(state.config, state.session) },
        { kind: 'connect', target: blackBoxRallarConnectionTargetOf(config, state.session) }
    );
    return decision.kind === 'reject' ? new Error(decision.reason) : undefined;
}
