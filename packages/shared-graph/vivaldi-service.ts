import { RttMeasurementInfo } from '@shared/api/api-config.ts';
import {
    createDegreeCappedPredictedGraph,
    createPredictedGraph,
    VivaldiConfig,
    VivaldiNodeData,
} from './graph/vivaldi.ts';
import { GraphProp } from './graph/graph-props.ts';
import * as vivaldiRepository from './repository/vivaldi-repository.ts';

const DEFAULT_DIMENSIONS = 4;
const DEFAULT_INITIAL_ERROR = 1.0;

export function observeRtt(
    rtt: RttMeasurementInfo,
    dimensions = DEFAULT_DIMENSIONS,
    initialError = DEFAULT_INITIAL_ERROR,
): boolean {
    if (!Number.isFinite(rtt.rttMs) || rtt.rttMs <= 0) {
        return false;
    }

    const fromNode = vivaldiRepository.getOrCreateNode(
        rtt.sessionIdFrom,
        dimensions,
        initialError,
    );
    const toNode = vivaldiRepository.getOrCreateNode(
        rtt.sessionIdTo,
        dimensions,
        initialError,
    );

    fromNode.update(toNode.toNodeData(rtt.sessionIdTo, rtt.rttMs));
    toNode.update(fromNode.toNodeData(rtt.sessionIdFrom, rtt.rttMs));

    return true;
}

export function readablePredictedNodeData(): ReadonlyMap<string, VivaldiNodeData> {
    return vivaldiRepository.getAllNodeData();
}

export function toPredictedGraphSnapshot(
    graphProp: GraphProp,
    cfg?: Partial<VivaldiConfig>,
) {
    return createPredictedGraph(
        vivaldiRepository.getAllNodeData(),
        graphProp,
        cfg
    );
}

export function toPredictedGraphFromIds(
    ids: readonly string[],
    graphProp: GraphProp,
    cfg?: Partial<VivaldiConfig>,
) {
    return createPredictedGraph(
        vivaldiRepository.getNodeDataById(ids),
        graphProp,
        cfg
    );
}

export function toDegreeCappedPredictedGraphFromIds(
    ids: readonly string[],
    graphProp: GraphProp,
    options: Readonly<{ degreeLimit: number }> & Partial<VivaldiConfig>,
) {
    return createDegreeCappedPredictedGraph(
        vivaldiRepository.getNodeDataById(ids),
        graphProp,
        options,
    );
}
