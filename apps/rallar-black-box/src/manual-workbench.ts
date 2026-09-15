import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestTransport
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import type { RallarBlackBoxProviderMode } from './client-defaults.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from './client-defaults.ts';
export interface ManualWorkbenchCommandInput {
    readonly action: ManualWorkbenchAction;
    readonly values: ManualWorkbenchValues;
    readonly payload: unknown;
    readonly sequence: number;
    readonly requestId: string;
}

export interface ManualRtcDeliveryMatrixInput {
    readonly values: ManualWorkbenchValues;
    readonly payload: unknown;
    readonly sequence: number;
    readonly transport: Extract<ManualWorkbenchTransport, 'realtime' | 'messages.rtc'>;
    readonly requestId: string;
}

export type ManualWorkbenchTransport = Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc' | 'ws'>;

export type ManualDeliveryMode = 'direct' | 'multicast' | 'broadcast';

export type ManualWorkbenchAction =
    | 'configure'
    | 'join'
    | 'connect'
    | 'send'
    | 'health'
    | 'close'
    | 'reset';

export interface ManualWorkbenchValues {
    readonly environment: string;
    readonly apiBaseUrl: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly actor: string;
    readonly sessionId: string;
    readonly groupId: string;
    readonly scopeText: string;
    readonly roomRefText: string;
    readonly minSnapshotVersion: number;
    readonly connection: string;
    readonly targetClient: string;
    readonly multicastClients: string;
    readonly transport: ManualWorkbenchTransport;
    readonly deliveryMode: ManualDeliveryMode;
    readonly wsUrl: string;
    readonly topic: string;
    readonly typeId: string;
    readonly topicId: string;
    readonly timeoutMs: number;
    readonly providerMode: RallarBlackBoxProviderMode;
    readonly rallarUsername?: string;
    readonly rallarPassword?: string;
    readonly rallarRegister: boolean;
    readonly rallarRestoreSession: boolean;
    readonly rallarLogoutOnClose: boolean;
    readonly rallarLeaveRoomOnClose: boolean;
}

export interface ManualPayloadPreset {
    readonly presetId: string;
    readonly label: string;
    readonly payload: unknown;
}

export interface ManualActionHistoryEntry {
    readonly actionId: string;
    readonly label: string;
    readonly commandIds: readonly string[];
    readonly commands: readonly RallarBlackBoxTestCommand[];
    readonly atEpochMs: number;
}

export interface ManualReceivedMessage {
    readonly eventId: string;
    readonly connection: string;
    readonly transport: string;
    readonly sender: string;
    readonly topic: string;
    readonly atEpochMs: number;
    readonly payload: unknown;
    readonly commandId?: string;
}

export type JsonParseResult =
    | Readonly<{ ok: true; value: unknown; }>
    | Readonly<{ ok: false; error: string; }>;

export const MANUAL_PAYLOAD_PRESETS: readonly ManualPayloadPreset[] = [
    {
        presetId: 'ping',
        label: 'Ping',
        payload: {
            topic: 'manual.ping',
            kind: 'ping',
            seq: 1
        }
    },
    {
        presetId: 'parity-probe',
        label: 'Parity Probe',
        payload: {
            topic: 'manual.parity',
            probeId: 'manual-parity-1',
            sentAt: 'manual-clock'
        }
    },
    {
        presetId: 'membership-probe',
        label: 'Membership Probe',
        payload: {
            topic: 'manual.membership',
            expectedClients: []
        }
    }
];

export const DEFAULT_MANUAL_WORKBENCH_VALUES: ManualWorkbenchValues = {
    environment: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.environment,
    apiBaseUrl: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.apiBaseUrl,
    applicationId: DEFAULT_STATE_APPLICATION_ID,
    workspaceId: DEFAULT_STATE_WORKSPACE_ID,
    actor: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.actor,
    sessionId: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.sessionId,
    groupId: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.roomId,
    scopeText: '',
    roomRefText: '',
    minSnapshotVersion: 0,
    connection: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.connection,
    targetClient: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.targetClient,
    multicastClients: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.multicastClients,
    transport: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.transport,
    deliveryMode: 'direct',
    wsUrl: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.wsUrl,
    topic: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.topic,
    typeId: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.typeId,
    topicId: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.topicId,
    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
    providerMode: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.providerMode,
    rallarUsername: undefined,
    rallarPassword: undefined,
    rallarRegister: false,
    rallarRestoreSession: false,
    rallarLogoutOnClose: false,
    rallarLeaveRoomOnClose: true
};

function toOptionalText(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function toTargetIds(value: string): readonly string[] {
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function toTimeoutMs(value: ManualWorkbenchValues): number | undefined {
    return Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
        ? Math.round(value.timeoutMs)
        : undefined;
}

function parseOptionalRecord(text: string): Readonly<Record<string, unknown>> | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(trimmed) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
    }
    catch {
        return undefined;
    }
}

function toMinSnapshotVersion(value: ManualWorkbenchValues): number | undefined {
    return Number.isFinite(value.minSnapshotVersion) && value.minSnapshotVersion > 0
        ? Math.round(value.minSnapshotVersion)
        : undefined;
}

function toDefaultRoomRef(values: ManualWorkbenchValues): Readonly<Record<string, unknown>> | undefined {
    const groupId = toOptionalText(values.groupId);
    return groupId ? { groupId } : undefined;
}

function toScopedRtcFields(
    values: ManualWorkbenchValues
): ManualRtcScope {
    const applicationId = toOptionalText(values.applicationId);
    const workspaceId = toOptionalText(values.workspaceId);
    const scope = parseOptionalRecord(values.scopeText);
    const roomRef = parseOptionalRecord(values.roomRefText) ?? toDefaultRoomRef(values);
    const minSnapshotVersion = toMinSnapshotVersion(values);
    return {
        ...(applicationId ? { applicationId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(scope ? { scope } : {}),
        ...(roomRef ? { roomRef } : {}),
        ...(minSnapshotVersion !== undefined ? { minSnapshotVersion } : {})
    };
}

function toRallarConfig(
    values: ManualWorkbenchValues
): Readonly<Record<string, unknown>> | undefined {
    if (values.providerMode !== 'browser-rallar') {
        return undefined;
    }

    const username = toOptionalText(values.rallarUsername ?? '');
    const password = toOptionalText(values.rallarPassword ?? '');
    const rallar: Record<string, unknown> = {
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

function toTargets(values: ManualWorkbenchValues): readonly string[] {
    if (values.deliveryMode === 'broadcast') {
        return [];
    }

    if (values.deliveryMode === 'direct') {
        const target = toOptionalText(values.targetClient);
        return target ? [target] : [];
    }

    return toTargetIds(values.multicastClients);
}

function toPayloadEnvelope(
    values: ManualWorkbenchValues,
    payload: unknown
): Record<string, unknown> {
    const targets = toTargets(values);
    return {
        groupId: toOptionalText(values.groupId),
        topic: toOptionalText(values.topic),
        deliveryMode: values.deliveryMode,
        targets,
        payload
    };
}

export function parseManualPayload(text: string): JsonParseResult {
    try {
        return {
            ok: true,
            value: JSON.parse(text) as unknown
        };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

export function manualConfigureCommand(
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

export function manualConnectCommand(
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

export function manualCreateGroupCommand(
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

export function manualSendCommand(
    values: ManualWorkbenchValues,
    payload: unknown,
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

export function manualRtcDeliveryMatrixCommands(
    { values, payload, sequence, transport, requestId }: ManualRtcDeliveryMatrixInput
): readonly RallarBlackBoxTestCommand[] {
    const baseValues: ManualWorkbenchValues = {
        ...values,
        transport,
        deliveryMode: 'direct'
    };
    const commands: RallarBlackBoxTestCommand[] = [manualConfigureCommand(baseValues, sequence)];
    let nextSequence = sequence + 1;

    if (baseValues.providerMode === 'browser-rallar') {
        commands.push(manualCreateGroupCommand(baseValues, nextSequence, requestId));
        nextSequence += 1;
    }

    commands.push(manualConnectCommand(baseValues, nextSequence));
    nextSequence += 1;

    for (const deliveryMode of ['direct', 'multicast', 'broadcast'] as const) {
        commands.push(manualSendCommand(
            {
                ...baseValues,
                deliveryMode
            },
            payload,
            nextSequence
        ));
        nextSequence += 1;
    }

    return commands;
}

export function manualRtcNackProbeCommands(
    values: ManualWorkbenchValues,
    payload: unknown,
    sequence: number
): readonly RallarBlackBoxTestCommand[] {
    const transport = values.transport === 'messages.rtc' ? 'messages.rtc' : 'realtime';
    const scopedValues: ManualWorkbenchValues = {
        ...values,
        transport,
        deliveryMode: 'direct',
        minSnapshotVersion: Math.max(values.minSnapshotVersion, 9_999_999)
    };
    const send = toManualRtcSendCommand(scopedValues, payload, sequence);
    return [{
        ...send,
        commandId: toCommandId('rtc-nack-not-yet-in-sync', sequence),
        label: 'RTC not-yet-in-sync probe',
        metadata: {
            ...send.metadata,
            negativeCase: 'not-yet-in-sync',
            expectedOutcome: 'nack'
        }
    }];
}

export function manualRtcNegativeRecipeSnippet(
    values: ManualWorkbenchValues,
    payload: unknown
): string {
    const commands = toNegativeRtcCommands(values, payload);
    return JSON.stringify(
        {
            schemaVersion: 1,
            recipeId: 'manual-rtc-negative-recipe',
            name: 'Manual RTC negative recipe',
            description:
                'Missing peer, stale agent, duplicate session, permission denied, closed transport, and not-yet-in-sync/NACK probes.',
            continueOnFailure: true,
            commands
        },
        null,
        2
    );
}

export function manualSimpleCommand(
    action: Extract<ManualWorkbenchAction, 'health' | 'close' | 'reset'>,
    sequence: number
): RallarBlackBoxTestCommand {
    return {
        kind: action,
        commandId: toCommandId(action, sequence),
        label: `Manual ${action}`
    };
}

export function buildManualWorkbenchCommands(
    { action, values, payload, sequence, requestId }: ManualWorkbenchCommandInput
): readonly RallarBlackBoxTestCommand[] {
    switch (action) {
        case 'configure':
            return [manualConfigureCommand(values, sequence)];
        case 'join':
            if (values.providerMode === 'browser-rallar' && values.transport !== 'ws') {
                return [
                    manualConfigureCommand(values, sequence),
                    manualCreateGroupCommand(values, sequence + 1, requestId),
                    manualConnectCommand(values, sequence + 2)
                ];
            }
            return [
                manualConfigureCommand(values, sequence),
                manualConnectCommand(values, sequence + 1)
            ];
        case 'connect':
            return [manualConnectCommand(values, sequence)];
        case 'send':
            return [manualSendCommand(values, payload, sequence)];
        case 'health':
        case 'close':
        case 'reset':
            return [manualSimpleCommand(action, sequence)];
    }
}

export function manualRecipeSnippet(
    entries: readonly ManualActionHistoryEntry[]
): string {
    const commands = entries.flatMap((entry) => entry.commands);
    return JSON.stringify(
        {
            schemaVersion: 1,
            recipeId: 'manual-workbench-recipe',
            name: 'Manual workbench recipe',
            continueOnFailure: false,
            commands
        },
        null,
        2
    );
}

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function toFirstText(values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }

    return undefined;
}

export function deriveManualReceivedMessages(
    events: readonly RallarBlackBoxTestEvent[]
): readonly ManualReceivedMessage[] {
    return events
        .filter((event) => event.kind === 'message')
        .map((event) => {
            const payload = toRecord(event.payload);
            const data = toRecord(payload.data);
            const nestedData = toRecord(data.data);
            const envelope = toRecord(data.payload);
            return {
                eventId: event.eventId,
                connection: event.connection ?? 'default',
                transport: event.transport ?? 'runtime',
                sender: toFirstText([
                    payload.senderId,
                    payload.remotePeerId,
                    data.senderId,
                    data.sender,
                    nestedData.senderId,
                    nestedData.sender,
                    event.actor
                ]) ?? '-',
                topic: toFirstText([
                    payload.topicId,
                    payload.topic,
                    data.topic,
                    nestedData.topic,
                    envelope.topic,
                    event.topic
                ]) ?? event.topic,
                atEpochMs: typeof payload.receivedAtEpochMs === 'number'
                    ? payload.receivedAtEpochMs
                    : event.atEpochMs,
                payload: payload.data ?? event.payload,
                commandId: event.commandId
            };
        });
}

function toNegativeRtcSend(
    values: ManualWorkbenchValues,
    payload: unknown,
    caseId: keyof typeof NEGATIVE_RTC_SEND_CASES
): RallarBlackBoxTestCommand {
    const probe = NEGATIVE_RTC_SEND_CASES[caseId];
    const targetClient = 'targetClient' in probe ? probe.targetClient : values.targetClient;
    return {
        ...toManualRtcSendCommand({ ...values, targetClient }, payload, probe.sequence),
        commandId: probe.commandId,
        label: probe.label,
        metadata: probe.metadata
    };
}

function toRtcSendPayload(values: ManualWorkbenchValues, payload: unknown): Record<string, unknown> {
    const targets = toTargets(values);
    const basePayload: Record<string, unknown> = values.transport === 'messages.rtc'
        ? {
            payload,
            roomId: toOptionalText(values.groupId),
            typeId: toOptionalText(values.typeId),
            topicId: toOptionalText(values.topicId) ?? toOptionalText(values.topic)
        }
        : {
            data: payload,
            roomId: toOptionalText(values.groupId)
        };
    if (values.deliveryMode !== 'broadcast' && targets.length > 0) {
        if (values.transport === 'messages.rtc') {
            basePayload.nextHopPeerIds = targets;
        }
        else {
            basePayload.peerIds = targets;
        }
    }
    return basePayload;
}

function toManualRtcSendCommand(
    values: ManualWorkbenchValues,
    payload: unknown,
    sequence: number
): Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }> {
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

function toNegativeRtcCommands(values: ManualWorkbenchValues, payload: unknown): readonly RallarBlackBoxTestCommand[] {
    const baseValues: ManualWorkbenchValues = {
        ...values,
        transport: values.transport === 'messages.rtc' ? 'messages.rtc' : 'realtime',
        deliveryMode: 'direct'
    };
    return [
        manualConfigureCommand(baseValues, 1),
        manualConnectCommand(baseValues, 2),
        toNegativeRtcSend(baseValues, payload, 'missingPeer'),
        toNegativeRtcSend(baseValues, payload, 'staleAgent'),
        {
            ...manualConnectCommand(baseValues, 5),
            commandId: 'manual-rtc-negative-duplicate-session',
            label: 'RTC duplicate session negative',
            metadata: { negativeCase: 'duplicate-session', expectedOutcome: 'permission-failure' }
        },
        toNegativeRtcSend(baseValues, payload, 'permissionDenied'),
        manualSimpleCommand('close', 7),
        toNegativeRtcSend(baseValues, payload, 'closedTransport'),
        ...manualRtcNackProbeCommands(baseValues, payload, 9)
    ];
}
const NEGATIVE_RTC_SEND_CASES = {
    missingPeer: {
        sequence: 3,
        targetClient: 'missing-peer',
        commandId: 'manual-rtc-negative-missing-peer',
        label: 'RTC missing peer negative',
        metadata: { negativeCase: 'missing-peer', expectedOutcome: 'delivery-failure' }
    },
    staleAgent: {
        sequence: 4,
        targetClient: 'stale-agent',
        commandId: 'manual-rtc-negative-stale-agent',
        label: 'RTC stale agent negative',
        metadata: { negativeCase: 'stale-agent', expectedOutcome: 'delivery-failure' }
    },
    permissionDenied: {
        sequence: 6,
        commandId: 'manual-rtc-negative-permission-denied',
        label: 'RTC permission denied negative',
        metadata: { negativeCase: 'permission-denied', expectedOutcome: 'permission-failure' }
    },
    closedTransport: {
        sequence: 8,
        commandId: 'manual-rtc-negative-closed-transport',
        label: 'RTC closed transport negative',
        metadata: { negativeCase: 'closed-transport', expectedOutcome: 'transport-failure' }
    }
} as const;

interface ManualRtcScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: Readonly<Record<string, unknown>>;
    readonly roomRef?: Readonly<Record<string, unknown>>;
    readonly minSnapshotVersion?: number;
}
