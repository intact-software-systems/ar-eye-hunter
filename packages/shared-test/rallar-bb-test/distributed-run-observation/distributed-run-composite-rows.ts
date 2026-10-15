import {
    toRallarBlackBoxCompositeDisplayResults,
    toRallarBlackBoxCompositeResultFlatEntries,
    type RallarBlackBoxCompositeResultFlatEntry,
    type RallarBlackBoxCompositeResultPosition
} from '../composite-results.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestParallelGroupResult,
    RallarBlackBoxTestResult
} from '../rallar-black-box-test-contracts.ts';
import { decodeParallelResultValue } from './decode-composite-result-values.ts';
import type {
    DistributedRunCompositeChildDecodeIssueRow,
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

/** A recorded root result and the command it ran; the command is absent when the observation does not carry it. */
export interface DistributedRunCompositeRoot {
    readonly result: RallarBlackBoxTestResult;
    readonly authored: RallarBlackBoxTestCommand | undefined;
}

const SOURCE_RECIPE_PATH_STEP = /^(?:\.groups\[(\d+)\])?\.commands\[(\d+)\]/u;

export function toDistributedRunCompositeRows(
    roots: readonly DistributedRunCompositeRoot[]
): readonly DistributedRunCompositeRow[] {
    const results = roots.map((root) => root.result);
    const entries = toRallarBlackBoxCompositeResultFlatEntries(results);
    const displayByPath = new Map(
        toRallarBlackBoxCompositeDisplayResults(results, {})
            .map((row) => [row.path, row])
    );
    const authoredByPath = toAuthoredCompositeCommandsByPath(entries, roots);

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
            summary: toCompositeResultSummary(entry.result, display?.value, authoredByPath.get(entry.path)),
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

export function toDistributedRunCompositeChildDecodeIssues(
    roots: readonly RallarBlackBoxTestResult[]
): readonly DistributedRunCompositeChildDecodeIssueRow[] {
    return toRallarBlackBoxCompositeResultFlatEntries(roots).flatMap((entry) =>
        entry.childDecodeIssues.map((issue) => ({
            parentPath: entry.path,
            parentCommandId: entry.commandId,
            parentEndedAtEpochMs: entry.endedAtEpochMs,
            valuePath: issue.valuePath,
            invalidFields: issue.invalidFields
        }))
    );
}

function toCompositeRowPosition(position: RallarBlackBoxCompositeResultPosition): CompositeRowPosition {
    switch (position.kind) {
        case 'root':
            return {};
        case 'recipe-child':
            return {
                parentPath: position.parentPath,
                parentCommandId: position.parentCommandId,
                childIndex: position.childIndex,
                commandIndex: position.commandIndex,
                originalCommandId: position.originalCommandId
            };
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
    group: RallarBlackBoxTestParallelGroupResult
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

/**
 * Pairs each composite entry with the command it ran, when the observation carries the authored root command.
 * Entries list each root before its descendants, so a root entry opens the authored tree its descendants walk.
 */
function toAuthoredCompositeCommandsByPath(
    entries: readonly RallarBlackBoxCompositeResultFlatEntry[],
    roots: readonly DistributedRunCompositeRoot[]
): ReadonlyMap<string, RallarBlackBoxTestCommand> {
    const authoredByPath = new Map<string, RallarBlackBoxTestCommand>();
    let rootIndex = -1;
    let rootSourceRecipePath = '';
    for (const entry of entries) {
        if (entry.depth === 0) {
            rootIndex += 1;
            rootSourceRecipePath = entry.sourceRecipePath;
        }
        const authored = entry.sourceRecipePath.startsWith(rootSourceRecipePath)
            ? resolveAuthoredCommand(
                roots[rootIndex]?.authored,
                entry.sourceRecipePath.slice(rootSourceRecipePath.length)
            )
            : undefined;
        if (authored?.kind === entry.kind) {
            authoredByPath.set(entry.path, authored);
        }
    }
    return authoredByPath;
}

function resolveAuthoredCommand(
    root: RallarBlackBoxTestCommand | undefined,
    relativeSourceRecipePath: string
): RallarBlackBoxTestCommand | undefined {
    let command = root;
    let remainingPath = relativeSourceRecipePath;
    while (command !== undefined && remainingPath.length > 0) {
        const step = SOURCE_RECIPE_PATH_STEP.exec(remainingPath);
        if (!step) {
            return undefined;
        }
        command = resolveAuthoredChildCommand(
            command,
            step[1] === undefined ? undefined : Number(step[1]),
            Number(step[2])
        );
        remainingPath = remainingPath.slice(step[0].length);
    }
    return command;
}

function resolveAuthoredChildCommand(
    parent: RallarBlackBoxTestCommand,
    groupIndex: number | undefined,
    commandIndex: number
): RallarBlackBoxTestCommand | undefined {
    if (groupIndex !== undefined) {
        return parent.kind === 'parallel' ? parent.groups[groupIndex]?.commands[commandIndex] : undefined;
    }
    if (parent.kind === 'loop') {
        return parent.commands[commandIndex];
    }
    return parent.kind === 'recipe.run' ? parent.recipe?.commands[commandIndex] : undefined;
}
