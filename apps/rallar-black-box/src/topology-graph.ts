import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestState
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { MultiDirectedGraph } from 'graphology';

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
    /** Absent until an event reaches this node. */
    lastEventAtEpochMs?: number;
}>;

export type RallarTopologyEdgeAttributes = Readonly<{
    label: string;
    kind: RallarTopologyEdgeKind;
    status: RallarTopologyStatus;
    color: string;
    size: number;
    eventCount: number;
    /** Absent until an event reaches this edge. */
    lastEventAtEpochMs?: number;
}>;

export type RallarTopologyGraphAttributes = Readonly<{
    generatedAtEpochMs: number;
    /** Absent when the runtime holds no configured run. */
    runId?: string;
    /** Absent when the runtime holds no configured agent. */
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
    message: '#b24b3b'
};

const STATUS_COLORS: Record<RallarTopologyStatus, string> = {
    active: '#226a44',
    degraded: '#96610d',
    failed: '#a83232'
};

const NODE_KIND_ORDER: Record<RallarTopologyNodeKind, number> = {
    run: 0,
    agent: 1,
    actor: 2,
    connection: 3,
    room: 4,
    session: 5,
    message: 6
};

function isJsonObject(value: unknown): value is ApiJsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The non-blank text a payload field carries, or `undefined` when it carries none. */
function decodeText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function decodeTexts(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
            const text = decodeText(entry);
            return text === undefined ? [] : [text];
        })
        : [];
}

function toSortedDistinctTexts(values: readonly (string | undefined)[]): readonly string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function toStatusForEvent(event: RallarBlackBoxTestEvent): RallarTopologyStatus {
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

function toMergedStatus(
    left: RallarTopologyStatus,
    right: RallarTopologyStatus
): RallarTopologyStatus {
    if (left === 'failed' || right === 'failed') {
        return 'failed';
    }
    if (left === 'degraded' || right === 'degraded') {
        return 'degraded';
    }
    return 'active';
}

function toNodeKey(kind: RallarTopologyNodeKind, id: string): string {
    return `${kind}:${id}`;
}

function toReadableId(value: string): string {
    return value.length > 28 ? `${value.slice(0, 25)}...` : value;
}

function toEventPayload(event: RallarBlackBoxTestEvent): ApiJsonObject {
    return isJsonObject(event.payload) ? event.payload : {};
}

/** The payload's own nested `data` object, which several runtime topics wrap their facts in. */
function toNestedEventPayload(event: RallarBlackBoxTestEvent): ApiJsonObject {
    const nested = toEventPayload(event).data;
    return isJsonObject(nested) ? nested : {};
}

function resolveRoomId(
    state: RallarBlackBoxTestState,
    event: RallarBlackBoxTestEvent
): string | undefined {
    return decodeText(toEventPayload(event).roomId) ??
        decodeText(toNestedEventPayload(event).roomId) ??
        state.currentConfig?.roomId;
}

function appendOrMergeNode(
    graph: RallarTopologyGraph,
    id: string,
    attrs: Omit<RallarTopologyNodeAttributes, 'x' | 'y'>
): void {
    if (!graph.hasNode(id)) {
        graph.addNode(id, {
            ...attrs,
            x: 0,
            y: 0
        });
        return;
    }

    const current = graph.getNodeAttributes(id);
    const status = toMergedStatus(current.status, attrs.status);
    graph.mergeNodeAttributes(id, {
        ...current,
        status,
        color: status === 'active' ? current.color : STATUS_COLORS[status],
        eventCount: current.eventCount + attrs.eventCount,
        lastEventAtEpochMs: Math.max(
            current.lastEventAtEpochMs ?? 0,
            attrs.lastEventAtEpochMs ?? 0
        ) || undefined
    });
}

interface AppendTopologyNodeInput {
    readonly graph: RallarTopologyGraph;
    readonly kind: RallarTopologyNodeKind;
    /** The node's id, or `undefined` when the runtime names none and no node is appended. */
    readonly id: string | undefined;
    /** The node's label, or `undefined` to shorten its id instead. */
    readonly label: string | undefined;
    readonly status: RallarTopologyStatus;
    /** When the event that reached this node happened, or `undefined` for a configured node. */
    readonly eventAtEpochMs: number | undefined;
}

/** The node's key, or `undefined` when the input names no id. */
function appendTopologyNode(input: AppendTopologyNodeInput): string | undefined {
    const { graph, kind, id, status } = input;
    if (!id) {
        return undefined;
    }

    const key = toNodeKey(kind, id);
    appendOrMergeNode(graph, key, {
        label: input.label ?? toReadableId(id),
        kind,
        status,
        color: status === 'active' ? NODE_COLORS[kind] : STATUS_COLORS[status],
        size: kind === 'room' || kind === 'run' ? 12 : kind === 'message' ? 7 : 9,
        eventCount: 1,
        lastEventAtEpochMs: input.eventAtEpochMs
    });
    return key;
}

interface AppendTopologyEdgeInput {
    readonly graph: RallarTopologyGraph;
    /** The source node key, or `undefined` when its node was not appended. */
    readonly source: string | undefined;
    /** The target node key, or `undefined` when its node was not appended. */
    readonly target: string | undefined;
    readonly kind: RallarTopologyEdgeKind;
    readonly label: string;
    readonly status: RallarTopologyStatus;
    /** When the event that reached this edge happened, or `undefined` for a configured edge. */
    readonly eventAtEpochMs: number | undefined;
}

function appendTopologyEdge(input: AppendTopologyEdgeInput): void {
    const { graph, source, target, kind, label, status } = input;
    if (!source || !target || source === target) {
        return;
    }

    const key = `${kind}:${source}->${target}`;
    const attrs: RallarTopologyEdgeAttributes = {
        label,
        kind,
        status,
        color: STATUS_COLORS[status],
        size: kind === 'route' ? 2.4 : 1.4,
        eventCount: 1,
        lastEventAtEpochMs: input.eventAtEpochMs
    };

    if (!graph.hasEdge(key)) {
        graph.addDirectedEdgeWithKey(key, source, target, attrs);
        return;
    }

    const current = graph.getEdgeAttributes(key);
    const nextStatus = toMergedStatus(current.status, status);
    graph.mergeEdgeWithKey(key, source, target, {
        ...current,
        status: nextStatus,
        color: STATUS_COLORS[nextStatus],
        eventCount: current.eventCount + 1,
        lastEventAtEpochMs: Math.max(
            current.lastEventAtEpochMs ?? 0,
            input.eventAtEpochMs ?? 0
        ) || undefined
    });
}

function toMessageTargets(event: RallarBlackBoxTestEvent): readonly string[] {
    const payload = toEventPayload(event);
    const nested = toNestedEventPayload(event);
    const browserSender = decodeText(payload.senderId) ?? decodeText(payload.remotePeerId);
    const browserReceiver = decodeText(payload.peerId);
    if (
        event.topic.startsWith('rallar.browser.') &&
        browserSender &&
        browserReceiver &&
        browserSender !== browserReceiver
    ) {
        return [browserReceiver];
    }

    return toSortedDistinctTexts([
        ...decodeTexts(payload.peerIds),
        ...decodeTexts(payload.nextHopPeerIds),
        ...decodeTexts(payload.observedClients),
        ...decodeTexts(nested.targets),
        ...decodeTexts(nested.peerIds),
        ...decodeTexts(nested.nextHopPeerIds),
        decodeText(payload.remotePeerId)
    ]);
}

function resolveSenderId(event: RallarBlackBoxTestEvent): string | undefined {
    const payload = toEventPayload(event);
    const nested = toNestedEventPayload(event);
    if (event.topic.startsWith('rallar.browser.')) {
        return decodeText(payload.senderId) ??
            decodeText(payload.remotePeerId) ??
            decodeText(nested.senderId) ??
            decodeText(payload.peerId) ??
            event.actor ??
            event.connection;
    }

    return decodeText(payload.senderId) ??
        decodeText(payload.peerId) ??
        decodeText(nested.senderId) ??
        event.actor ??
        event.connection;
}

function toSessionIds(event: RallarBlackBoxTestEvent): readonly string[] {
    const payload = toEventPayload(event);
    const nested = toNestedEventPayload(event);
    return toSortedDistinctTexts([
        decodeText(payload.sessionId),
        decodeText(payload.peerId),
        decodeText(payload.remotePeerId),
        decodeText(payload.senderId),
        decodeText(nested.senderId),
        ...decodeTexts(payload.peerIds),
        ...decodeTexts(payload.nextHopPeerIds),
        ...decodeTexts(payload.expectedClients),
        ...decodeTexts(payload.observedClients),
        ...decodeTexts(payload.connectedClients)
    ]);
}

function setTopologyLayout(graph: RallarTopologyGraph): void {
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

function toTopologySummary(graph: RallarTopologyGraph): RallarTopologySummary {
    let activeNodes = 0;
    let degradedNodes = 0;
    let failedNodes = 0;
    let rooms = 0;
    let sessions = 0;
    graph.forEachNode((_key, attrs) => {
        if (attrs.status === 'failed') {
            failedNodes += 1;
        }
        else if (attrs.status === 'degraded') {
            degradedNodes += 1;
        }
        else {
            activeNodes += 1;
        }
        if (attrs.kind === 'room') {
            rooms += 1;
        }
        if (attrs.kind === 'session') {
            sessions += 1;
        }
    });

    let activeEdges = 0;
    let degradedEdges = 0;
    let failedEdges = 0;
    let routes = 0;
    graph.forEachEdge((_key, attrs) => {
        if (attrs.status === 'failed') {
            failedEdges += 1;
        }
        else if (attrs.status === 'degraded') {
            degradedEdges += 1;
        }
        else {
            activeEdges += 1;
        }
        if (attrs.kind === 'route') {
            routes += 1;
        }
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
        routes
    };
}

export function computeRallarTopologyGraph(
    state: RallarBlackBoxTestState,
    nowEpochMs: number
): RallarTopologySnapshot {
    const graph: RallarTopologyGraph = new MultiDirectedGraph();
    const config = state.currentConfig;
    graph.replaceAttributes({
        generatedAtEpochMs: nowEpochMs,
        runId: config?.runId,
        agentId: config?.agentId
    });

    appendConfiguredTopology(graph, state);
    for (const event of state.events) {
        appendEventTopology({ graph, state, event });
    }

    setTopologyLayout(graph);
    return {
        graph,
        summary: toTopologySummary(graph)
    };
}

function appendConfiguredTopology(
    graph: RallarTopologyGraph,
    state: RallarBlackBoxTestState
): void {
    const config = state.currentConfig;
    const run = appendConfiguredNode(graph, 'run', config?.runId);
    const agent = appendConfiguredNode(graph, 'agent', config?.agentId);
    const actor = appendConfiguredNode(graph, 'actor', config?.actor);
    const room = appendConfiguredNode(graph, 'room', config?.roomId);
    const session = appendConfiguredNode(graph, 'session', config?.sessionId);
    const connection = appendTopologyNode({
        graph,
        kind: 'connection',
        id: String(config?.defaults?.connection ?? '') || undefined,
        label: undefined,
        status: 'active',
        eventAtEpochMs: undefined
    });
    appendConfiguredEdge(graph, { source: run, target: agent, kind: 'control', label: 'agent' });
    appendConfiguredEdge(graph, { source: agent, target: actor, kind: 'identity', label: 'actor' });
    appendConfiguredEdge(graph, { source: actor, target: session, kind: 'identity', label: 'session' });
    appendConfiguredEdge(graph, { source: connection, target: session, kind: 'connection', label: 'uses' });
    appendConfiguredEdge(graph, { source: session, target: room, kind: 'membership', label: 'member' });
}

/** A node the current configuration names, labelled with the id the operator configured. */
function appendConfiguredNode(
    graph: RallarTopologyGraph,
    kind: RallarTopologyNodeKind,
    id: string | undefined
): string | undefined {
    return appendTopologyNode({
        graph,
        kind,
        id,
        label: id,
        status: 'active',
        eventAtEpochMs: undefined
    });
}

/** One edge as its caller names it: which nodes it joins, and what kind of link it is. */
type TopologyEdgeLink = Readonly<{
    /** The source node key, or `undefined` when its node was not appended. */
    source: string | undefined;
    /** The target node key, or `undefined` when its node was not appended. */
    target: string | undefined;
    kind: RallarTopologyEdgeKind;
    label: string;
}>;

function appendConfiguredEdge(graph: RallarTopologyGraph, edge: TopologyEdgeLink): void {
    appendTopologyEdge({
        graph,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        label: edge.label,
        status: 'active',
        eventAtEpochMs: undefined
    });
}

interface AppendEventTopologyInput {
    readonly graph: RallarTopologyGraph;
    readonly state: RallarBlackBoxTestState;
    readonly event: RallarBlackBoxTestEvent;
}

function appendEventTopology(input: AppendEventTopologyInput): void {
    const { graph, state, event } = input;
    const observation: TopologyObservation = {
        graph,
        status: toStatusForEvent(event),
        eventAtEpochMs: event.atEpochMs
    };
    const eventRoom = appendObservedNode(observation, 'room', resolveRoomId(state, event));
    const eventActor = appendObservedNode(observation, 'actor', event.actor);
    const eventConnection = appendObservedNode(observation, 'connection', event.connection);
    if (eventActor && eventConnection) {
        appendObservedEdge(observation, {
            source: eventActor,
            target: eventConnection,
            kind: 'connection',
            label: 'opens'
        });
    }

    for (const sessionId of toSessionIds(event)) {
        const eventSession = appendObservedNode(observation, 'session', sessionId);
        appendObservedEdge(observation, {
            source: eventSession,
            target: eventRoom,
            kind: 'membership',
            label: 'member'
        });
        appendObservedEdge(observation, {
            source: eventConnection,
            target: eventSession,
            kind: 'connection',
            label: 'observed'
        });
    }

    if (event.kind === 'message') {
        appendMessageRoutes({ observation, event, eventRoom });
        return;
    }
    if (observation.status !== 'active') {
        appendDiagnosticNode({ observation, event, eventRoom, eventConnection });
    }
}

/** What one event says about the graph: which graph, and when it was seen in what state. */
type TopologyObservation = Readonly<{
    graph: RallarTopologyGraph;
    status: RallarTopologyStatus;
    eventAtEpochMs: number;
}>;

function appendObservedNode(
    observation: TopologyObservation,
    kind: RallarTopologyNodeKind,
    id: string | undefined
): string | undefined {
    return appendTopologyNode({
        graph: observation.graph,
        kind,
        id,
        label: undefined,
        status: observation.status,
        eventAtEpochMs: observation.eventAtEpochMs
    });
}

function appendObservedEdge(observation: TopologyObservation, edge: TopologyEdgeLink): void {
    appendTopologyEdge({
        graph: observation.graph,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        label: edge.label,
        status: observation.status,
        eventAtEpochMs: observation.eventAtEpochMs
    });
}

interface AppendMessageRoutesInput {
    readonly observation: TopologyObservation;
    readonly event: RallarBlackBoxTestEvent;
    /** The room node key, or `undefined` when the event names no room. */
    readonly eventRoom: string | undefined;
}

function appendMessageRoutes(input: AppendMessageRoutesInput): void {
    const { observation, event } = input;
    const sourceSession = appendObservedNode(observation, 'session', resolveSenderId(event));
    const targets = toMessageTargets(event);
    if (targets.length === 0) {
        appendObservedEdge(observation, {
            source: sourceSession,
            target: input.eventRoom,
            kind: 'route',
            label: 'broadcast'
        });
        return;
    }

    for (const target of targets) {
        appendObservedEdge(observation, {
            source: sourceSession,
            target: appendObservedNode(observation, 'session', target),
            kind: 'route',
            label: 'message'
        });
    }
}

interface AppendDiagnosticNodeInput {
    readonly observation: TopologyObservation;
    readonly event: RallarBlackBoxTestEvent;
    /** The room node key, or `undefined` when the event names no room. */
    readonly eventRoom: string | undefined;
    /** The connection node key, or `undefined` when the event names no connection. */
    readonly eventConnection: string | undefined;
}

function appendDiagnosticNode(input: AppendDiagnosticNodeInput): void {
    const { observation, event } = input;
    const diagnostic = appendTopologyNode({
        graph: observation.graph,
        kind: 'message',
        id: event.eventId,
        label: event.topic,
        status: observation.status,
        eventAtEpochMs: observation.eventAtEpochMs
    });
    appendObservedEdge(observation, {
        source: input.eventConnection ?? input.eventRoom,
        target: diagnostic,
        kind: 'diagnostic',
        label: event.kind
    });
}

export type RallarTopologyVisibleCounts = Readonly<{
    nodes: number;
    edges: number;
}>;

export function toVisibleTopologyCounts(
    graph: RallarTopologyGraph,
    filter: RallarTopologyFilter
): RallarTopologyVisibleCounts {
    if (filter === 'all') {
        return {
            nodes: graph.order,
            edges: graph.size
        };
    }

    let nodes = 0;
    let edges = 0;
    graph.forEachNode((_key, attrs) => {
        if (attrs.status === filter) {
            nodes += 1;
        }
    });
    graph.forEachEdge((_key, attrs) => {
        if (attrs.status === filter) {
            edges += 1;
        }
    });
    return { nodes, edges };
}
