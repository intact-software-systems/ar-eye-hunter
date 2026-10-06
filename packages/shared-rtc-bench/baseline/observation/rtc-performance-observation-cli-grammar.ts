import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import {
    createRtcBaselineCliIssue as issue,
    parseRtcBaselineBoundedInteger,
    parseRtcBaselineCommandOptions,
    type RtcBaselineCliIssue,
    type RtcBaselineCliOptions
} from '../command/rtc-baseline-cli-options.ts';
import type { RtcBaselineResult } from '../contracts/rtc-baseline-contracts.ts';

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
        'rtc-capture-mode'
    ],
    'verify-observation': ['archive', 'index-entry']
} as const;
const required = { ...allowed, 'observe-live-rtc': allowed['observe-browser'] };

interface RtcPerformanceObservationCommandInput {
    readonly sourceRef: 'main';
    readonly githubRunId: number;
    readonly githubRunAttempt: number;
    readonly githubRunUrl: string;
    readonly outputDirectory: string;
}

export type RtcPerformanceObservationParsedCommand =
    | ({ readonly kind: 'observe-browser'; } & RtcPerformanceObservationCommandInput)
    | (
        & { readonly kind: 'observe-live-rtc'; readonly rtcCaptureMode?: RtcSignalingDiagnostics.CaptureMode; }
        & RtcPerformanceObservationCommandInput
    )
    | {
        readonly kind: 'verify-observation';
        readonly archivePath: string;
        readonly indexEntryPath: string;
    };

export function isRtcPerformanceObservationCommand(command: string | undefined) {
    return command === 'observe-browser' ||
        command === 'observe-live-rtc' ||
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
                issue(
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
        issues.push(issue('$.archive', 'empty-path', 'Archive path must be nonempty.'));
    }
    if (options['index-entry'] === '') {
        issues.push(issue('$.index-entry', 'empty-path', 'Index entry path must be nonempty.'));
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

function parseObservationInputs(
    name: 'observe-browser' | 'observe-live-rtc',
    options: RtcBaselineCliOptions,
    issues: RtcBaselineCliIssue[]
): RtcBaselineResult<RtcPerformanceObservationParsedCommand> {
    const runId = parsePositiveInteger(options['github-run-id'] ?? '', 'github-run-id');
    const runAttempt = parsePositiveInteger(
        options['github-run-attempt'] ?? '',
        'github-run-attempt'
    );
    if (!runId.ok) {
        issues.push(...runId.issues);
    }
    if (!runAttempt.ok) {
        issues.push(...runAttempt.issues);
    }
    validateObservationOptions(options, runId.ok ? runId.value : undefined, issues);
    const capture = parseRtcCaptureMode(name === 'observe-live-rtc' ? options['rtc-capture-mode'] : undefined);
    for (const captureIssue of capture.left ?? []) {
        issues.push(issue('$.rtc-capture-mode', captureIssue.code, captureIssue.message));
    }
    return issues.length > 0 || !runId.ok || !runAttempt.ok
        ? { ok: false, issues }
        : {
            ok: true,
            value: {
                kind: name,
                sourceRef: 'main',
                githubRunId: runId.value,
                githubRunAttempt: runAttempt.value,
                githubRunUrl: options['github-run-url']!,
                outputDirectory: options.output!,
                ...(name === 'observe-live-rtc' && capture.right?.mode !== undefined
                    ? { rtcCaptureMode: capture.right.mode }
                    : {})
            }
        };
}

function validateObservationOptions(
    options: RtcBaselineCliOptions,
    runId: number | undefined,
    issues: RtcBaselineCliIssue[]
) {
    if (options['source-ref'] !== undefined && options['source-ref'] !== 'main') {
        issues.push(
            issue('$.source-ref', 'unsupported-source-ref', 'Observation source ref must be main.')
        );
    }
    if (
        runId !== undefined &&
        options['github-run-url'] !== undefined &&
        !validWorkflowUrl(options['github-run-url'], runId)
    ) {
        issues.push(
            issue(
                '$.github-run-url',
                'invalid-workflow-url',
                'Workflow URL must be the matching HTTPS GitHub Actions run.'
            )
        );
    }
    if (options.output === '') {
        issues.push(issue('$.output', 'empty-path', 'Output directory must be nonempty.'));
    }
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
