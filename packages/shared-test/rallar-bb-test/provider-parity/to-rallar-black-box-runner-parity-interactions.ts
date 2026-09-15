import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRtcSendCommand
} from '../rallar-black-box-test-contracts.ts';
import type {
    RallarBlackBoxParityCommandMetadata,
    RallarBlackBoxParityOperation,
    RallarBlackBoxRunnerParityConversion,
    RallarBlackBoxRunnerParityOmittedCommand,
    RallarBlackBoxRunnerParityOptions,
    RallarBlackBoxRunnerProviderName
} from './provider-parity-contracts.ts';
import {
    DEFAULT_PARITY_CONNECTION,
    toOperationFromCommand,
    toParityFromCommand,
    toParityMetadata
} from './to-parity-command-metadata.ts';

function toConfigCommands(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestConfig[] {
    return recipe.commands
        .filter((command): command is Extract<RallarBlackBoxTestCommand, { kind: 'configure'; }> =>
            command.kind === 'configure'
        )
        .map((command) => command.config);
}

function toFirstConfig(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestConfig {
    return toConfigCommands(recipe)[0] ?? {};
}

function toCommandId(command: RallarBlackBoxTestCommand, fallback: string): string {
    return command.commandId ?? fallback;
}

function toDefaultConnection(config: RallarBlackBoxTestConfig): string {
    const configured = config.defaults?.connection;
    return typeof configured === 'string' && configured.length > 0
        ? configured
        : DEFAULT_PARITY_CONNECTION;
}

function toOperationName(operation: RallarBlackBoxParityOperation): string {
    return operation
        .split('.')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function toRunnerName(operation: RallarBlackBoxParityOperation, commandIdValue: string): string {
    const compactId = commandIdValue
        .replace(/^parity-/, '')
        .replace(/[^a-zA-Z0-9]+(.)/g, (_match, next: string) => next.toUpperCase());
    return `parity${toOperationName(operation)}${compactId ? `_${compactId}` : ''}`;
}

interface RunnerInteractionInput {
    readonly name: string;
    readonly request: RallarBlackBoxTestRecord;
    readonly response: RallarBlackBoxTestRecord;
    readonly parity: RallarBlackBoxParityCommandMetadata;
}
function toRunnerInteraction(input: RunnerInteractionInput): RallarBlackBoxTestRecord {
    const { name, request, response, parity } = input;
    return {
        RTC: {
            request: {
                ...request,
                parity
            },
            response
        },
        [name]: {
            parity
        }
    };
}

interface RunnerRequestBaseInput {
    readonly provider: RallarBlackBoxRunnerProviderName;
    readonly command: RallarBlackBoxTestCommand;
    readonly config: RallarBlackBoxTestConfig;
    readonly interactionExecutionNumber: number;
    readonly scenarioExecutionNumber: number;
}
function toRunnerRequestBase(input: RunnerRequestBaseInput): RallarBlackBoxTestRecord {
    const { provider, command, config, interactionExecutionNumber, scenarioExecutionNumber } = input;
    return {
        provider,
        commandId: toCommandId(command, `parity-${interactionExecutionNumber}`),
        connection: resolveCommandText(command, 'connection') ?? toDefaultConnection(config),
        actor: resolveCommandText(command, 'actor') ?? config.actor,
        roomId: resolveCommandText(command, 'roomId') ?? config.roomId,
        transport: 'transport' in command && command.transport ? command.transport : config.transport,
        timeoutMs: typeof command.timeoutMs === 'number' ? command.timeoutMs : config.defaults?.timeoutMs,
        scenarioExecutionNumber,
        interactionExecutionNumber
    };
}

function resolveCommandText(
    command: RallarBlackBoxTestCommand,
    key: 'connection' | 'actor' | 'roomId'
): string | undefined {
    const value = key in command ? Reflect.get(command, key) : undefined;
    return typeof value === 'string' ? value : undefined;
}

function toExpectedConnections(command: RallarBlackBoxTestCommand): readonly string[] {
    return toParityFromCommand(command)?.expectedConnections ?? [];
}

function usesEventShapedRtcMessages(
    provider: RallarBlackBoxRunnerProviderName,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape']
): boolean {
    return messageShape === undefined ? provider === 'rallar-remote-browser' : messageShape === 'event';
}

function toExpectedRtcMessage(
    provider: RallarBlackBoxRunnerProviderName,
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }>,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape']
): RallarBlackBoxTestRtcSendCommand['send'] {
    const expected = command.expect ?? command.send;
    return usesEventShapedRtcMessages(provider, messageShape)
        ? { data: expected }
        : expected;
}

function toSendResponse(
    provider: RallarBlackBoxRunnerProviderName,
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }>,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape']
): RallarBlackBoxTestRecord {
    const expectedConnections = toExpectedConnections(command);
    if (expectedConnections.length !== 1) {
        return {};
    }

    return {
        connection: expectedConnections[0],
        withinMs: command.timeoutMs,
        message: toExpectedRtcMessage(provider, command, messageShape)
    };
}

interface WaitInteractionsInput {
    readonly provider: RallarBlackBoxRunnerProviderName;
    readonly command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }>;
    readonly config: RallarBlackBoxTestConfig;
    readonly scenarioExecutionNumber: number;
    readonly nextInteractionNumber: number;
    readonly messageShape?: RallarBlackBoxRunnerParityOptions['messageShape'];
}
function toWaitInteractions(input: WaitInteractionsInput): readonly RallarBlackBoxTestRecord[] {
    const parity = toParityFromCommand(input.command);
    const expectedConnections = parity?.expectedConnections ?? [];
    if (!parity || expectedConnections.length <= 1) {
        return [];
    }
    return expectedConnections.map((connection, index) => toWaitInteraction(input, { parity, connection, index }));
}

function toWaitInteraction(input: WaitInteractionsInput, target: WaitInteractionTarget): RallarBlackBoxTestRecord {
    const { provider, command, config, scenarioExecutionNumber, messageShape } = input;
    const { parity, connection, index } = target;
    const operation = toReceiveOperation(parity.deliveryMode);
    const waitCommandId = `${toCommandId(command, 'send')}-wait-${index + 1}`;
    return toRunnerInteraction({
        name: toRunnerName(operation, waitCommandId),
        request: {
            provider,
            action: 'wait',
            commandId: waitCommandId,
            connection,
            actor: config.actor,
            roomId: config.roomId,
            transport: command.transport ?? config.transport,
            timeoutMs: command.timeoutMs,
            scenarioExecutionNumber,
            interactionExecutionNumber: input.nextInteractionNumber + index
        },
        response: {
            connection,
            withinMs: command.timeoutMs,
            message: toExpectedRtcMessage(provider, command, messageShape)
        },
        parity: toParityMetadata(operation, {
            deliveryMode: parity.deliveryMode,
            expectedConnections: [connection],
            targetPeerIds: parity.targetPeerIds,
            runnerAction: 'wait'
        })
    });
}

function toReceiveOperation(
    deliveryMode: RallarBlackBoxParityCommandMetadata['deliveryMode']
): Extract<RallarBlackBoxParityOperation, `receive.${string}`> {
    switch (deliveryMode) {
        case 'broadcast':
            return 'receive.broadcast';
        case 'multicast':
            return 'receive.multicast';
        default:
            return 'receive.direct';
    }
}

interface WaitInteractionTarget {
    readonly parity: RallarBlackBoxParityCommandMetadata;
    readonly connection: string;
    readonly index: number;
}

export function toRallarBlackBoxRunnerParityInteractions(
    recipe: RallarBlackBoxTestRecipe,
    options: RallarBlackBoxRunnerParityOptions = {}
): RallarBlackBoxRunnerParityConversion {
    const provider = options.provider ?? 'rallar-remote-browser';
    const scenarioExecutionNumber = options.scenarioExecutionNumber ?? 1;
    const config = toFirstConfig(recipe);
    const interactions: RallarBlackBoxTestRecord[] = [];
    const omittedCommands: RallarBlackBoxRunnerParityOmittedCommand[] = [];
    for (const [commandIndex, command] of recipe.commands.entries()) {
        const operation = toParityFromCommand(command)?.operation ?? toOperationFromCommand(command);
        if (command.kind === 'configure' || command.kind === 'health' || command.kind === 'reset') {
            omittedCommands.push({
                commandId: toCommandId(command, `${command.kind}-${commandIndex + 1}`),
                kind: command.kind,
                operation,
                reason: OMITTED_COMMAND_REASONS[command.kind]
            });
        }
        else if (command.kind === 'rtc.connect' || command.kind === 'rtc.send' || command.kind === 'close') {
            interactions.push(
                ...toRunnerCommandInteractions({
                    provider,
                    command,
                    config,
                    interactionExecutionNumber: interactions.length + 1,
                    scenarioExecutionNumber,
                    options
                })
            );
        }
    }
    return { interactions, omittedCommands };
}
const OMITTED_COMMAND_REASONS: Readonly<Record<'configure' | 'health' | 'reset', string>> = {
    configure: 'runner RTC providers receive resolved config on each RTC request',
    health: 'runner RTC provider vocabulary has no first-class command for this SPA operation',
    reset: 'runner RTC provider vocabulary has no first-class command for this SPA operation'
};

interface RunnerCommandInteractionsInput extends RunnerRequestBaseInput {
    readonly command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' | 'rtc.send' | 'close'; }>;
    readonly options: RallarBlackBoxRunnerParityOptions;
}
function toRunnerCommandInteractions(input: RunnerCommandInteractionsInput): readonly RallarBlackBoxTestRecord[] {
    const { command, provider, config, options, scenarioExecutionNumber, interactionExecutionNumber } = input;
    const request = toRunnerRequestBase(input);
    const parity = toParityFromCommand(command);
    const operation = parity?.operation ?? toOperationFromCommand(command);
    const action = command.kind === 'rtc.connect' ? 'connect' : command.kind === 'rtc.send' ? 'send' : 'close';
    const first = toRunnerInteraction({
        name: toRunnerName(operation, toCommandId(command, action)),
        request: toRunnerRequest(command, request, config),
        response: command.kind === 'rtc.send' ? toSendResponse(provider, command, options.messageShape) : {},
        parity: parity ??
            toParityMetadata(action === 'send' ? 'send.direct' : action, {
                ...(action === 'send' ? {} : { expectedConnections: [String(request.connection)] }),
                runnerAction: action
            })
    });
    if (command.kind !== 'rtc.send' || options.includeReceiveWaits === false) {
        return [first];
    }
    return [
        first,
        ...toWaitInteractions({
            provider,
            command,
            config,
            scenarioExecutionNumber,
            nextInteractionNumber: interactionExecutionNumber + 1,
            messageShape: options.messageShape
        })
    ];
}
function toRunnerRequest(
    command: RunnerCommandInteractionsInput['command'],
    request: RallarBlackBoxTestRecord,
    config: RallarBlackBoxTestConfig
): RallarBlackBoxTestRecord {
    if (command.kind === 'rtc.connect') {
        return {
            ...request,
            action: 'connect',
            rallar: {
                ...(config.rallar ?? {}),
                ...(command.rallar ?? {}),
                ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {})
            }
        };
    }
    if (command.kind === 'rtc.send') {
        return { ...request, action: 'send', send: command.send };
    }
    return { ...request, action: 'close' };
}
