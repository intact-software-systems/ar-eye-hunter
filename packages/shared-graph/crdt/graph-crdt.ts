import { UndirectedGraph } from 'graphology';
import {
    rallarCrdtDeleteMapKeyOperation,
    rallarCrdtSetMapKeyOperation,
    rallarCrdtSetRegisterOperation,
    type RallarCrdtDocument,
    type RallarCrdtJsonValue,
    type RallarCrdtOperation,
    type RallarCrdtPath,
    type RallarCrdtRegisterPolicy,
} from '@shared/crdt/mod.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    type EdgeProp,
    type GraphProp,
    type VertexProp,
    VertexState,
    VertexType,
    type WeightedGraph,
} from '../graph/graph-props.ts';

export const RALLAR_GRAPH_CRDT_NODES_PATH = ['nodes'] as const;
export const RALLAR_GRAPH_CRDT_EDGES_PATH = ['edges'] as const;

export type RallarGraphCrdtNode = Readonly<{
    id: string;
    label?: string | readonly string[];
    type?: VertexType;
    state?: VertexState;
    degreeLimit?: number;
    metadata?: RallarCrdtJsonValue;
}>;

export type RallarGraphCrdtEdge = Readonly<{
    id: string;
    source: string;
    target: string;
    label?: string | readonly string[];
    weight?: number;
    metadata?: RallarCrdtJsonValue;
}>;

export type RallarGraphCrdtState = Readonly<{
    nodes?: Readonly<Record<string, RallarGraphCrdtNode>>;
    edges?: Readonly<Record<string, RallarGraphCrdtEdge>>;
}>;

export type RallarGraphCrdtNodeProperty = Exclude<
    keyof RallarGraphCrdtNode,
    'id'
>;

export type RallarGraphCrdtEdgeProperty = Exclude<
    keyof RallarGraphCrdtEdge,
    'id'
>;

export function rallarGraphCrdtAddNodeOperation(
    node: RallarGraphCrdtNode,
): RallarCrdtOperation {
    return rallarCrdtSetMapKeyOperation(
        RALLAR_GRAPH_CRDT_NODES_PATH,
        node.id,
        stripUndefinedJson(node) as RallarCrdtJsonValue,
    );
}

export function rallarGraphCrdtRemoveNodeOperation(
    document: Pick<RallarCrdtDocument, 'observedMapUpdateIds'>,
    nodeId: string,
): RallarCrdtOperation {
    return rallarCrdtDeleteMapKeyOperation(
        document,
        RALLAR_GRAPH_CRDT_NODES_PATH,
        nodeId,
    );
}

export function rallarGraphCrdtAddEdgeOperation(
    edge: RallarGraphCrdtEdge,
): RallarCrdtOperation {
    return rallarCrdtSetMapKeyOperation(
        RALLAR_GRAPH_CRDT_EDGES_PATH,
        edge.id,
        stripUndefinedJson(edge) as RallarCrdtJsonValue,
    );
}

export function rallarGraphCrdtRemoveEdgeOperation(
    document: Pick<RallarCrdtDocument, 'observedMapUpdateIds'>,
    edgeId: string,
): RallarCrdtOperation {
    return rallarCrdtDeleteMapKeyOperation(
        document,
        RALLAR_GRAPH_CRDT_EDGES_PATH,
        edgeId,
    );
}

export function rallarGraphCrdtSetNodePropertyOperation(
    nodeId: string,
    property: RallarGraphCrdtNodeProperty,
    value: RallarCrdtJsonValue,
    policy: RallarCrdtRegisterPolicy = 'lww',
): RallarCrdtOperation {
    return rallarCrdtSetRegisterOperation(
        graphNodePropertyPath(nodeId, property),
        value,
        policy,
    );
}

export function rallarGraphCrdtSetEdgePropertyOperation(
    edgeId: string,
    property: RallarGraphCrdtEdgeProperty,
    value: RallarCrdtJsonValue,
    policy: RallarCrdtRegisterPolicy = 'lww',
): RallarCrdtOperation {
    return rallarCrdtSetRegisterOperation(
        graphEdgePropertyPath(edgeId, property),
        value,
        policy,
    );
}

export function graphNodePropertyPath(
    nodeId: string,
    property: RallarGraphCrdtNodeProperty,
): RallarCrdtPath {
    return [...RALLAR_GRAPH_CRDT_NODES_PATH, nodeId, String(property)];
}

export function graphEdgePropertyPath(
    edgeId: string,
    property: RallarGraphCrdtEdgeProperty,
): RallarCrdtPath {
    return [...RALLAR_GRAPH_CRDT_EDGES_PATH, edgeId, String(property)];
}

export type RallarGraphCrdtLabelConflict = Readonly<{
    kind: 'node-label' | 'edge-label';
    id: string;
    values: readonly string[];
}>;

export type RallarGraphCrdtDerivedGraph = Readonly<{
    groupRef: GroupRef;
    graph: WeightedGraph;
    nodeLabels: Readonly<Record<string, string>>;
    edgeLabels: Readonly<Record<string, string>>;
    labelConflicts: readonly RallarGraphCrdtLabelConflict[];
}>;

export function deriveGraphologyFromRallarGraphCrdt(
    value: unknown,
    options: Readonly<{
        groupRef: GroupRef;
        graphProp?: GraphProp;
        defaultDegreeLimit?: number;
    }>,
): RallarGraphCrdtDerivedGraph {
    const state = toRallarGraphCrdtState(value);
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(
        options.graphProp ?? {
            id: toGraphPropId(options.groupRef),
            version: 1,
            degreeLimitMember: options.defaultDegreeLimit ?? 8,
            degreeLimitSteiner: options.defaultDegreeLimit ?? 8,
        },
    );

    const nodeLabels: Record<string, string> = {};
    const edgeLabels: Record<string, string> = {};
    const labelConflicts: RallarGraphCrdtLabelConflict[] = [];

    for (const node of Object.values(state.nodes ?? {}).sort(compareById)) {
        if (!node.id || graph.hasNode(node.id)) {
            continue;
        }

        const label = resolveLabel('node-label', node.id, node.label);
        if (label.conflict) {
            labelConflicts.push(label.conflict);
        }
        if (label.value !== undefined) {
            nodeLabels[node.id] = label.value;
        }

        graph.addNode(node.id, {
            id: node.id,
            type: node.type ?? VertexType.CLIENT,
            state: node.state ?? VertexState.MEMBER,
            degreeLimit: node.degreeLimit ?? options.defaultDegreeLimit ?? 8,
        });
    }

    for (const edge of Object.values(state.edges ?? {}).sort(compareById)) {
        if (
            !edge.id ||
            !graph.hasNode(edge.source) ||
            !graph.hasNode(edge.target) ||
            graph.hasEdge(edge.source, edge.target)
        ) {
            continue;
        }

        const label = resolveLabel('edge-label', edge.id, edge.label);
        if (label.conflict) {
            labelConflicts.push(label.conflict);
        }
        if (label.value !== undefined) {
            edgeLabels[edge.id] = label.value;
        }

        graph.addEdge(edge.source, edge.target, {
            from: edge.source,
            to: edge.target,
            weight: edge.weight ?? 1,
        });
    }

    return {
        groupRef: options.groupRef,
        graph,
        nodeLabels,
        edgeLabels,
        labelConflicts,
    };
}

export function toRallarGraphCrdtState(value: unknown): RallarGraphCrdtState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    const record = value as Record<string, unknown>;
    return {
        nodes: toNodeRecord(record.nodes),
        edges: toEdgeRecord(record.edges),
    };
}

function toNodeRecord(value: unknown): Record<string, RallarGraphCrdtNode> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    const nodes: Record<string, RallarGraphCrdtNode> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }

        const record = entry as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id : key;
        nodes[id] = {
            id,
            label: toOptionalLabel(record.label),
            type: isVertexType(record.type) ? record.type : undefined,
            state: isVertexState(record.state) ? record.state : undefined,
            degreeLimit: toOptionalFiniteNumber(record.degreeLimit),
            metadata: isCrdtJsonValue(record.metadata)
                ? record.metadata
                : undefined,
        };
    }
    return nodes;
}

function toEdgeRecord(value: unknown): Record<string, RallarGraphCrdtEdge> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    const edges: Record<string, RallarGraphCrdtEdge> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }

        const record = entry as Record<string, unknown>;
        if (
            typeof record.source !== 'string' ||
            typeof record.target !== 'string'
        ) {
            continue;
        }

        const id = typeof record.id === 'string' ? record.id : key;
        edges[id] = {
            id,
            source: record.source,
            target: record.target,
            label: toOptionalLabel(record.label),
            weight: toOptionalFiniteNumber(record.weight),
            metadata: isCrdtJsonValue(record.metadata)
                ? record.metadata
                : undefined,
        };
    }
    return edges;
}

function stripUndefinedJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripUndefinedJson);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, entryValue]) => entryValue !== undefined)
                .map(([key, entryValue]) => [
                    key,
                    stripUndefinedJson(entryValue),
                ]),
        );
    }
    return value;
}

function resolveLabel(
    kind: RallarGraphCrdtLabelConflict['kind'],
    id: string,
    label: string | readonly string[] | undefined,
): Readonly<{
    value?: string;
    conflict?: RallarGraphCrdtLabelConflict;
}> {
    if (typeof label === 'string') {
        return { value: label };
    }
    if (!Array.isArray(label) || label.length === 0) {
        return {};
    }

    const values = [
        ...new Set(label.filter((entry) => entry.length > 0)),
    ].sort();
    return {
        value: values[0],
        conflict:
            values.length > 1
                ? {
                      kind,
                      id,
                      values,
                  }
                : undefined,
    };
}

function toOptionalLabel(
    value: unknown,
): string | readonly string[] | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === 'string')
    ) {
        return value;
    }
    return undefined;
}

function toOptionalFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function isVertexType(value: unknown): value is VertexType {
    return value === VertexType.CLIENT || value === VertexType.CORE;
}

function isVertexState(value: unknown): value is VertexState {
    return value === VertexState.MEMBER || value === VertexState.STEINER;
}

function isCrdtJsonValue(value: unknown): value is RallarCrdtJsonValue {
    return (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        Array.isArray(value) ||
        (!!value && typeof value === 'object')
    );
}

function compareById<T extends Readonly<{ id: string }>>(
    left: T,
    right: T,
): number {
    return left.id.localeCompare(right.id);
}

function toGraphPropId(groupRef: GroupRef): string {
    return [
        groupRef.applicationId,
        groupRef.workspaceId ?? '',
        groupRef.groupId,
        'crdt',
    ].join(':');
}
