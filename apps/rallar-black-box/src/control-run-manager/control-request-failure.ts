/**
 * Why a control-server request did not produce the value its caller asked for. Every variant
 * carries the exact `message` the operator sees, so a caller folds one value instead of matching
 * error classes.
 */
export type ControlRequestFailure =
    | Readonly<{
        kind: 'http';
        status: number;
        statusText: string;
        message: string;
    }>
    | Readonly<{ kind: 'undecodable-reply'; message: string; }>
    | Readonly<{ kind: 'transfer-limit'; maxBytes: number; message: string; }>
    | Readonly<{ kind: 'unsupported-distributed-run'; message: string; }>;

/** The variant a control server answered with a status line, and the only one that carries one. */
export type ControlHttpRequestFailure = Extract<ControlRequestFailure, Readonly<{ kind: 'http'; }>>;

export function createControlHttpFailure(
    response: Response,
    message: string
): ControlHttpRequestFailure {
    return {
        kind: 'http',
        status: response.status,
        statusText: response.statusText,
        message
    };
}

export function createControlTransferLimitFailure(maxBytes: number): ControlRequestFailure {
    return {
        kind: 'transfer-limit',
        maxBytes,
        message: `Control artifact response exceeds the ${maxBytes}-byte transfer limit.`
    };
}

/**
 * The operator-visible message a failed outcome carries. A caller reads the value through
 * `outcome.right` and reaches this with `outcome.left`, which the `Either` invariant guarantees is
 * present there; the second arm names the request rather than inventing a cause.
 */
export function toControlFailureMessage(failure: ControlRequestFailure | undefined): string {
    return failure?.message ?? 'The control server request failed.';
}

/** The statuses the recipe-console transport answers by presenting or refreshing a token. */
export function isControlAuthorizationFailure(
    failure: ControlRequestFailure
): failure is ControlHttpRequestFailure {
    return failure.kind === 'http' && (failure.status === 401 || failure.status === 403);
}
