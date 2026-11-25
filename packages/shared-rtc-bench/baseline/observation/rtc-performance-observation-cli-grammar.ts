import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    createRtcBaselineCliIssue,
    parseRtcBaselineBoundedInteger,
    parseRtcBaselineCommandOptions,
    type RtcBaselineCliIssue,
    type RtcBaselineCliOptions
} from '../command/rtc-baseline-cli-options.ts';
import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';

export type RtcPerformanceObservationParsedCommand =
    | ({ readonly kind: 'observe-browser'; } & RtcPerformanceObservationCommandInput)
    | (
        & {
            readonly kind: 'observe-live-rtc';
            readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
            readonly jobBudgetSeconds?: number;
        }
        & RtcPerformanceObservationCommandInput
    )
    | ({
        readonly kind: 'capture-live-rtc';
        readonly environmentId: 'E3-memory' | 'E4-pg';
        readonly sourceRef: string;
        readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
        readonly jobBudgetSeconds?: number;
    } & Omit<RtcPerformanceObservationCommandInput, 'sourceRef'>)
    | {
        readonly kind: 'verify-observation';
        readonly archivePath: string;
        readonly indexEntryPath: string;
    };

const allowed = {
    'observe-browser': [
        'source-ref',
        'github-run-id',
        'github-run-attempt',
        'github-run-url',
        'output'
    ],
    'observe-live-rtc': [
        'source-ref',
        'github-run-id',
        'github-run-attempt',
        'github-run-url',
        'output',
        'rtc-capture-mode',
        'job-budget-seconds'
    ],
    'capture-live-rtc': [
        'environment',
        'source-ref',
        'github-run-id',
        'github-run-attempt',
        'github-run-url',
        'output',
        'rtc-capture-mode',
        'job-budget-seconds'
    ],
    'verify-observation': ['archive', 'index-entry']
} as const;

const required = {
    ...allowed,
    'observe-live-rtc': allowed['observe-browser'],
    'capture-live-rtc': allowed['observe-browser']
};

/** A capture that names no environment captures in E3-memory. */
const DEFAULT_CAPTURE_ENVIRONMENT_ID = 'E3-memory';

interface RtcPerformanceObservationCommandInput {
    readonly sourceRef: 'main';
    readonly githubRunId: number;
    readonly githubRunAttempt: number;
    readonly githubRunUrl: string;
    readonly outputDirectory: string;
}

/** A run command's inputs once parsed, before its source ref is resolved. */
interface RtcPerformanceObservationNormalizedInput extends Omit<RtcPerformanceObservationCommandInput, 'sourceRef'> {
    readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode;
    readonly jobBudgetSeconds?: number;
}

export function isRtcPerformanceObservationCommand(command: string | undefined) {
    return command === 'observe-browser' ||
        command === 'observe-live-rtc' ||
        command === 'capture-live-rtc' ||
        command === 'verify-observation';
}

export function parseRtcPerformanceObservationCommand(
    args: readonly string[]
): RtcBaselineResult<RtcPerformanceObservationParsedCommand> {
    const command = args[0];
    if (!isRtcPerformanceObservationCommand(command)) {
        return {
            ok: false,
            issues: [
                createRtcBaselineCliIssue(
                    '$.args[0]',
                    'unknown-observation-subcommand',
                    `Unknown RTC observation subcommand ${command ?? ''}.`
                )
            ]
        };
    }
    const name = command as keyof typeof allowed;
    const { options, issues } = parseRtcBaselineCommandOptions({
        command: name,
        args: args.slice(1),
        allowed,
        required
    });
    return name === 'verify-observation'
        ? parseVerificationPaths(options, issues)
        : parseObservationInputs(name, options, issues);
}

function parseVerificationPaths(
    options: RtcBaselineCliOptions,
    issues: RtcBaselineCliIssue[]
): RtcBaselineResult<RtcPerformanceObservationParsedCommand> {
    if (options.archive === '') {
        issues.push(createRtcBaselineCliIssue('$.archive', 'empty-path', 'Archive path must be nonempty.'));
    }
    if (options['index-entry'] === '') {
        issues.push(createRtcBaselineCliIssue('$.index-entry', 'empty-path', 'Index entry path must be nonempty.'));
    }
    return issues.length > 0
        ? { ok: false, issues }
        : {
            ok: true,
            value: {
                kind: 'verify-observation',
                archivePath: options.archive!,
                indexEntryPath: options['index-entry']!
            }
        };
}

type RtcPerformanceObservationRunCommand = 'observe-browser' | 'observe-live-rtc' | 'capture-live-rtc';

function parseObservationInputs(
    name: RtcPerformanceObservationRunCommand,
    options: RtcBaselineCliOptions,
    issues: RtcBaselineCliIssue[]
): RtcBaselineResult<RtcPerformanceObservationParsedCommand> {
    const runId = parsePositiveInteger(options['github-run-id'] ?? '', 'github-run-id');
    const runAttempt = parsePositiveInteger(options['github-run-attempt'] ?? '', 'github-run-attempt');
    for (const parsed of [runId, runAttempt]) {
        if (!parsed.ok) {
            issues.push(...parsed.issues);
        }
    }
    validateObservationSourceRef(name, options, issues);
    validateObservationOptions(options, runId.ok ? runId.value : undefined, issues);
    if (name === 'capture-live-rtc') {
        issues.push(...validateCaptureEnvironment(toCaptureEnvironmentId(options)));
    }
    const capture = parseRtcCaptureMode(name !== 'observe-browser' ? options['rtc-capture-mode'] : undefined);
    for (const captureIssue of capture.left ?? []) {
        issues.push(createRtcBaselineCliIssue('$.rtc-capture-mode', captureIssue.code, captureIssue.message));
    }
    const jobBudgetSeconds = parseJobBudgetSeconds(options, issues);
    if (issues.length > 0 || !runId.ok || !runAttempt.ok) {
        return { ok: false, issues };
    }
    return toParsedObservationCommand(name, options, {
        githubRunId: runId.value,
        githubRunAttempt: runAttempt.value,
        githubRunUrl: options['github-run-url']!,
        outputDirectory: options.output!,
        ...(name !== 'observe-browser' && capture.right?.mode !== undefined
            ? { rtcCaptureMode: capture.right.mode }
            : {}),
        ...(jobBudgetSeconds === undefined ? {} : { jobBudgetSeconds })
    });
}

/** An observation records main; a governed capture records the nonempty branch it was asked to. */
function validateObservationSourceRef(
    name: RtcPerformanceObservationRunCommand,
    options: RtcBaselineCliOptions,
    issues: RtcBaselineCliIssue[]
) {
    if (name !== 'capture-live-rtc' && options['source-ref'] !== undefined && options['source-ref'] !== 'main') {
        issues.push(
            createRtcBaselineCliIssue('$.source-ref', 'unsupported-source-ref', 'Observation source ref must be main.')
        );
    }
    if (name === 'capture-live-rtc' && options['source-ref']?.trim() === '') {
        issues.push(
            createRtcBaselineCliIssue('$.source-ref', 'empty-source-ref', 'Capture source ref must be nonempty.')
        );
    }
}

function toParsedObservationCommand(
    name: RtcPerformanceObservationRunCommand,
    options: RtcBaselineCliOptions,
    normalized: RtcPerformanceObservationNormalizedInput
): RtcBaselineResult<RtcPerformanceObservationParsedCommand> {
    return name === 'capture-live-rtc'
        ? {
            ok: true,
            value: {
                ...normalized,
                kind: name,
                sourceRef: options['source-ref']!,
                environmentId: toCaptureEnvironmentId(options) as 'E3-memory' | 'E4-pg'
            }
        }
        : { ok: true, value: { ...normalized, kind: name, sourceRef: 'main' } };
}

function validateObservationOptions(
    options: RtcBaselineCliOptions,
    runId: number | undefined,
    issues: RtcBaselineCliIssue[]
) {
    if (
        runId !== undefined &&
        options['github-run-url'] !== undefined &&
        !validWorkflowUrl(options['github-run-url'], runId)
    ) {
        issues.push(
            createRtcBaselineCliIssue(
                '$.github-run-url',
                'invalid-workflow-url',
                'Workflow URL must be the matching HTTPS GitHub Actions run.'
            )
        );
    }
    if (options.output === '') {
        issues.push(createRtcBaselineCliIssue('$.output', 'empty-path', 'Output directory must be nonempty.'));
    }
}

/** Absent, the capture has no job deadline and runs every declared attempt. */
function parseJobBudgetSeconds(options: RtcBaselineCliOptions, issues: RtcBaselineCliIssue[]): number | undefined {
    const value = options['job-budget-seconds'];
    if (value === undefined) {
        return undefined;
    }
    const parsed = parsePositiveInteger(value, 'job-budget-seconds');
    if (!parsed.ok) {
        issues.push(...parsed.issues);
        return undefined;
    }
    return parsed.value;
}

function parsePositiveInteger(value: string, name: string) {
    return parseRtcBaselineBoundedInteger(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function validWorkflowUrl(value: string, runId: number) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            url.hostname === 'github.com' &&
            url.username === '' &&
            url.password === '' &&
            url.search === '' &&
            url.hash === '' &&
            url.pathname.endsWith(`/actions/runs/${runId}`);
    }
    catch {
        return false;
    }
}

function toCaptureEnvironmentId(options: RtcBaselineCliOptions): string {
    return options.environment ?? DEFAULT_CAPTURE_ENVIRONMENT_ID;
}

function validateCaptureEnvironment(environmentId: string): RtcBaselineCliIssue[] {
    return environmentId === 'E3-memory' || environmentId === 'E4-pg' ? [] : [createRtcBaselineCliIssue(
        '$.environment',
        'unsupported-capture-environment',
        'Governed RTC capture environment must be E3-memory or E4-pg.'
    )];
}
