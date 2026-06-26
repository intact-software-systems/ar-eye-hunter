import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlFleetRunReport,
    ControlRunSnapshot,
} from './control-run-manager.ts';
import {
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView,
    type DistributedRunAnalysisReport,
    type RunVerdictView,
} from './distributed-recipes.ts';

export type DistributedRunArtifactFiles = Readonly<Record<string, string | undefined>>;

export type DistributedRunAnalysisInput = Readonly<{
    files: DistributedRunArtifactFiles;
    generatedAtEpochMs?: number;
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
    slowestAgents: readonly Readonly<{
        agentId: string;
        commandCount: number;
        averageMs?: number;
        maxMs?: number;
    }>[];
}>;

export type DistributedRunAnalysis = Readonly<{
    generatedAtEpochMs: number;
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

const TERMINAL_FAILURE_STATES = new Set(['failed', 'timed-out', 'cancelled']);

const DISTRIBUTED_ARTIFACT_FILE_NAMES = new Set([
    'distributed-run.json',
    'manifest.json',
    'control-run.json',
    'fleet-report.json',
    'report.json',
    'results.jsonl',
    'events.jsonl',
    'failures.json',
    'metadata.json',
]);

const DISTRIBUTED_ARTIFACT_V2_REQUIRED_FILE_NAMES = [
    'report.json',
    'results.jsonl',
    'events.jsonl',
    'failures.json',
    'metadata.json',
] as const;

export function analyzeDistributedRunArtifactFiles(
    input: DistributedRunAnalysisInput,
): DistributedRunAnalysis {
    const {
        parseWarnings,
        distributedRunRecord,
        controlRunRecord,
        fleetReport,
        failureBundle,
        results,
        events,
    } = parseDistributedRunArtifactFiles(input.files);
    const distributedRun = normalizeDistributedRunRecord(distributedRunRecord, results);
    const controlRun = normalizeControlRunRecord(controlRunRecord, distributedRun.controlRunId, results, events);
    const artifactBundle = distributedArtifactBundleFromFiles(
        input.files,
        input.generatedAtEpochMs ?? Date.now(),
        distributedRun.distributedRunId,
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
    const performance = derivePerformance(distributedRun, controlRun, fleetReport, events);
    const failure = ok
        ? undefined
        : deriveFailure({ distributedRun, fleetReport, failureBundle, results, events, spaReport: spa?.report });
    const summary = {
        agents: numberValue(readPath(fleetReport, ['summary', 'agents'])) ?? performance.agentCount,
        passRate: numberValue(readPath(fleetReport, ['summary', 'passRate'])) ?? performance.passRate,
        failureGroups: numberValue(readPath(fleetReport, ['summary', 'failureGroups'])) ??
            (failure ? 1 : 0),
        blockingFailures: numberValue(readPath(distributedRun, ['rollup', 'summary', 'blockingFailures'])) ??
            (failure ? 1 : 0),
    };

    const base: Omit<DistributedRunAnalysis, 'summaryMarkdown' | 'fixProposalMarkdown' | 'performanceMarkdown'> = {
        generatedAtEpochMs: input.generatedAtEpochMs ?? Date.now(),
        distributedRunId,
        controlRunId,
        status,
        ok,
        group,
        summary,
        parseWarnings,
        failure,
        performance,
        spa,
    };
    const summaryMarkdown = renderSummaryMarkdown(base);
    const fixProposalMarkdown = failure ? renderFixProposalMarkdown(base) : undefined;
    const performanceMarkdown = ok ? renderPerformanceMarkdown(base) : undefined;

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
    const artifactSchemaVersion = DISTRIBUTED_ARTIFACT_V2_REQUIRED_FILE_NAMES
        .every(fileName => bundleFiles[fileName] !== undefined)
        ? 2
        : 1;

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

function deriveFailure(input: Readonly<{
    distributedRun: ControlDistributedRunSnapshot;
    fleetReport: Record<string, unknown>;
    failureBundle: Record<string, unknown>;
    results: readonly Record<string, unknown>[];
    events: readonly Record<string, unknown>[];
    spaReport?: DistributedRunAnalysisReport;
}>): DistributedRunFailureAnalysis {
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

function derivePerformance(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
    fleetReport: Record<string, unknown>,
    events: readonly Record<string, unknown>[],
): DistributedRunPerformanceAnalysis {
    const agents = arrayRecords(controlRun.agents);
    const commandTimingSamples = timingSamplesFromControlRun(distributedRun, controlRun);
    const commandDurations = commandTimingSamples.map(sample => sample.durationMs);
    const commandTiming = timingFromFleetOrValues(readPath(fleetReport, ['timing', 'commands']), commandDurations);
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
        performance.slowestAgents.length > 0
            ? `Slowest agents: ${performance.slowestAgents.map((agent) => `${agent.agentId} max=${formatMs(agent.maxMs)} avg=${formatMs(agent.averageMs)}`).join(', ')}`
            : undefined,
        '',
    ].filter((line): line is string => line !== undefined).join('\n');
}

function firstFailedResult(
    results: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
    return results.find((result) =>
        firstString(result.status)?.toUpperCase() === 'FAILURE' || booleanValue(result.ok) === false
    );
}

function verificationCommand(minimalFixArea: string): string {
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

type ParsedDistributedRunArtifactFiles = Readonly<{
    parseWarnings: DistributedRunArtifactParseWarning[];
    distributedRunRecord: Record<string, unknown>;
    controlRunRecord: Record<string, unknown>;
    fleetReport: Record<string, unknown>;
    failureBundle: Record<string, unknown>;
    results: readonly Record<string, unknown>[];
    events: readonly Record<string, unknown>[];
}>;

function parseDistributedRunArtifactFiles(
    files: DistributedRunArtifactFiles,
): ParsedDistributedRunArtifactFiles {
    const parseWarnings: DistributedRunArtifactParseWarning[] = [];
    return {
        parseWarnings,
        distributedRunRecord: parseJsonRecord(
            files['distributed-run.json'],
            'distributed-run.json',
            parseWarnings,
            true,
        ),
        controlRunRecord: parseJsonRecord(files['control-run.json'], 'control-run.json', parseWarnings),
        fleetReport: parseJsonRecord(files['fleet-report.json'], 'fleet-report.json', parseWarnings),
        failureBundle: parseJsonRecord(files['failures.json'], 'failures.json', parseWarnings),
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
    return {
        distributedRunId: firstString(record.distributedRunId, 'unknown-distributed-run') ?? 'unknown-distributed-run',
        controlRunId: firstString(record.controlRunId, record.distributedRunId, 'unknown-control-run') ?? 'unknown-control-run',
        manifest: ({
            schemaVersion: numberValue(readPath(record, ['manifest', 'schemaVersion'])) ?? 1,
            distributedRunId: firstString(readPath(record, ['manifest', 'distributedRunId']), record.distributedRunId, 'unknown-distributed-run') ??
                'unknown-distributed-run',
            controlRunId: firstString(readPath(record, ['manifest', 'controlRunId']), record.controlRunId, 'unknown-control-run') ??
                'unknown-control-run',
            group: asRecord(readPath(record, ['manifest', 'group'])),
            recipes: arrayRecords(readPath(record, ['manifest', 'recipes'])) as ControlDistributedRunSnapshot['manifest']['recipes'],
            targetPolicy: asRecord(readPath(record, ['manifest', 'targetPolicy'])) as ControlDistributedRunSnapshot['manifest']['targetPolicy'],
            roleAssignments: arrayRecords(readPath(record, ['manifest', 'roleAssignments'])) as ControlDistributedRunSnapshot['manifest']['roleAssignments'],
            startMode: firstString(readPath(record, ['manifest', 'startMode']), 'manual') as ControlDistributedRunSnapshot['manifest']['startMode'],
            displayName: firstString(readPath(record, ['manifest', 'displayName'])),
            metadata: asRecord(readPath(record, ['manifest', 'metadata'])),
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
    return {
        ...nested,
        ...(numberValue(nested.durationMs) === undefined && numberValue(result.durationMs) !== undefined
            ? { durationMs: numberValue(result.durationMs) }
            : {}),
        ...(numberValue(nested.startedAtEpochMs) === undefined && numberValue(result.startedAtEpochMs) !== undefined
            ? { startedAtEpochMs: numberValue(result.startedAtEpochMs) }
            : {}),
        ...(numberValue(nested.endedAtEpochMs) === undefined && numberValue(result.endedAtEpochMs) !== undefined
            ? { endedAtEpochMs: numberValue(result.endedAtEpochMs) }
            : {}),
        ...(firstString(nested.commandId) === undefined && commandIdFromResult(result)
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

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (_error) {
        return {};
    }
}
