import type { V1dGrowthOutcome } from './compute-v1d-growth-assessment.ts';
import type { V1dGrowthVerdict, V1dGrowthVerdictRow } from './v1d-growth-verdict.ts';

export interface V1dGrowthVerdictDocumentInput {
    readonly verdict: V1dGrowthVerdict;
    readonly skippedLines: number;
}

const OUTCOMES: readonly V1dGrowthOutcome[] = ['pass', 'fail', 'insufficient', 'no-data', 'unclassified'];
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
        'The slope is the last 15 minutes, or everything after the 10-minute warm-up for a heap reading.',
        '',
        '| # | surface | reader | class | first plateau | slope per hour | max | bound | verdict |',
        '| -: | --- | --- | --- | --- | --: | --: | --- | --- |',
        ...verdict.rows.map(toTableRow),
        '',
        '## Reasons',
        '',
        ...verdict.rows
            .filter((row) => row.outcome !== 'pass')
            .map((row) => `- ${row.surfaceId ?? '-'} ${toCell(row.surface)} (${row.reader}): ${row.reason}`),
        ''
    ].join('\n');
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
