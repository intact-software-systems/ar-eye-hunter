import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ScenarioInput } from '../scenario-algorithm.ts';

export interface ScenarioRecipe extends ScenarioInput {
    variables?: Record<string, unknown>;
    execution?: Record<string, unknown>;
    steps?: Array<Record<string, unknown>>;
    fragments?: Record<string, unknown>;
    includeMetadata?: Record<string, unknown>;
    trafficPlan?: Record<string, unknown>;
    postRunAssertions?: unknown;
    secrets?: unknown;
    secretVariables?: unknown;
}

export interface ScenarioRecipeIncludes {
    readonly config: ScenarioRecipe;
    readonly includes: readonly Record<string, unknown>[];
}

interface IncludeReference {
    readonly key?: string;
    readonly path?: string;
    readonly variables: Record<string, unknown>;
    readonly namePrefix?: string;
    readonly nameSuffix?: string;
}

interface IncludeLocation {
    readonly parentFilePath: string;
    readonly stack: readonly string[];
}

interface RecipeIncludeRead {
    readonly rootDir: string;
    readonly inlineFragments: Record<string, unknown>;
    readonly includes: Record<string, unknown>[];
    readonly variables: Record<string, unknown>;
    readonly connections: Record<string, unknown>;
    readonly defaults: Record<string, unknown>;
}

interface RecipeFragmentRead {
    readonly value: unknown;
    readonly source: string;
    readonly filePath: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function isRemoteIncludePath(value: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
}

function includeReference(
    value: unknown
): IncludeReference {
    if (typeof value === 'string') {
        return {
            key: value,
            variables: {}
        };
    }

    const record = asRecord(value);
    return {
        key: stringValue(record.fragment) ?? stringValue(record.name) ?? stringValue(record.id),
        path: stringValue(record.path) ?? stringValue(record.file) ?? stringValue(record.recipe),
        variables: asRecord(record.variables),
        namePrefix: stringValue(record.namePrefix),
        nameSuffix: stringValue(record.nameSuffix)
    };
}

function parseIncludeFile(filePath: string): unknown {
    const text = readFileSync(filePath, 'utf8');
    return JSON.parse(text);
}

function resolveIncludeFilePath(includePath: string, parentFilePath: string, rootDir: string): string {
    if (isRemoteIncludePath(includePath)) {
        throw new Error('Remote includes are not allowed by default: ' + includePath);
    }

    if (path.isAbsolute(includePath)) {
        throw new Error('Absolute include paths are not allowed: ' + includePath);
    }

    const resolved = path.resolve(path.dirname(parentFilePath), includePath);
    const relative = path.relative(rootDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Include path escapes recipe root: ' + includePath);
    }

    return resolved;
}

function applyIncludeVariables<T>(value: T, variables: JsonRecord): T {
    if (typeof value === 'string') {
        const exact = value.match(/^\{([^{}]+)}$/);
        if (exact && Object.prototype.hasOwnProperty.call(variables, exact[1])) {
            return variables[exact[1]] as T;
        }

        return value.replaceAll(/\{([^{}]+)}/g, (match, key) => {
            return Object.prototype.hasOwnProperty.call(variables, key)
                ? String(variables[key])
                : match;
        }) as T;
    }

    if (Array.isArray(value)) {
        return value.map((item) => applyIncludeVariables(item, variables)) as T;
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, applyIncludeVariables(nested, variables)])
        ) as T;
    }

    return value;
}

function withIncludeNameAffixes(step: JsonRecord, prefix?: string, suffix?: string): JsonRecord {
    if (!prefix && !suffix) {
        return step;
    }

    const name = stringValue(step.name);
    const withName = name
        ? {
            ...step,
            name: `${prefix || ''}${name}${suffix || ''}`
        }
        : step;

    return {
        ...withName,
        ...(Array.isArray(withName.steps)
            ? {
                steps: withName.steps.map((child) => asRecord(child)).map((child) =>
                    withIncludeNameAffixes(child, prefix, suffix)
                )
            }
            : {}),
        ...(Array.isArray(withName.loopSteps)
            ? {
                loopSteps: withName.loopSteps.map((child) => asRecord(child)).map((child) =>
                    withIncludeNameAffixes(child, prefix, suffix)
                )
            }
            : {}),
        ...(Array.isArray(withName.groups)
            ? {
                groups: withName.groups.map((group) => {
                    const groupRecord = asRecord(group);
                    return {
                        ...groupRecord,
                        steps: Array.isArray(groupRecord.steps)
                            ? groupRecord.steps.map((child) => asRecord(child)).map((child) =>
                                withIncludeNameAffixes(child, prefix, suffix)
                            )
                            : groupRecord.steps
                    };
                })
            }
            : {})
    };
}

function fragmentSteps(value: unknown): JsonRecord[] {
    if (Array.isArray(value)) {
        return value.filter(isJsonRecord);
    }

    const record = asRecord(value);
    return asArray(record.steps).filter(isJsonRecord);
}

function isJsonRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readScenarioRecipeIncludes(
    config: ScenarioRecipe,
    configPath: string,
    rootDir: string
): ScenarioRecipeIncludes {
    const read: RecipeIncludeRead = {
        rootDir,
        inlineFragments: asRecord(config.fragments),
        includes: [],
        variables: {},
        connections: {},
        defaults: {}
    };
    const steps = Array.isArray(config.steps)
        ? readRecipeSteps(config.steps, { parentFilePath: configPath, stack: [] }, read)
        : undefined;
    return {
        config: {
            ...config,
            variables: { ...read.variables, ...asRecord(config.variables) },
            connections: { ...read.connections, ...asRecord(config.connections) },
            defaults: { ...read.defaults, ...asRecord(config.defaults) },
            ...(steps ? { steps } : {}),
            fragments: undefined,
            includeMetadata: {
                schemaVersion: 1,
                configPath: path.relative(rootDir, configPath),
                includes: read.includes
            }
        },
        includes: read.includes
    };
}

function readRecipeFragment(
    reference: IncludeReference,
    location: IncludeLocation,
    read: RecipeIncludeRead
): RecipeFragmentRead {
    const key = reference.key;
    if (key && Object.hasOwn(read.inlineFragments, key)) {
        const source = 'fragment:' + key;
        assertNoIncludeCycle(source, location.stack);
        return { value: cloneJson(read.inlineFragments[key]), source, filePath: location.parentFilePath };
    }
    const includePath = reference.path ?? key;
    if (!includePath) {
        throw new Error('Include step must specify a fragment name or local path.');
    }
    const filePath = resolveIncludeFilePath(includePath, location.parentFilePath, read.rootDir);
    const source = 'file:' + path.relative(read.rootDir, filePath);
    assertNoIncludeCycle(source, location.stack);
    try {
        return { value: parseIncludeFile(filePath), source, filePath };
    }
    catch (caught) {
        throw new Error(
            'Failed to load include ' + includePath + ': ' + (caught instanceof Error ? caught.message : String(caught))
        );
    }
}

function assertNoIncludeCycle(source: string, stack: readonly string[]): void {
    if (stack.includes(source)) {
        throw new Error('Circular include detected: ' + [...stack, source].join(' -> '));
    }
}

function readRecipeSteps(steps: readonly unknown[], location: IncludeLocation, read: RecipeIncludeRead): JsonRecord[] {
    const expanded: JsonRecord[] = [];
    for (const [stepIndex, step] of steps.entries()) {
        const record = asRecord(step);
        if (!record.include) {
            expanded.push(readNestedRecipeIncludes(record, location, read));
            continue;
        }
        const reference = includeReference(record.include);
        const mergedReference = {
            ...reference,
            variables: { ...reference.variables, ...asRecord(record.variables) },
            namePrefix: reference.namePrefix ?? stringValue(record.namePrefix),
            nameSuffix: reference.nameSuffix ?? stringValue(record.nameSuffix)
        };
        const fragment = readRecipeFragment(mergedReference, location, read);
        const fragmentRecord = asRecord(fragment.value);
        Object.assign(read.variables, asRecord(fragmentRecord.variables));
        Object.assign(read.connections, asRecord(fragmentRecord.connections));
        Object.assign(read.defaults, asRecord(fragmentRecord.defaults));
        const variables = { ...asRecord(fragmentRecord.variables), ...mergedReference.variables };
        const fragmentLocation = { parentFilePath: fragment.filePath, stack: [...location.stack, fragment.source] };
        const expandedFragmentSteps = readRecipeSteps(fragmentSteps(fragment.value), fragmentLocation, read)
            .map((fragmentStep) => applyIncludeVariables(fragmentStep, variables))
            .map((fragmentStep) =>
                withIncludeNameAffixes(fragmentStep, mergedReference.namePrefix, mergedReference.nameSuffix)
            );
        read.includes.push({
            source: fragment.source,
            path: reference.path ?? reference.key,
            parent: path.relative(read.rootDir, location.parentFilePath),
            stepIndex,
            stepCount: expandedFragmentSteps.length
        });
        expanded.push(...expandedFragmentSteps);
    }
    return expanded;
}

function readNestedRecipeIncludes(step: JsonRecord, location: IncludeLocation, read: RecipeIncludeRead): JsonRecord {
    const expanded = { ...step };
    for (const field of ['steps', 'loopSteps', 'setupSteps', 'cleanupSteps']) {
        if (Array.isArray(step[field])) {
            expanded[field] = readRecipeSteps(step[field], location, read);
        }
    }
    if (Array.isArray(step.groups)) {
        expanded.groups = step.groups.map((group) => {
            const record = asRecord(group);
            return {
                ...record,
                ...(Array.isArray(record.steps) ? { steps: readRecipeSteps(record.steps, location, read) } : {})
            };
        });
    }
    return expanded;
}
