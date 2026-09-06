import path from 'node:path';

import { collectApiV1StateWriteEvidence } from './api-v1-state-write-evidence.ts';
import {
    artifactEventsWithTruncation,
    artifactPath,
    failureBundle,
    selectArtifactEvents,
    toJsonLine,
    withArtifactReport,
    withExpandedPlanCorrelation
} from './artifacts/scenario-run-artifacts.ts';
import * as artifactBounds from './artifacts/with-bounded-artifact-report-results.ts';
import { executeBlackBox } from './execute-black-box.ts';
import { redactBlackBoxData } from './execution/black-box-redaction.ts';
import { resolveBlackBoxVariables } from './execution/black-box-run-secrets.ts';
import { parseScenarioCliOptions, scenarioCliHelp } from './parse-scenario-cli-options.ts';
import {
    collectBlackBoxRunnerEnvRequirements,
    explainBlackBoxRunnerPlan,
    resolveBlackBoxRunnerVariablesForPreflight,
    type BlackBoxRunnerPreflightProfile
} from './preflight/plan-preflight.ts';
import {
    readScenarioRecipeIncludes,
    type ScenarioRecipe,
    type ScenarioRecipeIncludes
} from './recipes/read-scenario-recipe-includes.ts';
import {
    firstNonNegativeInteger,
    firstPositiveInteger,
    readScenarioWorkload,
    type ScenarioWorkload
} from './recipes/scenario-workload.ts';
import { toExecutableInteractions } from './recipes/to-executable-interactions.ts';
import {
    computeScenarioScaleMetrics,
    computeScenarioSoakMetrics,
    withScenarioMetrics
} from './reports/scenario-metrics.ts';
import {
    normalizePostRunAssertionSource,
    toPostRunAssertionResult
} from './reports/scenario-post-run-assertions.ts';
import utils from './utils.ts';

type JsonRecord = Record<string, unknown>;

const cliOptions = parseScenarioCliOptions(process.argv.slice(2)).fold(
    (error) => {
        console.error(error.message);
        console.log(scenarioCliHelp);
        process.exit(1);
    },
    (command) => {
        if (command.kind === 'help') {
            console.log(scenarioCliHelp);
            process.exit(0);
        }
        return command.options;
    }
);

utils.setWorkingDirectory(cliOptions.workingDirectory || '.');

const preflightMode = cliOptions.explain === true || cliOptions.validate === true;
const preflightProfile: BlackBoxRunnerPreflightProfile = cliOptions.strict === true || cliOptions.profile === 'strict'
    ? 'strict'
    : 'compat';
const recipeRootDir = path.resolve(cliOptions.workingDirectory || '.');
const recipeConfigPath = path.resolve(recipeRootDir, cliOptions.config);
const rawInput = utils.openFile(cliOptions.config) as ScenarioRecipe;

let includeExpansion: ScenarioRecipeIncludes;
let includeExpansionError: unknown;

try {
    includeExpansion = readScenarioRecipeIncludes(rawInput, recipeConfigPath, recipeRootDir);
}
catch (caught) {
    if (!preflightMode) {
        throw caught;
    }

    includeExpansionError = caught;
    includeExpansion = {
        config: rawInput,
        includes: []
    };
}

const cliReplacements = utils.inputReplacesToJson(cliOptions.replace);
const preflightRawInput: ScenarioRecipe = {
    ...includeExpansion.config,
    replace: { ...includeExpansion.config.replace, ...cliReplacements },
    variables: {
        ...includeExpansion.config.variables,
        ...includeExpansion.config.replace,
        ...cliReplacements
    }
};
const envRequirements = collectBlackBoxRunnerEnvRequirements(preflightRawInput, process.env);
const resolvedVariables = preflightMode
    ? resolveBlackBoxRunnerVariablesForPreflight(
        preflightRawInput.variables,
        process.env,
        preflightRawInput.secretVariables || preflightRawInput.secrets || []
    )
    : resolveBlackBoxVariables(
        preflightRawInput.variables,
        process.env,
        preflightRawInput.secretVariables || preflightRawInput.secrets || []
    );

const input: ScenarioRecipe = { ...preflightRawInput, variables: resolvedVariables.variables };

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0
        ? value
        : undefined;
}

const executionConfig = asRecord(input.execution);

const configuredCorrelation = asRecord(executionConfig.correlation);
const runnerRunId = stringValue(configuredCorrelation.runnerRunId) ??
    stringValue(configuredCorrelation.runId) ??
    stringValue(executionConfig.runnerRunId) ??
    stringValue(executionConfig.runId) ??
    'bb-run-' + globalThis.crypto.randomUUID();
const correlationConfig = { ...configuredCorrelation, runnerRunId, runId: runnerRunId };

const failFast = executionConfig.failFast !== false;
const printDryExecutableInteractions = cliOptions.execution?.toLowerCase().includes('dry') === true;
const dryRun = cliOptions.dryRun === true || executionConfig.dryRun === true;
const artifactDir = cliOptions.artifactDir ||
    (typeof executionConfig.artifactDir === 'string' ? executionConfig.artifactDir : undefined) ||
    (typeof executionConfig.recordDir === 'string' ? executionConfig.recordDir : undefined);
const scaleConfig = asRecord(executionConfig.scale);
const soakConfig = asRecord(executionConfig.soak);
const soakMode = Object.keys(soakConfig).length > 0 && soakConfig.enabled !== false;

const requestedIterations = firstPositiveInteger([
    cliOptions.iterations,
    soakConfig.iterations,
    soakConfig.runs,
    scaleConfig.iterations,
    scaleConfig.runs,
    executionConfig.iterations,
    executionConfig.runs
]);
const maxDurationMs = firstPositiveInteger([
    cliOptions.durationMs,
    soakConfig.durationMs,
    soakConfig.maxDurationMs,
    scaleConfig.durationMs,
    scaleConfig.maxDurationMs,
    executionConfig.durationMs,
    executionConfig.maxDurationMs
]) || 0;
const maxRuns = requestedIterations ||
    firstPositiveInteger([
        soakConfig.maxRuns,
        soakConfig.maxIterations,
        scaleConfig.maxRuns,
        scaleConfig.maxIterations,
        executionConfig.maxRuns,
        executionConfig.maxIterations
    ]) || (maxDurationMs > 0 ? 1000 : 1);
const delayMs =
    firstNonNegativeInteger([cliOptions.delayMs, soakConfig.delayMs, scaleConfig.delayMs, executionConfig.delayMs]) ||
    0;
const stopOnFailure = soakConfig.stopOnFailure === true || scaleConfig.stopOnFailure === true ||
    executionConfig.stopOnFailure === true;
const scaleMode = !soakMode && (maxRuns > 1 || maxDurationMs > 0);

function configuredArtifactOptions(): JsonRecord {
    return {
        ...asRecord(executionConfig.artifactLimits),
        ...asRecord(executionConfig.artifact),
        ...asRecord(executionConfig.artifacts)
    };
}

function normalizeEventKindCaps(value: unknown): Record<string, number> {
    return Object.fromEntries(
        Object.entries(asRecord(value))
            .flatMap(([kind, limit]) => {
                const parsed = firstPositiveInteger([limit]);
                return parsed ? [[kind, parsed]] : [];
            })
    );
}

function configuredArtifactLimits(): JsonRecord {
    const options = configuredArtifactOptions();
    const maxEvents = firstPositiveInteger([options.maxEvents, options.maxArtifactEvents, options.eventLimit]);
    const maxEventsByKind = normalizeEventKindCaps(
        options.maxEventsByKind ||
            options.maxEventsPerKind ||
            options.eventKindLimits
    );

    return {
        ...(maxEvents ? { maxEvents } : {}),
        ...(Object.keys(maxEventsByKind).length > 0 ? { maxEventsByKind } : {})
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
            ...configured
        }
    };
}

let trafficExpansion: ScenarioWorkload;
let expandedInput: ScenarioRecipe;
let scenarioJson: unknown[];
let planExpansionError: unknown = includeExpansionError;

try {
    if (includeExpansionError !== undefined) {
        throw includeExpansionError;
    }

    trafficExpansion = readScenarioWorkload(input, {
        delayMs,
        requestedIterations,
        maxDurationMs,
        maxRuns,
        stopOnFailure
    });
    expandedInput = trafficExpansion.config;
    scenarioJson = toExecutableInteractions(expandedInput);
}
catch (caught) {
    if (!preflightMode) {
        throw caught;
    }

    planExpansionError = caught;
    trafficExpansion = {
        config: input
    };
    expandedInput = input;
    scenarioJson = [];
}

async function writeArtifacts(report: any, dir: string): Promise<void> {
    await Deno.mkdir(dir, {
        recursive: true
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
        command: redactBlackBoxData(process.argv, resolvedVariables.redactions)
    };
    const boundedReport = artifactBounds.toBoundedArtifactReport(
        artifactReport,
        configuredArtifactOptions().maxReportResults
    );
    const expandedRecipe = redactBlackBoxData({
        schemaVersion: 1,
        kind: 'black-box-runner.expanded-recipe',
        generatedAtEpochMs: Date.now(),
        sourceConfig: cliOptions.config,
        includeMetadata: input.includeMetadata,
        recipe: expandedInput
    }, resolvedVariables.redactions);
    await Deno.writeTextFile(artifactPath(dir, 'report.json'), JSON.stringify(boundedReport, null, 2));
    await Deno.writeTextFile(artifactPath(dir, 'events.jsonl'), events.map(toJsonLine).join(''));
    await Deno.writeTextFile(
        artifactPath(dir, 'failures.json'),
        JSON.stringify(failureBundle(artifactReport), null, 2)
    );
    await Deno.writeTextFile(artifactPath(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    await Deno.writeTextFile(artifactPath(dir, 'expanded-recipe.json'), JSON.stringify(expandedRecipe, null, 2));
    await Deno.writeTextFile(
        artifactPath(dir, 'artifact-index.json'),
        JSON.stringify(redactBlackBoxData(selection.index, resolvedVariables.redactions), null, 2)
    );
    if (trafficExpansion.artifact) {
        await Deno.writeTextFile(
            artifactPath(dir, 'expanded-plan.json'),
            JSON.stringify(
                redactBlackBoxData(
                    withExpandedPlanCorrelation(trafficExpansion.artifact, artifactReport),
                    resolvedVariables.redactions
                ),
                null,
                2
            )
        );
    }
}

function sleep(ms: number): Promise<void> {
    return ms > 0
        ? new Promise((resolve) => setTimeout(resolve, ms))
        : Promise.resolve();
}

function withSoakReport(report: any): any {
    const soak = trafficExpansion.soak;
    if (!soak) {
        return report;
    }
    return {
        ...report,
        summary: { ...report.summary, soak },
        metrics: { ...asRecord(report.metrics), soak: computeScenarioSoakMetrics(report) },
        artifactLimits: { ...asRecord(report.artifactLimits), maxEvents: soak.maxArtifactEvents }
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
                stepCount: artifact.steps.length
            }
        },
        trafficPlan: {
            seed: artifact.seed,
            replay: artifact.replay,
            decisions: artifact.decisions
        }
    };
}

function configuredPostRunAssertions(): JsonRecord[] {
    return [
        ...normalizePostRunAssertionSource(input.postRunAssertions, 'postRunAssertions'),
        ...normalizePostRunAssertionSource(executionConfig.postRunAssertions, 'execution.postRunAssertions'),
        ...normalizePostRunAssertionSource(executionConfig.thresholds, 'execution.thresholds')
    ];
}

function withPostRunAssertions(report: any, assertions: JsonRecord[]): any {
    if (assertions.length <= 0) {
        return report;
    }

    const results = assertions.map((assertion, index) => toPostRunAssertionResult(assertion, index, report));
    const failures = results.filter((result) => result.status === 'FAILURE');
    const summary = {
        total: results.length,
        success: results.length - failures.length,
        failure: failures.length
    };

    return redactBlackBoxData({
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
                    result: failures[0].result
                }
                : undefined
        },
        postRunAssertions: {
            summary,
            results
        }
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

    const reportWithMetrics = withConfiguredArtifactLimits(withScenarioMetrics(report));
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
        resultKey: ['run' + runIndex, result.resultKey].filter(Boolean).join('-')
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
                ? values.map((value) => ({
                    runIndex: run.runIndex,
                    connection,
                    value
                }))
                : [];
        });

        return merged;
    }, {});
}

function toFirstRunFailure(firstFailure: any): JsonRecord {
    return {
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
        repeatIndex: firstFailure.repeatIndex
    };
}

function aggregateReports(runs: any[], startedAtEpochMs: number, endedAtEpochMs: number): any {
    const resultsList = runs.flatMap((run) => annotateRunResults(run.report, run.runIndex));
    const results = Object.fromEntries(resultsList.map((result) => [result.resultKey, result]));
    const firstFailure = resultsList.find((result) => result.status === 'FAILURE');
    const failedRuns = runs.filter((run) => (run.summary?.failure || 0) > 0).length;
    const success = resultsList.filter((result) => result.status === 'SUCCESS').length;
    const failure = resultsList.filter((result) => result.status === 'FAILURE').length;

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
                stopOnFailure
            },
            firstFailure: firstFailure ? toFirstRunFailure(firstFailure) : undefined
        },
        runs: runs.map((run) => ({
            runIndex: run.runIndex,
            startedAtEpochMs: run.startedAtEpochMs,
            endedAtEpochMs: run.endedAtEpochMs,
            durationMs: run.endedAtEpochMs - run.startedAtEpochMs,
            runnerRunId: run.report?.runnerRunId,
            correlation: run.report?.correlation,
            summary: run.summary,
            outputs: run.report?.outputs || {}
        })),
        runnerRunId: runs.at(0)?.report?.runnerRunId,
        correlation: runs.at(0)?.report?.correlation,
        results,
        resultsList,
        resultsByName: toResultsByName(resultsList),
        outputs: runs.at(-1)?.report?.outputs || {},
        outputsByRun: Object.fromEntries(runs.map((run) => [String(run.runIndex), run.report?.outputs || {}])),
        metrics: computeScenarioScaleMetrics(resultsList, runs),
        wsMessages: mergeRunStores(runs, 'wsMessages'),
        wsCloseEvents: mergeRunStores(runs, 'wsCloseEvents'),
        rtcConnections: {},
        rtcMessages: mergeRunStores(runs, 'rtcMessages'),
        rtcDiagnostics: mergeRunStores(runs, 'rtcDiagnostics'),
        rtcCloseEvents: mergeRunStores(runs, 'rtcCloseEvents'),
        rtcProviderNames: runs.at(-1)?.report?.rtcProviderNames || []
    };
}

async function executeOnce(includePostRunAssertions = true, runIndex = 1): Promise<any> {
    const report = await executeBlackBox(scenarioJson, 0, {
        failFast,
        dryRun,
        variables: input.variables || {},
        redactions: resolvedVariables.redactions,
        correlation: correlationConfig,
        runnerRunId: correlationConfig.runnerRunId,
        runIndex,
        stateWriteEvidenceCollector: collectApiV1StateWriteEvidence
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
            report
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
        expansionError: planExpansionError
    });

    console.log(JSON.stringify(redactBlackBoxData(preflight, resolvedVariables.redactions), null, 2));
    process.exit(preflight.ok ? 0 : 1);
}
else if (printDryExecutableInteractions) {
    console.log(JSON.stringify(redactBlackBoxData(scenarioJson, resolvedVariables.redactions), null, 2));
}
else {
    (scaleMode ? executeScale() : executeOnce())
        .then(async (report) => {
            if (artifactDir) {
                await writeArtifacts(report, artifactDir);
            }
            console.log(JSON.stringify(
                artifactBounds.toBoundedArtifactReport(
                    report,
                    configuredArtifactOptions().maxReportResults
                ),
                null,
                2
            ));

            if (hasReportFailures(report)) {
                process.exit(1);
            }
        })
        .catch((e) => {
            console.error(e);
            process.exit(1);
        });
}
