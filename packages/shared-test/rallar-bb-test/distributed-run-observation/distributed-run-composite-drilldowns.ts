import { computeRallarBlackBoxCompositeResultSummary } from '../composite-results.ts';
import type { ControlDistributedRunCommandLink, ControlRunSnapshot } from '../control-snapshots.ts';
import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import {
    toDistributedRunCompositeChildDecodeIssues,
    toDistributedRunCompositeGroupSummaries,
    toDistributedRunCompositeRows
} from './distributed-run-composite-rows.ts';
import { isFiniteDurationMs } from './distributed-run-latency-summary.ts';
import type {
    DistributedRunCompositeChildDecodeIssueRow,
    DistributedRunCompositeCounts,
    DistributedRunCompositeDrilldown,
    DistributedRunCompositeRow,
    DistributedRunFailureRow
} from './distributed-run-row-contracts.ts';

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];

const COMPOSITE_CHILD_UNDECODABLE_CODE = 'RALLAR_BLACK_BOX_COMPOSITE_CHILD_UNDECODABLE';

export function toDistributedRunCompositeDrilldowns(
    results: readonly ControlResultSnapshot[],
    commands: ReadonlyMap<string, ControlCommandSnapshot>,
    linksByCommandId: ReadonlyMap<string, ControlDistributedRunCommandLink>
): readonly DistributedRunCompositeDrilldown[] {
    return results.flatMap((result) => {
        const roots = toDistributedRunCompositeRoots(result.result);
        if (roots.length === 0) {
            return [];
        }

        const link = linksByCommandId.get(result.commandId);
        const command = commands.get(result.commandId);
        const rows = toDistributedRunCompositeRows(roots);
        if (rows.length === 0) {
            return [];
        }

        const summary = computeRallarBlackBoxCompositeResultSummary(roots, {});
        const failedRows = [...rows]
            .filter((row) => !row.ok)
            .sort((left, right) =>
                left.startedAtEpochMs - right.startedAtEpochMs ||
                left.endedAtEpochMs - right.endedAtEpochMs ||
                left.path.localeCompare(right.path)
            );
        const firstFailure = failedRows.find((row) => row.depth > 0) ?? failedRows[0];

        return [{
            key: `${result.agentId}:${result.commandId}`,
            commandId: result.commandId,
            agentId: result.agentId,
            recipeId: link?.recipeId ?? resolveCommandRecipeId(command),
            role: link?.role,
            phase: link?.phase,
            commandKind: command?.envelope.command.kind ?? result.result?.kind,
            artifactRef: `control-run.json#results[commandId=${result.commandId}]`,
            summary: {
                total: summary.total,
                passed: summary.passed,
                failed: summary.failed,
                cancelled: summary.cancelled,
                skipped: summary.skipped,
                composite: summary.composite,
                leaf: summary.leaf
            },
            firstFailure,
            groupSummaries: toDistributedRunCompositeGroupSummaries(roots),
            childDecodeIssues: toDistributedRunCompositeChildDecodeIssues(roots),
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

function toDistributedRunCompositeRoots(
    result: RallarBlackBoxTestResult | undefined
): readonly RallarBlackBoxTestResult[] {
    if (!result) {
        return [];
    }

    const recipeResults = toRecipeRunChildResults(result);
    if (recipeResults.length > 0) {
        return recipeResults.some(isCompositeMonitorRelevantResult) ? recipeResults : [];
    }

    return isCompositeMonitorRelevantResult(result) ? [result] : [];
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
    return toRecipeRunChildResults(result).some(isCompositeMonitorRelevantResult);
}

function toRecipeRunChildResults(result: RallarBlackBoxTestResult): readonly RallarBlackBoxTestResult[] {
    if (result.kind !== 'recipe.run') {
        return [];
    }
    const value = decodeRecord(result.value);
    return Array.isArray(value.results)
        ? value.results.filter(isRallarBlackBoxTestResult)
        : [];
}

function isRallarBlackBoxTestResult(value: unknown): value is RallarBlackBoxTestResult {
    const candidate = decodeRecord(value);
    return typeof candidate.commandId === 'string' &&
        typeof candidate.kind === 'string' &&
        typeof candidate.status === 'string' &&
        typeof candidate.ok === 'boolean' &&
        isFiniteDurationMs(candidate.startedAtEpochMs) &&
        isFiniteDurationMs(candidate.endedAtEpochMs) &&
        isFiniteDurationMs(candidate.durationMs);
}

export function resolveCommandRecipeId(command: ControlCommandSnapshot | undefined): string | undefined {
    if (!command) {
        return undefined;
    }
    return command.envelope.command.kind === 'recipe.run' || command.envelope.command.kind === 'recipe.load'
        ? command.envelope.command.recipe?.recipeId
        : undefined;
}
