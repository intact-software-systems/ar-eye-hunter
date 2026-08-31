import type { RallarMessageSelectorInput } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import type { BlackBoxRallarConnectionState } from './black-box-rallar-connection-state.ts';
import type { BlackBoxBrowserRallarRuntimeDependency } from './browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarConnectionConfig, BlackBoxRallarTransport } from './contracts.ts';
import {
    blackBoxRallarAuthenticationIdentityOf,
    blackBoxRallarRoomRefOf,
    blackBoxRallarScopeOf
} from './policy.ts';
export const DEFAULT_LANE_ID = 'realtime';
export function resolveBlackBoxRallarTransport(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport {
    return config.rallar.transport ?? 'realtime';
}
export function resolveBlackBoxRallarLaneId(config: BlackBoxRallarConnectionConfig): string {
    return config.rallar.laneId ?? DEFAULT_LANE_ID;
}
export function resolveBlackBoxRallarTypeId(config: BlackBoxRallarConnectionConfig): string {
    const typeId = config.rallar.typeId;
    if (!typeId) {
        throw new Error('rallar.typeId is required for messages.rtc transport.');
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
export function toBlackBoxRallarOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
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
