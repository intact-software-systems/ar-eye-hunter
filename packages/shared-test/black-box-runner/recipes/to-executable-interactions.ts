import * as scenarioAlgorithms from '../scenario-algorithm.ts';
import type { ScenarioRecipe } from './read-scenario-recipe-includes.ts';
import { expandInlineLoopSteps } from './scenario-workload.ts';
import { toRecipeStepAction } from './to-recipe-step-action.ts';

type JsonRecord = Record<string, unknown>;

interface ExecutableBuildState {
    nextInteractionExecutionNumber: number;
}

interface ParallelStepInput {
    readonly step: JsonRecord;
    readonly config: ScenarioRecipe;
    readonly state: ExecutableBuildState;
    readonly interactionExecutionNumber: number;
}

function asRecord(value: unknown): JsonRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function replaceVariables<T>(data: T, variables: Record<string, unknown> = {}): T {
    let text = JSON.stringify(data);

    Object.entries(variables)
        .forEach(([key, value]) => {
            text = text.replaceAll('{' + key + '}', String(value));
        });

    return JSON.parse(text);
}

function toStepExecutionMetadata(step: JsonRecord, interactionExecutionNumber: number): JsonRecord {
    return {
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
        loopPhase: step.loopPhase
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
    config: Record<string, unknown>
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
                ...asRecord(request.resilience)
            },
            headers: {
                ...defaultHeaders,
                ...connectionHeaders,
                ...requestHeaders
            }
        },
        expect: {
            ...expect,
            comparison: expect.comparison || defaults.comparison,
            ignoreJsonKeys: expect.ignoreJsonKeys || defaults.ignoreJsonKeys,
            ignoreJsonPaths: expect.ignoreJsonPaths || defaults.ignoreJsonPaths
        }
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
    inferredInputs: string[] = []
): Record<string, unknown> {
    const request = asRecord(step.request);
    const expect = asRecord(step.expect || step.response);

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

    const action = toRecipeStepAction(step);

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
                ...toStepExecutionMetadata(step, interactionExecutionNumber),
                parallelGroup: step.parallelGroup,
                parallelGroupIndex: step.parallelGroupIndex,
                parallelStepIndex: step.parallelStepIndex
            },
            response: {
                ...expect,
                actual: step.actual !== undefined ? step.actual : expect.actual,
                statusCode: expect.statusCode !== undefined ? expect.statusCode : expect.status
            }
        },
        [String(step.name || 'step-' + interactionExecutionNumber)]: step
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
        .map((match) => match[1])
        .map((path) => path.split('.')[0])
        .filter((name) => name.length > 0);
}

function toStepOutputName(step: Record<string, unknown>): string | undefined {
    const request = asRecord(step.request);
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
    currentIndex: number
): string[] {
    const knownOutputs = toKnownOutputNames(steps, currentIndex);
    const placeholderNames = toPlaceholderNames(step);

    return [
        ...new Set(
            placeholderNames.filter((name) => knownOutputs.includes(name))
        )
    ];
}

function toRepeatedSteps(steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return steps.flatMap((step) => {
        const repeat = Number.parseInt(String(step.repeat ?? '1'));

        return new Array(Number.isFinite(repeat) && repeat > 0 ? repeat : 1)
            .fill(0)
            .map((_ignored, repeatIndex) => ({
                ...step,
                repeatIndex: step.repeatIndex ?? repeatIndex + 1
            }));
    });
}

function toParallelGroupSpecs(step: Record<string, unknown>): Array<JsonRecord> {
    if (Array.isArray(step.groups)) {
        return step.groups
            .filter((group) => group && typeof group === 'object' && !Array.isArray(group))
            .map((group, index) => ({
                name: String((group as JsonRecord).name || 'group-' + (index + 1)),
                steps: Array.isArray((group as JsonRecord).steps)
                    ? (group as JsonRecord).steps
                    : []
            }));
    }

    if (Array.isArray(step.steps)) {
        return step.steps.map((nestedStep, index) => {
            if (
                nestedStep && typeof nestedStep === 'object' && !Array.isArray(nestedStep) &&
                Array.isArray((nestedStep as JsonRecord).steps)
            ) {
                return {
                    name: String((nestedStep as JsonRecord).name || 'group-' + (index + 1)),
                    steps: (nestedStep as JsonRecord).steps
                };
            }

            return {
                name: String((nestedStep as JsonRecord)?.name || 'group-' + (index + 1)),
                steps: [nestedStep]
            };
        });
    }

    return [];
}

function toExecutableParallelStep(input: ParallelStepInput): Record<string, unknown> {
    const { step, config, state, interactionExecutionNumber } = input;
    const request = asRecord(step.request);
    const expect = asRecord(step.expect || step.response);
    const groups = toParallelGroupSpecs(step).map((group, groupIndex) => {
        const groupName = String(group.name || 'group-' + (groupIndex + 1));
        const rawSteps = Array.isArray(group.steps)
            ? group.steps
                .filter((nestedStep) => nestedStep && typeof nestedStep === 'object' && !Array.isArray(nestedStep))
                .map((nestedStep, stepIndex) => ({
                    ...asRecord(nestedStep),
                    parallelGroup: groupName,
                    parallelGroupIndex: groupIndex + 1,
                    parallelStepIndex: stepIndex + 1
                }))
            : [];

        return {
            name: groupName,
            index: groupIndex + 1,
            steps: toExecutableSteps(rawSteps as Array<Record<string, unknown>>, config, state)
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
                ...toStepExecutionMetadata(step, interactionExecutionNumber)
            },
            response: {
                ...expect
            }
        },
        [String(step.name || 'parallel-' + interactionExecutionNumber)]: step
    };
}

function toExecutableSteps(
    rawSteps: Array<Record<string, unknown>>,
    config: ScenarioRecipe,
    state: ExecutableBuildState
): Array<Record<string, unknown>> {
    const expandedRawSteps = expandInlineLoopSteps(rawSteps as Array<JsonRecord>) as Array<Record<string, unknown>>;
    const steps = toRepeatedSteps(expandedRawSteps)
        .map((step: Record<string, unknown>) => withDefaultsAndConnection(step, config as Record<string, unknown>));

    return steps
        .map((step: Record<string, unknown>, index: number) => {
            const interactionExecutionNumber = nextInteractionExecutionNumber(state);
            return isParallelStep(step)
                ? toExecutableParallelStep({ step, config, state, interactionExecutionNumber })
                : toExecutableStep(
                    step,
                    interactionExecutionNumber,
                    toInferredInputs(step, steps, index)
                );
        });
}

export function toExecutableInteractions(config: ScenarioRecipe): unknown[] {
    const normalizedConfig = replaceVariables(config, config.variables);

    if (Array.isArray(normalizedConfig.steps)) {
        return toExecutableSteps(
            normalizedConfig.steps as Array<Record<string, unknown>>,
            normalizedConfig,
            {
                nextInteractionExecutionNumber: 1
            }
        );
    }

    return scenarioAlgorithms.createScenarios(normalizedConfig).flatMap((a) => a);
}
