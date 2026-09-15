import type {
    RallarBlackBoxCompositeConformanceCaseId,
    RallarBlackBoxCompositeConformanceRecipeOptions
} from '../composite-conformance.ts';
import type {
    RallarBlackBoxTestConfigureCommand,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRtcConnectCommand,
    RallarBlackBoxTestRtcSendCommand,
    RallarBlackBoxTestSimpleCommand,
    RallarBlackBoxTestTransport,
    RallarBlackBoxTestWaitCommand
} from '../rallar-black-box-test-contracts.ts';
import {
    DEFAULT_CONNECTION,
    DEFAULT_ROOM_ID,
    toCommandMetadata,
    toScopeFields,
    toTimeoutMs
} from './composite-conformance-recipe-values.ts';

export function toConfigureCommand(
    caseId: RallarBlackBoxCompositeConformanceCaseId,
    options: RallarBlackBoxCompositeConformanceRecipeOptions
): RallarBlackBoxTestConfigureCommand {
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
): RallarBlackBoxTestRtcConnectCommand {
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
): RallarBlackBoxTestSimpleCommand {
    return {
        kind: 'stats',
        commandId,
        metadata: toCommandMetadata(caseId, commandId)
    };
}

export function toCloseCommand(
    commandId: string,
    caseId: RallarBlackBoxCompositeConformanceCaseId
): RallarBlackBoxTestSimpleCommand {
    return {
        kind: 'close',
        commandId,
        metadata: toCommandMetadata(caseId, commandId)
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

export interface ConformanceRtcConnectInput {
    readonly caseId: RallarBlackBoxCompositeConformanceCaseId;
    readonly commandId: string;
    readonly connection: string;
    readonly roomId: string;
    readonly transport: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly options: RallarBlackBoxCompositeConformanceRecipeOptions;
}

export interface ConformanceMessageProbeInput extends ConformanceRtcConnectInput {
    readonly data: RallarBlackBoxTestRecord;
}

export function toConformanceMessageProbe(
    input: ConformanceMessageProbeInput
): RallarBlackBoxTestRtcSendCommand {
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
): RallarBlackBoxTestWaitCommand {
    return {
        kind: 'wait',
        commandId: input.commandId,
        ...(input.absent === undefined ? {} : { absent: input.absent }),
        timeoutMs: input.timeoutMs,
        match: { kind: 'message', topic: 'rallar.conformance.message', payloadPath: 'data.topic', equals: input.topic },
        metadata: toCommandMetadata(input.caseId, input.commandId)
    };
}

export interface ConformanceProbeCommandsInput {
    readonly caseId: RallarBlackBoxCompositeConformanceCaseId;
    readonly commandPrefix: string;
    readonly options: RallarBlackBoxCompositeConformanceRecipeOptions;
    readonly data: RallarBlackBoxTestRecord;
}

/** Connects the conformance agent and sends one probe message it can then wait or assert on. */
export function toConformanceProbeCommands(
    input: ConformanceProbeCommandsInput
): readonly [RallarBlackBoxTestRtcConnectCommand, RallarBlackBoxTestRtcSendCommand] {
    const { caseId, commandPrefix, options } = input;
    const address = {
        caseId,
        connection: options.connection ?? DEFAULT_CONNECTION,
        roomId: options.roomId ?? DEFAULT_ROOM_ID,
        transport: options.transport ?? 'realtime',
        options
    };
    return [
        toRtcConnectCommand({ ...address, commandId: `${commandPrefix}-connect` }),
        toConformanceMessageProbe({ ...address, commandId: `${commandPrefix}-send`, data: input.data })
    ];
}
