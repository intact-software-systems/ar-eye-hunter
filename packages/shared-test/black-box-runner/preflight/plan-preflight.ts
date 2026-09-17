import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';

import {
    isJsonRecordValue,
    type JsonSchemaValidationIssue
} from '../../rallar-bb-test/schema/json-schema-validation.ts';
import { validateBlackBoxRunnerScenarioRecipe } from '../schema.ts';
import type { BlackBoxRunnerPreflightIssue } from './black-box-runner-preflight-issue.ts';
import type { BlackBoxRunnerEnvRequirement } from './preflight-env-variables.ts';
import {
    toFiniteNumber,
    toNonEmptyText,
    toPreflightJsonArray,
    toPreflightJsonObject,
    toUniqueSortedTexts
} from './preflight-json-values.ts';
import {
    toPreflightOperations,
    type BlackBoxRunnerPreflightOperation
} from './preflight-operations.ts';
import {
    computeRedactionPreflight,
    type BlackBoxRunnerPreflightRedactions
} from './preflight-redactions.ts';
import {
    computeOutputPreflight,
    computeStepReferencePreflight,
    type BlackBoxRunnerPreflightOutputs,
    type BlackBoxRunnerPreflightStepReferences
} from './preflight-step-references.ts';
import {
    isStoppingOnFailure,
    toConnectionPreflightSteps
} from './to-connection-preflight-steps.ts';
import {
    toConnectionPreflight,
    type ConnectionPreflight
} from './to-connection-preflight.ts';
import { validateStrictPreflightProfile } from './validate-strict-preflight-profile.ts';

export type BlackBoxRunnerPreflightProfile = 'compat' | 'strict';

export interface BlackBoxRunnerPlanPreflight {
    readonly schemaVersion: 1;
    readonly ok: boolean;
    readonly profile: BlackBoxRunnerPreflightProfile;
    readonly summary: BlackBoxRunnerPreflightSummary;
    readonly includes: BlackBoxRunnerPreflightIncludes;
    readonly providerModes: readonly string[];
    readonly liveServiceRequirements: readonly string[];
    readonly env: BlackBoxRunnerPreflightEnv;
    readonly connections: ConnectionPreflight;
    readonly stepReferences: BlackBoxRunnerPreflightStepReferences;
    readonly outputs: BlackBoxRunnerPreflightOutputs;
    readonly redactions: BlackBoxRunnerPreflightRedactions;
    /** Absent when the run expands no traffic plan. */
    readonly trafficPlan?: BlackBoxRunnerPreflightTrafficPlan;
    readonly operations: readonly BlackBoxRunnerPreflightOperation[];
    readonly issues: readonly BlackBoxRunnerPreflightIssue[];
}

export interface BlackBoxRunnerPreflightSummary {
    readonly generatedOperationCount: number;
    readonly topLevelOperationCount: number;
    readonly parallelGroupCount: number;
    readonly estimatedArtifactResultRecords: number;
    readonly estimatedArtifactEventRecords: number;
    readonly estimatedArtifactJsonBytes: number;
    readonly postRunAssertionCount: number;
    readonly includeCount: number;
}

export interface BlackBoxRunnerPreflightIncludes {
    readonly resolved: readonly ApiJsonObject[];
}

export interface BlackBoxRunnerPreflightEnv {
    readonly required: readonly BlackBoxRunnerEnvRequirement[];
    readonly missing: readonly BlackBoxRunnerEnvRequirement[];
}

export interface BlackBoxRunnerPreflightTrafficPlan {
    readonly enabled: boolean;
    readonly replay: boolean;
    /** Absent when the plan artifact records no numeric seed. */
    readonly seed?: number;
    readonly decisionCount: number;
    readonly stepCount: number;
}

export interface BlackBoxRunnerPreflightInput {
    readonly rawConfig: ApiJsonObject;
    readonly expandedConfig: ApiJsonObject;
    readonly executableInteractions: readonly ApiJsonValue[];
    readonly envRequirements: readonly BlackBoxRunnerEnvRequirement[];
    /** Absent when the recipe expands no traffic plan. */
    readonly trafficPlanArtifact?: ApiJsonObject;
    readonly profile: BlackBoxRunnerPreflightProfile;
    /** Absent when include and plan expansion succeeded. */
    readonly expansionError?: Error;
}

interface PreflightReferenceChecks {
    readonly missingEnv: readonly BlackBoxRunnerEnvRequirement[];
    readonly connections: ConnectionPreflight;
    readonly steps: BlackBoxRunnerPreflightStepReferences;
    readonly outputs: BlackBoxRunnerPreflightOutputs;
}

const POST_RUN_ASSERTION_KEYS = [
    'path',
    'metric',
    'from',
    'actual',
    'operator',
    'op',
    'equals',
    'eq',
    'expected',
    'notEquals',
    'ne',
    'gte',
    'min',
    'atLeast',
    'lte',
    'max',
    'atMost',
    'gt',
    'lt',
    'between',
    'includes',
    'contains',
    'notIncludes',
    'exists'
];

export function computeBlackBoxRunnerPlanPreflight(input: BlackBoxRunnerPreflightInput): BlackBoxRunnerPlanPreflight {
    const { rawConfig, expandedConfig, executableInteractions, envRequirements, profile } = input;
    const operations = toPreflightOperations(executableInteractions, undefined);
    const missingEnv = envRequirements.filter((requirement) =>
        requirement.required && requirement.source === 'missing'
    );
    const connections = toConnectionPreflight(
        Object.keys(toPreflightJsonObject(rawConfig.connections)),
        toConnectionPreflightSteps(
            executableInteractions,
            isStoppingOnFailure(toPreflightJsonObject(expandedConfig.execution))
        )
    );
    const stepReferences = computeStepReferencePreflight(rawConfig);
    const outputs = computeOutputPreflight(rawConfig, expandedConfig, operations);
    const includes = toIncludePreflight(expandedConfig);
    const issues = [
        ...validateRecipeShape(input, operations),
        ...validatePreflightReferences({ missingEnv, connections, steps: stepReferences, outputs })
    ];
    return {
        schemaVersion: 1,
        ok: issues.every((issue) => issue.severity !== 'error'),
        profile,
        summary: computePreflightSummary(input, operations, includes.resolved.length),
        includes,
        providerModes: computeProviderModes(rawConfig, operations),
        liveServiceRequirements: computeLiveServiceRequirements(input, operations),
        env: { required: envRequirements.filter((requirement) => requirement.required), missing: missingEnv },
        connections,
        stepReferences,
        outputs,
        redactions: computeRedactionPreflight(rawConfig),
        trafficPlan: input.trafficPlanArtifact === undefined
            ? undefined
            : toTrafficPlanPreflight(input.trafficPlanArtifact),
        operations,
        issues
    };
}

function validatePreflightReferences(checks: PreflightReferenceChecks): readonly BlackBoxRunnerPreflightIssue[] {
    return [
        ...checks.missingEnv.map((requirement) => ({
            severity: 'error' as const,
            code: 'MISSING_ENV',
            message:
                `Missing required environment variable ${requirement.envName} for variable ${requirement.variableName}.`,
            path: `variables.${requirement.variableName}`
        })),
        ...checks.connections.missing.map((connection) => ({
            severity: 'error' as const,
            code: 'MISSING_CONNECTION',
            message: `Step references missing connection ${connection}.`,
            path: 'connections'
        })),
        ...checks.steps.missing.map((reference) => ({
            severity: 'error' as const,
            code: 'MISSING_STEP_REFERENCE',
            message: `Recipe references missing step ${reference.name}.`,
            path: reference.path
        })),
        ...checks.outputs.missingConsumed.map((output) => ({
            severity: 'warning' as const,
            code: 'MISSING_OUTPUT_REFERENCE',
            message: `Placeholder references ${output}, but no earlier output with that name is produced.`,
            path: 'steps'
        }))
    ];
}

function validateRecipeShape(
    input: BlackBoxRunnerPreflightInput,
    operations: readonly BlackBoxRunnerPreflightOperation[]
): readonly BlackBoxRunnerPreflightIssue[] {
    const schema = validateBlackBoxRunnerScenarioRecipe(input.rawConfig);
    return [
        ...(schema.ok ? [] : schema.errors.map(toPreflightSchemaIssue)),
        ...(input.profile === 'strict' ? validateStrictPreflightProfile(input.rawConfig, operations) : []),
        ...(input.expansionError === undefined
            ? []
            : [{ severity: 'error' as const, code: 'PLAN_EXPANSION_FAILED', message: input.expansionError.message }])
    ];
}

function toPreflightSchemaIssue(issue: JsonSchemaValidationIssue): BlackBoxRunnerPreflightIssue {
    return {
        severity: 'error',
        code: 'SCHEMA',
        message: issue.message,
        path: issue.path
    };
}

/** The artifact estimate counts one result record and two event records per operation. */
function computePreflightSummary(
    input: BlackBoxRunnerPreflightInput,
    operations: readonly BlackBoxRunnerPreflightOperation[],
    includeCount: number
): BlackBoxRunnerPreflightSummary {
    return {
        generatedOperationCount: operations.length,
        topLevelOperationCount: input.executableInteractions.length,
        parallelGroupCount: operations
            .reduce((sum, operation) => sum + (operation.transport === 'PARALLEL' ? operation.groupCount : 0), 0),
        estimatedArtifactResultRecords: operations.length,
        estimatedArtifactEventRecords: operations.length * 2,
        estimatedArtifactJsonBytes: JSON.stringify({
            executableInteractions: input.executableInteractions,
            trafficPlan: input.trafficPlanArtifact
        }).length,
        postRunAssertionCount: computePostRunAssertionCount(input.rawConfig),
        includeCount
    };
}

function toIncludePreflight(expandedConfig: ApiJsonObject): BlackBoxRunnerPreflightIncludes {
    return {
        resolved: toPreflightJsonArray(toPreflightJsonObject(expandedConfig.includeMetadata).includes)
            .flatMap((include) => isJsonRecordValue(include) ? [include] : [])
    };
}

function computeProviderModes(
    rawConfig: ApiJsonObject,
    operations: readonly BlackBoxRunnerPreflightOperation[]
): readonly string[] {
    const connectionModes = Object.values(toPreflightJsonObject(rawConfig.connections))
        .map(toPreflightJsonObject)
        .flatMap((connection) => [toNonEmptyText(connection.provider), toNonEmptyText(connection.type)]);
    const operationModes = operations.flatMap((operation) => [
        operation.provider,
        ['HTTP', 'MQ', 'WS', 'RTC', 'WEBRTC'].includes(operation.transport)
            ? operation.transport.toLowerCase()
            : undefined
    ]);
    return toUniqueSortedTexts(
        [...connectionModes, ...operationModes].filter((mode): mode is string => Boolean(mode))
    );
}

function computeLiveServiceRequirements(
    input: BlackBoxRunnerPreflightInput,
    operations: readonly BlackBoxRunnerPreflightOperation[]
): readonly string[] {
    const providers = new Set(computeProviderModes(input.rawConfig, operations));
    const transports = new Set<string>(operations.map((operation) => operation.transport));
    const requirements = [
        'local black-box-runner process',
        ...(transports.has('HTTP') ? ['reachable HTTP endpoints for HTTP steps'] : []),
        ...(transports.has('WS') ? ['reachable WebSocket endpoint and any required ticket/token for WS steps'] : []),
        ...(transports.has('RTC') || transports.has('WEBRTC') ? ['configured RTC provider for RTC steps'] : []),
        ...(providers.has('rallar') || providers.has('rallar-browser')
            ? ['live Rallar API/signaling environment for browser-backed Rallar RTC']
            : []),
        ...(providers.has('rallar-remote-browser')
            ? ['Rallar black-box control server with connected browser agent']
            : []),
        ...(providers.has('rallar-memory') || providers.has('rallar-stub')
            ? ['deterministic in-process RTC provider']
            : []),
        ...(input.trafficPlanArtifact ? ['expanded traffic plan artifact for replay/debug'] : [])
    ];
    return toUniqueSortedTexts(requirements);
}

function toTrafficPlanPreflight(artifact: ApiJsonObject): BlackBoxRunnerPreflightTrafficPlan {
    return {
        enabled: true,
        replay: artifact.replay === true,
        seed: toFiniteNumber(artifact.seed),
        decisionCount: Array.isArray(artifact.decisions) ? artifact.decisions.length : 0,
        stepCount: Array.isArray(artifact.steps) ? artifact.steps.length : 0
    };
}

function computePostRunAssertionCount(rawConfig: ApiJsonObject): number {
    const execution = toPreflightJsonObject(rawConfig.execution);
    return computePostRunAssertionSourceCount(rawConfig.postRunAssertions) +
        computePostRunAssertionSourceCount(execution.postRunAssertions) +
        computePostRunAssertionSourceCount(execution.thresholds);
}

/** An assertion source is a list of assertions, one assertion, or a record of named assertions. */
function computePostRunAssertionSourceCount(value: ApiJsonValue | undefined): number {
    if (Array.isArray(value)) {
        return value.length;
    }
    const record = toPreflightJsonObject(value);
    const keys = Object.keys(record);
    if (keys.length <= 0) {
        return 0;
    }
    return POST_RUN_ASSERTION_KEYS.some((key) => record[key] !== undefined) ? 1 : keys.length;
}
