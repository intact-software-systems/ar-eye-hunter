import type { V1dGrowthOutcome } from './v1d-growth-assessment.ts';
import { toV1dGrowthMinutes } from './v1d-growth-series.ts';
import type { V1dGrowthVerdict, V1dGrowthVerdictRow } from './v1d-growth-verdict.ts';

export interface V1dGrowthVerdictDocumentInput {
    readonly verdict: V1dGrowthVerdict;
    readonly skippedLines: number;
}

const OUTCOMES: readonly V1dGrowthOutcome[] = [
    'pass',
    'declared',
    'fail',
    'insufficient',
    'no-data',
    'unclassified',
    'unbounded-unexercised'
];
const MINUTE_MS = 60_000;

export function toV1dGrowthVerdictMarkdown(input: V1dGrowthVerdictDocumentInput): string {
    const { verdict } = input;
    const counts = OUTCOMES.map((outcome) =>
        `${verdict.rows.filter((row) => row.outcome === outcome).length} ${outcome}`
    );
    return [
        '# V1d growth verdict',
        '',
        `**${verdict.passed ? 'PASS' : 'FAIL'}**: ${verdict.rows.length} readings: ${counts.join(', ')}. ` +
        `Sample lines skipped: ${input.skippedLines}.`,
        '',
        toWorkloadLine(verdict),
        ...verdict.workloadIssues.map((issue) => `- ${issue}`),
        '',
        'The slope is the last 15 minutes; everything after the 10-minute warm-up for a heap reading, of its 5-minute ' +
        'bucket medians for a page heap, whose max is its raw peak and not judged; the whole run for ' +
        'a durable, declared or unbounded reading. A declared reading is an append-only history R3 declares: reported, ' +
        'not judged. The RTC workload orders few ALM tracks, so the delivered-marker readings do not stress their caps.',
        ...(verdict.followUps.length === 0
            ? []
            : [
                '',
                '## Follow-ups: unbounded surfaces the workload never grew',
                '',
                ...verdict.followUps.map((followUp) => `- ${toCell(followUp)}`)
            ]),
        '',
        '| # | surface | reader | class | first plateau | slope per hour | max | bound | verdict |',
        '| -: | --- | --- | --- | --- | --: | --: | --- | --- |',
        ...verdict.rows.map(toTableRow),
        '',
        '## Reasons',
        '',
        ...verdict.rows
            .filter((row) => row.outcome !== 'pass' && row.outcome !== 'unbounded-unexercised')
            .map((row) => `- ${row.surfaceId ?? '-'} ${toCell(row.surface)} (${row.reader}): ${row.reason}`),
        ''
    ].join('\n');
}

function toWorkloadLine(verdict: V1dGrowthVerdict): string {
    const workload = verdict.workload;
    if (workload === null) {
        return 'Workload: not recorded.';
    }
    const toOffset = (atEpochMs: number) => toV1dGrowthMinutes(atEpochMs - verdict.windowStartedAtEpochMs);
    const completed = workload.manifestCompletedAtEpochMs === null
        ? 'past the window\'s end'
        : `${toOffset(workload.manifestCompletedAtEpochMs)} min of the window`;
    const manifest = workload.manifestStartedAtEpochMs === null
        ? 'the manifest never started'
        : `the manifest ran from ${toOffset(workload.manifestStartedAtEpochMs)} min to ${completed} ` +
            '(its stream runs inside it)';
    return `Workload: ${manifest}; runner ${workload.runner}; churn ${workload.churnPassed} passed, ` +
        `${workload.churnFailedRunIds.length} failed.`;
}

function toTableRow(row: V1dGrowthVerdictRow): string {
    const cells = [
        row.surfaceId === null ? '-' : String(row.surfaceId),
        row.surface,
        row.reader,
        row.growthClass,
        row.firstPlateau === null
            ? '-'
            : `${toRounded(row.firstPlateau.atElapsedMs / MINUTE_MS)} min: ${toRounded(row.firstPlateau.value)}`,
        row.slopePerHour === null ? '-' : String(toRounded(row.slopePerHour)),
        row.max === null ? '-' : String(toRounded(row.max)),
        row.bound,
        row.outcome
    ];
    return `| ${cells.map(toCell).join(' | ')} |`;
}

function toCell(text: string): string {
    return text.replaceAll('|', '\\|');
}

function toRounded(value: number): number {
    return Math.round(value * 100) / 100;
}
