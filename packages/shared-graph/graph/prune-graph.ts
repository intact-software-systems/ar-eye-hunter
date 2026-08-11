import { UndirectedGraph } from 'graphology';
import { EdgeProp, GraphProp, TreeGraph, VertexId, VertexProp, VertexState } from '../graph-props.ts';
import { CoreSelectionAlgo } from './steiner-core-algorithms.ts';

export const PruneGraphAlgo = {
    NO_GRAPH_ALGO: 'NO_GRAPH_ALGO',
    K_BEST_LINKS: 'K_BEST_LINKS',
    ADD_CORE_LINKS: 'ADD_CORE_LINKS',
    ADD_CORE_LINKS_OPTIMIZED: 'ADD_CORE_LINKS_OPTIMIZED',
    ADD_CORE_LINKS_OPTIMIZED_DEGREE_LIMITED: 'ADD_CORE_LINKS_OPTIMIZED_DEGREE_LIMITED',
} as const;

export type PruneGraphAlgo = (typeof PruneGraphAlgo)[keyof typeof PruneGraphAlgo];

export type PruneGraphInputDto = {
    inputT: TreeGraph;
    k: number;
    pruneAlgo: PruneGraphAlgo;
    wcnAlgo: CoreSelectionAlgo;
    degreeConstraint: number;
    degreeConstraintSP: number;
    steinerMemberSize: number;
    deps: {
        findWCNodes: (
            globalGraph: TreeGraph,
            nodeSearchSet: ReadonlySet<VertexId>,
            relativeSet: ReadonlySet<VertexId>,
            excludeSet: ReadonlySet<VertexId>,
            k: number,
            algo: CoreSelectionAlgo,
        ) => VertexId[];

        generateSizeOfSteinerSet: (groupSize: number) => number;
        generateSizeNonSteiner: (uncovered: number) => number;
    };
};

export type PruneGraphResult = {
    graph: TreeGraph;
    coreSet: Set<VertexId>;
};

export function pruneGraph(
    input: PruneGraphInputDto,
): PruneGraphResult {
    const {
        inputT,
        k,
        pruneAlgo,
        wcnAlgo,
        degreeConstraint,
        degreeConstraintSP,
        steinerMemberSize,
        deps,
    } = input;

    if (pruneAlgo === PruneGraphAlgo.NO_GRAPH_ALGO) {
        return {
            graph: cloneGraph(inputT),
            coreSet: new Set<VertexId>(),
        };
    }

    if (pruneAlgo === PruneGraphAlgo.K_BEST_LINKS) {
        return {
            graph: kBL(inputT, k),
            coreSet: new Set<VertexId>(),
        };
    }

    const inputNodes = nodeSet(inputT);
    const inputSteiner = steinerSet(inputT);
    const inputMembers = memberSet(inputT);

    if (inputSteiner.size === 0) {
        return pruneGraphWithoutSteiner(
            inputT,
            inputNodes,
            k,
            pruneAlgo,
            wcnAlgo,
            degreeConstraint,
            deps,
        );
    }

    return pruneGraphWithSteiner(
        inputT,
        inputNodes,
        inputMembers,
        inputSteiner,
        k,
        pruneAlgo,
        wcnAlgo,
        degreeConstraintSP,
        steinerMemberSize,
        deps,
    );
}

function pruneGraphWithoutSteiner(
    inputT: TreeGraph,
    inputNodes: ReadonlySet<VertexId>,
    k: number,
    pruneAlgo: PruneGraphAlgo,
    wcnAlgo: CoreSelectionAlgo,
    degreeConstraint: number,
    deps: PruneGraphInputDto['deps'],
): PruneGraphResult {
    const coreCount = deps.generateSizeOfSteinerSet(inputNodes.size);

    const coreCandidates = deps.findWCNodes(
        inputT,
        inputNodes,
        inputNodes,
        new Set<VertexId>(),
        coreCount,
        wcnAlgo,
    );

    const coreSet = new Set(coreCandidates);

    if (coreSet.size === 0) {
        throw new Error('pruneGraphWithoutSteiner: coreSet is empty.');
    }

    switch (pruneAlgo) {
        case PruneGraphAlgo.ADD_CORE_LINKS:
            return {
                graph: kBestLinksGraphNoSP(inputT, coreSet, k),
                coreSet,
            };

        case PruneGraphAlgo.ADD_CORE_LINKS_OPTIMIZED:
            return {
                graph: kBestLinksOptimizedGraphNoSP(
                    inputT,
                    coreSet,
                    k,
                    degreeConstraint,
                ),
                coreSet,
            };

        case PruneGraphAlgo.ADD_CORE_LINKS_OPTIMIZED_DEGREE_LIMITED:
            return {
                graph: kBestLinksOptimizedDLGraphNoSP(
                    inputT,
                    coreSet,
                    k,
                    degreeConstraint,
                ),
                coreSet,
            };

        default:
            throw new Error(`Unsupported prune algo without Steiner: ${pruneAlgo}`);
    }
}

function pruneGraphWithSteiner(
    inputT: TreeGraph,
    inputNodes: ReadonlySet<VertexId>,
    inputMembers: ReadonlySet<VertexId>,
    inputSteiner: ReadonlySet<VertexId>,
    k: number,
    pruneAlgo: PruneGraphAlgo,
    wcnAlgo: CoreSelectionAlgo,
    degreeConstraintSP: number,
    steinerMemberSize: number,
    deps: PruneGraphInputDto['deps'],
): PruneGraphResult {
    let coreSet = new Set<VertexId>(inputSteiner);

    const targetCoreCount = deps.generateSizeOfSteinerSet(inputMembers.size);

    if (steinerMemberSize > 0) {
        const missing = steinerMemberSize - coreSet.size;

        if (missing > 0) {
            const extra = deps.findWCNodes(
                inputT,
                inputNodes,
                inputNodes,
                inputSteiner,
                missing,
                wcnAlgo,
            );

            coreSet = union(coreSet, new Set(extra));
        }
    } else if (targetCoreCount > inputSteiner.size) {
        const uncovered =
            inputMembers.size - (inputSteiner.size * degreeConstraintSP);

        if (uncovered > 0) {
            const extraCount = deps.generateSizeNonSteiner(uncovered);

            if (extraCount > 0) {
                const extra = deps.findWCNodes(
                    inputT,
                    inputNodes,
                    inputNodes,
                    inputSteiner,
                    extraCount,
                    wcnAlgo,
                );

                coreSet = union(coreSet, new Set(extra));
            }
        }
    }

    switch (pruneAlgo) {
        case PruneGraphAlgo.ADD_CORE_LINKS:
            return {
                graph: kBestLinksGraph(inputT, coreSet, k),
                coreSet,
            };

        case PruneGraphAlgo.ADD_CORE_LINKS_OPTIMIZED: {
            const divisor = inputSteiner.size > 0 ? inputSteiner.size : 1;
            const sk = minInt(
                Math.floor(inputNodes.size / divisor),
                degreeConstraintSP - 1,
            );

            return {
                graph: kBestLinksOptimizedGraph(inputT, coreSet, k, sk),
                coreSet,
            };
        }

        case PruneGraphAlgo.ADD_CORE_LINKS_OPTIMIZED_DEGREE_LIMITED:
            return {
                graph: kBestLinksOptimizedDLGraph(
                    inputT,
                    coreSet,
                    k,
                    degreeConstraintSP,
                ),
                coreSet,
            };

        default:
            throw new Error(`Unsupported prune algo with Steiner: ${pruneAlgo}`);
    }
}

export function kBL(
    inputT: TreeGraph,
    k: number,
): TreeGraph {
    const newT = cloneEmptyLike(inputT);

    for (const src of inputT.nodes() as VertexId[]) {
        addVertexFromInput(newT, inputT, src);

        if (k <= 0) continue;

        const neighbors = sortedNeighborsByWeight(inputT, src);
        let added = 0;

        for (const targ of neighbors) {
            if (added >= k) break;
            if (newT.hasEdge(src, targ)) continue;

            addEdgeFromInput(newT, inputT, src, targ);
            added++;
        }
    }

    return connectPartitionedGraph(inputT, newT);
}

export function kBestLinksGraphNoSP(
    inputT: TreeGraph,
    coreSet: ReadonlySet<VertexId>,
    k: number,
): TreeGraph {
    const newT = cloneEmptyLike(inputT);

    for (const src of inputT.nodes() as VertexId[]) {
        addVertexFromInput(newT, inputT, src);

        if (coreSet.has(src)) {
            for (const targ of inputT.nodes() as VertexId[]) {
                if (src === targ) continue;
                addEdgeFromInput(newT, inputT, src, targ);
            }
            continue;
        }

        if (k <= 0) continue;

        let added = 0;
        for (const targ of sortedNeighborsByWeight(inputT, src)) {
            if (added >= k) break;
            if (nodeState(inputT, targ) !== VertexState.MEMBER) continue;
            if (newT.hasEdge(src, targ)) continue;

            addEdgeFromInput(newT, inputT, src, targ);
            added++;
        }
    }

    return newT;
}

export function kBestLinksOptimizedGraphNoSP(
    inputT: TreeGraph,
    coreSet: ReadonlySet<VertexId>,
    k: number,
    sk: number,
): TreeGraph {
    const newT = cloneEmptyLike(inputT);

    if (coreSet.size <= 1) {
        sk = inputT.nodes().length;
    }

    for (const src of inputT.nodes() as VertexId[]) {
        addVertexFromInput(newT, inputT, src);
        const neighbors = sortedNeighborsByWeight(inputT, src);

        if (coreSet.has(src)) {
            for (const core of coreSet) {
                if (src === core) continue;
                addEdgeFromInput(newT, inputT, src, core);
            }

            let added = 0;
            for (const targ of neighbors) {
                if (added >= sk) break;
                if (coreSet.has(targ)) continue;

                let doAdd = true;
                for (const core of coreSet) {
                    if (core === src) continue;
                    if (newT.hasEdge(core, targ)) {
                        doAdd = false;
                        break;
                    }
                }
                if (!doAdd) continue;

                if (!newT.hasEdge(src, targ)) {
                    addEdgeFromInput(newT, inputT, src, targ);
                    added++;
                }
            }

            continue;
        }

        if (k <= 0) continue;

        let added = 0;
        for (const targ of neighbors) {
            if (added >= k) break;
            if (nodeState(inputT, targ) !== VertexState.MEMBER) continue;
            if (newT.hasEdge(src, targ)) continue;

            addEdgeFromInput(newT, inputT, src, targ);
            added++;
        }
    }

    return newT;
}

export function kBestLinksOptimizedDLGraphNoSP(
    inputT: TreeGraph,
    coreSet: ReadonlySet<VertexId>,
    k: number,
    degreeConstraint: number,
): TreeGraph {
    const newT = cloneEmptyLike(inputT);
    const coreSetMeshifyFactor = 0.33;

    let sk = degreeConstraint;
    if (coreSet.size <= 1) {
        sk = inputT.nodes().length;
    }

    for (const src of inputT.nodes() as VertexId[]) {
        addVertexFromInput(newT, inputT, src);
        const neighbors = sortedNeighborsByWeight(inputT, src);

        if (coreSet.has(src)) {
            for (const core of coreSet) {
                if (src === core) continue;

                if ((degreeLimitOf(inputT, src) * coreSetMeshifyFactor) <= degreeOf(newT, src)) continue;
                if ((degreeLimitOf(inputT, core) * coreSetMeshifyFactor) <= degreeOf(newT, core)) continue;

                addEdgeFromInput(newT, inputT, src, core);
            }

            let added = 0;
            for (const targ of neighbors) {
                if (added >= sk) break;

                if (degreeLimitOf(inputT, src) <= degreeOf(newT, src)) continue;
                if (degreeLimitOf(inputT, targ) <= degreeOf(newT, targ)) continue;

                let doAdd = true;
                for (const core of coreSet) {
                    if (core === src) continue;
                    if (newT.hasEdge(core, targ)) {
                        doAdd = false;
                        break;
                    }
                }
                if (!doAdd) continue;

                if (!newT.hasEdge(src, targ)) {
                    addEdgeFromInput(newT, inputT, src, targ);
                    added++;
                }
            }

            continue;
        }

        if (k <= 0) continue;

        let added = 0;
        for (const targ of neighbors) {
            if (added >= k) break;
            if (nodeState(inputT, targ) !== VertexState.MEMBER) continue;
            if (degreeLimitOf(inputT, src) <= degreeOf(newT, src)) continue;
            if (degreeLimitOf(inputT, targ) <= degreeOf(newT, targ)) continue;
            if (newT.hasEdge(src, targ)) continue;

            addEdgeFromInput(newT, inputT, src, targ);
            added++;
        }
    }

    return connectPartitionedGraph(inputT, newT);
}

export function kBestLinksGraph(
    inputT: TreeGraph,
    coreSet: ReadonlySet<VertexId>,
    k: number,
): TreeGraph {
    const newT = cloneEmptyLike(inputT);

    for (const src of inputT.nodes() as VertexId[]) {
        addVertexFromInput(newT, inputT, src);

        if (coreSet.has(src)) {
            for (const targ of inputT.nodes() as VertexId[]) {
                if (src === targ) continue;
                addEdgeFromInput(newT, inputT, src, targ);
            }
            continue;
        }

        if (k <= 0) continue;

        let added = 0;
        for (const targ of sortedNeighborsByWeight(inputT, src)) {
            if (added >= k) break;
            if (nodeState(inputT, targ) !== VertexState.MEMBER) continue;
            if (newT.hasEdge(src, targ)) continue;

            addEdgeFromInput(newT, inputT, src, targ);
            added++;
        }
    }

    return newT;
}

export function kBestLinksOptimizedGraph(
    inputT: TreeGraph,
    coreSet: ReadonlySet<VertexId>,
    k: number,
    sk: number,
): TreeGraph {
    const newT = cloneEmptyLike(inputT);

    if (countSteiner(inputT) <= 1) {
        sk = inputT.nodes().length;
    }

    for (const src of inputT.nodes() as VertexId[]) {
        addVertexFromInput(newT, inputT, src);
        const neighbors = sortedNeighborsByWeight(inputT, src);

        if (coreSet.has(src)) {
            for (const core of coreSet) {
                if (src === core) continue;
                addEdgeFromInput(newT, inputT, src, core);
            }

            let added = 0;
            for (const targ of neighbors) {
                if (added >= sk) break;
                if (coreSet.has(targ)) continue;

                let doAdd = true;
                for (const core of coreSet) {
                    if (core === src) continue;
                    if (newT.hasEdge(core, targ)) {
                        doAdd = false;
                        break;
                    }
                }
                if (!doAdd) continue;

                if (!newT.hasEdge(src, targ)) {
                    addEdgeFromInput(newT, inputT, src, targ);
                    added++;
                }
            }

            continue;
        }

        if (k <= 0) continue;

        let added = 0;
        for (const targ of neighbors) {
            if (added >= k) break;
            if (nodeState(inputT, targ) !== VertexState.MEMBER) continue;
            if (newT.hasEdge(src, targ)) continue;

            addEdgeFromInput(newT, inputT, src, targ);
            added++;
        }
    }

    return newT;
}

export function kBestLinksOptimizedDLGraph(
    inputT: TreeGraph,
    coreSet: ReadonlySet<VertexId>,
    k: number,
    sk: number,
): TreeGraph {
    const newT = cloneEmptyLike(inputT);
    const coreSetMeshifyFactor = 3;

    if (coreSet.size <= 1) {
        sk = inputT.nodes().length;
    }

    for (const src of inputT.nodes() as VertexId[]) {
        addVertexFromInput(newT, inputT, src);
        const neighbors = sortedNeighborsByWeight(inputT, src);

        if (coreSet.has(src)) {
            for (const core of coreSet) {
                if (src === core) continue;
                if ((degreeLimitOf(inputT, src) / coreSetMeshifyFactor) <= degreeOf(newT, src)) continue;
                if ((degreeLimitOf(inputT, core) / coreSetMeshifyFactor) <= degreeOf(newT, core)) continue;

                addEdgeFromInput(newT, inputT, src, core);
            }

            let added = 0;
            for (const targ of neighbors) {
                if (added >= sk) break;
                if (src === targ) continue;

                if (degreeLimitOf(inputT, src) <= degreeOf(newT, src)) continue;
                if (degreeLimitOf(inputT, targ) <= degreeOf(newT, targ)) continue;

                let doAdd = true;
                for (const core of coreSet) {
                    if (core === src) continue;
                    if (newT.hasEdge(core, targ)) {
                        doAdd = false;
                        break;
                    }
                }
                if (!doAdd) continue;

                if (!newT.hasEdge(src, targ)) {
                    addEdgeFromInput(newT, inputT, src, targ);
                    added++;
                }
            }

            continue;
        }

        if (k <= 0) continue;

        let added = 0;
        for (const targ of neighbors) {
            if (added >= k) break;
            if (nodeState(inputT, targ) !== VertexState.MEMBER) continue;
            if (degreeLimitOf(inputT, src) <= degreeOf(newT, src)) continue;
            if (degreeLimitOf(inputT, targ) <= degreeOf(newT, targ)) continue;
            if (newT.hasEdge(src, targ)) continue;

            addEdgeFromInput(newT, inputT, src, targ);
            added++;
        }
    }

    return connectPartitionedGraph(inputT, newT);
}

function cloneGraph(graph: TreeGraph): TreeGraph {
    const cloned = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    cloned.import(graph.export());
    return cloned;
}

function cloneEmptyLike(reference: TreeGraph): TreeGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(reference.getAttributes());
    return graph;
}

function nodeSet(graph: TreeGraph): Set<VertexId> {
    return new Set(graph.nodes() as VertexId[]);
}

function steinerSet(graph: TreeGraph): Set<VertexId> {
    const result = new Set<VertexId>();
    for (const node of graph.nodes() as VertexId[]) {
        if (graph.getNodeAttributes(node).state === VertexState.STEINER) {
            result.add(node);
        }
    }
    return result;
}

function memberSet(graph: TreeGraph): Set<VertexId> {
    const result = new Set<VertexId>();
    for (const node of graph.nodes() as VertexId[]) {
        if (graph.getNodeAttributes(node).state === VertexState.MEMBER) {
            result.add(node);
        }
    }
    return result;
}

function nodeState(graph: TreeGraph, node: VertexId): VertexState {
    return graph.getNodeAttributes(node).state;
}

function degreeOf(graph: TreeGraph, node: VertexId): number {
    return graph.degree(node);
}

function degreeLimitOf(graph: TreeGraph, node: VertexId): number {
    return graph.getNodeAttributes(node).degreeLimit;
}

function edgeWeightOf(graph: TreeGraph, a: VertexId, b: VertexId): number {
    const edgeKey = graph.edge(a, b);
    if (edgeKey === undefined) {
        throw new Error(`Missing edge between ${a} and ${b}`);
    }
    return graph.getEdgeAttribute(edgeKey, 'weight') as number;
}

function addVertexFromInput(
    target: TreeGraph,
    input: TreeGraph,
    node: VertexId,
): void {
    if (target.hasNode(node)) return;
    target.addNode(node, { ...input.getNodeAttributes(node) });
}

function addEdgeFromInput(
    target: TreeGraph,
    input: TreeGraph,
    a: VertexId,
    b: VertexId,
): void {
    if (a === b) return;

    addVertexFromInput(target, input, a);
    addVertexFromInput(target, input, b);

    if (target.hasEdge(a, b)) return;

    const edgeKey = input.edge(a, b);
    if (edgeKey === undefined) return;

    target.addEdge(a, b, { ...input.getEdgeAttributes(edgeKey) });
}

function sortedNeighborsByWeight(
    input: TreeGraph,
    node: VertexId,
): VertexId[] {
    const neighbors = input.neighbors(node) as VertexId[];
    neighbors.sort((a, b) => {
        const wa = edgeWeightOf(input, node, a);
        const wb = edgeWeightOf(input, node, b);
        if (wa !== wb) return wa - wb;
        return a.localeCompare(b);
    });
    return neighbors;
}

function union<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
    const out = new Set<T>(a);
    for (const x of b) out.add(x);
    return out;
}

function minInt(a: number, b: number): number {
    return a < b ? a : b;
}

function countSteiner(graph: TreeGraph): number {
    let count = 0;
    for (const node of graph.nodes() as VertexId[]) {
        if (nodeState(graph, node) === VertexState.STEINER) {
            count++;
        }
    }
    return count;
}

function connectPartitionedGraph(
    input: TreeGraph,
    partial: TreeGraph,
): TreeGraph {
    const next = cloneGraph(partial);
    const nodes = next.nodes() as VertexId[];
    if (nodes.length <= 1) return next;

    while (true) {
        const components = connectedComponents(next);
        if (components.length <= 1) {
            return next;
        }

        let best:
            | { a: VertexId; b: VertexId; weight: number }
            | undefined;

        for (let i = 0; i < components.length; i++) {
            for (let j = i + 1; j < components.length; j++) {
                for (const a of components[i]) {
                    for (const b of components[j]) {
                        if (!input.hasEdge(a, b)) continue;
                        const weight = edgeWeightOf(input, a, b);

                        if (
                            best === undefined ||
                            weight < best.weight ||
                            (weight === best.weight && `${a}:${b}` < `${best.a}:${best.b}`)
                        ) {
                            best = { a, b, weight };
                        }
                    }
                }
            }
        }

        if (best === undefined) {
            return next;
        }

        addEdgeFromInput(next, input, best.a, best.b);
    }
}

function connectedComponents(graph: TreeGraph): VertexId[][] {
    const remaining = new Set(graph.nodes() as VertexId[]);
    const components: VertexId[][] = [];

    while (remaining.size > 0) {
        const start = remaining.values().next().value as VertexId;
        const queue = [start];
        const component: VertexId[] = [];
        remaining.delete(start);

        while (queue.length > 0) {
            const current = queue.shift()!;
            component.push(current);

            for (const neighbor of graph.neighbors(current) as VertexId[]) {
                if (remaining.has(neighbor)) {
                    remaining.delete(neighbor);
                    queue.push(neighbor);
                }
            }
        }

        components.push(component);
    }

    return components;
}