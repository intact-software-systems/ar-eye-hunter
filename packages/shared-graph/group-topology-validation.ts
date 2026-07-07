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

export type GroupTopologyNextHopValidationInput = Readonly<{
    nextHopsBySessionId: Readonly<Record<string, readonly VertexId[]>>;
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

export function validateGroupTopologyNextHops(
    input: GroupTopologyNextHopValidationInput,
): GroupTopologyValidationResult {
    const requireConnected = input.requireConnected ?? true;
    const topologySessionIds = new Set<VertexId>();
    const adjacency = new Map<VertexId, Set<VertexId>>();
    const issues: GroupTopologyValidationIssue[] = [];
    const missingSessionIds: VertexId[] = [];
    const inactiveSessionIds: VertexId[] = [];
    const overDegreeSessionIds: VertexId[] = [];

    for (const [sessionId, nextHops] of Object.entries(input.nextHopsBySessionId)) {
        topologySessionIds.add(sessionId);
        const neighbors = getOrCreateSet(adjacency, sessionId);
        for (const nextHop of nextHops) {
            topologySessionIds.add(nextHop);
            neighbors.add(nextHop);
            getOrCreateSet(adjacency, nextHop).add(sessionId);
        }
    }

    for (const sessionId of input.activeSessionIds) {
        if (!Object.prototype.hasOwnProperty.call(input.nextHopsBySessionId, sessionId)) {
            missingSessionIds.push(sessionId);
        }
    }

    for (const sessionId of topologySessionIds) {
        if (!input.activeSessionIds.has(sessionId)) {
            inactiveSessionIds.push(sessionId);
        }

        const degree = adjacency.get(sessionId)?.size ?? 0;
        if (input.maxDegree !== undefined && degree > input.maxDegree) {
            overDegreeSessionIds.push(sessionId);
        }
    }

    for (const sessionId of missingSessionIds) {
        issues.push({
            code: 'missing-active-session',
            sessionId,
        });
    }
    for (const sessionId of inactiveSessionIds) {
        issues.push({
            code: 'inactive-session-present',
            sessionId,
        });
    }
    for (const sessionId of overDegreeSessionIds) {
        issues.push({
            code: 'degree-limit-exceeded',
            sessionId,
            degree: adjacency.get(sessionId)?.size ?? 0,
            maxDegree: input.maxDegree,
        });
    }

    if (
        requireConnected &&
        input.activeSessionIds.size > 1 &&
        !isNextHopMapConnected(input.activeSessionIds, adjacency)
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

function getOrCreateSet(
    map: Map<VertexId, Set<VertexId>>,
    key: VertexId,
): Set<VertexId> {
    const existing = map.get(key);
    if (existing) {
        return existing;
    }

    const next = new Set<VertexId>();
    map.set(key, next);
    return next;
}

function isNextHopMapConnected(
    activeSessionIds: ReadonlySet<VertexId>,
    adjacency: ReadonlyMap<VertexId, ReadonlySet<VertexId>>,
): boolean {
    const first = activeSessionIds.values().next().value as VertexId | undefined;
    if (first === undefined) {
        return true;
    }

    const visited = new Set<VertexId>();
    const queue: VertexId[] = [first];
    visited.add(first);

    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const neighbor of adjacency.get(current) ?? []) {
            if (!activeSessionIds.has(neighbor) || visited.has(neighbor)) continue;
            visited.add(neighbor);
            queue.push(neighbor);
        }
    }

    return visited.size === activeSessionIds.size;
}
