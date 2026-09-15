import type { RallarBlackBoxTestCommand, RallarBlackBoxTestTransport } from '../rallar-black-box-test-contracts.ts';

import type {
    RallarBlackBoxCompositeConformanceCaseId,
    RallarBlackBoxCompositeConformanceRecipeOptions
} from '../composite-conformance.ts';

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_CONNECTION = 'conformanceRtc';
export const DEFAULT_WS_CONNECTION = 'conformanceWs';
export const DEFAULT_ROOM_ID = 'rallar-conformance-room';

export function toConfigureCommand(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): Extract<RallarBlackBoxTestCommand, { kind: 'configure'; }> {
    return {
        kind: 'configure',
        commandId: `${caseId}-configure`,
        config: {
            runId: options.runId ?? 'rallar-composite-conformance-run',
            agentId: options.agentId ?? 'local-conformance-agent',
            environment: options.environment ?? 'local',
            apiBaseUrl: options.apiBaseUrl ?? 'http://localhost:8080',
            actor: options.actor ?? 'alice',
            sessionId: options.sessionId ?? 'alice-session',
            roomId: options.roomId ?? DEFAULT_ROOM_ID,
            transport: options.transport ?? 'realtime',
            rallar: {
                apiBaseUrl: options.apiBaseUrl ?? 'http://localhost:8080',
                wsBaseUrl: toWsBaseUrl(options.apiBaseUrl ?? 'http://localhost:8080'),
                applicationId: options.applicationId ?? 'rallar-server',
                workspaceId: options.workspaceId ?? 'default',
                roomId: options.roomId ?? DEFAULT_ROOM_ID
            },
            control: {
                providerMode: options.providerMode ?? 'simulated',
                conformance: true
            },
            defaults: {
                timeoutMs: toTimeoutMs(options),
                connection: options.connection ?? DEFAULT_CONNECTION
            },
            redaction: {
                keys: ['password', 'accessToken', 'token']
            }
        },
        metadata: toCommandMetadata(caseId, `${caseId}-configure`)
    };
}

export function toRtcConnectCommand(
    input: ConformanceRtcConnectInput
): Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect'; }> {
    const { caseId, commandId, connection, roomId, transport, options } = input;
    return {
        kind: 'rtc.connect',
        commandId,
        connection,
        actor: options.actor ?? 'alice',
        roomId,
        transport,
        timeoutMs: toTimeoutMs(options),
        ...toScopeFields(options),
        rallar: {
            sessionId: options.sessionId ?? 'alice-session',
            transport
        },
        metadata: toCommandMetadata(caseId, commandId)
    };
}

export function toStatsCommand(
    commandId: string,
    caseId: RallarBlackBoxCompositeConformanceCaseId
): Extract<RallarBlackBoxTestCommand, { kind: 'stats'; }> {
    return {
        kind: 'stats',
        commandId,
        metadata: toCommandMetadata(caseId, commandId)
    };
}

export function toCloseCommand(
    commandId: string,
    caseId: RallarBlackBoxCompositeConformanceCaseId
): Extract<RallarBlackBoxTestCommand, { kind: 'close'; }> {
    return {
        kind: 'close',
        commandId,
        metadata: toCommandMetadata(caseId, commandId)
    };
}

export function toRecipeId(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): string {
    return [options.recipeIdPrefix ?? 'composite-conformance', caseId].join('-');
}

export function toTimeoutMs(options: RallarBlackBoxCompositeConformanceRecipeOptions): number {
    return Number.isFinite(options.timeoutMs) && options.timeoutMs !== undefined &&
            options.timeoutMs > 0
        ? Math.round(options.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
}

export function toScopeFields(
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): Record<string, unknown> {
    return {
        applicationId: options.applicationId ?? 'rallar-server',
        workspaceId: options.workspaceId ?? 'default',
        roomRef: {
            applicationId: options.applicationId ?? 'rallar-server',
            workspaceId: options.workspaceId ?? 'default',
            groupId: options.roomId ?? DEFAULT_ROOM_ID
        }
    };
}

function toWsBaseUrl(apiBaseUrl: string): string {
    try {
        const url = new URL(apiBaseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.toString().replace(/\/+$/, '');
    }
    catch {
        return 'ws://localhost:8080';
    }
}

export function toRecipeMetadata(
    caseId: RallarBlackBoxCompositeConformanceCaseId
): Record<string, unknown> {
    return {
        conformance: {
            schemaVersion: 1,
            caseId
        }
    };
}

export function toCommandMetadata(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    commandId: string
): Record<string, unknown> {
    return {
        conformance: {
            schemaVersion: 1,
            caseId,
            commandId
        }
    };
}

export interface ConformanceRtcConnectInput {
    readonly caseId: RallarBlackBoxCompositeConformanceCaseId;
    readonly commandId: string;
    readonly connection: string;
    readonly roomId: string;
    readonly transport: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly options: RallarBlackBoxCompositeConformanceRecipeOptions;
}

export interface ConformanceMessageProbeInput extends ConformanceRtcConnectInput {
    readonly data: Readonly<Record<string, unknown>>;
}

export function toConformanceMessageProbe(
    input: ConformanceMessageProbeInput
): Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }> {
    return {
        kind: 'rtc.send',
        commandId: input.commandId,
        connection: input.connection,
        transport: input.transport,
        timeoutMs: toTimeoutMs(input.options),
        send: { data: input.data, roomId: input.roomId, ...toScopeFields(input.options) },
        metadata: toCommandMetadata(input.caseId, input.commandId)
    };
}

export interface ConformanceMessageWaitInput {
    readonly caseId: RallarBlackBoxCompositeConformanceCaseId;
    readonly commandId: string;
    readonly timeoutMs: number;
    readonly topic: string;
    readonly absent?: true;
}

export function toConformanceMessageWait(
    input: ConformanceMessageWaitInput
): Extract<RallarBlackBoxTestCommand, { kind: 'wait'; }> {
    return {
        kind: 'wait',
        commandId: input.commandId,
        ...(input.absent === undefined ? {} : { absent: input.absent }),
        timeoutMs: input.timeoutMs,
        match: { kind: 'message', topic: 'rallar.conformance.message', payloadPath: 'data.topic', equals: input.topic },
        metadata: toCommandMetadata(input.caseId, input.commandId)
    };
}
