import type {
    AlmLaneCarrierStreak,
    AlmLaneKeyFailures,
    AlmLaneLedger,
    AlmLaneLeftOutRun,
    AlmLaneRedRun,
    AlmLaneSideRun
} from './compute-alm-lane-ledger.ts';
import type { AlmLaneWorkflowRunWindow } from './compute-alm-lane-workflow-runs.ts';

/** The streak a carrier needs before its lane may become required. */
const ALM_LANE_PROMOTION_STREAK = 10;

/** How many entries of one list (a red run's keys, the unattributed runs, the issues) print before the rest count. */
const ALM_LANE_PRINTED_LINES = 10;

const SHORT_COMMIT_LENGTH = 7;

export interface ToAlmLaneLedgerTextInput {
    readonly ledger: AlmLaneLedger;
    readonly window: AlmLaneWorkflowRunWindow;
    /** What could not be read: undecodable files, mismatched identities, carriers with no job, expired artifacts. */
    readonly issues: readonly string[];
}

/** Plain text for a fixed-width terminal; each section is separated by a blank line, and an empty one is one line. */
export function toAlmLaneLedgerText(input: ToAlmLaneLedgerTextInput): string {
    const { ledger } = input;
    const sections = [
        [toHeaderLine(input.window)],
        ['Streak of green main-push runs, per carrier:', ...ledger.carriers.flatMap(toCarrierLines)],
        toSection('Keys failed or not run in main-push runs', toKeyLines(ledger.keys)),
        toSection('Pull-request and dispatched runs', toSideRunLines(ledger.sideRuns)),
        toSection(
            'Jobs left out (running, skipped, or a cancelled pull-request job)',
            toLeftOutRunLines(ledger.leftOutRuns)
        ),
        toSection('Issues met while reading', toCappedLines(input.issues, '  '))
    ];
    return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

function toHeaderLine(window: AlmLaneWorkflowRunWindow): string {
    const { counts, newestPushCommitSha, oldestPushCommitSha } = window;
    const runs =
        `read ${counts.push} main push, ${counts.pullRequest} pull-request and ${counts.dispatch} dispatched runs`;
    if (newestPushCommitSha === null || oldestPushCommitSha === null) {
        return `ALM lane ledger: ${runs}; no main push run read.`;
    }
    const newest = toShortCommit(newestPushCommitSha);
    const oldest = toShortCommit(oldestPushCommitSha);
    return `ALM lane ledger: ${runs}; main push runs from ${newest} (newest) to ${oldest} (oldest).`;
}

function toCarrierLines(streak: AlmLaneCarrierStreak): readonly string[] {
    const runsRead = `${streak.runsRead} run${streak.runsRead === 1 ? '' : 's'} read`;
    const unattributed = streak.unattributed.map((run) =>
        `run ${run.runId} at ${toShortCommit(run.commitSha)}: ${run.reason}`
    );
    return [
        `${streak.carrier}: streak ${streak.streak}/${ALM_LANE_PROMOTION_STREAK} of ${runsRead}`,
        ...(streak.lastRed === null ? [] : toRedRunLines(streak.lastRed)),
        ...(unattributed.length === 0
            ? ['  red runs with nothing to attribute: none']
            : ['  red runs with nothing to attribute:', ...toCappedLines(unattributed, '    ')]),
        `  failures without a cause: ${streak.uncaused.length}`,
        ...toCappedLines(streak.uncaused, '    ')
    ];
}

function toRedRunLines(red: AlmLaneRedRun): readonly string[] {
    const facts = [
        `attempt ${red.attempt}`,
        `job ${red.jobConclusion}`,
        red.planRead ? 'plan read' : 'no plan read',
        ...(red.reason === null ? [] : [`nothing to attribute: ${red.reason}`])
    ];
    return [
        `  last red: run ${red.runId} at ${toShortCommit(red.commitSha)}, ${facts.join(', ')}`,
        ...toKeyListLines('failed', red.failed),
        ...toKeyListLines('not run', red.notRun)
    ];
}

function toKeyListLines(label: string, keys: readonly string[]): readonly string[] {
    if (keys.length === 0) {
        return [`    ${label}: none`];
    }
    return [`    ${label}:`, ...toCappedLines(keys, '      ')];
}

/** At most ten lines, then how many more there are. */
function toCappedLines(entries: readonly string[], indent: string): readonly string[] {
    const hidden = entries.length - ALM_LANE_PRINTED_LINES;
    return [
        ...entries.slice(0, ALM_LANE_PRINTED_LINES).map((entry) => `${indent}${entry}`),
        ...(hidden > 0 ? [`${indent}and ${hidden} more`] : [])
    ];
}

function toKeyLines(keys: readonly AlmLaneKeyFailures[]): readonly string[] {
    return toColumnLines([
        ['key', 'failed in', 'not run in', 'cause'],
        ...keys.map((failures) => [
            failures.key,
            toRunIdsText(failures.failedRunIds),
            toRunIdsText(failures.notRunRunIds),
            toCauseText(failures)
        ])
    ]);
}

/**
 * `open` while unfixed and the fixing pull request's number once fixed; for a key with no entry, `none` when it failed
 * (it needs a cause) and `-` when it only did not run (it never needs one).
 */
function toCauseText(failures: AlmLaneKeyFailures): string {
    if (failures.cause === null) {
        return failures.failedRunIds.length > 0 ? 'none' : '-';
    }
    return failures.cause.fixedByPullRequest === null ? 'open' : `#${failures.cause.fixedByPullRequest}`;
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
