import * as graphsRepository from '@shared-graph/repository/graphs-repository.ts';
import type { GraphInfoSnapshot } from '@shared-graph/shared-graph-types.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';

export interface DispatchGraphSnapshotMessageInput {
    readonly message: ALMessage;
    readonly sessionId: string;
}

export function dispatchGraphSnapshotMessage(
    input: DispatchGraphSnapshotMessageInput
): boolean {
    if (input.message.payload.typeId !== AppTopics.graphs) {
        return false;
    }
    const graph = JSON.parse(input.message.payload.resource) as GraphInfoSnapshot;
    if (!graphsRepository.setGraph(graph)) {
        return true;
    }
    const neighbors = graph.predicted.groupGraph.hasNode(input.sessionId)
        ? graph.predicted.groupGraph.neighbors(input.sessionId)
        : [];
    overlaysRepository.updateNextHopSessionIds(
        toScopedOverlayId(graph.groupRef),
        neighbors
    );
    return true;
}
