import type { AuthSession } from '@shared/api/api-config.ts';
import type { ControlServerSnapshot, ControlSnapshotBounds } from
    '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    controlHttpBaseUrlFromWsUrl,
    type ControlRunManagerFetch,
    ControlRunManagerHttpError,
} from '../../control-run-manager.ts';
import {
    type RecipeConsoleControlCredentialPolicy,
} from './control-credential-policy.ts';
import { createControlAuthorizedTransport } from './control-authorized-transport.ts';
import { isControlAbortError } from './control-authorized-fetch.ts';
import { createRecipeConsoleControlExecutionApi } from './control-execution-api.ts';
import type { RecipeConsoleControlExecutionApi } from './control-execution-api.ts';
import {
    createRecipeConsoleControlAgentLaunchApi,
    type RecipeConsoleControlAgentLaunchApi,
} from './control-agent-launch-api.ts';
import {
    createControlLazyCapability,
    type ControlLazyCapability,
} from './control-lazy-capability.ts';
import type { RecipeConsoleControlFleetApi } from './control-fleet-api.ts';
import type { RecipeConsoleControlRetentionApi } from './control-retention-api.ts';
import { createControlSnapshotReader } from './control-snapshot-reader.ts';
import type { RecipeConsoleControlSnapshotResult } from
    './control-snapshot-reader.ts';

export const RECIPE_CONSOLE_CONTROL_INDEX_BOUNDS = {
    commands: 0,
    results: 0,
    events: 0,
    stats: 0,
    reports: 0,
    heartbeats: 0,
} as const satisfies ControlSnapshotBounds;

export const RECIPE_CONSOLE_CONTROL_DETAIL_BOUNDS = {
    commands: 120,
    results: 120,
    events: 160,
    stats: 60,
    reports: 40,
    heartbeats: 80,
} as const satisfies ControlSnapshotBounds;

export const RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS =
    RECIPE_CONSOLE_CONTROL_DETAIL_BOUNDS;

const MISSING_CONTROL_CREDENTIAL_POLICY = {
    allowManualToken: false,
    allowBrokeredToken: false,
    allowBootstrapAgentTicket: false,
    controlUrlFromLocation: false,
    apiBaseUrlFromLocation: false,
    controlTokenFromLocation: false,
    blockedMessage: 'Automatic control credentials are blocked because endpoint credential provenance was not provided.',
} as const satisfies RecipeConsoleControlCredentialPolicy;

export type RecipeConsoleControlRetentionCapability =
    ControlLazyCapability<RecipeConsoleControlRetentionApi>;
export type RecipeConsoleControlFleetCapability =
    ControlLazyCapability<RecipeConsoleControlFleetApi>;

export type RecipeConsoleControlApi = Readonly<{
    baseUrl: string;
    agentLaunch: RecipeConsoleControlAgentLaunchApi;
    execution: RecipeConsoleControlExecutionApi;
    retention: RecipeConsoleControlRetentionCapability;
    fleet: RecipeConsoleControlFleetCapability;
    close(): void;
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
    indexBounds?: ControlSnapshotBounds;
    bounds?: ControlSnapshotBounds;
    fetchFn?: ControlRunManagerFetch;
    credentialPolicy: RecipeConsoleControlCredentialPolicy;
    detailRunIds?(snapshot: ControlServerSnapshot): readonly string[];
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
    const indexBounds = config.indexBounds ??
        RECIPE_CONSOLE_CONTROL_INDEX_BOUNDS;
    const detailBounds = config.bounds ??
        RECIPE_CONSOLE_CONTROL_DETAIL_BOUNDS;
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
    const execution = createRecipeConsoleControlExecutionApi({
        baseUrl,
        transport,
    });
    const agentLaunch = createRecipeConsoleControlAgentLaunchApi({
        baseUrl,
        endpoint: transport.createAuthorizedEndpoint(),
    });
    const lifetime = new AbortController();
    const retention = createControlLazyCapability({
        signal: lifetime.signal,
        load: async () => {
            const feature = await import('./control-retention-api.ts');
            return feature.createRecipeConsoleControlRetentionApi({
                baseUrl,
                endpoint: transport.createAuthorizedEndpoint(),
                contextSignal: lifetime.signal,
            });
        },
    });
    const fleet = createControlLazyCapability({
        signal: lifetime.signal,
        load: async () => {
            const feature = await import('./control-fleet-api.ts');
            return feature.createRecipeConsoleControlFleetApi({
                baseUrl,
                endpoint: transport.createAuthorizedEndpoint(),
                contextSignal: lifetime.signal,
            });
        },
    });
    const readSnapshot = createControlSnapshotReader({
        baseUrl,
        indexBounds,
        detailBounds,
        detailRunIds: config.detailRunIds,
        transport,
        protocolError: controlProtocolError,
        isProtocolCandidate,
    });

    return {
        baseUrl,
        agentLaunch,
        execution,
        retention,
        fleet,
        close: () => lifetime.abort(),
        readSnapshot,
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
        !isControlAbortError(error);
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

export type {
    ControlDistributedRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
export type { RecipeConsoleControlAuthorization } from
    './control-authorized-transport.ts';
export type {
    RecipeConsoleControlDistributedRunsSource,
    RecipeConsoleControlQueryProvenance,
    RecipeConsoleControlSnapshotResult,
} from './control-snapshot-reader.ts';
