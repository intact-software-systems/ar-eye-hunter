import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlFleetRunReport,
    ControlRunSnapshot,
} from './control-snapshots.ts';
import {
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView,
    type DistributedRunAnalysisReport,
    type RunVerdictView,
} from './distributed-run-monitor.ts';

export type DistributedRunArtifactFiles = Readonly<Record<string, string | undefined>>;

export type DistributedRunAnalysisInput = Readonly<{
    files: DistributedRunArtifactFiles;
    generatedAtEpochMs?: number;
    artifactSchemaVersion?: number;
}>;

export type DistributedRunArtifactParseWarning = Readonly<{
    fileName: string;
    message: string;
    lineNumber?: number;
}>;

export type DistributedRunFailureAnalysis = Readonly<{
    category: string;
    title: string;
    likelyCause: string;
    nextAction: string;
    minimalFixArea: string;
    verificationCommand: string;
    affectedAgents: readonly string[];
    affectedRegions: readonly string[];
    commandId?: string;
    recipeId?: string;
    evidenceFile: string;
}>;

export type DistributedRunPerformanceAnalysis = Readonly<{
    runDurationMs?: number;
    agentCount: number;
    passRate: number;
    reconnectCount: number;
    diagnosticCount: number;
    warningDiagnosticCount: number;
    errorDiagnosticCount: number;
    exportedEventCount: number;
    agentReportedEventCount: number;
    failedAgentCount: number;
    missingAgentCount: number;
    staleAgentCount: number;
    flakyAgentCount: number;
    commandTiming: Readonly<{
        count: number;
        minMs?: number;
        p50Ms?: number;
        p95Ms?: number;
        p99Ms?: number;
        maxMs?: number;
        averageMs?: number;
        spreadRatio?: number;
        outlierCount: number;
    }>;
    streamTiming?: Readonly<{
        streamCount: number;
        plannedFrames: number;
        scheduledFrames: number;
        attemptedFrames: number;
        completedFrames: number;
        failedFrames: number;
        droppedFrames: number;
        inFlightLimitDropCount: number;
        backpressureCount: number;
        sendSuccessRatio?: number;
        requestedRateHz?: number;
        achievedScheduleHz?: number;
        achievedCompletionHz?: number;
        maxStartDriftMs?: number;
        lateFrameCount: number;
        duration: Readonly<{
            count: number;
            minMs?: number;
            p50Ms?: number;
            p95Ms?: number;
            p99Ms?: number;
            maxMs?: number;
            averageMs?: number;
            spreadRatio?: number;
            outlierCount: number;
        }>;
        slowestAgents: readonly Readonly<{
            agentId: string;
            streamCount: number;
            plannedFrames: number;
            completedFrames: number;
            averageMs?: number;
            p95Ms?: number;
            p99Ms?: number;
            maxMs?: number;
        }>[];
    }>;
    receiverDelivery?: Readonly<{
        sampleCount: number;
        expectedInboundMessages?: number;
        minExpectedInboundMessages?: number;
        minReceiveRatio?: number;
        minReceivedMessages?: number;
        medianReceivedMessages?: number;
        p95ReceivedMessages?: number;
        maxReceivedMessages?: number;
        minDeliveryRatio?: number;
        medianDeliveryRatio?: number;
        p95DeliveryRatio?: number;
        lowestAgents: readonly Readonly<{
            agentId: string;
            receivedMessages: number;
            expectedInboundMessages?: number;
            deliveryRatio?: number;
        }>[];
    }>;
    slowestAgents: readonly Readonly<{
        agentId: string;
        commandCount: number;
        averageMs?: number;
        maxMs?: number;
    }>[];
}>;

export type DistributedRunSnapshotPerformanceInput = Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun: ControlRunSnapshot;
    fleetReport?: unknown;
    artifactResults?: readonly unknown[];
    artifactEvents?: readonly unknown[];
}>;

export type DistributedRunTargetResolutionAnalysis = Readonly<{
    selected: number;
    expectedParticipantCount?: number;
    missingExpectedParticipants: number;
    blockers: number;
    staleAgents: number;
    offlineAgents: number;
    wrongGroupAgents: number;
    agentsWithoutIdentity: number;
    roleCounts: Readonly<Record<string, number>>;
    regions: Readonly<Record<string, number>>;
    providers: Readonly<Record<string, number>>;
    targetAgentIds: readonly string[];
    blockingAgentIds: readonly string[];
}>;

export type DistributedRunAnalysis = Readonly<{
    generatedAtEpochMs: number;
    artifactSchemaVersion?: number;
    distributedRunId: string;
    controlRunId?: string;
    status: string;
    ok: boolean;
    group?: Readonly<{
        applicationId?: string;
        workspaceId?: string;
        groupId?: string;
    }>;
    summary: Readonly<{
        agents: number;
        passRate: number;
        failureGroups: number;
        blockingFailures: number;
    }>;
    parseWarnings: readonly DistributedRunArtifactParseWarning[];
    failure?: DistributedRunFailureAnalysis;
    performance?: DistributedRunPerformanceAnalysis;
    targetResolution?: DistributedRunTargetResolutionAnalysis;
    spa?: Readonly<{
        report: DistributedRunAnalysisReport;
        verdict: RunVerdictView;
    }>;
    summaryMarkdown: string;
    fixProposalMarkdown?: string;
    performanceMarkdown?: string;
}>;

export type DistributedRunArtifactSnapshots = Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    controlRun: ControlRunSnapshot;
    artifactBundle?: ControlDistributedRunArtifactBundle;
}>;

type ControlPostFailureArtifact = Readonly<{
    phase?: string;
    path?: string;
    httpStatus?: string;
    curlStatus?: number;
    exitStatus?: number;
    responseFile: string;
    body: Record<string, unknown>;
}>;

type ReceiverDeliverySpec = Readonly<{
    expectedInboundMessages?: number;
    minExpectedInboundMessages?: number;
    minReceiveRatio?: number;
}>;

type ReceiverDeliverySample = ReceiverDeliverySpec & Readonly<{
    agentId?: string;
    commandId?: string;
    receivedMessages: number;
}>;

const TERMINAL_FAILURE_STATES = new Set(['failed', 'timed-out', 'cancelled']);

const DISTRIBUTED_ARTIFACT_FILE_NAMES = new Set([
    'distributed-run.json',
    'manifest.json',
    'target-resolution.json',
    'runner-summary.json',
    'control-post-create-error.json',
    'control-post-stage-error.json',
    'control-post-start-error.json',
    'control-post-request-error.json',
    'control-post-error-metadata.json',
    'control-run.json',
    'fleet-report.json',
    'report.json',
    'results.jsonl',
    'events.jsonl',
    'failures.json',
    'metadata.json',
]);

const DISTRIBUTED_ARTIFACT_V2_EVIDENCE_FILE_NAMES = [
    'report.json',
    'failures.json',
    'metadata.json',
] as const;

const CONTROL_POST_ERROR_FILE_NAMES = [
    'control-post-create-error.json',
    'control-post-stage-error.json',
    'control-post-start-error.json',
    'control-post-request-error.json',
] as const;

export function analyzeDistributedRunArtifactFiles(
    input: DistributedRunAnalysisInput,
): DistributedRunAnalysis {
    const generatedAtEpochMs = input.generatedAtEpochMs ?? Date.now();
    const {
        parseWarnings,
        distributedRunRecord,
        controlRunRecord,
        fleetReport,
        failureBundle,
        controlPostFailure,
        results,
        events,
        targetResolutionRecord,
    } = parseDistributedRunArtifactFiles(input.files);
    const distributedRun = normalizeDistributedRunRecord(distributedRunRecord, results);
    const controlRun = normalizeControlRunRecord(controlRunRecord, distributedRun.controlRunId, results, events);
    const artifactBundle = distributedArtifactBundleFromFiles(
        input.files,
        generatedAtEpochMs,
        distributedRun.distributedRunId,
        input.artifactSchemaVersion,
    );
    const spa = deriveSpaAnalysis(distributedRun, controlRun, artifactBundle, parseWarnings);

    const distributedRunId = firstString(
        distributedRun.distributedRunId,
        fleetReport.distributedRunId,
        'unknown-distributed-run',
    ) ?? 'unknown-distributed-run';
    const controlRunId = firstString(distributedRun.controlRunId, controlRun.runId);
    const status = firstString(distributedRun.state, fleetReport.state, 'unknown') ?? 'unknown';
    const ok = booleanValue(fleetReport.ok) ?? booleanValue(readPath(distributedRun, ['rollup', 'ok'])) ??
        status === 'passed';
    const group = groupFromArtifacts(distributedRun, fleetReport);
    const performance = deriveDistributedRunSnapshotPerformance({
        distributedRun,
        controlRun,
        fleetReport,
        artifactResults: results,
        artifactEvents: events,
    });
    const targetResolution = targetResolutionAnalysis(targetResolutionRecord, distributedRun);
    const failure = ok
        ? undefined
        : deriveFailure({
            distributedRun,
            fleetReport,
            failureBundle,
            controlPostFailure,
            results,
            events,
            spaReport: spa?.report,
        });
    const summary = {
        agents: numberValue(readPath(fleetReport, ['summary', 'agents'])) ?? performance.agentCount,
        passRate: numberValue(readPath(fleetReport, ['summary', 'passRate'])) ?? performance.passRate,
        failureGroups: numberValue(readPath(fleetReport, ['summary', 'failureGroups'])) ??
            (failure ? 1 : 0),
        blockingFailures: numberValue(readPath(distributedRun, ['rollup', 'summary', 'blockingFailures'])) ??
            (failure ? 1 : 0),
    };

    const base: Omit<DistributedRunAnalysis, 'summaryMarkdown' | 'fixProposalMarkdown' | 'performanceMarkdown'> = {
        generatedAtEpochMs,
        artifactSchemaVersion: artifactBundle?.artifactSchemaVersion ?? input.artifactSchemaVersion ?? 1,
        distributedRunId,
        controlRunId,
        status,
        ok,
        group,
        summary,
        parseWarnings,
        failure,
        performance,
        targetResolution,
        spa,
    };
    const summaryMarkdown = renderSummaryMarkdown(base);
    const fixProposalMarkdown = failure ? renderFixProposalMarkdown(base) : undefined;
    const performanceMarkdown = performance ? renderPerformanceMarkdown(base) : undefined;

    return {
        ...base,
        summaryMarkdown,
        fixProposalMarkdown,
        performanceMarkdown,
    };
}

export function distributedArtifactBundleFromFiles(
    files: DistributedRunArtifactFiles,
    generatedAtEpochMs = Date.now(),
    fallbackDistributedRunId = 'imported-distributed-run',
    artifactSchemaVersionOverride?: number,
): ControlDistributedRunArtifactBundle | undefined {
    const distributedRunText = files['distributed-run.json'];
    const controlRunText = files['control-run.json'];
    const manifestText = files['manifest.json'] ?? distributedRunText;
    if (distributedRunText === undefined || controlRunText === undefined || manifestText === undefined) {
        return undefined;
    }

    const bundleFiles: Record<string, string> = {};
    for (const [fileName, text] of Object.entries(files)) {
        if (text !== undefined && DISTRIBUTED_ARTIFACT_FILE_NAMES.has(fileName)) {
            bundleFiles[fileName] = text;
        }
    }
    if (!bundleFiles['manifest.json']) {
        bundleFiles['manifest.json'] = manifestText;
    }
    const artifactSchemaVersion = artifactSchemaVersionOverride ??
        (DISTRIBUTED_ARTIFACT_V2_EVIDENCE_FILE_NAMES
                .every(fileName => bundleFiles[fileName] !== undefined)
            ? 2
            : 1);

    return {
        artifactSchemaVersion,
        distributedRunId: firstString(
            asRecord(safeJson(distributedRunText)).distributedRunId,
            fallbackDistributedRunId,
        ) ?? fallbackDistributedRunId,
        generatedAtEpochMs,
        files: bundleFiles as ControlDistributedRunArtifactBundle['files'],
    };
}

export function distributedArtifactSnapshotsFromFiles(
    files: DistributedRunArtifactFiles,
    generatedAtEpochMs = Date.now(),
    artifactSchemaVersion?: number,
): DistributedRunArtifactSnapshots {
    const {
        distributedRunRecord,
        controlRunRecord,
        results,
        events,
    } = parseDistributedRunArtifactFiles(files);
    const distributedRun = normalizeDistributedRunRecord(distributedRunRecord, results);
    const controlRun = normalizeControlRunRecord(
        controlRunRecord,
        distributedRun.controlRunId,
        results,
        events,
    );
    return {
        distributedRun,
        controlRun,
        artifactBundle: distributedArtifactBundleFromFiles(
            files,
            generatedAtEpochMs,
            distributedRun.distributedRunId,
            artifactSchemaVersion,
        ),
    };
}

function deriveSpaAnalysis(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
    artifactBundle: ControlDistributedRunArtifactBundle | undefined,
    warnings: DistributedRunArtifactParseWarning[],
): DistributedRunAnalysis['spa'] {
    try {
        const monitor = deriveDistributedRunMonitor({ distributedRun, controlRun, artifactBundle });
        const report = deriveDistributedRunAnalysisReport({ distributedRun, controlRun, artifactBundle });
        return {
            report,
            verdict: deriveRunVerdictView({ distributedRun, monitor, report, artifactBundle }),
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push({
            fileName: 'spa-analysis',
            message: `Unable to derive SPA report: ${detail}`,
        });
        return undefined;
    }
}

function controlPostFailureAnalysis(
    failure: ControlPostFailureArtifact,
): DistributedRunFailureAnalysis {
    const message = controlPostFailureMessage(failure);
    const phase = failure.phase ?? 'request';
    const path = failure.path ?? 'unknown path';
    const status = failure.httpStatus ? ` HTTP ${failure.httpStatus}` : '';
    const minimalFix = minimalFixArea({
        category: 'control-api',
        text: `${phase} ${path} ${message}`,
    });
    return {
        category: 'control-api',
        title: `Control API ${phase} request failed.`,
        likelyCause: message,
        nextAction: `Inspect ${failure.responseFile}; POST ${path} returned${status || ' a failure'} before the distributed run could continue.`,
        minimalFixArea: minimalFix,
        verificationCommand: verificationCommand(minimalFix),
        affectedAgents: [],
        affectedRegions: [],
        evidenceFile: failure.responseFile,
    };
}

function controlPostFailureMessage(failure: ControlPostFailureArtifact): string {
    if (Object.keys(failure.body).length === 0) {
        const details = [
            failure.httpStatus ? `HTTP ${failure.httpStatus}` : undefined,
            failure.curlStatus !== undefined ? `curl ${failure.curlStatus}` : undefined,
            failure.exitStatus !== undefined ? `exit ${failure.exitStatus}` : undefined,
        ].filter((value): value is string => value !== undefined);
        return details.length > 0
            ? `Control API request failed without a response body (${details.join(', ')}).`
            : 'Control API request failed without a response body.';
    }

    const error = asRecord(failure.body.error);
    return firstString(
        failure.body.message,
        error.message,
        failure.body.error,
        failure.body.detail,
        failure.body.title,
        'Control API request failed.',
    ) ?? 'Control API request failed.';
}

function deriveFailure(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    fleetReport: Record<string, unknown>;
    failureBundle: Record<string, unknown>;
    controlPostFailure?: ControlPostFailureArtifact;
    results: readonly Record<string, unknown>[];
    events: readonly Record<string, unknown>[];
    spaReport?: DistributedRunAnalysisReport;
}>): DistributedRunFailureAnalysis {
    if (input.controlPostFailure) {
        return controlPostFailureAnalysis(input.controlPostFailure);
    }

    const streamPerformance = streamPerformanceFailure(input.results, input.events);
    if (streamPerformance) {
        return streamPerformance;
    }

    const receiverDeliveryFailure = receiverDeliveryThresholdFailure(input.results);
    if (receiverDeliveryFailure) {
        return receiverDeliveryFailure;
    }

    const fleetSignature = arrayRecords(input.fleetReport.failureSignatures)[0];
    if (fleetSignature) {
        const failedResult = firstFailedResult(input.results);
        const minimalFix = minimalFixArea({
            category: firstString(fleetSignature.category),
            transport: firstString(fleetSignature.transport),
            text: [
                firstString(fleetSignature.title),
                firstString(fleetSignature.normalizedMessage),
                firstString(fleetSignature.likelyCause),
            ].filter(Boolean).join(' '),
        });
        return {
            category: firstString(fleetSignature.category, 'unknown') ?? 'unknown',
            title: firstString(fleetSignature.title, 'Fleet failure signature') ??
                'Fleet failure signature',
            likelyCause: firstString(fleetSignature.likelyCause, fleetSignature.normalizedMessage) ??
                'The fleet report grouped this run as failed.',
            nextAction: firstString(fleetSignature.nextAction) ??
                'Open the run artifacts and inspect the affected agent evidence.',
            minimalFixArea: minimalFix,
            verificationCommand: verificationCommand(minimalFix),
            affectedAgents: stringArray(fleetSignature.affectedAgents),
            affectedRegions: stringArray(fleetSignature.affectedRegions),
            commandId: firstString(fleetSignature.commandId, commandIdFromResult(failedResult)),
            recipeId: firstString(fleetSignature.recipeId),
            evidenceFile: 'fleet-report.json',
        };
    }

    const failedResult = firstFailedResult(input.results);
    if (failedResult) {
        const actual = asRecord(failedResult.actual ?? failedResult.error);
        const message = firstString(actual.message, failedResult.message, 'Command result failed') ??
            'Command result failed';
        const minimalFix = minimalFixArea({
            category: failureCategory(firstString(actual.code), message),
            transport: firstString(failedResult.transport),
            text: `${firstString(failedResult.action) ?? ''} ${message}`,
        });
        return {
            category: failureCategory(firstString(actual.code), message),
            title: message,
            likelyCause: message,
            nextAction: 'Open the failing command result and compare expected vs observed payload evidence.',
            minimalFixArea: minimalFix,
            verificationCommand: verificationCommand(minimalFix),
            affectedAgents: maybeStringArray(firstString(failedResult.agentId)),
            affectedRegions: [],
            commandId: commandIdFromResult(failedResult),
            evidenceFile: 'results.jsonl',
        };
    }

    const streamFailure = streamTimeoutFailure(input.distributedRun, input.events);
    if (streamFailure) {
        return streamFailure;
    }

    const spaAction = input.spaReport?.nextActions[0];
    if (spaAction) {
        const failure = input.spaReport?.firstFailure;
        const minimalFix = minimalFixArea({
            category: spaAction.category,
            text: `${spaAction.title} ${spaAction.likelyCause} ${spaAction.nextAction}`,
        });
        return {
            category: spaAction.category,
            title: spaAction.title,
            likelyCause: spaAction.likelyCause,
            nextAction: spaAction.nextAction,
            minimalFixArea: minimalFix,
            verificationCommand: verificationCommand(minimalFix),
            affectedAgents: maybeStringArray(failure?.agentId),
            affectedRegions: [],
            commandId: failure?.commandId,
            recipeId: failure?.recipeId,
            evidenceFile: evidenceFileForAction(spaAction.category),
        };
    }

    const bundledFailure = arrayRecords(input.failureBundle.failures)[0];
    if (bundledFailure) {
        const error = asRecord(bundledFailure.error);
        const message = firstString(error.message, bundledFailure.message, 'Failure bundle entry') ??
            'Failure bundle entry';
        const minimalFix = minimalFixArea({ category: failureCategory(firstString(error.code), message), text: message });
        return {
            category: failureCategory(firstString(error.code), message),
            title: message,
            likelyCause: message,
            nextAction: 'Open failures.json and the matching control-run command evidence.',
            minimalFixArea: minimalFix,
            verificationCommand: verificationCommand(minimalFix),
            affectedAgents: maybeStringArray(firstString(bundledFailure.agentId)),
            affectedRegions: [],
            commandId: firstString(bundledFailure.commandId),
            evidenceFile: 'failures.json',
        };
    }

    const diagnostic = input.events.find((event) => {
        const severity = eventSeverity(event);
        return severity === 'error' || severity === 'warning';
    });
    if (diagnostic) {
        const message = eventMessage(diagnostic) ?? 'Runtime diagnostic correlated with failed run';
        const minimalFix = minimalFixArea({
            category: 'diagnostic',
            transport: firstString(diagnostic.transport),
            text: message,
        });
        return {
            category: 'diagnostic',
            title: message,
            likelyCause: message,
            nextAction: 'Inspect the runtime diagnostic event and nearby command evidence.',
            minimalFixArea: minimalFix,
            verificationCommand: verificationCommand(minimalFix),
            affectedAgents: maybeStringArray(firstString(diagnostic.agentId)),
            affectedRegions: [],
            commandId: firstString(diagnostic.commandId),
            evidenceFile: 'events.jsonl',
        };
    }

    const state = firstString(input.distributedRun.state, 'unknown') ?? 'unknown';
    return {
        category: TERMINAL_FAILURE_STATES.has(state) ? 'runtime' : 'unknown',
        title: `Distributed run ended with state ${state}.`,
        likelyCause: 'The distributed run did not pass, but no specific failure evidence was exported.',
        nextAction: 'Refresh the control server artifacts with larger bounds and inspect the raw run snapshot.',
        minimalFixArea: 'artifact coverage',
        verificationCommand: verificationCommand('artifact coverage'),
        affectedAgents: [],
        affectedRegions: [],
        evidenceFile: 'distributed-run.json',
    };
}

export function deriveDistributedRunSnapshotPerformance(
    input: DistributedRunSnapshotPerformanceInput,
): DistributedRunPerformanceAnalysis {
    return derivePerformance(
        input.distributedRun,
        input.controlRun,
        asRecord(input.fleetReport),
        arrayRecords(input.artifactResults),
        input.artifactEvents === undefined
            ? arrayRecords(input.controlRun.events)
            : arrayRecords(input.artifactEvents),
    );
}

function derivePerformance(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
    fleetReport: Record<string, unknown>,
    results: readonly Record<string, unknown>[],
    events: readonly Record<string, unknown>[],
): DistributedRunPerformanceAnalysis {
    const agents = arrayRecords(controlRun.agents);
    const commandTimingSamples = timingSamplesFromControlRun(distributedRun, controlRun);
    const commandDurations = commandTimingSamples.map(sample => sample.durationMs);
    const commandTiming = timingFromFleetOrValues(readPath(fleetReport, ['timing', 'commands']), commandDurations);
    const streamSamples = streamSamplesFromResultsAndEvents(
        arrayRecords(controlRun.results),
        results,
        events,
    );
    const streamTiming = streamTimingFromSamples(streamSamples);
    const receiverDelivery = receiverDeliveryFromSamples(
        receiverDeliverySamplesFromResults(
            distributedRun,
            arrayRecords(controlRun.results),
            results,
        ),
    );
    const diagnosticCounts = diagnosticCountsFromEvents(events);
    const runDurationMs = durationFromFields(distributedRun, 'startedAtEpochMs', 'completedAtEpochMs') ??
        numberValue(readPath(fleetReport, ['timing', 'run', 'p50Ms']));
    const exportedEventCount = events.length;
    const agentReportedEventCount = agents.reduce((sum, agent) => sum + (numberValue(agent.receivedEventCount) ?? 0), 0);

    return {
        runDurationMs,
        agentCount: numberValue(readPath(fleetReport, ['summary', 'agents'])) ?? agents.length,
        passRate: numberValue(readPath(fleetReport, ['summary', 'passRate'])) ??
            (readPath(distributedRun, ['rollup', 'ok']) === true ? 1 : 0),
        reconnectCount: agents.reduce((sum, agent) => sum + (numberValue(agent.reconnectCount) ?? 0), 0),
        diagnosticCount: diagnosticCounts.warning + diagnosticCounts.error,
        warningDiagnosticCount: diagnosticCounts.warning,
        errorDiagnosticCount: diagnosticCounts.error,
        exportedEventCount,
        agentReportedEventCount,
        failedAgentCount: numberValue(readPath(fleetReport, ['summary', 'failed'])) ??
            numberValue(readPath(distributedRun, ['rollup', 'summary', 'failedParticipants'])) ?? 0,
        missingAgentCount: numberValue(readPath(fleetReport, ['summary', 'missing'])) ?? 0,
        staleAgentCount: numberValue(readPath(fleetReport, ['summary', 'stale'])) ?? 0,
        flakyAgentCount: numberValue(readPath(fleetReport, ['summary', 'flaky'])) ?? 0,
        commandTiming,
        streamTiming,
        receiverDelivery,
        slowestAgents: slowestAgentRows(commandTimingSamples),
    };
}

function renderSummaryMarkdown(
    analysis: Omit<DistributedRunAnalysis, 'summaryMarkdown' | 'fixProposalMarkdown' | 'performanceMarkdown'>,
): string {
    return [
        `# Distributed Run Analysis: ${analysis.distributedRunId}`,
        '',
        `State: ${analysis.status}`,
        `Result: ${analysis.ok ? 'passed' : 'failed'}`,
        analysis.controlRunId ? `Control run: ${analysis.controlRunId}` : undefined,
        analysis.group?.groupId ? `Group: ${analysis.group.groupId}` : undefined,
        `Agents: ${analysis.summary.agents}`,
        analysis.targetResolution
            ? `Targets: ${analysis.targetResolution.selected}/${analysis.targetResolution.expectedParticipantCount ?? 'unspecified'} resolved`
            : undefined,
        analysis.targetResolution
            ? `Target blockers: ${analysis.targetResolution.blockers}`
            : undefined,
        `Pass rate: ${percent(analysis.summary.passRate)}`,
        `Failure groups: ${analysis.summary.failureGroups}`,
        `Artifact warnings: ${analysis.parseWarnings.length}`,
        analysis.failure ? `First focus: ${analysis.failure.title}` : undefined,
        '',
    ].filter((line): line is string => line !== undefined).join('\n');
}

function renderFixProposalMarkdown(
    analysis: Omit<DistributedRunAnalysis, 'summaryMarkdown' | 'fixProposalMarkdown' | 'performanceMarkdown'>,
): string {
    const failure = analysis.failure;
    if (!failure) {
        return '';
    }
    return [
        `# Fix Proposal: ${analysis.distributedRunId}`,
        '',
        `Status: ${analysis.status}`,
        `Title: ${failure.title}`,
        `Category: ${failure.category}`,
        `Likely cause: ${failure.likelyCause}`,
        `Next action: ${failure.nextAction}`,
        `Minimal fix area: ${failure.minimalFixArea}`,
        failure.affectedAgents.length > 0 ? `Affected agents: ${failure.affectedAgents.join(', ')}` : undefined,
        failure.affectedRegions.length > 0 ? `Affected regions: ${failure.affectedRegions.join(', ')}` : undefined,
        failure.commandId ? `Command: ${failure.commandId}` : undefined,
        failure.recipeId ? `Recipe: ${failure.recipeId}` : undefined,
        `Evidence: ${failure.evidenceFile}`,
        '',
        'Suggested verification:',
        failure.verificationCommand,
        '',
    ].filter((line): line is string => line !== undefined).join('\n');
}

function renderPerformanceMarkdown(
    analysis: Omit<DistributedRunAnalysis, 'summaryMarkdown' | 'fixProposalMarkdown' | 'performanceMarkdown'>,
): string {
    const performance = analysis.performance;
    if (!performance) {
        return '';
    }
    return [
        `# Performance: ${analysis.distributedRunId}`,
        '',
        `Pass rate: ${percent(performance.passRate)}`,
        performance.runDurationMs !== undefined ? `Run duration: ${performance.runDurationMs}ms` : undefined,
        `Agents: ${performance.agentCount}`,
        `Reconnects: ${performance.reconnectCount}`,
        `Diagnostics: ${performance.diagnosticCount}`,
        `Warning diagnostics: ${performance.warningDiagnosticCount}`,
        `Error diagnostics: ${performance.errorDiagnosticCount}`,
        `Exported events: ${performance.exportedEventCount}`,
        `Agent-reported events: ${performance.agentReportedEventCount}`,
        `Failed agents: ${performance.failedAgentCount}`,
        `Missing agents: ${performance.missingAgentCount}`,
        `Stale agents: ${performance.staleAgentCount}`,
        `Flaky agents: ${performance.flakyAgentCount}`,
        `Command timing: count=${performance.commandTiming.count}, min=${formatMs(performance.commandTiming.minMs)}, p50=${formatMs(performance.commandTiming.p50Ms)}, p95=${formatMs(performance.commandTiming.p95Ms)}, p99=${formatMs(performance.commandTiming.p99Ms)}, max=${formatMs(performance.commandTiming.maxMs)}, avg=${formatMs(performance.commandTiming.averageMs)}, outliers=${performance.commandTiming.outlierCount}`,
        performance.streamTiming
            ? `Stream timing: streams=${performance.streamTiming.streamCount}, frames=${performance.streamTiming.completedFrames}/${performance.streamTiming.plannedFrames}, attempted=${performance.streamTiming.attemptedFrames}, failed=${performance.streamTiming.failedFrames}, dropped=${performance.streamTiming.droppedFrames}, in-flight drops=${performance.streamTiming.inFlightLimitDropCount}, backpressure=${performance.streamTiming.backpressureCount}, max drift=${formatMs(performance.streamTiming.maxStartDriftMs)}, late frames=${performance.streamTiming.lateFrameCount}, p50=${formatMs(performance.streamTiming.duration.p50Ms)}, p95=${formatMs(performance.streamTiming.duration.p95Ms)}, p99=${formatMs(performance.streamTiming.duration.p99Ms)}, max=${formatMs(performance.streamTiming.duration.maxMs)}, achieved=${formatRate(performance.streamTiming.achievedCompletionHz)}`
            : undefined,
        performance.streamTiming
            ? `Frame disposition: streams=${performance.streamTiming.streamCount}, planned=${performance.streamTiming.plannedFrames}, completed=${performance.streamTiming.completedFrames}, failed=${performance.streamTiming.failedFrames}, dropped=${performance.streamTiming.droppedFrames}, in-flight drops=${performance.streamTiming.inFlightLimitDropCount}`
            : undefined,
        performance.streamTiming && performance.streamTiming.slowestAgents.length > 0
            ? `Slowest stream agents: ${performance.streamTiming.slowestAgents.map((agent) => `${agent.agentId} max=${formatMs(agent.maxMs)} p99=${formatMs(agent.p99Ms)}`).join(', ')}`
            : undefined,
        performance.receiverDelivery
            ? `Receiver delivery: receivers=${performance.receiverDelivery.sampleCount}, expected=${performance.receiverDelivery.expectedInboundMessages ?? 'unknown'}, min required=${performance.receiverDelivery.minExpectedInboundMessages ?? 'unknown'}, min=${performance.receiverDelivery.minReceivedMessages ?? 'unknown'}, median=${performance.receiverDelivery.medianReceivedMessages ?? 'unknown'}, p95=${performance.receiverDelivery.p95ReceivedMessages ?? 'unknown'}, lowest=${formatLowestReceiverDelivery(performance.receiverDelivery.lowestAgents[0])}`
            : undefined,
        performance.slowestAgents.length > 0
            ? `Slowest agents: ${performance.slowestAgents.map((agent) => `${agent.agentId} max=${formatMs(agent.maxMs)} avg=${formatMs(agent.averageMs)}`).join(', ')}`
            : undefined,
        '',
    ].filter((line): line is string => line !== undefined).join('\n');
}

function formatLowestReceiverDelivery(
    agent: NonNullable<DistributedRunPerformanceAnalysis['receiverDelivery']>['lowestAgents'][number] | undefined,
): string {
    if (!agent) {
        return 'none';
    }
    const expected = agent.expectedInboundMessages ?? 'unknown';
    const ratio = agent.deliveryRatio === undefined ? 'unknown' : percent(agent.deliveryRatio);
    return `${agent.agentId} ${agent.receivedMessages}/${expected} (${ratio})`;
}

function firstFailedResult(
    results: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
    return results.find((result) =>
        firstString(result.status)?.toUpperCase() === 'FAILURE' || booleanValue(result.ok) === false
    );
}

function receiverDeliveryThresholdFailure(
    results: readonly Record<string, unknown>[],
): DistributedRunFailureAnalysis | undefined {
    const failedResult = results.find((result) => {
        if (firstString(result.status)?.toUpperCase() !== 'FAILURE' && booleanValue(result.ok) !== false) {
            return false;
        }
        const actual = asRecord(result.actual ?? result.error ?? result.value);
        const text = [
            firstString(actual.source),
            firstString(actual.message),
            firstString(actual.code),
            firstString(readPath(actual, ['details', 'source'])),
            firstString(readPath(actual, ['details', 'message'])),
        ].filter(Boolean).join(' ').toLowerCase();
        return text.includes('stats.counters.messages') ||
            (text.includes('receiver') && text.includes('delivery'));
    });
    if (!failedResult) {
        return undefined;
    }

    const minimalFix = 'RTC receiver delivery';
    return {
        category: 'receiver-delivery',
        title: 'Receiver delivery threshold failed.',
        likelyCause: 'A receiver observed fewer RTC messages than the recipe threshold required.',
        nextAction:
            'Inspect receiver stats, topology profile, stream fanout, and lowest receiver delivery counts before changing thresholds.',
        minimalFixArea: minimalFix,
        verificationCommand: verificationCommand(minimalFix),
        affectedAgents: maybeStringArray(firstString(failedResult.agentId)),
        affectedRegions: [],
        commandId: commandIdFromResult(failedResult),
        evidenceFile: 'results.jsonl',
    };
}

function streamPerformanceFailure(
    results: readonly Record<string, unknown>[],
    events: readonly Record<string, unknown>[],
): DistributedRunFailureAnalysis | undefined {
    const resultCandidates = results
        .flatMap(result => streamSamplesFromResult(result)
            .filter(streamSampleHasFailureEvidence)
            .map(sample => ({
                sample,
                agentId: firstString(result.agentId, sample.agentId),
                evidenceFile: 'results.jsonl',
            })))
        .filter(candidate => streamSampleHasFailureEvidence(candidate.sample));
    const eventCandidates = events
        .filter(event => {
            const topic = eventTopic(event);
            return topic === 'rallar.bb.rtc.stream_failed' ||
                isStreamFailureText([
                    topic,
                    firstString(event.commandId),
                    eventMessage(event),
                    JSON.stringify(streamSummaryFromEvent(event) ?? {}),
                ].filter(Boolean).join(' '));
        })
        .map(event => ({
            sample: streamSampleFromEvent(event),
            agentId: firstString(event.agentId),
            evidenceFile: 'events.jsonl',
        }))
        .filter((candidate): candidate is Readonly<{
            sample: StreamTimingSample;
            agentId: string | undefined;
            evidenceFile: string;
        }> => candidate.sample !== undefined);
    const candidate = [...resultCandidates, ...eventCandidates]
        .find(entry => streamSampleHasFailureEvidence(entry.sample));
    if (!candidate) {
        return undefined;
    }

    const summary = candidate.sample.summary;
    const commandId = firstString(candidate.sample.commandId, summary.commandId);
    const completedFrames = numberValue(summary.completedFrames) ?? 0;
    const plannedFrames = numberValue(summary.plannedFrames);
    const droppedFrames = numberValue(summary.droppedFrames) ?? 0;
    const inFlightLimitDropCount = streamSampleInFlightLimitDropCount(candidate.sample);
    const pacing = asRecord(summary.pacing);
    const maxStartDriftMs = numberValue(pacing.maxStartDriftMs);
    const lateFrameCount = numberValue(pacing.lateFrameCount);
    const duration = asRecord(summary.duration);
    const p99Ms = numberValue(duration.p99Ms);
    const frameText = plannedFrames !== undefined
        ? `${completedFrames}/${plannedFrames} frames`
        : `${completedFrames} frames`;
    const details = [
        `completed ${frameText}`,
        `dropped ${droppedFrames}`,
        `in-flight limit drops ${inFlightLimitDropCount}`,
        maxStartDriftMs !== undefined ? `max drift ${maxStartDriftMs}ms` : undefined,
        lateFrameCount !== undefined ? `late frames ${lateFrameCount}` : undefined,
        p99Ms !== undefined ? `p99 ${p99Ms}ms` : undefined,
    ].filter((value): value is string => value !== undefined);
    const likelyCause = `RTC stream ${commandId ?? 'unknown-stream'} exceeded pacing/backlog thresholds: ${details.join(', ')}.`;
    return {
        category: 'rtc-stream-performance',
        title: 'RTC stream pacing/backlog threshold failed.',
        likelyCause,
        nextAction: 'Reduce green-suite stream rate/load or inspect stream progress, in-flight drops, send duration percentiles, and RTC diagnostics for affected agents.',
        minimalFixArea: 'RTC stream pacing/performance',
        verificationCommand: verificationCommand('RTC stream pacing/performance'),
        affectedAgents: maybeStringArray(candidate.agentId ?? candidate.sample.agentId),
        affectedRegions: [],
        commandId,
        evidenceFile: candidate.evidenceFile,
    };
}

function isStreamFailureText(text: string): boolean {
    const normalized = text.toLowerCase();
    return normalized.includes('rallar_black_box_rtc_stream_threshold_failed') ||
        normalized.includes('rallar_black_box_rtc_stream_in_flight_limit') ||
        normalized.includes('rallar.bb.rtc.stream_failed') ||
        normalized.includes('maxdroppedframes');
}

function streamSampleHasFailureEvidence(sample: StreamTimingSample): boolean {
    return sample.failed === true ||
        arrayRecords(sample.summary.thresholdFailures).length > 0;
}

function verificationCommand(minimalFixArea: string): string {
    if (minimalFixArea === 'RTC stream pacing/performance') {
        return '`npm run test:e2e:rallar-black-box:full-stack:memory:live-rtc-3`';
    }
    if (minimalFixArea === 'RTC/TURN') {
        return '`npm run test:e2e:rallar-black-box:full-stack:memory:live-rtc-3`';
    }
    if (minimalFixArea === 'API/CORS/auth') {
        return '`./scripts/hetzner/controller/03-smoke-controller.sh` on the controller VM';
    }
    if (minimalFixArea === 'headless agent readiness') {
        return '`./scripts/hetzner/controller/12-status-headless-workers.sh` on the controller VM';
    }
    return '`npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts`';
}

function minimalFixArea(input: Readonly<{
    category?: string;
    transport?: string;
    text?: string;
}>): string {
    const text = `${input.category ?? ''} ${input.transport ?? ''} ${input.text ?? ''}`.toLowerCase();
    if (text.includes('rtc-stream-performance') || isStreamFailureText(text)) {
        return 'RTC stream pacing/performance';
    }
    if (text.includes('target')) return 'distributed targeting';
    if (text.includes('ack') || text.includes('readiness')) return 'headless agent readiness';
    if (text.includes('barrier')) return 'distributed barrier';
    if (text.includes('rtc') || text.includes('turn') || text.includes('peer') || text.includes('route')) {
        return 'RTC/TURN';
    }
    if (text.includes('ws') || text.includes('cors') || text.includes('auth') || text.includes('login')) {
        return 'API/CORS/auth';
    }
    if (text.includes('recipe') || text.includes('assert')) return 'recipe assertion';
    return 'control-server/runtime';
}

function failureCategory(code: string | undefined, message: string): string {
    const text = `${code ?? ''} ${message}`.toLowerCase();
    if (isStreamFailureText(text)) return 'rtc-stream-performance';
    if (text.includes('target')) return 'targeting';
    if (text.includes('ack')) return 'readiness';
    if (text.includes('barrier')) return 'barrier';
    if (text.includes('diagnostic')) return 'diagnostic';
    if (text.includes('runtime')) return 'runtime';
    if (text.includes('assert')) return 'command';
    return code || message ? 'command' : 'unknown';
}

function evidenceFileForAction(category: string): string {
    if (category === 'diagnostic') return 'events.jsonl';
    if (category === 'command') return 'results.jsonl';
    return 'distributed-run.json';
}

function groupFromArtifacts(
    distributedRun: ControlDistributedRunSnapshot,
    fleetReport: Record<string, unknown>,
): DistributedRunAnalysis['group'] {
    const group = asRecord(distributedRun.manifest.group ?? fleetReport.group);
    if (Object.keys(group).length === 0) {
        return undefined;
    }
    return {
        applicationId: firstString(group.applicationId),
        workspaceId: firstString(group.workspaceId),
        groupId: firstString(group.groupId),
    };
}

function targetResolutionAnalysis(
    targetResolutionRecord: Record<string, unknown>,
    distributedRun: ControlDistributedRunSnapshot,
): DistributedRunTargetResolutionAnalysis | undefined {
    const source = Object.keys(targetResolutionRecord).length > 0
        ? targetResolutionRecord
        : asRecord(distributedRun.targetResolution);
    if (Object.keys(source).length === 0) {
        return undefined;
    }

    const summary = asRecord(source.summary);
    const blockers = arrayRecords(source.blockers);
    return {
        selected: numberValue(summary.selected) ?? stringArray(source.targetAgentIds).length,
        expectedParticipantCount: numberValue(summary.expectedParticipantCount),
        missingExpectedParticipants: numberValue(summary.missingExpectedParticipants) ?? 0,
        blockers: blockers.length,
        staleAgents: numberValue(summary.staleAgents) ?? 0,
        offlineAgents: numberValue(summary.offlineAgents) ?? 0,
        wrongGroupAgents: numberValue(summary.wrongGroupAgents) ?? 0,
        agentsWithoutIdentity: numberValue(summary.agentsWithoutIdentity) ?? 0,
        roleCounts: numberRecord(summary.roleCounts),
        regions: numberRecord(summary.regions),
        providers: numberRecord(summary.providers),
        targetAgentIds: stringArray(source.targetAgentIds),
        blockingAgentIds: blockers
            .map(blocker => firstString(blocker.agentId))
            .filter((agentId): agentId is string => Boolean(agentId)),
    };
}

type ParsedDistributedRunArtifactFiles = Readonly<{
    parseWarnings: DistributedRunArtifactParseWarning[];
    distributedRunRecord: Record<string, unknown>;
    controlRunRecord: Record<string, unknown>;
    fleetReport: Record<string, unknown>;
    failureBundle: Record<string, unknown>;
    runnerSummary: Record<string, unknown>;
    manifestRecord: Record<string, unknown>;
    targetResolutionRecord: Record<string, unknown>;
    controlPostFailure?: ControlPostFailureArtifact;
    results: readonly Record<string, unknown>[];
    events: readonly Record<string, unknown>[];
}>;

function parseDistributedRunArtifactFiles(
    files: DistributedRunArtifactFiles,
): ParsedDistributedRunArtifactFiles {
    const parseWarnings: DistributedRunArtifactParseWarning[] = [];
    const runnerSummary = parseJsonRecord(files['runner-summary.json'], 'runner-summary.json', parseWarnings);
    const manifestRecord = parseJsonRecord(files['manifest.json'], 'manifest.json', parseWarnings);
    const controlPostFailure = parseControlPostFailure(files, parseWarnings);
    return {
        parseWarnings,
        distributedRunRecord: parseDistributedRunRecord(
            files['distributed-run.json'],
            runnerSummary,
            manifestRecord,
            parseWarnings,
        ),
        controlRunRecord: parseJsonRecord(files['control-run.json'], 'control-run.json', parseWarnings),
        fleetReport: parseJsonRecord(files['fleet-report.json'], 'fleet-report.json', parseWarnings),
        failureBundle: parseJsonRecord(files['failures.json'], 'failures.json', parseWarnings),
        targetResolutionRecord: parseJsonRecord(
            files['target-resolution.json'],
            'target-resolution.json',
            parseWarnings,
        ),
        runnerSummary,
        manifestRecord,
        controlPostFailure,
        results: parseJsonl(files['results.jsonl'], 'results.jsonl', parseWarnings),
        events: parseJsonl(files['events.jsonl'], 'events.jsonl', parseWarnings),
    };
}

function timingFromFleetOrValues(
    value: unknown,
    values: readonly number[],
): DistributedRunPerformanceAnalysis['commandTiming'] {
    const record = asRecord(value);
    if (values.length > 0) {
        const p50Ms = percentile(values, 0.5);
        const p95Ms = percentile(values, 0.95);
        const p99Ms = percentile(values, 0.99);
        return {
            count: values.length,
            minMs: Math.min(...values),
            p50Ms,
            p95Ms,
            p99Ms,
            maxMs: Math.max(...values),
            averageMs: average(values),
            spreadRatio: p50Ms !== undefined && p95Ms !== undefined
                ? roundMetric(p95Ms / Math.max(1, p50Ms))
                : undefined,
            outlierCount: outlierCount(values, p50Ms, p95Ms),
        };
    }

    const count = numberValue(record.count) ?? 0;
    const minMs = numberValue(record.minMs);
    const p50Ms = numberValue(record.p50Ms);
    const p95Ms = numberValue(record.p95Ms);
    const p99Ms = numberValue(record.p99Ms);
    const maxMs = numberValue(record.maxMs);
    const averageMs = numberValue(record.averageMs);
    const spreadRatio = p50Ms !== undefined && p95Ms !== undefined
        ? roundMetric(p95Ms / Math.max(1, p50Ms))
        : undefined;
    return {
        count,
        minMs,
        p50Ms,
        p95Ms,
        p99Ms,
        maxMs,
        averageMs,
        spreadRatio,
        outlierCount: numberValue(record.outlierCount) ?? 0,
    };
}

function diagnosticCountsFromEvents(
    events: readonly Record<string, unknown>[],
): Readonly<{ warning: number; error: number }> {
    return {
        warning: events.filter(event => eventSeverity(event) === 'warning').length,
        error: events.filter(event => eventSeverity(event) === 'error').length,
    };
}

function eventSeverity(event: Record<string, unknown>): string | undefined {
    return firstString(
        readPath(event, ['value', 'severity']),
        readPath(event, ['payload', 'severity']),
        event.severity,
    );
}

function eventMessage(event: Record<string, unknown>): string | undefined {
    return firstString(
        readPath(event, ['value', 'message']),
        readPath(event, ['payload', 'message']),
        event.message,
    );
}

type StreamTimingSample = Readonly<{
    agentId?: string;
    commandId?: string;
    identityKey?: string;
    completeness: 'terminal' | 'partial';
    failed?: boolean;
    nested?: boolean;
    summary: Record<string, unknown>;
    observations: readonly Record<string, unknown>[];
}>;

type StreamTimingSampleCandidate = Readonly<{
    sample: StreamTimingSample;
    sourcePriority: number;
    index: number;
}>;

function streamSamplesFromResultsAndEvents(
    controlResults: readonly Record<string, unknown>[],
    jsonlResults: readonly Record<string, unknown>[],
    events: readonly Record<string, unknown>[],
): readonly StreamTimingSample[] {
    const samples = new Map<string, StreamTimingSampleCandidate>();
    let index = 0;
    for (const result of controlResults) {
        for (const sample of streamSamplesFromResult(result)) {
            upsertBestStreamSample(samples, { sample, sourcePriority: 40, index: index++ });
        }
    }
    for (const result of jsonlResults) {
        for (const sample of streamSamplesFromResult(result)) {
            upsertBestStreamSample(samples, { sample, sourcePriority: 50, index: index++ });
        }
    }
    events.forEach((event) => {
        const sample = streamSampleFromEvent(event);
        if (!sample) {
            return;
        }
        upsertBestStreamSample(samples, {
            sample,
            sourcePriority: streamEventPriority(event) * 10,
            index: index++,
        });
    });
    return [...samples.values()]
        .sort((left, right) => left.index - right.index)
        .map(candidate => candidate.sample);
}

function streamSamplesFromResult(
    result: Record<string, unknown>,
    inheritedAgentId?: string,
    inheritedIdentityKey?: string,
): readonly StreamTimingSample[] {
    const summary = streamSummaryRecord(result.result) ??
        streamSummaryRecord(result.value) ??
        streamSummaryRecord(result.actual) ??
        streamSummaryRecord(result.error);
    const agentId = firstString(result.agentId, inheritedAgentId);
    const resultIdentity = streamResultIdentity(result);
    const identityKey = firstString(inheritedIdentityKey, resultIdentity);
    const samples: StreamTimingSample[] = [];
    if (summary) {
        samples.push({
            agentId,
            commandId: firstString(summary.commandId, commandIdFromResult(result)),
            identityKey,
            completeness: 'terminal',
            failed: streamResultHasFailureSignal(result),
            nested: inheritedIdentityKey !== undefined,
            summary,
            observations: arrayRecords(summary.observations),
        });
    }
    nestedRecipeResultRecords(result).forEach((nestedResult, nestedIndex) => {
        const nestedIdentity = [
            firstString(resultIdentity, inheritedIdentityKey, commandIdFromResult(result)),
            `nested-${nestedIndex}`,
            streamResultIdentity(nestedResult),
        ].filter((value): value is string => value !== undefined).join('/');
        samples.push(...streamSamplesFromResult(
            nestedResult,
            agentId,
            nestedIdentity || inheritedIdentityKey,
        ));
    });
    return samples;
}

function streamResultIdentity(result: Record<string, unknown>): string | undefined {
    return firstString(
        result.resultKey,
        result.id,
        result.commandId,
        readPath(result, ['envelope', 'commandId']),
        commandIdFromResult(result),
    );
}

function streamResultHasFailureSignal(result: Record<string, unknown>): boolean {
    const status = firstString(result.status)?.toLowerCase();
    if (status === 'failure' || status === 'failed' || status === 'error') {
        return true;
    }
    if (booleanValue(result.ok) === false) {
        return true;
    }
    const actual = asRecord(result.actual);
    const error = asRecord(result.error);
    const value = asRecord(result.value);
    return isStreamFailureText([
        firstString(actual.code),
        firstString(actual.message),
        firstString(readPath(actual, ['details', 'code'])),
        firstString(readPath(actual, ['details', 'message'])),
        firstString(error.code),
        firstString(error.message),
        firstString(value.code),
        firstString(value.message),
    ].filter(Boolean).join(' '));
}

function nestedRecipeResultRecords(result: Record<string, unknown>): readonly Record<string, unknown>[] {
    return [
        ...arrayRecords(readPath(result, ['actual', 'results'])),
        ...arrayRecords(readPath(result, ['result', 'results'])),
        ...arrayRecords(readPath(result, ['result', 'value', 'results'])),
        ...arrayRecords(readPath(result, ['value', 'results'])),
    ];
}

function upsertBestStreamSample(
    samples: Map<string, StreamTimingSampleCandidate>,
    candidate: StreamTimingSampleCandidate,
): void {
    const key = equivalentStreamSampleKey(samples, candidate) ?? streamSampleKey(candidate.sample);
    const current = samples.get(key);
    if (!current || compareStreamSampleCandidates(candidate, current) > 0) {
        samples.set(key, candidate);
    }
}

function compareStreamSampleCandidates(
    left: StreamTimingSampleCandidate,
    right: StreamTimingSampleCandidate,
): number {
    const terminalPriority = Number(left.sample.completeness === 'terminal') -
        Number(right.sample.completeness === 'terminal');
    return terminalPriority ||
        streamSampleEvidenceScore(left.sample) - streamSampleEvidenceScore(right.sample) ||
        left.sourcePriority - right.sourcePriority ||
        left.index - right.index;
}

function streamSampleEvidenceScore(sample: StreamTimingSample): number {
    return (arrayRecords(sample.summary.thresholdFailures).length > 0 ? 1_000_000 : 0) +
        (sample.failed === true ? 500_000 : 0) +
        (numberValue(sample.summary.completedFrames) ?? 0) * 10_000 +
        (numberValue(sample.summary.scheduledFrames) ?? 0) * 1_000 +
        (numberValue(sample.summary.plannedFrames) ?? 0) * 100 +
        sample.observations.length;
}

function streamSampleFromEvent(event: Record<string, unknown>): StreamTimingSample | undefined {
    const topic = eventTopic(event);
    if (!topic?.startsWith('rallar.bb.rtc.stream_')) {
        return undefined;
    }
    const summary = streamSummaryFromEvent(event);
    if (!summary) {
        return undefined;
    }
    return {
        agentId: firstString(event.agentId),
        commandId: firstString(summary.commandId, event.commandId),
        completeness: topic === 'rallar.bb.rtc.stream_completed' ||
                topic === 'rallar.bb.rtc.stream_failed'
            ? 'terminal'
            : 'partial',
        failed: topic === 'rallar.bb.rtc.stream_failed' || eventSeverity(event) === 'error',
        summary,
        observations: arrayRecords(summary.observations),
    };
}

function streamSampleKey(sample: StreamTimingSample): string {
    const baseKey = streamSampleBaseKey(sample);
    return sample.identityKey ? `${baseKey}:${sample.identityKey}` : baseKey;
}

function equivalentStreamSampleKey(
    samples: Map<string, StreamTimingSampleCandidate>,
    candidate: StreamTimingSampleCandidate,
): string | undefined {
    for (const [key, current] of samples) {
        if (streamSamplesRepresentSameExecution(
            current.sample,
            candidate.sample,
            current.sourcePriority !== candidate.sourcePriority,
        )) {
            return key;
        }
    }
    return undefined;
}

function streamSamplesRepresentSameExecution(
    left: StreamTimingSample,
    right: StreamTimingSample,
    crossSource: boolean,
): boolean {
    if (streamSampleBaseKey(left) !== streamSampleBaseKey(right)) {
        return false;
    }
    if (left.identityKey && right.identityKey) {
        if (left.identityKey === right.identityKey) {
            return true;
        }
        if (left.nested === true && right.nested === true) {
            return false;
        }
        if (left.nested !== true && right.nested !== true) {
            return crossSource && streamSampleFingerprint(left) === streamSampleFingerprint(right);
        }
        return streamSampleFingerprint(left) === streamSampleFingerprint(right);
    }
    if (!left.identityKey && !right.identityKey) {
        return true;
    }
    return streamSampleFingerprint(left) === streamSampleFingerprint(right);
}

function streamSampleBaseKey(sample: StreamTimingSample): string {
    return `${sample.agentId ?? 'unknown-agent'}:${sample.commandId ?? firstString(sample.summary.commandId, 'unknown-stream') ?? 'unknown-stream'}`;
}

function streamSampleFingerprint(sample: StreamTimingSample): string {
    const summary = sample.summary;
    return JSON.stringify({
        plannedFrames: numberValue(summary.plannedFrames),
        scheduledFrames: numberValue(summary.scheduledFrames),
        attemptedFrames: numberValue(summary.attemptedFrames),
        completedFrames: numberValue(summary.completedFrames),
        failedFrames: numberValue(summary.failedFrames),
        droppedFrames: numberValue(summary.droppedFrames),
        inFlightLimitDropCount: streamSampleInFlightLimitDropCount(sample),
        backpressureCount: numberValue(summary.backpressureCount),
        requestedRateHz: numberValue(summary.requestedRateHz),
        achievedScheduleHz: numberValue(summary.achievedScheduleHz),
        achievedCompletionHz: numberValue(summary.achievedCompletionHz),
        pacing: {
            maxStartDriftMs: numberValue(readPath(summary, ['pacing', 'maxStartDriftMs'])),
            lateFrameCount: numberValue(readPath(summary, ['pacing', 'lateFrameCount'])),
        },
        duration: asRecord(summary.duration),
        thresholdFailures: arrayRecords(summary.thresholdFailures),
        observations: sample.observations,
    });
}

function streamEventPriority(event: Record<string, unknown>): number {
    const topic = eventTopic(event);
    if (topic === 'rallar.bb.rtc.stream_completed' || topic === 'rallar.bb.rtc.stream_failed') {
        return 3;
    }
    if (topic === 'rallar.bb.rtc.stream_progress') {
        return 2;
    }
    if (topic === 'rallar.bb.rtc.stream_started') {
        return 1;
    }
    return 0;
}

function receiverDeliverySamplesFromResults(
    distributedRun: ControlDistributedRunSnapshot,
    controlResults: readonly Record<string, unknown>[],
    jsonlResults: readonly Record<string, unknown>[],
): readonly ReceiverDeliverySample[] {
    const specsByCommandId = receiverDeliverySpecsByCommandId(distributedRun);
    const samples = new Map<string, ReceiverDeliverySample>();
    for (const result of [...controlResults, ...jsonlResults]) {
        for (const sample of receiverDeliverySamplesFromResult(result, specsByCommandId)) {
            const key = [
                sample.agentId ?? 'unknown-agent',
                sample.expectedInboundMessages ?? 'unknown-expected',
                sample.minExpectedInboundMessages ?? 'unknown-minimum',
            ].join(':');
            samples.set(key, sample);
        }
    }
    return [...samples.values()];
}

function receiverDeliverySpecsByCommandId(
    distributedRun: ControlDistributedRunSnapshot,
): ReadonlyMap<string, ReceiverDeliverySpec> {
    const specs = new Map<string, ReceiverDeliverySpec>();
    const walkCommands = (commands: readonly Record<string, unknown>[]): void => {
        for (const command of commands) {
            const commandId = firstString(command.commandId);
            const spec = receiverDeliverySpecFromMetadata(asRecord(command.metadata));
            if (commandId && spec) {
                specs.set(commandId, spec);
            }
            walkCommands(arrayRecords(command.commands));
            for (const group of arrayRecords(command.groups)) {
                walkCommands(arrayRecords(group.commands));
            }
        }
    };

    for (const selection of arrayRecords(readPath(distributedRun, ['manifest', 'recipes']))) {
        const recipe = asRecord(selection.recipe);
        walkCommands(arrayRecords(recipe.commands));
    }
    return specs;
}

function receiverDeliverySamplesFromResult(
    result: Record<string, unknown>,
    specsByCommandId: ReadonlyMap<string, ReceiverDeliverySpec>,
    inheritedAgentId?: string,
): readonly ReceiverDeliverySample[] {
    const samples: ReceiverDeliverySample[] = [];
    const stats = statsSummaryRecord(result.result) ??
        statsSummaryRecord(result.value) ??
        statsSummaryRecord(result.actual) ??
        statsSummaryRecord(result.error);
    const action = firstString(result.action, result.kind, readPath(result, ['result', 'kind']));
    const agentId = firstString(result.agentId, inheritedAgentId);
    const commandId = firstString(
        stats?.commandId,
        readPath(result, ['result', 'commandId']),
        commandIdFromResult(result),
    );
    const receivedMessages = numberValue(readPath(stats, ['counters', 'messages']));
    const inlineSpec = receiverDeliverySpecFromMetadata(asRecord(result.metadata)) ??
        receiverDeliverySpecFromMetadata(asRecord(readPath(result, ['result', 'metadata']))) ??
        receiverDeliverySpecFromMetadata(asRecord(readPath(result, ['value', 'metadata']))) ??
        receiverDeliverySpecFromMetadata(asRecord(stats?.metadata));
    const spec = inlineSpec ?? (commandId ? specsByCommandId.get(commandId) : undefined);

    if ((stats || action === 'stats') && receivedMessages !== undefined && spec) {
        samples.push({
            agentId,
            commandId,
            receivedMessages,
            ...spec,
        });
    }

    nestedRecipeResultRecords(result).forEach(nestedResult => {
        samples.push(...receiverDeliverySamplesFromResult(
            nestedResult,
            specsByCommandId,
            agentId,
        ));
    });
    return samples;
}

function statsSummaryRecord(value: unknown): Record<string, unknown> | undefined {
    const record = asRecord(value);
    if (numberValue(readPath(record, ['counters', 'messages'])) !== undefined) {
        return record;
    }
    const nestedCandidates = [
        asRecord(record.value),
        asRecord(record.result),
        asRecord(record.actual),
    ];
    return nestedCandidates.find(candidate =>
        numberValue(readPath(candidate, ['counters', 'messages'])) !== undefined
    );
}

function receiverDeliverySpecFromMetadata(
    metadata: Record<string, unknown>,
): ReceiverDeliverySpec | undefined {
    const nested = asRecord(metadata.receiverDelivery);
    const source = Object.keys(nested).length > 0 ? nested : metadata;
    const expectedInboundMessages = numberValue(source.expectedInboundMessages);
    const minExpectedInboundMessages = numberValue(source.minExpectedInboundMessages);
    const minReceiveRatio = numberValue(source.minReceiveRatio);
    if (
        expectedInboundMessages === undefined &&
        minExpectedInboundMessages === undefined &&
        minReceiveRatio === undefined
    ) {
        return undefined;
    }
    return {
        expectedInboundMessages,
        minExpectedInboundMessages,
        minReceiveRatio,
    };
}

function receiverDeliveryFromSamples(
    samples: readonly ReceiverDeliverySample[],
): DistributedRunPerformanceAnalysis['receiverDelivery'] {
    if (samples.length === 0) {
        return undefined;
    }

    const receivedMessages = samples.map(sample => sample.receivedMessages);
    const expectedInboundMessages = firstDefinedNumber(samples.map(sample => sample.expectedInboundMessages));
    const minExpectedInboundMessages = firstDefinedNumber(samples.map(sample => sample.minExpectedInboundMessages));
    const minReceiveRatio = firstDefinedNumber(samples.map(sample => sample.minReceiveRatio));
    const deliveryRatios = samples
        .map(sample => sample.expectedInboundMessages && sample.expectedInboundMessages > 0
            ? roundMetric(sample.receivedMessages / sample.expectedInboundMessages)
            : undefined)
        .filter((value): value is number => value !== undefined);

    return {
        sampleCount: samples.length,
        expectedInboundMessages,
        minExpectedInboundMessages,
        minReceiveRatio,
        minReceivedMessages: Math.min(...receivedMessages),
        medianReceivedMessages: percentile(receivedMessages, 0.5),
        p95ReceivedMessages: percentile(receivedMessages, 0.95),
        maxReceivedMessages: Math.max(...receivedMessages),
        minDeliveryRatio: deliveryRatios.length > 0 ? Math.min(...deliveryRatios) : undefined,
        medianDeliveryRatio: percentile(deliveryRatios, 0.5),
        p95DeliveryRatio: percentile(deliveryRatios, 0.95),
        lowestAgents: samples
            .filter((sample): sample is ReceiverDeliverySample & Readonly<{ agentId: string }> =>
                typeof sample.agentId === 'string' && sample.agentId.length > 0
            )
            .map(sample => ({
                agentId: sample.agentId,
                receivedMessages: sample.receivedMessages,
                expectedInboundMessages: sample.expectedInboundMessages,
                deliveryRatio: sample.expectedInboundMessages && sample.expectedInboundMessages > 0
                    ? roundMetric(sample.receivedMessages / sample.expectedInboundMessages)
                    : undefined,
            }))
            .sort((left, right) =>
                left.receivedMessages - right.receivedMessages ||
                (left.deliveryRatio ?? Number.POSITIVE_INFINITY) -
                    (right.deliveryRatio ?? Number.POSITIVE_INFINITY) ||
                left.agentId.localeCompare(right.agentId)
            )
            .slice(0, 5),
    };
}

function firstDefinedNumber(values: readonly (number | undefined)[]): number | undefined {
    return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function streamTimingFromSamples(
    samples: readonly StreamTimingSample[],
): DistributedRunPerformanceAnalysis['streamTiming'] {
    if (samples.length === 0 || !samples.every(hasCompleteStreamTimingEvidence)) {
        return undefined;
    }
    const completeSamples = samples;

    const durations = completeSamples.flatMap(streamSampleObservationDurations);
    const plannedFrames = sumStreamNumber(completeSamples, 'plannedFrames');
    const scheduledFrames = sumStreamNumber(completeSamples, 'scheduledFrames');
    const attemptedFrames = sumStreamNumber(completeSamples, 'attemptedFrames');
    const completedFrames = sumStreamNumber(completeSamples, 'completedFrames');
    const failedFrames = sumStreamNumber(completeSamples, 'failedFrames');
    const droppedFrames = sumStreamNumber(completeSamples, 'droppedFrames');
    const inFlightLimitDropCount = completeSamples.reduce(
        (sum, sample) => sum + streamSampleInFlightLimitDropCount(sample),
        0,
    );
    const backpressureCount = sumStreamNumber(completeSamples, 'backpressureCount');
    const maxStartDriftMs = maxDefined(completeSamples.map(sample =>
        numberValue(readPath(sample.summary, ['pacing', 'maxStartDriftMs']))
    ));
    const lateFrameCount = completeSamples.reduce(
        (sum, sample) => sum + (numberValue(readPath(sample.summary, ['pacing', 'lateFrameCount'])) ?? 0),
        0,
    );

    return {
        streamCount: completeSamples.length,
        plannedFrames,
        scheduledFrames,
        attemptedFrames,
        completedFrames,
        failedFrames,
        droppedFrames,
        inFlightLimitDropCount,
        backpressureCount,
        sendSuccessRatio: attemptedFrames > 0
            ? roundMetric(completedFrames / attemptedFrames)
            : undefined,
        requestedRateHz: averageDefined(completeSamples.map(sample => numberValue(sample.summary.requestedRateHz))),
        achievedScheduleHz: averageDefined(completeSamples.map(sample => numberValue(sample.summary.achievedScheduleHz))),
        achievedCompletionHz: averageDefined(completeSamples.map(sample => numberValue(sample.summary.achievedCompletionHz))),
        maxStartDriftMs,
        lateFrameCount,
        duration: streamDurationTimingFromSamples(completeSamples, durations),
        slowestAgents: slowestStreamAgentRows(completeSamples),
    };
}

function hasCompleteStreamTimingEvidence(sample: StreamTimingSample): boolean {
    return sample.completeness === 'terminal' && [
        'plannedFrames', 'completedFrames', 'failedFrames', 'droppedFrames',
    ].every(key => numberValue(sample.summary[key]) !== undefined);
}

function sumStreamNumber(samples: readonly StreamTimingSample[], key: string): number {
    return samples.reduce((sum, sample) => sum + (numberValue(sample.summary[key]) ?? 0), 0);
}

function streamSampleObservationDurations(sample: StreamTimingSample): readonly number[] {
    return sample.observations
        .filter(observation => !observation.dropped)
        .map(observation => numberValue(observation.durationMs))
        .filter((value): value is number => value !== undefined);
}

function streamSampleInFlightLimitDropCount(sample: StreamTimingSample): number {
    const fromSummary = numberValue(sample.summary.inFlightLimitDropCount);
    if (fromSummary !== undefined) {
        return fromSummary;
    }
    return sample.observations.filter(observation =>
        firstString(observation.errorCode, observation.code) === 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT'
    ).length;
}

function streamDurationTimingFromSamples(
    samples: readonly StreamTimingSample[],
    observationDurations: readonly number[],
): DistributedRunPerformanceAnalysis['commandTiming'] {
    if (observationDurations.length > 0) {
        return timingFromFleetOrValues(undefined, observationDurations);
    }
    if (samples.length === 1) {
        return timingFromFleetOrValues(asRecord(samples[0].summary.duration), []);
    }
    return timingFromFleetOrValues(undefined, samples.flatMap(streamSampleSummaryDurations));
}

function streamSampleSummaryDurations(sample: StreamTimingSample): readonly number[] {
    const duration = asRecord(sample.summary.duration);
    return [
        numberValue(duration.minMs),
        numberValue(duration.p50Ms),
        numberValue(duration.p95Ms),
        numberValue(duration.p99Ms),
        numberValue(duration.maxMs),
    ].filter((value): value is number => value !== undefined);
}

function slowestStreamAgentRows(
    samples: readonly StreamTimingSample[],
): NonNullable<DistributedRunPerformanceAnalysis['streamTiming']>['slowestAgents'] {
    const byAgent = new Map<string, StreamTimingSample[]>();
    for (const sample of samples) {
        if (!sample.agentId) {
            continue;
        }
        byAgent.set(sample.agentId, [...(byAgent.get(sample.agentId) ?? []), sample]);
    }
    return [...byAgent.entries()]
        .map(([agentId, agentSamples]) => {
            const observationDurations = agentSamples.flatMap(streamSampleObservationDurations);
            const durations = observationDurations.length > 0
                ? observationDurations
                : agentSamples.flatMap(streamSampleSummaryDurations);
            return {
                agentId,
                streamCount: agentSamples.length,
                plannedFrames: sumStreamNumber(agentSamples, 'plannedFrames'),
                completedFrames: sumStreamNumber(agentSamples, 'completedFrames'),
                averageMs: average(durations),
                p95Ms: percentile(durations, 0.95),
                p99Ms: percentile(durations, 0.99),
                maxMs: durations.length > 0 ? Math.max(...durations) : undefined,
            };
        })
        .sort((left, right) =>
            (right.maxMs ?? 0) - (left.maxMs ?? 0) ||
            (right.averageMs ?? 0) - (left.averageMs ?? 0) ||
            right.completedFrames - left.completedFrames ||
            left.agentId.localeCompare(right.agentId)
        )
        .slice(0, 5);
}

function streamTimeoutFailure(
    distributedRun: ControlDistributedRunSnapshot,
    events: readonly Record<string, unknown>[],
): DistributedRunFailureAnalysis | undefined {
    const state = firstString(distributedRun.state);
    if (!state || !TERMINAL_FAILURE_STATES.has(state)) {
        return undefined;
    }
    const streamEvent = [...events].reverse().find(event => {
        const topic = eventTopic(event);
        return topic === 'rallar.bb.rtc.stream_progress' || topic === 'rallar.bb.rtc.stream_started';
    });
    if (!streamEvent) {
        return undefined;
    }
    const summary = streamSummaryFromEvent(streamEvent) ?? {};
    const commandId = firstString(streamEvent.commandId, summary.commandId);
    const plannedFrames = numberValue(summary.plannedFrames);
    const completedFrames = numberValue(summary.completedFrames) ?? 0;
    const frameSummary = plannedFrames !== undefined
        ? `${completedFrames} of ${plannedFrames} completed frames`
        : `${completedFrames} completed frames`;
    const likelyCause = `RTC stream ${commandId ?? 'unknown-stream'} reached ${frameSummary} before the run stopped.`;
    const minimalFix = minimalFixArea({
        category: 'rtc-stream',
        transport: firstString(streamEvent.transport),
        text: likelyCause,
    });
    return {
        category: 'rtc-stream',
        title: 'RTC stream did not finish before the distributed run timed out.',
        likelyCause,
        nextAction: 'Inspect stream progress, send duration percentiles, in-flight frames, and RTC diagnostics for the affected agent.',
        minimalFixArea: minimalFix,
        verificationCommand: verificationCommand(minimalFix),
        affectedAgents: maybeStringArray(firstString(streamEvent.agentId)),
        affectedRegions: [],
        commandId,
        evidenceFile: 'events.jsonl',
    };
}

function streamSummaryRecord(value: unknown): Record<string, unknown> | undefined {
    const record = asRecord(value);
    const candidates = [
        asRecord(record.value),
        asRecord(asRecord(record.details)?.value),
        asRecord(asRecord(record.details)?.details),
        asRecord(asRecord(asRecord(record.details)?.details)?.value),
        asRecord(record.payload),
        asRecord(record.data),
        record,
    ];
    return candidates.find(hasStreamSummaryFields);
}

function streamSummaryFromEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
    const payload = asRecord(event.payload);
    const value = asRecord(event.value);
    const candidates = [
        asRecord(payload.data),
        asRecord(payload.payload),
        asRecord(value.data),
        asRecord(value.payload),
        payload,
        value,
    ];
    return candidates.find(hasStreamSummaryFields);
}

function hasStreamSummaryFields(record: Record<string, unknown>): boolean {
    return numberValue(record.plannedFrames) !== undefined ||
        numberValue(record.completedFrames) !== undefined ||
        numberValue(record.scheduledFrames) !== undefined ||
        Object.keys(asRecord(record.duration)).length > 0;
}

function eventTopic(event: Record<string, unknown>): string | undefined {
    return firstString(
        event.topic,
        readPath(event, ['payload', 'topic']),
        readPath(event, ['value', 'topic']),
        readPath(event, ['payload', 'data', 'topic']),
        readPath(event, ['value', 'data', 'topic']),
    );
}

function averageDefined(values: readonly (number | undefined)[]): number | undefined {
    return average(values.filter((value): value is number => value !== undefined));
}

function maxDefined(values: readonly (number | undefined)[]): number | undefined {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length > 0 ? Math.max(...defined) : undefined;
}

type CommandTimingSample = Readonly<{
    commandId?: string;
    agentId?: string;
    durationMs: number;
}>;

function timingSamplesFromControlRun(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
): readonly CommandTimingSample[] {
    const samples: CommandTimingSample[] = [];
    const sampledCommandIds = new Set<string>();
    const linkedCommandIds = linkedDistributedCommandIds(distributedRun);

    for (const command of arrayRecords(controlRun.commands)) {
        const commandId = commandIdFromCommand(command);
        if (!shouldIncludeTimingSample(commandId, linkedCommandIds)) {
            continue;
        }
        const durationMs = commandDurationMs(command);
        if (durationMs === undefined) {
            continue;
        }
        if (commandId) {
            sampledCommandIds.add(commandId);
        }
        samples.push({
            commandId,
            agentId: firstString(readPath(command, ['envelope', 'agentId']), command.agentId),
            durationMs,
        });
    }

    for (const result of arrayRecords(controlRun.results)) {
        const commandId = commandIdFromResult(result);
        if (!shouldIncludeTimingSample(commandId, linkedCommandIds)) {
            continue;
        }
        if (commandId && sampledCommandIds.has(commandId)) {
            continue;
        }
        const durationMs = resultDurationMs(result);
        if (durationMs === undefined) {
            continue;
        }
        if (commandId) {
            sampledCommandIds.add(commandId);
        }
        samples.push({
            commandId,
            agentId: firstString(result.agentId),
            durationMs,
        });
    }

    return samples;
}

function linkedDistributedCommandIds(distributedRun: ControlDistributedRunSnapshot): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const link of arrayRecords(distributedRun.commandLinks)) {
        const commandId = firstString(link.commandId);
        if (commandId) {
            ids.add(commandId);
        }
    }
    return ids;
}

function shouldIncludeTimingSample(commandId: string | undefined, linkedCommandIds: ReadonlySet<string>): boolean {
    return linkedCommandIds.size === 0 || (commandId !== undefined && linkedCommandIds.has(commandId));
}

function slowestAgentRows(
    samples: readonly CommandTimingSample[],
): DistributedRunPerformanceAnalysis['slowestAgents'] {
    const byAgent = new Map<string, number[]>();
    for (const sample of samples) {
        if (!sample.agentId) {
            continue;
        }
        byAgent.set(sample.agentId, [...(byAgent.get(sample.agentId) ?? []), sample.durationMs]);
    }
    return [...byAgent.entries()]
        .map(([agentId, durations]) => ({
            agentId,
            commandCount: durations.length,
            averageMs: average(durations),
            maxMs: Math.max(...durations),
        }))
        .sort((left, right) =>
            (right.maxMs ?? 0) - (left.maxMs ?? 0) ||
            (right.averageMs ?? 0) - (left.averageMs ?? 0) ||
            left.agentId.localeCompare(right.agentId)
        )
        .slice(0, 5);
}

function commandIdFromCommand(command: Record<string, unknown>): string | undefined {
    return firstString(readPath(command, ['envelope', 'commandId']), command.commandId);
}

function commandDurationMs(command: Record<string, unknown>): number | undefined {
    return durationFromFields(command, 'dispatchedAtEpochMs', 'completedAtEpochMs') ??
        durationFromFields(command, 'queuedAtEpochMs', 'completedAtEpochMs');
}

function resultDurationMs(result: Record<string, unknown>): number | undefined {
    const payload = asRecord(result.result);
    return numberValue(payload.durationMs) ??
        numberValue(result.durationMs) ??
        durationFromFields(payload, 'startedAtEpochMs', 'endedAtEpochMs') ??
        durationFromFields(result, 'startedAtEpochMs', 'endedAtEpochMs');
}

function durationFromFields(
    record: Record<string, unknown>,
    startKey: string,
    endKey: string,
): number | undefined {
    const start = numberValue(record[startKey]);
    const end = numberValue(record[endKey]);
    if (start === undefined || end === undefined || end < start) {
        return undefined;
    }
    return end - start;
}

function percentile(values: readonly number[], percentileValue: number): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1);
    return sorted[index];
}

function average(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    return roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundMetric(value: number): number {
    return Math.round(value * 100) / 100;
}

function outlierCount(
    values: readonly number[],
    p50Ms: number | undefined,
    p95Ms: number | undefined,
): number {
    if (values.length < 2 || p50Ms === undefined || p95Ms === undefined || p95Ms <= p50Ms) {
        return 0;
    }
    return values.filter(value => value >= p95Ms && value > p50Ms).length;
}

function parseControlPostFailure(
    files: DistributedRunArtifactFiles,
    warnings: DistributedRunArtifactParseWarning[],
): ControlPostFailureArtifact | undefined {
    const metadata = parseJsonRecord(
        files['control-post-error-metadata.json'],
        'control-post-error-metadata.json',
        warnings,
    );
    const metadataResponseFile = firstString(metadata.responseFile);
    const responseFile = metadataResponseFile && files[metadataResponseFile] !== undefined
        ? metadataResponseFile
        : CONTROL_POST_ERROR_FILE_NAMES.find(fileName => files[fileName] !== undefined);
    const hasMetadataFailure = Object.keys(metadata).length > 0;
    if (!responseFile && !hasMetadataFailure) {
        return undefined;
    }

    return {
        phase: firstString(metadata.phase) ?? (responseFile ? controlPostPhaseFromFileName(responseFile) : undefined),
        path: firstString(metadata.path),
        httpStatus: firstString(metadata.httpStatus),
        curlStatus: numberValue(metadata.curlStatus),
        exitStatus: numberValue(metadata.exitStatus),
        responseFile: responseFile ?? 'control-post-error-metadata.json',
        body: responseFile ? parseJsonRecord(files[responseFile], responseFile, warnings) : {},
    };
}

function controlPostPhaseFromFileName(fileName: string): string | undefined {
    const match = fileName.match(/^control-post-(.+)-error\.json$/);
    return match?.[1];
}

function parseDistributedRunRecord(
    text: string | undefined,
    runnerSummary: Record<string, unknown>,
    manifestRecord: Record<string, unknown>,
    warnings: DistributedRunArtifactParseWarning[],
): Record<string, unknown> {
    if (!text || text.trim().length === 0) {
        const fallback = distributedRunRecordFromFallback(runnerSummary, manifestRecord);
        if (fallback) {
            warnings.push({
                fileName: 'distributed-run.json',
                message: 'distributed-run.json is missing or empty; using runner-summary.json and manifest.json fallback.',
            });
            return fallback;
        }
        throw new Error('distributed-run.json is required.');
    }

    try {
        return asRecord(JSON.parse(text));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const fallback = distributedRunRecordFromFallback(runnerSummary, manifestRecord);
        if (fallback) {
            warnings.push({
                fileName: 'distributed-run.json',
                message: `distributed-run.json is not valid JSON: ${detail}; using runner-summary.json and manifest.json fallback.`,
            });
            return fallback;
        }
        throw new Error(`distributed-run.json is not valid JSON: ${detail}`);
    }
}

function distributedRunRecordFromFallback(
    runnerSummary: Record<string, unknown>,
    manifestRecord: Record<string, unknown>,
): Record<string, unknown> | undefined {
    if (Object.keys(runnerSummary).length === 0 && Object.keys(manifestRecord).length === 0) {
        return undefined;
    }

    const distributedRunId = firstString(
        runnerSummary.distributedRunId,
        manifestRecord.distributedRunId,
        'unknown-distributed-run',
    ) ?? 'unknown-distributed-run';
    const controlRunId = firstString(
        runnerSummary.controlRunId,
        manifestRecord.controlRunId,
        distributedRunId,
    ) ?? distributedRunId;
    const state = firstString(runnerSummary.state, 'unknown') ?? 'unknown';
    const ok = booleanValue(runnerSummary.ok) ?? state === 'passed';
    const blockingFailures = ok ? 0 : 1;

    return {
        distributedRunId,
        controlRunId,
        state,
        createdAtEpochMs: numberValue(runnerSummary.createdAtEpochMs) ??
            numberValue(runnerSummary.startedAtEpochMs) ??
            0,
        startedAtEpochMs: numberValue(runnerSummary.startedAtEpochMs),
        completedAtEpochMs: numberValue(runnerSummary.completedAtEpochMs),
        updatedAtEpochMs: numberValue(runnerSummary.completedAtEpochMs) ??
            numberValue(runnerSummary.startedAtEpochMs) ??
            0,
        targetAgentIds: stringArray(runnerSummary.targetAgentIds),
        commandLinks: arrayRecords(runnerSummary.commandLinks),
        manifest: {
            ...manifestRecord,
            schemaVersion: numberValue(manifestRecord.schemaVersion) ?? 1,
            distributedRunId: firstString(manifestRecord.distributedRunId, distributedRunId) ?? distributedRunId,
            controlRunId: firstString(manifestRecord.controlRunId, controlRunId) ?? controlRunId,
            group: asRecord(manifestRecord.group),
            recipes: arrayRecords(manifestRecord.recipes),
            targetPolicy: asRecord(manifestRecord.targetPolicy),
            roleAssignments: arrayRecords(manifestRecord.roleAssignments),
        },
        rollup: {
            state,
            ok,
            summary: {
                blockingFailures,
                ...asRecord(runnerSummary.summary),
            },
            failures: arrayRecords(runnerSummary.failures),
        },
    };
}

function parseJsonRecord(
    text: string | undefined,
    fileName: string,
    warnings: DistributedRunArtifactParseWarning[],
    required = false,
): Record<string, unknown> {
    if (!text || text.trim().length === 0) {
        if (required) {
            throw new Error(`${fileName} is required.`);
        }
        return {};
    }
    try {
        return asRecord(JSON.parse(text));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (required) {
            throw new Error(`${fileName} is not valid JSON: ${detail}`);
        }
        warnings.push({ fileName, message: `${fileName} is not valid JSON: ${detail}` });
        return {};
    }
}

function parseJsonl(
    text: string | undefined,
    fileName: string,
    warnings: DistributedRunArtifactParseWarning[],
): readonly Record<string, unknown>[] {
    if (!text || text.trim().length === 0) {
        return [];
    }
    const rows: Record<string, unknown>[] = [];
    text.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            return;
        }
        try {
            rows.push(asRecord(JSON.parse(trimmed)));
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            warnings.push({
                fileName,
                lineNumber: index + 1,
                message: `${fileName}:${index + 1} is not valid JSON: ${detail}`,
            });
        }
    });
    return rows;
}

function normalizeDistributedRunRecord(
    record: Record<string, unknown>,
    exportedResults: readonly Record<string, unknown>[] = [],
): ControlDistributedRunSnapshot {
    const rollup = asRecord(record.rollup);
    const rollupFailures = arrayRecords(rollup.failures).map(normalizeRollupFailureRecord);
    const commandLinks = arrayRecords(record.commandLinks);
    const rawManifest = asRecord(record.manifest);
    const distributedRunId = firstString(
        record.distributedRunId,
        rawManifest.distributedRunId,
        'unknown-distributed-run',
    ) ?? 'unknown-distributed-run';
    const controlRunId = firstString(
        record.controlRunId,
        rawManifest.controlRunId,
        distributedRunId,
        'unknown-control-run',
    ) ?? 'unknown-control-run';
    return {
        distributedRunId,
        controlRunId,
        manifest: ({
            ...recognizedDistributedManifestFields(rawManifest),
            schemaVersion: numberValue(rawManifest.schemaVersion) ?? 1,
            distributedRunId,
            controlRunId,
            group: asRecord(rawManifest.group),
            recipes: arrayRecords(rawManifest.recipes) as ControlDistributedRunSnapshot['manifest']['recipes'],
            targetPolicy: asRecord(rawManifest.targetPolicy) as ControlDistributedRunSnapshot['manifest']['targetPolicy'],
            roleAssignments: arrayRecords(rawManifest.roleAssignments) as ControlDistributedRunSnapshot['manifest']['roleAssignments'],
            startMode: firstString(rawManifest.startMode, 'manual') as ControlDistributedRunSnapshot['manifest']['startMode'],
            displayName: firstString(rawManifest.displayName),
            metadata: asRecord(rawManifest.metadata),
        } as unknown as ControlDistributedRunSnapshot['manifest']),
        state: firstString(record.state, 'unknown') as ControlDistributedRunSnapshot['state'],
        createdAtEpochMs: numberValue(record.createdAtEpochMs) ?? numberValue(record.startedAtEpochMs) ?? 0,
        updatedAtEpochMs: numberValue(record.updatedAtEpochMs) ?? numberValue(record.completedAtEpochMs) ?? numberValue(record.startedAtEpochMs) ?? 0,
        stagedAtEpochMs: numberValue(record.stagedAtEpochMs),
        barrierStartedAtEpochMs: numberValue(record.barrierStartedAtEpochMs),
        barrierCompletedAtEpochMs: numberValue(record.barrierCompletedAtEpochMs),
        startedAtEpochMs: numberValue(record.startedAtEpochMs),
        cancelledAtEpochMs: numberValue(record.cancelledAtEpochMs),
        completedAtEpochMs: numberValue(record.completedAtEpochMs),
        targetAgentIds: stringArray(record.targetAgentIds),
        commandLinks: (commandLinks.length > 0
            ? commandLinks
            : exportedResults.map((result) => ({
                phase: 'start',
                agentId: firstString(result.agentId, 'unknown-agent') ?? 'unknown-agent',
                commandId: commandIdFromResult(result) ?? 'unknown-command',
                recipeId: firstString(result.recipeId),
                queuedAtEpochMs: numberValue(result.queuedAtEpochMs) ?? 0,
            }))) as ControlDistributedRunSnapshot['commandLinks'],
        rollup: {
            state: firstString(rollup.state, record.state, 'unknown') as ControlDistributedRunSnapshot['rollup']['state'],
            ok: booleanValue(rollup.ok) ?? false,
            summary: asRecord(rollup.summary) as ControlDistributedRunSnapshot['rollup']['summary'],
            failures: rollupFailures as unknown as ControlDistributedRunSnapshot['rollup']['failures'],
        },
        error: optionalRecord(record.error) as ControlDistributedRunSnapshot['error'],
    };
}

function recognizedDistributedManifestFields(
    manifest: Record<string, unknown>,
): Record<string, unknown> {
    const recognized: Record<string, unknown> = {};
    for (const key of [
        'description',
        'variables',
        'secretRefs',
        'roleAssignmentPolicy',
        'ackTimeoutMs',
        'barrier',
        'startDeadlineEpochMs',
        'artifactPolicy',
    ]) {
        if (manifest[key] !== undefined) {
            recognized[key] = manifest[key];
        }
    }
    return recognized;
}

function normalizeControlRunRecord(
    record: Record<string, unknown>,
    fallbackRunId: string,
    fallbackResults: readonly Record<string, unknown>[] = [],
    fallbackEvents: readonly Record<string, unknown>[] = [],
): ControlRunSnapshot {
    const runId = firstString(record.runId, fallbackRunId, 'unknown-control-run') ?? 'unknown-control-run';
    const results = arrayRecords(record.results);
    const events = arrayRecords(record.events);
    return {
        runId,
        createdAtEpochMs: numberValue(record.createdAtEpochMs) ?? 0,
        updatedAtEpochMs: numberValue(record.updatedAtEpochMs) ?? 0,
        agents: arrayRecords(record.agents) as ControlRunSnapshot['agents'],
        commands: arrayRecords(record.commands) as ControlRunSnapshot['commands'],
        results: (results.length > 0
            ? results
            : fallbackResults.map((result) => normalizeControlResultRecord(result, runId))) as ControlRunSnapshot['results'],
        events: (events.length > 0
            ? events
            : fallbackEvents.map((event, index) => normalizeControlEventRecord(event, runId, index))) as ControlRunSnapshot['events'],
        stats: arrayRecords(record.stats) as ControlRunSnapshot['stats'],
        reports: arrayRecords(record.reports) as ControlRunSnapshot['reports'],
        heartbeats: arrayRecords(record.heartbeats) as ControlRunSnapshot['heartbeats'],
    };
}

function normalizeRollupFailureRecord(failure: Record<string, unknown>): Record<string, unknown> {
    const error = asRecord(failure.error);
    const code = firstString(error.code, failure.code);
    const message = firstString(error.message, failure.message, failure.state);
    return {
        ...failure,
        error: {
            ...error,
            ...(code ? { code } : {}),
            ...(message ? { message } : {}),
        },
    };
}

function normalizeControlResultRecord(
    result: Record<string, unknown>,
    fallbackRunId: string,
): Record<string, unknown> {
    const actual = asRecord(result.actual ?? result.error);
    const status = firstString(result.status)?.toUpperCase();
    const ok = booleanValue(result.ok) ?? (status ? status !== 'FAILURE' : false);
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: firstString(result.runId, fallbackRunId) ?? fallbackRunId,
        agentId: firstString(result.agentId, 'unknown-agent') ?? 'unknown-agent',
        resultKey: firstString(result.resultKey),
        commandId: commandIdFromResult(result) ?? 'unknown-command',
        ok,
        result: normalizeResultPayload(result),
        error: ok
            ? undefined
            : {
                code: firstString(actual.code, 'COMMAND_FAILED') ?? 'COMMAND_FAILED',
                message: firstString(actual.message, result.message, 'Command failed.') ?? 'Command failed.',
                details: actual.details,
            },
    };
}

function commandIdFromResult(result: Record<string, unknown> | undefined): string | undefined {
    if (!result) {
        return undefined;
    }
    const explicit = firstString(result.commandId);
    if (explicit) {
        return explicit;
    }
    const resultKey = firstString(result.resultKey);
    if (!resultKey) {
        return undefined;
    }
    const [, commandId] = resultKey.split(/:(.*)/s);
    return commandId || resultKey;
}

function normalizeResultPayload(result: Record<string, unknown>): Record<string, unknown> {
    const nested = asRecord(result.result);
    const streamSummary = streamSummaryRecord(result.actual) ?? streamSummaryRecord(result.error);
    const payload = Object.keys(nested).length > 0 ? nested : streamSummary ?? nested;
    return {
        ...payload,
        ...(numberValue(payload.durationMs) === undefined && numberValue(result.durationMs) !== undefined
            ? { durationMs: numberValue(result.durationMs) }
            : {}),
        ...(numberValue(payload.startedAtEpochMs) === undefined && numberValue(result.startedAtEpochMs) !== undefined
            ? { startedAtEpochMs: numberValue(result.startedAtEpochMs) }
            : {}),
        ...(numberValue(payload.endedAtEpochMs) === undefined && numberValue(result.endedAtEpochMs) !== undefined
            ? { endedAtEpochMs: numberValue(result.endedAtEpochMs) }
            : {}),
        ...(firstString(payload.commandId) === undefined && commandIdFromResult(result)
            ? { commandId: commandIdFromResult(result) }
            : {}),
    };
}

function normalizeControlEventRecord(
    event: Record<string, unknown>,
    fallbackRunId: string,
    index: number,
): Record<string, unknown> {
    const value = event.value ?? event.payload ?? event;
    const severity = firstString(readPath(value, ['severity']), event.severity);
    return {
        kind: severity === 'error' || severity === 'warning' ? 'diagnostic' : 'event',
        protocolVersion: 1,
        runId: firstString(event.runId, fallbackRunId) ?? fallbackRunId,
        agentId: firstString(event.agentId, 'unknown-agent') ?? 'unknown-agent',
        commandId: firstString(event.commandId),
        eventId: firstString(event.eventId, `${firstString(event.kind, 'event')}-${index}`),
        atEpochMs: numberValue(event.atEpochMs) ?? numberValue(readPath(value, ['atEpochMs'])) ?? 0,
        payload: value,
    };
}

function readPath(value: unknown, path: readonly string[]): unknown {
    let current: unknown = value;
    for (const segment of path) {
        const record = asRecord(current);
        if (!(segment in record)) {
            return undefined;
        }
        current = record[segment];
    }
    return current;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
    const record = asRecord(value);
    return Object.keys(record).length > 0 ? record : undefined;
}

function arrayRecords(value: unknown): readonly Record<string, unknown>[] {
    return Array.isArray(value) ? value.map(asRecord) : [];
}

function numberRecord(value: unknown): Readonly<Record<string, number>> {
    return Object.fromEntries(
        Object.entries(asRecord(value))
            .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

function firstString(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

function stringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [];
}

function maybeStringArray(value: string | undefined): readonly string[] {
    return value ? [value] : [];
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function formatMs(value: number | undefined): string {
    return value === undefined ? '-' : `${Math.round(value)}ms`;
}

function formatRate(value: number | undefined): string {
    return value === undefined ? '-' : `${roundMetric(value)}Hz`;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (_error) {
        return {};
    }
}
