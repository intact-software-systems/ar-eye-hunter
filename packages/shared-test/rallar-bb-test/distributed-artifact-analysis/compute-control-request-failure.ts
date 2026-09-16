import type {
    DistributedRunControlRequestFailureAnalysis,
    DistributedRunFailureAnalysis
} from '../distributed-artifact-analysis.ts';
import { resolveMinimalFixArea, resolveVerificationCommand } from './distributed-run-failure-vocabulary.ts';
import type {
    ControlPostFailureArtifact,
    DistributedRunControlRequestFailureContent
} from './to-distributed-run-artifact-content.ts';

type ControlRequestFailureFacts = Omit<
    DistributedRunControlRequestFailureAnalysis,
    'summaryMarkdown' | 'fixProposalMarkdown'
>;

export function computeControlRequestFailureAnalysis(
    content: DistributedRunControlRequestFailureContent,
    generatedAtEpochMs: number
): DistributedRunControlRequestFailureAnalysis {
    const { controlPostFailure } = content;
    const facts = {
        generatedAtEpochMs,
        ...(content.runnerSummary === undefined ? {} : { runnerSummary: content.runnerSummary }),
        ok: false as const,
        request: controlPostFailure.request,
        ...(controlPostFailure.response === undefined ? {} : { responseBody: controlPostFailure.response.text }),
        parseWarnings: content.parseWarnings,
        failure: computeControlRequestFailure(controlPostFailure)
    };
    return {
        ...facts,
        summaryMarkdown: toControlRequestFailureSummaryMarkdown(facts),
        fixProposalMarkdown: toControlRequestFailureFixProposalMarkdown(facts)
    };
}

export function computeControlRequestFailure(failure: ControlPostFailureArtifact): DistributedRunFailureAnalysis {
    const { request } = failure;
    const message = toControlRequestFailureMessage(failure);
    const status = request.httpStatus ? ` HTTP ${request.httpStatus}` : '';
    const minimalFix = resolveMinimalFixArea({
        category: 'control-api',
        text: `${request.phase} ${request.path} ${message}`
    });
    const evidenceFile = failure.response?.fileName ?? 'control-post-error-metadata.json';
    return {
        category: 'control-api',
        title: `Control API ${request.phase} request failed.`,
        likelyCause: message,
        nextAction: `Inspect ${evidenceFile}; ${request.method} ${request.path} returned${
            status || ' a failure'
        } before the distributed run could continue.`,
        minimalFixArea: minimalFix,
        verificationCommand: resolveVerificationCommand(minimalFix),
        affectedAgents: [],
        affectedRegions: [],
        evidenceFile
    };
}

function toControlRequestFailureMessage(failure: ControlPostFailureArtifact): string {
    if (failure.response?.message !== undefined) {
        return failure.response.message;
    }
    const { request } = failure;
    const details = [
        request.httpStatus ? `HTTP ${request.httpStatus}` : undefined,
        request.curlStatus !== undefined ? `curl ${request.curlStatus}` : undefined,
        `exit ${request.exitStatus}`
    ].filter((value): value is string => value !== undefined);
    return `Control API request failed without a response body (${details.join(', ')}).`;
}

function toControlRequestFailureSummaryMarkdown(facts: ControlRequestFailureFacts): string {
    const { request, runnerSummary } = facts;
    return [
        `# Control Request Failure: ${runnerSummary?.distributedRunId ?? 'unnamed distributed run'}`,
        '',
        'Result: failed',
        runnerSummary ? `Control run: ${runnerSummary.controlRunId}` : undefined,
        runnerSummary ? `Runner state: ${runnerSummary.state}` : undefined,
        `Request: ${request.method} ${request.path} (${request.phase})`,
        request.httpStatus ? `HTTP status: ${request.httpStatus}` : undefined,
        request.curlStatus !== undefined ? `curl exit: ${request.curlStatus}` : undefined,
        `Runner exit: ${request.exitStatus}`,
        `Response body: ${request.responseFile ?? 'none'}`,
        `Error: ${facts.failure.likelyCause}`,
        `Artifact warnings: ${facts.parseWarnings.length}`,
        ''
    ].filter((line): line is string => line !== undefined).join('\n');
}

function toControlRequestFailureFixProposalMarkdown(facts: ControlRequestFailureFacts): string {
    const failure = facts.failure;
    return [
        `# Fix Proposal: ${facts.runnerSummary?.distributedRunId ?? 'unnamed distributed run'}`,
        '',
        `Title: ${failure.title}`,
        `Category: ${failure.category}`,
        `Likely cause: ${failure.likelyCause}`,
        `Next action: ${failure.nextAction}`,
        `Minimal fix area: ${failure.minimalFixArea}`,
        `Evidence: ${failure.evidenceFile}`,
        '',
        'Suggested verification:',
        failure.verificationCommand,
        ''
    ].join('\n');
}
