import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import { toFormationReadinessCapturedFacts } from '../../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime/formation/formation-controller.ts';
import type { RallarRtcLifecycleKind } from '../../../packages/shared-web/browser/rallar-rtc-facade.ts';
import type { RallarRoomTransportState } from '../../../packages/shared-web/browser/rallar-rtc-facade.ts';
import { AppTopics } from '../../../packages/shared/api/api-config.ts';
import { isGroupLayoutIdentity } from '../../../packages/shared/api/group-lifecycle/group-layout-identity.ts';
import { GROUP_LIFECYCLE_STATES } from '../../../packages/shared/api/group-lifecycle/group-lifecycle-policy.ts';
import {
    RTC_NATIVE_SIGNAL_DISPOSITIONS,
    RTC_SERVICE_SIGNAL_DISPOSITIONS,
    RTC_SIGNAL_CALLER_RELEASES
} from '../../../packages/shared/webrtc/rtc-signaling-diagnostics.ts';
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

interface LiveRtcEventRetention {
    readonly droppedRows: number;
    readonly outputBytes: number;
}

interface LiveRtcRecorderLine {
    readonly line: string;
    readonly streamRow: number;
}

interface LiveRtcScopedRecorderEvent {
    readonly agentId: string;
    readonly topic: string | null;
    readonly event: LiveRtcJsonRecord;
    readonly controlAtEpochMs: number;
    readonly runtimeAtEpochMs: number | null;
    readonly eventId: string | null;
    readonly streamRow: number;
}

interface LiveRtcSignalingIdentityObservations {
    readonly rtcAdmission: boolean;
    readonly conflictingAdmission: boolean;
    readonly dispatch: boolean;
}

type LiveRtcSignalingLink = 'matched' | 'ambiguous' | 'unknown';

const RTC_AL_OUTBOUND_TOPIC = 'rallar.browser.alm.outbound_diagnostics';
const RTC_AL_INBOUND_TOPIC = 'rallar.browser.alm.inbound_diagnostics';
const AL_LANES = ['durable', 'volatile'] as const;
const AL_COMMIT_ORIGINS = ['send', 'drain', 'repair'] as const;
const AL_COMMIT_OUTCOMES = ['committed', 'conflict', 'expired', 'not-attempted'] as const;
const AL_CARRIERS = ['rtc', 'ws'] as const;
const AL_ADMISSION_OUTCOMES = ['committed', 'not-handled', 'rejected', 'unauthorized', 'pending'] as const;
const AL_DISPATCH_DISPOSITIONS = [
    'shutdown',
    'expired',
    'plan-retry',
    'plan-dropped',
    'local-disabled',
    'ordering-completed',
    'ordering-retry',
    'consumer-unavailable',
    'port-returned',
    'port-retry',
    'port-threw'
] as const;
const AL_CONSUMER_SELECTIONS = ['exact-type', 'absent'] as const;
const AL_CONSUMER_OUTCOMES = ['returned', 'retry', 'threw', 'not-invoked'] as const;
const AL_CLAIM_OUTCOMES = ['completed', 'non-retryable', 'retry', 'not-ready'] as const;

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

const RTC_WRAPPER_STATES = ['Idle', 'Connecting', 'Open', 'Closed', 'Failed'] as const;
const RTC_CONNECTION_STATES = [
    'new',
    'connecting',
    'connected',
    'disconnected',
    'failed',
    'closed'
] as const satisfies readonly RTCPeerConnectionState[];
const RTC_ICE_CONNECTION_STATES = [
    'new',
    'checking',
    'connected',
    'completed',
    'disconnected',
    'failed',
    'closed'
] as const satisfies readonly RTCIceConnectionState[];
const RTC_ICE_GATHERING_STATES = ['new', 'gathering', 'complete'] as const satisfies readonly RTCIceGatheringState[];
const RTC_SIGNALING_STATES = [
    'stable',
    'have-local-offer',
    'have-remote-offer',
    'have-local-pranswer',
    'have-remote-pranswer',
    'closed'
] as const satisfies readonly RTCSignalingState[];
const RTC_LANE_READY_STATES = [
    'connecting',
    'open',
    'closing',
    'closed'
] as const satisfies readonly RTCDataChannelState[];
const RTC_SIGNALING_COUNT_FIELDS = [
    'outboundOfferCount',
    'outboundAnswerCount',
    'outboundIceCandidateCount',
    'inboundOfferCount',
    'inboundAnswerCount',
    'inboundIceCandidateCount',
    'outboundSignalingErrorCount',
    'inboundSignalingErrorCount'
] as const;

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
    // The compact identity index is bounded by the same <=20,000 selected rows, never by an extra read.
    const sourceIdentities = computeLiveRtcSignalingIdentities(input);
    const scanned = computeLiveRtcDiagnosticScan(input, sourceIdentities);
    const scan = computeRetainedLiveRtcSignalingLinks(scanned, sourceIdentities);
    const history = toLiveRtcLifecycleHistoryMetadata(input, scan);
    return Object.fromEntries(input.agentIds.map((agentId) => [
        agentId,
        normalizeJson({
            ...history,
            events: scan.events.filter((event) => event.agentId === agentId)
        })
    ]));
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

function toLiveRtcLifecycleHistoryMetadata(
    input: LiveRtcLifecycleHistoryInput,
    scan: LiveRtcLifecycleScan
): LiveRtcJsonRecord {
    return {
        coverage: computeLiveRtcLifecycleCoverage(input, scan),
        recorderOrigin: 'unknown',
        requestedInterval: normalizeJson(input.failureInterval),
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
        nativeApplication: 'unknown',
        consumerClaimAssociation: 'unknown-message-level-observation-only',
        signalingClock: 'AL-producer-clock-separate-from-runtime-emission-and-control-event',
        signalingJoin: 'same-agent-message-exact-lane-worker-all-admission-types-agree-duplicates-preserved',
        signalingIndexSelection: 'compact-identities-from-at-most-20000-selected-source-rows',
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

function computeLiveRtcDiagnosticScan(
    input: LiveRtcLifecycleHistoryInput,
    sourceIdentities: ReadonlyMap<string, LiveRtcSignalingIdentityObservations>
): LiveRtcLifecycleScan {
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
    scan.rowLimitReached = computeLiveRtcLifecycleScanWindow(input).rowLimitReached;
    for (const { line, streamRow } of toLiveRtcRecorderLines(input)) {
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
        const controlAtEpochMs = toFiniteNonnegativeObservation(decoded.atEpochMs);
        if (controlAtEpochMs !== null) {
            scan.firstControlAtEpochMs ??= controlAtEpochMs;
            scan.lastControlAtEpochMs = controlAtEpochMs;
        }
        const scoped = toLiveRtcScopedRecorderEvent(decoded, input, streamRow);
        const event = scoped ? toLiveRtcDiagnosticEvent(scoped, sourceIdentities) : null;
        if (!event) {
            scan.filteredRows += 1;
            continue;
        }
        scan.events.push(event);
        scan.outputBytes += Buffer.byteLength(JSON.stringify(event));
        const retention = computeLiveRtcEventRetention(scan.events, scan.outputBytes);
        scan.events.splice(0, retention.droppedRows);
        scan.outputDroppedRows += retention.droppedRows;
        scan.outputBytes = retention.outputBytes;
    }
    return scan;
}

function* toLiveRtcRecorderLines(input: LiveRtcLifecycleHistoryInput): Generator<LiveRtcRecorderLine> {
    const jsonl = input.jsonl ?? '';
    const window = computeLiveRtcLifecycleScanWindow(input);
    let streamRow = window.firstStreamRow;
    for (let cursor = window.startedAt; cursor < window.endedAt;) {
        const delimiter = jsonl.indexOf('\n', cursor);
        const endedAt = delimiter < 0 ? window.endedAt : Math.min(delimiter, window.endedAt);
        const line = jsonl.slice(cursor, endedAt);
        cursor = endedAt + 1;
        const row = streamRow++;
        if (line.trim().length > 0) {
            yield { line, streamRow: row };
        }
    }
}

function computeLiveRtcEventRetention(
    events: readonly LiveRtcJsonRecord[],
    outputBytes: number
): LiveRtcEventRetention {
    let droppedRows = 0;
    let retainedBytes = outputBytes;
    while (
        events.length - droppedRows > LIVE_RTC_LIFECYCLE_LIMITS.retainedRows ||
        retainedBytes > LIVE_RTC_LIFECYCLE_LIMITS.eventOutputBytes
    ) {
        retainedBytes -= Buffer.byteLength(JSON.stringify(events[droppedRows++]));
    }
    return { droppedRows, outputBytes: retainedBytes };
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
        const decoded = JSON.parse(
            line,
            (_key: string, value: RtcBaselineJson) =>
                typeof value === 'number' && !Number.isFinite(value) ? null : value
        );
        return jsonRecord(normalizeJson(decoded));
    }
    catch {
        return null;
    }
}

function toLiveRtcScopedRecorderEvent(
    row: LiveRtcJsonRecord,
    input: LiveRtcLifecycleHistoryInput,
    streamRow: number
): LiveRtcScopedRecorderEvent | null {
    const runtime = jsonRecord(row.value);
    const diagnostic = jsonRecord(runtime?.payload);
    const event = jsonRecord(diagnostic?.data);
    const agentId = toBoundedIdentity(row.agentId);
    const controlAtEpochMs = toFiniteNonnegativeObservation(row.atEpochMs);
    if (
        !agentId || !input.agentIds.includes(agentId) || !event || controlAtEpochMs === null ||
        controlAtEpochMs < input.failureInterval.startedAtEpochMs ||
        controlAtEpochMs > input.failureInterval.failedAtEpochMs
    ) {
        return null;
    }
    return {
        agentId,
        event,
        streamRow,
        controlAtEpochMs,
        topic: typeof runtime?.topic === 'string' ? runtime.topic : null,
        runtimeAtEpochMs: toFiniteNonnegativeObservation(diagnostic?.atEpochMs),
        eventId: toBoundedIdentity(row.name)
    };
}

function toLiveRtcDiagnosticEvent(
    scoped: LiveRtcScopedRecorderEvent,
    sourceIdentities: ReadonlyMap<string, LiveRtcSignalingIdentityObservations>
): LiveRtcJsonRecord | null {
    const { event, topic } = scoped;
    const identity = {
        streamRow: scoped.streamRow,
        eventId: scoped.eventId,
        agentId: scoped.agentId,
        kind: event.kind ?? null,
        controlAtEpochMs: scoped.controlAtEpochMs,
        runtimeAtEpochMs: scoped.runtimeAtEpochMs
    };
    if (topic === 'rallar.browser.rtc.signaling_diagnostics') {
        const signaling = toRtcSignalingObservation(event);
        return signaling ? { ...identity, ...signaling } : null;
    }
    if (topic === 'rallar.bb.http.failure' && event.kind === 'http-request-failed') {
        return { ...identity, ...toHttpRequestFailureObservation(event) };
    }
    if (topic === 'rallar.browser.formation.not-ready' && event.kind === 'formation-readiness-rejected') {
        return { ...identity, ...toFormationReadinessRejectionObservation(event) };
    }
    if (topic === RTC_AL_OUTBOUND_TOPIC && event.kind === 'commit-phases' && event.typeId === AppTopics.rtcSignaling) {
        return { ...identity, ...toLiveRtcSignalingCommit(event) };
    }
    if (topic === RTC_AL_INBOUND_TOPIC) {
        const signaling = toLiveRtcSignalingInbound(event, scoped.agentId, sourceIdentities);
        return signaling ? { ...identity, ...signaling } : null;
    }
    if (
        topic !== 'rallar.browser.rtc.lifecycle' || typeof event.kind !== 'string' ||
        !Object.hasOwn(RTC_LIFECYCLE_KINDS, event.kind)
    ) {
        return null;
    }
    const peerId = toBoundedIdentity(event.peerId);
    const laneId = toBoundedIdentity(event.laneId);
    return {
        ...identity,
        browserAtEpochMs: toFiniteNonnegativeObservation(event.atEpochMs),
        peerId,
        laneId,
        observation: 'facade-current-at-notification',
        peerObservation: toLifecyclePeerObservation(event.peer, peerId),
        laneObservation: laneId === null ? null : toLifecycleLaneObservation(event.lane, peerId, laneId)
    };
}

function toRtcSignalingObservation(event: LiveRtcJsonRecord): LiveRtcJsonRecord | null {
    const signalType = toAllowedLifecycleState(event.signalType, ['Offer', 'Answer', 'IceCandidate']);
    const common = {
        producerAtEpochMs: toFiniteNonnegativeObservation(event.atEpochMs),
        localSessionId: toBoundedIdentity(event.localSessionId),
        peerSessionId: toBoundedIdentity(event.peerSessionId),
        signalType,
        offerId: signalType === 'Offer' || signalType === 'Answer' ? toBoundedIdentity(event.offerId) : null,
        observation: 'owned-signal-decision-not-application-receipt'
    };
    if (event.kind === 'service-signal-route') {
        const disposition = toAllowedLifecycleState(event.disposition, RTC_SERVICE_SIGNAL_DISPOSITIONS);
        return disposition === null ? null : {
            ...common,
            disposition,
            result: toAllowedLifecycleState(event.result, [
                'self',
                'dial-denied',
                'connect-failed',
                'connect-exhausted',
                'signal-handle-failed',
                'setup-started',
                'setup-in-flight',
                'setup-established'
            ])
        };
    }
    if (event.kind === 'native-signal-decision') {
        const disposition = toAllowedLifecycleState(event.disposition, RTC_NATIVE_SIGNAL_DISPOSITIONS);
        return disposition === null ? null : {
            ...common,
            disposition,
            capturedPeerConnection: toLifecycleBoolean(event.capturedPeerConnection),
            currentPeerConnection: toLifecycleBoolean(event.currentPeerConnection),
            offerMatches: toLifecycleBoolean(event.offerMatches),
            signalingState: toAllowedLifecycleState(event.signalingState, RTC_SIGNALING_STATES)
        };
    }
    if (event.kind === 'signal-caller-release') {
        const disposition = toAllowedLifecycleState(event.disposition, RTC_SIGNAL_CALLER_RELEASES);
        return disposition === null ? null : {
            ...common,
            disposition,
            capturedPeerConnection: toLifecycleBoolean(event.capturedPeerConnection),
            currentPeerConnection: toLifecycleBoolean(event.currentPeerConnection)
        };
    }
    return null;
}

function toHttpRequestFailureObservation(event: LiveRtcJsonRecord): LiveRtcJsonRecord {
    return {
        commandId: toBoundedIdentity(event.commandId),
        phase: toAllowedLifecycleState(event.phase, ['fetch', 'body', 'response']),
        scopeAborted: toLifecycleBoolean(event.scopeAborted),
        scopeAbortOrigin: toAllowedLifecycleState(event.scopeAbortOrigin, ['timeout', 'parent']),
        observation: 'http-request-failure-with-owned-scope-state'
    };
}

function toFormationReadinessRejectionObservation(event: LiveRtcJsonRecord): LiveRtcJsonRecord {
    const captured = toFormationReadinessCapturedFacts({
        returnedRoomReason: event.returnedRoomReason,
        laneId: event.laneId,
        desiredPeerIds: event.desiredPeerIds,
        readyPeerIds: event.readyPeerIds,
        peerIdentitiesTruncated: event.peerIdentitiesTruncated
    });
    return {
        roomTransportState: typeof event.roomTransportState === 'string' &&
                Object.hasOwn(ROOM_TRANSPORT_STATES, event.roomTransportState)
            ? event.roomTransportState
            : null,
        summaryAvailable: toLifecycleBoolean(event.summaryAvailable),
        roomOpen: toLifecycleBoolean(event.roomOpen),
        hasDesiredPeers: toLifecycleBoolean(event.hasDesiredPeers),
        desiredPeerCount: toFiniteNonnegativeObservation(event.desiredPeerCount),
        readyPeerCount: toFiniteNonnegativeObservation(event.readyPeerCount),
        waitTerminalCause: 'unknown',
        observation: 'captured-room-wait-result-at-formation-rejection',
        returnedRoomReason: captured.returnedRoomReason,
        laneId: captured.laneId,
        desiredPeerIds: captured.desiredPeerIds === null ? null : [...captured.desiredPeerIds],
        readyPeerIds: captured.readyPeerIds === null ? null : [...captured.readyPeerIds],
        peerIdentitiesTruncated: captured.peerIdentitiesTruncated
    };
}

function toLiveRtcSignalingCommit(event: LiveRtcJsonRecord): LiveRtcJsonRecord {
    return {
        senderId: toBoundedIdentity(event.senderId),
        msgId: toBoundedIdentity(event.msgId),
        typeId: AppTopics.rtcSignaling,
        lane: toAllowedLifecycleState(event.lane, AL_LANES),
        origin: toAllowedLifecycleState(event.origin, AL_COMMIT_ORIGINS),
        commitOutcome: toAllowedLifecycleState(event.commitOutcome, AL_COMMIT_OUTCOMES),
        readDurationMs: toFiniteNonnegativeObservation(event.readDurationMs),
        readOperationCount: toFiniteNonnegativeObservation(event.readOperationCount),
        commitDurationMs: toFiniteNonnegativeObservation(event.commitDurationMs),
        observation: 'local-admission-store-commit-not-network-delivery'
    };
}

function toLiveRtcSignalingInbound(
    event: LiveRtcJsonRecord,
    agentId: string,
    sourceIdentities: ReadonlyMap<string, LiveRtcSignalingIdentityObservations>
): LiveRtcJsonRecord | null {
    const key = toLiveRtcInboundIdentityKey(event, agentId);
    const observations = key === null ? undefined : sourceIdentities.get(key);
    if (event.kind === 'consumer-invocation') {
        return event.typeId === AppTopics.rtcSignaling ? toLiveRtcConsumerInvocation(event) : null;
    }
    if (event.kind === 'dispatch-decision') {
        return event.typeId === AppTopics.rtcSignaling ? toLiveRtcDispatchDecision(event) : null;
    }
    const link = { sourceObserved: resolveLiveRtcSignalingLink(observations), retained: 'unknown' };
    if (event.kind === 'admission-outcome' && event.typeId === AppTopics.rtcSignaling) {
        return {
            workerId: toBoundedIdentity(event.workerId),
            msgId: toBoundedIdentity(event.msgId),
            typeId: AppTopics.rtcSignaling,
            carrier: toAllowedLifecycleState(event.carrier, AL_CARRIERS),
            outcome: toAllowedLifecycleState(event.outcome, AL_ADMISSION_OUTCOMES),
            observation: 'owned-work-admission-not-dispatch',
            dispatchLink: link
        };
    }
    if (event.kind !== 'claim-settled' || !observations?.rtcAdmission) {
        return null;
    }
    const startedAtMs = toFiniteNonnegativeObservation(event.startedAtMs);
    const batchStartedAtMs = toFiniteNonnegativeObservation(event.batchStartedAtMs);
    return {
        workerId: toBoundedIdentity(event.workerId),
        effectId: toBoundedIdentity(event.effectId),
        msgId: toBoundedIdentity(event.msgId),
        subjectMsgId: toBoundedIdentity(event.subjectMsgId),
        typeId: null,
        identifiedTypeId: observations.conflictingAdmission ? null : AppTopics.rtcSignaling,
        payloadKind: 'dispatch-local',
        lane: toAllowedLifecycleState(event.lane, AL_LANES),
        outcome: toAllowedLifecycleState(event.outcome, AL_CLAIM_OUTCOMES),
        attempts: toFiniteNonnegativeObservation(event.attempts),
        queueWaitMs: toFiniteNonnegativeObservation(event.queueWaitMs),
        durationMs: toFiniteNonnegativeObservation(event.durationMs),
        dueAtMs: toFiniteNonnegativeObservation(event.dueAtMs),
        batchStartedAtMs,
        startedAtMs,
        intraBatchWaitMs: startedAtMs !== null && batchStartedAtMs !== null && startedAtMs >= batchStartedAtMs
            ? startedAtMs - batchStartedAtMs
            : null,
        observation: 'owned-work-settlement-not-selected-consumer-invocation',
        admissionLink: link
    };
}

function toLiveRtcConsumerInvocation(event: LiveRtcJsonRecord): LiveRtcJsonRecord {
    return {
        msgId: toBoundedIdentity(event.msgId),
        typeId: AppTopics.rtcSignaling,
        carrier: event.carrier === 'ws' ? 'ws' : null,
        workerId: null,
        effectId: null,
        lane: null,
        attempts: null,
        selection: toAllowedLifecycleState(event.selection, AL_CONSUMER_SELECTIONS),
        outcome: toAllowedLifecycleState(event.outcome, AL_CONSUMER_OUTCOMES),
        beganAtMs: toFiniteNonnegativeObservation(event.beganAtMs),
        settledAtMs: toFiniteNonnegativeObservation(event.settledAtMs),
        observation: 'exact-type-consumer-settlement-not-native-application'
    };
}

function toLiveRtcDispatchDecision(event: LiveRtcJsonRecord): LiveRtcJsonRecord {
    return {
        workerId: toBoundedIdentity(event.workerId),
        effectId: toBoundedIdentity(event.effectId),
        msgId: toBoundedIdentity(event.msgId),
        typeId: AppTopics.rtcSignaling,
        lane: toAllowedLifecycleState(event.lane, AL_LANES),
        carrier: toAllowedLifecycleState(event.carrier, AL_CARRIERS),
        attempts: toFiniteNonnegativeObservation(event.attempts),
        producerAtEpochMs: toFiniteNonnegativeObservation(event.atEpochMs),
        disposition: toAllowedLifecycleState(event.disposition, AL_DISPATCH_DISPOSITIONS),
        observation: 'owned-dispatch-decision-not-selected-consumer-invocation'
    };
}

function toLiveRtcInboundIdentityKey(event: LiveRtcJsonRecord, agentId: string): string | null {
    const msgId = toBoundedIdentity(event.msgId);
    const workerId = toBoundedIdentity(event.workerId);
    if (!msgId || !workerId) {
        return null;
    }
    if (event.kind === 'admission-outcome') {
        return JSON.stringify([agentId, workerId, msgId]);
    }
    if (
        event.kind !== 'claim-settled' || event.payloadKind !== 'dispatch-local' || event.typeId !== null ||
        toBoundedIdentity(event.subjectMsgId) !== msgId
    ) {
        return null;
    }
    if (event.lane === 'durable') {
        return JSON.stringify([agentId, workerId, msgId]);
    }
    if (event.lane === 'volatile' && workerId.endsWith('/volatile') && workerId.length > '/volatile'.length) {
        return JSON.stringify([agentId, workerId.slice(0, -'/volatile'.length), msgId]);
    }
    return null;
}

function computeLiveRtcSignalingIdentities(
    input: LiveRtcLifecycleHistoryInput
): Map<string, LiveRtcSignalingIdentityObservations> {
    const identities = new Map<string, LiveRtcSignalingIdentityObservations>();
    for (const { line, streamRow } of toLiveRtcRecorderLines(input)) {
        if (Buffer.byteLength(line) > LIVE_RTC_LIFECYCLE_LIMITS.rowBytes) {
            continue;
        }
        const row = toLiveRtcRecorderRow(line);
        const scoped = row ? toLiveRtcScopedRecorderEvent(row, input, streamRow) : null;
        if (scoped?.topic === RTC_AL_INBOUND_TOPIC) {
            const key = toLiveRtcInboundIdentityKey(scoped.event, scoped.agentId);
            if (key !== null) {
                identities.set(key, computeLiveRtcSignalingIdentityObservations(identities.get(key), scoped.event));
            }
        }
    }
    return identities;
}

function computeLiveRtcSignalingIdentityObservations(
    previous: LiveRtcSignalingIdentityObservations | undefined,
    event: LiveRtcJsonRecord
): LiveRtcSignalingIdentityObservations {
    return {
        rtcAdmission: previous?.rtcAdmission === true ||
            (event.kind === 'admission-outcome' && event.typeId === AppTopics.rtcSignaling),
        conflictingAdmission: previous?.conflictingAdmission === true ||
            (event.kind === 'admission-outcome' && event.typeId !== AppTopics.rtcSignaling),
        dispatch: previous?.dispatch === true || event.kind === 'claim-settled'
    };
}

function resolveLiveRtcSignalingLink(
    observations: LiveRtcSignalingIdentityObservations | undefined
): LiveRtcSignalingLink {
    if (!observations?.rtcAdmission || !observations.dispatch) {
        return 'unknown';
    }
    return observations.conflictingAdmission ? 'ambiguous' : 'matched';
}

function computeRetainedLiveRtcSignalingLinks(
    scanned: LiveRtcLifecycleScan,
    sourceIdentities: ReadonlyMap<string, LiveRtcSignalingIdentityObservations>
): LiveRtcLifecycleScan {
    const scan = { ...scanned, events: [...scanned.events] };
    let droppedRows: number;
    do {
        droppedRows = scan.outputDroppedRows;
        const retainedIdentities = new Map<string, LiveRtcSignalingIdentityObservations>();
        for (const event of scan.events) {
            if (
                typeof event.agentId === 'string' &&
                (event.kind === 'admission-outcome' || event.kind === 'claim-settled')
            ) {
                const key = toLiveRtcInboundIdentityKey(event, event.agentId);
                if (key !== null) {
                    retainedIdentities.set(
                        key,
                        computeLiveRtcSignalingIdentityObservations(retainedIdentities.get(key), event)
                    );
                }
            }
        }
        scan.events.forEach((event, index) => {
            const field = event.kind === 'admission-outcome'
                ? 'dispatchLink'
                : event.kind === 'claim-settled'
                ? 'admissionLink'
                : null;
            if (field && typeof event.agentId === 'string') {
                const key = toLiveRtcInboundIdentityKey(event, event.agentId);
                const sourceObserved = resolveLiveRtcSignalingLink(
                    key === null ? undefined : sourceIdentities.get(key)
                );
                const retained = resolveLiveRtcSignalingLink(key === null ? undefined : retainedIdentities.get(key));
                scan.events[index] = {
                    ...event,
                    [field]: {
                        sourceObserved,
                        retained: retained === 'matched' && sourceObserved === 'ambiguous' ? 'ambiguous' : retained
                    }
                };
            }
        });
        scan.outputBytes = scan.events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
        const retention = computeLiveRtcEventRetention(scan.events, scan.outputBytes);
        scan.events.splice(0, retention.droppedRows);
        scan.outputDroppedRows += retention.droppedRows;
        scan.outputBytes = retention.outputBytes;
    }
    while (scan.outputDroppedRows !== droppedRows);
    return scan;
}

function toFiniteNonnegativeObservation(value: RtcBaselineJson | undefined): number | null {
    return isFiniteNonnegativeNumber(value) ? value : null;
}

function toLifecyclePeerObservation(value: RtcBaselineJson | undefined, peerId: string | null): RtcBaselineJson {
    const peer = jsonRecord(value);
    if (peerId === null || !peer || toBoundedIdentity(peer.peerId) !== peerId) {
        return null;
    }
    return {
        peerId,
        connection: toLifecycleConnectionObservation(peer.connection),
        lanes: Array.isArray(peer.lanes)
            ? peer.lanes.map((lane) => toLifecycleLaneObservation(lane, peerId, null))
            : null
    };
}

function toLifecycleConnectionObservation(value: RtcBaselineJson | undefined): RtcBaselineJson {
    const connection = jsonRecord(value);
    if (!connection) {
        return null;
    }
    const signaling = jsonRecord(connection.signaling);
    return {
        state: toAllowedLifecycleState(connection.state, RTC_WRAPPER_STATES),
        connectionState: toAllowedLifecycleState(connection.connectionState, RTC_CONNECTION_STATES),
        iceConnectionState: toAllowedLifecycleState(connection.iceConnectionState, RTC_ICE_CONNECTION_STATES),
        iceGatheringState: toAllowedLifecycleState(connection.iceGatheringState, RTC_ICE_GATHERING_STATES),
        signalingState: toAllowedLifecycleState(connection.signalingState, RTC_SIGNALING_STATES),
        hasLocalDescription: toLifecycleBoolean(connection.hasLocalDescription),
        hasRemoteDescription: toLifecycleBoolean(connection.hasRemoteDescription),
        makingOffer: toLifecycleBoolean(connection.makingOffer),
        iceCandidateQueueSize: toFiniteNonnegativeObservation(connection.iceCandidateQueueSize),
        signaling: signaling
            ? Object.fromEntries(
                RTC_SIGNALING_COUNT_FIELDS.map((field) => [field, toFiniteNonnegativeObservation(signaling[field])])
            )
            : null
    };
}

function toLifecycleLaneObservation(
    value: RtcBaselineJson | undefined,
    peerId: string | null,
    laneId: string | null
): RtcBaselineJson {
    const lane = jsonRecord(value);
    const observedLaneId = toBoundedIdentity(lane?.laneId);
    if (
        peerId === null || !lane || toBoundedIdentity(lane.peerId) !== peerId || observedLaneId === null ||
        (laneId !== null && observedLaneId !== laneId)
    ) {
        return null;
    }
    return {
        peerId,
        laneId: observedLaneId,
        isOpen: toLifecycleBoolean(lane.isOpen),
        isReconnectable: toLifecycleBoolean(lane.isReconnectable),
        readyState: toAllowedLifecycleState(jsonRecord(lane.channel)?.readyState, RTC_LANE_READY_STATES)
    };
}

function toAllowedLifecycleState(value: RtcBaselineJson | undefined, states: readonly string[]): string | null {
    return typeof value === 'string' && states.includes(value) ? value : null;
}

function toLifecycleBoolean(value: RtcBaselineJson | undefined): boolean | null {
    return typeof value === 'boolean' ? value : null;
}
