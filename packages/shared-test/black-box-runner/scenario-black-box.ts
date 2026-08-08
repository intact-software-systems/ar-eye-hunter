import * as sync from './execute-black-box.ts';
import { compareJson, COMPARISON, toConfig } from '../json-compare/CompareJson.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ScenarioInput } from './scenario-algorithm.ts';
import * as scenarioAlgorithms from './scenario-algorithm.ts';
import { collectApiV1StateWriteEvidence } from './api-v1-state-write-evidence.ts';
import * as artifactBounds from './artifacts/with-bounded-artifact-report-results.ts';
import {
    collectBlackBoxRunnerEnvRequirements,
    explainBlackBoxRunnerPlan,
    resolveBlackBoxRunnerVariablesForPreflight,
    type BlackBoxRunnerPreflightProfile,
} from './preflight/plan-preflight.ts';
import utils from './utils.ts';
type CliOptions = {
    config: string
    workingDirectory?: string
    replace?: string
    execution?: string
    dryRun?: boolean
    artifactDir?: string
    iterations?: string
    durationMs?: string
    delayMs?: string
    explain?: boolean
    validate?: boolean
    profile?: string
    strict?: boolean
}

function printHelp(): void {
    console.log('');
    console.log('Example calls:');
    console.log('  $ scenario-generate --config config.json');
    console.log('  $ scenario-generate -c config.json');
    console.log('  $ scenario-generate -c config.json -e dry');
    console.log('  $ scenario-generate -c config.json --dry-run');
    console.log('  $ scenario-generate -c config.json --explain');
    console.log('  $ scenario-generate -c config.json --validate --strict');
    console.log('  $ scenario-generate -c config.json --artifact-dir .artifacts/black-box-run');
    console.log('  $ scenario-generate -c config.json --iterations 10 --artifact-dir .artifacts/black-box-scale');
    console.log('  $ scenario-generate -c config.json -n');
    console.log('  $ scenario-generate --config config.json --replace url:=http://localhost:8080/led/api/v1,valuDate:=2022-10-01');
    console.log('  $ scenario-generate -c config.json -r url:=http://localhost:8080/led/api/v1,valuDate:=2022-10-01');
    console.log('  $ scenario-generate -c config.json -w ./test-data -r url:=http://localhost:8080/led/api/v1,valuDate:=2022-10-01');
}

function readOptionValue(args: readonly string[], index: number, option: string): string {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
        throw new Error('Missing value for ' + option);
    }

    return value;
}

function parseCliOptions(args: readonly string[]): CliOptions {
    const options: Partial<CliOptions> = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const [option, inlineValue] = arg.includes('=')
            ? arg.split(/=(.*)/s, 2)
            : [arg, undefined];

        switch (option) {
            case '-h':
            case '--help':
                printHelp();
                process.exit(0);
            case '-c':
            case '--config':
                options.config = inlineValue ?? readOptionValue(args, i, option);
                if (inlineValue === undefined) {
                    i++;
                }
                break;
            case '-w':
            case '--workingDirectory':
                options.workingDirectory = inlineValue ?? readOptionValue(args, i, option);
                if (inlineValue === undefined) {
                    i++;
                }
                break;
            case '-r':
            case '--replace':
                options.replace = inlineValue ?? readOptionValue(args, i, option);
                if (inlineValue === undefined) {
                    i++;
                }
                break;
            case '-e':
            case '--execution':
                options.execution = inlineValue ?? readOptionValue(args, i, option);
                if (inlineValue === undefined) {
                    i++;
                }
                break;
            case '-n':
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--explain':
                options.explain = true;
                break;
            case '--validate':
                options.validate = true;
                break;
            case '--strict':
                options.strict = true;
                options.profile = 'strict';
                break;
            case '--profile':
            case '--validation-profile':
                options.profile = inlineValue ?? readOptionValue(args, i, option);
                if (inlineValue === undefined) {
                    i++;
                }
                break;
            case '--artifact-dir':
            case '--artifacts':
            case '--record-dir':
                options.artifactDir = inlineValue ?? readOptionValue(args, i, option);
                if (inlineValue === undefined) {
                    i++;
                }
                break;
            case '--iterations':
            case '--runs':
                options.iterations = inlineValue ?? readOptionValue(args, i, option);
                if (inlineValue === undefined) {
                    i++;
                }
                break;
            case '--duration-ms':
            case '--max-duration-ms':
                options.durationMs = inlineValue ?? readOptionValue(args, i, option);
                if (inlineValue === undefined) {
                    i++;
                }
                break;
            case '--delay-ms':
            case '--scale-delay-ms':
                options.delayMs = inlineValue ?? readOptionValue(args, i, option);
                if (inlineValue === undefined) {
                    i++;
                }
                break;
            default:
                break;
        }
    }

    if (!options.config) {
        console.error('Missing required option: -c, --config <config>');
        printHelp();
        process.exit(1);
    }

    return options as CliOptions;
}

const cliOptions = parseCliOptions(process.argv.slice(2));

utils.setWorkingDirectory(cliOptions.workingDirectory || '.');

type JsonRecord = Record<string, unknown>

type ScenarioCliConfig = ScenarioInput & {
    variables?: JsonRecord
    execution?: JsonRecord
    steps?: Array<JsonRecord>
    fragments?: JsonRecord
    includeMetadata?: JsonRecord
    trafficPlan?: JsonRecord
    postRunAssertions?: unknown
    secrets?: unknown
    secretVariables?: unknown
}

type ExecutableBuildState = {
    nextInteractionExecutionNumber: number
}

type TrafficPlanArtifact = {
    version: number
    seed: number
    replay: boolean
    generator: JsonRecord
    decisions: Array<JsonRecord>
    steps: Array<JsonRecord>
    replayRecipe: JsonRecord
}

type ArtifactEventRecord = JsonRecord & {
    kind: string
    sequence: number
}

type ArtifactEventSelection = {
    allEvents: ArtifactEventRecord[]
    emittedEvents: ArtifactEventRecord[]
    index: JsonRecord
}

const preflightMode = cliOptions.explain === true || cliOptions.validate === true;
const preflightProfile: BlackBoxRunnerPreflightProfile =
    cliOptions.strict === true || cliOptions.profile === 'strict'
        ? 'strict'
        : 'compat';
const recipeRootDir = path.resolve(cliOptions.workingDirectory || '.');
const recipeConfigPath = path.resolve(recipeRootDir, cliOptions.config);
const rawInput = utils.openFile(cliOptions.config) as ScenarioCliConfig;

type IncludeExpansionResult = {
    config: ScenarioCliConfig
    includes: JsonRecord[]
}

let includeExpansion: IncludeExpansionResult;
let includeExpansionError: unknown;

try {
    includeExpansion = expandStaticRecipeIncludes(rawInput, recipeConfigPath, recipeRootDir);
} catch (caught) {
    if (!preflightMode) {
        throw caught;
    }

    includeExpansionError = caught;
    includeExpansion = {
        config: rawInput,
        includes: [],
    };
}

const input = includeExpansion.config;
const cliReplacements = utils.inputReplacesToJson(cliOptions.replace);

input.replace = {
    ...(input.replace || {}),
    ...cliReplacements,
};

input.variables = {
    ...asRecord(input.variables),
    ...asRecord(input.replace),
    ...cliReplacements,
};

const preflightRawInput = JSON.parse(JSON.stringify(input)) as ScenarioCliConfig;
const envRequirements = collectBlackBoxRunnerEnvRequirements(input, process.env);
const resolvedVariables = preflightMode
    ? resolveBlackBoxRunnerVariablesForPreflight(
        input.variables,
        process.env,
        input.secretVariables || input.secrets || [],
    )
    : sync.resolveBlackBoxVariables(
        input.variables,
        process.env,
        input.secretVariables || input.secrets || [],
    );

input.variables = resolvedVariables.variables;

function replaceVariables<T>(data: T, variables: Record<string, unknown> = {}): T {
    let text = JSON.stringify(data);

    Object.entries(variables)
        .forEach(([key, value]) => {
            text = text.replaceAll('{' + key + '}', String(value));
        });

    return JSON.parse(text);
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

function isRemoteIncludePath(value: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
}

function includeReference(value: unknown): { key?: string; path?: string; variables: JsonRecord; namePrefix?: string; nameSuffix?: string } {
    if (typeof value === 'string') {
        return {
            key: value,
            variables: {},
        };
    }

    const record = asRecord(value);
    return {
        key: stringValue(record.fragment) ?? stringValue(record.name) ?? stringValue(record.id),
        path: stringValue(record.path) ?? stringValue(record.file) ?? stringValue(record.recipe),
        variables: asRecord(record.variables),
        namePrefix: stringValue(record.namePrefix),
        nameSuffix: stringValue(record.nameSuffix),
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
        return value.map(item => applyIncludeVariables(item, variables)) as T;
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, applyIncludeVariables(nested, variables)]),
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
            name: `${prefix || ''}${name}${suffix || ''}`,
        }
        : step;

    return {
        ...withName,
        ...(Array.isArray(withName.steps)
            ? {
                steps: withName.steps.map(child => asRecord(child)).map(child => withIncludeNameAffixes(child, prefix, suffix)),
            }
            : {}),
        ...(Array.isArray(withName.loopSteps)
            ? {
                loopSteps: withName.loopSteps.map(child => asRecord(child)).map(child => withIncludeNameAffixes(child, prefix, suffix)),
            }
            : {}),
        ...(Array.isArray(withName.groups)
            ? {
                groups: withName.groups.map(group => {
                    const groupRecord = asRecord(group);
                    return {
                        ...groupRecord,
                        steps: Array.isArray(groupRecord.steps)
                            ? groupRecord.steps.map(child => asRecord(child)).map(child => withIncludeNameAffixes(child, prefix, suffix))
                            : groupRecord.steps,
                    };
                }),
            }
            : {}),
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

function expandStaticRecipeIncludes(
    config: ScenarioCliConfig,
    configPath: string,
    rootDir: string,
): IncludeExpansionResult {
    const includes: JsonRecord[] = [];
    const collectedVariables: JsonRecord = {};
    const collectedConnections: JsonRecord = {};
    const collectedDefaults: JsonRecord = {};
    const inlineFragments = asRecord(config.fragments);

    const readFragment = (
        reference: ReturnType<typeof includeReference>,
        parentFilePath: string,
        stack: string[],
    ): { value: unknown; source: string; filePath: string } => {
        const key = reference.key;
        if (key && Object.prototype.hasOwnProperty.call(inlineFragments, key)) {
            const source = 'fragment:' + key;
            if (stack.includes(source)) {
                throw new Error('Circular include detected: ' + [...stack, source].join(' -> '));
            }
            return {
                value: cloneJson(inlineFragments[key]),
                source,
                filePath: parentFilePath,
            };
        }

        const includePath = reference.path ?? key;
        if (!includePath) {
            throw new Error('Include step must specify a fragment name or local path.');
        }

        const filePath = resolveIncludeFilePath(includePath, parentFilePath, rootDir);
        const source = 'file:' + path.relative(rootDir, filePath);
        if (stack.includes(source)) {
            throw new Error('Circular include detected: ' + [...stack, source].join(' -> '));
        }

        try {
            return {
                value: parseIncludeFile(filePath),
                source,
                filePath,
            };
        } catch (caught) {
            throw new Error('Failed to load include ' + includePath + ': ' + errorMessage(caught));
        }
    };

    const expandSteps = (steps: readonly unknown[], parentFilePath: string, stack: string[]): JsonRecord[] => {
        return steps.flatMap((step, index) => {
            const record = asRecord(step);
            if (!record.include) {
                return [expandNestedStepIncludes(record, parentFilePath, stack)];
            }

            const reference = includeReference(record.include);
            const mergedReference = {
                ...reference,
                variables: {
                    ...reference.variables,
                    ...asRecord(record.variables),
                },
                namePrefix: reference.namePrefix ?? stringValue(record.namePrefix),
                nameSuffix: reference.nameSuffix ?? stringValue(record.nameSuffix),
            };
            const fragment = readFragment(mergedReference, parentFilePath, stack);
            const fragmentRecord = asRecord(fragment.value);
            Object.assign(collectedVariables, asRecord(fragmentRecord.variables));
            Object.assign(collectedConnections, asRecord(fragmentRecord.connections));
            Object.assign(collectedDefaults, asRecord(fragmentRecord.defaults));

            const variables = {
                ...asRecord(fragmentRecord.variables),
                ...mergedReference.variables,
            };
            const expandedFragmentSteps = expandSteps(fragmentSteps(fragment.value), fragment.filePath, [...stack, fragment.source])
                .map(fragmentStep => applyIncludeVariables(fragmentStep, variables))
                .map(fragmentStep => withIncludeNameAffixes(fragmentStep, mergedReference.namePrefix, mergedReference.nameSuffix));

            includes.push({
                source: fragment.source,
                path: reference.path ?? reference.key,
                parent: path.relative(rootDir, parentFilePath),
                stepIndex: index,
                stepCount: expandedFragmentSteps.length,
            });

            return expandedFragmentSteps;
        });
    };

    const expandNestedStepIncludes = (step: JsonRecord, parentFilePath: string, stack: string[]): JsonRecord => {
        return {
            ...step,
            ...(Array.isArray(step.steps) ? { steps: expandSteps(step.steps, parentFilePath, stack) } : {}),
            ...(Array.isArray(step.loopSteps) ? { loopSteps: expandSteps(step.loopSteps, parentFilePath, stack) } : {}),
            ...(Array.isArray(step.setupSteps) ? { setupSteps: expandSteps(step.setupSteps, parentFilePath, stack) } : {}),
            ...(Array.isArray(step.cleanupSteps) ? { cleanupSteps: expandSteps(step.cleanupSteps, parentFilePath, stack) } : {}),
            ...(Array.isArray(step.groups)
                ? {
                    groups: step.groups.map(group => {
                        const groupRecord = asRecord(group);
                        return {
                            ...groupRecord,
                            ...(Array.isArray(groupRecord.steps)
                                ? { steps: expandSteps(groupRecord.steps, parentFilePath, stack) }
                                : {}),
                        };
                    }),
                }
                : {}),
        };
    };

    return {
        config: {
            ...config,
            variables: {
                ...collectedVariables,
                ...asRecord(config.variables),
            },
            connections: {
                ...collectedConnections,
                ...asRecord(config.connections),
            },
            defaults: {
                ...collectedDefaults,
                ...asRecord(config.defaults),
            },
            ...(Array.isArray(config.steps) ? { steps: expandSteps(config.steps, configPath, []) } : {}),
            fragments: undefined,
            includeMetadata: {
                schemaVersion: 1,
                configPath: path.relative(rootDir, configPath),
                includes,
            },
        } as ScenarioCliConfig,
        includes,
    };
}

function joinUrl(baseUrl: unknown, path: unknown): unknown {
    if (typeof path !== 'string') {
        return path;
    }

    if (!baseUrl || typeof baseUrl !== 'string') {
        return path;
    }

    if (path.startsWith('http://') || path.startsWith('https://')) {
        return path;
    }

    return baseUrl.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
}

function connectionRequestDefaults(connection: JsonRecord): JsonRecord {
    const {
        headers: _headers,
        resilience: _resilience,
        baseUrl: _baseUrl,
        url: _url,
        ...requestDefaults
    } = connection;

    return requestDefaults;
}

function toConnection(config: Record<string, unknown>, step: Record<string, unknown>): JsonRecord {
    const connections = asRecord(config.connections);
    const connectionName = step.connection;

    if (typeof connectionName !== 'string') {
        return {};
    }

    return asRecord(connections[connectionName]);
}

function withDefaultsAndConnection(
    step: Record<string, unknown>,
    config: Record<string, unknown>,
): Record<string, unknown> {
    const defaults = asRecord(config.defaults);
    const connection = toConnection(config, step);
    const request = asRecord(step.request);
    const expect = asRecord(step.expect || step.response);

    const defaultHeaders = asRecord(defaults.headers);
    const connectionHeaders = asRecord(connection.headers);
    const requestHeaders = asRecord(request.headers);

    const connectionBaseUrl = connection.baseUrl || defaults.baseUrl;
    const path = joinUrl(connectionBaseUrl, request.path || request.url || connection.url);

    return {
        ...step,
        type: step.type || connection.type || defaults.type || 'http',
        request: {
            ...connectionRequestDefaults(connection),
            ...request,
            path,
            method: request.method || defaults.method || 'GET',
            timeoutMs: request.timeoutMs || connection.timeoutMs || defaults.timeoutMs,
            resilience: {
                ...asRecord(defaults.resilience),
                ...asRecord(connection.resilience),
                ...asRecord(step.resilience),
                ...asRecord(request.resilience),
            },
            headers: {
                ...defaultHeaders,
                ...connectionHeaders,
                ...requestHeaders,
            },
        },
        expect: {
            ...expect,
            comparison: expect.comparison || defaults.comparison,
            ignoreJsonKeys: expect.ignoreJsonKeys || defaults.ignoreJsonKeys,
            ignoreJsonPaths: expect.ignoreJsonPaths || defaults.ignoreJsonPaths,
        },
    };
}

function nextInteractionExecutionNumber(state: ExecutableBuildState): number {
    const value = state.nextInteractionExecutionNumber;
    state.nextInteractionExecutionNumber++;
    return value;
}

function toExecutableStep(
    step: Record<string, unknown>,
    interactionExecutionNumber: number,
    inferredInputs: string[] = [],
): Record<string, unknown> {
    const request = step.request as Record<string, unknown> || {};
    const expect = step.expect as Record<string, unknown> || step.response as Record<string, unknown> || {};

    const stepType = String(step.type || 'http').toLowerCase();
    const technology = stepType.startsWith('assert')
        ? 'ASSERT'
        : stepType.startsWith('set') || stepType.startsWith('derive')
            ? 'SET'
            : stepType.startsWith('parallel')
                ? 'PARALLEL'
                : stepType.startsWith('ws')
                    ? 'WS'
                    : stepType.startsWith('crdt')
                        ? 'CRDT'
                        : stepType.startsWith('rtc') || stepType.startsWith('webrtc')
                            ? 'RTC'
                            : 'HTTP';

    const action = stepType.includes('.')
        ? stepType.split('.')[1]
        : request.action || step.action;

    return {
        [technology]: {
            request: {
                ...request,
                action,
                connection: step.connection || request.connection,
                method: request.method || 'GET',
                path: request.path || request.url,
                input: request.input || step.input || inferredInputs,
                output: request.output || step.output,
                outputPath: request.outputPath || step.outputPath,
                outputs: request.outputs || step.outputs,
                nonBlockingFailure: request.nonBlockingFailure ?? step.nonBlockingFailure,
                value: step.value !== undefined ? step.value : request.value,
                transform: request.transform || step.transform,
                derive: request.derive || step.derive,
                secret: request.secret ?? step.secret ?? request.redact ?? step.redact,
                redact: request.redact ?? step.redact,
                redactAs: request.redactAs || step.redactAs,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber,
                repeatIndex: step.repeatIndex,
                soakPhase: step.soakPhase,
                soakIteration: step.soakIteration,
                soakLoopIndex: step.soakLoopIndex,
                trafficPlan: step.trafficPlan,
                trafficSequence: step.trafficSequence,
                trafficOperation: step.trafficOperation,
                trafficSeed: step.trafficSeed,
                trafficPacing: step.trafficPacing,
                loopName: step.loopName,
                loopIndex: step.loopIndex,
                loopIteration: step.loopIteration,
                loopStepIndex: step.loopStepIndex,
                loopCount: step.loopCount,
                loopElapsedMs: step.loopElapsedMs,
                loopPhase: step.loopPhase,
                parallelGroup: step.parallelGroup,
                parallelGroupIndex: step.parallelGroupIndex,
                parallelStepIndex: step.parallelStepIndex,
            },
            response: {
                ...expect,
                actual: step.actual !== undefined ? step.actual : expect.actual,
                statusCode: expect.statusCode !== undefined ? expect.statusCode : expect.status,
            },
        },
        [String(step.name || 'step-' + interactionExecutionNumber)]: step,
    };
}

function isParallelStep(step: Record<string, unknown>): boolean {
    return String(step.type || '').toLowerCase().startsWith('parallel') ||
        Array.isArray(step.groups) ||
        (Array.isArray(step.steps) && (step.parallel === true || step.concurrent === true));
}

function toPlaceholderNames(data: unknown): string[] {
    const text = JSON.stringify(data);
    const matches = text.matchAll(/\{([^{}]+)}/g);

    return [...matches]
        .map(match => match[1])
        .map(path => path.split('.')[0])
        .filter(name => name.length > 0);
}

function toStepOutputName(step: Record<string, unknown>): string | undefined {
    const request = step.request as Record<string, unknown> || {};
    const output = request.output || step.output;

    return typeof output === 'string' && output.length > 0
        ? output
        : undefined;
}

function toKnownOutputNames(steps: Array<Record<string, unknown>>, currentIndex: number): string[] {
    return steps
        .slice(0, currentIndex)
        .map(toStepOutputName)
        .filter((name): name is string => name !== undefined);
}

function toInferredInputs(
    step: Record<string, unknown>,
    steps: Array<Record<string, unknown>>,
    currentIndex: number,
): string[] {
    const knownOutputs = toKnownOutputNames(steps, currentIndex);
    const placeholderNames = toPlaceholderNames(step);

    return [...new Set(
        placeholderNames.filter(name => knownOutputs.includes(name))
    )];
}

function toRepeatedSteps(steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return steps.flatMap(step => {
        const repeat = Number.parseInt(String(step.repeat ?? '1'));

        return new Array(Number.isFinite(repeat) && repeat > 0 ? repeat : 1)
            .fill(0)
            .map((_ignored, repeatIndex) => ({
                ...step,
                repeatIndex: step.repeatIndex ?? repeatIndex + 1,
            }));
    });
}

function toParallelGroupSpecs(step: Record<string, unknown>): Array<JsonRecord> {
    if (Array.isArray(step.groups)) {
        return step.groups
            .filter(group => group && typeof group === 'object' && !Array.isArray(group))
            .map((group, index) => ({
                name: String((group as JsonRecord).name || 'group-' + (index + 1)),
                steps: Array.isArray((group as JsonRecord).steps)
                    ? (group as JsonRecord).steps
                    : [],
            }));
    }

    if (Array.isArray(step.steps)) {
        return step.steps.map((nestedStep, index) => {
            if (nestedStep && typeof nestedStep === 'object' && !Array.isArray(nestedStep) && Array.isArray((nestedStep as JsonRecord).steps)) {
                return {
                    name: String((nestedStep as JsonRecord).name || 'group-' + (index + 1)),
                    steps: (nestedStep as JsonRecord).steps,
                };
            }

            return {
                name: String((nestedStep as JsonRecord)?.name || 'group-' + (index + 1)),
                steps: [nestedStep],
            };
        });
    }

    return [];
}

function withParallelAnnotations(step: JsonRecord, groupName: string, groupIndex: number, stepIndex: number): JsonRecord {
    return {
        ...step,
        parallelGroup: groupName,
        parallelGroupIndex: groupIndex,
        parallelStepIndex: stepIndex,
    };
}

function toExecutableParallelStep(
    step: Record<string, unknown>,
    config: ScenarioCliConfig,
    state: ExecutableBuildState,
    interactionExecutionNumber: number,
): Record<string, unknown> {
    const request = step.request as Record<string, unknown> || {};
    const expect = step.expect as Record<string, unknown> || step.response as Record<string, unknown> || {};
    const groups = toParallelGroupSpecs(step).map((group, groupIndex) => {
        const groupName = String(group.name || 'group-' + (groupIndex + 1));
        const rawSteps = Array.isArray(group.steps)
            ? group.steps
                .filter(nestedStep => nestedStep && typeof nestedStep === 'object' && !Array.isArray(nestedStep))
                .map((nestedStep, stepIndex) => withParallelAnnotations(nestedStep as JsonRecord, groupName, groupIndex + 1, stepIndex + 1))
            : [];

        return {
            name: groupName,
            index: groupIndex + 1,
            steps: toExecutableSteps(rawSteps as Array<Record<string, unknown>>, config, state),
        };
    });

    return {
        PARALLEL: {
            request: {
                ...request,
                action: request.action || step.action || 'run',
                groups,
                maxConcurrency: request.maxConcurrency || step.maxConcurrency || step.concurrency,
                timeoutMs: request.timeoutMs || step.timeoutMs,
                failFast: request.failFast ?? step.failFast,
                nonBlockingFailure: request.nonBlockingFailure ?? step.nonBlockingFailure,
                join: request.join || step.join || 'all',
                scenarioExecutionNumber: 1,
                interactionExecutionNumber,
                repeatIndex: step.repeatIndex,
                soakPhase: step.soakPhase,
                soakIteration: step.soakIteration,
                soakLoopIndex: step.soakLoopIndex,
                trafficPlan: step.trafficPlan,
                trafficSequence: step.trafficSequence,
                trafficOperation: step.trafficOperation,
                trafficSeed: step.trafficSeed,
                trafficPacing: step.trafficPacing,
                loopName: step.loopName,
                loopIndex: step.loopIndex,
                loopIteration: step.loopIteration,
                loopStepIndex: step.loopStepIndex,
                loopCount: step.loopCount,
                loopElapsedMs: step.loopElapsedMs,
                loopPhase: step.loopPhase,
            },
            response: {
                ...expect,
            },
        },
        [String(step.name || 'parallel-' + interactionExecutionNumber)]: step,
    };
}

function toExecutableSteps(
    rawSteps: Array<Record<string, unknown>>,
    config: ScenarioCliConfig,
    state: ExecutableBuildState,
): Array<Record<string, unknown>> {
    const expandedRawSteps = expandInlineLoopSteps(rawSteps as Array<JsonRecord>) as Array<Record<string, unknown>>;
    const steps = toRepeatedSteps(expandedRawSteps)
        .map((step: Record<string, unknown>) => withDefaultsAndConnection(step, config as Record<string, unknown>));

    return steps
        .map((step: Record<string, unknown>, index: number) => {
            const interactionExecutionNumber = nextInteractionExecutionNumber(state);
            return isParallelStep(step)
                ? toExecutableParallelStep(step, config, state, interactionExecutionNumber)
                : toExecutableStep(
                    step,
                    interactionExecutionNumber,
                    toInferredInputs(step, steps, index),
                );
        });
}

function toExecutableInteractions(config: ScenarioCliConfig): unknown[] {
    const normalizedConfig = replaceVariables(config, config.variables as Record<string, unknown>);

    if (Array.isArray(normalizedConfig.steps)) {
        return toExecutableSteps(
            normalizedConfig.steps as Array<Record<string, unknown>>,
            normalizedConfig,
            {
                nextInteractionExecutionNumber: 1,
            },
        );
    }

    return scenarioAlgorithms.createScenarios(normalizedConfig).flatMap(a => a);
}

const executionConfig = asRecord(input.execution);

function randomRunnerRunId(): string {
    const cryptoApi = globalThis.crypto as Crypto | undefined;
    if (cryptoApi?.randomUUID) {
        return 'bb-run-' + cryptoApi.randomUUID();
    }

    return 'bb-run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function toExecutionCorrelationConfig(config: JsonRecord): JsonRecord {
    const correlation = asRecord(config.correlation);
    const runnerRunId = stringValue(correlation.runnerRunId) ??
        stringValue(correlation.runId) ??
        stringValue(config.runnerRunId) ??
        stringValue(config.runId) ??
        randomRunnerRunId();

    return {
        ...correlation,
        runnerRunId,
        runId: runnerRunId,
    };
}

const correlationConfig = toExecutionCorrelationConfig(executionConfig);

const failFast = executionConfig.failFast !== false;
const printDryExecutableInteractions = cliOptions.execution?.toLowerCase().includes('dry') === true;
const dryRun = cliOptions.dryRun === true || executionConfig.dryRun === true;
const artifactDir = cliOptions.artifactDir ||
    (typeof executionConfig.artifactDir === 'string' ? executionConfig.artifactDir : undefined) ||
    (typeof executionConfig.recordDir === 'string' ? executionConfig.recordDir : undefined);
const scaleConfig = asRecord(executionConfig.scale);
const soakConfig = asRecord(executionConfig.soak);
const soakMode = Object.keys(soakConfig).length > 0 && soakConfig.enabled !== false;
const trafficPlanConfig = asRecord(executionConfig.trafficPlan || input.trafficPlan);
const trafficPlanMode = Object.keys(trafficPlanConfig).length > 0 && trafficPlanConfig.enabled !== false;

function firstPositiveInteger(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (value === undefined || value === null || value === '') {
            continue;
        }

        const parsed = Number.parseInt(String(value), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }

    return undefined;
}

function firstNonNegativeInteger(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (value === undefined || value === null || value === '') {
            continue;
        }

        const parsed = Number.parseInt(String(value), 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
            return parsed;
        }
    }

    return undefined;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (value === undefined || value === null || value === '') {
            continue;
        }

        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }

    return undefined;
}

const requestedIterations = firstPositiveInteger(
    cliOptions.iterations,
    soakConfig.iterations,
    soakConfig.runs,
    scaleConfig.iterations,
    scaleConfig.runs,
    executionConfig.iterations,
    executionConfig.runs,
);
const maxDurationMs = firstPositiveInteger(
    cliOptions.durationMs,
    soakConfig.durationMs,
    soakConfig.maxDurationMs,
    scaleConfig.durationMs,
    scaleConfig.maxDurationMs,
    executionConfig.durationMs,
    executionConfig.maxDurationMs,
) || 0;
const maxRuns = requestedIterations || firstPositiveInteger(
    soakConfig.maxRuns,
    soakConfig.maxIterations,
    scaleConfig.maxRuns,
    scaleConfig.maxIterations,
    executionConfig.maxRuns,
    executionConfig.maxIterations,
) || (maxDurationMs > 0 ? 1000 : 1);
const delayMs = firstNonNegativeInteger(
    cliOptions.delayMs,
    soakConfig.delayMs,
    scaleConfig.delayMs,
    executionConfig.delayMs,
) || 0;
const stopOnFailure = soakConfig.stopOnFailure === true || scaleConfig.stopOnFailure === true || executionConfig.stopOnFailure === true;
const scaleMode = !soakMode && (maxRuns > 1 || maxDurationMs > 0);

function configuredArtifactOptions(): JsonRecord {
    return {
        ...asRecord(executionConfig.artifactLimits),
        ...asRecord(executionConfig.artifact),
        ...asRecord(executionConfig.artifacts),
    };
}

function normalizeEventKindCaps(value: unknown): Record<string, number> {
    return Object.fromEntries(
        Object.entries(asRecord(value))
            .flatMap(([kind, limit]) => {
                const parsed = firstPositiveInteger(limit);
                return parsed ? [[kind, parsed]] : [];
            }),
    );
}

function configuredArtifactLimits(): JsonRecord {
    const options = configuredArtifactOptions();
    const maxEvents = firstPositiveInteger(
        options.maxEvents,
        options.maxArtifactEvents,
        options.eventLimit,
    );
    const maxEventsByKind = normalizeEventKindCaps(
        options.maxEventsByKind ||
        options.maxEventsPerKind ||
        options.eventKindLimits,
    );

    return {
        ...(maxEvents ? { maxEvents } : {}),
        ...(Object.keys(maxEventsByKind).length > 0 ? { maxEventsByKind } : {}),
    };
}

function withConfiguredArtifactLimits(report: any): any {
    const configured = configuredArtifactLimits();
    if (Object.keys(configured).length <= 0) {
        return report;
    }

    return {
        ...report,
        artifactLimits: {
            ...asRecord(report.artifactLimits),
            ...configured,
        },
    };
}

function stepName(step: JsonRecord, index: number): string {
    return typeof step.name === 'string' && step.name.length > 0
        ? step.name
        : 'step-' + (index + 1);
}

function cloneStep(step: JsonRecord): JsonRecord {
    return JSON.parse(JSON.stringify(step));
}

function resolveStepList(
    allSteps: Array<JsonRecord>,
    configured: unknown,
    fieldName: string,
    stepLabel = 'step',
): Array<JsonRecord> {
    if (!Array.isArray(configured)) {
        return [];
    }

    if (configured.every(item => typeof item === 'string')) {
        const byName = new Map(allSteps.map((step, index) => [stepName(step, index), step]));
        return configured.map(name => {
            const step = byName.get(String(name));
            if (!step) {
                throw new Error('Unknown ' + stepLabel + ' step in ' + fieldName + ': ' + String(name));
            }

            return cloneStep(step);
        });
    }

    return configured
        .filter(item => item && typeof item === 'object' && !Array.isArray(item))
        .map(item => cloneStep(item as JsonRecord));
}

function resolveSoakStepList(
    allSteps: Array<JsonRecord>,
    configured: unknown,
    fieldName: string,
): Array<JsonRecord> {
    return resolveStepList(allSteps, configured, fieldName, 'soak');
}

function resolveSoakLoopSteps(allSteps: Array<JsonRecord>, config: JsonRecord): Array<JsonRecord> {
    return resolveSoakStepList(
        allSteps,
        config.loopSteps || config.loop || config.steps,
        'loopSteps',
    );
}

function toUnsignedSeed(value: unknown): number {
    const parsed = Number.parseInt(String(value ?? 1), 10);
    return Number.isFinite(parsed)
        ? parsed >>> 0
        : 1;
}

function createSeededRandom(seed: number): () => number {
    let state = seed >>> 0;

    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function resolveTemplatePath(path: string, root: JsonRecord): unknown {
    return path
        .split('.')
        .reduce<unknown>((value, segment) => {
            if (value === undefined || value === null) {
                return undefined;
            }

            return (value as Record<string, unknown>)[segment];
        }, root);
}

function stringifyTemplateValue(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    if (value === undefined || value === null) {
        return String(value);
    }

    if (typeof value === 'object') {
        return JSON.stringify(value);
    }

    return String(value);
}

function resolveTrafficTemplate<T>(value: T, root: JsonRecord): T {
    if (typeof value === 'string') {
        const exactPlaceholderMatch = value.match(/^\{([^{}]+)}$/);
        if (exactPlaceholderMatch) {
            const resolved = resolveTemplatePath(exactPlaceholderMatch[1], root);
            return (resolved === undefined ? value : resolved) as T;
        }

        return value.replaceAll(/\{([^{}]+)}/g, (match, path) => {
            const resolved = resolveTemplatePath(path, root);
            return resolved === undefined
                ? match
                : stringifyTemplateValue(resolved);
        }) as T;
    }

    if (Array.isArray(value)) {
        return value.map(item => resolveTrafficTemplate(item, root)) as T;
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, resolveTrafficTemplate(nested, root)]),
        ) as T;
    }

    return value;
}

function isInlineLoopStep(step: JsonRecord): boolean {
    const stepType = String(step.type || '').toLowerCase();
    return stepType === 'loop' ||
        stepType.startsWith('loop.') ||
        (step.loop === true && Array.isArray(step.steps));
}

function toInlineLoopSteps(allSteps: Array<JsonRecord>, step: JsonRecord): Array<JsonRecord> {
    const loopConfig = Array.isArray(step.loop)
        ? step.loop
        : undefined;

    return resolveStepList(
        allSteps,
        step.loopSteps || loopConfig || step.steps,
        'loop.steps',
        'loop',
    );
}

function toInlineLoopIntervalMs(step: JsonRecord): number {
    const request = asRecord(step.request);
    const rateHz = firstPositiveNumber(step.rateHz, request.rateHz);

    return firstNonNegativeInteger(
        step.intervalMs,
        request.intervalMs,
        rateHz ? Math.max(1, Math.round(1000 / rateHz)) : undefined,
        step.delayMs,
        request.delayMs,
    ) || 0;
}

function toInlineLoopMessageCount(step: JsonRecord): number | undefined {
    const request = asRecord(step.request);
    return firstPositiveInteger(step.messageCount, request.messageCount, step.messages, request.messages);
}

function toInlineLoopIterationCount(step: JsonRecord, loopStepCount: number, intervalMs: number): number {
    const request = asRecord(step.request);
    const configuredIterations = firstPositiveInteger(
        step.count,
        request.count,
        step.iterations,
        request.iterations,
        step.runs,
        request.runs,
    );

    if (configuredIterations) {
        return configuredIterations;
    }

    const messageCount = toInlineLoopMessageCount(step);
    if (messageCount) {
        return Math.max(1, Math.ceil(messageCount / Math.max(1, loopStepCount)));
    }

    const durationMs = firstPositiveInteger(step.durationMs, request.durationMs, step.maxDurationMs, request.maxDurationMs);
    if (durationMs && intervalMs > 0) {
        return Math.max(1, Math.ceil(durationMs / intervalMs));
    }

    return 1;
}

function sanitizedStepName(value: string): string {
    return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'loop';
}

function annotateInlineLoopStep(step: JsonRecord, root: JsonRecord): JsonRecord {
    const loop = asRecord(root.loop);

    return {
        ...resolveTrafficTemplate(step, root),
        loopName: loop.name,
        loopIndex: loop.index,
        loopIteration: loop.iteration,
        loopStepIndex: loop.stepIndex,
        loopCount: loop.count,
        loopElapsedMs: loop.elapsedMs,
        loopPhase: 'body',
        repeatIndex: step.repeatIndex ?? loop.iteration,
    };
}

function toInlineLoopDelayStep(loopName: string, iteration: number, iterations: number, intervalMs: number): JsonRecord {
    return {
        name: loopName + 'Delay',
        type: 'set',
        output: '__loopDelay' + sanitizedStepName(loopName) + iteration,
        value: {
            delayedMs: intervalMs,
            loopName,
            loopIteration: iteration,
            loopCount: iterations,
        },
        request: {
            delayMs: intervalMs,
        },
        loopName,
        loopIteration: iteration,
        loopCount: iterations,
        loopPhase: 'delay',
        repeatIndex: iteration,
    };
}

function expandInlineLoopSteps(
    rawSteps: Array<JsonRecord>,
    allSteps: Array<JsonRecord> = rawSteps,
    depth = 0,
): Array<JsonRecord> {
    if (depth > 20) {
        throw new Error('Inline loop nesting exceeded 20 levels.');
    }

    return rawSteps.flatMap((step, stepIndex) => {
        if (!isInlineLoopStep(step)) {
            return [step];
        }

        const loopSteps = toInlineLoopSteps(allSteps, step);
        if (loopSteps.length <= 0) {
            throw new Error('Inline loop requires steps, loopSteps, or loop.');
        }

        const loopName = stepName(step, stepIndex);
        const intervalMs = toInlineLoopIntervalMs(step);
        const iterations = toInlineLoopIterationCount(step, loopSteps.length, intervalMs);
        const messageCount = toInlineLoopMessageCount(step);
        const expandedSteps: Array<JsonRecord> = [];
        let loopIndex = 0;

        for (let iterationIndex = 0; iterationIndex < iterations; iterationIndex++) {
            const iteration = iterationIndex + 1;
            const remainingMessages = messageCount === undefined
                ? loopSteps.length
                : Math.max(0, messageCount - (iterationIndex * loopSteps.length));
            const iterationSteps = loopSteps.slice(0, Math.min(loopSteps.length, remainingMessages));

            iterationSteps.forEach((loopStep, loopStepIndex) => {
                loopIndex++;
                const root = {
                    loop: {
                        name: loopName,
                        index: loopIndex,
                        iteration,
                        stepIndex: loopStepIndex + 1,
                        count: iterations,
                        elapsedMs: (iteration - 1) * intervalMs,
                    },
                };

                expandedSteps.push(...expandInlineLoopSteps([
                    annotateInlineLoopStep(cloneStep(loopStep), root),
                ], allSteps, depth + 1));
            });

            const hasRemainingWork = messageCount === undefined
                ? iteration < iterations
                : loopIndex < messageCount;
            if (intervalMs > 0 && hasRemainingWork) {
                expandedSteps.push(toInlineLoopDelayStep(loopName, iteration, iterations, intervalMs));
            }
        }

        return expandedSteps;
    });
}

function toTrafficStepList(
    allSteps: Array<JsonRecord>,
    configured: unknown,
    fieldName: string,
): Array<JsonRecord> {
    return resolveSoakStepList(allSteps, configured, fieldName);
}

function toTrafficOperationSteps(allSteps: Array<JsonRecord>, operation: JsonRecord): Array<JsonRecord> {
    if (Array.isArray(operation.steps)) {
        return toTrafficStepList(allSteps, operation.steps, 'trafficPlan.operations.steps');
    }

    if (operation.step !== undefined) {
        return toTrafficStepList(allSteps, [operation.step], 'trafficPlan.operations.step');
    }

    return [];
}

function toTrafficOperations(allSteps: Array<JsonRecord>, config: JsonRecord): Array<JsonRecord> {
    const operations = Array.isArray(config.operations)
        ? config.operations
        : [];

    return operations
        .filter(operation => operation && typeof operation === 'object' && !Array.isArray(operation))
        .map((operation, index) => {
            const operationConfig = operation as JsonRecord;
            const steps = toTrafficOperationSteps(allSteps, operationConfig);

            return {
                name: String(operationConfig.name || 'operation-' + (index + 1)),
                index: index + 1,
                weight: Math.max(0, Number(operationConfig.weight ?? 1)),
                steps,
            };
        })
        .filter(operation => (operation.steps as Array<JsonRecord>).length > 0 && Number(operation.weight) > 0);
}

function chooseTrafficOperation(operations: Array<JsonRecord>, random: number): JsonRecord {
    const totalWeight = operations.reduce((total, operation) => total + Number(operation.weight || 0), 0);
    const roll = random * totalWeight;
    let cursor = 0;

    for (const operation of operations) {
        cursor += Number(operation.weight || 0);
        if (roll < cursor) {
            return operation;
        }
    }

    return operations[operations.length - 1];
}

function annotateTrafficStep(step: JsonRecord, root: JsonRecord): JsonRecord {
    const traffic = asRecord(root.traffic);

    return {
        ...resolveTrafficTemplate(step, root),
        trafficPlan: {
            seed: traffic.seed,
        },
        trafficSeed: traffic.seed,
        trafficSequence: traffic.sequence,
        trafficOperation: traffic.operation,
    };
}

type TrafficPacingConfig = {
    rateHz?: number
    intervalMs: number
    jitterMs: number
    burstSize: number
    maxInFlight?: number
}

function toTrafficPacingConfig(planConfig: JsonRecord): TrafficPacingConfig {
    const rateHz = firstPositiveNumber(planConfig.rateHz);
    const intervalMs = firstNonNegativeInteger(
        planConfig.intervalMs,
        rateHz ? Math.max(1, Math.round(1000 / rateHz)) : undefined,
        planConfig.delayMs,
        delayMs,
    ) || 0;

    return {
        ...(rateHz ? { rateHz } : {}),
        intervalMs,
        jitterMs: firstNonNegativeInteger(planConfig.jitterMs) || 0,
        burstSize: firstPositiveInteger(planConfig.burstSize) || 1,
        ...(firstPositiveInteger(planConfig.maxInFlight) ? { maxInFlight: firstPositiveInteger(planConfig.maxInFlight) } : {}),
    };
}

function toTrafficDelayMs(
    pacing: TrafficPacingConfig,
    sequence: number,
    count: number,
    jitterRandom: () => number,
): number {
    if (pacing.intervalMs <= 0 || sequence >= count || sequence % pacing.burstSize !== 0) {
        return 0;
    }

    if (pacing.jitterMs <= 0) {
        return pacing.intervalMs;
    }

    const jitter = Math.round(((jitterRandom() * 2) - 1) * pacing.jitterMs);
    return Math.max(0, pacing.intervalMs + jitter);
}

function toTrafficDelayStep(sequence: number, configuredDelayMs: number, seed: number, pacing: TrafficPacingConfig): JsonRecord {
    return {
        name: 'trafficDelay',
        type: 'set',
        output: '__trafficDelay' + sequence,
        value: {
            delayedMs: configuredDelayMs,
            trafficSequence: sequence,
            burstSize: pacing.burstSize,
            maxInFlight: pacing.maxInFlight,
        },
        request: {
            delayMs: configuredDelayMs,
        },
        trafficPlan: {
            seed,
            pacing,
        },
        trafficSeed: seed,
        trafficSequence: sequence,
        trafficOperation: 'delay',
        trafficPacing: pacing,
    };
}

function toReplayTrafficPlan(config: ScenarioCliConfig, planConfig: JsonRecord): TrafficPlanArtifact | undefined {
    const replaySource = planConfig.replayFrom || planConfig.replayPath;
    const replayPlan = typeof replaySource === 'string'
        ? utils.openFile(replaySource) as JsonRecord
        : asRecord(planConfig.expandedPlan || planConfig.replay || planConfig.plan);

    if (Object.keys(replayPlan).length <= 0) {
        return undefined;
    }

    const steps = Array.isArray(replayPlan.steps)
        ? replayPlan.steps as Array<JsonRecord>
        : Array.isArray(asRecord(replayPlan.replayRecipe).steps)
            ? asRecord(replayPlan.replayRecipe).steps as Array<JsonRecord>
            : [];

    if (steps.length <= 0) {
        throw new Error('Traffic plan replay requires an expanded plan with steps.');
    }

    const seed = toUnsignedSeed(replayPlan.seed || planConfig.seed);
    const replayConfig = {
        ...config,
        steps,
    };

    return {
        version: 1,
        seed,
        replay: true,
        generator: {
            replayFrom: replaySource,
        },
        decisions: Array.isArray(replayPlan.decisions)
            ? replayPlan.decisions as Array<JsonRecord>
            : [],
        steps,
        replayRecipe: {
            ...replayConfig,
            execution: {
                ...asRecord(config.execution),
                trafficPlan: {
                    expandedPlan: {
                        version: 1,
                        seed,
                        steps,
                    },
                },
            },
        },
    };
}

function toGeneratedTrafficPlan(config: ScenarioCliConfig, planConfig: JsonRecord): TrafficPlanArtifact {
    if (!Array.isArray(config.steps)) {
        throw new Error('Traffic plan mode requires an explicit steps array.');
    }

    const seed = toUnsignedSeed(planConfig.seed);
    const random = createSeededRandom(seed);
    const count = firstPositiveInteger(
        planConfig.count,
        planConfig.iterations,
        planConfig.runs,
        planConfig.messageCount,
        planConfig.messages,
    ) || 1;
    const pacing = toTrafficPacingConfig(planConfig);
    const setupSteps = expandInlineLoopSteps(
        toTrafficStepList(config.steps, planConfig.setupSteps || planConfig.setup, 'trafficPlan.setupSteps'),
        config.steps,
    );
    const cleanupSteps = expandInlineLoopSteps(
        toTrafficStepList(config.steps, planConfig.cleanupSteps || planConfig.cleanup, 'trafficPlan.cleanupSteps'),
        config.steps,
    );
    const operations = toTrafficOperations(config.steps, planConfig);
    const jitterRandom = createSeededRandom(seed ^ 0x9E3779B9);

    if (operations.length <= 0) {
        throw new Error('Traffic plan mode requires at least one operation with steps.');
    }

    const decisions: Array<JsonRecord> = [];
    const generatedLoopSteps = Array.from({ length: count }).flatMap((_ignored, index) => {
        const sequence = index + 1;
        const operationRandom = random();
        const operation = chooseTrafficOperation(operations, operationRandom);
        const randomValue = random();
        const randomInt = Math.floor(random() * 1_000_000);
        const root = {
            traffic: {
                seed,
                sequence,
                iteration: sequence,
                operation: operation.name,
                operationIndex: operation.index,
                random: Number(randomValue.toFixed(6)),
                randomInt,
                pacing,
            },
        };
        const generatedDelayMs = toTrafficDelayMs(pacing, sequence, count, jitterRandom);

        decisions.push({
            sequence,
            operation: operation.name,
            operationIndex: operation.index,
            operationRandom: Number(operationRandom.toFixed(6)),
            random: Number(randomValue.toFixed(6)),
            randomInt,
            delayMs: generatedDelayMs,
            burstIndex: Math.ceil(sequence / pacing.burstSize),
            burstPosition: ((sequence - 1) % pacing.burstSize) + 1,
            pacing,
        });

        const operationSteps = expandInlineLoopSteps(
            (operation.steps as Array<JsonRecord>).map(step => annotateTrafficStep(cloneStep(step), root)),
            config.steps,
        );

        return generatedDelayMs > 0
            ? [
                ...operationSteps,
                toTrafficDelayStep(sequence, generatedDelayMs, seed, pacing),
            ]
            : operationSteps;
    });

    const steps = [
        ...setupSteps,
        ...generatedLoopSteps,
        ...cleanupSteps,
    ];

    return {
        version: 1,
        seed,
        replay: false,
        generator: {
            ...planConfig,
            pacing,
            operations: operations.map(operation => ({
                name: operation.name,
                index: operation.index,
                weight: operation.weight,
                stepCount: (operation.steps as Array<JsonRecord>).length,
            })),
        },
        decisions,
        steps,
        replayRecipe: {
            ...config,
            steps,
            execution: {
                ...asRecord(config.execution),
                trafficPlan: {
                    expandedPlan: {
                        version: 1,
                        seed,
                        decisions,
                        steps,
                    },
                },
            },
        },
    };
}

function toTrafficPlanExpandedConfig(config: ScenarioCliConfig): { config: ScenarioCliConfig, artifact?: TrafficPlanArtifact } {
    if (!trafficPlanMode) {
        return {
            config,
        };
    }

    const replayPlan = toReplayTrafficPlan(config, trafficPlanConfig);
    const artifact = replayPlan || toGeneratedTrafficPlan(config, trafficPlanConfig);

    return {
        config: {
            ...config,
            steps: artifact.steps,
        },
        artifact,
    };
}

function toSoakMessageCount(config: JsonRecord): number | undefined {
    return firstPositiveInteger(config.messageCount, config.messages);
}

function toSoakIterationCount(config: JsonRecord, loopStepCount = 1): number {
    const configuredIterations = firstPositiveInteger(
        requestedIterations,
        config.iterations,
        config.runs,
    );

    if (configuredIterations) {
        return configuredIterations;
    }

    const configuredMessages = toSoakMessageCount(config);
    if (configuredMessages) {
        return Math.max(1, Math.ceil(configuredMessages / Math.max(1, loopStepCount)));
    }

    const durationMs = firstPositiveInteger(config.durationMs, config.maxDurationMs, maxDurationMs);
    const configuredDelayMs = firstPositiveInteger(config.delayMs, delayMs);
    if (durationMs && configuredDelayMs) {
        return Math.max(1, Math.ceil(durationMs / configuredDelayMs));
    }

    return maxRuns;
}

function annotateSoakStep(step: JsonRecord, phase: string, iteration?: number, loopIndex?: number): JsonRecord {
    return {
        ...step,
        soakPhase: phase,
        ...(iteration !== undefined ? { soakIteration: iteration, repeatIndex: iteration } : {}),
        ...(loopIndex !== undefined ? { soakLoopIndex: loopIndex } : {}),
    };
}

function toSoakDelayStep(iteration: number, configuredDelayMs: number): JsonRecord {
    return {
        name: 'soakDelay',
        type: 'set',
        output: '__soakDelay' + iteration,
        value: {
            delayedMs: configuredDelayMs,
            soakIteration: iteration,
        },
        request: {
            delayMs: configuredDelayMs,
        },
        soakPhase: 'delay',
        soakIteration: iteration,
        repeatIndex: iteration,
    };
}

function toSoakExpandedConfig(config: ScenarioCliConfig): ScenarioCliConfig {
    if (!soakMode) {
        return config;
    }

    if (!Array.isArray(config.steps)) {
        throw new Error('Soak mode requires an explicit steps array.');
    }

    const setupSteps = resolveSoakStepList(config.steps, soakConfig.setupSteps || soakConfig.setup, 'setupSteps')
        .map(step => annotateSoakStep(step, 'setup'));
    const loopSteps = resolveSoakLoopSteps(config.steps, soakConfig);
    const cleanupSteps = resolveSoakStepList(config.steps, soakConfig.cleanupSteps || soakConfig.cleanup, 'cleanupSteps')
        .map(step => annotateSoakStep(step, 'cleanup'));
    const messageCount = toSoakMessageCount(soakConfig);
    const iterations = toSoakIterationCount(soakConfig, loopSteps.length);
    const configuredDelayMs = firstNonNegativeInteger(soakConfig.delayMs, delayMs) || 0;

    if (loopSteps.length <= 0) {
        throw new Error('Soak mode requires loopSteps, loop, or steps in execution.soak.');
    }

    const repeatedLoopSteps = Array.from({ length: iterations }).flatMap((_ignored, iterationIndex) => {
        const iteration = iterationIndex + 1;
        const remainingMessages = messageCount === undefined
            ? loopSteps.length
            : Math.max(0, messageCount - (iterationIndex * loopSteps.length));
        const iterationLoopSteps = loopSteps.slice(0, Math.min(loopSteps.length, remainingMessages));
        const annotatedLoopSteps = iterationLoopSteps.map((step, loopIndex) => annotateSoakStep(cloneStep(step), 'loop', iteration, loopIndex + 1));

        return configuredDelayMs > 0 && iteration < iterations
            ? [
                ...annotatedLoopSteps,
                toSoakDelayStep(iteration, configuredDelayMs),
            ]
            : annotatedLoopSteps;
    });

    return {
        ...config,
        steps: [
            ...setupSteps,
            ...repeatedLoopSteps,
            ...cleanupSteps,
        ],
    };
}

let trafficExpansion: ReturnType<typeof toTrafficPlanExpandedConfig>;
let expandedInput: ScenarioCliConfig;
let scenarioJson: unknown[];
let planExpansionError: unknown = includeExpansionError;

try {
    if (includeExpansionError !== undefined) {
        throw includeExpansionError;
    }

    trafficExpansion = toTrafficPlanExpandedConfig(input);
    expandedInput = toSoakExpandedConfig(trafficExpansion.config);
    scenarioJson = toExecutableInteractions(expandedInput);
} catch (caught) {
    if (!preflightMode) {
        throw caught;
    }

    planExpansionError = caught;
    trafficExpansion = {
        config: input,
    };
    expandedInput = input;
    scenarioJson = [];
}

function artifactPath(dir: string, name: string): string {
    return dir.replace(/\/+$/, '') + '/' + name;
}

function toJsonLine(value: unknown): string {
    return JSON.stringify(value) + '\n';
}

function resultEvents(report: any): unknown[] {
    return (report.resultsList || []).map((result: any) => ({
        kind: 'step-result',
        name: result.name,
        status: result.status,
        transport: result.transport,
        action: result.action,
        connection: result.connection,
        result: result.result,
        runnerRunId: result.runnerRunId,
        runnerStepId: result.runnerStepId,
        correlation: result.correlation,
        runIndex: result.runIndex,
        stepResultKey: result.stepResultKey,
        scenarioExecutionNumber: result.scenarioExecutionNumber,
        interactionExecutionNumber: result.interactionExecutionNumber,
        repeatIndex: result.repeatIndex,
        startedAtEpochMs: result.startedAtEpochMs,
        endedAtEpochMs: result.endedAtEpochMs,
        durationMs: result.durationMs,
        actual: result.actual,
    }));
}

function postRunAssertionEvents(report: any): unknown[] {
    const results = Array.isArray(report.postRunAssertions?.results)
        ? report.postRunAssertions.results
        : [];

    return results.map((result: any) => ({
        kind: 'post-run-assertion',
        name: result.name,
        status: result.status,
        path: result.path,
        operator: result.operator,
        runnerRunId: report.runnerRunId ?? report.correlation?.runnerRunId,
        correlation: report.correlation,
        expected: result.expected,
        actual: result.actual,
        result: result.result,
        details: result.details,
    }));
}

function keyedStoreEvents(kind: string, store: any): unknown[] {
    return Object.entries(asRecord(store)).flatMap(([connection, values]) => {
        return Array.isArray(values)
            ? values.map(value => ({
                kind,
                connection,
                value,
            }))
            : [];
    });
}

function artifactEvents(report: any): unknown[] {
    return [
        ...resultEvents(report),
        ...postRunAssertionEvents(report),
        ...keyedStoreEvents('ws-message', report.wsMessages),
        ...keyedStoreEvents('ws-close', report.wsCloseEvents),
        ...keyedStoreEvents('rtc-message', report.rtcMessages),
        ...keyedStoreEvents('rtc-diagnostic', report.rtcDiagnostics),
        ...keyedStoreEvents('rtc-close', report.rtcCloseEvents),
    ];
}

function artifactEventKind(event: JsonRecord): string {
    return stringValue(event.kind) ?? 'unknown';
}

function artifactEventStatus(event: JsonRecord): string {
    return String(event.status || asRecord(event.result).status || 'unknown');
}

function artifactEventTransport(event: JsonRecord): string {
    return String(event.transport || asRecord(event.value).transport || 'unknown');
}

function artifactEventConnection(event: JsonRecord): string | undefined {
    return stringValue(event.connection) ?? stringValue(asRecord(event.value).connection);
}

function artifactEventRunIndex(event: JsonRecord): string {
    const runIndex = event.runIndex ?? asRecord(event.result).runIndex;
    return runIndex === undefined || runIndex === null
        ? 'unknown'
        : String(runIndex);
}

function isFailureArtifactEvent(event: JsonRecord): boolean {
    return (event.kind === 'step-result' || event.kind === 'post-run-assertion') &&
        artifactEventStatus(event) === 'FAILURE';
}

function isDiagnosticArtifactEvent(event: JsonRecord): boolean {
    return event.kind === 'rtc-diagnostic';
}

function shouldPreserveArtifactEvent(event: JsonRecord): boolean {
    return isFailureArtifactEvent(event) || isDiagnosticArtifactEvent(event);
}

function eventPointer(event: ArtifactEventRecord): JsonRecord {
    return {
        sequence: event.sequence,
        kind: event.kind,
        name: event.name,
        status: event.status,
        transport: event.transport,
        action: event.action,
        connection: event.connection,
        runnerRunId: event.runnerRunId,
        runnerStepId: event.runnerStepId,
        runIndex: event.runIndex,
        stepResultKey: event.stepResultKey,
        scenarioExecutionNumber: event.scenarioExecutionNumber,
        interactionExecutionNumber: event.interactionExecutionNumber,
        repeatIndex: event.repeatIndex,
    };
}

function eventCounts(events: readonly ArtifactEventRecord[]): JsonRecord {
    const byKind: Record<string, number> = {};
    const byTransport: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    events.forEach(event => {
        incrementCount(byKind, artifactEventKind(event));
        incrementCount(byTransport, artifactEventTransport(event));
        incrementCount(byStatus, artifactEventStatus(event));
    });

    return {
        total: events.length,
        byKind,
        byTransport,
        byStatus,
    };
}

function toArtifactEventRecords(report: any): ArtifactEventRecord[] {
    return artifactEvents(report).map((event, index) => ({
        ...asRecord(event),
        kind: stringValue(asRecord(event).kind) ?? 'unknown',
        sequence: index + 1,
    }));
}

function artifactLimitConfig(report: any): { maxEvents?: number; maxEventsByKind: Record<string, number> } {
    return {
        maxEvents: firstPositiveInteger(
            report?.artifactLimits?.maxEvents,
            report?.summary?.soak?.maxArtifactEvents,
        ),
        maxEventsByKind: normalizeEventKindCaps(report?.artifactLimits?.maxEventsByKind),
    };
}

function selectArtifactEvents(report: any): ArtifactEventSelection {
    const allEvents = toArtifactEventRecords(report);
    const limits = artifactLimitConfig(report);
    const emittedEvents: ArtifactEventRecord[] = [];
    const omittedEvents: ArtifactEventRecord[] = [];
    const emittedByKind: Record<string, number> = {};

    allEvents.forEach(event => {
        const kind = artifactEventKind(event);
        const preserve = shouldPreserveArtifactEvent(event);
        const kindLimit = limits.maxEventsByKind[kind];
        const kindCapAllows = preserve || kindLimit === undefined || (emittedByKind[kind] || 0) < kindLimit;
        const globalCapAllows = preserve || limits.maxEvents === undefined || emittedEvents.length < limits.maxEvents;

        if (kindCapAllows && globalCapAllows) {
            emittedEvents.push(event);
            incrementCount(emittedByKind, kind);
            return;
        }

        omittedEvents.push(event);
    });

    return {
        allEvents,
        emittedEvents,
        index: buildArtifactIndex(report, allEvents, emittedEvents, omittedEvents, limits),
    };
}

function artifactEventsWithTruncation(selection: ArtifactEventSelection): unknown[] {
    const omittedEvents = Number(asRecord(selection.index.truncation).omittedEvents || 0);
    if (omittedEvents <= 0) {
        return selection.emittedEvents;
    }

    const truncation = asRecord(selection.index.truncation);
    return [
        ...selection.emittedEvents,
        {
            kind: 'artifact-truncated',
            totalEvents: truncation.totalEvents,
            emittedEvents: truncation.emittedEvents,
            omittedEvents: truncation.omittedEvents,
            maxEvents: truncation.maxEvents,
            maxEventsByKind: truncation.maxEventsByKind,
            omittedByKind: truncation.omittedByKind,
        },
    ];
}

function compactSuccessSummaries(omittedEvents: readonly ArtifactEventRecord[]): JsonRecord[] {
    const groups = new Map<string, JsonRecord>();

    omittedEvents
        .filter(event => event.kind === 'step-result' && artifactEventStatus(event) === 'SUCCESS')
        .forEach(event => {
            const key = JSON.stringify([
                event.name,
                artifactEventTransport(event),
                event.action,
                artifactEventConnection(event) || 'unknown',
            ]);
            const existing = groups.get(key) || {
                name: event.name,
                transport: artifactEventTransport(event),
                action: event.action,
                connection: artifactEventConnection(event),
                status: 'SUCCESS',
                count: 0,
                firstSequence: event.sequence,
                lastSequence: event.sequence,
            };

            existing.count = Number(existing.count || 0) + 1;
            existing.lastSequence = event.sequence;
            groups.set(key, existing);
        });

    return [...groups.values()];
}

function perRunSummaries(
    allEvents: readonly ArtifactEventRecord[],
    emittedSequences: ReadonlySet<number>,
): JsonRecord[] {
    const runs = new Map<string, JsonRecord>();

    allEvents
        .filter(event => event.kind === 'step-result')
        .forEach(event => {
            const runIndex = artifactEventRunIndex(event);
            const status = artifactEventStatus(event);
            const summary = runs.get(runIndex) || {
                runIndex,
                total: 0,
                success: 0,
                failure: 0,
                emitted: 0,
                omitted: 0,
            };

            summary.total = Number(summary.total || 0) + 1;
            if (status === 'SUCCESS') {
                summary.success = Number(summary.success || 0) + 1;
            }
            if (status === 'FAILURE') {
                summary.failure = Number(summary.failure || 0) + 1;
            }
            if (emittedSequences.has(event.sequence)) {
                summary.emitted = Number(summary.emitted || 0) + 1;
            } else {
                summary.omitted = Number(summary.omitted || 0) + 1;
            }

            runs.set(runIndex, summary);
        });

    return [...runs.values()];
}

function perConnectionSummaries(
    allEvents: readonly ArtifactEventRecord[],
    emittedSequences: ReadonlySet<number>,
): JsonRecord[] {
    const connections = new Map<string, JsonRecord>();

    allEvents.forEach(event => {
        const connection = artifactEventConnection(event);
        if (!connection) {
            return;
        }

        const summary = connections.get(connection) || {
            connection,
            total: 0,
            emitted: 0,
            omitted: 0,
            byKind: {},
            byTransport: {},
            byStatus: {},
        };

        summary.total = Number(summary.total || 0) + 1;
        if (emittedSequences.has(event.sequence)) {
            summary.emitted = Number(summary.emitted || 0) + 1;
        } else {
            summary.omitted = Number(summary.omitted || 0) + 1;
        }
        incrementCount(summary.byKind as Record<string, number>, artifactEventKind(event));
        incrementCount(summary.byTransport as Record<string, number>, artifactEventTransport(event));
        incrementCount(summary.byStatus as Record<string, number>, artifactEventStatus(event));

        connections.set(connection, summary);
    });

    return [...connections.values()];
}

function buildArtifactIndex(
    report: any,
    allEvents: readonly ArtifactEventRecord[],
    emittedEvents: readonly ArtifactEventRecord[],
    omittedEvents: readonly ArtifactEventRecord[],
    limits: { maxEvents?: number; maxEventsByKind: Record<string, number> },
): JsonRecord {
    const emittedSequences = new Set(emittedEvents.map(event => event.sequence));
    const omittedByKind = eventCounts(omittedEvents).byKind;
    const firstFailure = allEvents.find(isFailureArtifactEvent);
    const stepResults = allEvents
        .filter(event => event.kind === 'step-result')
        .map(event => ({
            ...eventPointer(event),
            emitted: emittedSequences.has(event.sequence),
        }));
    const compactSummaries = compactSuccessSummaries(omittedEvents);

    return {
        schemaVersion: 1,
        kind: 'black-box-runner.artifact-index',
        generatedAtEpochMs: Date.now(),
        runnerRunId: report.runnerRunId,
        correlation: report.correlation,
        summary: report.summary,
        counts: {
            total: eventCounts(allEvents),
            emitted: eventCounts(emittedEvents),
            omitted: eventCounts(omittedEvents),
        },
        firstFailure: firstFailure ? eventPointer(firstFailure) : undefined,
        stepResults,
        perRun: perRunSummaries(allEvents, emittedSequences),
        perConnection: perConnectionSummaries(allEvents, emittedSequences),
        compaction: {
            compacted: omittedEvents.length > 0,
            repeatedSuccessSummaries: compactSummaries,
        },
        truncation: {
            truncated: omittedEvents.length > 0,
            totalEvents: allEvents.length,
            emittedEvents: emittedEvents.length,
            omittedEvents: omittedEvents.length,
            omittedByKind,
            maxEvents: limits.maxEvents,
            maxEventsByKind: limits.maxEventsByKind,
            preservedFailureEvents: emittedEvents.filter(isFailureArtifactEvent).length,
            preservedDiagnosticEvents: emittedEvents.filter(isDiagnosticArtifactEvent).length,
        },
    };
}

function withArtifactReport(report: any): any {
    const selection = selectArtifactEvents(report);
    const truncation = asRecord(selection.index.truncation);

    return {
        ...report,
        artifact: {
            ...asRecord(report.artifact),
            eventCount: truncation.totalEvents,
            maxEvents: truncation.maxEvents,
            maxEventsByKind: truncation.maxEventsByKind,
            emittedEvents: truncation.emittedEvents,
            omittedEvents: truncation.omittedEvents,
            omittedByKind: truncation.omittedByKind,
            truncated: truncation.truncated,
            compactedSuccessGroups: asArray(asRecord(selection.index.compaction).repeatedSuccessSummaries).length,
        },
    };
}

function failureBundle(report: any): unknown {
    const failures = (report.resultsList || [])
        .filter((result: any) => result.status === 'FAILURE')
        .map((result: any) => ({
            resultKey: result.resultKey,
            name: result.name,
            transport: result.transport,
            action: result.action,
            connection: result.connection,
            result: result.result,
            exception: result.exception,
            runnerRunId: result.runnerRunId,
            runnerStepId: result.runnerStepId,
            correlation: result.correlation,
            method: result.method,
            path: result.path,
            expected: result.expected,
            actual: result.actual,
            details: result.details,
            runIndex: result.runIndex,
            stepResultKey: result.stepResultKey,
            scenarioExecutionNumber: result.scenarioExecutionNumber,
            interactionExecutionNumber: result.interactionExecutionNumber,
            repeatIndex: result.repeatIndex,
        }));
    const postRunAssertionFailures = (report.postRunAssertions?.results || [])
        .filter((result: any) => result.status === 'FAILURE');

    return {
        summary: report.summary,
        failures,
        postRunAssertionFailures,
        postRunAssertions: report.postRunAssertions,
        outputs: report.outputs,
    };
}

function withExpandedPlanCorrelation(artifact: TrafficPlanArtifact, report: any): unknown {
    return {
        ...artifact,
        runnerRunId: report.runnerRunId,
        correlation: report.correlation,
        replayRecipe: {
            ...artifact.replayRecipe,
            execution: {
                ...asRecord(artifact.replayRecipe.execution),
                correlation: {
                    ...asRecord(asRecord(artifact.replayRecipe.execution).correlation),
                    runnerRunId: report.runnerRunId,
                    runId: report.runnerRunId,
                },
            },
        },
    };
}

async function writeArtifacts(report: any, dir: string): Promise<void> {
    await Deno.mkdir(dir, {
        recursive: true,
    });
    const artifactReport = withArtifactReport(withConfiguredArtifactLimits(report));
    const selection = selectArtifactEvents(artifactReport);
    const events = artifactEventsWithTruncation(selection);
    const metadata = {
        generatedAtEpochMs: Date.now(),
        config: cliOptions.config,
        workingDirectory: cliOptions.workingDirectory || '.',
        dryRun,
        execution: printDryExecutableInteractions ? 'dry' : 'run',
        summary: artifactReport.summary,
        runnerRunId: artifactReport.runnerRunId,
        correlation: artifactReport.correlation,
        command: sync.redactBlackBoxData(process.argv, resolvedVariables.redactions),
    };
    const boundedReport = artifactBounds.withBoundedArtifactReportStores(
        artifactBounds.withBoundedArtifactReportResults(artifactReport,
            configuredArtifactOptions().maxReportResults));
    await Deno.writeTextFile(artifactPath(dir, 'report.json'), JSON.stringify(boundedReport, null, 2));
    await Deno.writeTextFile(artifactPath(dir, 'events.jsonl'), events.map(toJsonLine).join(''));
    await Deno.writeTextFile(artifactPath(dir, 'failures.json'), JSON.stringify(failureBundle(artifactReport), null, 2));
    await Deno.writeTextFile(artifactPath(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    await Deno.writeTextFile(
        artifactPath(dir, 'expanded-recipe.json'),
        JSON.stringify(sync.redactBlackBoxData({
            schemaVersion: 1,
            kind: 'black-box-runner.expanded-recipe',
            generatedAtEpochMs: Date.now(),
            sourceConfig: cliOptions.config,
            includeMetadata: input.includeMetadata,
            recipe: expandedInput,
        }, resolvedVariables.redactions), null, 2),
    );
    await Deno.writeTextFile(
        artifactPath(dir, 'artifact-index.json'),
        JSON.stringify(sync.redactBlackBoxData(selection.index, resolvedVariables.redactions), null, 2),
    );
    if (trafficExpansion.artifact) {
        await Deno.writeTextFile(
            artifactPath(dir, 'expanded-plan.json'),
            JSON.stringify(sync.redactBlackBoxData(
                withExpandedPlanCorrelation(trafficExpansion.artifact, artifactReport),
                resolvedVariables.redactions,
            ), null, 2),
        );
    }
}

function sleep(ms: number): Promise<void> {
    return ms > 0
        ? new Promise(resolve => setTimeout(resolve, ms))
        : Promise.resolve();
}

function numberFromPath(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed)
        ? parsed
        : undefined;
}

function latencyMetric(values: number[]): unknown {
    const sorted = values
        .filter(value => Number.isFinite(value))
        .sort((a, b) => a - b);

    if (sorted.length <= 0) {
        return {
            count: 0,
        };
    }

    const percentile = (p: number): number => {
        const index = Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
        );
        return sorted[index];
    };

    const sum = sorted.reduce((acc, value) => acc + value, 0);

    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: Number((sum / sorted.length).toFixed(2)),
        p50: percentile(50),
        p95: percentile(95),
        p99: percentile(99),
    };
}

function incrementCount(target: Record<string, number>, key: unknown): void {
    const normalized = String(key || 'unknown');
    target[normalized] = (target[normalized] || 0) + 1;
}

function countReconnects(results: any[]): number {
    const seen = new Set<string>();
    let reconnects = 0;

    results.forEach(result => {
        const action = String(result.action || '').toLowerCase();
        if (action !== 'connect' && action !== 'open') {
            return;
        }

        const connection = result.connection || result.actual?.connection;
        if (!connection) {
            return;
        }

        const key = [result.runIndex, result.transport, connection].join(':');
        if (seen.has(key)) {
            reconnects++;
            return;
        }

        seen.add(key);
    });

    return reconnects;
}

function countArrayValues(store: unknown): number {
    return Object.values(asRecord(store))
        .reduce<number>((count, values) => count + (Array.isArray(values) ? values.length : 0), 0);
}

function ratio(numerator: number, denominator: number): number {
    return denominator > 0
        ? Number((numerator / denominator).toFixed(4))
        : 1;
}

function resultOutcomeMetrics(results: any[], predicate: (result: any) => boolean): unknown {
    const matching = results.filter(predicate);
    const succeeded = matching.filter(result => result.status === 'SUCCESS').length;
    const failed = matching.filter(result => result.status === 'FAILURE').length;

    return {
        attempted: matching.length,
        succeeded,
        failed,
        successRatio: ratio(succeeded, matching.length),
    };
}

function flattenStoreValues(store: unknown): any[] {
    return Object.values(asRecord(store))
        .flatMap(values => Array.isArray(values) ? values : []);
}

function diagnosticSeverity(value: unknown): string {
    const severity = String(asRecord(value).severity || '').toLowerCase();
    if (severity === 'warn') {
        return 'warning';
    }
    return severity || 'unknown';
}

function diagnosticTopic(value: unknown): string {
    return String(asRecord(value).topic || 'unknown');
}

function diagnosticMetricsFromValues(values: any[]): unknown {
    const bySeverity: Record<string, number> = {
        debug: 0,
        info: 0,
        warning: 0,
        error: 0,
        unknown: 0,
    };
    const byTopic: Record<string, number> = {};

    values.forEach(value => {
        incrementCount(bySeverity, diagnosticSeverity(value));
        incrementCount(byTopic, diagnosticTopic(value));
    });

    return {
        total: values.length,
        bySeverity,
        byTopic,
    };
}

function diagnosticMetricsFromReport(report: any): unknown {
    return diagnosticMetricsFromValues(flattenStoreValues(report.rtcDiagnostics));
}

function countNestedArrayValues(results: any[], fieldName: string): number {
    return results.reduce((count, result) => {
        const actualValues = asRecord(result.actual);
        const detailValues = asRecord(result.details);
        const actualValue = actualValues[fieldName];
        const detailValue = detailValues[fieldName];
        return count +
            (Array.isArray(actualValue) ? actualValue.length : 0) +
            (Array.isArray(detailValue) ? detailValue.length : 0);
    }, 0);
}

function baseMetrics(report: any): JsonRecord {
    const results = Array.isArray(report.resultsList) ? report.resultsList : [];
    const byTransport: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const closeResults = results.filter((result: any) => String(result.action || '').toLowerCase() === 'close');

    results.forEach((result: any) => {
        incrementCount(byTransport, result.transport);
        incrementCount(byAction, result.action || result.method || result.transport);
        incrementCount(byStatus, result.status);
    });

    return {
        byTransport,
        byAction,
        byStatus,
        sends: resultOutcomeMetrics(results, result => String(result.action || '').toLowerCase() === 'send'),
        waits: resultOutcomeMetrics(results, result => ['wait', 'expect'].includes(String(result.action || '').toLowerCase())),
        latencyMs: {
            stepDuration: latencyMetric(results.map((result: any) => numberFromPath(result.durationMs)).filter((value: number | undefined): value is number => value !== undefined)),
            connect: latencyMetric(results.map((result: any) => numberFromPath(result.actual?.connectLatencyMs)).filter((value: number | undefined): value is number => value !== undefined)),
            send: latencyMetric(results.map((result: any) => numberFromPath(result.actual?.sendLatencyMs)).filter((value: number | undefined): value is number => value !== undefined)),
            firstPayload: latencyMetric(results.map((result: any) => numberFromPath(result.actual?.firstPayloadLatencyMs)).filter((value: number | undefined): value is number => value !== undefined)),
        },
        failures: {
            total: results.filter((result: any) => result.status === 'FAILURE').length,
            missingExpectedMessages: countNestedArrayValues(results, 'missingMessages'),
            missingExpectedDiagnostics: countNestedArrayValues(results, 'missingDiagnostics'),
        },
        reconnects: countReconnects(results),
        diagnostics: diagnosticMetricsFromReport(report),
        cleanup: {
            closeSteps: closeResults.length,
            closeSuccess: closeResults.filter((result: any) => result.status === 'SUCCESS').length,
            closeFailure: closeResults.filter((result: any) => result.status === 'FAILURE').length,
            rtcCloseEvents: countArrayValues(report.rtcCloseEvents),
            wsCloseEvents: countArrayValues(report.wsCloseEvents),
        },
    };
}

function withBaseMetrics(report: any): any {
    return {
        ...report,
        metrics: {
            ...baseMetrics(report),
            ...asRecord(report.metrics),
        },
    };
}

function scaleMetrics(results: any[], runs: any[]): unknown {
    const byTransport: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const closeResults = results.filter(result => String(result.action || '').toLowerCase() === 'close');

    results.forEach(result => {
        incrementCount(byTransport, result.transport);
        incrementCount(byAction, result.action || result.method || result.transport);
        incrementCount(byStatus, result.status);
    });

    return {
        byTransport,
        byAction,
        byStatus,
        sends: resultOutcomeMetrics(results, result => String(result.action || '').toLowerCase() === 'send'),
        waits: resultOutcomeMetrics(results, result => ['wait', 'expect'].includes(String(result.action || '').toLowerCase())),
        latencyMs: {
            runDuration: latencyMetric(runs.map(run => numberFromPath(run.summary?.durationMs)).filter((value): value is number => value !== undefined)),
            stepDuration: latencyMetric(results.map(result => numberFromPath(result.durationMs)).filter((value): value is number => value !== undefined)),
            connect: latencyMetric(results.map(result => numberFromPath(result.actual?.connectLatencyMs)).filter((value): value is number => value !== undefined)),
            send: latencyMetric(results.map(result => numberFromPath(result.actual?.sendLatencyMs)).filter((value): value is number => value !== undefined)),
            firstPayload: latencyMetric(results.map(result => numberFromPath(result.actual?.firstPayloadLatencyMs)).filter((value): value is number => value !== undefined)),
        },
        failures: {
            total: results.filter(result => result.status === 'FAILURE').length,
            runs: runs.filter(run => (run.summary?.failure || 0) > 0).length,
            missingExpectedMessages: countNestedArrayValues(results, 'missingMessages'),
            missingExpectedDiagnostics: countNestedArrayValues(results, 'missingDiagnostics'),
        },
        reconnects: countReconnects(results),
        diagnostics: diagnosticMetricsFromValues(runs.flatMap(run => flattenStoreValues(run.report?.rtcDiagnostics))),
        cleanup: {
            closeSteps: closeResults.length,
            closeSuccess: closeResults.filter(result => result.status === 'SUCCESS').length,
            closeFailure: closeResults.filter(result => result.status === 'FAILURE').length,
            rtcCloseEvents: runs.reduce((count, run) => count + countArrayValues(run.report?.rtcCloseEvents), 0),
            wsCloseEvents: runs.reduce((count, run) => count + countArrayValues(run.report?.wsCloseEvents), 0),
        },
    };
}

function uniqueRepeatIndexes(results: any[]): number[] {
    return [...new Set(
        results
            .map((result: any) => Number.parseInt(String(result.repeatIndex), 10))
            .filter((value: number) => Number.isFinite(value) && value > 0)
    )].sort((a, b) => a - b);
}

function soakMetrics(report: any): unknown {
    const results = Array.isArray(report.resultsList) ? report.resultsList : [];
    const byTransport: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const closeResults = results.filter((result: any) => String(result.action || '').toLowerCase() === 'close');

    results.forEach((result: any) => {
        incrementCount(byTransport, result.transport);
        incrementCount(byAction, result.action || result.method || result.transport);
        incrementCount(byStatus, result.status);
    });

    return {
        sameConnection: true,
        iterationsObserved: uniqueRepeatIndexes(results).length,
        byTransport,
        byAction,
        byStatus,
        sends: resultOutcomeMetrics(results, result => String(result.action || '').toLowerCase() === 'send'),
        waits: resultOutcomeMetrics(results, result => ['wait', 'expect'].includes(String(result.action || '').toLowerCase())),
        latencyMs: {
            stepDuration: latencyMetric(results.map((result: any) => numberFromPath(result.durationMs)).filter((value: number | undefined): value is number => value !== undefined)),
            connect: latencyMetric(results.map((result: any) => numberFromPath(result.actual?.connectLatencyMs)).filter((value: number | undefined): value is number => value !== undefined)),
            send: latencyMetric(results.map((result: any) => numberFromPath(result.actual?.sendLatencyMs)).filter((value: number | undefined): value is number => value !== undefined)),
            firstPayload: latencyMetric(results.map((result: any) => numberFromPath(result.actual?.firstPayloadLatencyMs)).filter((value: number | undefined): value is number => value !== undefined)),
        },
        failures: {
            total: results.filter((result: any) => result.status === 'FAILURE').length,
            missingExpectedMessages: countNestedArrayValues(results, 'missingMessages'),
            missingExpectedDiagnostics: countNestedArrayValues(results, 'missingDiagnostics'),
        },
        reconnects: countReconnects(results),
        diagnostics: diagnosticMetricsFromReport(report),
        events: {
            wsMessages: countArrayValues(report.wsMessages),
            wsCloseEvents: countArrayValues(report.wsCloseEvents),
            rtcMessages: countArrayValues(report.rtcMessages),
            rtcDiagnostics: countArrayValues(report.rtcDiagnostics),
            rtcCloseEvents: countArrayValues(report.rtcCloseEvents),
        },
        cleanup: {
            closeSteps: closeResults.length,
            closeSuccess: closeResults.filter((result: any) => result.status === 'SUCCESS').length,
            closeFailure: closeResults.filter((result: any) => result.status === 'FAILURE').length,
            rtcCloseEvents: countArrayValues(report.rtcCloseEvents),
            wsCloseEvents: countArrayValues(report.wsCloseEvents),
        },
    };
}

function withSoakReport(report: any): any {
    if (!soakMode) {
        return report;
    }

    const originalSteps = Array.isArray(input.steps) ? input.steps : [];
    const setupStepCount = resolveSoakStepList(originalSteps, soakConfig.setupSteps || soakConfig.setup, 'setupSteps').length;
    const loopStepCount = resolveSoakLoopSteps(originalSteps, soakConfig).length;
    const cleanupStepCount = resolveSoakStepList(originalSteps, soakConfig.cleanupSteps || soakConfig.cleanup, 'cleanupSteps').length;
    const maxArtifactEvents = firstPositiveInteger(soakConfig.maxArtifactEvents, soakConfig.maxEvents) || 5000;
    const messageCount = toSoakMessageCount(soakConfig);

    return {
        ...report,
        summary: {
            ...report.summary,
            soak: {
                sameConnection: true,
                iterations: toSoakIterationCount(soakConfig, loopStepCount),
                requestedMessageCount: messageCount,
                setupStepCount,
                loopStepCount,
                cleanupStepCount,
                delayMs,
                requestedDurationMs: maxDurationMs || undefined,
                stopOnFailure,
                maxArtifactEvents,
            },
        },
        metrics: {
            ...asRecord(report.metrics),
            soak: soakMetrics(report),
        },
        artifactLimits: {
            ...asRecord(report.artifactLimits),
            maxEvents: maxArtifactEvents,
        },
    };
}

function withTrafficPlanReport(report: any): any {
    if (!trafficExpansion.artifact) {
        return report;
    }

    const artifact = trafficExpansion.artifact;

    return {
        ...report,
        summary: {
            ...report.summary,
            trafficPlan: {
                seed: artifact.seed,
                replay: artifact.replay,
                decisionCount: artifact.decisions.length,
                stepCount: artifact.steps.length,
            },
        },
        trafficPlan: {
            seed: artifact.seed,
            replay: artifact.replay,
            decisions: artifact.decisions,
        },
    };
}

function postRunOperatorKeys(): string[] {
    return [
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
        'exists',
    ];
}

function isPostRunAssertionSpec(value: JsonRecord): boolean {
    return value.path !== undefined ||
        value.metric !== undefined ||
        value.from !== undefined ||
        value.actual !== undefined ||
        value.operator !== undefined ||
        value.op !== undefined ||
        postRunOperatorKeys().some(key => value[key] !== undefined);
}

function normalizePostRunAssertionSource(value: unknown, source: string): JsonRecord[] {
    if (Array.isArray(value)) {
        return value
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map((item, index) => ({
                source,
                index,
                ...(item as JsonRecord),
            }));
    }

    const record = asRecord(value);
    if (Object.keys(record).length <= 0) {
        return [];
    }

    if (isPostRunAssertionSpec(record)) {
        return [{
            source,
            ...record,
        }];
    }

    return Object.entries(record).map(([name, spec]) => {
        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
            const specRecord = spec as JsonRecord;
            return {
                source,
                name: stringValue(specRecord.name) ?? name,
                ...specRecord,
                path: specRecord.path ?? specRecord.metric ?? specRecord.from ?? name,
            };
        }

        return {
            source,
            name,
            path: name,
            equals: spec,
        };
    });
}

function configuredPostRunAssertions(): JsonRecord[] {
    return [
        ...normalizePostRunAssertionSource(input.postRunAssertions, 'postRunAssertions'),
        ...normalizePostRunAssertionSource(executionConfig.postRunAssertions, 'execution.postRunAssertions'),
        ...normalizePostRunAssertionSource(executionConfig.thresholds, 'execution.thresholds'),
    ];
}

function reportPathSegments(path: string): string[] {
    const segments: string[] = [];
    let current = '';

    for (let index = 0; index < path.length; index++) {
        const character = path[index];

        if (character === '.') {
            if (current.length > 0) {
                segments.push(current);
                current = '';
            }
            continue;
        }

        if (character === '[') {
            if (current.length > 0) {
                segments.push(current);
                current = '';
            }
            const endIndex = path.indexOf(']', index);
            if (endIndex < 0) {
                current += character;
                continue;
            }
            const rawSegment = path.slice(index + 1, endIndex).trim();
            segments.push(rawSegment.replace(/^['"]|['"]$/g, ''));
            index = endIndex;
            continue;
        }

        current += character;
    }

    if (current.length > 0) {
        segments.push(current);
    }

    return segments.filter(segment => segment.length > 0);
}

function resolveReportPath(report: any, path: string | undefined): { found: boolean; value?: unknown } {
    if (!path || path.trim().length <= 0) {
        return {
            found: false,
        };
    }

    const segments = reportPathSegments(path.trim());
    const normalizedSegments = segments[0] === 'report'
        ? segments.slice(1)
        : segments;
    let value = report;

    for (const segment of normalizedSegments) {
        if (value === undefined || value === null) {
            return {
                found: false,
            };
        }

        value = value[segment];
    }

    return value === undefined
        ? {
            found: false,
        }
        : {
            found: true,
            value,
        };
}

function firstConfiguredOperator(spec: JsonRecord): string {
    const explicit = stringValue(spec.operator) ?? stringValue(spec.op);
    if (explicit) {
        return explicit;
    }

    return postRunOperatorKeys().find(key => spec[key] !== undefined) ?? 'equals';
}

function operatorExpectedValue(spec: JsonRecord, aliases: string[]): unknown {
    for (const alias of aliases) {
        if (spec[alias] !== undefined) {
            return spec[alias];
        }
    }

    if (spec.value !== undefined) {
        return spec.value;
    }

    return spec.expected;
}

function numberComparison(operator: string, actual: unknown, expected: unknown): { pass: boolean; details?: JsonRecord } {
    const actualNumber = Number(actual);
    const expectedNumber = Number(expected);

    if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) {
        return {
            pass: false,
            details: {
                reason: 'numeric-comparison-requires-finite-values',
                actual,
                expected,
            },
        };
    }

    if (operator === 'gt') {
        return {
            pass: actualNumber > expectedNumber,
        };
    }

    if (operator === 'gte' || operator === 'min' || operator === 'atLeast') {
        return {
            pass: actualNumber >= expectedNumber,
        };
    }

    if (operator === 'lt') {
        return {
            pass: actualNumber < expectedNumber,
        };
    }

    return {
        pass: actualNumber <= expectedNumber,
    };
}

function includesValue(actual: unknown, expected: unknown, spec: JsonRecord): boolean {
    if (typeof actual === 'string') {
        return actual.includes(String(expected));
    }

    if (Array.isArray(actual)) {
        return actual.some(item => compareJson(
            expected as any,
            item as any,
            toConfig(
                String(spec.comparison || COMPARISON.COMPATIBLE),
                Array.isArray(spec.ignoreJsonKeys) ? spec.ignoreJsonKeys as string[] : [],
                Array.isArray(spec.ignoreJsonPaths) ? spec.ignoreJsonPaths as string[] : [],
            ),
        ).isEqual);
    }

    if (actual && typeof actual === 'object' && typeof expected === 'string') {
        return Object.prototype.hasOwnProperty.call(actual, expected);
    }

    return false;
}

function postRunAssertionName(spec: JsonRecord, index: number, path: string | undefined): string {
    return stringValue(spec.name) ??
        stringValue(spec.label) ??
        path ??
        'post-run-assertion-' + (index + 1);
}

function toPostRunAssertionResult(
    spec: JsonRecord,
    index: number,
    report: any,
): JsonRecord {
    const path = stringValue(spec.path ?? spec.metric ?? spec.from);
    const name = postRunAssertionName(spec, index, path);
    const operator = firstConfiguredOperator(spec);
    const resolved = spec.actual !== undefined
        ? {
            found: true,
            value: spec.actual,
        }
        : resolveReportPath(report, path);
    const actual = resolved.value;
    const common = {
        name,
        path,
        operator,
        source: stringValue(spec.source),
        index: numberFromPath(spec.index),
        actual,
    };

    if (operator === 'exists') {
        const expectedExists = spec.exists === undefined ? true : Boolean(spec.exists);
        const actualExists = resolved.found;
        const status = actualExists === expectedExists ? 'SUCCESS' : 'FAILURE';
        return {
            ...common,
            status,
            expected: expectedExists,
            ...(status === 'FAILURE' ? {
                result: 'Post-run assertion failed',
                details: {
                    reason: expectedExists ? 'path-missing' : 'path-present',
                },
            } : {}),
        };
    }

    if (!resolved.found) {
        return {
            ...common,
            status: 'FAILURE',
            expected: operatorExpectedValue(spec, [operator, 'expected', 'equals', 'eq']),
            result: 'Post-run assertion failed',
            details: {
                reason: 'path-missing',
            },
        };
    }

    if (operator === 'equals' || operator === 'eq' || operator === 'expected') {
        const expected = operatorExpectedValue(spec, ['equals', 'eq', 'expected']);
        const comparison = compareJson(
            expected as any,
            actual as any,
            toConfig(
                String(spec.comparison || COMPARISON.COMPATIBLE),
                Array.isArray(spec.ignoreJsonKeys) ? spec.ignoreJsonKeys as string[] : [],
                Array.isArray(spec.ignoreJsonPaths) ? spec.ignoreJsonPaths as string[] : [],
            ),
        );

        return {
            ...common,
            expected,
            status: comparison.isEqual ? 'SUCCESS' : 'FAILURE',
            ...(comparison.isEqual ? {} : {
                result: 'Post-run assertion failed',
                details: {
                    comparison,
                },
            }),
        };
    }

    if (operator === 'notEquals' || operator === 'ne') {
        const expected = operatorExpectedValue(spec, ['notEquals', 'ne', 'expected', 'equals', 'eq']);
        const comparison = compareJson(
            expected as any,
            actual as any,
            toConfig(String(spec.comparison || COMPARISON.COMPATIBLE)),
        );

        return {
            ...common,
            expected,
            status: comparison.isEqual ? 'FAILURE' : 'SUCCESS',
            ...(comparison.isEqual ? {
                result: 'Post-run assertion failed',
                details: {
                    reason: 'values-were-equal',
                    comparison,
                },
            } : {}),
        };
    }

    if (['gt', 'gte', 'min', 'atLeast', 'lt', 'lte', 'max', 'atMost'].includes(operator)) {
        const expected = operatorExpectedValue(spec, [operator, 'value', 'expected']);
        const comparison = numberComparison(operator, actual, expected);
        return {
            ...common,
            expected,
            status: comparison.pass ? 'SUCCESS' : 'FAILURE',
            ...(comparison.pass ? {} : {
                result: 'Post-run assertion failed',
                details: comparison.details ?? {
                    reason: 'numeric-threshold-not-met',
                },
            }),
        };
    }

    if (operator === 'between') {
        const expected = operatorExpectedValue(spec, ['between']);
        const range = Array.isArray(expected) ? expected : [];
        const actualNumber = Number(actual);
        const min = Number(range[0]);
        const max = Number(range[1]);
        const pass = Number.isFinite(actualNumber) &&
            Number.isFinite(min) &&
            Number.isFinite(max) &&
            actualNumber >= min &&
            actualNumber <= max;

        return {
            ...common,
            expected,
            status: pass ? 'SUCCESS' : 'FAILURE',
            ...(pass ? {} : {
                result: 'Post-run assertion failed',
                details: {
                    reason: 'between-threshold-not-met',
                    min: range[0],
                    max: range[1],
                },
            }),
        };
    }

    if (operator === 'includes' || operator === 'contains' || operator === 'notIncludes') {
        const expected = operatorExpectedValue(spec, ['includes', 'contains', 'notIncludes', 'expected', 'value']);
        const includes = includesValue(actual, expected, spec);
        const pass = operator === 'notIncludes' ? !includes : includes;

        return {
            ...common,
            expected,
            status: pass ? 'SUCCESS' : 'FAILURE',
            ...(pass ? {} : {
                result: 'Post-run assertion failed',
                details: {
                    reason: operator === 'notIncludes' ? 'value-was-included' : 'value-was-not-included',
                },
            }),
        };
    }

    return {
        ...common,
        status: 'FAILURE',
        expected: operatorExpectedValue(spec, [operator, 'expected', 'value']),
        result: 'Post-run assertion failed',
        details: {
            reason: 'unsupported-post-run-operator',
            supportedOperators: postRunOperatorKeys(),
        },
    };
}

function withPostRunAssertions(report: any, assertions: JsonRecord[]): any {
    if (assertions.length <= 0) {
        return report;
    }

    const results = assertions.map((assertion, index) => toPostRunAssertionResult(assertion, index, report));
    const failures = results.filter(result => result.status === 'FAILURE');
    const summary = {
        total: results.length,
        success: results.length - failures.length,
        failure: failures.length,
    };

    return sync.redactBlackBoxData({
        ...report,
        summary: {
            ...report.summary,
            ok: Number(report.summary?.failure || 0) <= 0 && failures.length <= 0,
            postRunAssertions: summary,
            firstPostRunAssertionFailure: failures[0]
                ? {
                    name: failures[0].name,
                    path: failures[0].path,
                    operator: failures[0].operator,
                    expected: failures[0].expected,
                    actual: failures[0].actual,
                    result: failures[0].result,
                }
                : undefined,
        },
        postRunAssertions: {
            summary,
            results,
        },
    }, resolvedVariables.redactions);
}

function withFinalReportChecks(report: any, includePostRunAssertions: boolean): any {
    if (!includePostRunAssertions) {
        return report;
    }

    const assertions = configuredPostRunAssertions();
    if (assertions.length <= 0) {
        return report;
    }

    const reportWithMetrics = withConfiguredArtifactLimits(withBaseMetrics(report));
    const reportWithArtifact = withArtifactReport(reportWithMetrics);
    const reportWithAssertions = withPostRunAssertions(reportWithArtifact, assertions);

    return withArtifactReport(reportWithAssertions);
}

function hasReportFailures(report: any): boolean {
    return Number(report?.summary?.failure || 0) > 0 ||
        Number(report?.summary?.postRunAssertions?.failure || 0) > 0;
}

function annotateRunResults(report: any, runIndex: number): any[] {
    return (report.resultsList || []).map((result: any) => ({
        ...result,
        runIndex,
        stepResultKey: result.resultKey,
        resultKey: ['run' + runIndex, result.resultKey].filter(Boolean).join('-'),
    }));
}

function toResultsByName(results: any[]): Record<string, any[]> {
    return results.reduce<Record<string, any[]>>((byName, result) => {
        byName[result.name] = byName[result.name] || [];
        byName[result.name].push(result);
        return byName;
    }, {});
}

function mergeRunStores(runs: any[], storeName: string): Record<string, unknown[]> {
    return runs.reduce<Record<string, unknown[]>>((merged, run) => {
        Object.entries(asRecord(run.report?.[storeName])).forEach(([connection, values]) => {
            const key = ['run' + run.runIndex, connection].join(':');
            merged[key] = Array.isArray(values)
                ? values.map(value => ({
                    runIndex: run.runIndex,
                    connection,
                    value,
                }))
                : [];
        });

        return merged;
    }, {});
}

function aggregateReports(runs: any[], startedAtEpochMs: number, endedAtEpochMs: number): any {
    const resultsList = runs.flatMap(run => annotateRunResults(run.report, run.runIndex));
    const results = Object.fromEntries(resultsList.map(result => [result.resultKey, result]));
    const firstFailure = resultsList.find(result => result.status === 'FAILURE');
    const failedRuns = runs.filter(run => (run.summary?.failure || 0) > 0).length;
    const success = resultsList.filter(result => result.status === 'SUCCESS').length;
    const failure = resultsList.filter(result => result.status === 'FAILURE').length;

    return {
        summary: {
            total: resultsList.length,
            success,
            failure,
            failFast,
            durationMs: endedAtEpochMs - startedAtEpochMs,
            runnerRunId: runs.at(0)?.report?.runnerRunId,
            runs: runs.length,
            passedRuns: runs.length - failedRuns,
            failedRuns,
            scale: {
                requestedIterations: requestedIterations || undefined,
                maxRuns,
                maxDurationMs: maxDurationMs || undefined,
                delayMs,
                stopOnFailure,
            },
            firstFailure: firstFailure
                ? {
                    resultKey: firstFailure.resultKey,
                    stepResultKey: firstFailure.stepResultKey,
                    runIndex: firstFailure.runIndex,
                    name: firstFailure.name,
                    transport: firstFailure.transport,
                    action: firstFailure.action,
                    connection: firstFailure.connection,
                    result: firstFailure.result,
                    exception: firstFailure.exception,
                    method: firstFailure.method,
                    path: firstFailure.path,
                    scenarioExecutionNumber: firstFailure.scenarioExecutionNumber,
                    interactionExecutionNumber: firstFailure.interactionExecutionNumber,
                    repeatIndex: firstFailure.repeatIndex,
                }
                : undefined,
        },
        runs: runs.map(run => ({
            runIndex: run.runIndex,
            startedAtEpochMs: run.startedAtEpochMs,
            endedAtEpochMs: run.endedAtEpochMs,
            durationMs: run.endedAtEpochMs - run.startedAtEpochMs,
            runnerRunId: run.report?.runnerRunId,
            correlation: run.report?.correlation,
            summary: run.summary,
            outputs: run.report?.outputs || {},
        })),
        runnerRunId: runs.at(0)?.report?.runnerRunId,
        correlation: runs.at(0)?.report?.correlation,
        results,
        resultsList,
        resultsByName: toResultsByName(resultsList),
        outputs: runs.at(-1)?.report?.outputs || {},
        outputsByRun: Object.fromEntries(runs.map(run => [String(run.runIndex), run.report?.outputs || {}])),
        metrics: scaleMetrics(resultsList, runs),
        wsMessages: mergeRunStores(runs, 'wsMessages'),
        wsCloseEvents: mergeRunStores(runs, 'wsCloseEvents'),
        rtcConnections: {},
        rtcMessages: mergeRunStores(runs, 'rtcMessages'),
        rtcDiagnostics: mergeRunStores(runs, 'rtcDiagnostics'),
        rtcCloseEvents: mergeRunStores(runs, 'rtcCloseEvents'),
        rtcProviderNames: runs.at(-1)?.report?.rtcProviderNames || [],
    };
}

async function executeOnce(includePostRunAssertions = true, runIndex = 1): Promise<any> {
    const report = await sync.executeBlackBox(scenarioJson, 0, {
        failFast,
        dryRun,
        variables: input.variables || {},
        redactions: resolvedVariables.redactions,
        correlation: correlationConfig,
        runnerRunId: correlationConfig.runnerRunId,
        runIndex,
        stateWriteEvidenceCollector: collectApiV1StateWriteEvidence,
    });
    return withFinalReportChecks(withTrafficPlanReport(withSoakReport(report)), includePostRunAssertions);
}

async function executeScale(): Promise<any> {
    const runs: any[] = [];
    const startedAtEpochMs = Date.now();

    while (runs.length < maxRuns) {
        if (runs.length > 0 && maxDurationMs > 0 && Date.now() - startedAtEpochMs >= maxDurationMs) {
            break;
        }

        if (runs.length > 0) {
            await sleep(delayMs);
        }
        const runIndex = runs.length + 1;
        const runStartedAtEpochMs = Date.now();
        const report = await executeOnce(false, runIndex);
        const runEndedAtEpochMs = Date.now();

        runs.push({
            runIndex,
            startedAtEpochMs: runStartedAtEpochMs,
            endedAtEpochMs: runEndedAtEpochMs,
            summary: report.summary,
            report,
        });

        if (stopOnFailure && report?.summary?.failure > 0) {
            break;
        }
    }

    return withFinalReportChecks(aggregateReports(runs, startedAtEpochMs, Date.now()), true);
}

if (preflightMode) {
    const preflight = explainBlackBoxRunnerPlan({
        rawConfig: preflightRawInput,
        expandedConfig: expandedInput,
        executableInteractions: scenarioJson,
        envRequirements,
        trafficPlanArtifact: trafficExpansion.artifact,
        profile: preflightProfile,
        expansionError: planExpansionError,
    });

    console.log(JSON.stringify(sync.redactBlackBoxData(preflight, resolvedVariables.redactions), null, 2));
    process.exit(preflight.ok ? 0 : 1);
} else if (printDryExecutableInteractions) {
    console.log(JSON.stringify(sync.redactBlackBoxData(scenarioJson, resolvedVariables.redactions), null, 2));
} else {
    (scaleMode ? executeScale() : executeOnce())
        .then(async report => {
            if (artifactDir) {
                await writeArtifacts(report, artifactDir);
            }
            console.log(JSON.stringify(artifactBounds.withBoundedArtifactReportStores(
                artifactBounds.withBoundedArtifactReportResults(
                    report, configuredArtifactOptions().maxReportResults)), null, 2));

            if (hasReportFailures(report)) {
                process.exit(1);
            }
        })
        .catch(e => {
            console.error(e);
            process.exit(1);
        });
}
