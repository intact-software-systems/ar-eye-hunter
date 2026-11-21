import type {
    AlmLaneCarrierStreak,
    AlmLaneLedger,
    AlmLaneLeftOutRun,
    AlmLaneRedRun,
    AlmLaneScenarioFailures,
    AlmLaneSideRun
} from './compute-alm-lane-ledger.ts';

/** The streak a carrier needs before its lane may become required. */
const ALM_LANE_PROMOTION_STREAK = 10;

/** How many keys of one list a red run prints before it counts the rest. */
const ALM_LANE_PRINTED_KEYS = 10;

const SHORT_COMMIT_LENGTH = 7;

export interface ToAlmLaneLedgerTextInput {
    readonly ledger: AlmLaneLedger;
    /** The commit of each workflow run read, newest first. */
    readonly commitShas: readonly string[];
    /** What could not be read: undecodable files, mismatched identities. */
    readonly issues: readonly string[];
}

/** Plain text for a fixed-width terminal; each section is separated by a blank line, and an empty one is one line. */
export function toAlmLaneLedgerText(input: ToAlmLaneLedgerTextInput): string {
    const { ledger } = input;
    const sections = [
        [toHeaderLine(input.commitShas)],
        ['Streak of green main-push runs, per carrier:', ...ledger.carriers.flatMap(toCarrierLines)],
        toSection('Scenarios failed or not run in main-push runs', toScenarioLines(ledger.scenarios)),
        toSection(
            'Red main-push runs with nothing to attribute',
            ledger.unattributedRedRunIds.map((runId) => `  run ${runId}`)
        ),
        toSection('Pull-request and dispatched runs', toSideRunLines(ledger.sideRuns)),
        toSection(
            'Jobs left out (running, skipped, or a cancelled pull-request or dispatched job)',
            toLeftOutRunLines(ledger.leftOutRuns)
        ),
        toSection('Issues met while reading', input.issues.map((issue) => `  ${issue}`))
    ];
    return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

function toHeaderLine(commitShas: readonly string[]): string {
    const newest = commitShas[0];
    const oldest = commitShas.at(-1);
    const runs = `${commitShas.length} workflow run${commitShas.length === 1 ? '' : 's'} read`;
    if (newest === undefined || oldest === undefined) {
        return `ALM lane ledger: ${runs}.`;
    }
    return `ALM lane ledger: ${runs}, newest commit ${toShortCommit(newest)}, oldest commit ${toShortCommit(oldest)}.`;
}

function toCarrierLines(streak: AlmLaneCarrierStreak): readonly string[] {
    return [
        `${streak.carrier}: streak ${streak.streak}/${ALM_LANE_PROMOTION_STREAK}`,
        ...(streak.lastRed === null ? [] : toRedRunLines(streak.lastRed)),
        `  failures without a cause: ${streak.uncaused.length}`
    ];
}

function toRedRunLines(red: AlmLaneRedRun): readonly string[] {
    return [
        `  last red: run ${red.runId} at ${toShortCommit(red.commitSha)}`,
        ...toKeyListLines('failed', red.failed),
        ...toKeyListLines('not run', red.notRun)
    ];
}

function toKeyListLines(label: string, keys: readonly string[]): readonly string[] {
    if (keys.length === 0) {
        return [`    ${label}: none`];
    }
    const hidden = keys.length - ALM_LANE_PRINTED_KEYS;
    return [
        `    ${label}:`,
        ...keys.slice(0, ALM_LANE_PRINTED_KEYS).map((key) => `      ${key}`),
        ...(hidden > 0 ? [`      and ${hidden} more`] : [])
    ];
}

function toScenarioLines(scenarios: readonly AlmLaneScenarioFailures[]): readonly string[] {
    return toColumnLines([
        ['scenario', 'failed in', 'not run in', 'cause'],
        ...scenarios.map((failures) => [
            failures.scenario,
            toRunIdsText(failures.failedRunIds),
            toRunIdsText(failures.notRunRunIds),
            failures.hasCause ? 'yes' : 'no'
        ])
    ]);
}

function toSideRunLines(sideRuns: readonly AlmLaneSideRun[]): readonly string[] {
    return toColumnLines([
        ['run', 'event', 'carrier', 'result'],
        ...sideRuns.map((run) => [String(run.runId), run.event, run.carrier, run.green ? 'green' : 'red'])
    ]);
}

function toLeftOutRunLines(leftOutRuns: readonly AlmLaneLeftOutRun[]): readonly string[] {
    return toColumnLines([
        ['run', 'event', 'carrier', 'job'],
        ...leftOutRuns.map((run) => [String(run.runId), run.event, run.carrier, run.jobConclusion])
    ]);
}

/** A titled list of lines, or one line saying the list is empty. */
function toSection(title: string, lines: readonly string[]): readonly string[] {
    return lines.length === 0 ? [`${title}: none.`] : [`${title}:`, ...lines];
}

/** Rows under a heading row, each column as wide as its widest cell; no lines when there is no row below the heading. */
function toColumnLines(rows: readonly (readonly string[])[]): readonly string[] {
    if (rows.length < 2) {
        return [];
    }
    const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
    return rows.map((row) => `  ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ')}`.trimEnd());
}

function toRunIdsText(runIds: readonly number[]): string {
    return runIds.length === 0 ? '-' : runIds.join(', ');
}

function toShortCommit(commitSha: string): string {
    return commitSha.slice(0, SHORT_COMMIT_LENGTH);
}
