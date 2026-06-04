import type { WeightedGraph, VertexId } from './graph-props.ts';

export type GroupTopologyValidationIssue = Readonly<{
    code:
        | 'missing-active-session'
        | 'inactive-session-present'
        | 'disconnected'
        | 'degree-limit-exceeded';
    sessionId?: VertexId;
    degree?: number;
    maxDegree?: number;
}>;

export type GroupTopologyValidationInput = Readonly<{
    graph: WeightedGraph;
    activeSessionIds: ReadonlySet<VertexId>;
    maxDegree?: number;
    requireConnected?: boolean;
}>;

export type GroupTopologyValidationResult = Readonly<{
    valid: boolean;
    issues: readonly GroupTopologyValidationIssue[];
    missingSessionIds: readonly VertexId[];
    inactiveSessionIds: readonly VertexId[];
    overDegreeSessionIds: readonly VertexId[];
}>;

export function validateGroupTopology(
    input: GroupTopologyValidationInput,
): GroupTopologyValidationResult {
    const requireConnected = input.requireConnected ?? true;
    const graphSessionIds = new Set(input.graph.nodes() as VertexId[]);
    const issues: GroupTopologyValidationIssue[] = [];
    const missingSessionIds: VertexId[] = [];
    const inactiveSessionIds: VertexId[] = [];
    const overDegreeSessionIds: VertexId[] = [];

    for (const sessionId of input.activeSessionIds) {
        if (!graphSessionIds.has(sessionId)) {
            missingSessionIds.push(sessionId);
            issues.push({
                code: 'missing-active-session',
                sessionId,
            });
        }
    }

    for (const sessionId of graphSessionIds) {
        if (!input.activeSessionIds.has(sessionId)) {
            inactiveSessionIds.push(sessionId);
            issues.push({
                code: 'inactive-session-present',
                sessionId,
            });
        }

        const maxDegree = input.maxDegree ??
            input.graph.getNodeAttributes(sessionId).degreeLimit;
        const degree = input.graph.degree(sessionId);

        if (degree > maxDegree) {
            overDegreeSessionIds.push(sessionId);
            issues.push({
                code: 'degree-limit-exceeded',
                sessionId,
                degree,
                maxDegree,
            });
        }
    }

    if (
        requireConnected &&
        input.activeSessionIds.size > 1 &&
        !isConnected(input.graph)
    ) {
        issues.push({
            code: 'disconnected',
        });
    }

    return {
        valid: issues.length === 0,
        issues,
        missingSessionIds,
        inactiveSessionIds,
        overDegreeSessionIds,
    };
}

function isConnected(graph: WeightedGraph): boolean {
    const nodes = graph.nodes() as VertexId[];
    if (nodes.length <= 1) {
        return true;
    }

    const visited = new Set<VertexId>();
    const queue: VertexId[] = [nodes[0]];
    visited.add(nodes[0]);

    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const neighbor of graph.neighbors(current) as VertexId[]) {
            if (visited.has(neighbor)) continue;
            visited.add(neighbor);
            queue.push(neighbor);
        }
    }

    return visited.size === nodes.length;
}

