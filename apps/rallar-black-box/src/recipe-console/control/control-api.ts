import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    resolveBlackBoxControlToken,
    shouldRefreshBlackBoxControlToken,
    type BlackBoxControlTokenSession,
} from '../../control-operator-token.ts';
import {
    ControlRunManagerHttpError,
    controlHttpBaseUrlFromWsUrl,
    fetchControlServerSnapshot,
    fetchDistributedRuns,
    type ControlRunManagerFetch,
} from '../../control-run-manager.ts';
import {
    TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
    type RecipeConsoleControlCredentialPolicy,
} from './control-credential-policy.ts';
import {
    validateControlDistributedRuns,
    validateControlServerCoreSnapshot,
    withoutDistributedRuns,
} from './control-snapshot-validation.ts';

export const RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS = {
    commands: 120,
    results: 120,
    events: 160,
    stats: 60,
    reports: 40,
    heartbeats: 80,
} as const satisfies ControlSnapshotBounds;

export type RecipeConsoleControlAuthorization =
    | 'anonymous'
    | 'manual'
    | 'brokered';

export type RecipeConsoleControlSnapshotResult = Readonly<{
    snapshot: ControlServerSnapshot;
    completeness: 'complete' | 'partial';
    authorization: RecipeConsoleControlAuthorization;
    partialError?: unknown;
}>;

export type RecipeConsoleControlApi = Readonly<{
    baseUrl: string;
    readSnapshot(input?: Readonly<{
        signal?: AbortSignal;
    }>): Promise<RecipeConsoleControlSnapshotResult>;
}>;

export type RecipeConsoleControlApiConfig = Readonly<{
    controlUrl?: string;
    manualToken?: string;
    apiBaseUrl: string;
    authSession?: AuthSession;
    bounds?: ControlSnapshotBounds;
    fetchFn?: ControlRunManagerFetch;
    credentialPolicy?: RecipeConsoleControlCredentialPolicy;
}>;

export class RecipeConsoleControlProtocolError extends Error {
    readonly reachable = true;

    constructor(message: string) {
        super(message);
        this.name = 'RecipeConsoleControlProtocolError';
    }
}

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

type AuthorizedResult<Value> = Readonly<{
    value: Value;
    authorization: RecipeConsoleControlAuthorization;
}>;

type EndpointAuthorizationState = {
    requiresAuthorization: boolean;
    challenge?: ControlRunManagerHttpError;
};

export function createRecipeConsoleControlApi(
    config: RecipeConsoleControlApiConfig,
): RecipeConsoleControlApi {
    const baseUrl = recipeConsoleControlBaseUrl(config.controlUrl);
    const bounds = config.bounds ?? RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS;
    const credentialPolicy = config.credentialPolicy ??
        TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY;
    const configuredManualToken = config.manualToken?.trim() || undefined;
    const manualToken = credentialPolicy.allowManualToken
        ? configuredManualToken
        : undefined;
    let brokeredToken: BlackBoxControlTokenSession | undefined;
    const runsAuthorization: EndpointAuthorizationState = {
        requiresAuthorization: false,
    };
    const distributedRunsAuthorization: EndpointAuthorizationState = {
        requiresAuthorization: false,
    };

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

    async function authorizedRead<Value>(
        operation: (token: string | undefined, fetchFn: ControlRunManagerFetch) => Promise<Value>,
        endpointAuthorization: EndpointAuthorizationState,
        signal?: AbortSignal,
    ): Promise<AuthorizedResult<Value>> {
        const fetchFn = fetchWithSignal(config.fetchFn, signal);
        let authorization: RecipeConsoleControlAuthorization = manualToken
            ? 'manual'
            : endpointAuthorization.requiresAuthorization && brokeredToken
            ? 'brokered'
            : 'anonymous';
        let token = manualToken ?? (
            endpointAuthorization.requiresAuthorization
                ? brokeredToken?.token
                : undefined
        );

        if (
            !manualToken &&
            endpointAuthorization.requiresAuthorization &&
            brokeredToken &&
            shouldRefreshBlackBoxControlToken(brokeredToken)
        ) {
            try {
                token = await resolveBrokeredToken(signal);
            } catch (brokerError) {
                if (signal?.aborted || isAbortError(brokerError)) {
                    throw brokerError;
                }
                if (endpointAuthorization.challenge) {
                    throw new RecipeConsoleControlAuthorizationError(
                        endpointAuthorization.challenge,
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
            if (!credentialPolicy.allowBrokeredToken) {
                if (config.authSession || configuredManualToken) {
                    throw new RecipeConsoleControlCredentialTrustError(
                        error,
                        credentialPolicy.blockedMessage ??
                            'Automatic control credentials are blocked for this endpoint source.',
                    );
                }
                throw error;
            }
            if (!config.authSession) {
                throw error;
            }

            endpointAuthorization.requiresAuthorization = true;
            endpointAuthorization.challenge = error;
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
                    endpointAuthorization.challenge = cachedTokenError;
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
                    endpointAuthorization.challenge ?? error,
                    brokerError,
                );
            }
            return {
                value: await operation(token, fetchFn),
                authorization: 'brokered',
            };
        }
    }

    async function authorizedResponseRead<Value>(
        operation: (
            token: string | undefined,
            fetchFn: ControlRunManagerFetch,
        ) => Promise<Value>,
        endpointAuthorization: EndpointAuthorizationState,
        signal?: AbortSignal,
    ): Promise<AuthorizedResult<Value>> {
        let receivedResponse = false;
        try {
            return await authorizedRead(
                (token, fetchFn) => operation(
                    token,
                    async (input, init) => {
                        const response = await fetchFn(input, init);
                        receivedResponse = true;
                        return response;
                    },
                ),
                endpointAuthorization,
                signal,
            );
        } catch (error) {
            if (receivedResponse && isProtocolCandidate(error)) {
                throw controlProtocolError(error);
            }
            throw error;
        }
    }

    return {
        baseUrl,
        async readSnapshot(input = {}) {
            const server = await authorizedResponseRead(
                (token, fetchFn) => fetchControlServerSnapshot({
                    baseUrl,
                    token,
                    bounds,
                    fetchFn,
                }),
                runsAuthorization,
                input.signal,
            );
            try {
                validateControlServerCoreSnapshot(server.value);
            } catch (error) {
                throw controlProtocolError(error);
            }
            if (server.value.distributedRuns !== undefined) {
                try {
                    validateControlDistributedRuns(
                        server.value.distributedRuns,
                    );
                } catch (error) {
                    return {
                        snapshot: withoutDistributedRuns(server.value),
                        completeness: 'partial',
                        authorization: server.authorization,
                        partialError: controlProtocolError(error),
                    };
                }
                return {
                    snapshot: server.value,
                    completeness: 'complete',
                    authorization: server.authorization,
                };
            }

            let distributed: AuthorizedResult<readonly ControlDistributedRunSnapshot[]>;
            let snapshot: ControlServerSnapshot;
            try {
                distributed = await authorizedResponseRead(
                    (token, fetchFn) => fetchDistributedRuns({
                        baseUrl,
                        token,
                        fetchFn,
                    }),
                    distributedRunsAuthorization,
                    input.signal,
                );
                validateControlDistributedRuns(distributed.value);
                snapshot = {
                    ...server.value,
                    distributedRuns: distributed.value,
                };
                validateControlServerCoreSnapshot(snapshot);
            } catch (partialError) {
                if (input.signal?.aborted || isAbortError(partialError)) {
                    throw partialError;
                }
                const normalizedPartialError = isProtocolCandidate(partialError)
                    ? controlProtocolError(partialError)
                    : partialError;
                return {
                    snapshot: server.value,
                    completeness: 'partial',
                    authorization: server.authorization,
                    partialError: normalizedPartialError,
                };
            }
            return {
                snapshot,
                completeness: 'complete',
                authorization: combinedAuthorization(
                    server.authorization,
                    distributed.authorization,
                ),
            };
        },
    };
}

function controlProtocolError(error: unknown): RecipeConsoleControlProtocolError {
    return error instanceof RecipeConsoleControlProtocolError
        ? error
        : new RecipeConsoleControlProtocolError(errorMessage(error));
}

function isProtocolCandidate(error: unknown): boolean {
    return !(error instanceof ControlRunManagerHttpError) &&
        !(
            error && typeof error === 'object' &&
            'authorizationRequired' in error && error.authorizationRequired === true
        ) &&
        !(error instanceof TypeError) &&
        !isAbortError(error);
}

function recipeConsoleControlBaseUrl(controlUrl: string | undefined): string {
    const configured = controlUrl?.trim();
    if (configured) {
        let parsed: URL;
        try {
            parsed = new URL(configured);
        } catch (_error) {
            throw new Error('The configured control URL is invalid.');
        }
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
            throw new Error('The configured control URL uses an invalid protocol.');
        }
        if (parsed.username || parsed.password) {
            throw new Error('The configured control URL must not contain credentials.');
        }
    }
    return controlHttpBaseUrlFromWsUrl(configured);
}

function fetchWithSignal(
    fetchFn: ControlRunManagerFetch | undefined,
    signal: AbortSignal | undefined,
): ControlRunManagerFetch {
    const request = fetchFn ?? fetch;
    return (input, init) => request(input, {
        ...init,
        signal: signal ?? init?.signal,
    });
}

function isAuthorizationError(error: unknown): error is ControlRunManagerHttpError {
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

function combinedAuthorization(
    left: RecipeConsoleControlAuthorization,
    right: RecipeConsoleControlAuthorization,
): RecipeConsoleControlAuthorization {
    if (left === 'manual' || right === 'manual') return 'manual';
    if (left === 'brokered' || right === 'brokered') return 'brokered';
    return 'anonymous';
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

export type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds,
};
