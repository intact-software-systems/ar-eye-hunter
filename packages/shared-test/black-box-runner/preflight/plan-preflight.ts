import type { JsonSchemaValidationIssue } from '../../rallar-bb-test/schema.ts';
import { directSafeOutputTransformSpec } from '../scenario-transform/safe-output-transform.ts';
import { validateBlackBoxRunnerScenarioRecipe } from '../schema.ts';
import {
    toConnectionPreflight,
    type ConnectionPreflightStep,
    type ConnectionSelection
} from './to-connection-preflight.ts';

interface JsonRecord {
    [key: string]: unknown;
}

export type BlackBoxRunnerPreflightProfile = 'compat' | 'strict';
export type BlackBoxRunnerPreflightSeverity = 'error' | 'warning';
export interface BlackBoxRunnerEnvRequirement {
    readonly variableName: string;
    readonly envName: string;
    readonly required: boolean;
    readonly secret: boolean;
    readonly hasValue: boolean;
    readonly hasDefault: boolean;
    readonly hasFallback: boolean;
    readonly source: 'env' | 'default' | 'fallback' | 'missing' | 'unset';
}

export interface BlackBoxRunnerPreflightIssue {
    readonly severity: BlackBoxRunnerPreflightSeverity;
    readonly code: string;
    readonly message: string;
    readonly path?: string;
}

export interface BlackBoxRunnerPreflightOperation {
    readonly name: string;
    readonly transport: string;
    readonly action?: string;
    readonly connection?: string;
    readonly provider?: string;
    readonly path?: string;
    readonly group?: string;
    readonly groupCount?: number;
    readonly interactionExecutionNumber?: number;
    readonly repeatIndex?: number;
}

export interface BlackBoxRunnerPlanPreflight {
    readonly schemaVersion: 1;
    readonly ok: boolean;
    readonly profile: BlackBoxRunnerPreflightProfile;
    readonly summary: Readonly<{
        generatedOperationCount: number;
        topLevelOperationCount: number;
        parallelGroupCount: number;
        estimatedArtifactResultRecords: number;
        estimatedArtifactEventRecords: number;
        estimatedArtifactJsonBytes: number;
        postRunAssertionCount: number;
        includeCount: number;
    }>;
    readonly includes: Readonly<{
        resolved: readonly JsonRecord[];
    }>;
    readonly providerModes: readonly string[];
    readonly liveServiceRequirements: readonly string[];
    readonly env: Readonly<{
        required: readonly BlackBoxRunnerEnvRequirement[];
        missing: readonly BlackBoxRunnerEnvRequirement[];
    }>;
    readonly connections: Readonly<{
        defined: readonly string[];
        referenced: readonly string[];
        missing: readonly string[];
    }>;
    readonly stepReferences: Readonly<{
        defined: readonly string[];
        referenced: readonly Readonly<{ name: string; path: string; }>[];
        missing: readonly Readonly<{ name: string; path: string; }>[];
    }>;
    readonly outputs: Readonly<{
        produced: readonly string[];
        consumed: readonly string[];
        missingConsumed: readonly string[];
    }>;
    readonly redactions: Readonly<{
        sources: readonly Readonly<{ kind: 'variable' | 'output'; name: string; redactAs?: string; }>[];
    }>;
    readonly trafficPlan?: Readonly<{
        enabled: boolean;
        replay: boolean;
        seed?: number;
        decisionCount: number;
        stepCount: number;
    }>;
    readonly operations: readonly BlackBoxRunnerPreflightOperation[];
    readonly issues: readonly BlackBoxRunnerPreflightIssue[];
}

export interface BlackBoxRunnerPreflightInput {
    readonly rawConfig: JsonRecord;
    readonly expandedConfig?: JsonRecord;
    readonly executableInteractions?: readonly unknown[];
    readonly envRequirements?: readonly BlackBoxRunnerEnvRequirement[];
    readonly trafficPlanArtifact?: JsonRecord;
    readonly profile?: BlackBoxRunnerPreflightProfile;
    readonly expansionError?: unknown;
}

interface Redaction {
    name: string;
    value: string;
}

export interface BlackBoxRunnerPreflightVariables {
    readonly variables: JsonRecord;
    readonly redactions: Redaction[];
}

interface PreflightReferenceChecks {
    readonly missingEnv: readonly BlackBoxRunnerEnvRequirement[];
    readonly connections: BlackBoxRunnerPlanPreflight['connections'];
    readonly steps: BlackBoxRunnerPlanPreflight['stepReferences'];
    readonly outputs: BlackBoxRunnerPlanPreflight['outputs'];
}

interface PreflightSizeInput {
    readonly config: BlackBoxRunnerPreflightInput;
    readonly operations: readonly BlackBoxRunnerPreflightOperation[];
    readonly includeCount: number;
}

const TRANSPORT_KEYS = ['HTTP', 'MQ', 'WS', 'RTC', 'WEBRTC', 'CRDT', 'ASSERT', 'SET', 'PARALLEL'] as const;
const RESERVED_PLACEHOLDER_ROOTS = new Set([
    'loop',
    'traffic',
    'variables',
    'outputs',
    'results',
    'resultsList',
    'resultsByName',
    'process'
]);

const TRANSFORM_KEYS = new Set([
    'path',
    'from',
    'outputPath',
    'template',
    'concat',
    'coalesce',
    'add',
    'max',
    'equals',
    'lexicallyBefore',
    'get',
    'includes',
    'if',
    'jsonStringify',
    'jsonParse',
    'urlEncode',
    'number',
    'string',
    'boolean',
    'uuid',
    'timestamp',
    'op',
    'operator',
    'type',
    'value',
    'input',
    'values',
    'condition',
    'then',
    'else',
    'format',
    'secret',
    'redact',
    'redactAs',
    'transform'
]);
const TRANSFORM_OPERATOR_KEYS = [
    'path',
    'from',
    'outputPath',
    'template',
    'concat',
    'coalesce',
    'add',
    'max',
    'equals',
    'lexicallyBefore',
    'get',
    'includes',
    'if',
    'jsonStringify',
    'jsonParse',
    'urlEncode',
    'number',
    'string',
    'boolean',
    'uuid',
    'timestamp',
    'op',
    'operator'
];

export function collectBlackBoxRunnerEnvRequirements(
    config: JsonRecord,
    environment: Record<string, string | undefined> = {}
): readonly BlackBoxRunnerEnvRequirement[] {
    const variables = asRecord(config.variables);

    return Object.entries(variables)
        .flatMap(([variableName, value]) => {
            if (!isEnvVariableDescriptor(value)) {
                return [];
            }

            const descriptor = value as JsonRecord;
            const envName = String(descriptor.env ?? descriptor.fromEnv);
            const envValue = environment[envName];
            const hasValue = envValue !== undefined && (envValue.length > 0 || descriptor.allowEmpty === true);
            const hasDefault = descriptor.default !== undefined;
            const hasFallback = descriptor.fallback !== undefined;
            const required = descriptor.required === true;
            const source = hasValue
                ? 'env'
                : hasDefault
                ? 'default'
                : hasFallback
                ? 'fallback'
                : required
                ? 'missing'
                : 'unset';

            return [{
                variableName,
                envName,
                required,
                secret: descriptor.secret === true || descriptor.redact === true,
                hasValue,
                hasDefault,
                hasFallback,
                source
            }];
        });
}

export function resolveBlackBoxRunnerVariablesForPreflight(
    rawVariables: JsonRecord = {},
    environment: Record<string, string | undefined> = {},
    secretVariables: unknown = []
): BlackBoxRunnerPreflightVariables {
    const secrets = toSecretNameSet(secretVariables);
    const variables: JsonRecord = {};
    const redactions: Redaction[] = [];

    Object.entries(rawVariables)
        .forEach(([key, value]) => {
            if (!isEnvVariableDescriptor(value)) {
                variables[key] = value;
                if (secrets.has(key)) {
                    addRedaction(redactions, key, value);
                }
                return;
            }

            const descriptor = value as JsonRecord;
            const envName = String(descriptor.env ?? descriptor.fromEnv);
            const envValue = environment[envName];
            const hasEnvValue = envValue !== undefined && (envValue.length > 0 || descriptor.allowEmpty === true);
            const fallbackValue = descriptor.default !== undefined
                ? descriptor.default
                : descriptor.fallback;
            const resolvedValue = hasEnvValue
                ? envValue
                : fallbackValue !== undefined
                ? fallbackValue
                : `<missing:${envName}>`;

            variables[key] = resolvedValue;

            if (descriptor.secret === true || descriptor.redact === true || secrets.has(key)) {
                addRedaction(redactions, String(descriptor.redactAs || key), resolvedValue);
            }
        });

    return {
        variables,
        redactions
    };
}

export function explainBlackBoxRunnerPlan(input: BlackBoxRunnerPreflightInput): BlackBoxRunnerPlanPreflight {
    const profile = input.profile ?? 'compat';
    const rawConfig = input.rawConfig;
    const expandedConfig = input.expandedConfig ?? rawConfig;
    const executableInteractions = input.executableInteractions ?? [];
    const operations = flattenExecutableOperations(executableInteractions);
    const envRequirements = input.envRequirements ?? collectBlackBoxRunnerEnvRequirements(rawConfig);
    const missingEnv = envRequirements.filter((requirement) =>
        requirement.required && requirement.source === 'missing'
    );
    const connectionSummary = toConnectionPreflight(
        Object.keys(asRecord(rawConfig.connections)),
        toConnectionPreflightSteps(executableInteractions, stopsOnFailure(asRecord(expandedConfig.execution)))
    );
    const stepReferences = stepReferencePreflight(rawConfig);
    const outputSummary = outputPreflight(rawConfig, expandedConfig, operations);
    const redactions = redactionPreflight(rawConfig);
    const includes = includePreflight(expandedConfig);
    const issues = [
        ...validateRecipeShape(input, operations),
        ...validatePreflightReferences({
            missingEnv,
            connections: connectionSummary,
            steps: stepReferences,
            outputs: outputSummary
        })
    ];

    return {
        schemaVersion: 1,
        ok: issues.every((issue) => issue.severity !== 'error'),
        profile,
        summary: toPreflightSize({ config: input, operations, includeCount: includes.resolved.length }),
        includes,
        providerModes: providerModes(rawConfig, operations),
        liveServiceRequirements: liveServiceRequirements(rawConfig, operations, input.trafficPlanArtifact),
        env: {
            required: envRequirements.filter((requirement) => requirement.required),
            missing: missingEnv
        },
        connections: connectionSummary,
        stepReferences,
        outputs: outputSummary,
        redactions,
        trafficPlan: trafficPlanPreflight(input.trafficPlanArtifact),
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

function toPreflightSize(input: PreflightSizeInput): BlackBoxRunnerPlanPreflight['summary'] {
    return {
        generatedOperationCount: input.operations.length,
        topLevelOperationCount: input.config.executableInteractions?.length ?? 0,
        parallelGroupCount: input.operations
            .filter((operation) => operation.transport === 'PARALLEL')
            .reduce((sum, operation) => sum + (operation.groupCount ?? 0), 0),
        estimatedArtifactResultRecords: input.operations.length,
        estimatedArtifactEventRecords: input.operations.length * 2,
        estimatedArtifactJsonBytes: JSON.stringify({
            executableInteractions: input.config.executableInteractions ?? [],
            trafficPlan: input.config.trafficPlanArtifact
        }).length,
        postRunAssertionCount: postRunAssertionCount(input.config.rawConfig),
        includeCount: input.includeCount
    };
}

function validateRecipeShape(
    input: BlackBoxRunnerPreflightInput,
    operations: readonly BlackBoxRunnerPreflightOperation[]
): readonly BlackBoxRunnerPreflightIssue[] {
    const schema = validateBlackBoxRunnerScenarioRecipe(input.rawConfig);
    const issues: BlackBoxRunnerPreflightIssue[] = schema.ok ? [] : schema.errors.map(schemaIssueToPreflightIssue);
    if (input.profile === 'strict') {
        issues.push(...strictProfileIssues(input.rawConfig, operations));
    }
    if (input.expansionError !== undefined) {
        issues.push({ severity: 'error', code: 'PLAN_EXPANSION_FAILED', message: errorMessage(input.expansionError) });
    }
    return issues;
}

function schemaIssueToPreflightIssue(issue: JsonSchemaValidationIssue): BlackBoxRunnerPreflightIssue {
    return {
        severity: 'error',
        code: 'SCHEMA',
        message: issue.message,
        path: issue.path
    };
}

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
    return isRecord(value) ? value : {};
}

function includePreflight(expandedConfig: JsonRecord): BlackBoxRunnerPlanPreflight['includes'] {
    const includeMetadata = asRecord(expandedConfig.includeMetadata);
    const includes = Array.isArray(includeMetadata.includes)
        ? includeMetadata.includes.filter(isRecord)
        : [];

    return {
        resolved: includes
    };
}

function isEnvVariableDescriptor(value: unknown): value is JsonRecord {
    const record = asRecord(value);
    return typeof record.env === 'string' || typeof record.fromEnv === 'string';
}

function toSecretNameSet(secretVariables: unknown): Set<string> {
    if (Array.isArray(secretVariables)) {
        return new Set(secretVariables.map(String));
    }

    if (typeof secretVariables === 'string') {
        return new Set(
            secretVariables
                .split(',')
                .map((value) => value.trim())
                .filter((value) => value.length > 0)
        );
    }

    return new Set();
}

function addRedaction(redactions: Redaction[], name: string, value: unknown): void {
    if (value === undefined || value === null) {
        return;
    }

    const text = String(value);
    if (text.length <= 0 || text.startsWith('<missing:')) {
        return;
    }

    if (!redactions.some((redaction) => redaction.name === name && redaction.value === text)) {
        redactions.push({
            name,
            value: text
        });
    }
}

function uniqueValues(values: readonly string[]): readonly string[] {
    return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function transportKey(interaction: unknown): string | undefined {
    const record = asRecord(interaction);
    return TRANSPORT_KEYS.find((key) => record[key] !== undefined);
}

function interactionName(interaction: unknown): string {
    const record = asRecord(interaction);
    return Object.keys(record)
        .find((key) => !TRANSPORT_KEYS.includes(key as typeof TRANSPORT_KEYS[number])) ?? 'unnamed';
}

function executableRequest(interaction: unknown): JsonRecord {
    const key = transportKey(interaction);
    return key ? asRecord(asRecord(asRecord(interaction)[key]).request) : {};
}

function flattenExecutableOperations(
    interactions: readonly unknown[],
    group?: string
): readonly BlackBoxRunnerPreflightOperation[] {
    return interactions.flatMap((interaction) => {
        const transport = transportKey(interaction) ?? 'UNKNOWN';
        const request = executableRequest(interaction);
        const operation: BlackBoxRunnerPreflightOperation = {
            name: interactionName(interaction),
            transport,
            action: stringValue(request.action),
            connection: stringValue(request.connection),
            provider: stringValue(request.provider ?? request.remoteProvider ?? asRecord(request.control).provider),
            path: stringValue(request.path ?? request.url),
            group,
            interactionExecutionNumber: numberValue(request.interactionExecutionNumber),
            repeatIndex: numberValue(request.repeatIndex)
        };

        if (transport !== 'PARALLEL') {
            return [operation];
        }

        const groups = Array.isArray(request.groups)
            ? request.groups
            : [];
        const children = groups.flatMap((groupSpec) => {
            const groupRecord = asRecord(groupSpec);
            return flattenExecutableOperations(
                Array.isArray(groupRecord.steps) ? groupRecord.steps : [],
                stringValue(groupRecord.name)
            );
        });

        return [
            {
                ...operation,
                groupCount: groups.length
            },
            ...children
        ];
    });
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined;
}

function numberValue(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function stepReferencePreflight(rawConfig: JsonRecord): BlackBoxRunnerPlanPreflight['stepReferences'] {
    const steps = Array.isArray(rawConfig.steps)
        ? rawConfig.steps.map(asRecord)
        : [];
    const defined = uniqueValues(steps.map((step, index) => stepName(step, index)));
    const definedSet = new Set(defined);
    const references: Array<{ name: string; path: string; }> = [];
    const execution = asRecord(rawConfig.execution);
    const soak = asRecord(execution.soak);
    const trafficPlan = asRecord(execution.trafficPlan || rawConfig.trafficPlan);

    collectStepNameReferences(references, soak.setupSteps ?? soak.setup, 'execution.soak.setupSteps');
    collectStepNameReferences(references, soak.loopSteps ?? soak.loop ?? soak.steps, 'execution.soak.loopSteps');
    collectStepNameReferences(references, soak.cleanupSteps ?? soak.cleanup, 'execution.soak.cleanupSteps');
    collectStepNameReferences(
        references,
        trafficPlan.setupSteps ?? trafficPlan.setup,
        'execution.trafficPlan.setupSteps'
    );
    collectStepNameReferences(
        references,
        trafficPlan.cleanupSteps ?? trafficPlan.cleanup,
        'execution.trafficPlan.cleanupSteps'
    );
    if (Array.isArray(trafficPlan.operations)) {
        trafficPlan.operations.forEach((operation, operationIndex) => {
            const operationRecord = asRecord(operation);
            collectStepNameReferences(
                references,
                operationRecord.steps ?? (operationRecord.step === undefined ? undefined : [operationRecord.step]),
                `execution.trafficPlan.operations[${operationIndex}].steps`
            );
        });
    }
    steps.forEach((step, stepIndex) => {
        collectStepNameReferences(
            references,
            step.loopSteps ?? (Array.isArray(step.loop) ? step.loop : undefined),
            `steps[${stepIndex}].loopSteps`
        );
        collectStepNameReferences(
            references,
            step.steps,
            `steps[${stepIndex}].steps`
        );
    });

    return {
        defined,
        referenced: references,
        missing: references.filter((reference) => !definedSet.has(reference.name))
    };
}

function collectStepNameReferences(
    target: Array<{ name: string; path: string; }>,
    value: unknown,
    path: string
): void {
    if (!Array.isArray(value)) {
        return;
    }

    value.forEach((entry, index) => {
        if (typeof entry === 'string') {
            target.push({
                name: entry,
                path: `${path}[${index}]`
            });
        }
    });
}

function stepName(step: JsonRecord, index: number): string {
    return typeof step.name === 'string' && step.name.length > 0
        ? step.name
        : `step-${index + 1}`;
}

function outputPreflight(
    rawConfig: JsonRecord,
    expandedConfig: JsonRecord,
    operations: readonly BlackBoxRunnerPreflightOperation[]
): BlackBoxRunnerPlanPreflight['outputs'] {
    const variableNames = new Set(Object.keys(asRecord(rawConfig.variables)));
    const produced = uniqueValues([
        ...producedOutputsFromSteps(Array.isArray(expandedConfig.steps) ? expandedConfig.steps.map(asRecord) : []),
        ...producedOutputsFromOperations(operations)
    ]);
    const producedSet = new Set(produced);
    const consumed = uniqueValues([
        ...placeholderRoots(rawConfig),
        ...operations.flatMap((operation) => placeholderRoots(operation)),
        ...transformConsumedRoots(rawConfig),
        ...operations.flatMap((operation) => transformConsumedRoots(operation))
    ].filter((root) =>
        !variableNames.has(root) &&
        !RESERVED_PLACEHOLDER_ROOTS.has(root)
    ));

    return {
        produced,
        consumed: consumed.filter((root) => producedSet.has(root)),
        missingConsumed: consumed.filter((root) => !producedSet.has(root))
    };
}

/**
 * A `parallel` step's groups hold ordinary steps, and an output declared inside
 * one resolves for every later step exactly as a top-level output does. Reading
 * only the top level reported every such output as missing.
 */
function producedOutputsFromSteps(steps: readonly JsonRecord[]): readonly string[] {
    return steps.flatMap((step) =>
        [
            stringValue(step.output),
            stringValue(asRecord(step.request).output),
            ...Object.keys(asRecord(step.outputs)),
            ...Object.keys(asRecord(asRecord(step.request).outputs)),
            ...producedOutputsFromSteps(toParallelGroupSteps(step))
        ].filter((output): output is string => Boolean(output))
    );
}

function toParallelGroupSteps(step: JsonRecord): readonly JsonRecord[] {
    const groups = step.groups;
    if (!Array.isArray(groups)) {
        return [];
    }

    return groups.flatMap((group) => {
        const groupSteps = asRecord(group).steps;
        return Array.isArray(groupSteps) ? groupSteps.map(asRecord) : [];
    });
}

function producedOutputsFromOperations(operations: readonly BlackBoxRunnerPreflightOperation[]): readonly string[] {
    return operations.flatMap((operation) =>
        [
            stringValue(asRecord(operation).output)
        ].filter((output): output is string => Boolean(output))
    );
}

function placeholderRoots(value: unknown): readonly string[] {
    const text = JSON.stringify(value);
    if (!text) {
        return [];
    }

    return [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]*)}/g)]
        .map((match) => match[1])
        .map((path) => path.split('.')[0])
        .filter((root) => root.length > 0);
}

function transformConsumedRoots(value: unknown): readonly string[] {
    if (Array.isArray(value)) {
        return value.flatMap(transformConsumedRoots);
    }

    if (!value || typeof value !== 'object') {
        return [];
    }

    const record = asRecord(value);
    const roots: string[] = [];
    if (isTransformOnlySpec(record)) {
        roots.push(...transformPathRoots(record.path, record.from, record.outputPath));
    }

    Object.values(record).forEach((nested) => {
        roots.push(...transformConsumedRoots(nested));
    });

    return roots;
}

function transformPathRoots(...values: readonly unknown[]): readonly string[] {
    return values
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .flatMap((value) => {
            const segments = value.replaceAll(/\[(\d+)]/g, '.$1').split('.').filter(Boolean);
            if (segments[0] === 'outputs' || segments[0] === 'variables') {
                return segments[1] ? [segments[1]] : [];
            }
            return [];
        });
}

function isTransformOnlySpec(record: JsonRecord): boolean {
    const keys = Object.keys(record);
    return keys.length > 0 &&
        TRANSFORM_OPERATOR_KEYS.some((key) => record[key] !== undefined) &&
        keys.every((key) => TRANSFORM_KEYS.has(key));
}

function redactionPreflight(rawConfig: JsonRecord): BlackBoxRunnerPlanPreflight['redactions'] {
    const secrets = toSecretNameSet(rawConfig.secretVariables ?? rawConfig.secrets);
    const variableSources = Object.entries(asRecord(rawConfig.variables))
        .flatMap(([name, value]) => {
            const record = asRecord(value);
            if (secrets.has(name) || record.secret === true || record.redact === true) {
                return [{
                    kind: 'variable' as const,
                    name,
                    redactAs: stringValue(record.redactAs)
                }];
            }
            return [];
        });
    const outputSources = (Array.isArray(rawConfig.steps) ? rawConfig.steps.map(asRecord) : [])
        .flatMap((step, stepIndex) => outputRedactionSources(step, `steps[${stepIndex}]`));

    return {
        sources: [...variableSources, ...outputSources]
    };
}

function outputRedactionSources(
    step: JsonRecord,
    path: string
): readonly Readonly<{ kind: 'output'; name: string; redactAs?: string; }>[] {
    const sources: Array<Readonly<{ kind: 'output'; name: string; redactAs?: string; }>> = [];
    const request = asRecord(step.request);
    const directOutput = stringValue(step.output) ?? stringValue(request.output);
    if (
        directOutput &&
        (step.secret === true || step.redact === true || request.secret === true || request.redact === true)
    ) {
        sources.push({
            kind: 'output',
            name: directOutput,
            redactAs: stringValue(step.redactAs) ?? stringValue(request.redactAs) ?? `${path}.${directOutput}`
        });
    }
    Object.entries({
        ...asRecord(step.outputs),
        ...asRecord(request.outputs)
    }).forEach(([name, spec]) => {
        const record = asRecord(spec);
        if (record.secret === true || record.redact === true) {
            sources.push({
                kind: 'output',
                name,
                redactAs: stringValue(record.redactAs) ?? `${path}.${name}`
            });
        }
    });

    return sources;
}

function providerModes(
    rawConfig: JsonRecord,
    operations: readonly BlackBoxRunnerPreflightOperation[]
): readonly string[] {
    const connectionModes = Object.values(asRecord(rawConfig.connections))
        .map(asRecord)
        .flatMap((connection) => [
            stringValue(connection.provider),
            stringValue(connection.type)
        ]);
    const operationModes = operations.flatMap((operation) => [
        operation.provider,
        ['HTTP', 'MQ', 'WS', 'RTC', 'WEBRTC'].includes(operation.transport)
            ? operation.transport.toLowerCase()
            : undefined
    ]);

    return uniqueValues([
        ...connectionModes,
        ...operationModes
    ].filter((mode): mode is string => Boolean(mode)));
}

function liveServiceRequirements(
    rawConfig: JsonRecord,
    operations: readonly BlackBoxRunnerPreflightOperation[],
    trafficPlanArtifact: JsonRecord | undefined
): readonly string[] {
    const providers = new Set(providerModes(rawConfig, operations));
    const transports = new Set(operations.map((operation) => operation.transport));
    const requirements: string[] = ['local black-box-runner process'];

    if (transports.has('HTTP')) {
        requirements.push('reachable HTTP endpoints for HTTP steps');
    }
    if (transports.has('WS')) {
        requirements.push('reachable WebSocket endpoint and any required ticket/token for WS steps');
    }
    if (transports.has('RTC') || transports.has('WEBRTC')) {
        requirements.push('configured RTC provider for RTC steps');
    }
    if (providers.has('rallar') || providers.has('rallar-browser')) {
        requirements.push('live Rallar API/signaling environment for browser-backed Rallar RTC');
    }
    if (providers.has('rallar-remote-browser')) {
        requirements.push('Rallar black-box control server with connected browser agent');
    }
    if (providers.has('rallar-memory') || providers.has('rallar-stub')) {
        requirements.push('deterministic in-process RTC provider');
    }
    if (trafficPlanArtifact) {
        requirements.push('expanded traffic plan artifact for replay/debug');
    }

    return uniqueValues(requirements);
}

function trafficPlanPreflight(
    artifact: JsonRecord | undefined
): BlackBoxRunnerPlanPreflight['trafficPlan'] {
    if (!artifact) {
        return undefined;
    }

    return {
        enabled: true,
        replay: artifact.replay === true,
        seed: numberValue(artifact.seed),
        decisionCount: Array.isArray(artifact.decisions) ? artifact.decisions.length : 0,
        stepCount: Array.isArray(artifact.steps) ? artifact.steps.length : 0
    };
}

function postRunAssertionCount(rawConfig: JsonRecord): number {
    const execution = asRecord(rawConfig.execution);
    return postRunAssertionSourceCount(rawConfig.postRunAssertions) +
        postRunAssertionSourceCount(execution.postRunAssertions) +
        postRunAssertionSourceCount(execution.thresholds);
}

function postRunAssertionSourceCount(value: unknown): number {
    if (Array.isArray(value)) {
        return value.length;
    }

    const record = asRecord(value);
    if (Object.keys(record).length <= 0) {
        return 0;
    }

    return isPostRunAssertionSpec(record)
        ? 1
        : Object.keys(record).length;
}

function isPostRunAssertionSpec(record: JsonRecord): boolean {
    return record.path !== undefined ||
        record.metric !== undefined ||
        record.from !== undefined ||
        record.actual !== undefined ||
        record.operator !== undefined ||
        record.op !== undefined ||
        [
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
        ].some((key) => record[key] !== undefined);
}

function strictProfileIssues(
    rawConfig: JsonRecord,
    operations: readonly BlackBoxRunnerPreflightOperation[]
): readonly BlackBoxRunnerPreflightIssue[] {
    const steps = Array.isArray(rawConfig.steps) ? rawConfig.steps.map(asRecord) : [];
    return [
        ...steps.flatMap((step, index) => validateStrictStep(step, `steps[${index}]`)),
        ...operations
            .filter((operation) => operation.transport === 'HTTP' && !operation.path)
            .map((operation): BlackBoxRunnerPreflightIssue => ({
                severity: 'error',
                code: 'STRICT_HTTP_TARGET',
                message:
                    `Strict HTTP operation ${operation.name} requires request.path, request.url, or connection.url.`,
                path: operation.name
            }))
    ];
}

function validateStrictStep(step: JsonRecord, path: string): readonly BlackBoxRunnerPreflightIssue[] {
    const type = String(step.type || '').toLowerCase();
    const issues: BlackBoxRunnerPreflightIssue[] = [];
    if (type.length > 0 && !isKnownStepType(type)) {
        issues.push({
            severity: 'error',
            code: 'STRICT_UNKNOWN_STEP_TYPE',
            message: `Unknown strict step type ${type}.`,
            path: `${path}.type`
        });
    }
    if (type.startsWith('set') || type.startsWith('derive')) {
        issues.push(...validateStrictSet(step, path));
    }
    if (type.startsWith('assert')) {
        const expected = asRecord(step.expect || step.response);
        const hasExpected = expected.body !== undefined || expected.expect !== undefined ||
            expected.expected !== undefined || Array.isArray(expected.anyOf) || Array.isArray(expected.comparators);
        if (!hasExpected) {
            issues.push({
                severity: 'error',
                code: 'STRICT_ASSERT_EXPECTED',
                message: 'Strict assert steps need an expected value or expect.comparators.',
                path
            });
        }
    }
    issues.push(...validateStrictExpectIsHonoured(step, type, path));
    issues.push(...validateStrictExpectIsNotVacuous(step, path));
    return issues;
}

/**
 * Assertion keys a WebSocket send never reads. `sendWs` dispatches on
 * `expect.messages` and `expect.message` only, so these two describe a check
 * the runner will not perform. Wait plumbing (`connection`, `withinMs`,
 * `consume`) is deliberately absent from this list: those are honoured
 * elsewhere on the step and flagging them would be noise, not a finding.
 *
 * A `parallel` step is no longer listed here at all. Its `expect` is compared
 * against the aggregate, so flagging it would block the capability rather than
 * report a dropped one.
 */
const WS_SEND_IGNORED_ASSERTION_KEYS = ['absent', 'close'];

function validateStrictExpectIsHonoured(
    step: JsonRecord,
    type: string,
    path: string
): readonly BlackBoxRunnerPreflightIssue[] {
    const expected = asRecord(step.expect || step.response);
    const expectedKeys = Object.keys(expected);
    if (expectedKeys.length <= 0) {
        return [];
    }

    const action = String(asRecord(step.request).action || '').toLowerCase();
    const isWsSend = type.startsWith('ws') && (action === 'send' || action.length <= 0);
    if (!isWsSend) {
        return [];
    }

    return expectedKeys
        .filter((key) => WS_SEND_IGNORED_ASSERTION_KEYS.includes(key))
        .map((key): BlackBoxRunnerPreflightIssue => ({
            severity: 'error',
            code: 'STRICT_EXPECT_IGNORED',
            message: `WebSocket send steps read only expect.message and expect.messages; expect.${key} is ignored. ` +
                'Use a ws.wait step for it.',
            path: `${path}.expect.${key}`
        }));
}

/**
 * `compatible` and `compatible-structure` match an empty expected array against
 * any actual array, so an empty one asserts nothing at all. The stricter modes
 * reject it, which is what makes the mode part of the check rather than the
 * array alone.
 */
const VACUOUS_ARRAY_COMPARISONS = ['', 'compatible', 'compatible-structure'];

function validateStrictExpectIsNotVacuous(
    step: JsonRecord,
    path: string
): readonly BlackBoxRunnerPreflightIssue[] {
    const expected = asRecord(step.expect || step.response);
    const comparison = String(expected.comparison || '').toLowerCase();
    if (!VACUOUS_ARRAY_COMPARISONS.includes(comparison)) {
        return [];
    }

    return toEmptyArrayPaths(expected.body, `${path}.expect.body`)
        .map((emptyPath): BlackBoxRunnerPreflightIssue => ({
            severity: 'error',
            code: 'STRICT_EXPECT_VACUOUS',
            message: 'An empty expected array matches anything under compatible; ' +
                'use compatible-complete or a non-empty expectation.',
            path: emptyPath
        }));
}

function toEmptyArrayPaths(value: unknown, path: string): readonly string[] {
    if (Array.isArray(value)) {
        return value.length <= 0
            ? [path]
            : value.flatMap((item, index) => toEmptyArrayPaths(item, `${path}[${index}]`));
    }

    return isRecord(value)
        ? Object.entries(value).flatMap(([key, item]) => toEmptyArrayPaths(item, `${path}.${key}`))
        : [];
}

function validateStrictSet(step: JsonRecord, path: string): readonly BlackBoxRunnerPreflightIssue[] {
    const request = asRecord(step.request);
    const output = step.output ?? request.output;
    const stateWriteEvidence = step.stateWriteEvidence ?? request.stateWriteEvidence;
    const issues: BlackBoxRunnerPreflightIssue[] = [];
    if (output === 'stateWriteEvidence' && !isRecord(stateWriteEvidence)) {
        issues.push({
            severity: 'error',
            code: 'STRICT_STATE_WRITE_EVIDENCE_SOURCE',
            message: 'Strict stateWriteEvidence must come from the persisted-state collector.',
            path
        });
    }
    if (typeof output !== 'string') {
        issues.push({
            severity: 'error',
            code: 'STRICT_SET_OUTPUT',
            message: 'Strict set steps require output.',
            path
        });
    }
    if (
        step.value === undefined && request.value === undefined &&
        step.transform === undefined && request.transform === undefined &&
        step.derive === undefined && request.derive === undefined && stateWriteEvidence === undefined
    ) {
        issues.push({
            severity: 'error',
            code: 'STRICT_SET_VALUE',
            message: 'Strict set steps require value, request.value, transform, or request.transform.',
            path
        });
    }
    return issues;
}

function isKnownStepType(type: string): boolean {
    return [
        'http',
        'http.request',
        'ws',
        'ws.open',
        'ws.send',
        'ws.wait',
        'ws.close',
        'rtc',
        'rtc.connect',
        'rtc.send',
        'rtc.wait',
        'rtc.close',
        'webrtc',
        'crdt',
        'crdt.open',
        'crdt.apply',
        'crdt.read',
        'crdt.sync',
        'crdt.health',
        'crdt.wait',
        'crdt.undo',
        'crdt.redo',
        'crdt.close',
        'crdt.destroy',
        'assert',
        'set',
        'derive',
        'parallel',
        'loop'
    ].some((known) => type === known || type.startsWith(`${known}.`));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toConnectionPreflightSteps(
    interactions: NonNullable<BlackBoxRunnerPreflightInput['executableInteractions']>,
    failureStops: boolean
): ConnectionPreflightStep[] {
    return interactions.map((interaction) => {
        const request = executableRequest(interaction);
        const transport = transportKey(interaction);
        const groups = transport === 'PARALLEL' && Array.isArray(request.groups) ? request.groups : [];
        const output = stringValue(request.output);
        const writtenOutputs = [...Object.keys(asRecord(request.outputs)), ...(output ? [output] : [])];
        const writesAllOutputs = writtenOutputs.some((name) => /[{}]/.test(name)) ||
            (request.outputs !== undefined && !isRecord(request.outputs));
        const selectionCanBeTrusted = failureStops && stopsOnFailure(request) && !writesAllOutputs;
        return {
            connection: stringValue(request.connection),
            writtenOutputs,
            writesAllOutputs,
            selection: transport === 'SET' && selectionCanBeTrusted ? toBoundedConnectionSelection(request) : undefined,
            groups: groups.map((group) => {
                const steps = asRecord(group).steps;
                return toConnectionPreflightSteps(
                    Array.isArray(steps) ? steps : [],
                    stopsOnFailure(request)
                );
            })
        };
    });
}

function toBoundedConnectionSelection(request: JsonRecord): ConnectionSelection | undefined {
    const output = stringValue(request.output);
    if (!output || Object.hasOwn(asRecord(request.outputs), output)) {
        return undefined;
    }
    if (request.transform === undefined && request.outputPath) {
        return undefined;
    }
    const transform = asRecord(request.transform === undefined ? request.derive : request.transform);
    if (Object.keys(transform).length !== 1 || transform.if === undefined) {
        return undefined;
    }
    const branches = asRecord(transform.if);
    if (branches.condition === undefined) {
        return undefined;
    }
    const whenTrue = toLiteralConnection(asRecord(branches.then));
    const whenFalse = toLiteralConnection(asRecord(branches.else));
    return whenTrue && whenFalse ? { output, connections: [...new Set([whenTrue, whenFalse])] } : undefined;
}

function toLiteralConnection(branch: JsonRecord): string | undefined {
    if (directSafeOutputTransformSpec(branch) !== undefined) {
        return undefined;
    }
    const connection = branch.connection;
    return typeof connection === 'string' && connection.length > 0 && !/[{}]/.test(connection) ? connection : undefined;
}

function stopsOnFailure(request: JsonRecord): boolean {
    return (request.failFast === undefined || request.failFast === true) &&
        (request.nonBlockingFailure === undefined || request.nonBlockingFailure === false);
}
