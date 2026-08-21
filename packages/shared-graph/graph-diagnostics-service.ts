import type {
    GraphDiagnosticReadOptions,
    GraphDiagnosticReadResponse
} from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { serializeGraphInfoSnapshot } from './graph-diagnostics-serialization.ts';
import {
    computeGroupGraph,
    computeScopedGlobalGraphAndCacheIt,
    toScopedGlobalGraphRef
} from './group-graphs-create-service.ts';
import { findGraphByRef, setGraph } from './repository/graphs-repository.ts';
import type { GraphInfoSnapshot } from './shared-graph-types.ts';

export function readScopedGlobalGraphDiagnostic(
    scope: StateScope,
    options: GraphDiagnosticReadOptions = {}
): Either<string, GraphDiagnosticReadResponse> {
    const groupRef = toScopedGlobalGraphRef(scope);
    return readGraphDiagnostic(
        groupRef,
        options,
        (current) => {
            const computed = computeScopedGlobalGraphAndCacheIt(
                scope,
                options.includeMeasured ?? false
            );
            return ensureFreshVersion(computed, current);
        }
    );
}

export function readGroupGraphDiagnostic(
    groupRef: GroupRef,
    options: GraphDiagnosticReadOptions = {}
): Either<string, GraphDiagnosticReadResponse> {
    return readGraphDiagnostic(
        groupRef,
        options,
        (current) => {
            const result = computeGroupGraph(groupRef, options.includeMeasured ?? false);
            if (result.left !== undefined) {
                return result;
            }

            return Either.ofRight(
                ensureFreshVersion(result.right, current)
            );
        }
    );
}

function readGraphDiagnostic(
    groupRef: GroupRef,
    options: GraphDiagnosticReadOptions,
    compute: (
        current: GraphInfoSnapshot | undefined
    ) => GraphInfoSnapshot | Either<string, GraphInfoSnapshot>
): Either<string, GraphDiagnosticReadResponse> {
    const refresh = options.refresh ?? 'if-missing';
    const current = findGraphByRef(groupRef);

    if (refresh === 'never') {
        if (!current) {
            return Either.ofLeft(
                `No cached graph diagnostic for ${groupRef.applicationId}/${
                    groupRef.workspaceId ?? ''
                }/${groupRef.groupId}`
            );
        }

        return Either.ofRight(toReadResponse(groupRef, current, true, false));
    }

    if (refresh === 'if-missing' && current) {
        return Either.ofRight(toReadResponse(groupRef, current, true, false));
    }

    const computed = compute(current);
    const snapshot = computed instanceof Either
        ? computed.right
        : computed;
    if (computed instanceof Either && computed.left !== undefined) {
        return Either.ofLeft(computed.left);
    }
    if (!snapshot) {
        return Either.ofLeft(
            `No graph diagnostic could be computed for ${groupRef.applicationId}/${
                groupRef.workspaceId ?? ''
            }/${groupRef.groupId}`
        );
    }

    setGraph(snapshot);
    return Either.ofRight(
        toReadResponse(groupRef, snapshot, current !== undefined, true)
    );
}

function toReadResponse(
    groupRef: GroupRef,
    snapshot: GraphInfoSnapshot,
    hit: boolean,
    refreshed: boolean
): GraphDiagnosticReadResponse {
    return {
        groupRef,
        snapshot: serializeGraphInfoSnapshot(snapshot),
        cache: {
            hit,
            refreshed
        }
    };
}

function ensureFreshVersion(
    snapshot: GraphInfoSnapshot | undefined,
    current: GraphInfoSnapshot | undefined
): GraphInfoSnapshot {
    if (!snapshot) {
        throw new Error('Graph diagnostic computation returned no snapshot');
    }

    if (!current || snapshot.version > current.version) {
        return snapshot;
    }

    return {
        ...snapshot,
        version: current.version + 1
    };
}
