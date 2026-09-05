export interface WsOpenCloseEvent {
    readonly code?: number;
    readonly reason?: string;
}

export interface WsOpenExpectation {
    /** True when the recipe asserts the upgrade is refused rather than accepted. */
    readonly rejected?: boolean;
    readonly close?: WsOpenCloseEvent;
}

export interface ResolveWsOpenExpectationInput {
    readonly expectation: WsOpenExpectation;
    readonly opened: boolean;
    readonly close: WsOpenCloseEvent | undefined;
}

export interface WsOpenExpectationResult {
    readonly satisfied: boolean;
    readonly message?: string;
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
        return { satisfied: input.opened };
    }

    if (input.opened) {
        return { satisfied: false, message: 'WebSocket upgrade was expected to be rejected but opened' };
    }

    const expectedCode = input.expectation.close?.code;
    if (expectedCode === undefined) {
        return { satisfied: true };
    }

    if (input.close?.code === expectedCode) {
        return { satisfied: true };
    }

    return {
        satisfied: false,
        message: `WebSocket upgrade was rejected with close code ${
            input.close?.code ?? 'none'
        }, expected ${expectedCode}`
    };
}
