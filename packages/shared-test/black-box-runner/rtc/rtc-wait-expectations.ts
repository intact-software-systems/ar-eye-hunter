// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig, type CompareConfig } from '../../json-compare/compare-json-values.ts';
import { toInteractionOutputFields } from '../execution/black-box-scenario-results.ts';

export interface RtcWaitInput {
    readonly interaction: any;
    readonly config: any;
    readonly context: any;
    readonly details?: any;
}

export interface RtcFailureStatusInput {
    readonly config: any;
    readonly interaction: any;
    readonly result: string;
    readonly details?: any;
}

interface FindRtcDiagnosticInput {
    readonly diagnostics: any[];
    readonly expectedDiagnostic: any;
    readonly interaction: any;
}

interface FindRtcMessageInput {
    readonly messages: any[];
    readonly expectedMessage: any;
    readonly interaction: any;
}

interface RtcObservationMatchInput {
    readonly observations: readonly unknown[];
    readonly expected: readonly unknown[];
    readonly ordered: boolean;
    readonly comparison: CompareConfig;
}

interface RtcObservationMatch {
    readonly expectedIndex: number;
    readonly observationIndex: number;
}

interface RtcMessageObservation {
    readonly data: unknown;
}

interface RtcMessageMatchInput extends Omit<RtcObservationMatchInput, 'observations'> {
    readonly observations: readonly RtcMessageObservation[];
}

interface MatchedRtcMessage {
    readonly expectedMessage: unknown;
    readonly matchedMessage: RtcMessageObservation;
}

interface MatchedRtcDiagnostic {
    readonly expectedDiagnostic: unknown;
    readonly matchedDiagnostic: unknown;
}

interface RtcMessageMatchEvidence {
    readonly indexes: readonly number[];
    readonly matchedMessages: readonly MatchedRtcMessage[];
    readonly missingMessages: readonly unknown[];
}

interface RtcDiagnosticMatchEvidence {
    readonly indexes: readonly number[];
    readonly matchedDiagnostics: readonly MatchedRtcDiagnostic[];
    readonly missingDiagnostics: readonly unknown[];
}

interface RtcWaitWindow {
    readonly connectionName: string;
    readonly startedAt: number;
    readonly timeoutMs: number;
    readonly consume: boolean;
    readonly ordered: boolean;
    readonly details: Record<string, any>;
}

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function toRtcReportFields(interaction: any): any {
    return {
        provider: interaction.request.provider,
        actor: interaction.request.actor,
        peerId: interaction.request.peerId,
        roomId: interaction.request.roomId,
        roomRef: interaction.request.roomRef,
        scope: interaction.request.scope,
        applicationId: interaction.request.applicationId,
        workspaceId: interaction.request.workspaceId,
        minSnapshotVersion: interaction.request.minSnapshotVersion,
        groupId: interaction.request.groupId,
        overlayId: interaction.request.overlayId,
        remotePeerId: interaction.request.remotePeerId,
        action: interaction.request.action,
        connection: interaction.request.connection
    };
}

function toCorrelationReportFields(interaction: any): any {
    const correlation = interaction?.request?.correlation;
    if (!correlation) {
        return {};
    }

    return {
        runnerRunId: correlation.runnerRunId,
        runnerStepId: correlation.runnerStepId,
        correlation
    };
}

export function toRtcFailureStatus(input: RtcFailureStatusInput): any {
    const { config, interaction, result } = input;
    return {
        name: config.interactionName,
        status: FAILURE,
        result,
        transport: 'RTC',
        ...toCorrelationReportFields(interaction),
        ...toRtcReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toRtcReportFields(interaction),
            ...(input.details ?? {})
        },
        ...toInteractionOutputFields(interaction),
        ...config
    };
}

export function toRtcSuccessStatus(config: any, interaction: any, details: any = {}): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'RTC',
        ...toCorrelationReportFields(interaction),
        ...toRtcReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toRtcReportFields(interaction),
            ...details
        },
        ...toInteractionOutputFields(interaction),
        input: interaction.request.input
    };
}

export function rememberRtcMessage(connectionName: string, message: any, context: any): void {
    if (!context.rtcMessages[connectionName]) {
        context.rtcMessages[connectionName] = [];
    }

    context.rtcMessages[connectionName].push(message);
}

export function rememberRtcDiagnostic(connectionName: string, diagnostic: any, context: any): void {
    if (!context.rtcDiagnostics) {
        context.rtcDiagnostics = {};
    }
    if (!context.rtcDiagnostics[connectionName]) {
        context.rtcDiagnostics[connectionName] = [];
    }

    context.rtcDiagnostics[connectionName].push(diagnostic);
}

export function rememberRtcCloseEvent(connectionName: string, closeEvent: any, context: any): void {
    if (!context.rtcCloseEvents[connectionName]) {
        context.rtcCloseEvents[connectionName] = [];
    }

    context.rtcCloseEvents[connectionName].push(closeEvent);
}

export function toRtcConnectionName(request: any): string {
    return request.connection !== undefined
        ? String(request.connection)
        : request.actor !== undefined
        ? String(request.actor)
        : request.name !== undefined
        ? String(request.name)
        : 'default';
}

export function toRtcExpectedConnectionName(interaction: any): string {
    return interaction.response?.connection !== undefined
        ? String(interaction.response.connection)
        : interaction.response?.onConnection !== undefined
        ? String(interaction.response.onConnection)
        : interaction.request?.expectConnection !== undefined
        ? String(interaction.request.expectConnection)
        : toRtcConnectionName(interaction.request);
}

function findRtcDiagnosticIndex(input: FindRtcDiagnosticInput): number {
    const { diagnostics, expectedDiagnostic, interaction } = input;
    return diagnostics.findIndex((diagnostic) => {
        const result = compareJson(
            expectedDiagnostic,
            diagnostic,
            toRtcComparisonConfig(interaction)
        );

        return result.isEqual;
    });
}

function findRtcCloseEventIndex(
    closeEvents: any[],
    expectedCloseEvent: any,
    interaction: any
): number {
    return closeEvents.findIndex((closeEvent) => {
        const result = compareJson(
            expectedCloseEvent,
            closeEvent,
            toRtcComparisonConfig(interaction)
        );

        return result.isEqual;
    });
}

function toLatencyMs(startedAtEpochMs: any, endedAtEpochMs: any): number | undefined {
    if (
        typeof startedAtEpochMs !== 'number' ||
        typeof endedAtEpochMs !== 'number' ||
        endedAtEpochMs < startedAtEpochMs
    ) {
        return undefined;
    }

    return endedAtEpochMs - startedAtEpochMs;
}

function toRtcComparisonConfig(interaction: any): CompareConfig {
    return toConfig(
        interaction.response?.comparison || COMPARISON.COMPATIBLE,
        interaction.response?.ignoreJsonKeys || [],
        interaction.response?.ignoreJsonPaths || []
    );
}

function findRtcMessageIndex(input: FindRtcMessageInput): number {
    const { messages, expectedMessage, interaction } = input;
    return messages.findIndex((message) => {
        const result = compareJson(
            expectedMessage,
            message.data,
            toRtcComparisonConfig(interaction)
        );

        return result.isEqual;
    });
}

function computeRtcObservationMatches(input: RtcObservationMatchInput): readonly RtcObservationMatch[] {
    const matches: RtcObservationMatch[] = [];
    const matchedIndexes = new Set<number>();
    let fromIndex = 0;
    for (const [expectedIndex, expected] of input.expected.entries()) {
        const observationIndex = input.observations.findIndex((observation, index) =>
            index >= fromIndex && !matchedIndexes.has(index) &&
            compareJson(expected, observation, input.comparison).isEqual
        );
        if (observationIndex >= 0) {
            matches.push({ expectedIndex, observationIndex });
            matchedIndexes.add(observationIndex);
            if (input.ordered) {
                fromIndex = observationIndex + 1;
            }
        }
        else if (input.ordered) {
            break;
        }
    }
    return matches;
}

function computeRtcMessageMatchEvidence(input: RtcMessageMatchInput): RtcMessageMatchEvidence {
    const matches = computeRtcObservationMatches({
        ...input,
        observations: input.observations.map((message) => message.data)
    });
    const matchedMessages = matches.map((match) => ({
        expectedMessage: input.expected[match.expectedIndex],
        matchedMessage: input.observations[match.observationIndex]
    }));
    return {
        indexes: matches.map((match) => match.observationIndex),
        matchedMessages,
        missingMessages: input.expected.filter((expected) =>
            matchedMessages.every((match) => match.expectedMessage !== expected)
        )
    };
}

function computeRtcDiagnosticMatchEvidence(input: RtcObservationMatchInput): RtcDiagnosticMatchEvidence {
    const matches = computeRtcObservationMatches(input);
    const matchedDiagnostics = matches.map((match) => ({
        expectedDiagnostic: input.expected[match.expectedIndex],
        matchedDiagnostic: input.observations[match.observationIndex]
    }));
    return {
        indexes: matches.map((match) => match.observationIndex),
        matchedDiagnostics,
        missingDiagnostics: input.expected.filter((expected) =>
            matchedDiagnostics.every((match) => match.expectedDiagnostic !== expected)
        )
    };
}

function consumeRtcObservations(observations: unknown[], indexes: readonly number[]): void {
    for (const index of [...indexes].sort((left, right) => right - left)) {
        observations.splice(index, 1);
    }
}

function startRtcWaitWindow(input: RtcWaitInput): RtcWaitWindow {
    const connectionName = toRtcExpectedConnectionName(input.interaction);
    return {
        connectionName,
        startedAt: Date.now(),
        timeoutMs: Number.parseInt(input.interaction.response.withinMs || input.interaction.request.timeoutMs || 5000),
        consume: input.interaction.response.consume === true,
        ordered: input.interaction.response.ordered === true,
        details: { ...input.details, connection: connectionName }
    };
}

export async function waitForRtcMessage(input: RtcWaitInput): Promise<any> {
    const { interaction, config, context } = input;
    const { connectionName, startedAt, timeoutMs, consume, details } = startRtcWaitWindow(input);
    const expectedMessage = interaction.response.message;

    if (expectedMessage === undefined) {
        return toRtcFailureStatus({
            ...input,
            result: 'RTC wait expects expect.message',
            details
        });
    }

    while (true) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        const messages = context.rtcMessages[connectionName] || [];
        const matchIndex = findRtcMessageIndex({
            messages,
            expectedMessage,
            interaction
        });

        if (matchIndex >= 0) {
            const match = messages[matchIndex];

            if (consume) {
                messages.splice(matchIndex, 1);
            }

            return toRtcSuccessStatus(config, interaction, {
                ...details,
                matchedMessage: match,
                consumed: consume,
                firstPayloadLatencyMs: toLatencyMs(
                    details.sendStartedAtEpochMs,
                    match.receivedAtEpochMs
                ),
                waitedMs: Date.now() - startedAt
            });
        }

        if (Date.now() - startedAt >= timeoutMs) {
            return toRtcFailureStatus({
                ...input,
                result: 'Expected RTC message was not received',
                details: {
                    ...details,
                    expectedMessage,
                    messages,
                    waitedMs: Date.now() - startedAt
                }
            });
        }
    }
}

export async function waitForRtcDiagnostic(input: RtcWaitInput): Promise<any> {
    const { interaction, config, context } = input;
    const { connectionName, startedAt, timeoutMs, consume, details } = startRtcWaitWindow(input);
    const expectedDiagnostic = interaction.response.diagnostic;

    if (expectedDiagnostic === undefined) {
        return toRtcFailureStatus({
            ...input,
            result: 'RTC wait expects expect.diagnostic',
            details
        });
    }

    while (true) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        const diagnostics = context.rtcDiagnostics?.[connectionName] || [];
        const matchIndex = findRtcDiagnosticIndex({
            diagnostics,
            expectedDiagnostic,
            interaction
        });

        if (matchIndex >= 0) {
            const match = diagnostics[matchIndex];

            if (consume) {
                diagnostics.splice(matchIndex, 1);
            }

            return toRtcSuccessStatus(config, interaction, {
                ...details,
                matchedDiagnostic: match,
                consumed: consume,
                waitedMs: Date.now() - startedAt
            });
        }

        if (Date.now() - startedAt >= timeoutMs) {
            return toRtcFailureStatus({
                ...input,
                result: 'Expected RTC diagnostic was not received',
                details: {
                    ...details,
                    expectedDiagnostic,
                    diagnostics,
                    waitedMs: Date.now() - startedAt
                }
            });
        }
    }
}

export async function waitForRtcDiagnostics(input: RtcWaitInput): Promise<any> {
    const { interaction, config, context } = input;
    const { connectionName, startedAt, timeoutMs, consume, ordered, details } = startRtcWaitWindow(input);
    const expectedDiagnostics = interaction.response.diagnostics;

    if (!Array.isArray(expectedDiagnostics) || expectedDiagnostics.length <= 0) {
        return toRtcFailureStatus({
            ...input,
            result: 'Expected RTC diagnostics must be a non-empty array',
            details: {
                ...details,
                expectedDiagnostics
            }
        });
    }

    while (true) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        const diagnostics = context.rtcDiagnostics?.[connectionName] || [];
        const { indexes, matchedDiagnostics, missingDiagnostics } = computeRtcDiagnosticMatchEvidence({
            observations: diagnostics,
            expected: expectedDiagnostics,
            ordered,
            comparison: toRtcComparisonConfig(interaction)
        });

        if (matchedDiagnostics.length === expectedDiagnostics.length) {
            if (consume) {
                consumeRtcObservations(diagnostics, indexes);
            }

            return toRtcSuccessStatus(config, interaction, {
                ...details,
                matchedDiagnostics,
                consumed: consume,
                ordered,
                waitedMs: Date.now() - startedAt
            });
        }

        if (Date.now() - startedAt >= timeoutMs) {
            return toRtcFailureStatus({
                ...input,
                result: ordered
                    ? 'Expected RTC diagnostics were not received in the expected order'
                    : 'Expected RTC diagnostics were not received',
                details: {
                    ...details,
                    expectedDiagnostics,
                    matchedDiagnostics,
                    missingDiagnostics,
                    ordered,
                    diagnostics,
                    waitedMs: Date.now() - startedAt
                }
            });
        }
    }
}

export async function waitForRtcHealth(input: RtcWaitInput): Promise<any> {
    const { interaction, config, context } = input;
    const { connectionName, startedAt, timeoutMs, details } = startRtcWaitWindow(input);
    const expectedHealth = interaction.response.health;

    if (expectedHealth === undefined) {
        return toRtcFailureStatus({
            ...input,
            result: 'RTC wait expects expect.health',
            details
        });
    }

    while (true) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        const connection = context.rtcConnections?.[connectionName];
        const health = connection?.client?.diagnostics?.() ?? connection?.diagnostics;
        if (connection && health !== undefined) {
            connection.diagnostics = health;
        }

        if (
            health !== undefined && compareJson(
                expectedHealth,
                health,
                toRtcComparisonConfig(interaction)
            ).isEqual
        ) {
            return toRtcSuccessStatus(config, interaction, {
                ...details,
                matchedHealth: health,
                waitedMs: Date.now() - startedAt
            });
        }

        if (Date.now() - startedAt >= timeoutMs) {
            return toRtcFailureStatus({
                ...input,
                result: 'Expected RTC health was not observed',
                details: {
                    ...details,
                    expectedHealth,
                    health,
                    waitedMs: Date.now() - startedAt
                }
            });
        }
    }
}

export async function waitForRtcMessages(input: RtcWaitInput): Promise<any> {
    const { interaction, config, context } = input;
    const { connectionName, startedAt, timeoutMs, consume, ordered, details } = startRtcWaitWindow(input);
    const expectedMessages = interaction.response.messages;

    if (!Array.isArray(expectedMessages) || expectedMessages.length <= 0) {
        return toRtcFailureStatus({
            ...input,
            result: 'Expected RTC messages must be a non-empty array',
            details: {
                ...details,
                expectedMessages
            }
        });
    }

    while (true) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        const messages = context.rtcMessages[connectionName] || [];
        const { indexes, matchedMessages, missingMessages } = computeRtcMessageMatchEvidence({
            observations: messages,
            expected: expectedMessages,
            ordered,
            comparison: toRtcComparisonConfig(interaction)
        });

        if (matchedMessages.length === expectedMessages.length) {
            if (consume) {
                consumeRtcObservations(messages, indexes);
            }

            return toRtcSuccessStatus(config, interaction, {
                ...details,
                matchedMessages,
                consumed: consume,
                ordered,
                waitedMs: Date.now() - startedAt
            });
        }

        if (Date.now() - startedAt >= timeoutMs) {
            return toRtcFailureStatus({
                ...input,
                result: ordered
                    ? 'Expected RTC messages were not received in the expected order'
                    : 'Expected RTC messages were not received',
                details: {
                    ...details,
                    expectedMessages,
                    matchedMessages,
                    missingMessages,
                    ordered,
                    messages,
                    waitedMs: Date.now() - startedAt
                }
            });
        }
    }
}

export async function waitForRtcClose(input: RtcWaitInput): Promise<any> {
    const { interaction, config, context } = input;
    const { connectionName, startedAt, timeoutMs, consume, details } = startRtcWaitWindow(input);
    const expectedClose = interaction.response.close === true
        ? {}
        : interaction.response.close;

    if (expectedClose === undefined) {
        return toRtcFailureStatus({
            ...input,
            result: 'RTC close expectation is missing. Use expect.close.',
            details
        });
    }

    while (true) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        const closeEvents = context.rtcCloseEvents[connectionName] || [];
        const matchIndex = findRtcCloseEventIndex(closeEvents, expectedClose, interaction);

        if (matchIndex >= 0) {
            const match = closeEvents[matchIndex];

            if (consume) {
                closeEvents.splice(matchIndex, 1);
            }

            return toRtcSuccessStatus(config, interaction, {
                ...details,
                matchedCloseEvent: match,
                consumed: consume,
                waitedMs: Date.now() - startedAt
            });
        }

        if (Date.now() - startedAt >= timeoutMs) {
            return toRtcFailureStatus({
                ...input,
                result: 'Expected RTC close event was not received',
                details: {
                    ...details,
                    expectedClose,
                    closeEvents,
                    waitedMs: Date.now() - startedAt
                }
            });
        }
    }
}

export async function waitForRtcMessageAbsence(input: RtcWaitInput): Promise<any> {
    const { interaction, config, context } = input;
    const details = input.details ?? {};
    const connectionName = toRtcExpectedConnectionName(interaction);
    const absentMessage = interaction.response.absent;
    const windowMs = Number.parseInt(
        interaction.response.withinMs || interaction.request.timeoutMs || 5000
    );
    const startedAt = Date.now();

    if (absentMessage === undefined || absentMessage === null) {
        return toRtcFailureStatus({
            config: config,
            interaction: interaction,
            result: 'RTC absence wait expects expect.absent to be a partial message matcher.',
            details: {
                ...details,
                connection: connectionName
            }
        });
    }

    // The full window is always waited: an absence claim is only as strong as
    // the time the runner kept listening for the offending frame.
    await new Promise<void>((resolve) => setTimeout(resolve, windowMs));

    const messages = context.rtcMessages[connectionName] || [];
    const matchIndex = findRtcMessageIndex({
        messages: messages,
        expectedMessage: absentMessage,
        interaction: interaction
    });

    if (matchIndex >= 0) {
        return toRtcFailureStatus({
            config: config,
            interaction: interaction,
            result: 'RTC message expected to be absent was received',
            details: {
                ...details,
                connection: connectionName,
                absent: absentMessage,
                matchedMessage: messages[matchIndex],
                matchedIndex: matchIndex,
                observedMessageCount: messages.length,
                waitedMs: Date.now() - startedAt
            }
        });
    }

    return toRtcSuccessStatus(config, interaction, {
        ...details,
        connection: connectionName,
        absent: absentMessage,
        matchedMessage: undefined,
        observedMessageCount: messages.length,
        waitedMs: Date.now() - startedAt
    });
}
