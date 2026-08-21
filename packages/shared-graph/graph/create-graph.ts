import { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import * as rttRepository from '@shared/repository/rtt-repository.ts';
import { UndirectedGraph } from 'graphology';
import { EdgeProp, GraphProp, VertexProp, VertexState, VertexType } from '../graph-props.ts';

export function toMeasuredGraph(prop: GraphProp) {
    return toGraph(
        rttRepository.latestRttById(),
        prop
    );
}

export function toGraph(
    rttById: LatestRepository<string, RttMeasurementInfo>,
    prop: GraphProp
): UndirectedGraph<VertexProp, EdgeProp, GraphProp> {
    const graph: UndirectedGraph<VertexProp, EdgeProp, GraphProp> = new UndirectedGraph<
        VertexProp,
        EdgeProp,
        GraphProp
    >();
    graph.replaceAttributes(prop);

    for (const rttValue of rttById.values()) {
        const rtt = rttValue.read();
        if (rtt === undefined) {
            continue;
        }

        if (!graph.hasNode(rtt.sessionIdFrom)) {
            const vertex: VertexProp = {
                id: rtt.sessionIdFrom,
                type: VertexType.CLIENT,
                state: VertexState.MEMBER,
                degreeLimit: prop.degreeLimitMember
            };

            graph.addNode(vertex.id, vertex);
        }

        if (!graph.hasNode(rtt.sessionIdTo)) {
            const vertex: VertexProp = {
                id: rtt.sessionIdTo,
                type: VertexType.CLIENT,
                state: VertexState.MEMBER,
                degreeLimit: prop.degreeLimitMember
            };

            graph.addNode(vertex.id, vertex);
        }

        if (!graph.hasEdge(rtt.sessionIdFrom, rtt.sessionIdTo)) {
            graph.addEdge(
                rtt.sessionIdFrom,
                rtt.sessionIdTo,
                {
                    from: rtt.sessionIdFrom,
                    to: rtt.sessionIdTo,
                    weight: rtt.rttMs
                }
            );
        }
    }

    return graph;
}
