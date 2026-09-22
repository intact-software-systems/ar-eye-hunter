import { RALLAR_BLACK_BOX_DISTRIBUTED_FAILURE_CATEGORIES } from '@shared-test/rallar-bb-test/distributed-run-analysis/distributed-failure-explanation-contracts.ts';
import {
    DIAGNOSTIC_BRIDGE_SOURCE_VIEWS,
    DIAGNOSTIC_BRIDGE_TRANSPORTS,
    type DiagnosticBridgeSourceView,
    type DiagnosticBridgeTransport
} from '../../app/diagnostic-bridge-url-contract.ts';

export const RECIPE_CONSOLE_URL_VERSION = 1 as const;

export const RECIPE_CONSOLE_VIEWS = DIAGNOSTIC_BRIDGE_SOURCE_VIEWS;

export const RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES = [
    'debug',
    'info',
    'warning',
    'error'
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
    'timed-out'
] as const;

// Every category the analyzer can emit must stay filterable, so the console
// reuses the analyzer's own vocabulary instead of transcribing it.
export const RECIPE_CONSOLE_FAILURE_CATEGORIES = RALLAR_BLACK_BOX_DISTRIBUTED_FAILURE_CATEGORIES;

export const RECIPE_CONSOLE_TIMING_METRICS = [
    'command-duration',
    'stream-send-duration',
    'stream-drift',
    'stream-cadence'
] as const;

export const RECIPE_CONSOLE_FLEET_MAP_LAYERS = [
    'live-agents',
    'historical-regions',
    'failures',
    'observed-routes'
] as const;

export type RecipeConsoleDiagnosticSeverity = typeof RECIPE_CONSOLE_DIAGNOSTIC_SEVERITIES[number];
export type RecipeConsoleRunStatus = typeof RECIPE_CONSOLE_RUN_STATUSES[number];
export type RecipeConsoleFailureCategory = typeof RECIPE_CONSOLE_FAILURE_CATEGORIES[number];
export type RecipeConsoleTimingMetric = typeof RECIPE_CONSOLE_TIMING_METRICS[number];
export type RecipeConsoleFleetMapLayer = typeof RECIPE_CONSOLE_FLEET_MAP_LAYERS[number];

export type RecipeConsoleUrlState = Readonly<{
    v: 1;
    experience: 'recipe-console';
    view: DiagnosticBridgeSourceView;
    /** Absent until the operator selects a control run. */
    controlRunId?: string;
    /** Absent until the operator selects a distributed run. */
    distributedRunId?: string;
    /** Absent until the operator selects an agent. */
    agentId?: string;
    /** Absent until the operator selects a recipe. */
    recipeId?: string;
    /** Absent until the operator selects a command. */
    commandId?: string;
    /** Absent until the operator filters Monitor diagnostics by severity. */
    diagnosticSeverity?: RecipeConsoleDiagnosticSeverity;
    /** Absent until the operator filters Monitor diagnostics by transport. */
    transport?: DiagnosticBridgeTransport;
    /** Absent until the operator types a History search. */
    historyQuery?: string;
    /** Absent until the operator filters History by group. */
    historyGroup?: string;
    /** Absent until the operator filters History by recipe. */
    historyRecipeId?: string;
    /** Absent until the operator filters History by profile. */
    historyProfile?: string;
    /** Absent until the operator filters History by failure category. */
    failureCategory?: RecipeConsoleFailureCategory;
    /** Absent until the operator filters History by run status. */
    status?: RecipeConsoleRunStatus;
    /** Absent until the operator sets the start of a History time range. */
    from?: number;
    /** Absent until the operator sets the end of a History time range. */
    to?: number;
    /** Absent until the operator picks a Tune baseline run. */
    compareLeft?: string;
    /** Absent until the operator picks a Tune candidate run. */
    compareRight?: string;
    /** Absent until the operator picks a Tune timing metric. */
    timingMetric?: RecipeConsoleTimingMetric;
    /** Absent until the operator selects a Fleet region. */
    fleetRegion?: string;
    /** Absent until the operator chooses which Fleet map layers to show. */
    fleetMapLayers?: readonly RecipeConsoleFleetMapLayer[];
    /** Absent outside the Advanced view, which is the only view that opens a legacy surface. */
    legacySurface?: string;
}>;

export type RecipeConsoleUrlIssue = Readonly<{
    field: string;
    code: 'missing' | 'invalid' | 'duplicate' | 'normalized' | 'inapplicable';
    /** Absent when the parameter was missing, so there is no rejected value to show. */
    value?: string;
    message: string;
}>;

export type ParsedRecipeConsoleUrl = Readonly<{
    state: RecipeConsoleUrlState;
    issues: readonly RecipeConsoleUrlIssue[];
    canonicalSearch: string;
    needsReplace: boolean;
}>;
