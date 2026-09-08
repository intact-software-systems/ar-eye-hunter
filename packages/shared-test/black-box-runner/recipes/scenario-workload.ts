import utils from '../utils.ts';
import type { ScenarioRecipe } from './read-scenario-recipe-includes.ts';

export type TrafficPlanArtifact = GeneratedTrafficPlanArtifact | ReplayedTrafficPlanArtifact;

interface TrafficPlanContent extends Record<string, unknown> {
    readonly version: number;
    readonly seed: number;
    readonly steps: Record<string, unknown>[];
    readonly replayRecipe: ScenarioRecipe;
}

export interface GeneratedTrafficPlanArtifact extends TrafficPlanContent {
    readonly replay: false;
    readonly generator: TrafficPlanGenerator;
    readonly decisions: TrafficDecision[];
}

export interface ReplayedTrafficPlanArtifact extends TrafficPlanContent {
    readonly replay: true;
    readonly generator: TrafficReplaySource;
    readonly decisions: Record<string, unknown>[];
}

export interface TrafficReplaySource {
    readonly replayFrom: unknown;
}

export interface TrafficPlanGenerator extends Record<string, unknown> {
    readonly pacing: TrafficPacingConfig;
    readonly operations: TrafficOperationSummary[];
}

export interface TrafficOperationSummary {
    readonly name: string;
    readonly index: number;
    readonly weight: number;
    readonly stepCount: number;
}

export interface TrafficDecision {
    readonly sequence: number;
    readonly operation: string;
    readonly operationIndex: number;
    readonly operationRandom: number;
    readonly random: number;
    readonly randomInt: number;
    readonly delayMs: number;
    readonly burstIndex: number;
    readonly burstPosition: number;
    readonly pacing: TrafficPacingConfig;
}

interface TrafficOperation {
    readonly name: string;
    readonly index: number;
    readonly weight: number;
    readonly steps: Record<string, unknown>[];
}

interface TrafficTemplateRoot extends Record<string, unknown> {
    readonly traffic: TrafficTemplateValues;
}

interface TrafficTemplateValues {
    readonly seed: number;
    readonly sequence: number;
    readonly iteration: number;
    readonly operation: string;
    readonly operationIndex: number;
    readonly random: number;
    readonly randomInt: number;
    readonly pacing: TrafficPacingConfig;
}

interface InlineLoopTemplateRoot extends Record<string, unknown> {
    readonly loop: InlineLoopTemplateValues;
}

interface InlineLoopTemplateValues {
    readonly name: string;
    readonly index: number;
    readonly iteration: number;
    readonly stepIndex: number;
    readonly count: number;
    readonly elapsedMs: number;
}

export interface ScenarioWorkloadLimits {
    readonly delayMs: number;
    readonly requestedIterations: number | undefined;
    readonly maxDurationMs: number;
    readonly maxRuns: number;
    readonly stopOnFailure: boolean;
}

export interface ScenarioSoakSummary {
    readonly sameConnection: true;
    readonly iterations: number;
    readonly requestedMessageCount: number | undefined;
    readonly setupStepCount: number;
    readonly loopStepCount: number;
    readonly cleanupStepCount: number;
    readonly delayMs: number;
    readonly requestedDurationMs: number | undefined;
    readonly stopOnFailure: boolean;
    readonly maxArtifactEvents: number;
}

export interface ScenarioWorkload {
    readonly config: ScenarioRecipe;
    readonly artifact?: TrafficPlanArtifact;
    readonly soak?: ScenarioSoakSummary;
}

interface TrafficAnnotatedStep extends Record<string, unknown> {
    readonly trafficPlan: TrafficPlanIdentity;
    readonly trafficSeed: number;
    readonly trafficSequence: number;
    readonly trafficOperation: string;
}

interface TrafficPlanIdentity {
    readonly seed: number;
    readonly pacing?: TrafficPacingConfig;
}

interface InlineLoopAnnotatedStep extends Record<string, unknown> {
    readonly loopName: string;
    readonly loopIndex: number;
    readonly loopIteration: number;
    readonly loopStepIndex: number;
    readonly loopCount: number;
    readonly loopElapsedMs: number;
    readonly loopPhase: 'body';
    readonly repeatIndex: unknown;
}

interface ScenarioDelayRequest {
    readonly delayMs: number;
}

interface ScenarioDelayStep<Value> extends Record<string, unknown> {
    readonly name: string;
    readonly type: 'set';
    readonly output: string;
    readonly value: Value;
    readonly request: ScenarioDelayRequest;
}

interface InlineLoopDelayValue {
    readonly delayedMs: number;
    readonly loopName: string;
    readonly loopIteration: number;
    readonly loopCount: number;
}

interface InlineLoopDelayStep extends ScenarioDelayStep<InlineLoopDelayValue> {
    readonly loopName: string;
    readonly loopIteration: number;
    readonly loopCount: number;
    readonly loopPhase: 'delay';
    readonly repeatIndex: number;
}

interface TrafficDelayValue {
    readonly delayedMs: number;
    readonly trafficSequence: number;
    readonly burstSize: number;
    readonly maxInFlight: number | undefined;
}

interface TrafficDelayStep extends ScenarioDelayStep<TrafficDelayValue>, TrafficAnnotatedStep {
    readonly trafficPacing: TrafficPacingConfig;
}

interface SoakDelayValue {
    readonly delayedMs: number;
    readonly soakIteration: number;
}

interface SoakDelayStep extends ScenarioDelayStep<SoakDelayValue> {
    readonly soakPhase: 'delay';
    readonly soakIteration: number;
    readonly repeatIndex: number;
}

interface SoakAnnotatedStep extends Record<string, unknown> {
    readonly soakPhase: string;
    readonly soakIteration?: unknown;
    readonly repeatIndex?: unknown;
    readonly soakLoopIndex?: unknown;
}

interface ScenarioStepSelection {
    readonly allSteps: Record<string, unknown>[];
    readonly configured: unknown;
    readonly fieldName: string;
    readonly stepLabel: string;
}

interface InlineLoopDelay {
    readonly loopName: string;
    readonly iteration: number;
    readonly iterations: number;
    readonly intervalMs: number;
}

interface InlineLoopExpansion {
    readonly step: Record<string, unknown>;
    readonly stepIndex: number;
    readonly allSteps: Record<string, unknown>[];
    readonly depth: number;
}

export interface TrafficPacingConfig {
    rateHz?: number;
    intervalMs: number;
    jitterMs: number;
    burstSize: number;
    maxInFlight?: number;
}

interface TrafficDelayInput {
    readonly pacing: TrafficPacingConfig;
    readonly sequence: number;
    readonly count: number;
    readonly jitterRandom: number;
}

interface TrafficDelayStepInput {
    readonly sequence: number;
    readonly configuredDelayMs: number;
    readonly seed: number;
    readonly pacing: TrafficPacingConfig;
}

interface TrafficReplayContent {
    readonly version: number;
    readonly seed: number;
    readonly steps: Record<string, unknown>[];
    readonly decisions?: TrafficDecision[];
}

interface TrafficLoopInput {
    readonly allSteps: Record<string, unknown>[];
    readonly seed: number;
    readonly count: number;
    readonly pacing: TrafficPacingConfig;
    readonly operations: TrafficOperation[];
}

interface TrafficLoopComputed {
    readonly steps: Record<string, unknown>[];
    readonly decisions: TrafficDecision[];
}

interface TrafficTemplateInput {
    readonly seed: number;
    readonly sequence: number;
    readonly operation: TrafficOperation;
    readonly randomValue: number;
    readonly randomInt: number;
    readonly pacing: TrafficPacingConfig;
}

interface SoakStepPosition {
    readonly phase: string;
    readonly iteration?: number;
    readonly loopIndex?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readScenarioWorkload(config: ScenarioRecipe, limits: ScenarioWorkloadLimits): ScenarioWorkload {
    const execution = asRecord(config.execution);
    const trafficConfig = asRecord(execution.trafficPlan || config.trafficPlan);
    const traffic = Object.keys(trafficConfig).length > 0 && trafficConfig.enabled !== false
        ? readReplayTrafficPlan(config, trafficConfig) || toGeneratedTrafficPlan(config, trafficConfig, limits)
        : undefined;
    const trafficRecipe = traffic ? { ...config, steps: traffic.steps } : config;
    const soakConfig = asRecord(execution.soak);
    const soakEnabled = Object.keys(soakConfig).length > 0 && soakConfig.enabled !== false;
    return {
        config: soakEnabled ? toSoakExpandedConfig(trafficRecipe, soakConfig, limits) : trafficRecipe,
        ...(traffic ? { artifact: traffic } : {}),
        ...(soakEnabled ? { soak: computeSoakSummary(config, soakConfig, limits) } : {})
    };
}

function computeSoakSummary(
    config: ScenarioRecipe,
    soakConfig: Record<string, unknown>,
    limits: ScenarioWorkloadLimits
): ScenarioSoakSummary {
    const originalSteps = config.steps || [];
    const loopStepCount = resolveSoakLoopSteps(originalSteps, soakConfig).length;
    return {
        sameConnection: true,
        iterations: toSoakIterationCount(soakConfig, loopStepCount, limits),
        requestedMessageCount: toSoakMessageCount(soakConfig),
        setupStepCount:
            resolveRecipeStepList(originalSteps, soakConfig.setupSteps || soakConfig.setup, 'setupSteps').length,
        loopStepCount,
        cleanupStepCount:
            resolveRecipeStepList(originalSteps, soakConfig.cleanupSteps || soakConfig.cleanup, 'cleanupSteps').length,
        delayMs: limits.delayMs,
        requestedDurationMs: limits.maxDurationMs || undefined,
        stopOnFailure: limits.stopOnFailure,
        maxArtifactEvents: firstPositiveInteger([soakConfig.maxArtifactEvents, soakConfig.maxEvents]) || 5000
    };
}

export function firstPositiveInteger(values: readonly unknown[]): number | undefined {
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

export function firstNonNegativeInteger(values: readonly unknown[]): number | undefined {
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

function firstPositiveNumber(values: readonly unknown[]): number | undefined {
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

function stepName(step: Record<string, unknown>, index: number): string {
    return typeof step.name === 'string' && step.name.length > 0
        ? step.name
        : 'step-' + (index + 1);
}

function cloneStep(step: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(step));
}

function resolveStepList(selection: ScenarioStepSelection): Record<string, unknown>[] {
    const { allSteps, configured, fieldName, stepLabel } = selection;
    if (!Array.isArray(configured)) {
        return [];
    }

    if (configured.every((item) => typeof item === 'string')) {
        const byName = new Map(allSteps.map((step, index) => [stepName(step, index), step]));
        return configured.map((name) => {
            const step = byName.get(String(name));
            if (!step) {
                throw new Error('Unknown ' + stepLabel + ' step in ' + fieldName + ': ' + String(name));
            }

            return cloneStep(step);
        });
    }

    return configured
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => cloneStep(item as Record<string, unknown>));
}

function resolveRecipeStepList(
    allSteps: Array<Record<string, unknown>>,
    configured: unknown,
    fieldName: string
): Array<Record<string, unknown>> {
    return resolveStepList({ allSteps, configured, fieldName, stepLabel: 'soak' });
}

function resolveSoakLoopSteps(
    allSteps: Array<Record<string, unknown>>,
    config: Record<string, unknown>
): Array<Record<string, unknown>> {
    return resolveRecipeStepList(
        allSteps,
        config.loopSteps || config.loop || config.steps,
        'loopSteps'
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

function resolveTemplatePath(path: string, root: Record<string, unknown>): unknown {
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

function resolveTrafficTemplate(value: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown>;
function resolveTrafficTemplate(value: unknown, root: Record<string, unknown>): unknown;
function resolveTrafficTemplate(value: unknown, root: Record<string, unknown>): unknown {
    if (typeof value === 'string') {
        const exactPlaceholderMatch = value.match(/^\{([^{}]+)}$/);
        if (exactPlaceholderMatch) {
            const resolved = resolveTemplatePath(exactPlaceholderMatch[1], root);
            return (resolved === undefined ? value : resolved);
        }

        return value.replaceAll(/\{([^{}]+)}/g, (match, path) => {
            const resolved = resolveTemplatePath(path, root);
            return resolved === undefined
                ? match
                : stringifyTemplateValue(resolved);
        });
    }

    if (Array.isArray(value)) {
        return value.map((item) => resolveTrafficTemplate(item, root));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .map(([key, nested]) => [key, resolveTrafficTemplate(nested, root)])
        );
    }

    return value;
}

function isInlineLoopStep(step: Record<string, unknown>): boolean {
    const stepType = String(step.type || '').toLowerCase();
    return stepType === 'loop' ||
        stepType.startsWith('loop.') ||
        (step.loop === true && Array.isArray(step.steps));
}

function toInlineLoopSteps(
    allSteps: Array<Record<string, unknown>>,
    step: Record<string, unknown>
): Array<Record<string, unknown>> {
    const loopConfig = Array.isArray(step.loop)
        ? step.loop
        : undefined;

    return resolveStepList({
        allSteps,
        configured: step.loopSteps || loopConfig || step.steps,
        fieldName: 'loop.steps',
        stepLabel: 'loop'
    });
}

function toInlineLoopIntervalMs(step: Record<string, unknown>): number {
    const request = asRecord(step.request);
    const rateHz = firstPositiveNumber([step.rateHz, request.rateHz]);

    return firstNonNegativeInteger([
        step.intervalMs,
        request.intervalMs,
        rateHz ? Math.max(1, Math.round(1000 / rateHz)) : undefined,
        step.delayMs,
        request.delayMs
    ]) || 0;
}

function toInlineLoopMessageCount(step: Record<string, unknown>): number | undefined {
    const request = asRecord(step.request);
    return firstPositiveInteger([step.messageCount, request.messageCount, step.messages, request.messages]);
}

function toInlineLoopIterationCount(step: Record<string, unknown>, loopStepCount: number, intervalMs: number): number {
    const request = asRecord(step.request);
    const configuredIterations = firstPositiveInteger([
        step.count,
        request.count,
        step.iterations,
        request.iterations,
        step.runs,
        request.runs
    ]);

    if (configuredIterations) {
        return configuredIterations;
    }

    const messageCount = toInlineLoopMessageCount(step);
    if (messageCount) {
        return Math.max(1, Math.ceil(messageCount / Math.max(1, loopStepCount)));
    }

    const durationMs = firstPositiveInteger([
        step.durationMs,
        request.durationMs,
        step.maxDurationMs,
        request.maxDurationMs
    ]);
    if (durationMs && intervalMs > 0) {
        return Math.max(1, Math.ceil(durationMs / intervalMs));
    }

    return 1;
}

function sanitizedStepName(value: string): string {
    return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'loop';
}

function annotateInlineLoopStep(step: Record<string, unknown>, root: InlineLoopTemplateRoot): InlineLoopAnnotatedStep {
    const loop = root.loop;

    return {
        ...resolveTrafficTemplate(step, root),
        loopName: loop.name,
        loopIndex: loop.index,
        loopIteration: loop.iteration,
        loopStepIndex: loop.stepIndex,
        loopCount: loop.count,
        loopElapsedMs: loop.elapsedMs,
        loopPhase: 'body',
        repeatIndex: step.repeatIndex ?? loop.iteration
    };
}

function toInlineLoopDelayStep(delay: InlineLoopDelay): InlineLoopDelayStep {
    const { loopName, iteration, iterations, intervalMs } = delay;
    return {
        name: loopName + 'Delay',
        type: 'set',
        output: '__loopDelay' + sanitizedStepName(loopName) + iteration,
        value: {
            delayedMs: intervalMs,
            loopName,
            loopIteration: iteration,
            loopCount: iterations
        },
        request: {
            delayMs: intervalMs
        },
        loopName,
        loopIteration: iteration,
        loopCount: iterations,
        loopPhase: 'delay',
        repeatIndex: iteration
    };
}

export function expandInlineLoopSteps(
    rawSteps: Array<Record<string, unknown>>,
    allSteps: Array<Record<string, unknown>> = rawSteps,
    depth = 0
): Array<Record<string, unknown>> {
    if (depth > 20) {
        throw new Error('Inline loop nesting exceeded 20 levels.');
    }

    return rawSteps.flatMap((step, stepIndex) =>
        isInlineLoopStep(step)
            ? computeInlineLoopSteps({ step, stepIndex, allSteps, depth })
            : [step]
    );
}

function computeInlineLoopSteps(expansion: InlineLoopExpansion): Record<string, unknown>[] {
    const { step, stepIndex, allSteps, depth } = expansion;
    const loopSteps = toInlineLoopSteps(allSteps, step);
    if (loopSteps.length <= 0) {
        throw new Error('Inline loop requires steps, loopSteps, or loop.');
    }

    const loopName = stepName(step, stepIndex);
    const intervalMs = toInlineLoopIntervalMs(step);
    const iterations = toInlineLoopIterationCount(step, loopSteps.length, intervalMs);
    const messageCount = toInlineLoopMessageCount(step);
    const expandedSteps: Array<Record<string, unknown>> = [];
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
                    elapsedMs: (iteration - 1) * intervalMs
                }
            };

            expandedSteps.push(...expandInlineLoopSteps(
                [
                    annotateInlineLoopStep(cloneStep(loopStep), root)
                ],
                allSteps,
                depth + 1
            ));
        });

        const hasRemainingWork = messageCount === undefined
            ? iteration < iterations
            : loopIndex < messageCount;
        if (intervalMs > 0 && hasRemainingWork) {
            expandedSteps.push(toInlineLoopDelayStep({ loopName, iteration, iterations, intervalMs }));
        }
    }

    return expandedSteps;
}

function toTrafficOperationSteps(
    allSteps: Array<Record<string, unknown>>,
    operation: Record<string, unknown>
): Array<Record<string, unknown>> {
    if (Array.isArray(operation.steps)) {
        return resolveRecipeStepList(allSteps, operation.steps, 'trafficPlan.operations.steps');
    }

    if (operation.step !== undefined) {
        return resolveRecipeStepList(allSteps, [operation.step], 'trafficPlan.operations.step');
    }

    return [];
}

function toTrafficOperations(
    allSteps: Array<Record<string, unknown>>,
    config: Record<string, unknown>
): TrafficOperation[] {
    const operations = Array.isArray(config.operations)
        ? config.operations
        : [];

    return operations
        .filter((operation) => operation && typeof operation === 'object' && !Array.isArray(operation))
        .map((operation, index) => {
            const operationConfig = operation as Record<string, unknown>;
            const steps = toTrafficOperationSteps(allSteps, operationConfig);

            return {
                name: String(operationConfig.name || 'operation-' + (index + 1)),
                index: index + 1,
                weight: toTrafficOperationWeight(operationConfig.weight ?? 1),
                steps
            };
        })
        .filter((operation) => operation.steps.length > 0 && operation.weight > 0);
}

function toTrafficOperationWeight(value: unknown): number {
    const weight = Number(value);
    if (!Number.isFinite(weight)) {
        throw new Error('Traffic operation weight must be finite.');
    }
    return Math.max(0, weight);
}

function chooseTrafficOperation(operations: readonly TrafficOperation[], random: number): TrafficOperation {
    const totalWeight = operations.reduce((total, operation) => total + operation.weight, 0);
    const scale = Number.isFinite(totalWeight)
        ? 1
        : operations.reduce((largest, operation) => Math.max(largest, operation.weight), 0);
    const boundedTotalWeight = scale === 1
        ? totalWeight
        : operations.reduce((total, operation) => total + operation.weight / scale, 0);
    const roll = random * boundedTotalWeight;
    let cursor = 0;

    for (const operation of operations) {
        cursor += operation.weight / scale;
        if (roll < cursor) {
            return operation;
        }
    }

    return operations[operations.length - 1];
}

function annotateTrafficStep(step: Record<string, unknown>, root: TrafficTemplateRoot): TrafficAnnotatedStep {
    const traffic = root.traffic;

    return {
        ...resolveTrafficTemplate(step, root),
        trafficPlan: {
            seed: traffic.seed
        },
        trafficSeed: traffic.seed,
        trafficSequence: traffic.sequence,
        trafficOperation: traffic.operation
    };
}

function toTrafficPacingConfig(
    planConfig: Record<string, unknown>,
    limits: ScenarioWorkloadLimits
): TrafficPacingConfig {
    const rateHz = firstPositiveNumber([planConfig.rateHz]);
    const intervalMs = firstNonNegativeInteger([
        planConfig.intervalMs,
        rateHz ? Math.max(1, Math.round(1000 / rateHz)) : undefined,
        planConfig.delayMs,
        limits.delayMs
    ]) || 0;

    return {
        ...(rateHz ? { rateHz } : {}),
        intervalMs,
        jitterMs: firstNonNegativeInteger([planConfig.jitterMs]) || 0,
        burstSize: firstPositiveInteger([planConfig.burstSize]) || 1,
        ...(firstPositiveInteger([planConfig.maxInFlight])
            ? { maxInFlight: firstPositiveInteger([planConfig.maxInFlight]) }
            : {})
    };
}

function toTrafficDelayMs(input: TrafficDelayInput): number {
    const { pacing, sequence, count, jitterRandom } = input;
    if (pacing.intervalMs <= 0 || sequence >= count || sequence % pacing.burstSize !== 0) {
        return 0;
    }

    if (pacing.jitterMs <= 0) {
        return pacing.intervalMs;
    }

    const jitter = Math.round(((jitterRandom * 2) - 1) * pacing.jitterMs);
    return Math.max(0, pacing.intervalMs + jitter);
}

function toTrafficDelayStep(delay: TrafficDelayStepInput): TrafficDelayStep {
    const { sequence, configuredDelayMs, seed, pacing } = delay;
    return {
        name: 'trafficDelay',
        type: 'set',
        output: '__trafficDelay' + sequence,
        value: {
            delayedMs: configuredDelayMs,
            trafficSequence: sequence,
            burstSize: pacing.burstSize,
            maxInFlight: pacing.maxInFlight
        },
        request: {
            delayMs: configuredDelayMs
        },
        trafficPlan: {
            seed,
            pacing
        },
        trafficSeed: seed,
        trafficSequence: sequence,
        trafficOperation: 'delay',
        trafficPacing: pacing
    };
}

function readReplayTrafficPlan(
    config: ScenarioRecipe,
    planConfig: Record<string, unknown>
): TrafficPlanArtifact | undefined {
    const replaySource = planConfig.replayFrom || planConfig.replayPath;
    const replayPlan = typeof replaySource === 'string'
        ? utils.openFile(replaySource) as Record<string, unknown>
        : asRecord(planConfig.expandedPlan || planConfig.replay || planConfig.plan);

    if (Object.keys(replayPlan).length <= 0) {
        return undefined;
    }

    const steps = Array.isArray(replayPlan.steps)
        ? replayPlan.steps as Array<Record<string, unknown>>
        : Array.isArray(asRecord(replayPlan.replayRecipe).steps)
        ? asRecord(replayPlan.replayRecipe).steps as Array<Record<string, unknown>>
        : [];

    if (steps.length <= 0) {
        throw new Error('Traffic plan replay requires an expanded plan with steps.');
    }

    const seed = toUnsignedSeed(replayPlan.seed || planConfig.seed);

    return {
        version: 1,
        seed,
        replay: true,
        generator: {
            replayFrom: replaySource
        },
        decisions: Array.isArray(replayPlan.decisions)
            ? replayPlan.decisions as Array<Record<string, unknown>>
            : [],
        steps,
        replayRecipe: toTrafficReplayRecipe(config, { version: 1, seed, steps })
    };
}

function toGeneratedTrafficPlan(
    config: ScenarioRecipe,
    planConfig: Record<string, unknown>,
    limits: ScenarioWorkloadLimits
): GeneratedTrafficPlanArtifact {
    if (!Array.isArray(config.steps)) {
        throw new Error('Traffic plan mode requires an explicit steps array.');
    }

    const seed = toUnsignedSeed(planConfig.seed);
    const count = firstPositiveInteger([
        planConfig.count,
        planConfig.iterations,
        planConfig.runs,
        planConfig.messageCount,
        planConfig.messages
    ]) || 1;
    const pacing = toTrafficPacingConfig(planConfig, limits);
    const setupSteps = expandInlineLoopSteps(
        resolveRecipeStepList(config.steps, planConfig.setupSteps || planConfig.setup, 'trafficPlan.setupSteps'),
        config.steps
    );
    const cleanupSteps = expandInlineLoopSteps(
        resolveRecipeStepList(config.steps, planConfig.cleanupSteps || planConfig.cleanup, 'trafficPlan.cleanupSteps'),
        config.steps
    );
    const operations = toTrafficOperations(config.steps, planConfig);

    if (operations.length <= 0) {
        throw new Error('Traffic plan mode requires at least one operation with steps.');
    }

    const generated = computeTrafficLoop({ allSteps: config.steps, seed, count, pacing, operations });

    const steps = [
        ...setupSteps,
        ...generated.steps,
        ...cleanupSteps
    ];

    return {
        version: 1,
        seed,
        replay: false,
        generator: {
            ...planConfig,
            pacing,
            operations: operations.map((operation) => ({
                name: operation.name,
                index: operation.index,
                weight: operation.weight,
                stepCount: operation.steps.length
            }))
        },
        decisions: generated.decisions,
        steps,
        replayRecipe: toTrafficReplayRecipe(config, { version: 1, seed, decisions: generated.decisions, steps })
    };
}

function toTrafficReplayRecipe(config: ScenarioRecipe, content: TrafficReplayContent): ScenarioRecipe {
    return {
        ...config,
        steps: content.steps,
        execution: {
            ...asRecord(config.execution),
            trafficPlan: { expandedPlan: content }
        }
    };
}

function computeTrafficLoop(input: TrafficLoopInput): TrafficLoopComputed {
    const { allSteps, seed, count, pacing, operations } = input;
    const random = createSeededRandom(seed);
    const jitterRandom = createSeededRandom(seed ^ 0x9E3779B9);
    const decisions: TrafficDecision[] = [];
    const generatedLoopSteps = Array.from({ length: count }).flatMap((_ignored, index) => {
        const sequence = index + 1;
        const operationRandom = random();
        const operation = chooseTrafficOperation(operations, operationRandom);
        const randomValue = random();
        const randomInt = Math.floor(random() * 1_000_000);
        const root = toTrafficTemplateRoot({ seed, sequence, operation, randomValue, randomInt, pacing });
        const jitterValue =
            pacing.intervalMs > 0 && sequence < count && sequence % pacing.burstSize === 0 && pacing.jitterMs > 0
                ? jitterRandom()
                : 0.5;
        const generatedDelayMs = toTrafficDelayMs({ pacing, sequence, count, jitterRandom: jitterValue });

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
            pacing
        });

        const operationSteps = expandInlineLoopSteps(
            operation.steps.map((step) => annotateTrafficStep(cloneStep(step), root)),
            allSteps
        );

        return generatedDelayMs > 0
            ? [
                ...operationSteps,
                toTrafficDelayStep({ sequence, configuredDelayMs: generatedDelayMs, seed, pacing })
            ]
            : operationSteps;
    });

    return { steps: generatedLoopSteps, decisions };
}

function toTrafficTemplateRoot(input: TrafficTemplateInput): TrafficTemplateRoot {
    const { seed, sequence, operation, randomValue, randomInt, pacing } = input;
    return {
        traffic: {
            seed,
            sequence,
            iteration: sequence,
            operation: operation.name,
            operationIndex: operation.index,
            random: Number(randomValue.toFixed(6)),
            randomInt,
            pacing
        }
    };
}

function toSoakMessageCount(config: Record<string, unknown>): number | undefined {
    return firstPositiveInteger([config.messageCount, config.messages]);
}

function toSoakIterationCount(
    config: Record<string, unknown>,
    loopStepCount: number,
    limits: ScenarioWorkloadLimits
): number {
    const configuredIterations = firstPositiveInteger([limits.requestedIterations, config.iterations, config.runs]);

    if (configuredIterations) {
        return configuredIterations;
    }

    const configuredMessages = toSoakMessageCount(config);
    if (configuredMessages) {
        return Math.max(1, Math.ceil(configuredMessages / Math.max(1, loopStepCount)));
    }

    const durationMs = firstPositiveInteger([config.durationMs, config.maxDurationMs, limits.maxDurationMs]);
    const configuredDelayMs = firstPositiveInteger([config.delayMs, limits.delayMs]);
    if (durationMs && configuredDelayMs) {
        return Math.max(1, Math.ceil(durationMs / configuredDelayMs));
    }

    return limits.maxRuns;
}

function annotateSoakStep(step: Record<string, unknown>, position: SoakStepPosition): SoakAnnotatedStep {
    const { phase, iteration, loopIndex } = position;
    return {
        ...step,
        soakPhase: phase,
        ...(iteration !== undefined ? { soakIteration: iteration, repeatIndex: iteration } : {}),
        ...(loopIndex !== undefined ? { soakLoopIndex: loopIndex } : {})
    };
}

function toSoakDelayStep(iteration: number, configuredDelayMs: number): SoakDelayStep {
    return {
        name: 'soakDelay',
        type: 'set',
        output: '__soakDelay' + iteration,
        value: {
            delayedMs: configuredDelayMs,
            soakIteration: iteration
        },
        request: {
            delayMs: configuredDelayMs
        },
        soakPhase: 'delay',
        soakIteration: iteration,
        repeatIndex: iteration
    };
}

function toSoakExpandedConfig(
    config: ScenarioRecipe,
    soakConfig: Record<string, unknown>,
    limits: ScenarioWorkloadLimits
): ScenarioRecipe {
    if (!Array.isArray(config.steps)) {
        throw new Error('Soak mode requires an explicit steps array.');
    }

    const setupSteps = resolveRecipeStepList(config.steps, soakConfig.setupSteps || soakConfig.setup, 'setupSteps')
        .map((step) => annotateSoakStep(step, { phase: 'setup' }));
    const loopSteps = resolveSoakLoopSteps(config.steps, soakConfig);
    const cleanupSteps = resolveRecipeStepList(
        config.steps,
        soakConfig.cleanupSteps || soakConfig.cleanup,
        'cleanupSteps'
    )
        .map((step) => annotateSoakStep(step, { phase: 'cleanup' }));
    const messageCount = toSoakMessageCount(soakConfig);
    const iterations = toSoakIterationCount(soakConfig, loopSteps.length, limits);
    const configuredDelayMs = firstNonNegativeInteger([soakConfig.delayMs, limits.delayMs]) || 0;

    if (loopSteps.length <= 0) {
        throw new Error('Soak mode requires loopSteps, loop, or steps in execution.soak.');
    }

    const repeatedLoopSteps = Array.from({ length: iterations }).flatMap((_ignored, iterationIndex) => {
        const iteration = iterationIndex + 1;
        const remainingMessages = messageCount === undefined
            ? loopSteps.length
            : Math.max(0, messageCount - (iterationIndex * loopSteps.length));
        const iterationLoopSteps = loopSteps.slice(0, Math.min(loopSteps.length, remainingMessages));
        const annotatedLoopSteps = iterationLoopSteps.map((step, loopIndex) =>
            annotateSoakStep(cloneStep(step), { phase: 'loop', iteration, loopIndex: loopIndex + 1 })
        );

        return configuredDelayMs > 0 && iteration < iterations
            ? [
                ...annotatedLoopSteps,
                toSoakDelayStep(iteration, configuredDelayMs)
            ]
            : annotatedLoopSteps;
    });

    return {
        ...config,
        steps: [
            ...setupSteps,
            ...repeatedLoopSteps,
            ...cleanupSteps
        ]
    };
}
