import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>

export type BlackBoxTrafficPlanReductionInput = Readonly<{
    expandedPlan: JsonRecord
    artifactIndex?: JsonRecord
    failures?: JsonRecord
    report?: JsonRecord
    firstFailureName?: string
}>

export type BlackBoxTrafficPlanReductionResult = Readonly<{
    plan: JsonRecord
    summary: JsonRecord
}>

type CliOptions = {
    artifactDir?: string
    expandedPlan?: string
    artifactIndex?: string
    failures?: string
    report?: string
    firstFailure?: string
    out?: string
    summaryOut?: string
    help?: boolean
}

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
    return isRecord(value) ? value : {};
}

function asRecordArray(value: unknown): JsonRecord[] {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
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

function firstRecord(...values: readonly unknown[]): JsonRecord {
    return values.find(isRecord) ?? {};
}

function firstFailureEvidence(input: BlackBoxTrafficPlanReductionInput): JsonRecord {
    if (input.firstFailureName) {
        return {
            name: input.firstFailureName,
            source: 'explicit',
        };
    }

    const artifactIndexFailure = asRecord(input.artifactIndex?.firstFailure);
    if (Object.keys(artifactIndexFailure).length > 0) {
        return {
            ...artifactIndexFailure,
            source: 'artifact-index',
        };
    }

    const failureBundleFailure = asRecordArray(input.failures?.failures)[0];
    if (failureBundleFailure) {
        return {
            ...failureBundleFailure,
            source: 'failures',
        };
    }

    const summaryFailure = asRecord(asRecord(input.report?.summary).firstFailure);
    if (Object.keys(summaryFailure).length > 0) {
        return {
            ...summaryFailure,
            source: 'report-summary',
        };
    }

    const failedResult = asRecordArray(input.report?.resultsList)
        .find(result => result.status === 'FAILURE');
    if (failedResult) {
        return {
            ...failedResult,
            source: 'report-results',
        };
    }

    throw new Error('Traffic plan reduction requires first-failure evidence from --first-failure, artifact-index.json, failures.json, or report.json.');
}

function stepName(step: JsonRecord, index: number): string {
    return stringValue(step.name) ?? `step-${index + 1}`;
}

function findFailureStepIndex(steps: readonly JsonRecord[], failure: JsonRecord): number {
    const interactionExecutionNumber = numberValue(failure.interactionExecutionNumber);
    if (
        interactionExecutionNumber !== undefined &&
        interactionExecutionNumber >= 1 &&
        interactionExecutionNumber <= steps.length
    ) {
        return interactionExecutionNumber - 1;
    }

    const name = stringValue(failure.name);
    if (!name) {
        throw new Error('First-failure evidence must include name or interactionExecutionNumber.');
    }

    return steps.findIndex((step, index) => stepName(step, index) === name);
}

function trafficSequence(step: JsonRecord): number | undefined {
    return numberValue(step.trafficSequence);
}

function trafficIndexes(steps: readonly JsonRecord[]): number[] {
    return steps.flatMap((step, index) => trafficSequence(step) === undefined ? [] : [index]);
}

function shouldKeepStep(
    step: JsonRecord,
    index: number,
    failureIndex: number,
    failureSequence: number | undefined,
    firstTrafficIndex: number,
    lastTrafficIndex: number,
): boolean {
    const sequence = trafficSequence(step);
    if (failureSequence !== undefined) {
        if (sequence !== undefined) {
            return sequence <= failureSequence;
        }

        return index < firstTrafficIndex || index > lastTrafficIndex;
    }

    if (firstTrafficIndex >= 0 && failureIndex < firstTrafficIndex) {
        return index <= failureIndex || index > lastTrafficIndex;
    }

    if (lastTrafficIndex >= 0 && failureIndex > lastTrafficIndex) {
        return true;
    }

    return index <= failureIndex || index > lastTrafficIndex;
}

function toRemovedOperations(decisions: readonly JsonRecord[], removedSteps: readonly JsonRecord[]): JsonRecord[] {
    const removedStepCountsBySequence = removedSteps.reduce<Record<string, number>>((counts, step) => {
        const sequence = trafficSequence(step);
        if (sequence === undefined) {
            return counts;
        }

        counts[String(sequence)] = (counts[String(sequence)] || 0) + 1;
        return counts;
    }, {});

    return decisions
        .filter(decision => removedStepCountsBySequence[String(numberValue(decision.sequence))])
        .map(decision => ({
            sequence: numberValue(decision.sequence),
            operation: stringValue(decision.operation),
            operationIndex: numberValue(decision.operationIndex),
            stepCount: removedStepCountsBySequence[String(numberValue(decision.sequence))] || 0,
        }));
}

function toReplayRecipe(expandedPlan: JsonRecord, seed: number, decisions: JsonRecord[], steps: JsonRecord[], reduction: JsonRecord): JsonRecord {
    const baseRecipe = cloneJson(firstRecord(expandedPlan.replayRecipe, {
        steps,
    }));
    const execution = asRecord(baseRecipe.execution);
    const trafficPlan = asRecord(execution.trafficPlan);
    const nextTrafficPlan: JsonRecord = {
        ...trafficPlan,
        expandedPlan: {
            version: 1,
            seed,
            decisions,
            steps,
            reduction,
        },
    };

    delete nextTrafficPlan.replayFrom;
    delete nextTrafficPlan.replayPath;

    return {
        ...baseRecipe,
        steps,
        execution: {
            ...execution,
            trafficPlan: nextTrafficPlan,
        },
    };
}

export function reduceBlackBoxTrafficPlanFailure(
    input: BlackBoxTrafficPlanReductionInput,
): BlackBoxTrafficPlanReductionResult {
    const expandedPlan = input.expandedPlan;
    const steps = asRecordArray(expandedPlan.steps);
    const decisions = asRecordArray(expandedPlan.decisions);
    if (steps.length <= 0) {
        throw new Error('Traffic plan reduction requires expandedPlan.steps.');
    }

    const seed = numberValue(expandedPlan.seed) ?? 1;
    const failure = firstFailureEvidence(input);
    const failureIndex = findFailureStepIndex(steps, failure);
    if (failureIndex < 0) {
        throw new Error('Could not find first failure step in expanded plan: ' + String(failure.name ?? failure.interactionExecutionNumber));
    }

    const failureStep = steps[failureIndex];
    const failureSequence = trafficSequence(failureStep);
    const indexes = trafficIndexes(steps);
    const firstTrafficIndex = indexes[0] ?? -1;
    const lastTrafficIndex = indexes[indexes.length - 1] ?? -1;
    const keptSteps = steps.filter((step, index) =>
        shouldKeepStep(step, index, failureIndex, failureSequence, firstTrafficIndex, lastTrafficIndex)
    );
    const removedSteps = steps.filter(step => !keptSteps.includes(step));
    const keptSequences = new Set(keptSteps
        .map(trafficSequence)
        .filter((sequence): sequence is number => sequence !== undefined)
        .map(String));
    const keptDecisions = failureSequence !== undefined
        ? decisions.filter(decision => {
            const sequence = numberValue(decision.sequence);
            return sequence === undefined || keptSequences.has(String(sequence));
        })
        : firstTrafficIndex >= 0 && failureIndex < firstTrafficIndex
            ? []
            : decisions;
    const removedDecisions = decisions.filter(decision => !keptDecisions.includes(decision));
    const removedOperations = toRemovedOperations(removedDecisions, removedSteps);
    const reduction = {
        schemaVersion: 1,
        strategy: 'truncate-after-first-failure',
        firstFailure: {
            ...failure,
            stepIndex: failureIndex,
            stepName: stepName(failureStep, failureIndex),
            trafficSequence: failureSequence,
        },
        original: {
            seed,
            replay: expandedPlan.replay === true,
            stepCount: steps.length,
            decisionCount: decisions.length,
        },
        reduced: {
            stepCount: keptSteps.length,
            decisionCount: keptDecisions.length,
        },
        removed: {
            stepCount: removedSteps.length,
            decisionCount: removedDecisions.length,
            operations: removedOperations,
        },
    };
    const plan = {
        ...cloneJson(expandedPlan),
        version: numberValue(expandedPlan.version) ?? 1,
        schemaVersion: numberValue(expandedPlan.schemaVersion) ?? 1,
        kind: 'black-box-runner.reduced-plan',
        generatedAtEpochMs: Date.now(),
        seed,
        replay: true,
        generator: {
            ...asRecord(expandedPlan.generator),
            reducedFrom: {
                seed,
                stepCount: steps.length,
                decisionCount: decisions.length,
            },
            reductionStrategy: 'truncate-after-first-failure',
        },
        decisions: keptDecisions,
        steps: keptSteps,
        reduction,
        replayRecipe: toReplayRecipe(expandedPlan, seed, keptDecisions, keptSteps, reduction),
    };
    const summary = {
        kind: 'black-box-runner.reduction-summary',
        generatedAtEpochMs: plan.generatedAtEpochMs,
        ...reduction,
        replay: {
            recipe: {
                execution: {
                    trafficPlan: {
                        replayFrom: 'reduced-plan.json',
                    },
                },
                steps: [],
            },
        },
    };

    return {
        plan,
        summary,
    };
}

function readJsonFile(filePath: string): JsonRecord {
    return JSON.parse(readFileSync(filePath, 'utf8')) as JsonRecord;
}

function readOptionalJsonFile(filePath?: string): JsonRecord | undefined {
    return filePath && existsSync(filePath)
        ? readJsonFile(filePath)
        : undefined;
}

function readOptionValue(args: readonly string[], index: number, option: string): string {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
        throw new Error('Missing value for ' + option);
    }

    return value;
}

function parseCliOptions(args: readonly string[]): CliOptions {
    const options: CliOptions = {};

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const [option, inlineValue] = arg.includes('=')
            ? arg.split(/=(.*)/s, 2)
            : [arg, undefined];

        switch (option) {
            case '-h':
            case '--help':
                options.help = true;
                break;
            case '--artifact-dir':
            case '--artifacts':
                options.artifactDir = inlineValue ?? readOptionValue(args, index, option);
                if (inlineValue === undefined) index++;
                break;
            case '--expanded-plan':
            case '--plan':
                options.expandedPlan = inlineValue ?? readOptionValue(args, index, option);
                if (inlineValue === undefined) index++;
                break;
            case '--artifact-index':
                options.artifactIndex = inlineValue ?? readOptionValue(args, index, option);
                if (inlineValue === undefined) index++;
                break;
            case '--failures':
                options.failures = inlineValue ?? readOptionValue(args, index, option);
                if (inlineValue === undefined) index++;
                break;
            case '--report':
                options.report = inlineValue ?? readOptionValue(args, index, option);
                if (inlineValue === undefined) index++;
                break;
            case '--first-failure':
            case '--failure':
                options.firstFailure = inlineValue ?? readOptionValue(args, index, option);
                if (inlineValue === undefined) index++;
                break;
            case '--out':
            case '--output':
                options.out = inlineValue ?? readOptionValue(args, index, option);
                if (inlineValue === undefined) index++;
                break;
            case '--summary-out':
                options.summaryOut = inlineValue ?? readOptionValue(args, index, option);
                if (inlineValue === undefined) index++;
                break;
            default:
                break;
        }
    }

    return options;
}

function printHelp(): void {
    console.log([
        '',
        'Traffic-plan reducer',
        '',
        'Examples:',
        '  deno run -A packages/shared-test/black-box-runner/traffic-plan-reducer.ts --artifact-dir .artifacts/shared-test/rallar-memory-traffic',
        '  deno run -A packages/shared-test/black-box-runner/traffic-plan-reducer.ts --expanded-plan expanded-plan.json --artifact-index artifact-index.json --out reduced-plan.json',
        '',
        'Options:',
        '  --artifact-dir <dir>       Read expanded-plan.json and optional artifact files from a runner artifact directory.',
        '  --expanded-plan <file>     Expanded traffic plan artifact to reduce.',
        '  --artifact-index <file>    Optional artifact-index.json with firstFailure.',
        '  --failures <file>          Optional failures.json fallback.',
        '  --report <file>            Optional report.json fallback.',
        '  --first-failure <name>     Explicit first failing step name.',
        '  --out <file>               Reduced plan output. Defaults to reduced-plan.json next to the input plan.',
        '  --summary-out <file>       Summary output. Defaults to reduced-plan-summary.json next to --out.',
    ].join('\n'));
}

function resolveInputPaths(options: CliOptions): Required<Pick<CliOptions, 'expandedPlan' | 'out' | 'summaryOut'>> & CliOptions {
    const artifactDir = options.artifactDir;
    const expandedPlan = options.expandedPlan ?? (artifactDir ? path.join(artifactDir, 'expanded-plan.json') : undefined);
    if (!expandedPlan) {
        throw new Error('Missing --expanded-plan or --artifact-dir.');
    }

    const out = options.out ?? path.join(path.dirname(expandedPlan), 'reduced-plan.json');
    const summaryOut = options.summaryOut ?? path.join(path.dirname(out), 'reduced-plan-summary.json');

    return {
        ...options,
        expandedPlan,
        artifactIndex: options.artifactIndex ?? (artifactDir ? path.join(artifactDir, 'artifact-index.json') : undefined),
        failures: options.failures ?? (artifactDir ? path.join(artifactDir, 'failures.json') : undefined),
        report: options.report ?? (artifactDir ? path.join(artifactDir, 'report.json') : undefined),
        out,
        summaryOut,
    };
}

function isCliEntrypoint(): boolean {
    return process.argv[1] !== undefined &&
        path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isCliEntrypoint()) {
    try {
        const options = parseCliOptions(process.argv.slice(2));
        if (options.help) {
            printHelp();
            process.exit(0);
        }

        const paths = resolveInputPaths(options);
        const result = reduceBlackBoxTrafficPlanFailure({
            expandedPlan: readJsonFile(paths.expandedPlan),
            artifactIndex: readOptionalJsonFile(paths.artifactIndex),
            failures: readOptionalJsonFile(paths.failures),
            report: readOptionalJsonFile(paths.report),
            firstFailureName: paths.firstFailure,
        });

        writeFileSync(paths.out, JSON.stringify(result.plan, null, 2));
        writeFileSync(paths.summaryOut, JSON.stringify(result.summary, null, 2));
        console.log(JSON.stringify({
            ok: true,
            reducedPlan: paths.out,
            summary: paths.summaryOut,
            reduction: result.summary,
        }, null, 2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
