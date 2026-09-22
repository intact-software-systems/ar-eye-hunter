import type { RallarBlackBoxTestConfig, RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

import type { CommandWithId, RallarBlackBoxBrowserRallarConnectionConfig } from './browser-command-contracts.ts';
import {
    decodeBrowserCommandRecord,
    decodeBrowserCommandString,
    decodeRtcTransport
} from './browser-command-values.ts';

type WsSendCommand = Extract<CommandWithId, { kind: 'ws.send'; }>;

const WEB_SOCKET_SCOPES = ['room', 'world', 'all'] as const;

interface WebSocketRoomSelection {
    readonly applicationId: string | undefined;
    readonly workspaceId: string | undefined;
    readonly stateScope: RallarBlackBoxTestRecord | undefined;
    readonly roomId: string | undefined;
    readonly roomRef: RallarBlackBoxTestRecord | undefined;
}

interface WebSocketRoomSources {
    readonly data: RallarBlackBoxTestRecord;
    readonly configuredRallar: RallarBlackBoxTestRecord;
    readonly config: RallarBlackBoxTestConfig | undefined;
}

export function toRallarAuthConnectionConfig(
    config: RallarBlackBoxTestConfig | undefined
): RallarBlackBoxBrowserRallarConnectionConfig {
    const configuredRallar = config?.rallar ?? {};
    const apiBaseUrl = resolveFirstDefined([configuredRallar.apiBaseUrl, config?.apiBaseUrl]);
    const expectedSessionId = resolveFirstDefined([
        configuredRallar.expectedSessionId,
        configuredRallar.sessionId,
        config?.sessionId
    ]);

    return {
        connection: resolveDefaultConnection(config),
        actor: config?.actor,
        rallar: {
            ...configuredRallar,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
            ...(expectedSessionId ? { expectedSessionId } : {}),
            transport: 'realtime'
        }
    };
}

export function toRallarConnectionConfig(
    command: Extract<CommandWithId, { kind: 'rtc.connect'; }>,
    config: RallarBlackBoxTestConfig | undefined
): RallarBlackBoxBrowserRallarConnectionConfig {
    return {
        connection: command.connection ?? resolveDefaultConnection(config),
        actor: command.actor ?? config?.actor,
        roomId: command.roomId ?? config?.roomId,
        roomRef: command.roomRef,
        rallar: toRtcConnectRallarConfig(command, config)
    };
}

export function toRallarWebSocketConnectionConfig(
    command: WsSendCommand,
    config: RallarBlackBoxTestConfig | undefined
): RallarBlackBoxBrowserRallarConnectionConfig {
    const configuredRallar = config?.rallar ?? {};
    const data = decodeBrowserCommandRecord(command.data) ?? {};
    const room = resolveWebSocketRoom({ data, configuredRallar, config });
    const apiBaseUrl = decodeNonEmptyBrowserCommandString(
        resolveFirstDefined([configuredRallar.apiBaseUrl, config?.apiBaseUrl])
    );
    const expectedSessionId = decodeNonEmptyBrowserCommandString(
        resolveFirstDefined([configuredRallar.expectedSessionId, configuredRallar.sessionId, config?.sessionId])
    );
    const typeId = decodeNonEmptyBrowserCommandString(data.typeId);
    const topicId = decodeNonEmptyBrowserCommandString(data.topicId);

    return {
        connection: command.connection ?? resolveDefaultConnection(config),
        actor: config?.actor,
        ...(room.roomId ? { roomId: room.roomId } : {}),
        ...(room.roomRef ? { roomRef: room.roomRef } : {}),
        rallar: {
            ...configuredRallar,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
            transport: 'realtime',
            restoreSession: configuredRallar.restoreSession ?? true,
            ...(expectedSessionId ? { expectedSessionId } : {}),
            ...(room.applicationId ? { applicationId: room.applicationId } : {}),
            ...(room.workspaceId ? { workspaceId: room.workspaceId } : {}),
            ...(room.stateScope ? { scope: room.stateScope } : {}),
            ...(room.roomRef ? { roomRef: room.roomRef } : {}),
            ...(typeId ? { typeId } : {}),
            ...(topicId ? { topicId } : {})
        }
    };
}

function toRtcConnectRallarConfig(
    command: Extract<CommandWithId, { kind: 'rtc.connect'; }>,
    config: RallarBlackBoxTestConfig | undefined
): RallarBlackBoxTestRecord {
    const configuredRallar = config?.rallar ?? {};
    const commandRallar = command.rallar ?? {};
    const transport = command.transport ??
        decodeRtcTransport(resolveFirstDefined([commandRallar.transport, config?.transport]));
    const apiBaseUrl = resolveFirstDefined([commandRallar.apiBaseUrl, configuredRallar.apiBaseUrl, config?.apiBaseUrl]);
    const expectedSessionId = resolveFirstDefined([
        commandRallar.expectedSessionId,
        commandRallar.sessionId,
        configuredRallar.expectedSessionId,
        configuredRallar.sessionId,
        config?.sessionId
    ]);
    return {
        ...configuredRallar,
        ...commandRallar,
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(transport ? { transport } : {}),
        ...(expectedSessionId ? { expectedSessionId } : {}),
        ...(command.applicationId !== undefined ? { applicationId: command.applicationId } : {}),
        ...(command.workspaceId !== undefined ? { workspaceId: command.workspaceId } : {}),
        ...(command.scope !== undefined ? { scope: command.scope } : {}),
        ...(command.roomRef !== undefined ? { roomRef: command.roomRef } : {}),
        ...(command.minSnapshotVersion !== undefined ? { minSnapshotVersion: command.minSnapshotVersion } : {})
    };
}

function resolveDefaultConnection(config: RallarBlackBoxTestConfig | undefined): string {
    return decodeBrowserCommandString(config?.defaults?.connection) ?? config?.actor ?? 'default';
}

function resolveWebSocketRoom(sources: WebSocketRoomSources): WebSocketRoomSelection {
    const { data, configuredRallar, config } = sources;
    const dataScope = decodeBrowserCommandRecord(data.scope);
    const configuredScope = decodeBrowserCommandRecord(configuredRallar.scope);
    const applicationId = decodeNonEmptyBrowserCommandString(
        resolveFirstDefined([
            data.applicationId,
            dataScope?.applicationId,
            configuredRallar.applicationId,
            configuredScope?.applicationId
        ])
    );
    const workspaceId = decodeNonEmptyBrowserCommandString(
        resolveFirstDefined([
            data.workspaceId,
            dataScope?.workspaceId,
            configuredRallar.workspaceId,
            configuredScope?.workspaceId
        ])
    );
    const wsScope = decodeWebSocketScope(data.scope);
    const roomIdCandidate = decodeNonEmptyBrowserCommandString(
        resolveFirstDefined([data.roomId, data.groupId, config?.roomId])
    );
    const roomId = wsScope === 'all' || wsScope === 'world' ? undefined : roomIdCandidate;
    return {
        applicationId,
        workspaceId,
        stateScope: applicationId ? { applicationId, ...(workspaceId ? { workspaceId } : {}) } : configuredScope,
        roomId,
        roomRef: roomId
            ? decodeBrowserCommandRecord(data.roomRef) ??
                decodeBrowserCommandRecord(configuredRallar.roomRef) ??
                (applicationId
                    ? { applicationId, ...(workspaceId ? { workspaceId } : {}), groupId: roomId }
                    : undefined)
            : undefined
    };
}

function decodeNonEmptyBrowserCommandString(value: unknown): string | undefined {
    const text = decodeBrowserCommandString(value)?.trim();
    return text && text.length > 0 ? text : undefined;
}

function decodeWebSocketScope(value: unknown): 'room' | 'world' | 'all' | undefined {
    return typeof value === 'string' ? WEB_SOCKET_SCOPES.find((scope) => scope === value) : undefined;
}

function resolveFirstDefined<T>(values: readonly T[]): T | undefined {
    return values.find((value) => value !== undefined);
}
