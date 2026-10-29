import { Either } from '@shared/resilience/Either.ts';

import { tryResolvePath } from '../execution/black-box-value-resolution.ts';
import {
    toWaitCountBound,
    type WaitCountBound
} from '../expectations/wait-count-bound.ts';
import {
    toWsFailureStatus,
    toWsSuccessStatus
} from './ws-interaction-statuses.ts';
import {
    finishWsObservationWindow,
    hasCompleteWsObservations,
    matchesWsMessage,
    startWsWaitWindow,
    type WsInteractionResult,
    type WsMessageObservation,
    type WsWaitInput,
    type WsWaitWindow
} from './ws-wait-expectations.ts';

/** A matched frame that carries no value at `expect.countDistinctBy`, so its publication cannot be told apart. */
interface WsCountMissingIdentity {
    readonly frameIndex: number;
}

/**
 * Waits the full window, then counts the frames matching `expect.message`, or with `expect.countDistinctBy` the
 * distinct publications among them, against `expect.count`.
 */
export async function waitForWsMessageCount(input: WsWaitInput): Promise<WsInteractionResult> {
    const { interaction, config } = input;
    const window = startWsWaitWindow(input);
    return await toWsCountBound(input, window).fold(
        async (result) =>
            toWsFailureStatus({
                config,
                interaction,
                result,
                details: { ...input.details, connection: window.connectionName }
            }),
        async (bound) => {
            await finishWsObservationWindow(input, window);
            return completeWsCount(input, window, bound);
        }
    );
}

/** The count bound to judge against, or why the expectation is refused before the window opens. */
function toWsCountBound(input: WsWaitInput, window: WsWaitWindow): Either<string, WaitCountBound> {
    const response = input.interaction.response;
    if (response?.message === undefined || response.message === null) {
        return Either.ofLeft('WebSocket count wait expects expect.message to match frames against.');
    }
    const bound = toWaitCountBound(response.count);
    if (bound === undefined) {
        return Either.ofLeft('WebSocket count wait expects expect.count to be a non-negative integer or {min,max}.');
    }
    const countDistinctBy = response.countDistinctBy;
    if (countDistinctBy !== undefined && (typeof countDistinctBy !== 'string' || countDistinctBy.length === 0)) {
        return Either.ofLeft('WebSocket count wait expects expect.countDistinctBy to be a non-empty JSON path.');
    }
    if (!Number.isFinite(window.timeoutMs) || window.timeoutMs <= 0) {
        return Either.ofLeft('WebSocket count duration must be positive');
    }
    return Either.ofRight(bound);
}

function completeWsCount(input: WsWaitInput, window: WsWaitWindow, bound: WaitCountBound): WsInteractionResult {
    const { interaction, config, context } = input;
    const messages = context.wsMessages[window.connectionName] ?? [];
    const matched = messages.filter((message) => matchesWsMessage(interaction.response?.message, message, interaction));
    const matchedCount = computeWsMatchedCount(matched, interaction.response?.countDistinctBy);
    const details = {
        ...input.details,
        connection: window.connectionName,
        expectedMessage: interaction.response?.message,
        expectedCount: interaction.response?.count,
        matchedCount: matchedCount.right,
        matchedFrameCount: matched.length,
        observedMessageCount: messages.length,
        waitedMs: input.context.dependencies.now() - window.startedAt
    };
    if (!hasCompleteWsObservations(input, window)) {
        const result = 'WebSocket count cannot be established because observations were discarded';
        return toWsFailureStatus({ config, interaction, result, details });
    }
    return matchedCount.fold(
        (missing) =>
            toWsFailureStatus({
                config,
                interaction,
                result: 'WebSocket count wait found a matched frame without a value at expect.countDistinctBy.',
                details: { ...details, missingIdentityFrameIndex: missing.frameIndex }
            }),
        (count) =>
            count >= bound.min && count <= bound.max
                ? toWsSuccessStatus(config, interaction, details)
                : toWsFailureStatus({
                    config,
                    interaction,
                    result: 'WebSocket message count did not match the expectation',
                    details
                })
    );
}

/** The matched frames, or with an identity path the distinct identities among them. */
function computeWsMatchedCount(
    matched: readonly WsMessageObservation[],
    countDistinctBy: string | undefined
): Either<WsCountMissingIdentity, number> {
    if (countDistinctBy === undefined) {
        return Either.ofRight(matched.length);
    }
    const identities = matched.map((message) => tryResolvePath(countDistinctBy, message.data));
    const frameIndex = identities.findIndex((identity) => !identity.found);
    if (frameIndex >= 0) {
        return Either.ofLeft({ frameIndex });
    }
    return Either.ofRight(new Set(identities.map((identity) => JSON.stringify(identity.value))).size);
}
