// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../json-compare/CompareJson.ts';

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

export type RtcProvider = {
    connect: (interaction: any, config: any, context: any) => Promise<any>
    send: (interaction: any, config: any, context: any) => Promise<any>
    wait: (interaction: any, config: any, context: any) => Promise<any>
    close: (interaction: any, config: any, context: any) => Promise<any>
}

export type RtcClient = {
    connect: () => Promise<void>
    send: (message: any, interaction?: any, config?: any, context?: any) => Promise<void>
    close: (interaction?: any, config?: any, context?: any) => Promise<void>
    onMessage?: (handler: (message: any) => void) => void
    onClose?: (handler: (event: any) => void) => void
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
        groupId: interaction.request.groupId,
        overlayId: interaction.request.overlayId,
        remotePeerId: interaction.request.remotePeerId,
        action: interaction.request.action,
        connection: interaction.request.connection,
    };
}

export function toRtcFailureStatus(config: any, interaction: any, result: string, details: any = {}): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        result,
        transport: 'RTC',
        ...toRtcReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toRtcReportFields(interaction),
            ...details,
        },
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
        ...toRtcReportFields(interaction),
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: {
            ...toRtcReportFields(interaction),
            ...details,
        },
        output: interaction.request.output,
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

export function rememberRtcCloseEvent(connectionName: string, closeEvent: any, context: any): void {
    if (!context.rtcCloseEvents[connectionName]) {
        context.rtcCloseEvents[connectionName] = [];
    }

    context.rtcCloseEvents[connectionName].push(closeEvent);
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

export function createRtcProviderFromClientFactory(options: RtcClientProviderOptions): RtcProvider {
    return {
        connect: async (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);

            try {
                const client = await options.createClient(interaction.request, config, context);

                client.onMessage?.((message: any) => {
                    rememberRtcMessage(connectionName, {
                        data: message,
                        receivedAtEpochMs: Date.now(),
                        provider: interaction.request.provider,
                        actor: interaction.request.actor,
                        roomId: interaction.request.roomId,
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

                context.rtcConnections[connectionName] = {
                    client,
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                    request: interaction.request,
                    connectedAtEpochMs: Date.now(),
                };

                context.rtcMessages[connectionName] = context.rtcMessages[connectionName] || [];
                context.rtcCloseEvents[connectionName] = context.rtcCloseEvents[connectionName] || [];

                return toRtcSuccessStatus(config, interaction, {
                    connection: connectionName,
                    connected: true,
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                });
            } catch (e) {
                return toRtcFailureStatus(config, interaction, 'RTC connect failed', {
                    connection: connectionName,
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                });
            }
        },

        send: async (interaction: any, config: any, context: any): Promise<any> => {
            const connectionName = toRtcConnectionName(interaction.request);
            const connection = context.rtcConnections[connectionName];
            const client = connection?.client as RtcClient | undefined;
            const payload = toRtcPayload(interaction.request);

            if (!client) {
                return toRtcFailureStatus(config, interaction, 'RTC connection is not open', {
                    connection: connectionName,
                });
            }

            try {
                await client.send(payload, interaction, config, context);
            } catch (e) {
                return toRtcFailureStatus(config, interaction, 'RTC send failed', {
                    connection: connectionName,
                    sent: payload,
                    exception: e instanceof Error ? e.message : String(e),
                    provider: interaction.request.provider,
                    actor: interaction.request.actor,
                    roomId: interaction.request.roomId,
                });
            }

            if (interaction.response?.messages) {
                return waitForRtcMessages(interaction, config, context, {
                    sentConnection: connectionName,
                    sent: payload,
                });
            }

            if (interaction.response?.message) {
                return waitForRtcMessage(interaction, config, context, {
                    sentConnection: connectionName,
                    sent: payload,
                });
            }

            return toRtcSuccessStatus(config, interaction, {
                connection: connectionName,
                sent: payload,
                provider: interaction.request.provider,
                actor: interaction.request.actor,
                roomId: interaction.request.roomId,
            });
        },

        wait: async (interaction: any, config: any, context: any): Promise<any> => {
            if (interaction.response?.close !== undefined) {
                return waitForRtcClose(interaction, config, context);
            }

            if (interaction.response?.messages) {
                return waitForRtcMessages(interaction, config, context);
            }

            if (interaction.response?.message) {
                return waitForRtcMessage(interaction, config, context);
            }

            return toRtcFailureStatus(config, interaction, 'RTC wait expects expect.message, expect.messages, or expect.close', {
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
