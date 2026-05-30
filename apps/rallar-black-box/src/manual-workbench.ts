import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestTransport,
} from '@shared-test/rallar-bb-test/types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from './client-defaults.ts';
import type { RallarBlackBoxProviderMode } from './client-defaults.ts';

export type ManualWorkbenchTransport = Extract<
    RallarBlackBoxTestTransport,
    'realtime' | 'messages.rtc' | 'ws'
>;

export type ManualDeliveryMode = 'direct' | 'multicast' | 'broadcast';

export type ManualWorkbenchAction =
    | 'configure'
    | 'join'
    | 'connect'
    | 'send'
    | 'health'
    | 'close'
    | 'reset';

export type ManualWorkbenchValues = Readonly<{
    environment: string;
    apiBaseUrl: string;
    applicationId: string;
    workspaceId: string;
    actor: string;
    sessionId: string;
    groupId: string;
    scopeText: string;
    roomRefText: string;
    minSnapshotVersion: number;
    connection: string;
    targetClient: string;
    multicastClients: string;
    transport: ManualWorkbenchTransport;
    deliveryMode: ManualDeliveryMode;
    wsUrl: string;
    topic: string;
    typeId: string;
    topicId: string;
    timeoutMs: number;
    providerMode: RallarBlackBoxProviderMode;
    rallarUsername?: string;
    rallarPassword?: string;
    rallarRegister: boolean;
    rallarRestoreSession: boolean;
    rallarLogoutOnClose: boolean;
    rallarLeaveRoomOnClose: boolean;
}>;

export type ManualPayloadPreset = Readonly<{
    presetId: string;
    label: string;
    payload: unknown;
}>;

export type ManualActionHistoryEntry = Readonly<{
    actionId: string;
    label: string;
    commandIds: readonly string[];
    commands: readonly RallarBlackBoxTestCommand[];
    atEpochMs: number;
}>;

export type ManualReceivedMessage = Readonly<{
    eventId: string;
    connection: string;
    transport: string;
    sender: string;
    topic: string;
    atEpochMs: number;
    payload: unknown;
    commandId?: string;
}>;

export type JsonParseResult =
    | Readonly<{ ok: true; value: unknown }>
    | Readonly<{ ok: false; error: string }>;

export const MANUAL_PAYLOAD_PRESETS: readonly ManualPayloadPreset[] = [
    {
        presetId: 'ping',
        label: 'Ping',
        payload: {
            topic: 'manual.ping',
            kind: 'ping',
            seq: 1,
        },
    },
    {
        presetId: 'parity-probe',
        label: 'Parity Probe',
        payload: {
            topic: 'manual.parity',
            probeId: 'manual-parity-1',
            sentAt: 'manual-clock',
        },
    },
    {
        presetId: 'membership-probe',
        label: 'Membership Probe',
        payload: {
            topic: 'manual.membership',
            expectedClients: [],
        },
    },
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
    rallarLeaveRoomOnClose: true,
};

function clean(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function cleanList(value: string): readonly string[] {
    return value
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0);
}

function timeoutMs(value: ManualWorkbenchValues): number | undefined {
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
    } catch {
        return undefined;
    }
}

function minSnapshotVersionFrom(value: ManualWorkbenchValues): number | undefined {
    return Number.isFinite(value.minSnapshotVersion) && value.minSnapshotVersion > 0
        ? Math.round(value.minSnapshotVersion)
        : undefined;
}

function defaultRoomRef(values: ManualWorkbenchValues): Readonly<Record<string, unknown>> | undefined {
    const groupId = clean(values.groupId);
    return groupId ? { groupId } : undefined;
}

function scopedRtcFields(
    values: ManualWorkbenchValues,
): Readonly<{
    applicationId?: string;
    workspaceId?: string;
    scope?: Readonly<Record<string, unknown>>;
    roomRef?: Readonly<Record<string, unknown>>;
    minSnapshotVersion?: number;
}> {
    return {
        ...(clean(values.applicationId) ? { applicationId: clean(values.applicationId) } : {}),
        ...(clean(values.workspaceId) ? { workspaceId: clean(values.workspaceId) } : {}),
        ...(parseOptionalRecord(values.scopeText)
            ? { scope: parseOptionalRecord(values.scopeText) }
            : {}),
        ...(parseOptionalRecord(values.roomRefText) ?? defaultRoomRef(values)
            ? { roomRef: parseOptionalRecord(values.roomRefText) ?? defaultRoomRef(values) }
            : {}),
        ...(minSnapshotVersionFrom(values) !== undefined
            ? { minSnapshotVersion: minSnapshotVersionFrom(values) }
            : {}),
    };
}

function rallarConfigFrom(
    values: ManualWorkbenchValues,
): Readonly<Record<string, unknown>> | undefined {
    if (values.providerMode !== 'browser-rallar') {
        return undefined;
    }

    const username = clean(values.rallarUsername ?? '');
    const password = clean(values.rallarPassword ?? '');
    const rallar: Record<string, unknown> = {
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        ...(values.rallarRegister ? { register: true } : {}),
        ...(values.rallarRestoreSession ? { restoreSession: true } : {}),
        ...(values.rallarLogoutOnClose ? { logoutOnClose: true } : {}),
        leaveRoomOnClose: values.rallarLeaveRoomOnClose,
        ...scopedRtcFields(values),
    };

    return Object.keys(rallar).length > 0 ? rallar : undefined;
}

function redactionFrom(
    values: ManualWorkbenchValues,
): RallarBlackBoxTestConfig['redaction'] | undefined {
    const secretValues = [
        values.rallarPassword,
    ].filter((value): value is string => Boolean(value && value.length > 0));

    return secretValues.length > 0 ? { secretValues } : undefined;
}

function commandId(action: string, sequence: number): string {
    return `manual-${action}-${sequence}`;
}

function asRtcSendCommand(
    command: RallarBlackBoxTestCommand,
): Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send' }> {
    if (command.kind !== 'rtc.send') {
        throw new Error(`Expected rtc.send command, got ${command.kind}.`);
    }

    return command;
}

function pathSegment(value: string): string {
    return encodeURIComponent(value);
}

function targetsFor(values: ManualWorkbenchValues): readonly string[] {
    if (values.deliveryMode === 'broadcast') {
        return [];
    }

    if (values.deliveryMode === 'direct') {
        const target = clean(values.targetClient);
        return target ? [target] : [];
    }

    return cleanList(values.multicastClients);
}

function withPayloadEnvelope(
    values: ManualWorkbenchValues,
    payload: unknown,
): Record<string, unknown> {
    const targets = targetsFor(values);
    return {
        groupId: clean(values.groupId),
        topic: clean(values.topic),
        deliveryMode: values.deliveryMode,
        targets,
        payload,
    };
}

export function parseManualPayload(text: string): JsonParseResult {
    try {
        return {
            ok: true,
            value: JSON.parse(text) as unknown,
        };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function manualConfigureCommand(
    values: ManualWorkbenchValues,
    sequence: number,
): RallarBlackBoxTestCommand {
    const rallar = rallarConfigFrom(values);
    const redaction = redactionFrom(values);
    const config: RallarBlackBoxTestConfig = {
        runId: `manual-workbench-${sequence}`,
        agentId: 'visible-agent-local',
        environment: clean(values.environment),
        apiBaseUrl: clean(values.apiBaseUrl),
        actor: clean(values.actor),
        sessionId: clean(values.sessionId),
        roomId: clean(values.groupId),
        transport: values.transport === 'ws' ? 'ws' : values.transport,
        control: {
            mode: 'manual-workbench',
            providerMode: values.providerMode,
            protocolVersion: 1,
            connected: false,
        },
        defaults: {
            timeoutMs: timeoutMs(values),
            connection: clean(values.connection),
            providerMode: values.providerMode,
            ...scopedRtcFields(values),
        },
        ...(rallar ? { rallar } : {}),
        ...(redaction ? { redaction } : {}),
    };

    return {
        kind: 'configure',
        commandId: commandId('configure', sequence),
        label: 'Configure manual group',
        config,
    };
}

export function manualConnectCommand(
    values: ManualWorkbenchValues,
    sequence: number,
): RallarBlackBoxTestCommand {
    if (values.transport === 'ws') {
        return {
            kind: 'ws.open',
            commandId: commandId('ws-open', sequence),
            label: 'Open manual WebSocket',
            connection: clean(values.connection),
            url: clean(values.wsUrl),
            timeoutMs: timeoutMs(values),
            metadata: {
                manual: {
                    groupId: clean(values.groupId),
                    actor: clean(values.actor),
                },
            },
        };
    }

    return {
        kind: 'rtc.connect',
        commandId: commandId('rtc-connect', sequence),
        label: 'Connect manual RTC client',
        connection: clean(values.connection),
        actor: clean(values.actor),
        roomId: clean(values.groupId),
        ...scopedRtcFields(values),
        transport: values.transport,
        timeoutMs: timeoutMs(values),
        rallar: {
            sessionId: clean(values.sessionId),
        },
        metadata: {
            manual: {
                deliveryMode: values.deliveryMode,
                expectedClients: targetsFor(values),
            },
        },
    };
}

export function manualCreateGroupCommand(
    values: ManualWorkbenchValues,
    sequence: number,
): RallarBlackBoxTestCommand {
    const groupId = clean(values.groupId) ?? RALLAR_BLACK_BOX_CLIENT_DEFAULTS.roomId;
    const applicationId = clean(values.applicationId) ?? DEFAULT_STATE_APPLICATION_ID;
    const workspaceId = clean(values.workspaceId) ?? DEFAULT_STATE_WORKSPACE_ID;
    return {
        kind: 'http.request',
        commandId: commandId('group-create', sequence),
        label: 'Create manual Rallar group',
        request: {
            method: 'POST',
            path: `/api/state/apps/${pathSegment(applicationId)}/workspaces/${pathSegment(workspaceId)}/groups`,
            body: {
                groupId,
                displayName: groupId,
                description: 'Created by rallar-black-box Manual Rallar',
                kind: 'room',
                joinMode: 'open',
                metadata: {
                    source: 'rallar-black-box',
                    surface: 'manual-rallar',
                    ...scopedRtcFields(values),
                },
            },
        },
        response: {
            body: 'json',
        },
        metadata: {
            manual: {
                groupId,
                action: 'create-group',
                applicationId,
                workspaceId,
            },
        },
    };
}

export function manualSendCommand(
    values: ManualWorkbenchValues,
    payload: unknown,
    sequence: number,
): RallarBlackBoxTestCommand {
    const targets = targetsFor(values);
    const manual = {
        groupId: clean(values.groupId),
        topic: clean(values.topic),
        deliveryMode: values.deliveryMode,
        targets,
        ...scopedRtcFields(values),
    };

    if (values.transport === 'ws') {
        return {
            kind: 'ws.send',
            commandId: commandId(`ws-send-${values.deliveryMode}`, sequence),
            label: `WS ${values.deliveryMode}`,
            connection: clean(values.connection),
            data: withPayloadEnvelope(values, payload),
            timeoutMs: timeoutMs(values),
            metadata: {
                manual,
            },
        };
    }

    const basePayload: Record<string, unknown> = values.transport === 'messages.rtc'
        ? {
            payload,
            roomId: clean(values.groupId),
            typeId: clean(values.typeId),
            topicId: clean(values.topicId) ?? clean(values.topic),
        }
        : {
            data: payload,
            roomId: clean(values.groupId),
        };

    if (values.deliveryMode !== 'broadcast' && targets.length > 0) {
        if (values.transport === 'messages.rtc') {
            basePayload.nextHopPeerIds = targets;
        } else {
            basePayload.peerIds = targets;
        }
    }

    return {
        kind: 'rtc.send',
        commandId: commandId(`rtc-send-${values.deliveryMode}`, sequence),
        label: `RTC ${values.deliveryMode}`,
        connection: clean(values.connection),
        transport: values.transport,
        ...scopedRtcFields(values),
        send: basePayload,
        timeoutMs: timeoutMs(values),
        metadata: {
            manual,
        },
    };
}

export function manualRtcDeliveryMatrixCommands(
    values: ManualWorkbenchValues,
    payload: unknown,
    sequence: number,
    transport: Extract<ManualWorkbenchTransport, 'realtime' | 'messages.rtc'>,
): readonly RallarBlackBoxTestCommand[] {
    const baseValues: ManualWorkbenchValues = {
        ...values,
        transport,
        deliveryMode: 'direct',
    };
    const commands: RallarBlackBoxTestCommand[] = [manualConfigureCommand(baseValues, sequence)];
    let nextSequence = sequence + 1;

    if (baseValues.providerMode === 'browser-rallar') {
        commands.push(manualCreateGroupCommand(baseValues, nextSequence));
        nextSequence += 1;
    }

    commands.push(manualConnectCommand(baseValues, nextSequence));
    nextSequence += 1;

    for (const deliveryMode of ['direct', 'multicast', 'broadcast'] as const) {
        commands.push(manualSendCommand({
            ...baseValues,
            deliveryMode,
        }, payload, nextSequence));
        nextSequence += 1;
    }

    return commands;
}

export function manualRtcNackProbeCommands(
    values: ManualWorkbenchValues,
    payload: unknown,
    sequence: number,
): readonly RallarBlackBoxTestCommand[] {
    const transport = values.transport === 'messages.rtc' ? 'messages.rtc' : 'realtime';
    const scopedValues: ManualWorkbenchValues = {
        ...values,
        transport,
        deliveryMode: 'direct',
        minSnapshotVersion: Math.max(values.minSnapshotVersion, 9_999_999),
    };
    const send = asRtcSendCommand(manualSendCommand(scopedValues, payload, sequence));
    return [{
        ...send,
        commandId: commandId('rtc-nack-not-yet-in-sync', sequence),
        label: 'RTC not-yet-in-sync probe',
        metadata: {
            ...send.metadata,
            negativeCase: 'not-yet-in-sync',
            expectedOutcome: 'nack',
        },
        expect: {
            outcome: 'nack',
            code: 'not-yet-in-sync',
        },
    }];
}

export function manualRtcNegativeRecipeSnippet(
    values: ManualWorkbenchValues,
    payload: unknown,
): string {
    const transport = values.transport === 'messages.rtc' ? 'messages.rtc' : 'realtime';
    const baseValues: ManualWorkbenchValues = {
        ...values,
        transport,
        deliveryMode: 'direct',
    };
    const commands: RallarBlackBoxTestCommand[] = [
        manualConfigureCommand(baseValues, 1),
        manualConnectCommand(baseValues, 2),
        {
            ...asRtcSendCommand(manualSendCommand({
                ...baseValues,
                targetClient: 'missing-peer',
            }, payload, 3)),
            commandId: 'manual-rtc-negative-missing-peer',
            label: 'RTC missing peer negative',
            metadata: {
                negativeCase: 'missing-peer',
                expectedOutcome: 'delivery-failure',
            },
            expect: {
                status: 'failed',
                code: 'missing-peer',
            },
        },
        {
            ...asRtcSendCommand(manualSendCommand({
                ...baseValues,
                targetClient: 'stale-agent',
            }, payload, 4)),
            commandId: 'manual-rtc-negative-stale-agent',
            label: 'RTC stale agent negative',
            metadata: {
                negativeCase: 'stale-agent',
                expectedOutcome: 'delivery-failure',
            },
            expect: {
                status: 'failed',
                code: 'stale-agent',
            },
        },
        {
            ...manualConnectCommand(baseValues, 5),
            commandId: 'manual-rtc-negative-duplicate-session',
            label: 'RTC duplicate session negative',
            metadata: {
                negativeCase: 'duplicate-session',
                expectedOutcome: 'permission-failure',
            },
        },
        {
            ...asRtcSendCommand(manualSendCommand(baseValues, payload, 6)),
            commandId: 'manual-rtc-negative-permission-denied',
            label: 'RTC permission denied negative',
            metadata: {
                negativeCase: 'permission-denied',
                expectedOutcome: 'permission-failure',
            },
            expect: {
                status: 'failed',
                code: 'permission-denied',
            },
        },
        manualSimpleCommand('close', 7),
        {
            ...asRtcSendCommand(manualSendCommand(baseValues, payload, 8)),
            commandId: 'manual-rtc-negative-closed-transport',
            label: 'RTC closed transport negative',
            metadata: {
                negativeCase: 'closed-transport',
                expectedOutcome: 'transport-failure',
            },
            expect: {
                status: 'failed',
                code: 'closed-transport',
            },
        },
        ...manualRtcNackProbeCommands(baseValues, payload, 9),
    ];

    return JSON.stringify({
        recipeId: 'manual-rtc-negative-recipe',
        name: 'Manual RTC negative recipe',
        description: 'Missing peer, stale agent, duplicate session, permission denied, closed transport, and not-yet-in-sync/NACK probes.',
        continueOnFailure: true,
        commands,
    }, null, 2);
}

export function manualSimpleCommand(
    action: Extract<ManualWorkbenchAction, 'health' | 'close' | 'reset'>,
    sequence: number,
): RallarBlackBoxTestCommand {
    return {
        kind: action,
        commandId: commandId(action, sequence),
        label: `Manual ${action}`,
    };
}

export function buildManualWorkbenchCommands(
    action: ManualWorkbenchAction,
    values: ManualWorkbenchValues,
    payload: unknown,
    sequence: number,
): readonly RallarBlackBoxTestCommand[] {
    switch (action) {
        case 'configure':
            return [manualConfigureCommand(values, sequence)];
        case 'join':
            if (values.providerMode === 'browser-rallar' && values.transport !== 'ws') {
                return [
                    manualConfigureCommand(values, sequence),
                    manualCreateGroupCommand(values, sequence + 1),
                    manualConnectCommand(values, sequence + 2),
                ];
            }
            return [
                manualConfigureCommand(values, sequence),
                manualConnectCommand(values, sequence + 1),
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
    entries: readonly ManualActionHistoryEntry[],
): string {
    const commands = entries.flatMap(entry => entry.commands);
    return JSON.stringify({
        recipeId: 'manual-workbench-recipe',
        name: 'Manual workbench recipe',
        continueOnFailure: false,
        commands,
    }, null, 2);
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function firstString(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }

    return undefined;
}

export function deriveManualReceivedMessages(
    events: readonly RallarBlackBoxTestEvent[],
): readonly ManualReceivedMessage[] {
    return events
        .filter(event => event.kind === 'message')
        .map(event => {
            const payload = asRecord(event.payload);
            const data = asRecord(payload.data);
            const nestedData = asRecord(data.data);
            const envelope = asRecord(data.payload);
            return {
                eventId: event.eventId,
                connection: event.connection ?? 'default',
                transport: event.transport ?? 'runtime',
                sender: firstString(
                    payload.senderId,
                    payload.remotePeerId,
                    data.senderId,
                    data.sender,
                    nestedData.senderId,
                    nestedData.sender,
                    event.actor,
                ) ?? '-',
                topic: firstString(
                    payload.topicId,
                    payload.topic,
                    data.topic,
                    nestedData.topic,
                    envelope.topic,
                    event.topic,
                ) ?? event.topic,
                atEpochMs: typeof payload.receivedAtEpochMs === 'number'
                    ? payload.receivedAtEpochMs
                    : event.atEpochMs,
                payload: payload.data ?? event.payload,
                commandId: event.commandId,
            };
        });
}
