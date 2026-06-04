import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind, } from '@shared/api/overlay-topology.ts';
import {
    readGroupCreatedAtEpochMs,
    readGroupCreatedByPrincipalId,
    readGroupDisplayName,
    readGroupMemberSessionIds,
} from '@shared/api/group-client-views.ts';
import { ReconfigAlgo } from '@shared-graph/algo-props.ts';
import { createGroupMesh, type GlobalMeshArgs, } from '@shared-graph/graphs-mesh-service.ts';
import { createGroupTree } from '@shared-graph/graphs-tree-service.ts';
import {
    type EdgeProp,
    type GraphProp,
    type VertexProp,
    VertexState,
    VertexType,
    type WeightedGraph,
} from '@shared-graph/graph-props.ts';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { insertToMesh } from '@shared-graph/mesh/insert-mesh-algs.ts';
import { pairKey } from '@shared/repository/rtt-repository.ts';
import { UndirectedGraph } from 'graphology';

export type RallarRtcTopologyServiceOptions = Readonly<{
    degreeLimit?: number;
    treeMinSize?: number;
    meshMinSize?: number;
    meshParamK?: number;
    rttRebuildDebounceMs?: number;
    now?: () => number;
}>;

export type RallarRtcTopologyUpdateResult = Readonly<{
    snapshot: RallarOverlayTopologySnapshot;
    changed: boolean;
    previous?: RallarOverlayTopologySnapshot;
}>;

export type RallarRtcTopologyUpdateOptions = Readonly<{
    previous?: RallarOverlayTopologySnapshot;
}>;

export type RallarRtcTopologyRttQueueResult = Readonly<{
    overlayId: string;
    dueAtEpochMs: number;
    delayMs: number;
    newlyQueued: boolean;
    immediate: boolean;
}>;

const DEFAULT_DEGREE_LIMIT = 5;
const DEFAULT_TREE_MIN_SIZE = 5;
const DEFAULT_MESH_MIN_SIZE = 16;
const DEFAULT_MESH_PARAM_K = 2;
const DEFAULT_RTT_REBUILD_DEBOUNCE_MS = 250;

export class RallarRtcTopologyService {
    private readonly snapshotsByOverlayId = new Map<
        string,
        RallarOverlayTopologySnapshot
    >();
    private readonly pendingRttUpdateDueAtByOverlayId = new Map<string, number>();

    constructor(
        private readonly options: RallarRtcTopologyServiceOptions = {},
    ) {
    }

    updateGroupTopology(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
        options: RallarRtcTopologyUpdateOptions = {},
    ): RallarRtcTopologyUpdateResult {
        const overlayId = toScopedOverlayId(group.group);
        const previous = this.readPreviousSnapshot(overlayId, options);
        const topology = this.selectTopology(group);
        const activeSessionIds = readGroupMemberSessionIds(group);
        const globalGraph = this.createRoomGraph(group, rttMeasurements);
        const nextHopsBySessionId = this.createNextHopMap(
            topology,
            group,
            activeSessionIds,
            globalGraph,
        );
        const changed = previous === undefined ||
            previous.topology !== topology ||
            !isSameNextHopMap(previous.nextHopsBySessionId, nextHopsBySessionId);
        const now = this.now();
        const snapshot: RallarOverlayTopologySnapshot = {
            overlayId,
            groupRef: group.group,
            name: readGroupDisplayName(group),
            topology,
            activeSessionIds,
            nextHopsBySessionId,
            degreeLimit: this.degreeLimit(),
            version: changed ? (previous?.version ?? 0) + 1 : previous.version,
            createdByClientId: readGroupCreatedByPrincipalId(group),
            createdAtEpochMs: previous?.createdAtEpochMs ??
                readGroupCreatedAtEpochMs(group),
            updatedAtEpochMs: changed ? now : previous.updatedAtEpochMs,
        };
        const resultSnapshot = changed ? snapshot : previous;

        this.snapshotsByOverlayId.set(overlayId, resultSnapshot);
        this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);

        return {
            snapshot: resultSnapshot,
            changed,
            previous,
        };
    }

    removeGroupTopology(group: GroupSnapshot): boolean {
        const overlayId = toScopedOverlayId(group.group);
        this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
        return this.snapshotsByOverlayId.delete(overlayId);
    }

    readSnapshot(group: GroupSnapshot): RallarOverlayTopologySnapshot | undefined {
        return this.snapshotsByOverlayId.get(toScopedOverlayId(group.group));
    }

    queueRttTopologyUpdate(
        group: GroupSnapshot,
    ): RallarRtcTopologyRttQueueResult {
        const overlayId = toScopedOverlayId(group.group);
        const now = this.now();
        const existingDueAt = this.pendingRttUpdateDueAtByOverlayId.get(
            overlayId,
        );

        if (existingDueAt !== undefined) {
            return {
                overlayId,
                dueAtEpochMs: existingDueAt,
                delayMs: Math.max(0, existingDueAt - now),
                newlyQueued: false,
                immediate: existingDueAt <= now,
            };
        }

        const dueAtEpochMs = this.snapshotsByOverlayId.has(overlayId)
            ? now + this.rttRebuildDebounceMs()
            : now;
        this.pendingRttUpdateDueAtByOverlayId.set(overlayId, dueAtEpochMs);

        return {
            overlayId,
            dueAtEpochMs,
            delayMs: Math.max(0, dueAtEpochMs - now),
            newlyQueued: true,
            immediate: dueAtEpochMs <= now,
        };
    }

    flushDueRttTopologyUpdate(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
    ): RallarRtcTopologyUpdateResult | undefined {
        const overlayId = toScopedOverlayId(group.group);
        const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(
            overlayId,
        );
        if (dueAtEpochMs === undefined || dueAtEpochMs > this.now()) {
            return undefined;
        }

        this.pendingRttUpdateDueAtByOverlayId.delete(overlayId);
        return this.updateGroupTopology(group, rttMeasurements);
    }

    readRttTopologyUpdateDelayMs(group: GroupSnapshot): number | undefined {
        const dueAtEpochMs = this.pendingRttUpdateDueAtByOverlayId.get(
            toScopedOverlayId(group.group),
        );
        if (dueAtEpochMs === undefined) {
            return undefined;
        }

        return Math.max(0, dueAtEpochMs - this.now());
    }

    readRttRebuildDebounceMs(): number {
        return this.rttRebuildDebounceMs();
    }

    selectTopology(group: GroupSnapshot): RallarRtcTopologyKind {
        const activeSize = readGroupMemberSessionIds(group).length;

        if (activeSize >= this.meshMinSize()) {
            return 'mesh';
        }

        if (activeSize >= this.treeMinSize()) {
            return 'tree';
        }

        return 'star';
    }

    private readPreviousSnapshot(
        overlayId: string,
        options: RallarRtcTopologyUpdateOptions,
    ): RallarOverlayTopologySnapshot | undefined {
        if (options.previous?.overlayId === overlayId) {
            return options.previous;
        }

        return this.snapshotsByOverlayId.get(overlayId);
    }

    createRoomGraph(
        group: GroupSnapshot,
        rttMeasurements: readonly RttMeasurementInfo[] = [],
    ): WeightedGraph {
        const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
        const degreeLimit = this.degreeLimit();
        const activeSessionIds = readGroupMemberSessionIds(group);
        const rttByPair = new Map(
            rttMeasurements.map((rtt) => [
                pairKey(rtt.sessionIdFrom, rtt.sessionIdTo),
                rtt.rttMs,
            ]),
        );

        graph.replaceAttributes({
            id: toScopedOverlayId(group.group),
            version: group.group.snapshotVersion,
            degreeLimitMember: degreeLimit,
            degreeLimitSteiner: degreeLimit,
        });

        for (const sessionId of activeSessionIds) {
            graph.addNode(sessionId, {
                id: sessionId,
                type: VertexType.CLIENT,
                state: VertexState.MEMBER,
                degreeLimit,
            });
        }

        for (let i = 0; i < activeSessionIds.length; i++) {
            for (let j = i + 1; j < activeSessionIds.length; j++) {
                const from = activeSessionIds[i];
                const to = activeSessionIds[j];
                graph.addEdge(from, to, {
                    from,
                    to,
                    weight: rttByPair.get(pairKey(from, to)) ??
                        fallbackWeight(i, j),
                });
            }
        }

        return graph;
    }

    private createNextHopMap(
        topology: RallarRtcTopologyKind,
        group: GroupSnapshot,
        activeSessionIds: readonly string[],
        globalGraph: WeightedGraph,
    ): Record<string, readonly string[]> {
        if (topology === 'star') {
            return Object.fromEntries(
                activeSessionIds.map((sessionId) => [
                    sessionId,
                    activeSessionIds.filter((peerId) => peerId !== sessionId),
                ]),
            );
        }

        const graph = topology === 'tree'
            ? createGroupTree({
                group,
                globalGraph,
                maxDegree: this.degreeLimit(),
            }).tree
            : createGroupMesh({
                group,
                globalGraph,
                maxDegree: this.degreeLimit(),
                globalArgs: this.meshArgs(),
                deps: {
                    insertMeshAlgorithmTimed: insertToMesh,
                },
            }).mesh;

        return Object.fromEntries(
            activeSessionIds.map((sessionId) => [
                sessionId,
                graph.hasNode(sessionId)
                    ? (graph.neighbors(sessionId) as string[]).sort()
                    : [],
            ]),
        );
    }

    private meshArgs(): GlobalMeshArgs {
        return {
            meshParamK: this.options.meshParamK ?? DEFAULT_MESH_PARAM_K,
            insertAlgo: DynamicMeshAlgo.K_INSERT_MC,
            removeAlgo: DynamicMeshAlgo.K_REMOVE_MC,
            diameterBound: Number.POSITIVE_INFINITY,
            reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO,
        };
    }

    private degreeLimit(): number {
        return this.options.degreeLimit ?? DEFAULT_DEGREE_LIMIT;
    }

    private treeMinSize(): number {
        return this.options.treeMinSize ?? DEFAULT_TREE_MIN_SIZE;
    }

    private meshMinSize(): number {
        return this.options.meshMinSize ?? DEFAULT_MESH_MIN_SIZE;
    }

    private rttRebuildDebounceMs(): number {
        return Math.max(
            0,
            this.options.rttRebuildDebounceMs ??
            DEFAULT_RTT_REBUILD_DEBOUNCE_MS,
        );
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }
}

function fallbackWeight(i: number, j: number): number {
    return Math.abs(i - j) + 1;
}

function isSameNextHopMap(
    left: Readonly<Record<string, readonly string[]>>,
    right: Readonly<Record<string, readonly string[]>>,
): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    for (let i = 0; i < leftKeys.length; i++) {
        const key = leftKeys[i];
        if (key !== rightKeys[i]) {
            return false;
        }

        if (!sameStringArray(left[key], right[key])) {
            return false;
        }
    }

    return true;
}

function sameStringArray(
    left: readonly string[],
    right: readonly string[],
): boolean {
    if (left.length !== right.length) {
        return false;
    }

    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
}
