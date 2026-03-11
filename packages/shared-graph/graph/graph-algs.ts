import { EdgeProp, GraphProp, MeshGraph, TreeGraph, VertexId, VertexProp, VertexState } from '../graph-props.ts';
import { UndirectedGraph } from 'graphology';

export function diameterDistance(graph: TreeGraph): number {
    const nodes = graph.nodes() as string[];
    let diameter = 0;

    for (const source of nodes) {
        const distances = dijkstraOnTreeFromSource(graph, source);
        for (const d of distances.values()) {
            if (Number.isFinite(d) && d > diameter) {
                diameter = d;
            }
        }
    }

    return diameter;
}

export function dijkstraOnTreeFromSource(
    tree: TreeGraph,
    source: VertexId,
): Map<VertexId, number> {
    const nodes = tree.nodes() as VertexId[];
    const distances = new Map<VertexId, number>();
    const visited = new Set<VertexId>();

    for (const node of nodes) distances.set(node, Number.POSITIVE_INFINITY);
    distances.set(source, 0);

    while (visited.size < nodes.length) {
        let current: VertexId | undefined;
        let currentDistance = Number.POSITIVE_INFINITY;

        for (const node of nodes) {
            if (visited.has(node)) continue;
            const d = distances.get(node) ?? Number.POSITIVE_INFINITY;
            if (d < currentDistance) {
                current = node;
                currentDistance = d;
            }
        }

        if (current === undefined || !Number.isFinite(currentDistance)) break;

        visited.add(current);

        tree.forEachNeighbor(current, (neighbor: string) => {
            if (visited.has(neighbor)) return;

            const weight = getEdgeWeight(tree, current!, neighbor);
            const alt = currentDistance + weight;
            const prev = distances.get(neighbor) ?? Number.POSITIVE_INFINITY;

            if (alt < prev) distances.set(neighbor, alt);
        });
    }

    return distances;
}

export function getEdgeWeight(graph: TreeGraph, a: VertexId, b: VertexId): number {
    const edgeKey = graph.edge(a, b);
    if (edgeKey === undefined) {
        throw new Error(`Missing edge between ${a} and ${b}`);
    }
    return graph.getEdgeAttribute(edgeKey, 'weight') as number;
}

export function canAcceptChild(tree: TreeGraph, node: VertexId): boolean {
    return tree.degree(node) < tree.getNodeAttributes(node).degreeLimit;
}

export function cloneTree(tree: TreeGraph): TreeGraph {
    const cloned = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    cloned.import(tree.export());
    return cloned;
}

export function cloneGraph(graph: TreeGraph): TreeGraph {
    return cloneTree(graph);
}

export function neighborsOf(tree: TreeGraph, node: VertexId): VertexId[] {
    return tree.neighbors(node) as VertexId[];
}


export function disconnectAllEdges(tree: TreeGraph, node: VertexId): void {
    const incidentEdges = tree.edges(node) as string[];
    for (const edgeKey of incidentEdges) {
        tree.dropEdge(edgeKey);
    }
}


export function worstCaseDist(
    groupGraph: MeshGraph,
    source: VertexId,
): number {
    const distances = dijkstraDistances(groupGraph, source);
    let maxDistance = 0;

    for (const d of distances.values()) {
        if (Number.isFinite(d) && d > maxDistance) {
            maxDistance = d;
        }
    }

    return maxDistance;
}

export function eccentricity(tree: TreeGraph, source: VertexId): number {
    const distances = dijkstraOnTreeFromSource(tree, source);
    let ecc = 0;

    for (const d of distances.values()) {
        if (Number.isFinite(d) && d > ecc) ecc = d;
    }

    return ecc;
}


function dijkstraDistances(
    graph: MeshGraph,
    source: VertexId,
): Map<VertexId, number> {
    const nodes = graph.nodes() as VertexId[];
    const distances = new Map<VertexId, number>();
    const visited = new Set<VertexId>();

    for (const node of nodes) {
        distances.set(node, Number.POSITIVE_INFINITY);
    }
    distances.set(source, 0);

    while (visited.size < nodes.length) {
        let current: VertexId | undefined;
        let best = Number.POSITIVE_INFINITY;

        for (const node of nodes) {
            if (visited.has(node)) continue;
            const d = distances.get(node) ?? Number.POSITIVE_INFINITY;
            if (d < best) {
                best = d;
                current = node;
            }
        }

        if (current === undefined || !Number.isFinite(best)) {
            break;
        }

        visited.add(current);

        graph.forEachNeighbor(current, (neighbor: string) => {
            if (visited.has(neighbor)) return;

            const edgeKey = graph.edge(current!, neighbor);
            if (edgeKey === undefined) return;

            const weight = graph.getEdgeAttribute(edgeKey, 'weight') as number;
            const alt = best + weight;
            const prev = distances.get(neighbor) ?? Number.POSITIVE_INFINITY;

            if (alt < prev) {
                distances.set(neighbor, alt);
            }
        });
    }

    return distances;
}

export function isValidMesh(groupGraph: MeshGraph): boolean {
    const nodes = groupGraph.nodes() as VertexId[];
    if (nodes.length <= 1) return true;

    const visited = new Set<VertexId>();
    const queue: VertexId[] = [nodes[0]];
    visited.add(nodes[0]);

    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const neighbor of groupGraph.neighbors(current) as VertexId[]) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    return visited.size === nodes.length;
}

export function diffGraphs(base: TreeGraph, removeGraph: TreeGraph): void {
    for (const edgeKey of removeGraph.edges() as string[]) {
        const [a, b] = removeGraph.extremities(edgeKey) as [VertexId, VertexId];
        if (base.hasEdge(a, b)) {
            const key = base.edge(a, b);
            if (key !== undefined) {
                base.dropEdge(key);
            }
        }
    }

    for (const node of [...base.nodes()] as VertexId[]) {
        const attrs = base.getNodeAttributes(node);
        const isSteiner = attrs.state === VertexState.STEINER;

        if (base.degree(node) === 0) {
            if (isSteiner || removeGraph.hasNode(node)) {
                base.dropNode(node);
            }
        }
    }
}

export function pruneNonTerminalLeaves(T: TreeGraph): void {
    let changed = true;

    while (changed) {
        changed = false;
        const toRemove: VertexId[] = [];

        for (const node of T.nodes() as VertexId[]) {
            const attrs = T.getNodeAttributes(node);
            if (attrs.state !== VertexState.STEINER) continue;

            if (T.degree(node) <= 1) {
                toRemove.push(node);
            }
        }

        if (toRemove.length > 0) {
            changed = true;
            for (const node of toRemove) {
                if (T.hasNode(node)) {
                    T.dropNode(node);
                }
            }
        }
    }
}

export function mergeGraphs(target: TreeGraph, source: TreeGraph): void {
    for (const node of source.nodes() as VertexId[]) {
        if (!target.hasNode(node)) {
            target.addNode(node, { ...source.getNodeAttributes(node) });
        }
    }

    for (const edgeKey of source.edges() as string[]) {
        const ext = source.extremities(edgeKey) as [VertexId, VertexId];
        const [a, b] = ext;

        if (!target.hasEdge(a, b)) {
            target.addEdge(a, b, { ...source.getEdgeAttributes(edgeKey) });
        }
    }
}

export function getDegreeConstraint(graph: TreeGraph, node: VertexId): number {
    return graph.getNodeAttributes(node).degreeLimit;
}
