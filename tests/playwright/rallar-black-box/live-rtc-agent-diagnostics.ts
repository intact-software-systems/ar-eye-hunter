import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import type { RallarRtcLifecycleKind } from '../../../packages/shared-web/browser/rallar-rtc-facade.ts';
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

export interface LiveRtcLifecycleFailureInterval {
    readonly caseId: 'default' | 'all-scenarios' | 'retention-100';
    readonly startedAtEpochMs: number;
    readonly failedAtEpochMs: number;
    readonly precision: 'attempt-phase-unspecified' | 'initial-attempt' | 'current-cycle-before-close';
}

interface LiveRtcLifecycleHistoryInput {
    readonly jsonl: string | null;
    readonly bytesRead: number;
    readonly retainedBytes: number;
    readonly retainedPrefixDropped: boolean;
    readonly transportTruncated: boolean;
    readonly failureInterval: LiveRtcLifecycleFailureInterval;
    readonly agentIds: readonly string[];
    readonly cycle: number | null;
}

interface LiveRtcLifecycleScan {
    readonly events: LiveRtcJsonRecord[];
    scannedRows: number;
    filteredRows: number;
    malformedRows: number;
    oversizedRows: number;
    outputDroppedRows: number;
    outputBytes: number;
    rowLimitReached: boolean;
    firstControlAtEpochMs: number | null;
    lastControlAtEpochMs: number | null;
}

interface LiveRtcLifecycleScanWindow {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly firstStreamRow: number;
    readonly rowLimitReached: boolean;
}

const RTC_LIFECYCLE_KINDS: Readonly<Record<RallarRtcLifecycleKind, true>> = {
    snapshot: true,
    connected: true,
    disconnected: true,
    'peer-created': true,
    'peer-established': true,
    'peer-deleted': true,
    'peer-timeout': true,
    'lane-open': true,
    'lane-close': true,
    'lane-error': true,
    'signaling-failed': true
};
export const LIVE_RTC_LIFECYCLE_LIMITS = Object.freeze({
    inputBytes: 8_388_608,
    transportBytes: 67_108_864,
    transportTimeoutMs: 30_000,
    scannedRows: 20_000,
    rowBytes: 16_384,
    retainedRows: 600,
    eventOutputBytes: 262_144,
    identityCharacters: 256
});

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
    return typeof value === 'string' && value.length > 0 && value.length <= LIVE_RTC_LIFECYCLE_LIMITS.identityCharacters
        ? value
        : null;
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

export function toLiveRtcLifecycleHistory(
    input: LiveRtcLifecycleHistoryInput
): Readonly<Record<string, RtcBaselineJson>> {
    const scan: LiveRtcLifecycleScan = {
        events: [],
        scannedRows: 0,
        filteredRows: 0,
        malformedRows: 0,
        oversizedRows: 0,
        outputDroppedRows: 0,
        outputBytes: 0,
        rowLimitReached: false,
        firstControlAtEpochMs: null,
        lastControlAtEpochMs: null
    };
    scanLiveRtcLifecycleRows(input, scan);
    const history = {
        coverage: computeLiveRtcLifecycleCoverage(input, scan),
        recorderOrigin: 'unknown',
        requestedInterval: input.failureInterval,
        cycle: input.cycle,
        windowClock: 'control-event-atEpochMs',
        timestampPrecision: 'producer-clocks-not-recorder-receipt',
        ordering: 'recorder-stream-row-not-causal-order',
        streamRowOrigin: 'retained-response-body',
        absoluteRecorderRow: 'unknown',
        inputSelection: 'suffix-of-accepted-response-bytes',
        rowSelection: 'last-retained-rows',
        eventSelection: 'latest-permitted-events-in-stream-order',
        nativeGenerationAndDeletionIssuer: 'unknown',
        limits: LIVE_RTC_LIFECYCLE_LIMITS,
        failure: input.jsonl === null ? 'RTC lifecycle recorder history unavailable.' : null,
        observed: {
            bytesRead: input.bytesRead,
            retainedBytes: input.retainedBytes,
            retainedPrefixDropped: input.retainedPrefixDropped,
            transportTruncated: input.transportTruncated,
            scannedRows: scan.scannedRows,
            filteredRows: scan.filteredRows,
            malformedRows: scan.malformedRows,
            oversizedRows: scan.oversizedRows,
            outputDroppedRows: scan.outputDroppedRows,
            rowLimitReached: scan.rowLimitReached,
            retainedRows: scan.events.length,
            outputBytes: scan.outputBytes,
            firstControlAtEpochMs: scan.firstControlAtEpochMs,
            lastControlAtEpochMs: scan.lastControlAtEpochMs
        }
    };
    return Object.fromEntries(input.agentIds.map((agentId) => [
        agentId,
        normalizeJson({
            ...history,
            events: scan.events.filter((event) => event.agentId === agentId)
        })
    ]));
}

function computeLiveRtcLifecycleCoverage(
    input: LiveRtcLifecycleHistoryInput,
    scan: LiveRtcLifecycleScan
): 'unavailable' | 'incomplete' | 'unknown' {
    if (input.jsonl === null) {
        return 'unavailable';
    }
    return scan.events.length === 0 || input.retainedPrefixDropped || input.transportTruncated ||
            scan.rowLimitReached ||
            scan.malformedRows > 0 || scan.oversizedRows > 0 || scan.outputDroppedRows > 0
        ? 'incomplete'
        : 'unknown';
}

function scanLiveRtcLifecycleRows(input: LiveRtcLifecycleHistoryInput, scan: LiveRtcLifecycleScan): void {
    const jsonl = input.jsonl ?? '';
    const window = computeLiveRtcLifecycleScanWindow(input);
    scan.rowLimitReached = window.rowLimitReached;
    let streamRow = window.firstStreamRow;
    for (let cursor = window.startedAt; cursor < window.endedAt;) {
        const delimiter = jsonl.indexOf('\n', cursor);
        const endedAt = delimiter < 0 ? window.endedAt : Math.min(delimiter, window.endedAt);
        const line = jsonl.slice(cursor, endedAt);
        cursor = endedAt + 1;
        const row = streamRow++;
        if (line.trim().length === 0) {
            continue;
        }
        scan.scannedRows += 1;
        if (Buffer.byteLength(line) > LIVE_RTC_LIFECYCLE_LIMITS.rowBytes) {
            scan.oversizedRows += 1;
            continue;
        }
        const decoded = toLiveRtcRecorderRow(line);
        if (!decoded) {
            scan.malformedRows += 1;
            continue;
        }
        const controlAtEpochMs = toLifecycleTimestamp(decoded.atEpochMs);
        if (controlAtEpochMs !== null) {
            scan.firstControlAtEpochMs ??= controlAtEpochMs;
            scan.lastControlAtEpochMs = controlAtEpochMs;
        }
        const event = toLiveRtcLifecycleEvent(decoded, input, row);
        if (!event) {
            scan.filteredRows += 1;
            continue;
        }
        const bytes = Buffer.byteLength(JSON.stringify(event));
        scan.events.push(event);
        scan.outputBytes += bytes;
        while (
            scan.events.length > LIVE_RTC_LIFECYCLE_LIMITS.retainedRows ||
            scan.outputBytes > LIVE_RTC_LIFECYCLE_LIMITS.eventOutputBytes
        ) {
            const dropped = scan.events.shift();
            scan.outputBytes -= Buffer.byteLength(JSON.stringify(dropped));
            scan.outputDroppedRows += 1;
        }
    }
}

function computeLiveRtcLifecycleScanWindow(input: LiveRtcLifecycleHistoryInput): LiveRtcLifecycleScanWindow {
    const jsonl = input.jsonl ?? '';
    const firstDelimiter = jsonl.indexOf('\n');
    const startedAt = input.retainedPrefixDropped ? firstDelimiter < 0 ? jsonl.length : firstDelimiter + 1 : 0;
    const endedAt = input.transportTruncated ? jsonl.lastIndexOf('\n') + 1 : jsonl.length;
    let selectedAt = startedAt;
    let rows = 0;
    for (let cursor = endedAt; cursor > startedAt;) {
        const lineStart = Math.max(startedAt, jsonl.lastIndexOf('\n', cursor - 1) + 1);
        const line = jsonl.slice(lineStart, cursor);
        if (line.trim().length > 0) {
            rows += 1;
            if (rows > LIVE_RTC_LIFECYCLE_LIMITS.scannedRows) {
                selectedAt = cursor + 1;
                break;
            }
        }
        cursor = lineStart - 1;
    }
    let firstStreamRow = 1;
    for (let index = 0; index < selectedAt; index += 1) {
        if (jsonl.charCodeAt(index) === 10) {
            firstStreamRow += 1;
        }
    }
    return {
        startedAt: selectedAt,
        endedAt,
        firstStreamRow,
        rowLimitReached: rows > LIVE_RTC_LIFECYCLE_LIMITS.scannedRows
    };
}

function toLiveRtcRecorderRow(line: string): LiveRtcJsonRecord | null {
    try {
        return jsonRecord(normalizeJson(JSON.parse(line)));
    }
    catch {
        return null;
    }
}

function toLiveRtcLifecycleEvent(
    row: LiveRtcJsonRecord,
    input: LiveRtcLifecycleHistoryInput,
    streamRow: number
): LiveRtcJsonRecord | null {
    const runtime = jsonRecord(row.value);
    const diagnostic = jsonRecord(runtime?.payload);
    const event = jsonRecord(diagnostic?.data);
    const agentId = toBoundedIdentity(row.agentId);
    const controlAtEpochMs = toLifecycleTimestamp(row.atEpochMs);
    if (
        !agentId || !input.agentIds.includes(agentId) || runtime?.topic !== 'rallar.browser.rtc.lifecycle' ||
        !event || typeof event.kind !== 'string' || !Object.hasOwn(RTC_LIFECYCLE_KINDS, event.kind) ||
        controlAtEpochMs === null || controlAtEpochMs < input.failureInterval.startedAtEpochMs ||
        controlAtEpochMs > input.failureInterval.failedAtEpochMs
    ) {
        return null;
    }
    return {
        streamRow,
        eventId: toBoundedIdentity(row.name),
        agentId,
        kind: event.kind,
        controlAtEpochMs,
        runtimeAtEpochMs: toLifecycleTimestamp(diagnostic?.atEpochMs),
        browserAtEpochMs: toLifecycleTimestamp(event.atEpochMs),
        peerId: toBoundedIdentity(event.peerId),
        laneId: toBoundedIdentity(event.laneId)
    };
}

function toLifecycleTimestamp(value: RtcBaselineJson | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
