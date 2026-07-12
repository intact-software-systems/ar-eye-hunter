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

export type RecipeConsoleControlAuthorization = 'anonymous' | 'manual' | 'brokered';
export type AuthorizedControlResult<Value> = Readonly<{
    value: Value;
    authorization: RecipeConsoleControlAuthorization;
}>;

export type ControlEndpointAuthorization = {
    requiresAuthorization: boolean;
    challenge?: ControlRunManagerHttpError;
};

export type ControlAuthorizedTransport = Readonly<{
    createEndpointAuthorization(): ControlEndpointAuthorization;
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

class RecipeConsoleControlAuthorizationError extends Error {
    readonly reachable = true;
    readonly authorizationRequired = true;
    readonly controlStatus: number;
    readonly controlStatusText: string;
    readonly brokerStatus?: number;
    readonly brokerStatusText?: string;
    readonly brokerError: unknown;

    constructor(
        controlError: ControlRunManagerHttpError,
        brokerError: unknown,
    ) {
        super(errorMessage(brokerError));
        this.name = 'RecipeConsoleControlAuthorizationError';
        this.controlStatus = controlError.status;
        this.controlStatusText = controlError.statusText;
        this.brokerStatus = httpStatus(brokerError);
        this.brokerStatusText = httpStatusText(brokerError);
        this.brokerError = brokerError;
    }
}

class RecipeConsoleControlCredentialTrustError extends ControlRunManagerHttpError {
    readonly reachable = true;
    readonly authorizationRequired = true;
    readonly credentialTrustRequired = true;

    constructor(
        controlError: ControlRunManagerHttpError,
        message: string,
    ) {
        super(message, controlError.status, controlError.statusText);
        this.name = 'RecipeConsoleControlCredentialTrustError';
    }
}

export function createControlAuthorizedTransport(
    config: ControlAuthorizedTransportConfig,
): ControlAuthorizedTransport {
    const configuredManualToken = config.manualToken?.trim() || undefined;
    const manualToken = config.credentialPolicy.allowManualToken
        ? configuredManualToken
        : undefined;
    let brokeredToken: BlackBoxControlTokenSession | undefined;

    async function resolveBrokeredToken(signal?: AbortSignal): Promise<string> {
        const request = fetchWithSignal(config.fetchFn, signal);
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
        } catch (error) {
            if (
                brokerResponse &&
                !brokerResponse.ok &&
                !(error instanceof ControlRunManagerHttpError)
            ) {
                throw new ControlRunManagerHttpError(
                    errorMessage(error),
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
        const fetchFn = fetchWithSignal(config.fetchFn, signal);
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
            } catch (brokerError) {
                if (signal?.aborted || isAbortError(brokerError)) {
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
            return {
                value: await operation(token, fetchFn),
                authorization,
            };
        } catch (error) {
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
                    return {
                        value: await operation(brokeredToken.token, fetchFn),
                        authorization: 'brokered',
                    };
                } catch (cachedTokenError) {
                    if (
                        signal?.aborted ||
                        isAbortError(cachedTokenError) ||
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
            } catch (brokerError) {
                if (signal?.aborted || isAbortError(brokerError)) {
                    throw brokerError;
                }
                throw new RecipeConsoleControlAuthorizationError(
                    endpoint.challenge ?? error,
                    brokerError,
                );
            }
            return {
                value: await operation(token, fetchFn),
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
            return await request(
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
        } catch (error) {
            if (receivedResponse && config.isProtocolCandidate(error)) {
                throw config.protocolError(error);
            }
            throw error;
        }
    }

    return {
        createEndpointAuthorization: () => ({ requiresAuthorization: false }),
        request,
        response,
    };
}

function fetchWithSignal(
    fetchFn: ControlRunManagerFetch | undefined,
    signal: AbortSignal | undefined,
): ControlRunManagerFetch {
    const request = fetchFn ?? fetch;
    return (input, init) =>
        request(input, {
            ...init,
            signal: signal ?? init?.signal,
        });
}

function isAuthorizationError(
    error: unknown,
): error is ControlRunManagerHttpError {
    return error instanceof ControlRunManagerHttpError &&
        (error.status === 401 || error.status === 403);
}

function isAbortError(error: unknown): boolean {
    return Boolean(
        error &&
            typeof error === 'object' &&
            'name' in error &&
            error.name === 'AbortError',
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function httpStatus(error: unknown): number | undefined {
    return error && typeof error === 'object' &&
            'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined;
}

function httpStatusText(error: unknown): string | undefined {
    return error && typeof error === 'object' &&
            'statusText' in error && typeof error.statusText === 'string'
        ? error.statusText
        : undefined;
}
