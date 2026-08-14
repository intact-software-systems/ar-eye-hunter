import {
    RALLAR_BLACK_BOX_DISTRIBUTED_FAILURE_CATEGORIES,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    DIAGNOSTIC_BRIDGE_SOURCE_VIEWS,
    DIAGNOSTIC_BRIDGE_TRANSPORTS,
    DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES,
    type DiagnosticBridgeSourceView,
    type DiagnosticBridgeTransport,
} from '../../app/diagnostic-bridge-url-contract.ts';

export const RECIPE_CONSOLE_URL_VERSION = 1 as const;
export const RECIPE_CONSOLE_URL_STRING_MAX_BYTES =
    DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES;

export const RECIPE_CONSOLE_VIEWS = DIAGNOSTIC_BRIDGE_SOURCE_VIEWS;

export const RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES = [
    'debug',
    'info',
    'warning',
    'error',
] as const;

export const RECIPE_CONSOLE_TRANSPORTS = DIAGNOSTIC_BRIDGE_TRANSPORTS;

export const RECIPE_CONSOLE_RUN_STATUSES = [
    'draft',
    'resolving-targets',
    'staging',
    'waiting-for-ack',
    'waiting-for-barrier',
    'ready',
    'running',
    'passed',
    'failed',
    'cancelled',
    'timed-out',
] as const;

// Every category the analyzer can emit must stay filterable, so the console
// reuses the analyzer's own vocabulary instead of transcribing it.
export const RECIPE_CONSOLE_FAILURE_CATEGORIES =
    RALLAR_BLACK_BOX_DISTRIBUTED_FAILURE_CATEGORIES;

export const RECIPE_CONSOLE_TIMING_METRICS = [
    'command-duration',
    'stream-send-duration',
    'stream-drift',
    'stream-cadence',
] as const;

export const RECIPE_CONSOLE_FLEET_MAP_LAYERS = [
    'live-agents',
    'historical-regions',
    'failures',
    'observed-routes',
] as const;

export const RECIPE_CONSOLE_OWNED_URL_KEYS = [
    'v',
    'experience',
    'view',
    'controlRunId',
    'distributedRunId',
    'agentId',
    'recipeId',
    'commandId',
    'diagnosticSeverity',
    'transport',
    'historyQuery',
    'historyGroup',
    'historyRecipeId',
    'historyProfile',
    'failureCategory',
    'status',
    'from',
    'to',
    'compareLeft',
    'compareRight',
    'timingMetric',
    'fleetRegion',
    'fleetMapLayers',
    'legacySurface',
] as const;

export const LEGACY_APP_URL_ALIAS_KEYS = [
    'mode',
    'workspace',
    'appMode',
    'tab',
    'advancedSurface',
    'advanced',
] as const;

export const RECIPE_CONSOLE_SENSITIVE_URL_KEYS = [
    'agentSessionTicket',
    'controlToken',
    'rallarPassword',
    'rallarToken',
    'accessToken',
    'refreshToken',
    'password',
    'token',
] as const;

export const RECIPE_CONSOLE_NON_SHAREABLE_URL_KEYS = [
    'controlUrl',
] as const;

export type RecipeConsoleView = DiagnosticBridgeSourceView;
export type RecipeConsoleDiagnosticSeverity =
    typeof RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES[number];
export type RecipeConsoleTransport = DiagnosticBridgeTransport;
export type RecipeConsoleRunStatus = typeof RECIPE_CONSOLE_RUN_STATUSES[number];
export type RecipeConsoleFailureCategory =
    typeof RECIPE_CONSOLE_FAILURE_CATEGORIES[number];
export type RecipeConsoleTimingMetric = typeof RECIPE_CONSOLE_TIMING_METRICS[number];
export type RecipeConsoleFleetMapLayer =
    typeof RECIPE_CONSOLE_FLEET_MAP_LAYERS[number];

export type RecipeConsoleUrlState = Readonly<{
    v: 1;
    experience: 'recipe-console';
    view: RecipeConsoleView;
    controlRunId?: string;
    distributedRunId?: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    diagnosticSeverity?: RecipeConsoleDiagnosticSeverity;
    transport?: RecipeConsoleTransport;
    historyQuery?: string;
    historyGroup?: string;
    historyRecipeId?: string;
    historyProfile?: string;
    failureCategory?: RecipeConsoleFailureCategory;
    status?: RecipeConsoleRunStatus;
    from?: number;
    to?: number;
    compareLeft?: string;
    compareRight?: string;
    timingMetric?: RecipeConsoleTimingMetric;
    fleetRegion?: string;
    fleetMapLayers?: readonly RecipeConsoleFleetMapLayer[];
    legacySurface?: string;
}>;

export type RecipeConsoleUrlIssue = Readonly<{
    field: string;
    code: 'missing' | 'invalid' | 'duplicate' | 'normalized' | 'inapplicable';
    value?: string;
    message: string;
}>;

export type ParsedRecipeConsoleUrl = Readonly<{
    state: RecipeConsoleUrlState;
    issues: readonly RecipeConsoleUrlIssue[];
    canonicalSearch: string;
    needsReplace: boolean;
}>;
