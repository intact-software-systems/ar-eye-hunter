import type { AuthSession } from '@shared/api/api-config.ts';
import { Either } from '@shared/resilience/Either.ts';
import { ControlRunManagerHttpError } from '../../control-http-error.ts';
import {
    resolveBlackBoxControlToken,
    shouldRefreshBlackBoxControlToken,
    type BlackBoxControlTokenSession
} from '../../control-operator-token.ts';
import type { ControlRunManagerFetch } from '../../control-run-manager/control-endpoint-request.ts';
import {
    isControlAuthorizationFailure,
    type ControlHttpRequestFailure,
    type ControlRequestFailure
} from '../../control-run-manager/control-request-failure.ts';
import {
    controlAuthorizationErrorMessage,
    RecipeConsoleControlAuthorizationError,
    RecipeConsoleControlCredentialTrustError
} from './control-authorization-errors.ts';
import {
    controlFetchWithAuthorization,
    controlFetchWithSignal,
    isControlAbortError,
    throwIfControlAborted
} from './control-authorized-fetch.ts';
import type { RecipeConsoleControlCredentialPolicy } from './control-credential-policy.ts';

export type RecipeConsoleControlAuthorization = 'anonymous' | 'manual' | 'brokered';
export type AuthorizedControlResult<Value> = Readonly<{
    value: Value;
    authorization: RecipeConsoleControlAuthorization;
}>;

export type ControlAuthorizedOperation<Value> = (
    token: string | undefined,
    fetchFn: ControlRunManagerFetch
) => Promise<Either<ControlRequestFailure, Value>>;

export type ControlEndpointAuthorization = {
    requiresAuthorization: boolean;
    challenge?: ControlHttpRequestFailure;
};

export type ControlAuthorizedEndpoint = Readonly<{
    response<Value>(
        operation: (
            fetchFn: ControlRunManagerFetch
        ) => Promise<Either<ControlRequestFailure, Value>>,
        signal?: AbortSignal
    ): Promise<AuthorizedControlResult<Value>>;
}>;

export type ControlAuthorizedTransport = Readonly<{
    createEndpointAuthorization(): ControlEndpointAuthorization;
    createAuthorizedEndpoint(): ControlAuthorizedEndpoint;
    request<Value>(
        operation: ControlAuthorizedOperation<Value>,
        endpoint: ControlEndpointAuthorization,
        signal?: AbortSignal
    ): Promise<AuthorizedControlResult<Value>>;
    response<Value>(
        operation: ControlAuthorizedOperation<Value>,
        endpoint: ControlEndpointAuthorization,
        signal?: AbortSignal
    ): Promise<AuthorizedControlResult<Value>>;
}>;

export type ControlAuthorizedTransportConfig = Readonly<{
    apiBaseUrl: string;
    authSession?: AuthSession;
    manualToken?: string;
    fetchFn?: ControlRunManagerFetch;
    credentialPolicy: RecipeConsoleControlCredentialPolicy;
    protocolError(error: unknown): Error;
    isProtocolCandidate(error: unknown): boolean;
}>;

/**
 * The recipe console presents a control failure as a thrown operation error: its query layer, its
 * Analyze worker boundary and its panels all read `reachable`, `authorizationRequired` and
 * `credentialTrustRequired` off an error object. This transport is the one place that translates a
 * control request failure value into that protocol, after deciding whether a token answers it.
 */
export function createControlAuthorizedTransport(
    config: ControlAuthorizedTransportConfig
): ControlAuthorizedTransport {
    const configuredManualToken = config.manualToken?.trim() || undefined;
    const manualToken = config.credentialPolicy.allowManualToken
        ? configuredManualToken
        : undefined;
    let brokeredToken: BlackBoxControlTokenSession | undefined;

    async function resolveBrokeredToken(signal?: AbortSignal): Promise<string> {
        throwIfControlAborted(signal);
        const request = controlFetchWithSignal(config.fetchFn, signal);
        let brokerResponse: Response | undefined;
        let resolved: Awaited<ReturnType<typeof resolveBlackBoxControlToken>>;
        try {
            resolved = await resolveBlackBoxControlToken({
                apiBaseUrl: config.apiBaseUrl,
                authSession: config.authSession,
                brokeredToken,
                fetchFn: async (input, init) => {
                    const response = await request(input, init);
                    brokerResponse = response;
                    return response;
                }
            });
            throwIfControlAborted(signal);
        }
        catch (error) {
            throwIfControlAborted(signal);
            if (
                brokerResponse &&
                !brokerResponse.ok &&
                !(error instanceof ControlRunManagerHttpError)
            ) {
                throw new ControlRunManagerHttpError(
                    controlAuthorizationErrorMessage(error),
                    brokerResponse.status,
                    brokerResponse.statusText
                );
            }
            throw error;
        }
        if (resolved.source !== 'brokered') {
            return resolved.token;
        }
        brokeredToken = resolved.session;
        return resolved.token;
    }

    async function request<Value>(
        operation: ControlAuthorizedOperation<Value>,
        endpoint: ControlEndpointAuthorization,
        signal?: AbortSignal
    ): Promise<AuthorizedControlResult<Value>> {
        throwIfControlAborted(signal);
        const fetchFn = controlFetchWithSignal(config.fetchFn, signal);
        const attemptWithToken = (
            token: string | undefined
        ): Promise<Either<ControlRequestFailure, Value>> => runControlOperation({ operation, token, fetchFn, signal });

        let authorization: RecipeConsoleControlAuthorization = manualToken
            ? 'manual'
            : endpoint.requiresAuthorization && brokeredToken
            ? 'brokered'
            : 'anonymous';
        let token = manualToken ?? (
            endpoint.requiresAuthorization ? brokeredToken?.token : undefined
        );

        if (
            !manualToken &&
            endpoint.requiresAuthorization &&
            brokeredToken &&
            shouldRefreshBlackBoxControlToken(brokeredToken)
        ) {
            token = await refreshTokenBeforeRequest(endpoint, signal);
            authorization = 'brokered';
        }

        const outcome = await attemptWithToken(token);
        return outcome.fold(
            (failure) =>
                answerControlFailure({
                    failure,
                    endpoint,
                    requestToken: token,
                    attemptWithToken,
                    signal
                }),
            async (value) => ({ value, authorization })
        );
    }

    async function refreshTokenBeforeRequest(
        endpoint: ControlEndpointAuthorization,
        signal: AbortSignal | undefined
    ): Promise<string> {
        try {
            const token = await resolveBrokeredToken(signal);
            throwIfControlAborted(signal);
            return token;
        }
        catch (brokerError) {
            if (isControlAbortError(brokerError) || !endpoint.challenge) {
                throw brokerError;
            }
            throw new RecipeConsoleControlAuthorizationError(
                toControlHttpError(endpoint.challenge),
                brokerError
            );
        }
    }

    async function answerControlFailure<Value>(
        input: Readonly<{
            failure: ControlRequestFailure;
            endpoint: ControlEndpointAuthorization;
            requestToken: string | undefined;
            attemptWithToken(token: string | undefined): Promise<Either<ControlRequestFailure, Value>>;
            signal: AbortSignal | undefined;
        }>
    ): Promise<AuthorizedControlResult<Value>> {
        if (manualToken || !isControlAuthorizationFailure(input.failure)) {
            throw toControlOperationError(input.failure);
        }
        if (!config.credentialPolicy.allowBrokeredToken) {
            if (config.authSession || configuredManualToken) {
                throw new RecipeConsoleControlCredentialTrustError(
                    toControlHttpError(input.failure),
                    config.credentialPolicy.blockedMessage ??
                        'Automatic control credentials are blocked for this endpoint source.'
                );
            }
            throw toControlOperationError(input.failure);
        }
        if (!config.authSession) {
            throw toControlOperationError(input.failure);
        }

        input.endpoint.requiresAuthorization = true;
        input.endpoint.challenge = input.failure;
        if (input.requestToken === undefined && brokeredToken) {
            const cached = toCachedTokenAttempt(
                await input.attemptWithToken(brokeredToken.token)
            );
            if (cached.kind === 'value') {
                return { value: cached.value, authorization: 'brokered' };
            }
            input.endpoint.challenge = cached.challenge;
        }
        brokeredToken = undefined;
        const refreshedToken = await refreshTokenAfterChallenge(
            input.endpoint.challenge ?? input.failure,
            input.signal
        );
        const retried = await input.attemptWithToken(refreshedToken);
        return retried.fold(
            (retriedFailure) => {
                throw toControlOperationError(retriedFailure);
            },
            async (value) => ({ value, authorization: 'brokered' as const })
        );
    }

    async function refreshTokenAfterChallenge(
        challenge: ControlHttpRequestFailure,
        signal: AbortSignal | undefined
    ): Promise<string> {
        try {
            const token = await resolveBrokeredToken(signal);
            throwIfControlAborted(signal);
            return token;
        }
        catch (brokerError) {
            if (isControlAbortError(brokerError)) {
                throw brokerError;
            }
            throw new RecipeConsoleControlAuthorizationError(
                toControlHttpError(challenge),
                brokerError
            );
        }
    }

    async function response<Value>(
        operation: ControlAuthorizedOperation<Value>,
        endpoint: ControlEndpointAuthorization,
        signal?: AbortSignal
    ): Promise<AuthorizedControlResult<Value>> {
        let receivedResponse = false;
        try {
            const result = await request(
                (token, fetchFn) =>
                    operation(
                        token,
                        async (input, init) => {
                            const result = await fetchFn(input, init);
                            receivedResponse = true;
                            return result;
                        }
                    ),
                endpoint,
                signal
            );
            throwIfControlAborted(signal);
            return result;
        }
        catch (error) {
            throwIfControlAborted(signal);
            if (receivedResponse && config.isProtocolCandidate(error)) {
                throw config.protocolError(error);
            }
            throw error;
        }
    }

    function createAuthorizedEndpoint(): ControlAuthorizedEndpoint {
        const authorization = { requiresAuthorization: false };
        return {
            response: (operation, signal) =>
                response(
                    (token, fetchFn) =>
                        operation(
                            controlFetchWithAuthorization(fetchFn, token)
                        ),
                    authorization,
                    signal
                )
        };
    }

    return {
        createEndpointAuthorization: () => ({ requiresAuthorization: false }),
        createAuthorizedEndpoint,
        request,
        response
    };
}

/** What a retry with the cached brokered token produced: the value, or the next challenge. */
type CachedTokenAttempt<Value> =
    | Readonly<{ kind: 'value'; value: Value; }>
    | Readonly<{ kind: 'challenge'; challenge: ControlHttpRequestFailure; }>;

function toCachedTokenAttempt<Value>(
    cached: Either<ControlRequestFailure, Value>
): CachedTokenAttempt<Value> {
    return cached.fold<CachedTokenAttempt<Value>>(
        (failure) => {
            if (!isControlAuthorizationFailure(failure)) {
                throw toControlOperationError(failure);
            }
            return { kind: 'challenge', challenge: failure };
        },
        (value) => ({ kind: 'value', value })
    );
}

async function runControlOperation<Value>(
    input: Readonly<{
        operation: ControlAuthorizedOperation<Value>;
        token: string | undefined;
        fetchFn: ControlRunManagerFetch;
        signal: AbortSignal | undefined;
    }>
): Promise<Either<ControlRequestFailure, Value>> {
    try {
        throwIfControlAborted(input.signal);
        const outcome = await input.operation(input.token, input.fetchFn);
        throwIfControlAborted(input.signal);
        return outcome;
    }
    catch (error) {
        throwIfControlAborted(input.signal);
        // Control endpoints this transport also serves - retention, and operations that validate
        // their own reply - still report an HTTP failure by throwing. Read that as the same
        // failure value so one recovery path answers both.
        if (error instanceof ControlRunManagerHttpError) {
            return Either.ofLeft({
                kind: 'http',
                status: error.status,
                statusText: error.statusText,
                message: error.message
            });
        }
        throw error;
    }
}

function toControlOperationError(failure: ControlRequestFailure): Error {
    return failure.kind === 'http'
        ? toControlHttpError(failure)
        : new Error(failure.message);
}

function toControlHttpError(failure: ControlHttpRequestFailure): ControlRunManagerHttpError {
    return new ControlRunManagerHttpError(failure.message, failure.status, failure.statusText);
}
