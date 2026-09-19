import { DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES } from '../../app/diagnostic-bridge-url-contract.ts';

export const RECIPE_CONSOLE_URL_STRING_MAX_BYTES = DIAGNOSTIC_BRIDGE_URL_STRING_MAX_BYTES;

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
    'legacySurface'
] as const;

export const RECIPE_CONSOLE_SENSITIVE_URL_KEYS = [
    'agentSessionTicket',
    'controlToken',
    'rallarPassword',
    'rallarToken',
    'accessToken',
    'refreshToken',
    'password',
    'token'
] as const;

export const RECIPE_CONSOLE_NON_SHAREABLE_URL_KEYS = [
    'controlUrl'
] as const;
