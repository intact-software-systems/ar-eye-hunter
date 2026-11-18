import { createBrowserRttHeartbeatMessage } from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { DEFAULT_RTT_REPORTING_DEGREE_LIMIT } from '@shared/rtc/rtt-reporting-policy.ts';

import type { TopologyChurnApi, TopologyChurnSession } from '../topology-churn-api.mts';
import {
    computeTopologyChurnRttMatrix,
    computeTopologyChurnRttPairs,
    type TopologyChurnRttMatrixShape
} from './compute-topology-churn-rtt-matrix.ts';
import { TopologyChurnRttSocket, type TopologyChurnWsEndpoint } from './topology-churn-rtt-socket.mts';

export namespace TopologyChurnRttReporter {
    export interface Input {
        readonly api: TopologyChurnApi;
        readonly roomRef: GroupRef;
        /** Each API process's WebSocket endpoint, keyed by its API base URL. */
        readonly endpointsByApiBaseUrl: ReadonlyMap<string, TopologyChurnWsEndpoint>;
    }

    export interface Report {
        readonly layout: Pick<RallarOverlayTopologySnapshot, 'activeSessionIds' | 'nextHopsBySessionId'>;
        readonly shape: TopologyChurnRttMatrixShape;
        readonly round: number;
        /** A member that left keeps its socket open, but neither reports nor is reported on. */
        readonly presentSessionIds: readonly string[];
        readonly nowEpochMs: number;
    }
}

/** Sends a room's RTT reports as its members' browsers do, each over the member's own socket; a socket never reconnects. */
export class TopologyChurnRttReporter {
    readonly #input: TopologyChurnRttReporter.Input;
    readonly #socketsBySessionId = new Map<string, TopologyChurnRttSocket>();
    /** A pair's report with a lower version than its stored one is stale, so every report sent outranks the ones before. */
    #nextVersion = 1;

    constructor(input: TopologyChurnRttReporter.Input) {
        this.#input = input;
    }

    /** Opens a socket for each session without one, on the session's own API process. */
    async open(sessions: readonly TopologyChurnSession[]): Promise<void> {
        for (const session of sessions) {
            if (this.#socketsBySessionId.has(session.sessionId)) {
                continue;
            }
            const endpoint = this.#input.endpointsByApiBaseUrl.get(session.member.apiBaseUrl);
            if (endpoint === undefined) {
                throw new Error(`No WebSocket endpoint is known for the API process ${session.member.apiBaseUrl}.`);
            }
            const socket = await TopologyChurnRttSocket.open({
                endpoint,
                sessionId: session.sessionId,
                ticket: await this.#input.api.writeWebSocketTicket(session),
                scope: this.#input.roomRef
            });
            this.#socketsBySessionId.set(session.sessionId, socket);
        }
    }

    /** Sends the matrix over the layout's reporting pairs and answers how many reports were sent. */
    report(input: TopologyChurnRttReporter.Report): number {
        const pairs = computeTopologyChurnRttPairs({
            layout: input.layout,
            roomRef: this.#input.roomRef,
            reportingDegreeLimit: DEFAULT_RTT_REPORTING_DEGREE_LIMIT,
            reporterSessionIds: [...this.#socketsBySessionId.keys()],
            presentSessionIds: input.presentSessionIds
        });
        const reports = computeTopologyChurnRttMatrix({
            pairs,
            layout: input.layout,
            shape: input.shape,
            round: input.round
        });
        for (const report of reports) {
            const socket = this.#getSocket(report.sessionIdFrom);
            socket.assertOpen();
            socket.send(createBrowserRttHeartbeatMessage(
                report.sessionIdFrom,
                { ...report, createdAtEpochMs: input.nowEpochMs, version: this.#nextVersion },
                newALUntargetedMessage
            ));
            this.#nextVersion += 1;
        }
        return reports.length;
    }

    close(): void {
        for (const socket of this.#socketsBySessionId.values()) {
            socket.close();
        }
        this.#socketsBySessionId.clear();
    }

    #getSocket(sessionId: string): TopologyChurnRttSocket {
        const socket = this.#socketsBySessionId.get(sessionId);
        if (socket === undefined) {
            throw new Error(`The session ${sessionId} reports RTT but has no socket.`);
        }
        return socket;
    }
}
