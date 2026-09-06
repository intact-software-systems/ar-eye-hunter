import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import { compareJson, COMPARISON, toConfig } from '../../json-compare/compare-json-values.ts';
import { toBoundedWsWaitMessages } from '../artifacts/with-bounded-artifact-report-results.ts';
import type { LocalWsRequest } from '../execution/local-websocket-session.ts';
import { toWaitCountBound, type WaitCountBound } from '../expectations/wait-count-bound.ts';
import { toWsExpectedConnectionName, toWsFailureStatus, toWsSuccessStatus } from './ws-interaction-statuses.ts';

export interface WsInteractionRequest extends LocalWsRequest {
    readonly action?: string;
    readonly expectConnection?: string;
    readonly send?: unknown;
    readonly message?: unknown;
    readonly body?: unknown;
    readonly protocols?: string | readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
}

export interface WsInteractionResponse {
    readonly rejected?: boolean;
    readonly connection?: string;
    readonly onConnection?: string;
    readonly withinMs?: number | string;
    readonly consume?: boolean;
    readonly ordered?: boolean;
    readonly message?: unknown;
    readonly messages?: readonly unknown[];
    readonly count?: ApiJsonValue;
    readonly absent?: unknown;
    readonly close?: unknown;
    readonly comparison?: string;
    readonly ignoreJsonKeys?: readonly string[];
    readonly ignoreJsonPaths?: readonly string[];
}

export interface WsInteraction {
    readonly request: WsInteractionRequest;
    readonly response?: WsInteractionResponse;
}

export interface WsMessageObservation {
    readonly data: unknown;
}

export interface WsWaitContext {
    readonly wsMessages: Record<string, WsMessageObservation[] | undefined>;
    readonly wsCloseEvents?: Record<string, unknown[] | undefined>;
    wsObservationLoss?: Record<string, number>;
}

export interface WsWaitInput {
    readonly interaction: WsInteraction;
    readonly config: unknown;
    readonly context: WsWaitContext;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly observeCloseEvents?: boolean;
}

export interface WsInteractionResult {
    readonly status: 'SUCCESS' | 'FAILURE';
    readonly actual: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
}

function matchesWsValue(expected: unknown, actual: unknown, interaction: WsInteraction): boolean {
    return compareJson(
        expected,
        actual,
        toConfig(
            interaction.response?.comparison ?? COMPARISON.COMPATIBLE,
            [...(interaction.response?.ignoreJsonKeys ?? [])],
            [...(interaction.response?.ignoreJsonPaths ?? [])]
        )
    ).isEqual;
}

interface WsWaitWindow {
    readonly connectionName: string;
    readonly startedAt: number;
    readonly timeoutMs: number;
    readonly observationLoss: number;
    readonly closeEventCount: number;
}

function startWsWaitWindow(input: WsWaitInput): WsWaitWindow {
    const connectionName = toWsExpectedConnectionName(input.interaction);
    return {
        connectionName,
        startedAt: Date.now(),
        timeoutMs: Number(input.interaction.response?.withinMs ?? input.interaction.request.timeoutMs ?? 5000),
        observationLoss: input.context.wsObservationLoss?.[connectionName] ?? 0,
        closeEventCount: input.context.wsCloseEvents?.[connectionName]?.length ?? 0
    };
}

function consumeWsMessages(input: WsWaitInput, connectionName: string, indexes: readonly number[]): void {
    if (!input.interaction.response?.consume || indexes.length === 0) {
        return;
    }
    const messages = input.context.wsMessages[connectionName] ?? [];
    input.context.wsMessages[connectionName] = messages.filter((_, index) => !indexes.includes(index));
    const loss = input.context.wsObservationLoss ??= {};
    loss[connectionName] = (loss[connectionName] ?? 0) + indexes.length;
}

export async function waitForWsMessageCount(input: WsWaitInput): Promise<WsInteractionResult> {
    const { interaction, config } = input;
    const window = startWsWaitWindow(input);
    const bound = toWaitCountBound(interaction.response?.count);
    const details = { ...input.details, connection: window.connectionName };
    if (interaction.response?.message === undefined || interaction.response.message === null) {
        return toWsFailureStatus(
            config,
            interaction,
            'WebSocket count wait expects expect.message to match frames against.',
            details
        );
    }
    if (bound === undefined) {
        return toWsFailureStatus(
            config,
            interaction,
            'WebSocket count wait expects expect.count to be a non-negative integer or {min,max}.',
            details
        );
    }
    if (!Number.isFinite(window.timeoutMs) || window.timeoutMs <= 0) {
        return toWsFailureStatus(config, interaction, 'WebSocket count duration must be positive', details);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, window.timeoutMs));
    return completeWsCount(input, window, bound);
}

function completeWsCount(input: WsWaitInput, window: WsWaitWindow, bound: WaitCountBound): WsInteractionResult {
    const { interaction, config, context } = input;
    const messages = context.wsMessages[window.connectionName] ?? [];
    const matchedCount =
        messages.filter((message) => matchesWsValue(interaction.response?.message, message.data, interaction)).length;
    const details = {
        ...input.details,
        connection: window.connectionName,
        expectedMessage: interaction.response?.message,
        expectedCount: interaction.response?.count,
        matchedCount,
        observedMessageCount: messages.length,
        waitedMs: Date.now() - window.startedAt
    };
    if (!hasCompleteWsObservations(input, window)) {
        return toWsFailureStatus(
            config,
            interaction,
            'WebSocket count cannot be established because observations were discarded',
            details
        );
    }
    return matchedCount >= bound.min && matchedCount <= bound.max
        ? toWsSuccessStatus(config, interaction, details)
        : toWsFailureStatus(config, interaction, 'WebSocket message count did not match the expectation', details);
}

function hasCompleteWsObservations(input: WsWaitInput, window: WsWaitWindow): boolean {
    const currentLoss = input.context.wsObservationLoss?.[window.connectionName] ?? 0;
    return currentLoss === window.observationLoss && Number.isSafeInteger(currentLoss) &&
        currentLoss < Number.MAX_SAFE_INTEGER &&
        (input.observeCloseEvents !== true ||
            (input.context.wsCloseEvents?.[window.connectionName]?.length ?? 0) === window.closeEventCount);
}

export function waitForWsMessage(input: WsWaitInput): Promise<WsInteractionResult> {
    const { interaction, config, context, details = {} } = input;
    const window = startWsWaitWindow(input);
    const { connectionName, startedAt, timeoutMs } = window;
    const expectedMessage = interaction.response?.message;
    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const messages = context.wsMessages[connectionName] ?? [];
            const index = messages.findIndex((message) => matchesWsValue(expectedMessage, message.data, interaction));
            if (index >= 0) {
                clearInterval(interval);
                const matchedMessage = messages[index];
                consumeWsMessages(input, connectionName, [index]);
                resolve(toWsSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedMessage,
                    consumed: interaction.response?.consume === true,
                    waitedMs: Date.now() - startedAt
                }));
            }
            else if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toWsFailureStatus(config, interaction, 'Expected WebSocket message was not received', {
                    ...details,
                    connection: connectionName,
                    expectedMessage,
                    ...toBoundedWsWaitMessages(messages.map((message) => ({ ...message }))),
                    waitedMs: Date.now() - startedAt
                }));
            }
        }, 25);
    });
}

interface WsMessageMatch {
    readonly expectedMessage: unknown;
    readonly matchedMessage: WsMessageObservation;
}

interface WsMessageMatches {
    readonly matchedMessages: readonly WsMessageMatch[];
    readonly matchedIndexes: readonly number[];
    readonly missingMessages: readonly unknown[];
}

interface WsMessageMatchInput {
    readonly messages: readonly WsMessageObservation[];
    readonly expectedMessages: readonly unknown[];
    readonly interaction: WsInteraction;
}

function computeWsMessageMatches(input: WsMessageMatchInput): WsMessageMatches {
    const matchedMessages: WsMessageMatch[] = [];
    const matchedIndexes: number[] = [];
    const missingMessages: unknown[] = [];
    let nextIndex = 0;
    for (const expectedMessage of input.expectedMessages) {
        const index = input.messages.findIndex((message, index) =>
            index >= nextIndex && !matchedIndexes.includes(index) &&
            matchesWsValue(expectedMessage, message.data, input.interaction)
        );
        if (index < 0) {
            missingMessages.push(expectedMessage);
            if (input.interaction.response?.ordered) {
                nextIndex = input.messages.length;
            }
            continue;
        }
        matchedIndexes.push(index);
        matchedMessages.push({ expectedMessage, matchedMessage: input.messages[index]! });
        if (input.interaction.response?.ordered) {
            nextIndex = index + 1;
        }
    }
    return { matchedMessages, matchedIndexes, missingMessages };
}

export function waitForWsMessages(input: WsWaitInput): Promise<WsInteractionResult> {
    const { interaction, config, context, details = {} } = input;
    const { connectionName, startedAt, timeoutMs } = startWsWaitWindow(input);
    const expectedMessages = interaction.response?.messages;
    if (!Array.isArray(expectedMessages) || expectedMessages.length === 0) {
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
            const messages = context.wsMessages[connectionName] ?? [];
            const matches = computeWsMessageMatches({ messages, expectedMessages, interaction });
            const common = {
                ...details,
                connection: connectionName,
                matchedMessages: matches.matchedMessages,
                ordered: interaction.response?.ordered === true,
                waitedMs: Date.now() - startedAt
            };
            if (matches.missingMessages.length === 0) {
                clearInterval(interval);
                consumeWsMessages(input, connectionName, matches.matchedIndexes);
                resolve(
                    toWsSuccessStatus(config, interaction, {
                        ...common,
                        consumed: interaction.response?.consume === true
                    })
                );
            }
            else if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(interval);
                resolve(toWsFailureStatus(
                    config,
                    interaction,
                    interaction.response?.ordered
                        ? 'Expected WebSocket messages were not received in the expected order'
                        : 'Expected WebSocket messages were not received',
                    {
                        ...common,
                        expectedMessages,
                        missingMessages: matches.missingMessages,
                        ...toBoundedWsWaitMessages(messages.map((message) => ({ ...message })))
                    }
                ));
            }
        }, 25);
    });
}

export function waitForWsClose(input: WsWaitInput): Promise<WsInteractionResult> {
    const { interaction, config, context, details = {} } = input;
    const { connectionName, startedAt, timeoutMs } = startWsWaitWindow(input);
    const expectedClose = interaction.response?.close === true ? {} : interaction.response?.close;
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
            const closeEvents = context.wsCloseEvents?.[connectionName] ?? [];
            const index = closeEvents.findIndex((event) => matchesWsValue(expectedClose, event, interaction));
            if (index >= 0) {
                clearInterval(interval);
                const matchedCloseEvent = closeEvents[index];
                if (interaction.response?.consume) {
                    closeEvents.splice(index, 1);
                    const loss = context.wsObservationLoss ??= {};
                    loss[connectionName] = (loss[connectionName] ?? 0) + 1;
                }
                resolve(toWsSuccessStatus(config, interaction, {
                    ...details,
                    connection: connectionName,
                    matchedCloseEvent,
                    consumed: interaction.response?.consume === true,
                    waitedMs: Date.now() - startedAt
                }));
            }
            else if (Date.now() - startedAt >= timeoutMs) {
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

function completeWsAbsence(input: WsWaitInput, window: WsWaitWindow): WsInteractionResult {
    const { interaction, config, context, details = {} } = input;
    const { connectionName, startedAt, observationLoss } = window;
    const messages = context.wsMessages[connectionName] ?? [];
    const absent = interaction.response?.absent;
    const matchedIndex = messages.findIndex((message) => matchesWsValue(absent, message.data, interaction));
    const common = {
        ...details,
        connection: connectionName,
        absent,
        observedMessageCount: messages.length,
        waitedMs: Date.now() - startedAt
    };
    if (matchedIndex >= 0) {
        return toWsFailureStatus(config, interaction, 'WebSocket message expected to be absent was received', {
            ...common,
            matchedMessage: messages[matchedIndex],
            matchedIndex
        });
    }
    const currentLoss = context.wsObservationLoss?.[connectionName] ?? 0;
    if (!hasCompleteWsObservations(input, window)) {
        return toWsFailureStatus(
            config,
            interaction,
            'WebSocket absence cannot be established because observations were discarded',
            {
                ...common,
                observationLossAtStart: observationLoss,
                observationLossAtEnd: currentLoss
            }
        );
    }
    return toWsSuccessStatus(config, interaction, { ...common, matchedMessage: undefined });
}

export function waitForWsMessageAbsence(input: WsWaitInput): Promise<WsInteractionResult> {
    const { interaction, config } = input;
    const window = startWsWaitWindow(input);
    if (interaction.response?.absent === undefined || interaction.response.absent === null) {
        return Promise.resolve(
            toWsFailureStatus(
                config,
                interaction,
                'WebSocket absence wait expects expect.absent to be a partial message matcher.',
                {
                    ...input.details,
                    connection: window.connectionName
                }
            )
        );
    }
    if (!Number.isFinite(window.timeoutMs) || window.timeoutMs <= 0) {
        return Promise.resolve(toWsFailureStatus(config, interaction, 'WebSocket absence duration must be positive'));
    }
    return new Promise((resolve) => {
        setTimeout(() => resolve(completeWsAbsence(input, window)), window.timeoutMs);
    });
}
