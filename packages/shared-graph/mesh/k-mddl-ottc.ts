import { TreeGraph, VertexId, WeightedGraph } from '../graph-props.ts';
import {
    cloneGraph,
    diffGraphs,
    getDegreeConstraint,
    mergeGraphs,
    pruneNonTerminalLeaves
} from '../graph/graph-algs.ts';
import { CoreSelectionAlgo, findWCNodes } from '../graph/steiner-core-algorithms.ts';
import { createEmptyTreeLike, mddlOTTC, relaxDegreeByOne } from '../tree/mddl-ottc.ts';

export function kMDDLOTTCTree(
    inputT: TreeGraph,
    k: number,
    src: VertexId
): WeightedGraph {
    const newT = createEmptyTreeLike(inputT);
    const meshT = cloneGraph(inputT);

    if (newT.nodes().length > 0) {
        diffGraphs(meshT, newT);

        if (!meshT.hasNode(src)) {
            return newT;
        }
        if (meshT.degree(src) <= 0) {
            return newT;
        }
    }

    const usedSources = new Set<VertexId>();

    for (let i = 0; i < k; i++) {
        const treeNodes = new Set(meshT.nodes() as VertexId[]);
        if (treeNodes.size === 0) {
            break;
        }
        if (!treeNodes.has(src)) {
            break;
        }

        const built = mddlOTTC(
            meshT,
            src,
            treeNodes,
            relaxDegreeByOne
        );

        if (!built.success) {
            break;
        }

        const T = built.tree;

        pruneNonTerminalLeaves(T);

        mergeGraphs(newT, T);
        diffGraphs(meshT, T);

        for (const v of newT.nodes() as VertexId[]) {
            if (!meshT.hasNode(v)) {
                continue;
            }

            const originalLimit = getDegreeConstraint(inputT, v);
            const usedDegree = newT.degree(v);

            if (usedDegree >= originalLimit) {
                meshT.dropNode(v);
            }
            else {
                const attrs = meshT.getNodeAttributes(v);
                meshT.replaceNodeAttributes(v, {
                    ...attrs,
                    degreeLimit: originalLimit - usedDegree
                });
            }
        }

        usedSources.add(src);

        const remainingVertices = new Set(meshT.nodes() as VertexId[]);
        for (const used of usedSources) {
            remainingVertices.delete(used);
        }

        if (meshT.edges().length <= 1) {
            break;
        }
        if (remainingVertices.size === 0) {
            break;
        }

        const centers = findWCNodes(
            meshT,
            remainingVertices,
            remainingVertices,
            usedSources,
            1,
            CoreSelectionAlgo.CENTER_SELECTION
        );

        if (centers.length === 0) {
            break;
        }

        src = centers[0];

        if (!meshT.hasNode(src)) {
            break;
        }
        if (meshT.degree(src) <= 0) {
            break;
        }
    }

    return newT;
}
