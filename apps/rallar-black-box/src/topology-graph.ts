import { MultiDirectedGraph } from 'graphology';
import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestState,
} from '@shared-test/rallar-bb-test/types.ts';

export type RallarTopologyNodeKind =
    | 'run'
    | 'agent'
    | 'room'
    | 'session'
    | 'actor'
    | 'connection'
    | 'message';

export type RallarTopologyEdgeKind =
    | 'control'
    | 'membership'
    | 'identity'
    | 'connection'
    | 'route'
    | 'diagnostic';

export type RallarTopologyStatus = 'active' | 'degraded' | 'failed';

export type RallarTopologyFilter = 'all' | RallarTopologyStatus;

export type RallarTopologyNodeAttributes = Readonly<{
    label: string;
    kind: RallarTopologyNodeKind;
    status: RallarTopologyStatus;
    color: string;
    size: number;
    x: number;
    y: number;
    eventCount: number;
    lastEventAtEpochMs?: number;
}>;

export type RallarTopologyEdgeAttributes = Readonly<{
    label: string;
    kind: RallarTopologyEdgeKind;
    status: RallarTopologyStatus;
    color: string;
    size: number;
    eventCount: number;
    lastEventAtEpochMs?: number;
}>;

export type RallarTopologyGraphAttributes = Readonly<{
    generatedAtEpochMs: number;
    runId?: string;
    agentId?: string;
}>;

export type RallarTopologyGraph = MultiDirectedGraph<
    RallarTopologyNodeAttributes,
    RallarTopologyEdgeAttributes,
    RallarTopologyGraphAttributes
>;

export type RallarTopologySummary = Readonly<{
    nodes: number;
    edges: number;
    activeNodes: number;
    degradedNodes: number;
    failedNodes: number;
    activeEdges: number;
    degradedEdges: number;
    failedEdges: number;
    rooms: number;
    sessions: number;
    routes: number;
}>;

export type RallarTopologySnapshot = Readonly<{
    graph: RallarTopologyGraph;
    summary: RallarTopologySummary;
}>;

const NODE_COLORS: Record<RallarTopologyNodeKind, string> = {
    run: '#304c89',
    agent: '#226a44',
    room: '#8a5a00',
    session: '#0c6f7b',
    actor: '#7a4ea3',
    connection: '#4d5b65',
    message: '#b24b3b',
};

const STATUS_COLORS: Record<RallarTopologyStatus, string> = {
    active: '#226a44',
    degraded: '#96610d',
    failed: '#a83232',
};

const NODE_KIND_ORDER: Record<RallarTopologyNodeKind, number> = {
    run: 0,
    agent: 1,
    actor: 2,
    connection: 3,
    room: 4,
    session: 5,
    message: 6,
};

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function asArray(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function stringArray(value: unknown): readonly string[] {
    return asArray(value)
        .map(entry => stringValue(entry))
        .filter((entry): entry is string => Boolean(entry));
}

function unique(values: readonly (string | undefined)[]): readonly string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function statusFromEvent(event: RallarBlackBoxTestEvent): RallarTopologyStatus {
    const topic = event.topic.toLowerCase();
    if (
        event.severity === 'error' ||
        topic.includes('failed') ||
        topic.includes('failure') ||
        topic.includes('timeout') ||
        topic.includes('mismatch') ||
        topic.includes('not_found')
    ) {
        return 'failed';
    }

    if (event.severity === 'warning' || topic.includes('degraded') || topic.includes('stale')) {
        return 'degraded';
    }

    return 'active';
}

function mergeStatus(
    left: RallarTopologyStatus,
    right: RallarTopologyStatus,
): RallarTopologyStatus {
    if (left === 'failed' || right === 'failed') return 'failed';
    if (left === 'degraded' || right === 'degraded') return 'degraded';
    return 'active';
}

function nodeId(kind: RallarTopologyNodeKind, id: string): string {
    return `${kind}:${id}`;
}

function readableId(value: string): string {
    return value.length > 28 ? `${value.slice(0, 25)}...` : value;
}

function payloadOf(event: RallarBlackBoxTestEvent): Record<string, unknown> {
    return asRecord(event.payload);
}

function nestedDataOf(event: RallarBlackBoxTestEvent): Record<string, unknown> {
    return asRecord(payloadOf(event).data);
}

function roomIdFrom(
    state: RallarBlackBoxTestState,
    event?: RallarBlackBoxTestEvent,
): string | undefined {
    const payload = event ? payloadOf(event) : {};
    const data = event ? nestedDataOf(event) : {};
    return stringValue(payload.roomId) ??
        stringValue(data.roomId) ??
        state.currentConfig?.roomId;
}

function addOrUpdateNode(
    graph: RallarTopologyGraph,
    id: string,
    attrs: Omit<RallarTopologyNodeAttributes, 'x' | 'y'>,
): void {
    if (!graph.hasNode(id)) {
        graph.addNode(id, {
            ...attrs,
            x: 0,
            y: 0,
        });
        return;
    }

    const current = graph.getNodeAttributes(id);
    const status = mergeStatus(current.status, attrs.status);
    graph.mergeNodeAttributes(id, {
        ...current,
        status,
        color: status === 'active' ? current.color : STATUS_COLORS[status],
        eventCount: current.eventCount + attrs.eventCount,
        lastEventAtEpochMs: Math.max(
            current.lastEventAtEpochMs ?? 0,
            attrs.lastEventAtEpochMs ?? 0,
        ) || undefined,
    });
}

function addNode(
    graph: RallarTopologyGraph,
    kind: RallarTopologyNodeKind,
    id: string | undefined,
    options: Readonly<{
        label?: string;
        status?: RallarTopologyStatus;
        eventAtEpochMs?: number;
        eventCount?: number;
    }> = {},
): string | undefined {
    if (!id) {
        return undefined;
    }

    const key = nodeId(kind, id);
    const status = options.status ?? 'active';
    addOrUpdateNode(graph, key, {
        label: options.label ?? readableId(id),
        kind,
        status,
        color: status === 'active' ? NODE_COLORS[kind] : STATUS_COLORS[status],
        size: kind === 'room' || kind === 'run' ? 12 : kind === 'message' ? 7 : 9,
        eventCount: options.eventCount ?? 1,
        lastEventAtEpochMs: options.eventAtEpochMs,
    });
    return key;
}

function addEdge(
    graph: RallarTopologyGraph,
    source: string | undefined,
    target: string | undefined,
    kind: RallarTopologyEdgeKind,
    label: string,
    options: Readonly<{
        status?: RallarTopologyStatus;
        eventAtEpochMs?: number;
    }> = {},
): void {
    if (!source || !target || source === target) {
        return;
    }

    const status = options.status ?? 'active';
    const key = `${kind}:${source}->${target}`;
    const attrs: RallarTopologyEdgeAttributes = {
        label,
        kind,
        status,
        color: STATUS_COLORS[status],
        size: kind === 'route' ? 2.4 : 1.4,
        eventCount: 1,
        lastEventAtEpochMs: options.eventAtEpochMs,
    };

    if (!graph.hasEdge(key)) {
        graph.addDirectedEdgeWithKey(key, source, target, attrs);
        return;
    }

    const current = graph.getEdgeAttributes(key);
    const nextStatus = mergeStatus(current.status, status);
    graph.mergeEdgeWithKey(key, source, target, {
        ...current,
        status: nextStatus,
        color: STATUS_COLORS[nextStatus],
        eventCount: current.eventCount + 1,
        lastEventAtEpochMs: Math.max(
            current.lastEventAtEpochMs ?? 0,
            options.eventAtEpochMs ?? 0,
        ) || undefined,
    });
}

function messageTargets(event: RallarBlackBoxTestEvent): readonly string[] {
    const payload = payloadOf(event);
    const data = nestedDataOf(event);
    return unique([
        ...stringArray(payload.peerIds),
        ...stringArray(payload.nextHopPeerIds),
        ...stringArray(payload.observedClients),
        ...stringArray(data.targets),
        ...stringArray(data.peerIds),
        ...stringArray(data.nextHopPeerIds),
        stringValue(payload.remotePeerId),
    ]);
}

function senderId(event: RallarBlackBoxTestEvent): string | undefined {
    const payload = payloadOf(event);
    const data = nestedDataOf(event);
    return stringValue(payload.senderId) ??
        stringValue(payload.peerId) ??
        stringValue(data.senderId) ??
        event.actor ??
        event.connection;
}

function collectSessionIds(event: RallarBlackBoxTestEvent): readonly string[] {
    const payload = payloadOf(event);
    const data = nestedDataOf(event);
    return unique([
        stringValue(payload.sessionId),
        stringValue(payload.peerId),
        stringValue(payload.remotePeerId),
        stringValue(payload.senderId),
        stringValue(data.senderId),
        ...stringArray(payload.peerIds),
        ...stringArray(payload.nextHopPeerIds),
        ...stringArray(payload.expectedClients),
        ...stringArray(payload.observedClients),
        ...stringArray(payload.connectedClients),
    ]);
}

function assignLayout(graph: RallarTopologyGraph): void {
    const byKind = new Map<RallarTopologyNodeKind, string[]>();
    graph.forEachNode((key, attrs) => {
        const list = byKind.get(attrs.kind) ?? [];
        list.push(key);
        byKind.set(attrs.kind, list);
    });

    byKind.forEach((nodes, kind) => {
        const sorted = nodes.sort((left, right) =>
            graph.getNodeAttribute(left, 'label').localeCompare(graph.getNodeAttribute(right, 'label'))
        );
        const x = NODE_KIND_ORDER[kind] * 2.2;
        const center = (sorted.length - 1) / 2;
        sorted.forEach((key, index) => {
            graph.setNodeAttribute(key, 'x', x);
            graph.setNodeAttribute(key, 'y', (index - center) * 1.25);
        });
    });
}

function summarize(graph: RallarTopologyGraph): RallarTopologySummary {
    let activeNodes = 0;
    let degradedNodes = 0;
    let failedNodes = 0;
    let rooms = 0;
    let sessions = 0;
    graph.forEachNode((_key, attrs) => {
        if (attrs.status === 'failed') failedNodes += 1;
        else if (attrs.status === 'degraded') degradedNodes += 1;
        else activeNodes += 1;
        if (attrs.kind === 'room') rooms += 1;
        if (attrs.kind === 'session') sessions += 1;
    });

    let activeEdges = 0;
    let degradedEdges = 0;
    let failedEdges = 0;
    let routes = 0;
    graph.forEachEdge((_key, attrs) => {
        if (attrs.status === 'failed') failedEdges += 1;
        else if (attrs.status === 'degraded') degradedEdges += 1;
        else activeEdges += 1;
        if (attrs.kind === 'route') routes += 1;
    });

    return {
        nodes: graph.order,
        edges: graph.size,
        activeNodes,
        degradedNodes,
        failedNodes,
        activeEdges,
        degradedEdges,
        failedEdges,
        rooms,
        sessions,
        routes,
    };
}

export function deriveRallarTopologyGraph(
    state: RallarBlackBoxTestState,
): RallarTopologySnapshot {
    const graph: RallarTopologyGraph = new MultiDirectedGraph();
    const config = state.currentConfig;
    graph.replaceAttributes({
        generatedAtEpochMs: Date.now(),
        runId: config?.runId,
        agentId: config?.agentId,
    });

    const run = addNode(graph, 'run', config?.runId, { label: config?.runId });
    const agent = addNode(graph, 'agent', config?.agentId, { label: config?.agentId });
    const actor = addNode(graph, 'actor', config?.actor, { label: config?.actor });
    const room = addNode(graph, 'room', config?.roomId, { label: config?.roomId });
    const session = addNode(graph, 'session', config?.sessionId, { label: config?.sessionId });
    const connection = addNode(
        graph,
        'connection',
        String(config?.defaults?.connection ?? '') || undefined,
    );
    addEdge(graph, run, agent, 'control', 'agent');
    addEdge(graph, agent, actor, 'identity', 'actor');
    addEdge(graph, actor, session, 'identity', 'session');
    addEdge(graph, connection, session, 'connection', 'uses');
    addEdge(graph, session, room, 'membership', 'member');

    for (const event of state.events) {
        const status = statusFromEvent(event);
        const eventRoom = addNode(graph, 'room', roomIdFrom(state, event), {
            status,
            eventAtEpochMs: event.atEpochMs,
        });
        const eventActor = addNode(graph, 'actor', event.actor, {
            status,
            eventAtEpochMs: event.atEpochMs,
        });
        const eventConnection = addNode(graph, 'connection', event.connection, {
            status,
            eventAtEpochMs: event.atEpochMs,
        });
        if (eventActor && eventConnection) {
            addEdge(graph, eventActor, eventConnection, 'connection', 'opens', {
                status,
                eventAtEpochMs: event.atEpochMs,
            });
        }

        for (const sessionId of collectSessionIds(event)) {
            const eventSession = addNode(graph, 'session', sessionId, {
                status,
                eventAtEpochMs: event.atEpochMs,
            });
            addEdge(graph, eventSession, eventRoom, 'membership', 'member', {
                status,
                eventAtEpochMs: event.atEpochMs,
            });
            addEdge(graph, eventConnection, eventSession, 'connection', 'observed', {
                status,
                eventAtEpochMs: event.atEpochMs,
            });
        }

        if (event.kind === 'message') {
            const sourceSession = addNode(graph, 'session', senderId(event), {
                status,
                eventAtEpochMs: event.atEpochMs,
            });
            const targets = messageTargets(event);
            if (targets.length === 0) {
                addEdge(graph, sourceSession, eventRoom, 'route', 'broadcast', {
                    status,
                    eventAtEpochMs: event.atEpochMs,
                });
            } else {
                for (const target of targets) {
                    const targetSession = addNode(graph, 'session', target, {
                        status,
                        eventAtEpochMs: event.atEpochMs,
                    });
                    addEdge(graph, sourceSession, targetSession, 'route', 'message', {
                        status,
                        eventAtEpochMs: event.atEpochMs,
                    });
                }
            }
        } else if (status !== 'active') {
            const diagnostic = addNode(graph, 'message', event.eventId, {
                label: event.topic,
                status,
                eventAtEpochMs: event.atEpochMs,
            });
            addEdge(graph, eventConnection ?? eventRoom, diagnostic, 'diagnostic', event.kind, {
                status,
                eventAtEpochMs: event.atEpochMs,
            });
        }
    }

    assignLayout(graph);
    return {
        graph,
        summary: summarize(graph),
    };
}

export function visibleTopologyCounts(
    graph: RallarTopologyGraph,
    filter: RallarTopologyFilter,
): Readonly<{ nodes: number; edges: number }> {
    if (filter === 'all') {
        return {
            nodes: graph.order,
            edges: graph.size,
        };
    }

    let nodes = 0;
    let edges = 0;
    graph.forEachNode((_key, attrs) => {
        if (attrs.status === filter) nodes += 1;
    });
    graph.forEachEdge((_key, attrs) => {
        if (attrs.status === filter) edges += 1;
    });
    return { nodes, edges };
}
