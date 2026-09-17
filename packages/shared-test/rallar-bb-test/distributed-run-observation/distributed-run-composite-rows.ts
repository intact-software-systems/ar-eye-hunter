import {
    toRallarBlackBoxCompositeDisplayResults,
    toRallarBlackBoxCompositeResultFlatEntries,
    type RallarBlackBoxCompositeResultPosition
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

type CompositeRowPosition = Pick<
    DistributedRunCompositeRow,
    | 'parentPath'
    | 'parentCommandId'
    | 'childIndex'
    | 'commandIndex'
    | 'iteration'
    | 'groupId'
    | 'groupIndex'
    | 'originalCommandId'
>;

export function toDistributedRunCompositeRows(
    roots: readonly RallarBlackBoxTestResult[]
): readonly DistributedRunCompositeRow[] {
    const entries = toRallarBlackBoxCompositeResultFlatEntries(roots);
    const displayByPath = new Map(
        toRallarBlackBoxCompositeDisplayResults(roots, {})
            .map((row) => [row.path, row])
    );

    return entries.map((entry) => {
        const display = displayByPath.get(entry.path);
        const errorSummary = toCompositeErrorSummary(display?.error ?? entry.result.error);
        const position = toCompositeRowPosition(entry.position);
        return {
            path: entry.path,
            sourceRecipePath: entry.sourceRecipePath,
            parentPath: position.parentPath,
            parentCommandId: position.parentCommandId,
            depth: entry.depth,
            childIndex: position.childIndex,
            commandIndex: position.commandIndex,
            iteration: position.iteration,
            groupId: position.groupId,
            groupIndex: position.groupIndex,
            originalCommandId: position.originalCommandId,
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
    return toRallarBlackBoxCompositeResultFlatEntries(roots)
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

function toCompositeRowPosition(position: RallarBlackBoxCompositeResultPosition): CompositeRowPosition {
    switch (position.kind) {
        case 'root':
            return {};
        case 'loop-child':
            return {
                parentPath: position.parentPath,
                parentCommandId: position.parentCommandId,
                childIndex: position.childIndex,
                commandIndex: position.commandIndex,
                iteration: position.iteration,
                originalCommandId: position.originalCommandId
            };
        case 'parallel-child':
            return {
                parentPath: position.parentPath,
                parentCommandId: position.parentCommandId,
                childIndex: position.childIndex,
                commandIndex: position.commandIndex,
                groupId: position.groupId,
                groupIndex: position.groupIndex,
                originalCommandId: position.originalCommandId
            };
    }
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
