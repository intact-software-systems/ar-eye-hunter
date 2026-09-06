// deno-lint-ignore-file no-explicit-any
import { compareJson, COMPARISON, toConfig } from '../../json-compare/CompareJson.ts';
import { toBoundedWsWaitMessages } from '../artifacts/with-bounded-artifact-report-results.ts';
import { toWaitCountBound } from '../expectations/wait-count-bound.ts';
import { toWsExpectedConnectionName, toWsFailureStatus, toWsSuccessStatus } from './ws-interaction-statuses.ts';

export {
    toWsConnectionName,
    toWsExpectedConnectionName,
    toWsFailureStatus,
    toWsSuccessStatus
} from './ws-interaction-statuses.ts';

function toWsComparisonConfig(interaction: any): any {
    return toConfig(
        interaction.response?.comparison || COMPARISON.COMPATIBLE,
        interaction.response?.ignoreJsonKeys || [],
        interaction.response?.ignoreJsonPaths || []
    );
}

function findWsMessageIndex(
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
            message.data,
            toWsComparisonConfig(interaction)
        );

        return result.isEqual;
    });
}

function findWsMessageIndexFrom(
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
            messages[index].data,
            toWsComparisonConfig(interaction)
        );

        if (result.isEqual) {
            return index;
        }
    }

    return -1;
}

function findWsCloseEventIndex(
    closeEvents: any[],
    expectedCloseEvent: any,
    interaction: any
): number {
    return closeEvents.findIndex((closeEvent) => {
        const result = compareJson(
            expectedCloseEvent,
            closeEvent,
            toWsComparisonConfig(interaction)
        );

        return result.isEqual;
    });
}

export function waitForWsMessage(
    interaction: any,
    config: any,
    context: any,
    details: any = {}
): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsExpectedConnectionName(interaction);
    const expectedMessage = interaction.response.message;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const messages = context.wsMessages[connectionName] || [];
            const matchIndex = findWsMessageIndex(messages, expectedMessage, interaction);

            if (matchIndex >= 0) {
                clearInterval(interval);
                const match = messages[matchIndex];

                if (consume) {
                    messages.splice(matchIndex, 1);
                }

                resolve(toWsSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedMessage: match,
                    consumed: consume,
                    waitedMs: Date.now() - startedAt
                }));
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toWsFailureStatus(config, interaction, 'Expected WebSocket message was not received', {
                    ...details,
                    connection: connectionName,
                    expectedMessage,
                    ...toBoundedWsWaitMessages(messages),
                    waitedMs: Date.now() - startedAt
                }));
            }
        }, 25);
    });
}

export function waitForWsMessages(
    interaction: any,
    config: any,
    context: any,
    details: any = {}
): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsExpectedConnectionName(interaction);
    const expectedMessages = interaction.response.messages;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;
    const ordered = interaction.response.ordered === true;

    if (!Array.isArray(expectedMessages) || expectedMessages.length <= 0) {
        return Promise.resolve(
            toWsFailureStatus(config, interaction, 'Expected WebSocket messages must be a non-empty array', {
                ...details,
                connection: connectionName,
                expectedMessages
            })
        );
    }

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const messages = context.wsMessages[connectionName] || [];
            const matchedMessages: any[] = [];
            const matchedIndexes: number[] = [];

            let nextOrderedSearchIndex = 0;

            for (const expectedMessage of expectedMessages) {
                const matchIndex = ordered
                    ? findWsMessageIndexFrom(
                        messages,
                        expectedMessage,
                        interaction,
                        nextOrderedSearchIndex,
                        matchedIndexes
                    )
                    : findWsMessageIndex(messages, expectedMessage, interaction, matchedIndexes);

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

                resolve(toWsSuccessStatus(config, interaction, {
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
                resolve(toWsFailureStatus(
                    config,
                    interaction,
                    ordered
                        ? 'Expected WebSocket messages were not received in the expected order'
                        : 'Expected WebSocket messages were not received',
                    {
                        ...details,
                        connection: connectionName,
                        expectedMessages,
                        matchedMessages,
                        missingMessages: expectedMessages.filter((expectedMessage: any) => {
                            return matchedMessages.every((match) => match.expectedMessage !== expectedMessage);
                        }),
                        ordered,
                        ...toBoundedWsWaitMessages(messages),
                        waitedMs: Date.now() - startedAt
                    }
                ));
            }
        }, 25);
    });
}

export function waitForWsClose(
    interaction: any,
    config: any,
    context: any,
    details: any = {}
): Promise<any> {
    const request = interaction.request;
    const connectionName = toWsExpectedConnectionName(interaction);
    const expectedClose = interaction.response.close === true
        ? {}
        : interaction.response.close;
    const timeoutMs = Number.parseInt(interaction.response.withinMs || request.timeoutMs || 5000);
    const startedAt = Date.now();
    const consume = interaction.response.consume === true;

    if (expectedClose === undefined) {
        return Promise.resolve(
            toWsFailureStatus(config, interaction, 'WebSocket close expectation is missing. Use expect.close.', {
                ...details,
                connection: connectionName
            })
        );
    }

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const closeEvents = context.wsCloseEvents[connectionName] || [];
            const matchIndex = findWsCloseEventIndex(closeEvents, expectedClose, interaction);

            if (matchIndex >= 0) {
                clearInterval(interval);
                const match = closeEvents[matchIndex];

                if (consume) {
                    closeEvents.splice(matchIndex, 1);
                }

                resolve(toWsSuccessStatus(config, interaction, {
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
                resolve(toWsFailureStatus(config, interaction, 'Expected WebSocket close event was not received', {
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

export interface WaitForWsMessageCountInput {
    readonly interaction: any;
    readonly config: any;
    readonly context: any;
    readonly details?: any;
}

function countMatchingWsMessages(messages: any[], expectedMessage: any, interaction: any): number {
    return messages.filter((message) =>
        compareJson(expectedMessage, message.data, toWsComparisonConfig(interaction)).isEqual
    ).length;
}

/**
 * Cardinality over the whole window. `waitForWsMessage` resolves on the first
 * match, which cannot distinguish "exactly one" from "at least one" -- so this
 * always waits the full `withinMs` before counting, the same reason
 * `waitForWsMessageAbsence` does.
 */
export function waitForWsMessageCount(input: WaitForWsMessageCountInput): Promise<any> {
    const { interaction, config, context } = input;
    const details = input.details ?? {};
    const connectionName = toWsExpectedConnectionName(interaction);
    const expectedMessage = interaction.response.message;
    const bound = toWaitCountBound(interaction.response.count);
    const windowMs = Number.parseInt(
        interaction.response.withinMs || interaction.request.timeoutMs || 5000
    );
    const startedAt = Date.now();

    if (expectedMessage === undefined || expectedMessage === null) {
        return Promise.resolve(toWsFailureStatus(
            config,
            interaction,
            'WebSocket count wait expects expect.message to match frames against.',
            { ...details, connection: connectionName }
        ));
    }

    if (bound === undefined) {
        return Promise.resolve(toWsFailureStatus(
            config,
            interaction,
            'WebSocket count wait expects expect.count to be a non-negative integer or {min,max}.',
            { ...details, connection: connectionName, count: interaction.response.count }
        ));
    }

    return new Promise((resolve) => {
        setTimeout(() => {
            const messages = context.wsMessages[connectionName] || [];
            const matchedCount = countMatchingWsMessages(messages, expectedMessage, interaction);
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
                    ? toWsSuccessStatus(config, interaction, reported)
                    : toWsFailureStatus(
                        config,
                        interaction,
                        'WebSocket message count did not match the expectation',
                        reported
                    )
            );
        }, windowMs);
    });
}

export interface WaitForWsMessageAbsenceInput {
    readonly interaction: any;
    readonly config: any;
    readonly context: any;
    readonly details?: any;
}

export function waitForWsMessageAbsence(input: WaitForWsMessageAbsenceInput): Promise<any> {
    const { interaction, config, context } = input;
    const details = input.details ?? {};
    const connectionName = toWsExpectedConnectionName(interaction);
    const absentMessage = interaction.response.absent;
    const windowMs = Number.parseInt(
        interaction.response.withinMs || interaction.request.timeoutMs || 5000
    );
    const startedAt = Date.now();

    if (absentMessage === undefined || absentMessage === null) {
        return Promise.resolve(toWsFailureStatus(
            config,
            interaction,
            'WebSocket absence wait expects expect.absent to be a partial message matcher.',
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
            const messages = context.wsMessages[connectionName] || [];
            const matchIndex = findWsMessageIndex(messages, absentMessage, interaction);

            if (matchIndex >= 0) {
                resolve(toWsFailureStatus(
                    config,
                    interaction,
                    'WebSocket message expected to be absent was received',
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

            resolve(toWsSuccessStatus(config, interaction, {
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
