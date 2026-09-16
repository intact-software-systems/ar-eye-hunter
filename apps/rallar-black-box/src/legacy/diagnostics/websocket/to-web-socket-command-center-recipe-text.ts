import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecord
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { json } from '../../shared/json-presentation.ts';
import { uiSecretValues } from '../../shared/redaction-presentation.ts';
import type { WebSocketCommandCenterValues } from './websocket-contracts.ts';
import { webSocketSendData } from './websocket-routing.ts';

export interface WebSocketCommandCenterRecipeInput {
    readonly values: WebSocketCommandCenterValues;
    readonly payload: RallarMessagePayload;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly providerMode: string;
    readonly authSession?: AuthSession;
    readonly sequence: number;
    readonly includeRtcParity: boolean;
}

export function toWebSocketCommandCenterRecipeText(input: WebSocketCommandCenterRecipeInput): string {
    const { values, sequence } = input;
    const commands: RallarBlackBoxTestCommand[] = [
        toWebSocketConfigureCommand(input),
        toWebSocketOpenCommand(values, sequence + 1),
        toWebSocketSendCommand(values, input.payload, sequence + 2),
        ...(input.includeRtcParity ? toRtcParityCommands(input) : [])
    ];
    commands.push(toWebSocketCloseCommand(values, sequence + commands.length + 1));

    return json({
        schemaVersion: 1,
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

function toWebSocketConfigureCommand(input: WebSocketCommandCenterRecipeInput): RallarBlackBoxTestCommand {
    const { values, bootstrap, authSession, providerMode, sequence } = input;
    const rallar = providerMode === 'browser-rallar' ? toWebSocketRallarConfig(input) : undefined;
    return {
        kind: 'configure',
        commandId: `ws-configure-${sequence}`,
        label: 'Configure WebSocket command center',
        config: {
            runId: `websocket-command-center-${sequence}`,
            agentId: bootstrap.agentId,
            environment: bootstrap.environment,
            apiBaseUrl: values.apiBaseUrl,
            actor: authSession?.username ?? bootstrap.actor,
            sessionId: authSession?.sessionId ?? bootstrap.sessionId,
            roomId: values.groupId,
            transport: 'ws',
            ...(rallar ? { rallar } : {}),
            control: {
                mode: 'websocket-command-center',
                providerMode,
                protocolVersion: 1,
                connected: false
            },
            defaults: {
                timeoutMs: values.timeoutMs,
                connection: values.connection,
                providerMode
            }
        }
    };
}

function toWebSocketRallarConfig(
    { values, bootstrap, authSession }: WebSocketCommandCenterRecipeInput
): RallarBlackBoxTestRecord {
    const username = authSession?.username ?? bootstrap.rallarUsername;
    const { applicationId, workspaceId, groupId } = values;
    return {
        ...(username ? { username } : {}),
        ...(bootstrap.rallarPassword ? { password: bootstrap.rallarPassword } : {}),
        ...(authSession || bootstrap.rallarRestoreSession ? { restoreSession: true } : {}),
        ...(bootstrap.rallarRegister ? { register: bootstrap.rallarRegister } : {}),
        ...(bootstrap.rallarLogoutOnClose ? { logoutOnClose: true } : {}),
        leaveRoomOnClose: bootstrap.rallarLeaveRoomOnClose,
        applicationId,
        workspaceId,
        scope: { applicationId, workspaceId },
        ...(groupId ? { roomRef: { applicationId, workspaceId, groupId } } : {}),
        typeId: values.typeId,
        topicId: values.topicId
    };
}

function toWebSocketOpenCommand(
    values: WebSocketCommandCenterValues,
    sequence: number
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
        url: values.wsUrl,
        ...(protocols.length > 0 ? { protocols } : {}),
        timeoutMs: values.timeoutMs
    };
}

function toWebSocketSendCommand(
    values: WebSocketCommandCenterValues,
    payload: RallarMessagePayload,
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

function toRtcParityCommands(
    { values, bootstrap, authSession, payload, sequence }: WebSocketCommandCenterRecipeInput
): readonly RallarBlackBoxTestCommand[] {
    const connection = `${values.connection}-rtc`;
    return [
        {
            kind: 'rtc.connect',
            commandId: `ws-rtc-parity-connect-${sequence + 3}`,
            label: 'Connect RTC comparison client',
            connection,
            actor: authSession?.username ?? bootstrap.actor,
            roomId: bootstrap.roomId,
            transport: 'realtime',
            timeoutMs: values.timeoutMs,
            rallar: {
                sessionId: authSession?.sessionId ?? bootstrap.sessionId
            }
        },
        {
            kind: 'rtc.send',
            commandId: `ws-rtc-parity-send-${sequence + 4}`,
            label: 'Send RTC comparison JSON',
            connection,
            transport: 'realtime',
            send: payload,
            timeoutMs: values.timeoutMs
        }
    ];
}

function toWebSocketCloseCommand(
    values: WebSocketCommandCenterValues,
    sequence: number
): RallarBlackBoxTestCommand {
    return {
        kind: 'ws.close',
        commandId: `ws-close-${sequence}`,
        label: 'Close WebSocket',
        connection: values.connection,
        code: Number.isFinite(values.closeCode) ? values.closeCode : 1000,
        reason: values.closeReason,
        timeoutMs: values.timeoutMs
    };
}
