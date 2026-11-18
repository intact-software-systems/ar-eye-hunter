import type { StateScope } from '@shared/api/state-types.ts';
import { toApiWsUrl } from '@shared/websocket/to-api-ws-url.ts';

import { ClusterProofSocket } from '../../cluster-proofs/cluster-proof-socket.mts';

/** Where one API process upgrades a WebSocket, as its `/api/config` serves it. */
export interface TopologyChurnWsEndpoint {
    readonly wsBaseUrl: string;
    readonly createWsPath: string;
}

interface OpenTopologyChurnRttSocketInput {
    readonly endpoint: TopologyChurnWsEndpoint;
    readonly sessionId: string;
    readonly ticket: string;
    readonly scope: StateScope;
}

/** One member's authenticated socket, the one its RTT reports go over; it never reconnects. */
export class TopologyChurnRttSocket extends ClusterProofSocket {
    private constructor(socket: WebSocket) {
        super(socket, {
            failure: 'Topology churn RTT socket failed',
            frame: 'topology churn RTT socket frame',
            closeReason: 'topology-churn-rtt-complete'
        });
    }

    static async open(input: OpenTopologyChurnRttSocketInput): Promise<TopologyChurnRttSocket> {
        const socket = new TopologyChurnRttSocket(
            new WebSocket(toApiWsUrl({
                wsBaseUrl: input.endpoint.wsBaseUrl,
                createWsPath: input.endpoint.createWsPath,
                sessionId: input.sessionId,
                ticket: input.ticket,
                scope: input.scope
            }))
        );
        try {
            await socket.waitForOpen();
        }
        catch (error) {
            socket.close();
            throw error;
        }
        return socket;
    }
}
