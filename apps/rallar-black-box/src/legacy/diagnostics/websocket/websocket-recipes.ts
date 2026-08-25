import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { json } from '../../shared/json-presentation.ts';
import { uiSecretValues } from '../../shared/redaction-presentation.ts';
import type { WebSocketCommandCenterValues } from './websocket-contracts.ts';
import { webSocketSendData } from './websocket-routing.ts';

function webSocketConfigureCommand(
    input: Readonly<{
        values: WebSocketCommandCenterValues;
        bootstrap: RallarBlackBoxBootstrapConfig;
        providerMode: string;
        authSession?: AuthSession;
        sequence: number;
    }>
): RallarBlackBoxTestCommand {
    const browserRallar = input.providerMode === 'browser-rallar';
    const rallar = browserRallar
        ? {
            ...((input.authSession?.username ??
                    input.bootstrap.rallarUsername)
                ? {
                    username: input.authSession?.username ??
                        input.bootstrap.rallarUsername
                }
                : {}),
            ...(input.bootstrap.rallarPassword
                ? { password: input.bootstrap.rallarPassword }
                : {}),
            ...(input.authSession || input.bootstrap.rallarRestoreSession
                ? { restoreSession: true }
                : {}),
            ...(input.bootstrap.rallarRegister
                ? { register: input.bootstrap.rallarRegister }
                : {}),
            ...(input.bootstrap.rallarLogoutOnClose
                ? { logoutOnClose: true }
                : {}),
            leaveRoomOnClose: input.bootstrap.rallarLeaveRoomOnClose,
            applicationId: input.values.applicationId,
            workspaceId: input.values.workspaceId,
            scope: {
                applicationId: input.values.applicationId,
                workspaceId: input.values.workspaceId
            },
            ...(input.values.groupId
                ? {
                    roomRef: {
                        applicationId: input.values.applicationId,
                        workspaceId: input.values.workspaceId,
                        groupId: input.values.groupId
                    }
                }
                : {}),
            typeId: input.values.typeId,
            topicId: input.values.topicId
        }
        : undefined;

    return {
        kind: 'configure',
        commandId: `ws-configure-${input.sequence}`,
        label: 'Configure WebSocket command center',
        config: {
            runId: `websocket-command-center-${input.sequence}`,
            agentId: input.bootstrap.agentId,
            environment: input.bootstrap.environment,
            apiBaseUrl: input.values.apiBaseUrl,
            actor: input.authSession?.username ?? input.bootstrap.actor,
            sessionId: input.authSession?.sessionId ?? input.bootstrap.sessionId,
            roomId: input.values.groupId,
            transport: 'ws',
            ...(rallar ? { rallar } : {}),
            control: {
                mode: 'websocket-command-center',
                providerMode: input.providerMode,
                protocolVersion: 1,
                connected: false
            },
            defaults: {
                timeoutMs: input.values.timeoutMs,
                connection: input.values.connection,
                providerMode: input.providerMode
            }
        }
    };
}

function webSocketOpenCommand(
    values: WebSocketCommandCenterValues,
    sequence: number,
    url = values.wsUrl
): RallarBlackBoxTestCommand {
    const protocols = values.protocols
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    return {
        kind: 'ws.open',
        commandId: `ws-open-${sequence}`,
        label: 'Open WebSocket',
        connection: values.connection,
        url,
        ...(protocols.length > 0 ? { protocols } : {}),
        timeoutMs: values.timeoutMs
    };
}

function webSocketSendCommand(
    values: WebSocketCommandCenterValues,
    payload: unknown,
    sequence: number
): RallarBlackBoxTestCommand {
    return {
        kind: 'ws.send',
        commandId: `ws-send-${sequence}`,
        label: 'Send WebSocket JSON',
        connection: values.connection,
        data: webSocketSendData(values, payload),
        timeoutMs: values.timeoutMs
    };
}

function webSocketCloseCommand(
    values: WebSocketCommandCenterValues,
    sequence: number,
    reason = values.closeReason
): RallarBlackBoxTestCommand {
    return {
        kind: 'ws.close',
        commandId: `ws-close-${sequence}`,
        label: 'Close WebSocket',
        connection: values.connection,
        code: Number.isFinite(values.closeCode) ? values.closeCode : 1000,
        reason,
        timeoutMs: values.timeoutMs
    };
}

export function webSocketCommandCenterRecipe(
    input: Readonly<{
        values: WebSocketCommandCenterValues;
        payload: unknown;
        bootstrap: RallarBlackBoxBootstrapConfig;
        providerMode: string;
        authSession?: AuthSession;
        sequence: number;
        includeRtcParity?: boolean;
    }>
): string {
    const commands: RallarBlackBoxTestCommand[] = [
        webSocketConfigureCommand(input),
        webSocketOpenCommand(input.values, input.sequence + 1),
        webSocketSendCommand(input.values, input.payload, input.sequence + 2)
    ];
    if (input.includeRtcParity) {
        commands.push(
            {
                kind: 'rtc.connect',
                commandId: `ws-rtc-parity-connect-${input.sequence + 3}`,
                label: 'Connect RTC comparison client',
                connection: `${input.values.connection}-rtc`,
                actor: input.authSession?.username ?? input.bootstrap.actor,
                roomId: input.bootstrap.roomId,
                transport: 'realtime',
                timeoutMs: input.values.timeoutMs,
                rallar: {
                    sessionId: input.authSession?.sessionId ??
                        input.bootstrap.sessionId
                }
            },
            {
                kind: 'rtc.send',
                commandId: `ws-rtc-parity-send-${input.sequence + 4}`,
                label: 'Send RTC comparison JSON',
                connection: `${input.values.connection}-rtc`,
                transport: 'realtime',
                send: input.payload,
                timeoutMs: input.values.timeoutMs
            }
        );
    }
    commands.push(
        webSocketCloseCommand(
            input.values,
            input.sequence + commands.length + 1
        )
    );

    return json({
        recipeId: input.includeRtcParity
            ? 'rallar-websocket-rtc-parity-command-center'
            : 'rallar-websocket-command-center',
        name: input.includeRtcParity
            ? 'Rallar WebSocket and RTC comparison command-center recipe'
            : 'Rallar WebSocket command-center recipe',
        continueOnFailure: false,
        commands: redactRallarBlackBoxValue(commands, {
            secretValues: uiSecretValues(undefined, input.authSession, [
                input.bootstrap.rallarPassword
            ])
        })
    });
}
