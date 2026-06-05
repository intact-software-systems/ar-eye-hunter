// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../json-compare/CompareJson.ts';

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

export type RtcProvider = {
    connect: (interaction: any, config: any, context: any) => Promise<any>
    send: (interaction: any, config: any, context: any) => Promise<any>
    wait: (interaction: any, config: any, context: any) => Promise<any>
    close: (interaction: any, config: any, context: any) => Promise<any>
    command?: (interaction: any, config: any, context: any) => Promise<any>
}

export type RtcClient = {
    connect: () => Promise<void>
    send: (message: any, interaction?: any, config?: any, context?: any) => Promise<any>
    command?: (action: string, request: any, interaction?: any, config?: any, context?: any) => Promise<any>
    close: (interaction?: any, config?: any, context?: any) => Promise<void>
    onMessage?: (handler: (message: any) => void) => void
    onClose?: (handler: (event: any) => void) => void
    diagnostics?: () => any
}

export type RtcClientProviderOptions = {
    createClient: (request: any, config?: any, context?: any) => Promise<RtcClient> | RtcClient
}

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
        connection: interaction.request.connection,
    };
}

function toOutputReportFields(interaction: any): any {
    return {
        output: interaction.request.output,
        outputPath: interaction.request.outputPath,
        outputs: interaction.request.outputs,
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
        correlation,
    };
}

export function toRtcFailureStatus(config: any, interaction: any, result: string, details: any = {}): any {
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
            ...details,
        },
        ...toOutputReportFields(interaction),
        ...config,
    };
}

export function createMissingRtcProvider(providerName: string): RtcProvider {
    const missing = (interaction: any, config: any, context: any): Promise<any> => {
        return Promise.resolve(toRtcFailureStatus(
            config,
            interaction,
            'RTC provider is not configured: ' + providerName,
            {
                availableProviders: Object.keys(context.rtcProviders || {}),
            },
        ));
    };

    return {
        connect: missing,
        send: missing,
        wait: missing,
        close: missing,
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
            ...details,
        },
        ...toOutputReportFields(interaction),
        input: interaction.request.input,
    };
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

function findRtcDiagnosticIndex(
    diagnostics: any[],
    expectedDiagnostic: any,
    interaction: any,
    excludedIndexes: number[] = [],
): number {
    return diagnostics.findIndex((diagnostic, index) => {
        if (excludedIndexes.includes(index)) {
            return false;
        }

        const result = compareJson(
            expectedDiagnostic,
            diagnostic,
            toRtcComparisonConfig(interaction),
        );

        return result.isEqual;
    });
}

function findRtcDiagnosticIndexFrom(
    diagnostics: any[],
    expectedDiagnostic: any,
    interaction: any,
    fromIndex = 0,
    excludedIndexes: number[] = [],
): number {
    for (let index = fromIndex; index < diagnostics.length; index++) {
        if (excludedIndexes.includes(index)) {
            continue;
        }

        const result = compareJson(
            expectedDiagnostic,
            diagnostics[index],
            toRtcComparisonConfig(interaction),
        );

        if (result.isEqual) {
            return index;
        }
    }

    return -1;
}

function findRtcCloseEventIndex(closeEvents: any[], expectedCloseEvent: any, interaction: any): number {
    return closeEvents.findIndex(closeEvent => {
        const result = compareJson(
            expectedCloseEvent,
            closeEvent,
            toRtcComparisonConfig(interaction),
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

function toRtcComparisonConfig(interaction: any): any {
    return toConfig(
        interaction.response?.comparison || COMPARISON.COMPATIBLE,
        interaction.response?.ignoreJsonKeys || [],
        interaction.response?.ignoreJsonPaths || [],
    );
}

function findRtcMessageIndex(
    messages: any[],
    expectedMessage: any,
    interaction: any,
    excludedIndexes: number[] = [],
): number {
    return messages.findIndex((message, index) => {
        if (excludedIndexes.includes(index)) {
            return false;
        }

        const result = compareJson(
            expectedMessage,
            message.data,
            toRtcComparisonConfig(interaction),
        );

        return result.isEqual;
    });
}

function findRtcMessageIndexFrom(
    messages: any[],
    expectedMessage: any,
    interaction: any,
    fromIndex = 0,
    excludedIndexes: number[] = [],
): number {
    for (let index = fromIndex; index < messages.length; index++) {
        if (excludedIndexes.includes(index)) {
            continue;
        }

        const result = compareJson(
            expectedMessage,
            messages[index].data,
            toRtcComparisonConfig(interaction),
        );

        if (result.isEqual) {
            return index;
        }
    }

    return -1;
}

export function waitForRtcMessage(interaction: any, config: any, context: any, details: any = {}): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedMessage = interaction.response.message;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    if (expectedMessage === undefined) {
        return Promise.resolve(toRtcFailureStatus(config, interaction, 'RTC wait expects expect.message', {
            ...details,
            connection: connectionName,
        }));
    }

    return new Promise(resolve => {
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
                        match.receivedAtEpochMs,
                    ),
                    waitedMs: Date.now() - startedAt,
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
                    waitedMs: Date.now() - startedAt,
                }));
            }
        }, 25);
    });
}

export function waitForRtcDiagnostic(interaction: any, config: any, context: any, details: any = {}): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedDiagnostic = interaction.response.diagnostic;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    if (expectedDiagnostic === undefined) {
        return Promise.resolve(toRtcFailureStatus(config, interaction, 'RTC wait expects expect.diagnostic', {
            ...details,
            connection: connectionName,
        }));
    }

    return new Promise(resolve => {
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
                    waitedMs: Date.now() - startedAt,
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
                    waitedMs: Date.now() - startedAt,
                }));
            }
        }, 25);
    });
}

export function waitForRtcDiagnostics(interaction: any, config: any, context: any, details: any = {}): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedDiagnostics = interaction.response.diagnostics;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;
    const ordered = interaction.response.ordered === true;

    if (!Array.isArray(expectedDiagnostics) || expectedDiagnostics.length <= 0) {
        return Promise.resolve(toRtcFailureStatus(config, interaction, 'Expected RTC diagnostics must be a non-empty array', {
            ...details,
            connection: connectionName,
            expectedDiagnostics,
        }));
    }

    return new Promise(resolve => {
        const interval = setInterval(() => {
            const diagnostics = context.rtcDiagnostics?.[connectionName] || [];
            const matchedDiagnostics: any[] = [];
            const matchedIndexes: number[] = [];
            let nextOrderedSearchIndex = 0;

            for (const expectedDiagnostic of expectedDiagnostics) {
                const matchIndex = ordered
                    ? findRtcDiagnosticIndexFrom(diagnostics, expectedDiagnostic, interaction, nextOrderedSearchIndex, matchedIndexes)
                    : findRtcDiagnosticIndex(diagnostics, expectedDiagnostic, interaction, matchedIndexes);

                if (matchIndex >= 0) {
                    matchedIndexes.push(matchIndex);
                    matchedDiagnostics.push({
                        expectedDiagnostic,
                        matchedDiagnostic: diagnostics[matchIndex],
                    });

                    if (ordered) {
                        nextOrderedSearchIndex = matchIndex + 1;
                    }
                } else if (ordered) {
                    break;
                }
            }

            if (matchedDiagnostics.length === expectedDiagnostics.length) {
                clearInterval(interval);

                if (consume) {
                    matchedIndexes
                        .sort((a, b) => b - a)
                        .forEach(index => diagnostics.splice(index, 1));
                }

                resolve(toRtcSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedDiagnostics,
                    consumed: consume,
                    ordered,
                    waitedMs: Date.now() - startedAt,
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toRtcFailureStatus(config, interaction, ordered
                    ? 'Expected RTC diagnostics were not received in the expected order'
                    : 'Expected RTC diagnostics were not received', {
                    ...details,
                    connection: connectionName,
                    expectedDiagnostics,
                    matchedDiagnostics,
                    missingDiagnostics: expectedDiagnostics.filter((expectedDiagnostic: any) => {
                        return matchedDiagnostics.every(match => match.expectedDiagnostic !== expectedDiagnostic);
                    }),
                    ordered,
                    diagnostics,
                    waitedMs: Date.now() - startedAt,
                }));
            }
        }, 25);
    });
}

export function waitForRtcHealth(interaction: any, config: any, context: any, details: any = {}): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedHealth = interaction.response.health;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();

    if (expectedHealth === undefined) {
        return Promise.resolve(toRtcFailureStatus(config, interaction, 'RTC wait expects expect.health', {
            ...details,
            connection: connectionName,
        }));
    }

    return new Promise(resolve => {
        const interval = setInterval(() => {
            const connection = context.rtcConnections?.[connectionName];
            const health = connection?.client?.diagnostics?.() ?? connection?.diagnostics;
            if (connection && health !== undefined) {
                connection.diagnostics = health;
            }

            if (health !== undefined && compareJson(
                expectedHealth,
                health,
                toRtcComparisonConfig(interaction),
            ).isEqual) {
                clearInterval(interval);
                resolve(toRtcSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedHealth: health,
                    waitedMs: Date.now() - startedAt,
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
                    waitedMs: Date.now() - startedAt,
                }));
            }
        }, 25);
    });
}

export function waitForRtcMessages(interaction: any, config: any, context: any, details: any = {}): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedMessages = interaction.response.messages;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;
    const ordered = interaction.response.ordered === true;

    if (!Array.isArray(expectedMessages) || expectedMessages.length <= 0) {
        return Promise.resolve(toRtcFailureStatus(config, interaction, 'Expected RTC messages must be a non-empty array', {
            ...details,
            connection: connectionName,
            expectedMessages,
        }));
    }

    return new Promise(resolve => {
        const interval = setInterval(() => {
            const messages = context.rtcMessages[connectionName] || [];
            const matchedMessages: any[] = [];
            const matchedIndexes: number[] = [];
            let nextOrderedSearchIndex = 0;

            for (const expectedMessage of expectedMessages) {
                const matchIndex = ordered
                    ? findRtcMessageIndexFrom(messages, expectedMessage, interaction, nextOrderedSearchIndex, matchedIndexes)
                    : findRtcMessageIndex(messages, expectedMessage, interaction, matchedIndexes);

                if (matchIndex >= 0) {
                    matchedIndexes.push(matchIndex);
                    matchedMessages.push({
                        expectedMessage,
                        matchedMessage: messages[matchIndex],
                    });

                    if (ordered) {
                        nextOrderedSearchIndex = matchIndex + 1;
                    }
                } else if (ordered) {
                    break;
                }
            }

            if (matchedMessages.length === expectedMessages.length) {
                clearInterval(interval);

                if (consume) {
                    matchedIndexes
                        .sort((a, b) => b - a)
                        .forEach(index => messages.splice(index, 1));
                }

                resolve(toRtcSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedMessages,
                    consumed: consume,
                    ordered,
                    waitedMs: Date.now() - startedAt,
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toRtcFailureStatus(config, interaction, ordered
                    ? 'Expected RTC messages were not received in the expected order'
                    : 'Expected RTC messages were not received', {
                    ...details,
                    connection: connectionName,
                    expectedMessages,
                    matchedMessages,
                    missingMessages: expectedMessages.filter((expectedMessage: any) => {
                        return matchedMessages.every(match => match.expectedMessage !== expectedMessage);
                    }),
                    ordered,
                    messages,
                    waitedMs: Date.now() - startedAt,
                }));
            }
        }, 25);
    });
}

export function waitForRtcClose(interaction: any, config: any, context: any, details: any = {}): Promise<any> {
    const request = interaction.request;
    const connectionName = toRtcExpectedConnectionName(interaction);
    const expectedClose = interaction.response.close === true
        ? {}
        : interaction.response.close;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    if (expectedClose === undefined) {
        return Promise.resolve(toRtcFailureStatus(config, interaction, 'RTC close expectation is missing. Use expect.close.', {
            ...details,
            connection: connectionName,
        }));
    }

    return new Promise(resolve => {
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
                    waitedMs: Date.now() - startedAt,
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
                    waitedMs: Date.now() - startedAt,
                }));
            }
        }, 25);
    });
}

export function toRtcPayload(request: any): any {
    return request.send !== undefined
        ? request.send
        : request.message !== undefined
            ? request.message
            : request.body;
}

export function toRtcDeliveredMessages(request: any): any[] {
    const explicitDeliveredMessages = request.deliverMessages !== undefined
        ? request.deliverMessages
        : request.deliver;

    if (explicitDeliveredMessages !== undefined) {
        return Array.isArray(explicitDeliveredMessages)
            ? explicitDeliveredMessages
            : [explicitDeliveredMessages];
    }

    const payload = toRtcPayload(request);
    return payload !== undefined
        ? [payload]
        : [];
}

export function toRtcDeliverTargets(interaction: any): string[] {
    const explicitTarget = interaction.request.deliverTo !== undefined
        ? interaction.request.deliverTo
        : interaction.request.to;

    const expectedTarget = interaction.response?.connection !== undefined
        ? interaction.response.connection
        : interaction.response?.onConnection;

    const targets = explicitTarget !== undefined
        ? Array.isArray(explicitTarget) ? explicitTarget : [explicitTarget]
        : expectedTarget !== undefined
            ? [expectedTarget]
            : [];

    return targets.map(String);
}

function toStoredRtcCloseEvent(event: any, interaction: any): any {
    const eventFields = event && typeof event === 'object' && !Array.isArray(event)
        ? event
        : { value: event };

    return {
        ...eventFields,
        event,
        closedAtEpochMs: Date.now(),
        provider: interaction.request.provider,
        actor: interaction.request.actor,
        roomId: interaction.request.roomId,
    };
}

function isRtcDiagnosticMessage(message: any): boolean {
    return message?.kind === 'diagnostic';
}

function toStoredRtcDiagnostic(message: any, interaction: any, connectionName: string): any {
    return {
        kind: 'diagnostic',
        topic: message.topic,
        severity: message.severity ?? (message.error ? 'error' : 'info'),
        atEpochMs: message.atEpochMs ?? Date.now(),
        connection: message.connection ?? connectionName,
        provider: message.provider ?? interaction.request.provider,
        actor: message.actor ?? interaction.request.actor,
        peerId: message.peerId ?? interaction.request.peerId,
        remotePeerId: message.remotePeerId ?? interaction.request.remotePeerId,
        roomId: message.roomId ?? interaction.request.roomId,
        roomRef: message.roomRef ?? interaction.request.roomRef,
        scope: message.scope ?? interaction.request.scope,
        applicationId: message.applicationId ?? interaction.request.applicationId,
        workspaceId: message.workspaceId ?? interaction.request.workspaceId,
        groupId: message.groupId ?? interaction.request.groupId,
        overlayId: message.overlayId ?? interaction.request.overlayId,
        data: message.data,
        error: message.error,
        event: message,
    };
}

export function createRtcProviderFromClientFactory(options: RtcClientProviderOptions): RtcProvider {
    return {
        connect: async (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const connectStartedAtEpochMs = Date.now();

            try {
                const client = await options.createClient(interaction.request, config, context);

                client.onMessage?.((message: any) => {
                    if (isRtcDiagnosticMessage(message)) {
                        rememberRtcDiagnostic(
                            connectionName,
                            toStoredRtcDiagnostic(message, interaction, connectionName),
                            context,
                        );
                    }

                    rememberRtcMessage(connectionName, {
                        data: message,
                        receivedAtEpochMs: Date.now(),
                        provider: interaction.request.provider,
                        actor: interaction.request.actor,
                        roomId: interaction.request.roomId,
                        roomRef: message?.roomRef ?? interaction.request.roomRef,
                        scope: message?.scope ?? interaction.request.scope,
                        applicationId: message?.applicationId ?? interaction.request.applicationId,
                        workspaceId: message?.workspaceId ?? interaction.request.workspaceId,
                    }, context);
                });

                client.onClose?.((event: any) => {
                    rememberRtcCloseEvent(
                        connectionName,
                        toStoredRtcCloseEvent(event, interaction),
                        context,
                    );
                });

                await client.connect();
                const connectedAtEpochMs = Date.now();
                const diagnostics = client.diagnostics?.();

                context.rtcConnections[connectionName] = {
                    client,
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    request: interaction.request,
                    connectStartedAtEpochMs,
                    connectedAtEpochMs,
                    connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs,
                    diagnostics,
                };

                context.rtcMessages[connectionName] = context.rtcMessages[connectionName] || [];
                context.rtcDiagnostics = context.rtcDiagnostics || {};
                context.rtcDiagnostics[connectionName] = context.rtcDiagnostics[connectionName] || [];
                context.rtcCloseEvents[connectionName] = context.rtcCloseEvents[connectionName] || [];

                return toRtcSuccessStatus(config, interaction, {
                    connection: connectionName,
                    connected: true,
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    diagnostics,
                    connectStartedAtEpochMs,
                    connectedAtEpochMs,
                    connectLatencyMs: connectedAtEpochMs - connectStartedAtEpochMs,
                });
            } catch (e) {
                const failedAtEpochMs = Date.now();
                return toRtcFailureStatus(config, interaction, 'RTC connect failed', {
                    connection: connectionName,
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    connectStartedAtEpochMs,
                    connectFailedAtEpochMs: failedAtEpochMs,
                    connectLatencyMs: failedAtEpochMs - connectStartedAtEpochMs,
                });
            }
        },

        send: async (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const connection = context.rtcConnections[connectionName];
            const client = connection?.client as RtcClient | undefined;
            const payload = toRtcPayload(interaction.request);
            let sendStartedAtEpochMs: number | undefined;

            if (!client) {
                return toRtcFailureStatus(config, interaction, 'RTC connection is not open', {
                    connection: connectionName,
                });
            }

            try {
                sendStartedAtEpochMs = Date.now();
                const sendResult = await client.send(payload, interaction, config, context);
                const sendEndedAtEpochMs = Date.now();
                const diagnostics = client.diagnostics?.();
                connection.lastSendStartedAtEpochMs = sendStartedAtEpochMs;
                connection.lastSendEndedAtEpochMs = sendEndedAtEpochMs;
                connection.lastSendLatencyMs = sendEndedAtEpochMs - sendStartedAtEpochMs;
                if (sendResult !== undefined) {
                    connection.lastSendResult = sendResult;
                }
                if (diagnostics !== undefined) {
                    connection.diagnostics = diagnostics;
                }
            } catch (e) {
                const sendFailedAtEpochMs = Date.now();
                const errorRecord = e && typeof e === 'object'
                    ? e as any
                    : {};
                const sendResult = errorRecord.sendResult ?? errorRecord.response;
                const diagnostics = errorRecord.diagnostics;
                return toRtcFailureStatus(config, interaction, 'RTC send failed', {
                    connection: connectionName,
                    sent: payload,
                    ...(sendResult !== undefined ? { sendResult } : {}),
                    ...(diagnostics !== undefined ? { diagnostics } : {}),
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    sendStartedAtEpochMs,
                    sendFailedAtEpochMs,
                    sendLatencyMs: sendStartedAtEpochMs !== undefined
                        ? sendFailedAtEpochMs - sendStartedAtEpochMs
                        : undefined,
                });
            }

            if (interaction.response?.messages) {
                return waitForRtcMessages(interaction, config, context, {
                    sentConnection: connectionName,
                    sent: payload,
                    sendResult: connection.lastSendResult,
                    sendStartedAtEpochMs: connection.lastSendStartedAtEpochMs,
                    sendEndedAtEpochMs: connection.lastSendEndedAtEpochMs,
                    sendLatencyMs: connection.lastSendLatencyMs,
                    diagnostics: connection.diagnostics,
                });
            }

            if (interaction.response?.diagnostics) {
                return waitForRtcDiagnostics(interaction, config, context, {
                    sentConnection: connectionName,
                    sent: payload,
                    sendResult: connection.lastSendResult,
                    sendStartedAtEpochMs: connection.lastSendStartedAtEpochMs,
                    sendEndedAtEpochMs: connection.lastSendEndedAtEpochMs,
                    sendLatencyMs: connection.lastSendLatencyMs,
                    diagnostics: connection.diagnostics,
                });
            }

            if (interaction.response?.diagnostic) {
                return waitForRtcDiagnostic(interaction, config, context, {
                    sentConnection: connectionName,
                    sent: payload,
                    sendResult: connection.lastSendResult,
                    sendStartedAtEpochMs: connection.lastSendStartedAtEpochMs,
                    sendEndedAtEpochMs: connection.lastSendEndedAtEpochMs,
                    sendLatencyMs: connection.lastSendLatencyMs,
                    diagnostics: connection.diagnostics,
                });
            }

            if (interaction.response?.health !== undefined) {
                return waitForRtcHealth(interaction, config, context, {
                    sentConnection: connectionName,
                    sent: payload,
                    sendResult: connection.lastSendResult,
                    sendStartedAtEpochMs: connection.lastSendStartedAtEpochMs,
                    sendEndedAtEpochMs: connection.lastSendEndedAtEpochMs,
                    sendLatencyMs: connection.lastSendLatencyMs,
                    diagnostics: connection.diagnostics,
                });
            }

            if (interaction.response?.message) {
                return waitForRtcMessage(interaction, config, context, {
                    sentConnection: connectionName,
                    sent: payload,
                    sendResult: connection.lastSendResult,
                    sendStartedAtEpochMs: connection.lastSendStartedAtEpochMs,
                    sendEndedAtEpochMs: connection.lastSendEndedAtEpochMs,
                    sendLatencyMs: connection.lastSendLatencyMs,
                    diagnostics: connection.diagnostics,
                });
            }

            return toRtcSuccessStatus(config, interaction, {
                connection: connectionName,
                sent: payload,
                provider: interaction.request.provider,
                actor: interaction.request.actor,
                roomId: interaction.request.roomId,
                sendResult: connection.lastSendResult,
                sendStartedAtEpochMs: connection.lastSendStartedAtEpochMs,
                sendEndedAtEpochMs: connection.lastSendEndedAtEpochMs,
                sendLatencyMs: connection.lastSendLatencyMs,
                diagnostics: connection.diagnostics,
            });
        },

        wait: async (interaction: any, config: any, context: any): Promise<any> => {
            if (interaction.response?.close !== undefined) {
                return waitForRtcClose(interaction, config, context);
            }

            if (interaction.response?.diagnostics) {
                return waitForRtcDiagnostics(interaction, config, context);
            }

            if (interaction.response?.diagnostic) {
                return waitForRtcDiagnostic(interaction, config, context);
            }

            if (interaction.response?.health !== undefined) {
                return waitForRtcHealth(interaction, config, context);
            }

            if (interaction.response?.messages) {
                return waitForRtcMessages(interaction, config, context);
            }

            if (interaction.response?.message) {
                return waitForRtcMessage(interaction, config, context);
            }

            return toRtcFailureStatus(config, interaction, 'RTC wait expects expect.message, expect.messages, expect.diagnostic, expect.diagnostics, expect.health, or expect.close', {
                connection: toRtcExpectedConnectionName(interaction),
            });
        },

        close: async (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const connection = context.rtcConnections[connectionName];
            const client = connection?.client as RtcClient | undefined;

            try {
                if (client) {
                    await client.close(interaction, config, context);
                    delete context.rtcConnections[connectionName];
                }
            } catch (e) {
                return toRtcFailureStatus(config, interaction, 'RTC close failed', {
                    connection: connectionName,
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                });
            }

            rememberRtcCloseEvent(connectionName, {
                closeRequested: true,
                closed: client !== undefined,
                closedAtEpochMs: Date.now(),
                provider: interaction.request.provider,
                actor: interaction.request.actor,
                roomId: interaction.request.roomId,
            }, context);

            return toRtcSuccessStatus(config, interaction, {
                connection: connectionName,
                closeRequested: true,
                closed: client !== undefined,
                provider: interaction.request.provider,
                actor: interaction.request.actor,
                roomId: interaction.request.roomId,
            });
        },
    };
}
