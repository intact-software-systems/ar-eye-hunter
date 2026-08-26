import type { ExecutionBranch } from './mutation-boundary-execution-walk.ts';

export interface ExecutionBranchedWrite {
    readonly branches?: readonly ExecutionBranch[];
}

export function executionWriteScenarios<Write extends ExecutionBranchedWrite>(
    writes: readonly Write[]
): readonly (readonly Write[])[] {
    const groups = collectGroups(writes);
    if (groups.length === 0) {
        return [writes];
    }
    const selections = enumerateSelections(groups, 64);
    if (!selections) {
        return [writes, ...writes.map((write) => [write])];
    }
    return selections.map((selection) =>
        writes.filter((write) =>
            (write.branches ?? []).every(
                (branch) => selection.get(branch.group) === branch.alternativeIndex
            )
        )
    );
}

function collectGroups(writes: readonly ExecutionBranchedWrite[]): readonly BranchGroup[] {
    const groups = new Map<object, BranchGroup>();
    for (const write of writes) {
        for (const branch of write.branches ?? []) {
            groups.set(branch.group, {
                alternativeCount: branch.alternativeCount,
                group: branch.group,
                optional: branch.optional
            });
        }
    }
    return [...groups.values()];
}

function enumerateSelections(
    groups: readonly BranchGroup[],
    limit: number
): readonly ReadonlyMap<object, number>[] | undefined {
    let selections: readonly Map<object, number>[] = [new Map()];
    for (const group of groups) {
        const alternatives = [
            ...Array.from({ length: group.alternativeCount }, (_, index) => index),
            ...(group.optional ? [-1] : [])
        ];
        if (selections.length * alternatives.length > limit) {
            return undefined;
        }
        selections = selections.flatMap((selection) =>
            alternatives.map((alternative) => {
                const next = new Map(selection);
                next.set(group.group, alternative);
                return next;
            })
        );
    }
    return selections;
}

interface BranchGroup {
    readonly alternativeCount: number;
    readonly group: object;
    readonly optional: boolean;
}
