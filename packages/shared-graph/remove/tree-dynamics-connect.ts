import { degreeLimitOf, degreeOf, edgeWeightOf, } from './remove-dynamics-helpers.ts';
import type { ConnectContext, ConnectResult, DiameterCandidate, EdgeCandidate } from './tree-dynamics-connect-types.ts';
import { findMCEdge, findMDEdge, worstCaseDist, } from './tree-dynamics-search.ts';
import { TreeGraph, VertexId } from '../graph-props.ts';
import { cloneGraph } from '../graph/graph-algs.ts';

export function connectMCE(
    ctx: ConnectContext,
    remainingVertices: ReadonlySet<VertexId>,
    connectedVertices: ReadonlySet<VertexId>,
): ConnectResult {
    let graph = cloneGraph(ctx.groupGraph);
    const remaining = new Set(remainingVertices);
    const connected = new Set(connectedVertices);

    const targetSize = remaining.size + connected.size;
    let degInc = 0;
    let avInc = 2;

    while (connected.size < targetSize) {
        let best: EdgeCandidate | undefined;
        let chosenTarget: VertexId | undefined;

        const availableOutDegConnected = getAvailableOutDegree(
            graph,
            ctx.globalGraph,
            connected,
        );

        for (const source of connected) {
            if (degreeOf(graph, source) >= degreeLimitOf(ctx.globalGraph, source) + degInc) {
                continue;
            }

            for (const target of remaining) {
                if (!ctx.globalGraph.hasEdge(source, target)) continue;

                const weight = edgeWeightOf(ctx.globalGraph, source, target);
                const od =
                    availableOutDegConnected +
                    getAvailableOutDegree(graph, ctx.globalGraph, new Set([target])) -
                    avInc;

                if (od <= 0) continue;

                if (
                    best === undefined ||
                    weight < best.weight ||
                    (weight === best.weight &&
                        `${source}:${target}` < `${best.from}:${best.to}`)
                ) {
                    best = {
                        from: source,
                        to: target,
                        weight,
                    };
                    chosenTarget = target;
                }
            }
        }

        if (best === undefined || chosenTarget === undefined) {
            if (getAvailableOutDegree(graph, ctx.globalGraph, connected) < 0 || avInc < 0) {
                degInc++;
            }
            avInc--;

            if (degInc >= Number.MAX_SAFE_INTEGER - 1) {
                break;
            }
        } else {
            graph.addEdge(best.from, best.to, {
                from: best.from,
                to: best.to,
                weight: best.weight,
            });
            connected.add(chosenTarget);
            remaining.delete(chosenTarget);
        }
    }

    return {
        graph,
        connectedVertices: connected,
        remainingVertices: remaining,
    };
}

export function connectSearchMCE(
    ctx: ConnectContext,
    remainingVertices: ReadonlySet<VertexId>,
    connectedVertices: ReadonlySet<VertexId>,
): ConnectResult {
    let graph = cloneGraph(ctx.groupGraph);
    const remaining = new Set(remainingVertices);
    const connected = new Set(connectedVertices);

    const targetSize = remaining.size + connected.size;
    let degInc = 0;
    let avInc = 2;

    while (connected.size < targetSize) {
        let best: EdgeCandidate | undefined;
        let chosenTarget: VertexId | undefined;

        const availableOutDegConnected = getAvailableOutDegree(
            graph,
            ctx.globalGraph,
            connected,
        );

        for (const source of connected) {
            if (degreeOf(graph, source) >= degreeLimitOf(ctx.globalGraph, source) + degInc) {
                continue;
            }

            for (const target of remaining) {
                const od =
                    availableOutDegConnected +
                    getAvailableOutDegree(graph, ctx.globalGraph, new Set([target])) -
                    avInc;

                if (od <= 0) continue;

                const candidate = findMCEdge(ctx.globalGraph, graph, source, target);
                if (!candidate) continue;

                if (
                    best === undefined ||
                    candidate.weight < best.weight ||
                    (candidate.weight === best.weight &&
                        `${candidate.from}:${candidate.to}` < `${best.from}:${best.to}`)
                ) {
                    best = candidate;
                    chosenTarget = target;
                }
            }
        }

        if (best === undefined || chosenTarget === undefined) {
            if (getAvailableOutDegree(graph, ctx.globalGraph, connected) < 0 || avInc < 0) {
                degInc++;
            }
            avInc--;

            if (degInc >= Number.MAX_SAFE_INTEGER - 1) {
                break;
            }
        } else {
            graph.addEdge(best.from, best.to, {
                from: best.from,
                to: best.to,
                weight: best.weight,
            });
            connected.add(chosenTarget);
            remaining.delete(chosenTarget);
        }
    }

    return {
        graph,
        connectedVertices: connected,
        remainingVertices: remaining,
    };
}

export function connectMDE(
    ctx: ConnectContext,
    remainingVertices: ReadonlySet<VertexId>,
    connectedVertices: ReadonlySet<VertexId>,
): ConnectResult {
    let graph = cloneGraph(ctx.groupGraph);
    const remaining = new Set(remainingVertices);
    const connected = new Set(connectedVertices);

    let degInc = 0;

    while (remaining.size > 1) {
        let best: DiameterCandidate | undefined;
        let bestTarget: VertexId | undefined;

        for (const source of remaining) {
            if (degreeOf(graph, source) >= degreeLimitOf(ctx.globalGraph, source) + degInc) {
                continue;
            }

            const sourceEccentricity =
                degreeOf(graph, source) > 0 ? worstCaseDist(graph, source) : 0;

            for (const target of remaining) {
                if (source === target) continue;
                if (degreeOf(graph, target) >= degreeLimitOf(ctx.globalGraph, target) + degInc) {
                    continue;
                }
                if (!ctx.globalGraph.hasEdge(source, target)) continue;

                const targetEccentricity =
                    degreeOf(graph, target) > 0 ? worstCaseDist(graph, target) : 0;

                const linkWeight = edgeWeightOf(ctx.globalGraph, source, target);
                const newDiameter = Math.max(
                    sourceEccentricity,
                    linkWeight + targetEccentricity,
                );

                if (
                    best === undefined ||
                    newDiameter < best.diameter ||
                    (newDiameter === best.diameter &&
                        `${source}:${target}` < `${best.from}:${best.to}`)
                ) {
                    best = {
                        from: source,
                        to: target,
                        diameter: newDiameter,
                    };
                    bestTarget = target;
                }
            }
        }

        if (best === undefined || bestTarget === undefined) {
            degInc++;
            if (degInc >= Number.MAX_SAFE_INTEGER - 1) {
                break;
            }
        } else {
            graph.addEdge(best.from, best.to, {
                from: best.from,
                to: best.to,
                weight: edgeWeightOf(ctx.globalGraph, best.from, best.to),
            });

            remaining.delete(bestTarget);
            connected.add(bestTarget);
        }
    }

    return {
        graph,
        connectedVertices: connected,
        remainingVertices: remaining,
    };
}

export function connectSearchMDE(
    ctx: ConnectContext,
    remainingVertices: ReadonlySet<VertexId>,
    connectedVertices: ReadonlySet<VertexId>,
): ConnectResult {
    let graph = cloneGraph(ctx.groupGraph);
    const remaining = new Set(remainingVertices);
    const connected = new Set(connectedVertices);

    let degInc = 0;

    while (remaining.size > 1) {
        let best: DiameterCandidate | undefined;
        let bestTarget: VertexId | undefined;

        for (const source of remaining) {
            if (degreeOf(graph, source) >= degreeLimitOf(ctx.globalGraph, source) + degInc) {
                continue;
            }

            const sourceEccentricity =
                degreeOf(graph, source) > 0 ? worstCaseDist(graph, source) : 0;

            for (const target of remaining) {
                if (source === target) continue;
                if (degreeOf(graph, target) >= degreeLimitOf(ctx.globalGraph, target) + degInc) {
                    continue;
                }

                const candidate = findMDEdge(
                    ctx.globalGraph,
                    graph,
                    source,
                    target,
                    sourceEccentricity,
                );
                if (!candidate) continue;

                if (
                    best === undefined ||
                    candidate.diameter < best.diameter ||
                    (candidate.diameter === best.diameter &&
                        `${candidate.from}:${candidate.to}` < `${best.from}:${best.to}`)
                ) {
                    best = candidate;
                    bestTarget = target;
                }
            }
        }

        if (best === undefined || bestTarget === undefined) {
            degInc++;
            if (degInc >= Number.MAX_SAFE_INTEGER - 1) {
                break;
            }
        } else {
            graph.addEdge(best.from, best.to, {
                from: best.from,
                to: best.to,
                weight: edgeWeightOf(ctx.globalGraph, best.from, best.to),
            });

            remaining.delete(bestTarget);
            connected.add(bestTarget);
        }
    }

    return {
        graph,
        connectedVertices: connected,
        remainingVertices: remaining,
    };
}

function getAvailableOutDegree(
    graph: TreeGraph,
    globalGraph: TreeGraph,
    vertices: ReadonlySet<VertexId>,
): number {
    let total = 0;

    for (const v of vertices) {
        total += Math.max(0, degreeLimitOf(globalGraph, v) - degreeOf(graph, v));
    }

    return total;
}