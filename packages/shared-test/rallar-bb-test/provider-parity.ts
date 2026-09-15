import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestTransport
} from './rallar-black-box-test-contracts.ts';

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

export interface RallarBlackBoxParityCommandMetadata {
    readonly operation: RallarBlackBoxParityOperation;
    readonly deliveryMode?: RallarBlackBoxParityDeliveryMode;
    readonly expectedConnections?: readonly string[];
    readonly targetPeerIds?: readonly string[];
    readonly runnerAction?: 'connect' | 'send' | 'wait' | 'close';
    readonly providerSpecificFields?: readonly string[];
}

export interface RallarBlackBoxProviderParityRecipeOptions {
    readonly recipeId?: string;
    readonly name?: string;
    readonly description?: string;
    readonly runId?: string;
    readonly agentId?: string;
    readonly environment?: string;
    readonly apiBaseUrl?: string;
    readonly actor?: string;
    readonly sessionId?: string;
    readonly roomId?: string;
    readonly connection?: string;
    readonly transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly timeoutMs?: number;
    readonly providerMode?: 'simulated' | 'browser-rallar';
    readonly includeDemoAuth?: boolean;
    readonly rallar?: Readonly<Record<string, unknown>>;
    readonly browser?: Readonly<Record<string, unknown>>;
    readonly control?: Readonly<Record<string, unknown>>;
    readonly directPeerIds?: readonly string[];
    readonly directExpectedConnections?: readonly string[];
    readonly multicastPeerIds?: readonly string[];
    readonly multicastExpectedConnections?: readonly string[];
    readonly broadcastExpectedConnections?: readonly string[];
}

export interface RallarBlackBoxRunnerParityOptions {
    readonly provider?: RallarBlackBoxRunnerProviderName;
    readonly scenarioExecutionNumber?: number;
    readonly includeReceiveWaits?: boolean;
    readonly messageShape?: 'raw' | 'event';
}

export interface RallarBlackBoxRunnerParityOmittedCommand {
    readonly commandId: string;
    readonly kind: RallarBlackBoxTestCommand['kind'];
    readonly operation: RallarBlackBoxParityOperation | string;
    readonly reason: string;
}

export interface RallarBlackBoxRunnerParityConversion {
    readonly interactions: readonly Record<string, unknown>[];
    readonly omittedCommands: readonly RallarBlackBoxRunnerParityOmittedCommand[];
}

export interface RallarBlackBoxProviderParityStep {
    readonly key: string;
    readonly operation: RallarBlackBoxParityOperation | string;
    readonly status: 'ok' | 'failed' | 'cancelled' | 'skipped';
    readonly commandId?: string;
    readonly kind?: string;
    readonly action?: string;
    readonly connection?: string;
    readonly transport?: string;
    readonly comparable: Readonly<Record<string, unknown>>;
    readonly providerSpecific: Readonly<Record<string, unknown>>;
}

export interface RallarBlackBoxProviderParityReport {
    readonly source: 'rallar-bb-test' | 'black-box-runner';
    readonly steps: readonly RallarBlackBoxProviderParityStep[];
    readonly providerSpecificFields: readonly string[];
}

export interface RallarBlackBoxProviderParityComparison {
    readonly ok: boolean;
    readonly matchedKeys: readonly string[];
    readonly missingLeft: readonly string[];
    readonly missingRight: readonly string[];
    readonly statusMismatches: readonly Readonly<{
        key: string;
        left: string;
        right: string;
    }>[];
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECTION = 'aliceRtc';
const DEFAULT_ROOM_ID = 'rallar-black-box-room';
const DEFAULT_DIRECT_PEER_IDS = ['bob-session'] as const;
const DEFAULT_MULTICAST_PEER_IDS = ['bob-session', 'charlie-session'] as const;

function toNonEmptyStrings(values: readonly string[] | undefined): readonly string[] {
    return values
        ?.map((value) => value.trim())
        .filter((value) => value.length > 0) ?? [];
}

function toTimeoutMs(value: number | undefined): number {
    return Number.isFinite(value) && value !== undefined && value > 0
        ? Math.round(value)
        : DEFAULT_TIMEOUT_MS;
}

function toParityMetadata(
    operation: RallarBlackBoxParityOperation,
    options: Readonly<{
        deliveryMode?: RallarBlackBoxParityDeliveryMode;
        expectedConnections?: readonly string[];
        targetPeerIds?: readonly string[];
        runnerAction?: 'connect' | 'send' | 'wait' | 'close';
    }> = {}
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
            'actual'
        ]
    };
}

interface ParityPayloadInput {
    readonly transport: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly deliveryMode: RallarBlackBoxParityDeliveryMode;
    readonly roomId: string;
    readonly sequence: number;
    readonly peerIds: readonly string[];
}
function toParityPayload(input: ParityPayloadInput): Readonly<Record<string, unknown>> {
    const { transport, deliveryMode, roomId, peerIds } = input;
    const envelope = {
        topic: 'rallar.parity.probe',
        deliveryMode,
        roomId,
        payload: { sequence: input.sequence, kind: deliveryMode }
    };
    if (transport === 'messages.rtc') {
        return {
            payload: envelope,
            roomId,
            typeId: 'room.black-box.parity',
            topicId: `room.black-box.parity.${deliveryMode}`,
            ...(deliveryMode !== 'broadcast' && peerIds.length > 0 ? { nextHopPeerIds: peerIds } : {})
        };
    }
    return { data: envelope, roomId, ...(deliveryMode !== 'broadcast' && peerIds.length > 0 ? { peerIds } : {}) };
}

interface ParityRecipeContext {
    readonly options: RallarBlackBoxProviderParityRecipeOptions;
    readonly transport: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    readonly connection: string;
    readonly roomId: string;
    readonly timeoutMs: number;
}
export function createRallarBlackBoxProviderParityRecipe(
    options: RallarBlackBoxProviderParityRecipeOptions = {}
): RallarBlackBoxTestRecipe {
    const context: ParityRecipeContext = {
        options,
        transport: options.transport ?? 'realtime',
        connection: options.connection ?? DEFAULT_CONNECTION,
        roomId: options.roomId ?? DEFAULT_ROOM_ID,
        timeoutMs: toTimeoutMs(options.timeoutMs)
    };
    return {
        schemaVersion: 1,
        recipeId: options.recipeId ?? 'rallar-provider-parity-recipe',
        name: options.name ?? 'Rallar provider parity recipe',
        description: options.description ??
            'Portable connect/send/health/close/reset recipe for visible SPA and black-box runner parity checks.',
        continueOnFailure: false,
        metadata: {
            parity: {
                version: 1,
                providerMode: options.providerMode ?? 'simulated',
                transport: context.transport,
                connection: context.connection,
                roomId: context.roomId
            }
        },
        commands: [
            toParityConfigureCommand(context),
            toParityConnectCommand(context),
            ...toParitySendCommands(context),
            ...toParityCompletionCommands(context.connection)
        ]
    };
}
function toParityConfigureCommand(context: ParityRecipeContext): RallarBlackBoxTestCommand {
    const { options, roomId, transport, timeoutMs, connection } = context;
    const demoRallarAuth = options.includeDemoAuth === false
        ? {}
        : { username: 'alice', password: 'local-demo-password', token: 'local-demo-token' };
    return {
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
            rallar: { ...demoRallarAuth, ...(options.rallar ?? {}) },
            ...(options.browser ? { browser: options.browser } : {}),
            control: { providerMode: options.providerMode ?? 'simulated', parity: true, ...(options.control ?? {}) },
            defaults: { timeoutMs, connection }
        },
        metadata: { parity: toParityMetadata('configure') }
    };
}
function toParityConnectCommand(context: ParityRecipeContext): RallarBlackBoxTestCommand {
    const { options, roomId, transport, timeoutMs, connection } = context;
    return {
        kind: 'rtc.connect',
        commandId: 'parity-connect',
        label: 'Connect provider parity RTC client',
        connection,
        actor: options.actor ?? 'alice',
        roomId,
        transport,
        timeoutMs,
        rallar: { sessionId: options.sessionId ?? 'alice-session' },
        metadata: {
            parity: toParityMetadata('connect', { expectedConnections: [connection], runnerAction: 'connect' })
        }
    };
}
interface ParitySendTarget {
    readonly mode: RallarBlackBoxParityDeliveryMode;
    readonly peers: readonly string[];
    readonly expected: readonly string[];
}
function toParitySendCommands(context: ParityRecipeContext): readonly RallarBlackBoxTestCommand[] {
    const { options, connection, transport, timeoutMs, roomId } = context;
    const targets: readonly ParitySendTarget[] = [
        {
            mode: 'direct',
            peers: toNonEmptyStrings(options.directPeerIds ?? DEFAULT_DIRECT_PEER_IDS),
            expected: toNonEmptyStrings(options.directExpectedConnections ?? [connection])
        },
        {
            mode: 'multicast',
            peers: toNonEmptyStrings(options.multicastPeerIds ?? DEFAULT_MULTICAST_PEER_IDS),
            expected: toNonEmptyStrings(options.multicastExpectedConnections)
        },
        { mode: 'broadcast', peers: [], expected: toNonEmptyStrings(options.broadcastExpectedConnections) }
    ];
    return targets.map(({ mode, peers, expected }, index) => ({
        kind: 'rtc.send',
        commandId: `parity-send-${mode}`,
        label: `Send provider parity ${mode} payload`,
        connection,
        transport,
        timeoutMs,
        send: toParityPayload({ transport, deliveryMode: mode, roomId, sequence: index + 1, peerIds: peers }),
        metadata: {
            parity: toParityMetadata(`send.${mode}`, {
                deliveryMode: mode,
                expectedConnections: expected,
                ...(mode === 'broadcast' ? {} : { targetPeerIds: peers }),
                runnerAction: 'send'
            })
        }
    }));
}
function toParityCompletionCommands(connection: string): readonly RallarBlackBoxTestCommand[] {
    return [
        {
            kind: 'health',
            commandId: 'parity-health',
            label: 'Collect provider parity health',
            metadata: { parity: toParityMetadata('health') }
        },
        {
            kind: 'close',
            commandId: 'parity-close',
            label: 'Close provider parity runtime',
            metadata: {
                parity: toParityMetadata('close', { expectedConnections: [connection], runnerAction: 'close' })
            }
        },
        {
            kind: 'reset',
            commandId: 'parity-reset',
            label: 'Reset provider parity runtime',
            metadata: { parity: toParityMetadata('reset') }
        }
    ];
}

function toParityFromCommand(command: RallarBlackBoxTestCommand): RallarBlackBoxParityCommandMetadata | undefined {
    const metadata = command.metadata?.parity;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as RallarBlackBoxParityCommandMetadata
        : undefined;
}

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
        : DEFAULT_CONNECTION;
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
    readonly request: Readonly<Record<string, unknown>>;
    readonly response: Readonly<Record<string, unknown>>;
    readonly parity: RallarBlackBoxParityCommandMetadata;
}
function toRunnerInteraction(input: RunnerInteractionInput): Record<string, unknown> {
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
function toRunnerRequestBase(input: RunnerRequestBaseInput): Record<string, unknown> {
    const { provider, command, config, interactionExecutionNumber, scenarioExecutionNumber } = input;
    const connection = 'connection' in command && typeof command.connection === 'string'
        ? command.connection
        : toDefaultConnection(config);
    const timeoutMs = 'timeoutMs' in command && typeof command.timeoutMs === 'number'
        ? command.timeoutMs
        : config.defaults?.timeoutMs;

    return {
        provider,
        commandId: toCommandId(command, `parity-${interactionExecutionNumber}`),
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
        interactionExecutionNumber
    };
}

function toExpectedConnections(command: RallarBlackBoxTestCommand): readonly string[] {
    return toParityFromCommand(command)?.expectedConnections ?? [];
}

function usesEventShapedRtcMessages(
    provider: RallarBlackBoxRunnerProviderName,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape']
): boolean {
    if (messageShape) {
        return messageShape === 'event';
    }

    return provider === 'rallar-remote-browser';
}

function toExpectedRtcMessage(
    provider: RallarBlackBoxRunnerProviderName,
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }>,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape']
): unknown {
    const expected = command.expect ?? command.send;
    return usesEventShapedRtcMessages(provider, messageShape)
        ? { data: expected }
        : expected;
}

function toSendResponse(
    provider: RallarBlackBoxRunnerProviderName,
    command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send'; }>,
    messageShape?: RallarBlackBoxRunnerParityOptions['messageShape']
): Record<string, unknown> {
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
function toWaitInteractions(input: WaitInteractionsInput): readonly Record<string, unknown>[] {
    const { provider, command, config, scenarioExecutionNumber, nextInteractionNumber, messageShape } = input;
    const parity = toParityFromCommand(command);
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
        const waitParity = toParityMetadata(operation, {
            deliveryMode: parity.deliveryMode,
            expectedConnections: [connection],
            targetPeerIds: parity.targetPeerIds,
            runnerAction: 'wait'
        });
        return toRunnerInteraction({
            name: toRunnerName(operation, `${toCommandId(command, 'send')}-wait-${index + 1}`),
            request: {
                provider,
                action: 'wait',
                commandId: `${toCommandId(command, 'send')}-wait-${index + 1}`,
                connection,
                actor: config.actor,
                roomId: config.roomId,
                transport: command.transport ?? config.transport,
                timeoutMs: command.timeoutMs,
                scenarioExecutionNumber,
                interactionExecutionNumber: interactionNumber
            },
            response: {
                connection,
                withinMs: command.timeoutMs,
                message: toExpectedRtcMessage(provider, command, messageShape)
            },
            parity: waitParity
        });
    });
}

export function toRallarBlackBoxRunnerParityInteractions(
    recipe: RallarBlackBoxTestRecipe,
    options: RallarBlackBoxRunnerParityOptions = {}
): RallarBlackBoxRunnerParityConversion {
    const provider = options.provider ?? 'rallar-remote-browser';
    const scenarioExecutionNumber = options.scenarioExecutionNumber ?? 1;
    const config = toFirstConfig(recipe);
    const interactions: Record<string, unknown>[] = [];
    const omittedCommands: RallarBlackBoxRunnerParityOmittedCommand[] = [];
    for (const [commandIndex, command] of recipe.commands.entries()) {
        const operation = toParityFromCommand(command)?.operation ?? toOperationFromCommand(command);
        if (command.kind === 'configure' || command.kind === 'health' || command.kind === 'reset') {
            omittedCommands.push({
                commandId: toCommandId(command, `${command.kind}-${commandIndex + 1}`),
                kind: command.kind,
                operation,
                reason: command.kind === 'configure'
                    ? 'runner RTC providers receive resolved config on each RTC request'
                    : 'runner RTC provider vocabulary has no first-class command for this SPA operation'
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
interface RunnerCommandInteractionsInput extends RunnerRequestBaseInput {
    readonly command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.connect' | 'rtc.send' | 'close'; }>;
    readonly options: RallarBlackBoxRunnerParityOptions;
}
function toRunnerCommandInteractions(input: RunnerCommandInteractionsInput): readonly Record<string, unknown>[] {
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
    request: Readonly<Record<string, unknown>>,
    config: RallarBlackBoxTestConfig
): Readonly<Record<string, unknown>> {
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

function toOperationFromCommand(
    command: Pick<RallarBlackBoxTestCommand, 'kind' | 'commandId'>
): RallarBlackBoxParityOperation {
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

function toOperationFromResult(result: RallarBlackBoxTestResult): string {
    return toOperationFromCommand(result);
}

function toOperationFromRunnerResult(result: Record<string, unknown>): string {
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

function toStepKey(operation: string, commandId: string | undefined, index: number): string {
    return commandId ? `${operation}:${commandId}` : `${operation}:${index + 1}`;
}

function toParityStatus(value: unknown): 'ok' | 'failed' | 'cancelled' | 'skipped' {
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
    input:
        | readonly RallarBlackBoxTestResult[]
        | Readonly<{
            results?: readonly RallarBlackBoxTestResult[];
            commandHistory?: readonly RallarBlackBoxTestResult[];
            events?: readonly RallarBlackBoxTestEvent[];
        }>
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
        index: number
    ): RallarBlackBoxProviderParityStep => {
        const operation = toOperationFromResult(result);
        return {
            key: toStepKey(operation, result.commandId, index),
            operation,
            status: toParityStatus(result.status),
            commandId: result.commandId,
            kind: result.kind,
            comparable: {
                operation,
                commandId: result.commandId,
                kind: result.kind,
                status: toParityStatus(result.status)
            },
            providerSpecific: {
                startedAtEpochMs: result.startedAtEpochMs,
                endedAtEpochMs: result.endedAtEpochMs,
                durationMs: result.durationMs,
                value: result.value,
                error: result.error
            }
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
            'error'
        ]
    };
}

export function normalizeBlackBoxRunnerParityReport(
    report: Readonly<{
        resultsList?: readonly Record<string, unknown>[];
    }>
): RallarBlackBoxProviderParityReport {
    const results = report.resultsList ?? [];
    return {
        source: 'black-box-runner',
        steps: results.map((result, index): RallarBlackBoxProviderParityStep => {
            const operation = toOperationFromRunnerResult(result);
            const actual = result.actual && typeof result.actual === 'object'
                ? result.actual as Record<string, unknown>
                : {};
            const commandIdValue = typeof actual.commandId === 'string'
                ? actual.commandId
                : typeof result.commandId === 'string'
                ? result.commandId
                : undefined;
            return {
                key: toStepKey(operation, commandIdValue, index),
                operation,
                status: toParityStatus(result.status),
                commandId: commandIdValue,
                kind: typeof result.transport === 'string' ? result.transport : undefined,
                action: typeof result.action === 'string' ? result.action : undefined,
                connection: typeof result.connection === 'string' ? result.connection : undefined,
                transport: typeof result.transport === 'string' ? result.transport : undefined,
                comparable: {
                    operation,
                    commandId: commandIdValue,
                    status: toParityStatus(result.status),
                    action: result.action,
                    connection: result.connection,
                    transport: result.transport
                },
                providerSpecific: {
                    name: result.name,
                    actual,
                    expected: result.expected,
                    result: result.result,
                    exception: result.exception,
                    startedAtEpochMs: result.startedAtEpochMs,
                    endedAtEpochMs: result.endedAtEpochMs,
                    durationMs: result.durationMs
                }
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
            'durationMs'
        ]
    };
}

export function compareRallarBlackBoxProviderParityReports(
    left: RallarBlackBoxProviderParityReport,
    right: RallarBlackBoxProviderParityReport
): RallarBlackBoxProviderParityComparison {
    const leftByKey = new Map(left.steps.map((step) => [step.key, step]));
    const rightByKey = new Map(right.steps.map((step) => [step.key, step]));
    const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])];
    const matchedKeys: string[] = [];
    const missingLeft: string[] = [];
    const missingRight: string[] = [];
    const statusMismatches: Array<Readonly<{ key: string; left: string; right: string; }>> = [];

    keys.forEach((key) => {
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
                right: rightStep.status
            });
        }
    });

    return {
        ok: missingLeft.length === 0 && missingRight.length === 0 && statusMismatches.length === 0,
        matchedKeys,
        missingLeft,
        missingRight,
        statusMismatches
    };
}
