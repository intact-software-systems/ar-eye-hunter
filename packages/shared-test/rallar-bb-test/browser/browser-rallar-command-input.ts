import type {
    RallarBlackBoxTestConfig
} from '../rallar-black-box-test-contracts.ts';

import { CommandWithId, RallarBlackBoxBrowserRallarConnectionConfig } from './browser-command-contracts.ts';
import {
    resolveFirstDefined,
    toBrowserCommandRecord,
    toNonEmptyStringValue,
    toOptionalBrowserCommandRecord,
    toRtcTransport,
    toStringValue,
    toWebSocketScope
} from './browser-command-values.ts';

export function toRallarAuthConnectionConfig(
    config: RallarBlackBoxTestConfig | undefined
): RallarBlackBoxBrowserRallarConnectionConfig {
    const configuredRallar = toBrowserCommandRecord(config?.rallar);
    const defaults = toBrowserCommandRecord(config?.defaults);
    const apiBaseUrl = resolveFirstDefined([configuredRallar.apiBaseUrl, config?.apiBaseUrl]);
    const expectedSessionId = resolveFirstDefined([
        configuredRallar.expectedSessionId,
        configuredRallar.sessionId,
        config?.sessionId
    ]);

    return {
        connection: toStringValue(defaults.connection) ?? config?.actor ?? 'default',
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
    const configuredRallar = toBrowserCommandRecord(config?.rallar);
    const commandRallar = toBrowserCommandRecord(command.rallar);
    const transport = command.transport ??
        toRtcTransport(resolveFirstDefined([commandRallar.transport, config?.transport]));
    const apiBaseUrl = resolveFirstDefined([commandRallar.apiBaseUrl, configuredRallar.apiBaseUrl, config?.apiBaseUrl]);
    const expectedSessionId = resolveFirstDefined([
        commandRallar.expectedSessionId,
        commandRallar.sessionId,
        configuredRallar.expectedSessionId,
        configuredRallar.sessionId,
        config?.sessionId
    ]);
    const rallar = {
        ...configuredRallar,
        ...commandRallar,
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(transport ? { transport } : {}),
        ...(expectedSessionId ? { expectedSessionId } : {}),
        ...(command.applicationId !== undefined
            ? { applicationId: command.applicationId }
            : {}),
        ...(command.workspaceId !== undefined
            ? { workspaceId: command.workspaceId }
            : {}),
        ...(command.scope !== undefined ? { scope: command.scope } : {}),
        ...(command.roomRef !== undefined ? { roomRef: command.roomRef } : {}),
        ...(command.minSnapshotVersion !== undefined
            ? { minSnapshotVersion: command.minSnapshotVersion }
            : {})
    };

    return {
        connection: command.connection ??
            toStringValue(toBrowserCommandRecord(config?.defaults).connection) ??
            config?.actor ??
            'default',
        actor: command.actor ?? config?.actor,
        roomId: command.roomId ?? config?.roomId,
        roomRef: command.roomRef,
        rallar
    };
}

export function toRallarWebSocketConnectionConfig(
    command: Extract<CommandWithId, { kind: 'ws.send'; }>,
    config: RallarBlackBoxTestConfig | undefined
): RallarBlackBoxBrowserRallarConnectionConfig {
    const configuredRallar = toBrowserCommandRecord(config?.rallar);
    const data = toBrowserCommandRecord(command.data);
    const { applicationId, workspaceId, stateScope, roomId, roomRef } = resolveWebSocketRoom(
        command,
        configuredRallar,
        config
    );
    const apiBaseUrl = toNonEmptyStringValue(
        resolveFirstDefined([configuredRallar.apiBaseUrl, config?.apiBaseUrl])
    );
    const expectedSessionId = toNonEmptyStringValue(
        resolveFirstDefined([configuredRallar.expectedSessionId, configuredRallar.sessionId, config?.sessionId])
    );
    const typeId = toNonEmptyStringValue(data.typeId);
    const topicId = toNonEmptyStringValue(data.topicId);
    const rallar = {
        ...configuredRallar,
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        transport: 'realtime',
        restoreSession: configuredRallar.restoreSession ?? true,
        ...(expectedSessionId ? { expectedSessionId } : {}),
        ...(applicationId ? { applicationId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(stateScope ? { scope: stateScope } : {}),
        ...(roomRef ? { roomRef } : {}),
        ...(typeId ? { typeId } : {}),
        ...(topicId ? { topicId } : {})
    };

    return {
        connection: command.connection ??
            toStringValue(toBrowserCommandRecord(config?.defaults).connection) ??
            config?.actor ??
            'default',
        actor: config?.actor,
        ...(roomId ? { roomId } : {}),
        ...(roomRef ? { roomRef } : {}),
        rallar
    };
}

function resolveWebSocketRoom(
    command: Extract<CommandWithId, { kind: 'ws.send'; }>,
    configuredRallar: Record<string, unknown>,
    config: RallarBlackBoxTestConfig | undefined
): WebSocketRoomSelection {
    const data = toBrowserCommandRecord(command.data);
    const dataScope = toOptionalBrowserCommandRecord(data.scope);
    const configuredScope = toOptionalBrowserCommandRecord(configuredRallar.scope);
    const applicationId = toNonEmptyStringValue(
        resolveFirstDefined([
            data.applicationId,
            dataScope?.applicationId,
            configuredRallar.applicationId,
            configuredScope?.applicationId
        ])
    );
    const workspaceId = toNonEmptyStringValue(
        resolveFirstDefined([
            data.workspaceId,
            dataScope?.workspaceId,
            configuredRallar.workspaceId,
            configuredScope?.workspaceId
        ])
    );
    const stateScope = applicationId
        ? {
            applicationId,
            ...(workspaceId ? { workspaceId } : {})
        }
        : configuredScope;
    const wsScope = toWebSocketScope(data.scope);
    const roomIdCandidate = toNonEmptyStringValue(
        resolveFirstDefined([data.roomId, data.groupId, config?.roomId])
    );
    const roomId = wsScope === 'all' || wsScope === 'world' ? undefined : roomIdCandidate;
    const configuredRoomRef = toOptionalBrowserCommandRecord(configuredRallar.roomRef);
    const dataRoomRef = toOptionalBrowserCommandRecord(data.roomRef);
    const roomRef = roomId
        ? (dataRoomRef ??
            configuredRoomRef ??
            (applicationId
                ? {
                    applicationId,
                    ...(workspaceId ? { workspaceId } : {}),
                    groupId: roomId
                }
                : undefined))
        : undefined;
    return { applicationId, workspaceId, stateScope, roomId, roomRef };
}

interface WebSocketRoomSelection {
    readonly applicationId: string | undefined;
    readonly workspaceId: string | undefined;
    readonly stateScope: Record<string, unknown> | undefined;
    readonly roomId: string | undefined;
    readonly roomRef: Record<string, unknown> | undefined;
}

export function toScopedRtcSend(
    command: Extract<CommandWithId, { kind: 'rtc.send' | 'rtc.stream'; }>,
    streamSend: unknown
): unknown {
    const scopedSendFields = Object.fromEntries(
        Object.entries({
            roomId: 'roomId' in command ? command.roomId : undefined,
            applicationId: command.applicationId,
            workspaceId: command.workspaceId,
            scope: command.scope,
            roomRef: command.roomRef,
            minSnapshotVersion: command.minSnapshotVersion
        }).filter(([_key, value]) => value !== undefined)
    );
    if (Object.keys(scopedSendFields).length === 0) {
        return streamSend;
    }

    return streamSend &&
            typeof streamSend === 'object' &&
            !Array.isArray(streamSend)
        ? {
            ...(streamSend as Record<string, unknown>),
            ...Object.fromEntries(
                Object.entries(scopedSendFields).filter(
                    ([key]) => !Object.prototype.hasOwnProperty.call(streamSend, key)
                )
            )
        }
        : {
            data: streamSend,
            ...scopedSendFields
        };
}
