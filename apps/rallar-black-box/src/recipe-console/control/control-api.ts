import type { AuthSession } from '@shared/api/api-config.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    controlHttpBaseUrlFromWsUrl,
    type ControlRunManagerFetch,
    ControlRunManagerHttpError,
    fetchControlServerSnapshot,
    fetchDistributedRuns,
} from '../../control-run-manager.ts';
import {
    type RecipeConsoleControlCredentialPolicy,
} from './control-credential-policy.ts';
import { createControlAuthorizedTransport } from './control-authorized-transport.ts';
import type {
    AuthorizedControlResult,
    RecipeConsoleControlAuthorization,
} from './control-authorized-transport.ts';
import { createRecipeConsoleControlExecutionApi } from './control-execution-api.ts';
import type { RecipeConsoleControlExecutionApi } from './control-execution-api.ts';
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

const MISSING_CONTROL_CREDENTIAL_POLICY = {
    allowManualToken: false,
    allowBrokeredToken: false,
    allowBootstrapAgentTicket: false,
    controlUrlFromLocation: false,
    apiBaseUrlFromLocation: false,
    controlTokenFromLocation: false,
    blockedMessage: 'Automatic control credentials are blocked because endpoint credential provenance was not provided.',
} as const satisfies RecipeConsoleControlCredentialPolicy;

export type RecipeConsoleControlSnapshotResult = Readonly<{
    snapshot: ControlServerSnapshot;
    completeness: 'complete' | 'partial';
    authorization: RecipeConsoleControlAuthorization;
    partialError?: unknown;
}>;

export type RecipeConsoleControlApi = Readonly<{
    baseUrl: string;
    execution: RecipeConsoleControlExecutionApi;
    readSnapshot(
        input?: Readonly<{
            signal?: AbortSignal;
        }>,
    ): Promise<RecipeConsoleControlSnapshotResult>;
}>;

export type RecipeConsoleControlApiConfig = Readonly<{
    controlUrl?: string;
    manualToken?: string;
    apiBaseUrl: string;
    authSession?: AuthSession;
    bounds?: ControlSnapshotBounds;
    fetchFn?: ControlRunManagerFetch;
    credentialPolicy: RecipeConsoleControlCredentialPolicy;
}>;

export class RecipeConsoleControlProtocolError extends Error {
    readonly reachable = true;

    constructor(message: string) {
        super(message);
        this.name = 'RecipeConsoleControlProtocolError';
    }
}

export function createRecipeConsoleControlApi(
    config: RecipeConsoleControlApiConfig,
): RecipeConsoleControlApi {
    const baseUrl = recipeConsoleControlBaseUrl(config.controlUrl);
    const bounds = config.bounds ?? RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS;
    const credentialPolicy = config.credentialPolicy ??
        MISSING_CONTROL_CREDENTIAL_POLICY;
    const transport = createControlAuthorizedTransport({
        apiBaseUrl: config.apiBaseUrl,
        authSession: config.authSession,
        manualToken: config.manualToken,
        fetchFn: config.fetchFn,
        credentialPolicy,
        protocolError: controlProtocolError,
        isProtocolCandidate,
    });
    const runsAuthorization = transport.createEndpointAuthorization();
    const distributedRunsAuthorization = transport.createEndpointAuthorization();
    const execution = createRecipeConsoleControlExecutionApi({
        baseUrl,
        transport,
    });

    return {
        baseUrl,
        execution,
        async readSnapshot(input = {}) {
            const server = await transport.response(
                (token, fetchFn) =>
                    fetchControlServerSnapshot({
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

            let distributed: AuthorizedControlResult<
                readonly ControlDistributedRunSnapshot[]
            >;
            let snapshot: ControlServerSnapshot;
            try {
                distributed = await transport.response(
                    (token, fetchFn) =>
                        fetchDistributedRuns({
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
        : new RecipeConsoleControlProtocolError(
            error instanceof Error ? error.message : String(error),
        );
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

function isAbortError(error: unknown): boolean {
    return Boolean(
        error &&
            typeof error === 'object' &&
            'name' in error &&
            error.name === 'AbortError',
    );
}

function combinedAuthorization(
    left: RecipeConsoleControlAuthorization,
    right: RecipeConsoleControlAuthorization,
): RecipeConsoleControlAuthorization {
    if (left === 'manual' || right === 'manual') return 'manual';
    if (left === 'brokered' || right === 'brokered') return 'brokered';
    return 'anonymous';
}

export type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds,
    RecipeConsoleControlAuthorization,
};
