import type {
    DistributedRunControlRequestFailureAnalysis,
    DistributedRunFailureAnalysis
} from '../distributed-artifact-analysis.ts';
import type { DistributedRunControlPostRequest } from './decode-control-post-request.ts';
import { resolveMinimalFixArea, resolveVerificationCommand } from './distributed-run-failure-vocabulary.ts';
import type {
    ControlPostFailureArtifact,
    ControlPostFailureResponse,
    DistributedRunControlRequestFailureContent
} from './to-distributed-run-artifact-content.ts';

type ControlRequestFailureFacts = Omit<
    DistributedRunControlRequestFailureAnalysis,
    'summaryMarkdown' | 'fixProposalMarkdown'
>;

/** Enough of a proxy error page or error document to recognise it without flooding the step summary. */
const RESPONSE_BODY_EXCERPT_CHARACTERS = 500;

export function computeControlRequestFailureAnalysis(
    content: DistributedRunControlRequestFailureContent,
    generatedAtEpochMs: number
): DistributedRunControlRequestFailureAnalysis {
    const { controlPostFailure, runnerSummary } = content;
    const { response } = controlPostFailure;
    const distributedRunId = runnerSummary?.distributedRunId ?? content.manifestDistributedRunId;
    const facts = {
        generatedAtEpochMs,
        ...(distributedRunId === undefined ? {} : { distributedRunId }),
        ...(runnerSummary === undefined ? {} : { runnerSummary }),
        ok: false as const,
        request: controlPostFailure.request,
        ...(response.kind === 'json' || response.kind === 'text' ? { responseBody: response.text } : {}),
        parseWarnings: content.parseWarnings,
        failure: computeControlRequestFailure(controlPostFailure)
    };
    return {
        ...facts,
        summaryMarkdown: toControlRequestFailureSummaryMarkdown(facts, response),
        fixProposalMarkdown: toControlRequestFailureFixProposalMarkdown(facts, response)
    };
}

export function computeControlRequestFailure(failure: ControlPostFailureArtifact): DistributedRunFailureAnalysis {
    const { request, response } = failure;
    const message = toControlRequestFailureMessage(failure);
    const status = request.httpStatus ? ` HTTP ${request.httpStatus}` : '';
    const minimalFix = resolveMinimalFixArea({
        category: 'control-api',
        text: `${request.phase} ${request.path} ${message}`
    });
    const evidenceFile = response.kind === 'json' || response.kind === 'text'
        ? response.fileName
        : 'control-post-error-metadata.json';
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
    const { request, response } = failure;
    const outcome = toRequestOutcome(request);
    switch (response.kind) {
        case 'none':
            return `Control API request failed without a response body (${outcome}).`;
        case 'missing-file':
            return `Control API request failed; its response body ${response.fileName} is not among the artifact files (${outcome}).`;
        case 'text':
            return `Control API request failed with a response body that is not JSON (${outcome}).`;
        case 'json':
            return response.message ??
                `Control API request failed; its JSON response body names no error message (${outcome}).`;
    }
}

function toRequestOutcome(request: DistributedRunControlPostRequest): string {
    return [
        request.httpStatus ? `HTTP ${request.httpStatus}` : undefined,
        request.curlStatus !== undefined ? `curl ${request.curlStatus}` : undefined,
        `exit ${request.exitStatus}`
    ].filter((value): value is string => value !== undefined).join(', ');
}

function toControlRequestFailureSummaryMarkdown(
    facts: ControlRequestFailureFacts,
    response: ControlPostFailureResponse
): string {
    const { request, runnerSummary } = facts;
    return toMarkdown([
        toHeading('Control Request Failure', facts.distributedRunId),
        '',
        'Result: failed',
        runnerSummary ? `Control run: ${runnerSummary.controlRunId}` : undefined,
        runnerSummary ? `Runner state: ${runnerSummary.state}` : undefined,
        `Request: ${request.method} ${request.path} (${request.phase})`,
        request.httpStatus ? `HTTP status: ${request.httpStatus}` : undefined,
        request.curlStatus !== undefined ? `curl exit: ${request.curlStatus}` : undefined,
        `Runner exit: ${request.exitStatus}`,
        `Response body: ${toResponseBodyLabel(response)}`,
        `Error: ${facts.failure.likelyCause}`,
        `Artifact warnings: ${facts.parseWarnings.length}`,
        ...toResponseBodyExcerptLines(response),
        ''
    ]);
}

function toControlRequestFailureFixProposalMarkdown(
    facts: ControlRequestFailureFacts,
    response: ControlPostFailureResponse
): string {
    const failure = facts.failure;
    return toMarkdown([
        toHeading('Fix Proposal', facts.distributedRunId),
        '',
        `Title: ${failure.title}`,
        `Category: ${failure.category}`,
        `Likely cause: ${failure.likelyCause}`,
        `Next action: ${failure.nextAction}`,
        `Minimal fix area: ${failure.minimalFixArea}`,
        `Evidence: ${failure.evidenceFile}`,
        ...toResponseBodyExcerptLines(response),
        '',
        'Suggested verification:',
        failure.verificationCommand,
        ''
    ]);
}

function toHeading(title: string, distributedRunId: string | undefined): string {
    return distributedRunId === undefined ? `# ${title}` : `# ${title}: ${distributedRunId}`;
}

function toResponseBodyLabel(response: ControlPostFailureResponse): string {
    switch (response.kind) {
        case 'none':
            return 'none';
        case 'missing-file':
            return `${response.fileName} (not among the artifact files)`;
        case 'json':
        case 'text':
            return response.fileName;
    }
}

/** The fence is longer than any backtick run in the excerpt, so the body cannot close it. */
function toResponseBodyExcerptLines(response: ControlPostFailureResponse): readonly string[] {
    if (response.kind !== 'json' && response.kind !== 'text') {
        return [];
    }
    const characters = Array.from(response.text);
    const excerpt = characters.slice(0, RESPONSE_BODY_EXCERPT_CHARACTERS).join('');
    const heading = characters.length > RESPONSE_BODY_EXCERPT_CHARACTERS
        ? `Response body excerpt (first ${RESPONSE_BODY_EXCERPT_CHARACTERS} of ${characters.length} characters):`
        : 'Response body excerpt:';
    const longestBacktickRun = Math.max(0, ...(excerpt.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
    return ['', heading, '', `${fence}text`, excerpt, fence];
}

function toMarkdown(lines: readonly (string | undefined)[]): string {
    return lines.filter((line): line is string => line !== undefined).join('\n');
}
