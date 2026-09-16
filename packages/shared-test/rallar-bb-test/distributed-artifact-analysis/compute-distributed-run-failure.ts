import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunFailureAnalysis } from '../distributed-artifact-analysis.ts';
import type { DistributedRunAnalysisReport } from '../distributed-run-analysis/distributed-run-analysis-report.ts';
import { computeControlRequestFailure } from './compute-control-request-failure.ts';
import { computeStreamPerformanceFailure, computeStreamTimeoutFailure } from './compute-stream-failure.ts';
import type { DistributedRunEventEvidence } from './decode-distributed-run-event-evidence.ts';
import type {
    DistributedRunBundledFailure,
    DistributedRunFleetReportEvidence
} from './decode-distributed-run-report-evidence.ts';
import type { DistributedRunResultEvidence } from './decode-distributed-run-result-evidence.ts';
import {
    resolveEvidenceFileForAction,
    resolveFailureCategory,
    resolveMinimalFixArea,
    resolveVerificationCommand,
    TERMINAL_FAILURE_STATES,
    toAffectedAgents
} from './distributed-run-failure-vocabulary.ts';
import type { ControlPostFailureArtifact } from './to-distributed-run-artifact-content.ts';

const UNCLASSIFIED_CATEGORY = 'unknown';

export interface DistributedRunFailureInput {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly fleetReport: DistributedRunFleetReportEvidence;
    /** Absent when failures.json lists no failures. */
    readonly bundledFailure?: DistributedRunBundledFailure;
    /** Absent when the runner recorded no failed control request. */
    readonly controlPostFailure?: ControlPostFailureArtifact;
    readonly results: readonly DistributedRunResultEvidence[];
    readonly events: readonly DistributedRunEventEvidence[];
    readonly spaReport: DistributedRunAnalysisReport;
}

/**
 * The first focus of a run that did not pass, from the most specific evidence to the least: a failed
 * control request, stream thresholds, receiver delivery, fleet signatures, failed results, stalled
 * streams, the report's next action, failures.json, runtime diagnostics, and finally the run state.
 */
export function computeDistributedRunFailure(input: DistributedRunFailureInput): DistributedRunFailureAnalysis {
    return (input.controlPostFailure ? computeControlRequestFailure(input.controlPostFailure) : undefined) ??
        computeStreamPerformanceFailure(input.results, input.events) ??
        computeReceiverDeliveryFailure(input.results) ??
        computeFleetSignatureFailure(input.fleetReport, input.results) ??
        computeFailedResultFailure(input.results) ??
        computeStreamTimeoutFailure(input.distributedRun, input.events) ??
        computeReportActionFailure(input.spaReport) ??
        computeBundledFailure(input.bundledFailure) ??
        computeDiagnosticFailure(input.events) ??
        computeRunStateFailure(input.distributedRun);
}

function computeReceiverDeliveryFailure(
    results: readonly DistributedRunResultEvidence[]
): DistributedRunFailureAnalysis | undefined {
    const failedResult = results.find((result) => {
        const text = result.deliveryFailureTexts.join(' ').toLowerCase();
        return recordsFailedResult(result) &&
            (text.includes('stats.counters.messages') || (text.includes('receiver') && text.includes('delivery')));
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
        verificationCommand: resolveVerificationCommand(minimalFix),
        affectedAgents: toAffectedAgents(failedResult.agentId),
        affectedRegions: [],
        commandId: failedResult.commandId,
        evidenceFile: 'results.jsonl'
    };
}

function computeFleetSignatureFailure(
    fleetReport: DistributedRunFleetReportEvidence,
    results: readonly DistributedRunResultEvidence[]
): DistributedRunFailureAnalysis | undefined {
    const signature = fleetReport.firstFailureSignature;
    if (!signature) {
        return undefined;
    }
    const minimalFix = resolveMinimalFixArea({
        category: signature.category,
        transport: signature.transport,
        text: [signature.title, signature.normalizedMessage, signature.likelyCause].filter(Boolean).join(' ')
    });
    return {
        category: signature.category ?? UNCLASSIFIED_CATEGORY,
        title: signature.title ?? 'Fleet failure signature',
        likelyCause: signature.likelyCause ?? signature.normalizedMessage ??
            'The fleet report grouped this run as failed.',
        nextAction: signature.nextAction ?? 'Open the run artifacts and inspect the affected agent evidence.',
        minimalFixArea: minimalFix,
        verificationCommand: resolveVerificationCommand(minimalFix),
        affectedAgents: signature.affectedAgents,
        affectedRegions: signature.affectedRegions,
        commandId: signature.commandId ?? results.find(recordsFailedResult)?.commandId,
        recipeId: signature.recipeId,
        evidenceFile: 'fleet-report.json'
    };
}

function computeFailedResultFailure(
    results: readonly DistributedRunResultEvidence[]
): DistributedRunFailureAnalysis | undefined {
    const failedResult = results.find(recordsFailedResult);
    if (!failedResult) {
        return undefined;
    }
    const message = failedResult.failureMessage ?? failedResult.message ?? 'Command result failed';
    const category = resolveFailureCategory(failedResult.failureCode, message);
    const minimalFix = resolveMinimalFixArea({
        category,
        transport: failedResult.transport,
        text: `${failedResult.action ?? ''} ${message}`
    });
    return {
        category,
        title: message,
        likelyCause: message,
        nextAction: 'Open the failing command result and compare expected vs observed payload evidence.',
        minimalFixArea: minimalFix,
        verificationCommand: resolveVerificationCommand(minimalFix),
        affectedAgents: toAffectedAgents(failedResult.agentId),
        affectedRegions: [],
        commandId: failedResult.commandId,
        evidenceFile: 'results.jsonl'
    };
}

function computeReportActionFailure(
    spaReport: DistributedRunAnalysisReport
): DistributedRunFailureAnalysis | undefined {
    const action = spaReport.nextActions[0];
    if (!action) {
        return undefined;
    }
    const failure = spaReport.firstFailure;
    const minimalFix = resolveMinimalFixArea({
        category: action.category,
        text: `${action.title} ${action.likelyCause} ${action.nextAction}`
    });
    return {
        category: action.category,
        title: action.title,
        likelyCause: action.likelyCause,
        nextAction: action.nextAction,
        minimalFixArea: minimalFix,
        verificationCommand: resolveVerificationCommand(minimalFix),
        affectedAgents: toAffectedAgents(failure?.agentId),
        affectedRegions: [],
        commandId: failure?.commandId,
        recipeId: failure?.recipeId,
        evidenceFile: resolveEvidenceFileForAction(action.category)
    };
}

function computeBundledFailure(
    bundledFailure: DistributedRunBundledFailure | undefined
): DistributedRunFailureAnalysis | undefined {
    if (!bundledFailure) {
        return undefined;
    }
    const message = bundledFailure.errorMessage ?? bundledFailure.message ?? 'Failure bundle entry';
    const minimalFix = resolveMinimalFixArea({
        category: resolveFailureCategory(bundledFailure.code, message),
        text: message
    });
    return {
        category: resolveFailureCategory(bundledFailure.code, message),
        title: message,
        likelyCause: message,
        nextAction: 'Open failures.json and the matching control-run command evidence.',
        minimalFixArea: minimalFix,
        verificationCommand: resolveVerificationCommand(minimalFix),
        affectedAgents: toAffectedAgents(bundledFailure.agentId),
        affectedRegions: [],
        commandId: bundledFailure.commandId,
        evidenceFile: 'failures.json'
    };
}

function computeDiagnosticFailure(
    events: readonly DistributedRunEventEvidence[]
): DistributedRunFailureAnalysis | undefined {
    const diagnostic = events.find((event) => event.severity === 'error' || event.severity === 'warning');
    if (!diagnostic) {
        return undefined;
    }
    const message = diagnostic.message ?? 'Runtime diagnostic correlated with failed run';
    const minimalFix = resolveMinimalFixArea({
        category: 'diagnostic',
        transport: diagnostic.transport,
        text: message
    });
    return {
        category: 'diagnostic',
        title: message,
        likelyCause: message,
        nextAction: 'Inspect the runtime diagnostic event and nearby command evidence.',
        minimalFixArea: minimalFix,
        verificationCommand: resolveVerificationCommand(minimalFix),
        affectedAgents: toAffectedAgents(diagnostic.agentId),
        affectedRegions: [],
        commandId: diagnostic.commandId,
        evidenceFile: 'events.jsonl'
    };
}

function computeRunStateFailure(distributedRun: ControlDistributedRunSnapshot): DistributedRunFailureAnalysis {
    const state = distributedRun.state;
    return {
        category: TERMINAL_FAILURE_STATES.has(state) ? 'runtime' : UNCLASSIFIED_CATEGORY,
        title: `Distributed run ended with state ${state}.`,
        likelyCause: 'The distributed run did not pass, but no specific failure evidence was exported.',
        nextAction: 'Refresh the control server artifacts with larger bounds and inspect the raw run snapshot.',
        minimalFixArea: 'artifact coverage',
        verificationCommand: resolveVerificationCommand('artifact coverage'),
        affectedAgents: [],
        affectedRegions: [],
        evidenceFile: 'distributed-run.json'
    };
}

function recordsFailedResult(result: DistributedRunResultEvidence): boolean {
    return result.status?.toUpperCase() === 'FAILURE' || result.ok === false;
}
