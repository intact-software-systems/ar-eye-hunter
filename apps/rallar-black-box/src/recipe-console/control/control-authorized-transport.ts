import type { AuthSession } from '@shared/api/api-config.ts';
import {
    type BlackBoxControlTokenSession,
    resolveBlackBoxControlToken,
    shouldRefreshBlackBoxControlToken,
} from '../../control-operator-token.ts';
import {
    type ControlRunManagerFetch,
    ControlRunManagerHttpError,
} from '../../control-run-manager.ts';
import type { RecipeConsoleControlCredentialPolicy } from './control-credential-policy.ts';
import {
    controlAuthorizationErrorMessage,
    RecipeConsoleControlAuthorizationError,
    RecipeConsoleControlCredentialTrustError,
} from './control-authorization-errors.ts';
import {
    controlFetchWithAuthorization,
    controlFetchWithSignal,
    isControlAbortError,
    throwIfControlAborted,
} from './control-authorized-fetch.ts';

export type RecipeConsoleControlAuthorization = 'anonymous' | 'manual' | 'brokered';
export type AuthorizedControlResult<Value> = Readonly<{
    value: Value;
    authorization: RecipeConsoleControlAuthorization;
}>;

export type ControlEndpointAuthorization = {
    requiresAuthorization: boolean;
    challenge?: ControlRunManagerHttpError;
};

export type ControlAuthorizedEndpoint = Readonly<{
    response<Value>(
        operation: (fetchFn: ControlRunManagerFetch) => Promise<Value>,
        signal?: AbortSignal,
    ): Promise<AuthorizedControlResult<Value>>;
}>;

export type ControlAuthorizedTransport = Readonly<{
    createEndpointAuthorization(): ControlEndpointAuthorization;
    createAuthorizedEndpoint(): ControlAuthorizedEndpoint;
    request<Value>(
        operation: (
            token: string | undefined,
            fetchFn: ControlRunManagerFetch,
        ) => Promise<Value>,
        endpoint: ControlEndpointAuthorization,
        signal?: AbortSignal,
    ): Promise<AuthorizedControlResult<Value>>;
    response<Value>(
        operation: (
            token: string | undefined,
            fetchFn: ControlRunManagerFetch,
        ) => Promise<Value>,
        endpoint: ControlEndpointAuthorization,
        signal?: AbortSignal,
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

export function createControlAuthorizedTransport(
    config: ControlAuthorizedTransportConfig,
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
                },
            });
            throwIfControlAborted(signal);
        } catch (error) {
            throwIfControlAborted(signal);
            if (
                brokerResponse &&
                !brokerResponse.ok &&
                !(error instanceof ControlRunManagerHttpError)
            ) {
                throw new ControlRunManagerHttpError(
                    controlAuthorizationErrorMessage(error),
                    brokerResponse.status,
                    brokerResponse.statusText,
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
        operation: (
            token: string | undefined,
            fetchFn: ControlRunManagerFetch,
        ) => Promise<Value>,
        endpoint: ControlEndpointAuthorization,
        signal?: AbortSignal,
    ): Promise<AuthorizedControlResult<Value>> {
        throwIfControlAborted(signal);
        const fetchFn = controlFetchWithSignal(config.fetchFn, signal);
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
            try {
                token = await resolveBrokeredToken(signal);
                throwIfControlAborted(signal);
            } catch (brokerError) {
                if (isControlAbortError(brokerError)) {
                    throw brokerError;
                }
                if (endpoint.challenge) {
                    throw new RecipeConsoleControlAuthorizationError(
                        endpoint.challenge,
                        brokerError,
                    );
                }
                throw brokerError;
            }
            authorization = 'brokered';
        }

        try {
            throwIfControlAborted(signal);
            const value = await operation(token, fetchFn);
            throwIfControlAborted(signal);
            return {
                value,
                authorization,
            };
        } catch (error) {
            throwIfControlAborted(signal);
            if (manualToken || !isAuthorizationError(error)) {
                throw error;
            }
            if (!config.credentialPolicy.allowBrokeredToken) {
                if (config.authSession || configuredManualToken) {
                    throw new RecipeConsoleControlCredentialTrustError(
                        error,
                        config.credentialPolicy.blockedMessage ??
                            'Automatic control credentials are blocked for this endpoint source.',
                    );
                }
                throw error;
            }
            if (!config.authSession) {
                throw error;
            }

            endpoint.requiresAuthorization = true;
            endpoint.challenge = error;
            if (token === undefined && brokeredToken) {
                try {
                    throwIfControlAborted(signal);
                    const value = await operation(brokeredToken.token, fetchFn);
                    throwIfControlAborted(signal);
                    return {
                        value,
                        authorization: 'brokered',
                    };
                } catch (cachedTokenError) {
                    throwIfControlAborted(signal);
                    if (
                        isControlAbortError(cachedTokenError) ||
                        !isAuthorizationError(cachedTokenError)
                    ) {
                        throw cachedTokenError;
                    }
                    endpoint.challenge = cachedTokenError;
                }
            }
            brokeredToken = undefined;
            try {
                token = await resolveBrokeredToken(signal);
                throwIfControlAborted(signal);
            } catch (brokerError) {
                if (isControlAbortError(brokerError)) {
                    throw brokerError;
                }
                throw new RecipeConsoleControlAuthorizationError(
                    endpoint.challenge ?? error,
                    brokerError,
                );
            }
            throwIfControlAborted(signal);
            const value = await operation(token, fetchFn);
            throwIfControlAborted(signal);
            return {
                value,
                authorization: 'brokered',
            };
        }
    }

    async function response<Value>(
        operation: (
            token: string | undefined,
            fetchFn: ControlRunManagerFetch,
        ) => Promise<Value>,
        endpoint: ControlEndpointAuthorization,
        signal?: AbortSignal,
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
                        },
                    ),
                endpoint,
                signal,
            );
            throwIfControlAborted(signal);
            return result;
        } catch (error) {
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
            response: (operation, signal) => response(
                (token, fetchFn) => operation(
                    controlFetchWithAuthorization(fetchFn, token),
                ),
                authorization,
                signal,
            ),
        };
    }

    return {
        createEndpointAuthorization: () => ({ requiresAuthorization: false }),
        createAuthorizedEndpoint,
        request,
        response,
    };
}

function isAuthorizationError(
    error: unknown,
): error is ControlRunManagerHttpError {
    return error instanceof ControlRunManagerHttpError &&
        (error.status === 401 || error.status === 403);
}
