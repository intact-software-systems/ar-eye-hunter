import {
    flattenRallarBlackBoxCompositeResults,
    toRallarBlackBoxCompositeDisplayResults
} from '../composite-results.ts';
import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { decodeParallelResultValue } from './decode-composite-result-values.ts';
import type {
    DistributedRunCompositeGroupSummary,
    DistributedRunCompositeRow
} from './distributed-run-row-contracts.ts';
import {
    toCompositeErrorSummary,
    toCompositeResultDetail,
    toCompositeValueSummary
} from './to-composite-result-detail.ts';
import { toCompositeResultSummary } from './to-composite-result-summary.ts';

export function toDistributedRunCompositeRows(
    roots: readonly RallarBlackBoxTestResult[]
): readonly DistributedRunCompositeRow[] {
    const entries = flattenRallarBlackBoxCompositeResults(roots);
    const displayByPath = new Map(
        toRallarBlackBoxCompositeDisplayResults(roots)
            .map((row) => [row.path, row])
    );

    return entries.map((entry) => {
        const display = displayByPath.get(entry.path);
        const errorSummary = toCompositeErrorSummary(display?.error ?? entry.result.error);
        return {
            path: entry.path,
            sourceRecipePath: entry.sourceRecipePath,
            parentPath: entry.parentPath,
            parentCommandId: entry.parentCommandId,
            depth: entry.depth,
            childIndex: entry.childIndex,
            commandIndex: entry.commandIndex,
            iteration: entry.iteration,
            groupId: entry.groupId,
            groupIndex: entry.groupIndex,
            originalCommandId: entry.originalCommandId,
            commandId: entry.commandId,
            kind: entry.kind,
            status: entry.status,
            ok: entry.ok,
            startedAtEpochMs: entry.startedAtEpochMs,
            endedAtEpochMs: entry.endedAtEpochMs,
            durationMs: entry.durationMs,
            summary: toCompositeResultSummary(entry.result, display?.value),
            detail: toCompositeResultDetail(entry.result, display?.value, errorSummary),
            errorSummary,
            valueSummary: toCompositeValueSummary(display?.value)
        };
    });
}

export function toDistributedRunCompositeGroupSummaries(
    roots: readonly RallarBlackBoxTestResult[]
): readonly DistributedRunCompositeGroupSummary[] {
    return flattenRallarBlackBoxCompositeResults(roots)
        .flatMap((entry) => {
            const value = decodeParallelResultValue(entry.result.value);
            if (!value) {
                return [];
            }
            return value.groups.map((group, groupIndex) => ({
                parentPath: entry.path,
                parentCommandId: entry.commandId,
                groupId: group.groupId,
                groupIndex,
                commandCount: group.commandCount,
                passed: group.passed,
                failed: group.failed,
                cancelled: group.cancelled,
                durationMs: group.durationMs,
                status: toCompositeGroupStatus(group)
            }));
        });
}

function toCompositeGroupStatus(
    group: Readonly<{ commandCount: number; passed: number; failed: number; cancelled: boolean; }>
): DistributedRunCompositeGroupSummary['status'] {
    if (group.cancelled) {
        return 'cancelled';
    }
    if (group.failed > 0) {
        return 'failed';
    }
    if (group.commandCount === 0) {
        return 'empty';
    }
    return 'passed';
}
