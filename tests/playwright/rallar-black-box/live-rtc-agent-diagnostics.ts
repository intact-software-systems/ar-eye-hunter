import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import {
    exactStringArray,
    isFiniteNonnegativeNumber,
    jsonRecord,
    normalizeJson,
    numberValue,
    requiredBoolean,
    requiredJsonArray,
    requiredJsonRecord,
    requiredNonnegativeNumber,
    requiredString,
    requiredStringArray,
    type LiveRtcJsonRecord
} from './live-rtc-evidence-json.ts';

export interface LiveRtcAgentDiagnostics {
    agentId: string;
    settledPeerIds: readonly string[];
    readyPeerIds: readonly string[];
    laneStates: readonly LiveRtcLaneDiagnostics[];
    connectionTimerActive: boolean;
    peerCount: number;
    connectedPeerCount: number;
    relayPeerCount: number;
    details: RtcBaselineJson;
}

export interface LiveRtcLaneDiagnostics {
    peerId: string;
    laneId: string;
    isOpen: boolean;
    isReconnectable: boolean;
}

export function decodeAgentDiagnostics(
    value: RtcBaselineJson
): LiveRtcAgentDiagnostics | null {
    const agent = jsonRecord(value);
    const settledPeerIds = agent ? exactStringArray(agent.settledPeerIds) : null;
    const readyPeerIds = agent ? exactStringArray(agent.readyPeerIds) : null;
    if (
        !agent ||
        typeof agent.agentId !== 'string' ||
        !settledPeerIds ||
        !readyPeerIds ||
        !Array.isArray(agent.laneStates) ||
        typeof agent.connectionTimerActive !== 'boolean' ||
        !isFiniteNonnegativeNumber(agent.peerCount) ||
        !isFiniteNonnegativeNumber(agent.connectedPeerCount) ||
        !isFiniteNonnegativeNumber(agent.relayPeerCount) ||
        agent.details === undefined
    ) {
        return null;
    }
    const laneStates: LiveRtcLaneDiagnostics[] = [];
    for (const laneValue of agent.laneStates) {
        const lane = decodeLaneDiagnostics(laneValue);
        if (!lane) {
            return null;
        }
        laneStates.push(lane);
    }
    return {
        agentId: agent.agentId,
        settledPeerIds,
        readyPeerIds,
        laneStates,
        connectionTimerActive: agent.connectionTimerActive,
        peerCount: agent.peerCount,
        connectedPeerCount: agent.connectedPeerCount,
        relayPeerCount: agent.relayPeerCount,
        details: agent.details
    };
}

function decodeLaneDiagnostics(
    value: RtcBaselineJson
): LiveRtcLaneDiagnostics | null {
    const lane = jsonRecord(value);
    return lane &&
            typeof lane.peerId === 'string' &&
            typeof lane.laneId === 'string' &&
            typeof lane.isOpen === 'boolean' &&
            typeof lane.isReconnectable === 'boolean'
        ? {
            peerId: lane.peerId,
            laneId: lane.laneId,
            isOpen: lane.isOpen,
            isReconnectable: lane.isReconnectable
        }
        : null;
}

export function buildLiveRtcAgentDiagnostics(
    agentId: string,
    resultValue: RtcBaselineJson | object
): LiveRtcAgentDiagnostics {
    const normalized = normalizeJson(resultValue);
    const root = requiredJsonRecord(normalized, '$');
    const rallar = requiredJsonRecord(root.rallar, '$.rallar');
    const status = requiredJsonRecord(rallar.rtcStatus, '$.rallar.rtcStatus');
    const diagnostics = requiredJsonRecord(
        rallar.rtcDiagnostics,
        '$.rallar.rtcDiagnostics'
    );
    const settledPeerIds = requiredStringArray(
        status.activePeerIds,
        '$.rallar.rtcStatus.activePeerIds'
    ).sort();
    const readyPeerIds = requiredStringArray(
        status.readyPeerIds,
        '$.rallar.rtcStatus.readyPeerIds'
    ).sort();
    const peers = requiredJsonArray(
        diagnostics.peers,
        '$.rallar.rtcDiagnostics.peers'
    );
    const peerRecords = peers.map((peer, index) => requiredJsonRecord(peer, `$.rallar.rtcDiagnostics.peers[${index}]`));
    return {
        agentId,
        settledPeerIds,
        readyPeerIds,
        laneStates: toLiveRtcLaneStates(peerRecords),
        connectionTimerActive: hasLiveRtcConnectionTimer(peerRecords),
        peerCount: requiredNonnegativeNumber(diagnostics.peerCount, 'RTC peerCount'),
        connectedPeerCount: requiredNonnegativeNumber(
            diagnostics.connectedPeerCount,
            'RTC connectedPeerCount'
        ),
        relayPeerCount: requiredNonnegativeNumber(
            diagnostics.relayPeerCount,
            'RTC relayPeerCount'
        ),
        details: normalizeJson({
            sessionId: diagnostics.sessionId ?? null,
            generatedAtEpochMs: diagnostics.generatedAtEpochMs,
            status,
            diagnostics,
            rtcDiagnosticsError: rallar.rtcDiagnosticsError ?? null
        })
    };
}

function toLiveRtcLaneStates(
    peerRecords: readonly LiveRtcJsonRecord[]
): LiveRtcLaneDiagnostics[] {
    return peerRecords.flatMap((peer) => {
        const peerId = requiredString(peer.peerId, 'RTC diagnostic peerId');
        const lanes = requiredJsonArray(peer.lanes, `RTC diagnostic lanes for ${peerId}`);
        return lanes.map((laneValue, index) => {
            const lane = requiredJsonRecord(
                laneValue,
                `RTC diagnostic lane ${index} for ${peerId}`
            );
            return {
                peerId,
                laneId: requiredString(lane.laneId, `RTC diagnostic laneId for ${peerId}`),
                isOpen: requiredBoolean(lane.isOpen, `RTC diagnostic isOpen for ${peerId}`),
                isReconnectable: requiredBoolean(
                    lane.isReconnectable,
                    `RTC diagnostic isReconnectable for ${peerId}`
                )
            };
        });
    }).sort(compareLaneStates);
}

function hasLiveRtcConnectionTimer(
    peerRecords: readonly LiveRtcJsonRecord[]
): boolean {
    return peerRecords.some((peer) => {
        const connection = requiredJsonRecord(
            peer.connection,
            'RTC diagnostic peer connection'
        );
        const connectionDiagnostics = jsonRecord(peer.connectionDiagnostics);
        return connection.disconnectPending === true ||
            connection.reconnecting === true ||
            connectionDiagnostics?.hasReconnectTimer === true ||
            (numberValue(connectionDiagnostics?.reconnectAttemptsInFlight) ?? 0) !== 0;
    });
}

export function compareLaneStates(
    left: LiveRtcLaneDiagnostics,
    right: LiveRtcLaneDiagnostics
): number {
    return left.peerId.localeCompare(right.peerId) ||
        left.laneId.localeCompare(right.laneId);
}
