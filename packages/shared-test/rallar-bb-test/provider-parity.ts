import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestTransport,
} from './types.ts';

export type RallarBlackBoxParityOperation =
    | 'configure'
    | 'connect'
    | 'send.direct'
    | 'send.multicast'
    | 'send.broadcast'
    | 'receive.direct'
    | 'receive.multicast'
    | 'receive.broadcast'
    | 'health'
    | 'close'
    | 'reset';

export type RallarBlackBoxRunnerProviderName =
    | 'rallar-browser'
    | 'rallar-remote-browser';

export type RallarBlackBoxParityDeliveryMode =
    | 'direct'
    | 'multicast'
    | 'broadcast';

export type RallarBlackBoxParityCommandMetadata = Readonly<{
    operation: RallarBlackBoxParityOperation;
    deliveryMode?: RallarBlackBoxParityDeliveryMode;
    expectedConnections?: readonly string[];
    targetPeerIds?: readonly string[];
    runnerAction?: 'connect' | 'send' | 'wait' | 'close';
    providerSpecificFields?: readonly string[];
}>;

export type RallarBlackBoxProviderParityRecipeOptions = Readonly<{
    recipeId?: string;
    name?: string;
    description?: string;
    runId?: string;
    agentId?: string;
    environment?: string;
    apiBaseUrl?: string;
    actor?: string;
    sessionId?: string;
    roomId?: string;
    connection?: string;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    timeoutMs?: number;
    providerMode?: 'simulated' | 'browser-rallar';
    rallar?: Readonly<Record<string, unknown>>;
    browser?: Readonly<Record<string, unknown>>;
    control?: Readonly<Record<string, unknown>>;
    directPeerIds?: readonly string[];
    directExpectedConnections?: readonly string[];
    multicastPeerIds?: readonly string[];
    multicastExpectedConnections?: readonly string[];
    broadcastExpectedConnections?: readonly string[];
}>;

export type RallarBlackBoxRunnerParityOptions = Readonly<{
    provider?: RallarBlackBoxRunnerProviderName;
    scenarioExecutionNumber?: number;
    includeReceiveWaits?: boolean;
    messageShape?: 'raw' | 'event';
}>;

export type RallarBlackBoxRunnerParityOmittedCommand = Readonly<{
    commandId: string;
    kind: RallarBlackBoxTestCommand['kind'];
    operation: RallarBlackBoxParityOperation | string;
    reason: string;
}>;

export type RallarBlackBoxRunnerParityConversion = Readonly<{
    interactions: readonly Record<string, unknown>[];
    omittedCommands: readonly RallarBlackBoxRunnerParityOmittedCommand[];
}>;

export type RallarBlackBoxProviderParityStep = Readonly<{
    key: string;
    operation: RallarBlackBoxParityOperation | string;
    status: 'ok' | 'failed' | 'cancelled' | 'skipped';
    commandId?: string;
    kind?: string;
    action?: string;
    connection?: string;
    transport?: string;
    comparable: Readonly<Record<string, unknown>>;
    providerSpecific: Readonly<Record<string, unknown>>;
}>;

export type RallarBlackBoxProviderParityReport = Readonly<{
    source: 'rallar-bb-test' | 'black-box-runner';
    steps: readonly RallarBlackBoxProviderParityStep[];
    providerSpecificFields: readonly string[];
}>;

export type RallarBlackBoxProviderParityComparison = Readonly<{
    ok: boolean;
    matchedKeys: readonly string[];
    missingLeft: readonly string[];
    missingRight: readonly string[];
    statusMismatches: readonly Readonly<{
        key: string;
        left: string;
        right: string;
    }>[];
}>;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECTION = 'aliceRtc';
const DEFAULT_ROOM_ID = 'rallar-black-box-room';
const DEFAULT_DIRECT_PEER_IDS = ['bob-session'] as const;
const DEFAULT_MULTICAST_PEER_IDS = ['bob-session', 'charlie-session'] as const;

function cleanStrings(values: readonly string[] | undefined): readonly string[] {
    return values
        ?.map(value => value.trim())
        .filter(value => value.length > 0) ?? [];
}

function toTimeoutMs(value: number | undefined): number {
    return Number.isFinite(value) && value !== undefined && value > 0
        ? Math.round(value)
        : DEFAULT_TIMEOUT_MS;
}

function parityMetadata(
    operation: RallarBlackBoxParityOperation,
    options: Readonly<{
        deliveryMode?: RallarBlackBoxParityDeliveryMode;
        expectedConnections?: readonly string[];
        targetPeerIds?: readonly string[];
        runnerAction?: 'connect' | 'send' | 'wait' | 'close';
    }> = {},
): RallarBlackBoxParityCommandMetadata {
    return {
        operation,
        ...(options.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
        ...(options.expectedConnections ? { expectedConnections: options.expectedConnections } : {}),
        ...(options.targetPeerIds ? { targetPeerIds: options.targetPeerIds } : {}),
        ...(options.runnerAction ? { runnerAction: options.runnerAction } : {}),
        providerSpecificFields: [
            'startedAtEpochMs',
            'endedAtEpochMs',
            'durationMs',
            'provider',
            'remote',
            'health',
            'result',
            'actual',
        ],
    };
}

function parityPayload(
    transport: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>,
    deliveryMode: RallarBlackBoxParityDeliveryMode,
    roomId: string,
    payload: Readonly<Record<string, unknown>>,
    peerIds: readonly string[],
): Readonly<Record<string, unknown>> {
    const envelope = {
        topic: 'rallar.parity.probe',
        deliveryMode,
        roomId,
        payload,
    };

    if (transport === 'messages.rtc') {
        return {
            payload: envelope,
            roomId,
            typeId: 'room.black-box.parity',
            topicId: `room.black-box.parity.${deliveryMode}`,
            ...(deliveryMode !== 'broadcast' && peerIds.length > 0
                ? { nextHopPeerIds: peerIds }
                : {}),
        };
    }

    return {
        data: envelope,
        roomId,
        ...(deliveryMode !== 'broadcast' && peerIds.length > 0 ? { peerIds } : {}),
    };
}

export function createRallarBlackBoxProviderParityRecipe(
    options: RallarBlackBoxProviderParityRecipeOptions = {},
): RallarBlackBoxTestRecipe {
    const transport = options.transport ?? 'realtime';
    const connection = options.connection ?? DEFAULT_CONNECTION;
    const roomId = options.roomId ?? DEFAULT_ROOM_ID;
    const timeoutMs = toTimeoutMs(options.timeoutMs);
    const directPeerIds = cleanStrings(options.directPeerIds ?? DEFAULT_DIRECT_PEER_IDS);
    const multicastPeerIds = cleanStrings(options.multicastPeerIds ?? DEFAULT_MULTICAST_PEER_IDS);
    const directExpectedConnections = cleanStrings(
        options.directExpectedConnections ?? [connection],
    );
    const multicastExpectedConnections = cleanStrings(options.multicastExpectedConnections);
    const broadcastExpectedConnections = cleanStrings(options.broadcastExpectedConnections);

    return {
        recipeId: options.recipeId ?? 'rallar-provider-parity-recipe',
        name: options.name ?? 'Rallar provider parity recipe',
        description: options.description ??
            'Portable connect/send/health/close/reset recipe for visible SPA and black-box runner parity checks.',
        continueOnFailure: false,
        metadata: {
            parity: {
                version: 1,
                providerMode: options.providerMode ?? 'simulated',
                transport,
                connection,
                roomId,
            },
        },
        commands: [
            {
                kind: 'configure',
                commandId: 'parity-configure',
                label: 'Configure provider parity run',
                config: {
                    runId: options.runId ?? 'rallar-provider-parity-run',
                    agentId: options.agentId ?? 'visible-agent-local',
                    environment: options.environment ?? 'local',
                    apiBaseUrl: options.apiBaseUrl ?? 'https://api.example.invalid',
                    actor: options.actor ?? 'alice',
                    sessionId: options.sessionId ?? 'alice-session',
                    roomId,
                    transport,
                    rallar: {
                        username: 'alice',
                        password: 'local-demo-password',
                        token: 'local-demo-token',
                        ...(options.rallar ?? {}),
                    },
                    ...(options.browser ? { browser: options.browser } : {}),
                    control: {
                        providerMode: options.providerMode ?? 'simulated',
                        parity: true,
                        ...(options.control ?? {}),
                    },
                    defaults: {
                        timeoutMs,
                        connection,
                    },
                },
                metadata: {
                    parity: parityMetadata('configure'),
                },
            },
            {
                kind: 'rtc.connect',
                commandId: 'parity-connect',
                label: 'Connect provider parity RTC client',
                connection,
                actor: options.actor ?? 'alice',
                roomId,
                transport,
                timeoutMs,
                rallar: {
                    sessionId: options.sessionId ?? 'alice-session',
                },
                metadata: {
                    parity: parityMetadata('connect', {
                        expectedConnections: [connection],
                        runnerAction: 'connect',
                    }),
                },
            },
            {
                kind: 'rtc.send',
                commandId: 'parity-send-direct',
                label: 'Send provider parity direct payload',
                connection,
                transport,
                timeoutMs,
                send: parityPayload(transport, 'direct', roomId, {
                    sequence: 1,
                    kind: 'direct',
                }, directPeerIds),
                metadata: {
                    parity: parityMetadata('send.direct', {
                        deliveryMode: 'direct',
                        expectedConnections: directExpectedConnections,
                        targetPeerIds: directPeerIds,
                        runnerAction: 'send',
                    }),
                },
            },
            {
                kind: 'rtc.send',
                commandId: 'parity-send-multicast',
                label: 'Send provider parity multicast payload',
                connection,
                transport,
                timeoutMs,
                send: parityPayload(transport, 'multicast', roomId, {
                    sequence: 2,
                    kind: 'multicast',
                }, multicastPeerIds),
                metadata: {
                    parity: parityMetadata('send.multicast', {
                        deliveryMode: 'multicast',
                        expectedConnections: multicastExpectedConnections,
                        targetPeerIds: multicastPeerIds,
                        runnerAction: 'send',
                    }),
                },
            },
            {
                kind: 'rtc.send',
                commandId: 'parity-send-broadcast',
                label: 'Send provider parity broadcast payload',
                connection,
                transport,
                timeoutMs,
                send: parityPayload(transport, 'broadcast', roomId, {
                    sequence: 3,
                    kind: 'broadcast',
                }, []),
                metadata: {
                    parity: parityMetadata('send.broadcast', {
                        deliveryMode: 'broadcast',
                        expectedConnections: broadcastExpectedConnections,
                        runnerAction: 'send',
                    }),
                },
            },
            {
                kind: 'health',
                commandId: 'parity-health',
                label: 'Collect provider parity health',
                metadata: {
                    parity: parityMetadata('health'),
                },
            },
            {
                kind: 'close',
                commandId: 'parity-close',
                label: 'Close provider parity runtime',
                metadata: {
                    parity: parityMetadata('close', {
                        expectedConnections: [connection],
                        runnerAction: 'close',
                    }),
                },
            },
            {
                kind: 'reset',
                commandId: 'parity-reset',
                label: 'Reset provider parity runtime',
                metadata: {
                    parity: parityMetadata('reset'),
                },
            },
        ],
    };
}

function parityFromCommand(command: RallarBlackBoxTestCommand): RallarBlackBoxParityCommandMetadata | undefined {
    const metadata = command.metadata?.parity;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as RallarBlackBoxParityCommandMetadata
        : undefined;
}

function configCommands(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestConfig[] {
    return recipe.commands
        .filter((command): command is Extract<RallarBlackBoxTestCommand, { kind: 'configure' }> =>
            command.kind === 'configure'
        )
        .map(command => command.config);
}

function firstConfig(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestConfig {
    return configCommands(recipe)[0] ?? {};
}

function commandId(command: RallarBlackBoxTestCommand, fallback: string): string {
    return command.commandId ?? fallback;
}

function defaultConnection(config: RallarBlackBoxTestConfig): string {
    const configured = config.defaults?.connection;
    return typeof configured === 'string' && configured.length > 0
        ? configured
        : DEFAULT_CONNECTION;
}

function operationName(operation: RallarBlackBoxParityOperation): string {
    return operation
        .split('.')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function runnerName(operation: RallarBlackBoxParityOperation, commandIdValue: string): string {
    const compactId = commandIdValue
        .replace(/^parity-/, '')
        .replace(/[^a-zA-Z0-9]+(.)/g, (_match, next: string) => next.toUpperCase());
    return `parity${operationName(operation)}${compactId ? `_${compactId}` : ''}`;
}

function runnerInteraction(
    name: string,
    request: Readonly<Record<string, unknown>>,
    response: Readonly<Record<string, unknown>>,
    parity: RallarBlackBoxParityCommandMetadata,
): Record<string, unknown> {
    return {
        RTC: {
            request: {
                ...request,
                parity,
            },
            response,
        },
        [name]: {
            parity,
        },
    };
}

function runnerRequestBase(
    provider: RallarBlackBoxRunnerProviderName,
    command: RallarBlackBoxTestCommand,
    config: RallarBlackBoxTestConfig,
    interactionExecutionNumber: number,
    scenarioExecutionNumber: number,
): Record<string, unknown> {
    const connection = 'connection' in command && typeof command.connection === 'string'
        ? command.connection
        : defaultConnection(config);
    const timeoutMs = 'timeoutMs' in command && typeof command.timeoutMs === 'number'
        ? command.timeoutMs
        : config.defaults?.timeoutMs;

    return {
        provider,
        commandId: commandId(command, `parity-${interactionExecutionNumber}`),
        connection,
        actor: 'actor' in command && typeof command.actor === 'string'
            ? command.actor
            : config.actor,
        roomId: 'roomId' in command && typeof command.roomId === 'string'
            ? command.roomId
            : config.roomId,
        transport: 'transport' in command && command.transport
            ? command.transport
            : config.transport,
        timeoutMs,
        scenarioExecutionNumber,
        interactionExecutionNumber,
    };
}

function toExpectedConnections(command: RallarBlackBoxTestCommand): readonly string[] {
    return parityFromCommand(command)?.expectedConnections ?? [];
}

function usesEventShapedRtcMessages(
    provider: RallarBlackBoxRunnerProviderName,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape'],
): boolean {
    if (messageShape) {
        return messageShape === 'event';
    }

    return provider === 'rallar-remote-browser';
}

function expectedRtcMessage(
    provider: RallarBlackBoxRunnerProviderName,
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send' }>,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape'],
): unknown {
    const expected = command.expect ?? command.send;
    return usesEventShapedRtcMessages(provider, messageShape)
        ? { data: expected }
        : expected;
}

function sendResponse(
    provider: RallarBlackBoxRunnerProviderName,
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send' }>,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape'],
): Record<string, unknown> {
    const expectedConnections = toExpectedConnections(command);
    if (expectedConnections.length !== 1) {
        return {};
    }

    return {
        connection: expectedConnections[0],
        withinMs: command.timeoutMs,
        message: expectedRtcMessage(provider, command, messageShape),
    };
}

function waitInteractions(
    provider: RallarBlackBoxRunnerProviderName,
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send' }>,
    config: RallarBlackBoxTestConfig,
    scenarioExecutionNumber: number,
    nextInteractionNumber: number,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape'],
): readonly Record<string, unknown>[] {
    const parity = parityFromCommand(command);
    if (!parity) {
        return [];
    }

    const expectedConnections = parity.expectedConnections ?? [];
    if (expectedConnections.length <= 1) {
        return [];
    }

    const receiveOperation = parity.deliveryMode === 'broadcast'
        ? 'receive.broadcast'
        : parity.deliveryMode === 'multicast'
            ? 'receive.multicast'
            : 'receive.direct';

    return expectedConnections.map((connection, index) => {
        const operation = receiveOperation satisfies RallarBlackBoxParityOperation;
        const interactionNumber = nextInteractionNumber + index;
        const waitParity = parityMetadata(operation, {
            deliveryMode: parity.deliveryMode,
            expectedConnections: [connection],
            targetPeerIds: parity.targetPeerIds,
            runnerAction: 'wait',
        });
        return runnerInteraction(
            runnerName(operation, `${commandId(command, 'send')}-wait-${index + 1}`),
            {
                provider,
                action: 'wait',
                commandId: `${commandId(command, 'send')}-wait-${index + 1}`,
                connection,
                actor: config.actor,
                roomId: config.roomId,
                transport: command.transport ?? config.transport,
                timeoutMs: command.timeoutMs,
                scenarioExecutionNumber,
                interactionExecutionNumber: interactionNumber,
            },
            {
                connection,
                withinMs: command.timeoutMs,
                message: expectedRtcMessage(provider, command, messageShape),
            },
            waitParity,
        );
    });
}

export function toRallarBlackBoxRunnerParityInteractions(
    recipe: RallarBlackBoxTestRecipe,
    options: RallarBlackBoxRunnerParityOptions = {},
): RallarBlackBoxRunnerParityConversion {
    const provider = options.provider ?? 'rallar-remote-browser';
    const scenarioExecutionNumber = options.scenarioExecutionNumber ?? 1;
    const config = firstConfig(recipe);
    const interactions: Record<string, unknown>[] = [];
    const omittedCommands: RallarBlackBoxRunnerParityOmittedCommand[] = [];
    let interactionExecutionNumber = 1;

    recipe.commands.forEach((command, commandIndex) => {
        const parity = parityFromCommand(command);
        const operation = parity?.operation ?? operationFromCommand(command);
        if (command.kind === 'configure' || command.kind === 'health' || command.kind === 'reset') {
            omittedCommands.push({
                commandId: commandId(command, `${command.kind}-${commandIndex + 1}`),
                kind: command.kind,
                operation,
                reason: command.kind === 'configure'
                    ? 'runner RTC providers receive resolved config on each RTC request'
                    : 'runner RTC provider vocabulary has no first-class command for this SPA operation',
            });
            return;
        }

        if (command.kind === 'rtc.connect') {
            const request = runnerRequestBase(
                provider,
                command,
                config,
                interactionExecutionNumber,
                scenarioExecutionNumber,
            );
            interactions.push(runnerInteraction(
                runnerName(operation, commandId(command, 'connect')),
                {
                    ...request,
                    action: 'connect',
                    rallar: {
                        ...(config.rallar ?? {}),
                        ...(command.rallar ?? {}),
                        ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
                    },
                },
                {},
                parity ?? parityMetadata('connect', {
                    expectedConnections: [String(request.connection)],
                    runnerAction: 'connect',
                }),
            ));
            interactionExecutionNumber += 1;
            return;
        }

        if (command.kind === 'rtc.send') {
            const request = runnerRequestBase(
                provider,
                command,
                config,
                interactionExecutionNumber,
                scenarioExecutionNumber,
            );
            interactions.push(runnerInteraction(
                runnerName(operation, commandId(command, 'send')),
                {
                    ...request,
                    action: 'send',
                    send: command.send,
                },
                sendResponse(provider, command, options.messageShape),
                parity ?? parityMetadata('send.direct', {
                    runnerAction: 'send',
                }),
            ));
            interactionExecutionNumber += 1;

            if (options.includeReceiveWaits !== false) {
                const waits = waitInteractions(
                    provider,
                    command,
                    config,
                    scenarioExecutionNumber,
                    interactionExecutionNumber,
                    options.messageShape,
                );
                interactions.push(...waits);
                interactionExecutionNumber += waits.length;
            }
            return;
        }

        if (command.kind === 'close') {
            const request = runnerRequestBase(
                provider,
                command,
                config,
                interactionExecutionNumber,
                scenarioExecutionNumber,
            );
            interactions.push(runnerInteraction(
                runnerName(operation, commandId(command, 'close')),
                {
                    ...request,
                    action: 'close',
                },
                {},
                parity ?? parityMetadata('close', {
                    expectedConnections: [String(request.connection)],
                    runnerAction: 'close',
                }),
            ));
            interactionExecutionNumber += 1;
        }
    });

    return {
        interactions,
        omittedCommands,
    };
}

function operationFromCommand(command: RallarBlackBoxTestCommand): RallarBlackBoxParityOperation {
    if (command.kind === 'configure') {
        return 'configure';
    }
    if (command.kind === 'rtc.connect') {
        return 'connect';
    }
    if (command.kind === 'rtc.send') {
        const id = command.commandId ?? '';
        if (id.includes('broadcast')) {
            return 'send.broadcast';
        }
        if (id.includes('multicast')) {
            return 'send.multicast';
        }
        return 'send.direct';
    }
    if (command.kind === 'health') {
        return 'health';
    }
    if (command.kind === 'close') {
        return 'close';
    }
    if (command.kind === 'reset') {
        return 'reset';
    }
    return 'configure';
}

function operationFromResult(result: RallarBlackBoxTestResult): string {
    return operationFromCommand({
        kind: result.kind,
        commandId: result.commandId,
    } as RallarBlackBoxTestCommand);
}

function operationFromRunnerResult(result: Record<string, unknown>): string {
    const name = typeof result.name === 'string' ? result.name.toLowerCase() : '';
    if (name.includes('receive') && name.includes('broadcast')) {
        return 'receive.broadcast';
    }
    if (name.includes('receive') && name.includes('multicast')) {
        return 'receive.multicast';
    }
    if (name.includes('receive') && name.includes('direct')) {
        return 'receive.direct';
    }
    if (name.includes('broadcast')) {
        return 'send.broadcast';
    }
    if (name.includes('multicast')) {
        return 'send.multicast';
    }
    if (name.includes('direct')) {
        return 'send.direct';
    }
    if (name.includes('connect')) {
        return 'connect';
    }
    if (name.includes('close')) {
        return 'close';
    }
    return name || 'unknown';
}

function stepKey(operation: string, commandId: string | undefined, index: number): string {
    return commandId ? `${operation}:${commandId}` : `${operation}:${index + 1}`;
}

function normalizeStatus(value: unknown): 'ok' | 'failed' | 'cancelled' | 'skipped' {
    if (value === 'SUCCESS' || value === 'ok' || value === true) {
        return 'ok';
    }
    if (value === 'cancelled') {
        return 'cancelled';
    }
    if (value === 'skipped') {
        return 'skipped';
    }
    return 'failed';
}

export function normalizeRallarBlackBoxRuntimeParityReport(
    input: readonly RallarBlackBoxTestResult[] | Readonly<{
        results?: readonly RallarBlackBoxTestResult[];
        commandHistory?: readonly RallarBlackBoxTestResult[];
        events?: readonly RallarBlackBoxTestEvent[];
    }>,
): RallarBlackBoxProviderParityReport {
    const reportInput = input as Readonly<{
        results?: readonly RallarBlackBoxTestResult[];
        commandHistory?: readonly RallarBlackBoxTestResult[];
    }>;
    const results: readonly RallarBlackBoxTestResult[] = Array.isArray(input)
        ? input as readonly RallarBlackBoxTestResult[]
        : reportInput.results ?? reportInput.commandHistory ?? [];
    const resultSteps = results.map((
        result: RallarBlackBoxTestResult,
        index: number,
    ): RallarBlackBoxProviderParityStep => {
        const operation = operationFromResult(result);
        return {
            key: stepKey(operation, result.commandId, index),
            operation,
            status: normalizeStatus(result.status),
            commandId: result.commandId,
            kind: result.kind,
            comparable: {
                operation,
                commandId: result.commandId,
                kind: result.kind,
                status: normalizeStatus(result.status),
            },
            providerSpecific: {
                startedAtEpochMs: result.startedAtEpochMs,
                endedAtEpochMs: result.endedAtEpochMs,
                durationMs: result.durationMs,
                value: result.value,
                error: result.error,
            },
        };
    });

    return {
        source: 'rallar-bb-test',
        steps: resultSteps,
        providerSpecificFields: [
            'startedAtEpochMs',
            'endedAtEpochMs',
            'durationMs',
            'value',
            'error',
        ],
    };
}

export function normalizeBlackBoxRunnerParityReport(report: Readonly<{
    resultsList?: readonly Record<string, unknown>[];
}>): RallarBlackBoxProviderParityReport {
    const results = report.resultsList ?? [];
    return {
        source: 'black-box-runner',
        steps: results.map((result, index): RallarBlackBoxProviderParityStep => {
            const operation = operationFromRunnerResult(result);
            const actual = result.actual && typeof result.actual === 'object'
                ? result.actual as Record<string, unknown>
                : {};
            const commandIdValue = typeof actual.commandId === 'string'
                ? actual.commandId
                : typeof result.commandId === 'string'
                    ? result.commandId
                    : undefined;
            return {
                key: stepKey(operation, commandIdValue, index),
                operation,
                status: normalizeStatus(result.status),
                commandId: commandIdValue,
                kind: typeof result.transport === 'string' ? result.transport : undefined,
                action: typeof result.action === 'string' ? result.action : undefined,
                connection: typeof result.connection === 'string' ? result.connection : undefined,
                transport: typeof result.transport === 'string' ? result.transport : undefined,
                comparable: {
                    operation,
                    commandId: commandIdValue,
                    status: normalizeStatus(result.status),
                    action: result.action,
                    connection: result.connection,
                    transport: result.transport,
                },
                providerSpecific: {
                    name: result.name,
                    actual,
                    expected: result.expected,
                    result: result.result,
                    exception: result.exception,
                    startedAtEpochMs: result.startedAtEpochMs,
                    endedAtEpochMs: result.endedAtEpochMs,
                    durationMs: result.durationMs,
                },
            };
        }),
        providerSpecificFields: [
            'name',
            'actual',
            'expected',
            'result',
            'exception',
            'startedAtEpochMs',
            'endedAtEpochMs',
            'durationMs',
        ],
    };
}

export function compareRallarBlackBoxProviderParityReports(
    left: RallarBlackBoxProviderParityReport,
    right: RallarBlackBoxProviderParityReport,
): RallarBlackBoxProviderParityComparison {
    const leftByKey = new Map(left.steps.map(step => [step.key, step]));
    const rightByKey = new Map(right.steps.map(step => [step.key, step]));
    const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])];
    const matchedKeys: string[] = [];
    const missingLeft: string[] = [];
    const missingRight: string[] = [];
    const statusMismatches: Array<Readonly<{ key: string; left: string; right: string }>> = [];

    keys.forEach(key => {
        const leftStep = leftByKey.get(key);
        const rightStep = rightByKey.get(key);
        if (!leftStep) {
            missingLeft.push(key);
            return;
        }
        if (!rightStep) {
            missingRight.push(key);
            return;
        }
        matchedKeys.push(key);
        if (leftStep.status !== rightStep.status) {
            statusMismatches.push({
                key,
                left: leftStep.status,
                right: rightStep.status,
            });
        }
    });

    return {
        ok: missingLeft.length === 0 && missingRight.length === 0 && statusMismatches.length === 0,
        matchedKeys,
        missingLeft,
        missingRight,
        statusMismatches,
    };
}
