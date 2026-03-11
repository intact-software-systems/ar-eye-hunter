import { insertMinimumDiameterDegreeLimitedEdge } from './tree/insert-dynamics-mddl.ts';
import { removeTryReplaceMDDL } from './tree/remove-dynamics-mddl.ts';
import { mddlOTTC, relaxDegreeByOne } from './tree/mddl-ottc.ts';
import { TreeGraph, WeightedGraph } from './graph-props.ts';
import { diameterDistance } from './graph/graph-algs.ts';
import { GlobalArgs, MessageType, ReconfigAlgo } from './algo-props.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';

export type UpdateGroupTreeInputDto = {
    type: MessageType;
    fromNode: string;
    group: GroupSnapshot;
    groupGraph: TreeGraph;
    globalGraph: WeightedGraph;
    globalArgs: GlobalArgs;
    selectSteinerCandidate?: (
        tree: TreeGraph,
        globalGraph: WeightedGraph,
        actionVertexId: string,
        related: ReadonlySet<string>,
    ) => string | undefined;
};

export type UpdateGroupTreeComputedDto = {
    input: UpdateGroupTreeInputDto;
    elapsedMs: number;
    reconfigured: boolean;
    tree: TreeGraph;
};

export function updateGroupTree(
    input: UpdateGroupTreeInputDto,
): UpdateGroupTreeComputedDto {
    const started = performance.now();
    const memberSessionIds = readGroupMemberSessionIds(input.group);

    let updatedTree: TreeGraph;

    switch (input.type) {
        case MessageType.TO_SERVER_ENTER: {
            updatedTree = insertMinimumDiameterDegreeLimitedEdge(
                input.groupGraph,
                input.globalGraph,
                input.fromNode,
                (tree, g, actionVertexId, mcpVertexId) =>
                    input.selectSteinerCandidate?.(tree, g, actionVertexId, mcpVertexId),
            );
            break;
        }

        case MessageType.TO_SERVER_LEAVE: {
            updatedTree = removeTryReplaceMDDL(
                input.groupGraph,
                input.globalGraph,
                input.fromNode,
                (tree, g, actionVertexId, adjacent) =>
                    input.selectSteinerCandidate?.(tree, g, actionVertexId, adjacent),
            );
            break;
        }

        default:
            throw new Error(`Unsupported message type: ${input.type}`);
    }

    const computedReconfig = computeReconfig(
        updatedTree,
        new Set(memberSessionIds),
        input.globalGraph,
        input.globalArgs,
    );

    return {
        input: input,
        elapsedMs: performance.now() - started,
        reconfigured: computedReconfig.left === undefined,
        tree: computedReconfig.right ?? updatedTree,
    };
}

export function computeReconfig(
    tree: TreeGraph,
    members: ReadonlySet<string>,
    globalGraph: TreeGraph,
    globalArgs: GlobalArgs,
): Either<boolean, TreeGraph> {
    if (members.size < 5) {
        return Either.ofLeft(false);
    }

    switch (globalArgs.reconfigAlgo) {
        case ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE: {
            const currentDiameter = diameterDistance(tree);

            if (currentDiameter <= globalArgs.diameterBound) {
                return Either.ofLeft(false);
            }

            const src = pickSourceForRebuild(tree, members);
            if (src === undefined) {
                return Either.ofLeft(false);
            }

            const rebuild = mddlOTTC(
                globalGraph,
                src,
                members,
                relaxDegreeByOne,
            );
            if (!rebuild.success) {
                return Either.ofLeft(false);
            }

            return Either.ofRight(rebuild.tree);
        }

        case ReconfigAlgo.NO_RECONFIG_ALGO:
        default:
            return Either.ofLeft(false);
    }
}

export function pickSourceForRebuild(
    currentTree: TreeGraph,
    members: ReadonlySet<string>,
): string | undefined {
    for (const node of currentTree.nodes() as string[]) {
        if (members.has(node)) {
            return node;
        }
    }
    return undefined;
}
