import {
    createRtcBaselineCliIssue as issue,
    parseRtcBaselineBoundedInteger,
    parseRtcBaselineCommandOptions
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
        'output'
    ],
    'verify-observation': ['archive', 'index-entry']
} as const;
const required = allowed;

export type RtcPerformanceObservationParsedCommand =
    | {
        readonly kind: 'observe-browser' | 'observe-live-rtc';
        readonly sourceRef: 'main';
        readonly githubRunId: number;
        readonly githubRunAttempt: number;
        readonly githubRunUrl: string;
        readonly outputDirectory: string;
    }
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
    if (name === 'verify-observation') {
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
                    kind: name,
                    archivePath: options.archive!,
                    indexEntryPath: options['index-entry']!
                }
            };
    }
    if (options['source-ref'] !== undefined && options['source-ref'] !== 'main') {
        issues.push(
            issue('$.source-ref', 'unsupported-source-ref', 'Observation source ref must be main.')
        );
    }
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
    if (
        runId.ok &&
        options['github-run-url'] !== undefined &&
        !validWorkflowUrl(options['github-run-url'], runId.value)
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
                outputDirectory: options.output!
            }
        };
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
