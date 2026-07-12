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
}>;

type AuthorizedResult<Value> = Readonly<{
    value: Value;
    authorization: RecipeConsoleControlAuthorization;
}>;

export function createRecipeConsoleControlApi(
    config: RecipeConsoleControlApiConfig,
): RecipeConsoleControlApi {
    const baseUrl = recipeConsoleControlBaseUrl(config.controlUrl);
    const bounds = config.bounds ?? RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS;
    const manualToken = config.manualToken?.trim() || undefined;
    let brokeredToken: BlackBoxControlTokenSession | undefined;

    async function resolveBrokeredToken(signal?: AbortSignal): Promise<string> {
        const resolved = await resolveBlackBoxControlToken({
            apiBaseUrl: config.apiBaseUrl,
            authSession: config.authSession,
            brokeredToken,
            fetchFn: fetchWithSignal(config.fetchFn, signal),
        });
        if (resolved.source !== 'brokered') {
            return resolved.token;
        }
        brokeredToken = resolved.session;
        return resolved.token;
    }

    async function authorizedRead<Value>(
        operation: (token: string | undefined, fetchFn: ControlRunManagerFetch) => Promise<Value>,
        signal?: AbortSignal,
    ): Promise<AuthorizedResult<Value>> {
        const fetchFn = fetchWithSignal(config.fetchFn, signal);
        let authorization: RecipeConsoleControlAuthorization = manualToken
            ? 'manual'
            : brokeredToken
            ? 'brokered'
            : 'anonymous';
        let token = manualToken ?? brokeredToken?.token;

        if (
            !manualToken &&
            brokeredToken &&
            shouldRefreshBlackBoxControlToken(brokeredToken)
        ) {
            token = await resolveBrokeredToken(signal);
            authorization = 'brokered';
        }

        try {
            return {
                value: await operation(token, fetchFn),
                authorization,
            };
        } catch (error) {
            if (
                manualToken ||
                !config.authSession ||
                !isAuthorizationError(error)
            ) {
                throw error;
            }

            brokeredToken = undefined;
            try {
                token = await resolveBrokeredToken(signal);
            } catch (brokerError) {
                if (signal?.aborted || isAbortError(brokerError)) {
                    throw brokerError;
                }
                throw new ControlRunManagerHttpError(
                    errorMessage(brokerError),
                    error.status,
                    error.statusText,
                );
            }
            return {
                value: await operation(token, fetchFn),
                authorization: 'brokered',
            };
        }
    }

    return {
        baseUrl,
        async readSnapshot(input = {}) {
            const server = await authorizedRead(
                (token, fetchFn) => fetchControlServerSnapshot({
                    baseUrl,
                    token,
                    bounds,
                    fetchFn,
                }),
                input.signal,
            );
            validateControlServerSnapshot(server.value);
            if (server.value.distributedRuns !== undefined) {
                return {
                    snapshot: server.value,
                    completeness: 'complete',
                    authorization: server.authorization,
                };
            }

            let distributed: AuthorizedResult<readonly ControlDistributedRunSnapshot[]>;
            try {
                distributed = await authorizedRead(
                    (token, fetchFn) => fetchDistributedRuns({
                        baseUrl,
                        token,
                        fetchFn,
                    }),
                    input.signal,
                );
            } catch (partialError) {
                if (input.signal?.aborted || isAbortError(partialError)) {
                    throw partialError;
                }
                return {
                    snapshot: server.value,
                    completeness: 'partial',
                    authorization: server.authorization,
                    partialError,
                };
            }
            assertDistributedRuns(distributed.value);
            const snapshot = {
                ...server.value,
                distributedRuns: distributed.value,
            };
            validateControlServerSnapshot(snapshot);
            return {
                snapshot,
                completeness: 'complete',
                authorization: distributed.authorization,
            };
        },
    };
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

function validateControlServerSnapshot(value: unknown): asserts value is ControlServerSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Control server snapshot runs must be an array.');
    }
    const record = value as Record<string, unknown>;
    assertArray(record, 'runs', false);
    assertArray(record, 'distributedRuns', true);
    assertArray(record, 'fleetReports', true);
}

function assertDistributedRuns(
    value: unknown,
): asserts value is readonly ControlDistributedRunSnapshot[] {
    if (!Array.isArray(value)) {
        throw new Error('Control server snapshot distributedRuns must be an array.');
    }
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

function assertArray(
    value: Record<string, unknown>,
    field: 'runs' | 'distributedRuns' | 'fleetReports',
    optional: boolean,
): void {
    if (optional && value[field] === undefined) {
        return;
    }
    if (!Array.isArray(value[field])) {
        throw new Error(`Control server snapshot ${field} must be an array.`);
    }
}

export type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds,
};
