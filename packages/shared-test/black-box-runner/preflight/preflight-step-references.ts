import type {
    ApiJsonObject,
    ApiJsonValue
} from '../../../shared/api/api-json-value.ts';

import {
    isPreflightJsonObject,
    toNonEmptyText,
    toPreflightJsonArray,
    toPreflightJsonObject,
    toUniqueSortedTexts
} from './preflight-json-values.ts';
import type { BlackBoxRunnerPreflightOperation } from './preflight-operations.ts';

export interface BlackBoxRunnerPreflightStepReference {
    readonly name: string;
    readonly path: string;
}

export interface BlackBoxRunnerPreflightStepReferences {
    readonly defined: readonly string[];
    readonly referenced: readonly BlackBoxRunnerPreflightStepReference[];
    readonly missing: readonly BlackBoxRunnerPreflightStepReference[];
}

export interface BlackBoxRunnerPreflightOutputs {
    readonly produced: readonly string[];
    readonly consumed: readonly string[];
    readonly missingConsumed: readonly string[];
}

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

const TRANSFORM_KEYS = new Set([
    ...TRANSFORM_OPERATOR_KEYS,
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

/** Soak, traffic-plan and loop step lists name earlier steps; a name that no step defines is missing. */
export function computeStepReferencePreflight(rawConfig: ApiJsonObject): BlackBoxRunnerPreflightStepReferences {
    const steps = toPreflightJsonArray(rawConfig.steps).map(toPreflightJsonObject);
    const defined = toUniqueSortedTexts(steps.map((step, index) => resolveStepName(step, index)));
    const definedSet = new Set(defined);
    const execution = toPreflightJsonObject(rawConfig.execution);
    const soak = toPreflightJsonObject(execution.soak);
    const trafficPlan = toPreflightJsonObject(execution.trafficPlan || rawConfig.trafficPlan);
    const referenced = [
        ...toStepNameReferences(soak.setupSteps ?? soak.setup, 'execution.soak.setupSteps'),
        ...toStepNameReferences(soak.loopSteps ?? soak.loop ?? soak.steps, 'execution.soak.loopSteps'),
        ...toStepNameReferences(soak.cleanupSteps ?? soak.cleanup, 'execution.soak.cleanupSteps'),
        ...toStepNameReferences(trafficPlan.setupSteps ?? trafficPlan.setup, 'execution.trafficPlan.setupSteps'),
        ...toStepNameReferences(trafficPlan.cleanupSteps ?? trafficPlan.cleanup, 'execution.trafficPlan.cleanupSteps'),
        ...toPreflightJsonArray(trafficPlan.operations).flatMap((operation, operationIndex) => {
            const record = toPreflightJsonObject(operation);
            return toStepNameReferences(
                record.steps ?? (record.step === undefined ? undefined : [record.step]),
                `execution.trafficPlan.operations[${operationIndex}].steps`
            );
        }),
        ...steps.flatMap((step, stepIndex) => [
            ...toStepNameReferences(
                step.loopSteps ?? (Array.isArray(step.loop) ? step.loop : undefined),
                `steps[${stepIndex}].loopSteps`
            ),
            ...toStepNameReferences(step.steps, `steps[${stepIndex}].steps`)
        ])
    ];
    return {
        defined,
        referenced,
        missing: referenced.filter((reference) => !definedSet.has(reference.name))
    };
}

/** A placeholder or transform path consumes an output unless a variable or a reserved root owns its name. */
export function computeOutputPreflight(
    rawConfig: ApiJsonObject,
    expandedConfig: ApiJsonObject,
    operations: readonly BlackBoxRunnerPreflightOperation[]
): BlackBoxRunnerPreflightOutputs {
    const variableNames = new Set(Object.keys(toPreflightJsonObject(rawConfig.variables)));
    const produced = toUniqueSortedTexts(
        toProducedStepOutputs(toPreflightJsonArray(expandedConfig.steps).map(toPreflightJsonObject))
    );
    const producedSet = new Set(produced);
    const consumed = toUniqueSortedTexts([
        ...toPlaceholderRoots(rawConfig),
        ...operations.flatMap((operation) => toPlaceholderRoots(operation)),
        ...toTransformConsumedRoots(rawConfig)
    ].filter((root) => !variableNames.has(root) && !RESERVED_PLACEHOLDER_ROOTS.has(root)));
    return {
        produced,
        consumed: consumed.filter((root) => producedSet.has(root)),
        missingConsumed: consumed.filter((root) => !producedSet.has(root))
    };
}

function toStepNameReferences(
    value: ApiJsonValue | undefined,
    path: string
): readonly BlackBoxRunnerPreflightStepReference[] {
    return toPreflightJsonArray(value).flatMap((entry, index) =>
        typeof entry === 'string' ? [{ name: entry, path: `${path}[${index}]` }] : []
    );
}

function resolveStepName(step: ApiJsonObject, index: number): string {
    return typeof step.name === 'string' && step.name.length > 0
        ? step.name
        : `step-${index + 1}`;
}

/**
 * A `parallel` step's groups hold ordinary steps, and an output declared inside
 * one resolves for every later step exactly as a top-level output does. Reading
 * only the top level reported every such output as missing.
 */
function toProducedStepOutputs(steps: readonly ApiJsonObject[]): readonly string[] {
    return steps.flatMap((step) =>
        [
            toNonEmptyText(step.output),
            toNonEmptyText(toPreflightJsonObject(step.request).output),
            ...Object.keys(toPreflightJsonObject(step.outputs)),
            ...Object.keys(toPreflightJsonObject(toPreflightJsonObject(step.request).outputs)),
            ...toProducedStepOutputs(toParallelGroupSteps(step))
        ].filter((output): output is string => Boolean(output))
    );
}

function toParallelGroupSteps(step: ApiJsonObject): readonly ApiJsonObject[] {
    return toPreflightJsonArray(step.groups).flatMap((group) =>
        toPreflightJsonArray(toPreflightJsonObject(group).steps).map(toPreflightJsonObject)
    );
}

function toPlaceholderRoots(value: ApiJsonObject | BlackBoxRunnerPreflightOperation): readonly string[] {
    return [...JSON.stringify(value).matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]*)}/g)]
        .map((match) => match[1].split('.')[0])
        .filter((root) => root.length > 0);
}

function toTransformConsumedRoots(value: ApiJsonValue): readonly string[] {
    if (Array.isArray(value)) {
        return value.flatMap(toTransformConsumedRoots);
    }
    if (!isPreflightJsonObject(value)) {
        return [];
    }
    return [
        ...(isTransformOnlySpec(value) ? toTransformPathRoots([value.path, value.from, value.outputPath]) : []),
        ...Object.values(value).flatMap(toTransformConsumedRoots)
    ];
}

function toTransformPathRoots(values: readonly (ApiJsonValue | undefined)[]): readonly string[] {
    return values
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .flatMap((value) => {
            const segments = value.replaceAll(/\[(\d+)]/g, '.$1').split('.').filter(Boolean);
            return (segments[0] === 'outputs' || segments[0] === 'variables') && segments[1] ? [segments[1]] : [];
        });
}

function isTransformOnlySpec(record: ApiJsonObject): boolean {
    const keys = Object.keys(record);
    return keys.length > 0 &&
        TRANSFORM_OPERATOR_KEYS.some((key) => record[key] !== undefined) &&
        keys.every((key) => TRANSFORM_KEYS.has(key));
}
