export interface WsOpenCloseEvent {
    readonly code?: number;
    readonly reason?: string;
}

export interface WsOpenExpectation {
    /** True when the recipe asserts the upgrade is refused rather than accepted. */
    readonly rejected?: boolean;
    readonly close?: WsOpenCloseEvent;
}

/**
 * How the open ended. `refused` is the only outcome that demonstrates the
 * server declined the upgrade: a timeout or a transport error is a server that
 * never answered, which is not the same claim and must not satisfy `rejected`.
 */
export type WsOpenOutcome = 'opened' | 'refused' | 'timedOut' | 'errored';

export interface ResolveWsOpenExpectationInput {
    readonly expectation: WsOpenExpectation;
    readonly outcome: WsOpenOutcome;
    readonly close: WsOpenCloseEvent | undefined;
}

export interface WsOpenExpectationResult {
    readonly satisfied: boolean;
    readonly message?: string;
}

function toCloseMismatch(
    expected: WsOpenCloseEvent,
    actual: WsOpenCloseEvent | undefined
): string | undefined {
    if (expected.code !== undefined && actual?.code !== expected.code) {
        return `close code ${actual?.code ?? 'none'}, expected ${expected.code}`;
    }

    if (expected.reason !== undefined && actual?.reason !== expected.reason) {
        return `close reason ${actual?.reason === undefined ? 'none' : JSON.stringify(actual.reason)}, expected ${
            JSON.stringify(expected.reason)
        }`;
    }

    return undefined;
}

/**
 * Decides an open against its expectation. Without `rejected` the outcome is
 * its own verdict, which keeps every existing recipe unchanged; with it, a
 * refused upgrade is the assertion and an accepted one is the failure.
 *
 * Kept pure and separate from the socket so the negative paths are testable
 * without standing up a server that refuses connections.
 */
export function resolveWsOpenExpectation(
    input: ResolveWsOpenExpectationInput
): WsOpenExpectationResult {
    if (input.expectation.rejected !== true) {
        return { satisfied: input.outcome === 'opened' };
    }

    if (input.outcome === 'opened') {
        return { satisfied: false, message: 'WebSocket upgrade was expected to be rejected but opened' };
    }

    if (input.outcome !== 'refused') {
        return {
            satisfied: false,
            message: input.outcome === 'timedOut'
                ? 'WebSocket upgrade was expected to be rejected but the server never answered'
                : 'WebSocket upgrade was expected to be rejected but the transport failed before any refusal'
        };
    }

    const mismatch = input.expectation.close === undefined
        ? undefined
        : toCloseMismatch(input.expectation.close, input.close);

    return mismatch === undefined
        ? { satisfied: true }
        : { satisfied: false, message: `WebSocket upgrade was rejected with ${mismatch}` };
}
