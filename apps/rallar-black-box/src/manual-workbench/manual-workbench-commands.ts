import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRtcSendCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../client-defaults.ts';
import type { ManualWorkbenchAction, ManualWorkbenchValues } from '../manual-workbench.ts';
import { toOptionalText, toScopedRtcFields, toTargets, toTimeoutMs } from './manual-command-fields.ts';

export interface ManualWorkbenchCommandInput {
    readonly action: ManualWorkbenchAction;
    readonly values: ManualWorkbenchValues;
    readonly payload: RallarMessagePayload;
    readonly sequence: number;
    readonly requestId: string;
}

export function toManualConfigureCommand(
    values: ManualWorkbenchValues,
    sequence: number
): RallarBlackBoxTestCommand {
    const rallar = toRallarConfig(values);
    const redaction = toRedaction(values);
    const config: RallarBlackBoxTestConfig = {
        runId: `manual-workbench-${sequence}`,
        agentId: 'visible-agent-local',
        environment: toOptionalText(values.environment),
        apiBaseUrl: toOptionalText(values.apiBaseUrl),
        actor: toOptionalText(values.actor),
        sessionId: toOptionalText(values.sessionId),
        roomId: toOptionalText(values.groupId),
        transport: values.transport === 'ws' ? 'ws' : values.transport,
        control: {
            mode: 'manual-workbench',
            providerMode: values.providerMode,
            protocolVersion: 1,
            connected: false
        },
        defaults: {
            timeoutMs: toTimeoutMs(values),
            connection: toOptionalText(values.connection),
            providerMode: values.providerMode,
            ...toScopedRtcFields(values)
        },
        ...(rallar ? { rallar } : {}),
        ...(redaction ? { redaction } : {})
    };

    return {
        kind: 'configure',
        commandId: toCommandId('configure', sequence),
        label: 'Configure manual group',
        config
    };
}

export function toManualConnectCommand(
    values: ManualWorkbenchValues,
    sequence: number
): RallarBlackBoxTestCommand {
    if (values.transport === 'ws') {
        return {
            kind: 'ws.open',
            commandId: toCommandId('ws-open', sequence),
            label: 'Open manual WebSocket',
            connection: toOptionalText(values.connection),
            url: toOptionalText(values.wsUrl),
            timeoutMs: toTimeoutMs(values),
            metadata: {
                manual: {
                    groupId: toOptionalText(values.groupId),
                    actor: toOptionalText(values.actor)
                }
            }
        };
    }

    return {
        kind: 'rtc.connect',
        commandId: toCommandId('rtc-connect', sequence),
        label: 'Connect manual RTC client',
        connection: toOptionalText(values.connection),
        actor: toOptionalText(values.actor),
        roomId: toOptionalText(values.groupId),
        ...toScopedRtcFields(values),
        transport: values.transport,
        timeoutMs: toTimeoutMs(values),
        rallar: {
            sessionId: toOptionalText(values.sessionId)
        },
        metadata: {
            manual: {
                deliveryMode: values.deliveryMode,
                expectedClients: toTargets(values)
            }
        }
    };
}

export function toManualCreateGroupCommand(
    values: ManualWorkbenchValues,
    sequence: number,
    requestId: string
): RallarBlackBoxTestCommand {
    const groupId = toOptionalText(values.groupId) ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.roomId;
    const applicationId = toOptionalText(values.applicationId) ?? DEFAULT_STATE_APPLICATION_ID;
    const workspaceId = toOptionalText(values.workspaceId) ?? DEFAULT_STATE_WORKSPACE_ID;
    return {
        kind: 'http.request',
        commandId: toCommandId('group-create', sequence),
        label: 'Create manual Rallar group',
        request: {
            method: 'POST',
            path: `/api/state/apps/${encodeURIComponent(applicationId)}/workspaces/${encodeURIComponent(workspaceId)}` +
                `/groups/requests/${requestId}`,
            body: {
                groupId,
                displayName: groupId,
                description: 'Created by rallar-black-box Manual Rallar',
                kind: 'room',
                joinMode: 'open',
                metadata: {
                    source: 'rallar-black-box',
                    surface: 'manual-rallar',
                    ...toScopedRtcFields(values)
                }
            }
        },
        response: {
            body: 'json'
        },
        metadata: {
            manual: {
                groupId,
                action: 'create-group',
                applicationId,
                workspaceId
            }
        }
    };
}

export function toManualSendCommand(
    values: ManualWorkbenchValues,
    payload: RallarMessagePayload,
    sequence: number
): RallarBlackBoxTestCommand {
    const targets = toTargets(values);
    const manual = {
        groupId: toOptionalText(values.groupId),
        topic: toOptionalText(values.topic),
        deliveryMode: values.deliveryMode,
        targets,
        ...toScopedRtcFields(values)
    };

    if (values.transport === 'ws') {
        return {
            kind: 'ws.send',
            commandId: toCommandId(`ws-send-${values.deliveryMode}`, sequence),
            label: `WS ${values.deliveryMode}`,
            connection: toOptionalText(values.connection),
            data: toPayloadEnvelope(values, payload),
            timeoutMs: toTimeoutMs(values),
            metadata: {
                manual
            }
        };
    }

    return toManualRtcSendCommand(values, payload, sequence);
}

export function toManualSimpleCommand(
    action: Extract<ManualWorkbenchAction, 'health' | 'close' | 'reset'>,
    sequence: number
): RallarBlackBoxTestCommand {
    return {
        kind: action,
        commandId: toCommandId(action, sequence),
        label: `Manual ${action}`
    };
}

export function toManualWorkbenchCommands(
    { action, values, payload, sequence, requestId }: ManualWorkbenchCommandInput
): readonly RallarBlackBoxTestCommand[] {
    switch (action) {
        case 'configure':
            return [toManualConfigureCommand(values, sequence)];
        case 'join':
            if (values.providerMode === 'browser-rallar' && values.transport !== 'ws') {
                return [
                    toManualConfigureCommand(values, sequence),
                    toManualCreateGroupCommand(values, sequence + 1, requestId),
                    toManualConnectCommand(values, sequence + 2)
                ];
            }
            return [
                toManualConfigureCommand(values, sequence),
                toManualConnectCommand(values, sequence + 1)
            ];
        case 'connect':
            return [toManualConnectCommand(values, sequence)];
        case 'send':
            return [toManualSendCommand(values, payload, sequence)];
        case 'health':
        case 'close':
        case 'reset':
            return [toManualSimpleCommand(action, sequence)];
    }
}

function toRtcSendPayload(values: ManualWorkbenchValues, payload: RallarMessagePayload): RallarBlackBoxTestRecord {
    const targets = toTargets(values);
    const roomId = toOptionalText(values.groupId);
    if (values.transport === 'messages.rtc') {
        return {
            payload,
            roomId,
            typeId: toOptionalText(values.typeId),
            topicId: toOptionalText(values.topicId) ?? toOptionalText(values.topic),
            ...(targets.length > 0 ? { nextHopPeerIds: targets } : {})
        };
    }
    return {
        data: payload,
        roomId,
        ...(targets.length > 0 ? { peerIds: targets } : {})
    };
}

export function toManualRtcSendCommand(
    values: ManualWorkbenchValues,
    payload: RallarMessagePayload,
    sequence: number
): RallarBlackBoxTestRtcSendCommand {
    const targets = toTargets(values);
    const manual = {
        groupId: toOptionalText(values.groupId),
        topic: toOptionalText(values.topic),
        deliveryMode: values.deliveryMode,
        targets,
        ...toScopedRtcFields(values)
    };

    const basePayload = toRtcSendPayload(values, payload);
    return {
        kind: 'rtc.send',
        commandId: toCommandId(`rtc-send-${values.deliveryMode}`, sequence),
        label: `RTC ${values.deliveryMode}`,
        connection: toOptionalText(values.connection),
        transport: values.transport === 'messages.rtc' ? 'messages.rtc' : 'realtime',
        ...toScopedRtcFields(values),
        send: basePayload,
        timeoutMs: toTimeoutMs(values),
        metadata: {
            manual
        }
    };
}

function toRallarConfig(
    values: ManualWorkbenchValues
): RallarBlackBoxTestRecord | undefined {
    if (values.providerMode !== 'browser-rallar') {
        return undefined;
    }

    const username = toOptionalText(values.rallarUsername ?? '');
    const password = toOptionalText(values.rallarPassword ?? '');
    const rallar: RallarBlackBoxTestRecord = {
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        ...(values.rallarRegister ? { register: true } : {}),
        ...(values.rallarRestoreSession ? { restoreSession: true } : {}),
        ...(values.rallarLogoutOnClose ? { logoutOnClose: true } : {}),
        leaveRoomOnClose: values.rallarLeaveRoomOnClose,
        ...toScopedRtcFields(values)
    };

    return Object.keys(rallar).length > 0 ? rallar : undefined;
}

function toRedaction(
    values: ManualWorkbenchValues
): RallarBlackBoxTestConfig['redaction'] | undefined {
    const secretValues = [
        values.rallarPassword
    ].filter((value): value is string => Boolean(value && value.length > 0));

    return secretValues.length > 0 ? { secretValues } : undefined;
}

function toCommandId(action: string, sequence: number): string {
    return `manual-${action}-${sequence}`;
}

function toPayloadEnvelope(
    values: ManualWorkbenchValues,
    payload: RallarMessagePayload
): RallarBlackBoxTestRecord {
    const targets = toTargets(values);
    return {
        groupId: toOptionalText(values.groupId),
        topic: toOptionalText(values.topic),
        deliveryMode: values.deliveryMode,
        targets,
        payload
    };
}
