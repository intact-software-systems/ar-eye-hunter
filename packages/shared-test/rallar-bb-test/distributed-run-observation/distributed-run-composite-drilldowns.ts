import { RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH } from '../composite-result-paths.ts';
import {
    computeRallarBlackBoxCompositeResultSummary,
    decodeRallarBlackBoxTestResult,
    type RallarBlackBoxCompositeResultSummary
} from '../composite-results.ts';
import type { ControlDistributedRunCommandLink, ControlRunSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import {
    toDistributedRunCompositeChildDecodeIssues,
    toDistributedRunCompositeGroupSummaries,
    toDistributedRunCompositeRows
} from './distributed-run-composite-rows.ts';
import type {
    DistributedRunCompositeChildDecodeIssueRow,
    DistributedRunCompositeCounts,
    DistributedRunCompositeDrilldown,
    DistributedRunCompositeRow,
    DistributedRunFailureRow
} from './distributed-run-row-contracts.ts';

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];

interface DistributedRunCompositeRoots {
    readonly roots: readonly RallarBlackBoxTestResult[];
    readonly rootDecodeIssues: readonly DistributedRunCompositeChildDecodeIssueRow[];
}

const COMPOSITE_CHILD_UNDECODABLE_CODE = 'RALLAR_BLACK_BOX_COMPOSITE_CHILD_UNDECODABLE';
const NO_COMPOSITE_ROOTS: DistributedRunCompositeRoots = { roots: [], rootDecodeIssues: [] };

export function toDistributedRunCompositeDrilldowns(
    results: readonly ControlResultSnapshot[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>,
    linksByCommandId: ReadonlyMap<string, ControlDistributedRunCommandLink>
): readonly DistributedRunCompositeDrilldown[] {
    return results.flatMap((result) => {
        const { roots, rootDecodeIssues } = toDistributedRunCompositeRoots(result.result);
        const rows = toDistributedRunCompositeRows(roots);
        if (rows.length === 0 && rootDecodeIssues.length === 0) {
            return [];
        }

        const link = linksByCommandId.get(result.commandId);
        const command = commands.get(result.commandId);
        return [{
            key: `${result.agentId}:${result.commandId}`,
            commandId: result.commandId,
            agentId: result.agentId,
            recipeId: link?.recipeId ?? resolveCommandRecipeId(command),
            role: link?.role,
            phase: link?.phase,
            commandKind: command?.envelope.command.kind ?? result.result?.kind,
            artifactRef: `control-run.json#results[commandId=${result.commandId}]`,
            summary: toDrilldownSummary(computeRallarBlackBoxCompositeResultSummary(roots, {})),
            firstFailure: resolveFirstFailedRow(rows),
            groupSummaries: toDistributedRunCompositeGroupSummaries(roots),
            childDecodeIssues: [...rootDecodeIssues, ...toDistributedRunCompositeChildDecodeIssues(roots)],
            rows
        }];
    });
}

export function computeDistributedRunCompositeCounts(
    drilldowns: readonly DistributedRunCompositeDrilldown[]
): DistributedRunCompositeCounts {
    return {
        total: drilldowns.length,
        passed: drilldowns.filter((drilldown) => drilldown.summary.failed === 0).length,
        failed: drilldowns.filter((drilldown) => drilldown.summary.failed > 0).length,
        childResults: drilldowns.reduce((sum, drilldown) => sum + drilldown.summary.total, 0),
        composite: drilldowns.reduce((sum, drilldown) => sum + drilldown.summary.composite, 0),
        leaf: drilldowns.reduce((sum, drilldown) => sum + drilldown.summary.leaf, 0)
    };
}

/** Each drilldown reports its first failure and every recorded child that does not decode. */
export function toDistributedRunCompositeFailures(
    drilldowns: readonly DistributedRunCompositeDrilldown[]
): readonly DistributedRunFailureRow[] {
    return drilldowns.flatMap((drilldown) => [
        ...(drilldown.firstFailure ? [toFirstFailureRow(drilldown, drilldown.firstFailure)] : []),
        ...drilldown.childDecodeIssues.map((issue) => toChildDecodeIssueFailureRow(drilldown, issue))
    ]);
}

function toFirstFailureRow(
    drilldown: DistributedRunCompositeDrilldown,
    firstFailure: DistributedRunCompositeRow
): DistributedRunFailureRow {
    return {
        kind: 'command',
        key: `${drilldown.commandId}:${firstFailure.path}`,
        commandId: firstFailure.commandId,
        agentId: drilldown.agentId,
        recipeId: drilldown.recipeId,
        code: firstFailure.errorSummary ? undefined : firstFailure.status,
        message: firstFailure.errorSummary ?? `${firstFailure.kind} ${firstFailure.status} at ${firstFailure.path}.`,
        atEpochMs: firstFailure.endedAtEpochMs
    };
}

function toChildDecodeIssueFailureRow(
    drilldown: DistributedRunCompositeDrilldown,
    issue: DistributedRunCompositeChildDecodeIssueRow
): DistributedRunFailureRow {
    return {
        kind: 'command',
        key: `${drilldown.commandId}:${issue.parentPath}:${issue.valuePath}`,
        commandId: issue.parentCommandId,
        agentId: drilldown.agentId,
        recipeId: drilldown.recipeId,
        code: COMPOSITE_CHILD_UNDECODABLE_CODE,
        message: `Composite result ${issue.parentPath} records ${issue.valuePath} that does not decode ` +
            `(invalid ${issue.invalidFields.join(', ')}); it is not shown.`,
        atEpochMs: issue.parentEndedAtEpochMs
    };
}

/** The recorded results a drilldown walks, and every recipe.run result item that does not decode as a result. */
function toDistributedRunCompositeRoots(result: RallarBlackBoxTestResult | undefined): DistributedRunCompositeRoots {
    if (!result) {
        return NO_COMPOSITE_ROOTS;
    }

    const recipeRun = toRecipeRunChildResults(result);
    if (recipeRun.roots.length > 0 || recipeRun.rootDecodeIssues.length > 0) {
        return {
            roots: recipeRun.roots.some(isCompositeMonitorRelevantResult) ? recipeRun.roots : [],
            rootDecodeIssues: recipeRun.rootDecodeIssues
        };
    }

    return { roots: isCompositeMonitorRelevantResult(result) ? [result] : [], rootDecodeIssues: [] };
}

function isCompositeMonitorRelevantResult(result: RallarBlackBoxTestResult): boolean {
    if (
        result.kind === 'loop' ||
        result.kind === 'parallel' ||
        result.kind === 'wait' ||
        result.kind === 'assert'
    ) {
        return true;
    }
    return toRecipeRunChildResults(result).roots.some(isCompositeMonitorRelevantResult);
}

function toRecipeRunChildResults(result: RallarBlackBoxTestResult): DistributedRunCompositeRoots {
    const recorded = result.kind === 'recipe.run' ? decodeRecord(result.value).results : undefined;
    if (!Array.isArray(recorded)) {
        return NO_COMPOSITE_ROOTS;
    }
    const decoded = recorded.map((item) => decodeRallarBlackBoxTestResult(item));
    return {
        roots: decoded.flatMap((root) => root.right === undefined ? [] : [root.right]),
        rootDecodeIssues: decoded.flatMap((root, index) =>
            root.left === undefined ? [] : [{
                parentPath: RALLAR_BLACK_BOX_COMPOSITE_RESULT_ROOT_PATH,
                parentCommandId: result.commandId,
                parentEndedAtEpochMs: result.endedAtEpochMs,
                valuePath: `value.results[${index}]`,
                invalidFields: root.left
            }]
        )
    };
}

function toDrilldownSummary(
    summary: RallarBlackBoxCompositeResultSummary
): DistributedRunCompositeDrilldown['summary'] {
    return {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        cancelled: summary.cancelled,
        skipped: summary.skipped,
        composite: summary.composite,
        leaf: summary.leaf
    };
}

/** The earliest failed child, or else the earliest failed row. */
function resolveFirstFailedRow(rows: readonly DistributedRunCompositeRow[]): DistributedRunCompositeRow | undefined {
    const failedRows = rows
        .filter((row) => !row.ok)
        .sort((left, right) =>
            left.startedAtEpochMs - right.startedAtEpochMs ||
            left.endedAtEpochMs - right.endedAtEpochMs ||
            left.path.localeCompare(right.path)
        );
    return failedRows.find((row) => row.depth > 0) ?? failedRows[0];
}

export function resolveCommandRecipeId(command: ControlCommandSnapshot | undefined): string | undefined {
    if (!command) {
        return undefined;
    }
    return command.envelope.command.kind === 'recipe.run' || command.envelope.command.kind === 'recipe.load'
        ? command.envelope.command.recipe?.recipeId
        : undefined;
}
