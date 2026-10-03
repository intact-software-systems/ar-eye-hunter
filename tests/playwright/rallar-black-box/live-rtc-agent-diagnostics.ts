import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import type { RallarRoomTransportState } from '../../../packages/shared-web/browser/rallar-rtc-facade.ts';
import { isGroupLayoutIdentity } from '../../../packages/shared/api/group-lifecycle/group-layout-identity.ts';
import { GROUP_LIFECYCLE_STATES } from '../../../packages/shared/api/group-lifecycle/group-lifecycle-policy.ts';

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

const ROOM_TRANSPORT_STATES: Readonly<Record<RallarRoomTransportState, true>> = {
    off: true,
    halted: true,
    idle: true,
    connecting: true,
    partial: true,
    open: true,
    degraded: true,
    failed: true
};

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
            rtcDiagnosticsError: rallar.rtcDiagnosticsError ?? null,
            formation: toLiveRtcFormationDiagnostics(rallar.formation)
        })
    };
}

function toLiveRtcFormationDiagnostics(value: RtcBaselineJson | undefined): RtcBaselineJson {
    const formation = jsonRecord(value);
    const observation = 'health-summary-not-readiness-wait-result';
    if (!formation) {
        return { observation, available: false };
    }
    const room = jsonRecord(formation.room);
    const roomRef = jsonRecord(formation.roomRef);
    return {
        observation,
        available: true,
        roomRef: roomRef
            ? {
                applicationId: toBoundedIdentity(roomRef.applicationId),
                workspaceId: toBoundedIdentity(roomRef.workspaceId),
                groupId: toBoundedIdentity(roomRef.groupId)
            }
            : null,
        stage: GROUP_LIFECYCLE_STATES.find((stage) => stage === formation.stage) ?? null,
        roomTransportState: typeof room?.state === 'string' && Object.hasOwn(ROOM_TRANSPORT_STATES, room.state)
            ? room.state
            : null,
        desiredPeerIds: toBoundedPeerIdentities(room?.desiredPeerIds),
        readyPeerIds: toBoundedPeerIdentities(room?.readyPeerIds),
        activePeerIds: toBoundedPeerIdentities(room?.activePeerIds),
        failedPeerIds: toBoundedPeerIdentities(room?.failedPeerIds),
        peerIdentitiesTruncated: ['desiredPeerIds', 'readyPeerIds', 'activePeerIds', 'failedPeerIds']
            .some((field) => Array.isArray(room?.[field]) && room[field].length > 100),
        acceptedLayoutIdentity: toFormationLayoutIdentity(room?.acceptedLayoutIdentity)
    };
}

function toBoundedIdentity(value: RtcBaselineJson | undefined): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function toBoundedPeerIdentities(value: RtcBaselineJson | undefined): RtcBaselineJson {
    if (!Array.isArray(value) || value.some((identity) => toBoundedIdentity(identity) === null)) {
        return null;
    }
    return [...value.slice(0, 100)].sort();
}

function toFormationLayoutIdentity(value: RtcBaselineJson | undefined): RtcBaselineJson {
    const record = jsonRecord(value);
    if (!record) {
        return null;
    }
    const identity = {
        groupRevision: record.groupRevision,
        presenceRevision: record.presenceRevision,
        version: record.version,
        state: record.state
    };
    return isGroupLayoutIdentity(identity) ? normalizeJson(identity) : null;
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
