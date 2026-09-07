// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../../json-compare/CompareJson.ts';
import { toDecodedJsonStringPaths } from '../expectations/to-decoded-json-string-paths.ts';
import { toWaitCountBound } from '../expectations/wait-count-bound.ts';

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

function toOutputReportFields(interaction: any): any {
    return {
        output: interaction.request.output,
        outputPath: interaction.request.outputPath,
        outputs: interaction.request.outputs
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

export function toRtcFailureStatus(
    config: any,
    interaction: any,
    result: string,
    details: any = {}
): any {
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
            ...details
        },
        ...toOutputReportFields(interaction),
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
        ...toOutputReportFields(interaction),
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

function findRtcDiagnosticIndex(
    diagnostics: any[],
    expectedDiagnostic: any,
    interaction: any,
    excludedIndexes: number[] = []
): number {
    return diagnostics.findIndex((diagnostic, index) => {
        if (excludedIndexes.includes(index)) {
            return false;
        }

        const result = compareJson(
            expectedDiagnostic,
            diagnostic,
            toRtcComparisonConfig(interaction)
        );

        return result.isEqual;
    });
}

function findRtcDiagnosticIndexFrom(
    diagnostics: any[],
    expectedDiagnostic: any,
    interaction: any,
    fromIndex = 0,
    excludedIndexes: number[] = []
): number {
    for (let index = fromIndex; index < diagnostics.length; index++) {
        if (excludedIndexes.includes(index)) {
            continue;
        }

        const result = compareJson(
            expectedDiagnostic,
            diagnostics[index],
            toRtcComparisonConfig(interaction)
        );

        if (result.isEqual) {
            return index;
        }
    }

    return -1;
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

/** Applied to every observed frame before comparison, never to the expectation. */
function toDecodedFrame(data: any, interaction: any): any {
    return toDecodedJsonStringPaths(data, interaction.response?.decodeJsonPaths || []);
}

function toRtcComparisonConfig(interaction: any): any {
    return toConfig(
        interaction.response?.comparison || COMPARISON.COMPATIBLE,
        interaction.response?.ignoreJsonKeys || [],
        interaction.response?.ignoreJsonPaths || []
    );
}

function findRtcMessageIndex(
    messages: any[],
    expectedMessage: any,
    interaction: any,
    excludedIndexes: number[] = []
): number {
    return messages.findIndex((message, index) => {
        if (excludedIndexes.includes(index)) {
            return false;
        }

        const result = compareJson(
            expectedMessage,
            toDecodedFrame(message.data, interaction),
            toRtcComparisonConfig(interaction)
        );

        return result.isEqual;
    });
}

function findRtcMessageIndexFrom(
    messages: any[],
    expectedMessage: any,
    interaction: any,
    fromIndex = 0,
    excludedIndexes: number[] = []
): number {
    for (let index = fromIndex; index < messages.length; index++) {
        if (excludedIndexes.includes(index)) {
            continue;
        }

        const result = compareJson(
            expectedMessage,
            toDecodedFrame(messages[index].data, interaction),
            toRtcComparisonConfig(interaction)
        );

        if (result.isEqual) {
            return index;
        }
    }

    return -1;
}

export function waitForRtcMessage(
    interaction: any,
    config: any,
    context: any,
    details: any = {}
): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedMessage = interaction.response.message;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    if (expectedMessage === undefined) {
        return Promise.resolve(toRtcFailureStatus(config, interaction, 'RTC wait expects expect.message', {
            ...details,
            connection: connectionName
        }));
    }

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const messages = context.rtcMessages[connectionName] || [];
            const matchIndex = findRtcMessageIndex(messages, expectedMessage, interaction);

            if (matchIndex >= 0) {
                clearInterval(interval);
                const match = messages[matchIndex];

                if (consume) {
                    messages.splice(matchIndex, 1);
                }

                resolve(toRtcSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedMessage: match,
                    consumed: consume,
                    firstPayloadLatencyMs: toLatencyMs(
                        details.sendStartedAtEpochMs,
                        match.receivedAtEpochMs
                    ),
                    waitedMs: Date.now() - startedAt
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toRtcFailureStatus(config, interaction, 'Expected RTC message was not received', {
                    ...details,
                    connection: connectionName,
                    expectedMessage,
                    messages,
                    waitedMs: Date.now() - startedAt
                }));
            }
        }, 25);
    });
}

export function waitForRtcDiagnostic(
    interaction: any,
    config: any,
    context: any,
    details: any = {}
): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedDiagnostic = interaction.response.diagnostic;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    if (expectedDiagnostic === undefined) {
        return Promise.resolve(toRtcFailureStatus(config, interaction, 'RTC wait expects expect.diagnostic', {
            ...details,
            connection: connectionName
        }));
    }

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const diagnostics = context.rtcDiagnostics?.[connectionName] || [];
            const matchIndex = findRtcDiagnosticIndex(diagnostics, expectedDiagnostic, interaction);

            if (matchIndex >= 0) {
                clearInterval(interval);
                const match = diagnostics[matchIndex];

                if (consume) {
                    diagnostics.splice(matchIndex, 1);
                }

                resolve(toRtcSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedDiagnostic: match,
                    consumed: consume,
                    waitedMs: Date.now() - startedAt
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toRtcFailureStatus(config, interaction, 'Expected RTC diagnostic was not received', {
                    ...details,
                    connection: connectionName,
                    expectedDiagnostic,
                    diagnostics,
                    waitedMs: Date.now() - startedAt
                }));
            }
        }, 25);
    });
}

export function waitForRtcDiagnostics(
    interaction: any,
    config: any,
    context: any,
    details: any = {}
): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedDiagnostics = interaction.response.diagnostics;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;
    const ordered = interaction.response.ordered === true;

    if (!Array.isArray(expectedDiagnostics) || expectedDiagnostics.length <= 0) {
        return Promise.resolve(
            toRtcFailureStatus(config, interaction, 'Expected RTC diagnostics must be a non-empty array', {
                ...details,
                connection: connectionName,
                expectedDiagnostics
            })
        );
    }

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const diagnostics = context.rtcDiagnostics?.[connectionName] || [];
            const matchedDiagnostics: any[] = [];
            const matchedIndexes: number[] = [];
            let nextOrderedSearchIndex = 0;

            for (const expectedDiagnostic of expectedDiagnostics) {
                const matchIndex = ordered
                    ? findRtcDiagnosticIndexFrom(
                        diagnostics,
                        expectedDiagnostic,
                        interaction,
                        nextOrderedSearchIndex,
                        matchedIndexes
                    )
                    : findRtcDiagnosticIndex(
                        diagnostics,
                        expectedDiagnostic,
                        interaction,
                        matchedIndexes
                    );

                if (matchIndex >= 0) {
                    matchedIndexes.push(matchIndex);
                    matchedDiagnostics.push({
                        expectedDiagnostic,
                        matchedDiagnostic: diagnostics[matchIndex]
                    });

                    if (ordered) {
                        nextOrderedSearchIndex = matchIndex + 1;
                    }
                }
                else if (ordered) {
                    break;
                }
            }

            if (matchedDiagnostics.length === expectedDiagnostics.length) {
                clearInterval(interval);

                if (consume) {
                    matchedIndexes
                        .sort((a, b) => b - a)
                        .forEach((index) => diagnostics.splice(index, 1));
                }

                resolve(toRtcSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedDiagnostics,
                    consumed: consume,
                    ordered,
                    waitedMs: Date.now() - startedAt
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toRtcFailureStatus(
                    config,
                    interaction,
                    ordered
                        ? 'Expected RTC diagnostics were not received in the expected order'
                        : 'Expected RTC diagnostics were not received',
                    {
                        ...details,
                        connection: connectionName,
                        expectedDiagnostics,
                        matchedDiagnostics,
                        missingDiagnostics: expectedDiagnostics.filter((expectedDiagnostic: any) => {
                            return matchedDiagnostics.every((match) => match.expectedDiagnostic !== expectedDiagnostic);
                        }),
                        ordered,
                        diagnostics,
                        waitedMs: Date.now() - startedAt
                    }
                ));
            }
        }, 25);
    });
}

export function waitForRtcHealth(
    interaction: any,
    config: any,
    context: any,
    details: any = {}
): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedHealth = interaction.response.health;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();

    if (expectedHealth === undefined) {
        return Promise.resolve(toRtcFailureStatus(config, interaction, 'RTC wait expects expect.health', {
            ...details,
            connection: connectionName
        }));
    }

    return new Promise((resolve) => {
        const interval = setInterval(() => {
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
                clearInterval(interval);
                resolve(toRtcSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedHealth: health,
                    waitedMs: Date.now() - startedAt
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toRtcFailureStatus(config, interaction, 'Expected RTC health was not observed', {
                    ...details,
                    connection: connectionName,
                    expectedHealth,
                    health,
                    waitedMs: Date.now() - startedAt
                }));
            }
        }, 25);
    });
}

export function waitForRtcMessages(
    interaction: any,
    config: any,
    context: any,
    details: any = {}
): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedMessages = interaction.response.messages;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;
    const ordered = interaction.response.ordered === true;

    if (!Array.isArray(expectedMessages) || expectedMessages.length <= 0) {
        return Promise.resolve(
            toRtcFailureStatus(config, interaction, 'Expected RTC messages must be a non-empty array', {
                ...details,
                connection: connectionName,
                expectedMessages
            })
        );
    }

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const messages = context.rtcMessages[connectionName] || [];
            const matchedMessages: any[] = [];
            const matchedIndexes: number[] = [];
            let nextOrderedSearchIndex = 0;

            for (const expectedMessage of expectedMessages) {
                const matchIndex = ordered
                    ? findRtcMessageIndexFrom(
                        messages,
                        expectedMessage,
                        interaction,
                        nextOrderedSearchIndex,
                        matchedIndexes
                    )
                    : findRtcMessageIndex(messages, expectedMessage, interaction, matchedIndexes);

                if (matchIndex >= 0) {
                    matchedIndexes.push(matchIndex);
                    matchedMessages.push({
                        expectedMessage,
                        matchedMessage: messages[matchIndex]
                    });

                    if (ordered) {
                        nextOrderedSearchIndex = matchIndex + 1;
                    }
                }
                else if (ordered) {
                    break;
                }
            }

            if (matchedMessages.length === expectedMessages.length) {
                clearInterval(interval);

                if (consume) {
                    matchedIndexes
                        .sort((a, b) => b - a)
                        .forEach((index) => messages.splice(index, 1));
                }

                resolve(toRtcSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedMessages,
                    consumed: consume,
                    ordered,
                    waitedMs: Date.now() - startedAt
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toRtcFailureStatus(
                    config,
                    interaction,
                    ordered
                        ? 'Expected RTC messages were not received in the expected order'
                        : 'Expected RTC messages were not received',
                    {
                        ...details,
                        connection: connectionName,
                        expectedMessages,
                        matchedMessages,
                        missingMessages: expectedMessages.filter((expectedMessage: any) => {
                            return matchedMessages.every((match) => match.expectedMessage !== expectedMessage);
                        }),
                        ordered,
                        messages,
                        waitedMs: Date.now() - startedAt
                    }
                ));
            }
        }, 25);
    });
}

export function waitForRtcClose(
    interaction: any,
    config: any,
    context: any,
    details: any = {}
): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedClose = interaction.response.close === true
        ? {}
        : interaction.response.close;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    if (expectedClose === undefined) {
        return Promise.resolve(
            toRtcFailureStatus(config, interaction, 'RTC close expectation is missing. Use expect.close.', {
                ...details,
                connection: connectionName
            })
        );
    }

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const closeEvents = context.rtcCloseEvents[connectionName] || [];
            const matchIndex = findRtcCloseEventIndex(closeEvents, expectedClose, interaction);

            if (matchIndex >= 0) {
                clearInterval(interval);
                const match = closeEvents[matchIndex];

                if (consume) {
                    closeEvents.splice(matchIndex, 1);
                }

                resolve(toRtcSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedCloseEvent: match,
                    consumed: consume,
                    waitedMs: Date.now() - startedAt
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toRtcFailureStatus(config, interaction, 'Expected RTC close event was not received', {
                    ...details,
                    connection: connectionName,
                    expectedClose,
                    closeEvents,
                    waitedMs: Date.now() - startedAt
                }));
            }
        }, 25);
    });
}

export interface WaitForRtcMessageCountInput {
    readonly interaction: any;
    readonly config: any;
    readonly context: any;
    readonly details?: any;
}

function countMatchingRtcMessages(messages: any[], expectedMessage: any, interaction: any): number {
    return messages.filter((message) =>
        compareJson(expectedMessage, toDecodedFrame(message.data, interaction), toRtcComparisonConfig(interaction))
            .isEqual
    ).length;
}

/**
 * Cardinality over the whole window, mirroring the WebSocket wait.
 * `waitForRtcMessage` resolves on its first match and so cannot tell "exactly
 * one" from "at least one"; this waits the full `withinMs` before counting.
 */
export function waitForRtcMessageCount(input: WaitForRtcMessageCountInput): Promise<any> {
    const { interaction, config, context } = input;
    const details = input.details ?? {};
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedMessage = interaction.response.message;
    const bound = toWaitCountBound(interaction.response.count);
    const windowMs = Number.parseInt(
        interaction.response.withinMs || interaction.request.timeoutMs || 5000
    );
    const startedAt = Date.now();

    if (expectedMessage === undefined || expectedMessage === null) {
        return Promise.resolve(toRtcFailureStatus(
            config,
            interaction,
            'RTC count wait expects expect.message to match frames against.',
            { ...details, connection: connectionName }
        ));
    }

    if (bound === undefined) {
        return Promise.resolve(toRtcFailureStatus(
            config,
            interaction,
            'RTC count wait expects expect.count to be a non-negative integer or {min,max}.',
            { ...details, connection: connectionName, count: interaction.response.count }
        ));
    }

    return new Promise((resolve) => {
        setTimeout(() => {
            const messages = context.rtcMessages[connectionName] || [];
            const matchedCount = countMatchingRtcMessages(messages, expectedMessage, interaction);
            const reported = {
                ...details,
                connection: connectionName,
                expectedMessage,
                expectedCount: interaction.response.count,
                matchedCount,
                observedMessageCount: messages.length,
                waitedMs: Date.now() - startedAt
            };

            resolve(
                matchedCount >= bound.min && matchedCount <= bound.max
                    ? toRtcSuccessStatus(config, interaction, reported)
                    : toRtcFailureStatus(
                        config,
                        interaction,
                        'RTC message count did not match the expectation',
                        reported
                    )
            );
        }, windowMs);
    });
}

export interface WaitForRtcMessageAbsenceInput {
    readonly interaction: any;
    readonly config: any;
    readonly context: any;
    readonly details?: any;
}

export function waitForRtcMessageAbsence(input: WaitForRtcMessageAbsenceInput): Promise<any> {
    const { interaction, config, context } = input;
    const details = input.details ?? {};
    const connectionName = toRtcExpectedConnectionName(interaction);
    const absentMessage = interaction.response.absent;
    const windowMs = Number.parseInt(
        interaction.response.withinMs || interaction.request.timeoutMs || 5000
    );
    const startedAt = Date.now();

    if (absentMessage === undefined || absentMessage === null) {
        return Promise.resolve(toRtcFailureStatus(
            config,
            interaction,
            'RTC absence wait expects expect.absent to be a partial message matcher.',
            {
                ...details,
                connection: connectionName
            }
        ));
    }

    // The full window is always waited: an absence claim is only as strong as
    // the time the runner kept listening for the offending frame.
    return new Promise((resolve) => {
        setTimeout(() => {
            const messages = context.rtcMessages[connectionName] || [];
            const matchIndex = findRtcMessageIndex(messages, absentMessage, interaction);

            if (matchIndex >= 0) {
                resolve(toRtcFailureStatus(
                    config,
                    interaction,
                    'RTC message expected to be absent was received',
                    {
                        ...details,
                        connection: connectionName,
                        absent: absentMessage,
                        matchedMessage: messages[matchIndex],
                        matchedIndex: matchIndex,
                        observedMessageCount: messages.length,
                        waitedMs: Date.now() - startedAt
                    }
                ));
                return;
            }

            resolve(toRtcSuccessStatus(config, interaction, {
                ...details,
                connection: connectionName,
                absent: absentMessage,
                matchedMessage: undefined,
                observedMessageCount: messages.length,
                waitedMs: Date.now() - startedAt
            }));
        }, windowMs);
    });
}
