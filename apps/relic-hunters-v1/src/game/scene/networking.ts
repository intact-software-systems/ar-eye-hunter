import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import {
    rallar,
    type RallarRealtimeMessage,
    type RallarRoomRealtimeSendResult,
    type RallarRoomRealtimeSendStatus
} from '@shared-web/browser/rallar.ts';
import {
    RallarMotion,
    type RallarMotionAdaptiveDelay,
    type RallarMotionBuffer,
    type RallarMotionEstimate,
    type RallarMotionEstimateMode,
    type RallarMotionKinematicsEstimator,
    type RallarMotionSendGate,
    type RallarMotionVec3
} from '@shared/rallar-motion/mod.ts';
import {
    RELIC_MOTION_DEFAULT_DELAY_MS,
    RELIC_MOTION_FORCE_SEND_AFTER_MS,
    RELIC_MOTION_IDLE_CADENCE_MS,
    RELIC_MOTION_MAX_DELAY_MS,
    RELIC_MOTION_MAX_EXTRAPOLATION_MS,
    RELIC_MOTION_MIN_DELAY_MS,
    RELIC_MOTION_MIN_POSITION_DELTA,
    RELIC_MOTION_MIN_ROTATION_DELTA,
    RELIC_MOTION_SEND_CADENCE_MS
} from './motionTuning.ts';
import { roomWorldPosition } from './rooms.ts';

export const POS_MAX_AGE_MS = 2500;
export const RELIC_MOTION_PROTOCOL = 'relic.motion.v1';
export const RELIC_MOTION_LANE_ID = 'realtime';
export const RELIC_MOTION_OPEN_TIMEOUT_MS = 500;
export const RELIC_MOTION_FIRST_WAIT_TIMEOUT_MS = 1000;
export const RELIC_MOTION_MAX_AGE_MS = 180;

export type RelicMotionPhase = 'idle' | 'walk' | 'sprint' | 'inspect';

export type RelicMotionPayload = Readonly<{
    protocol: typeof RELIC_MOTION_PROTOCOL;
    version: 1;
    kind: 'relic-motion';
    pid: string;
    roomId: string;
    seq: number;
    x: number;
    y: number;
    z: number;
    ox: number;
    oz: number;
    r: number;
    vx?: number;
    vy?: number;
    vz?: number;
    vr?: number;
    phase: RelicMotionPhase;
    sentAtEpochMs: number;
}>;

export type RelicMotionMetadata = Readonly<{
    roomId: string;
    senderPeerId: string;
    playerId: string;
    sentAtEpochMs: number;
    phase: RelicMotionPhase;
}>;

export type RelicMotionDiagnostics = {
    laneId: typeof RELIC_MOTION_LANE_ID;
    laneReady: boolean;
    readyPeerCount: number;
    lastReadyWaitStatus?: string;
    lastSendStatus?: RallarRoomRealtimeSendStatus;
    lastSendReason?: string;
    lastSampleAgeMs?: number;
    lastEstimateMode?: RallarMotionEstimateMode;
    lastConfidence?: number;
    acceptedSamples: number;
    staleSamples: number;
    duplicateSamples: number;
    droppedSamples: number;
};

export type RelicMotionRuntimeState = {
    buffer: RallarMotionBuffer<RelicMotionMetadata>;
    adaptiveDelay: RallarMotionAdaptiveDelay;
    sendGate: RallarMotionSendGate;
    kinematics: RallarMotionKinematicsEstimator;
    seq: { value: number; };
    laneReady: { value: boolean; };
    readyWait: { value?: Promise<boolean>; };
    lastReadyWaitEpochMs: { value: number; };
    diagnostics: RelicMotionDiagnostics;
};

export type RelicScenePositionRuntime = Readonly<{
    snapshot: { value?: RelicPublicSnapshot; };
    localPlayerId: { value?: string; };
    rtcReady: { value: boolean; };
    roamOffset: Vector3;
    cameraYaw: { value: number; };
    motionPhase: { value: RelicMotionPhase; };
    motion: RelicMotionRuntimeState;
}>;

interface RelicLocalMotionSample {
    readonly snapshotRoomId: string;
    readonly playerId: string;
    readonly playerRoomId: string;
    readonly nowEpochMs: number;
    readonly position: RallarMotionVec3;
    readonly rotation: RallarMotionVec3;
}

interface WriteRelicLocalMotionInput {
    readonly runtime: RelicScenePositionRuntime;
    readonly sample: RelicLocalMotionSample;
    readonly seq: number;
    readonly velocity: RallarMotionVec3 | undefined;
    readonly angularVelocity: RallarMotionVec3 | undefined;
}

export function createRelicMotionState(): RelicMotionRuntimeState {
    const adaptiveDelay = RallarMotion.createAdaptiveDelay({
        defaultDelayMs: RELIC_MOTION_DEFAULT_DELAY_MS,
        minDelayMs: RELIC_MOTION_MIN_DELAY_MS,
        maxDelayMs: RELIC_MOTION_MAX_DELAY_MS
    });
    return {
        adaptiveDelay,
        buffer: RallarMotion.createBuffer<RelicMotionMetadata>({
            readInterpolationDelayMs: adaptiveDelay.currentDelayMs,
            maxExtrapolationMs: RELIC_MOTION_MAX_EXTRAPOLATION_MS,
            interpolationMode: 'hermite',
            rotationWrap: { period: Math.PI * 2 },
            discontinuity: { enabled: true, maxPositionDelta: 4.5 }
        }),
        sendGate: RallarMotion.createSendGate({
            cadenceMs: RELIC_MOTION_SEND_CADENCE_MS,
            idleCadenceMs: RELIC_MOTION_IDLE_CADENCE_MS,
            minPositionDelta: RELIC_MOTION_MIN_POSITION_DELTA,
            minRotationDelta: RELIC_MOTION_MIN_ROTATION_DELTA,
            forceSendAfterMs: RELIC_MOTION_FORCE_SEND_AFTER_MS,
            rotationWrap: { period: Math.PI * 2 }
        }),
        kinematics: RallarMotion.createKinematicsEstimator({
            smoothingAlpha: 0.45,
            rotationWrap: { period: Math.PI * 2 }
        }),
        seq: { value: 0 },
        laneReady: { value: false },
        readyWait: { value: undefined },
        lastReadyWaitEpochMs: { value: 0 },
        diagnostics: {
            laneId: RELIC_MOTION_LANE_ID,
            laneReady: false,
            readyPeerCount: 0,
            acceptedSamples: 0,
            staleSamples: 0,
            duplicateSamples: 0,
            droppedSamples: 0
        }
    };
}

export function subscribeRelicScenePositionUpdates(
    runtime: RelicScenePositionRuntime
): () => void {
    return rallar.realtime.onJson<RelicMotionPayload>(
        RELIC_MOTION_LANE_ID,
        (message) => {
            applyRelicMotionMessage(runtime, message);
        }
    );
}

export function applyRelicMotionMessage(
    runtime: RelicScenePositionRuntime,
    message: RallarRealtimeMessage<RelicMotionPayload>
): boolean {
    return applyRelicMotionPayload(
        runtime,
        message.data,
        message.peerId,
        message.receivedAtEpochMs
    );
}

export function applyRelicMotionPayload(
    runtime: RelicScenePositionRuntime,
    payload: unknown,
    senderPeerId: string,
    receivedAtEpochMs: number
): boolean {
    if (!isRelicMotionPayload(payload)) {
        return false;
    }
    if (payload.pid === runtime.localPlayerId.value) {
        return false;
    }

    const snapshot = runtime.snapshot.value;
    const player = snapshot?.players.find((candidate) => candidate.playerId === payload.pid);
    if (!snapshot || !player || player.escaped || player.defeated || player.roomId !== payload.roomId) {
        runtime.motion.buffer.remove(payload.pid);
        runtime.motion.kinematics.remove(payload.pid);
        return false;
    }

    const position = resolveRelicMotionPosition(payload, snapshot);
    if (!position) {
        return false;
    }

    const rotation: RallarMotionVec3 = [0, payload.r, 0];
    const velocity = vectorIfFinite(payload.vx, payload.vy, payload.vz);
    const angularVelocity: RallarMotionVec3 | undefined = Number.isFinite(payload.vr)
        ? [0, payload.vr ?? 0, 0]
        : undefined;
    const sample = {
        entityId: payload.pid,
        observedAtEpochMs: receivedAtEpochMs,
        position,
        rotation,
        seq: payload.seq,
        metadata: {
            roomId: payload.roomId,
            senderPeerId,
            playerId: payload.pid,
            sentAtEpochMs: payload.sentAtEpochMs,
            phase: payload.phase
        },
        ...(velocity ? { velocity } : {}),
        ...(angularVelocity ? { angularVelocity } : {})
    };
    const kinematics = runtime.motion.kinematics.push(sample);
    const result = runtime.motion.buffer.push({
        ...sample,
        velocity: velocity ?? kinematics.velocity,
        angularVelocity: angularVelocity ?? kinematics.angularVelocity
    });

    runtime.motion.adaptiveDelay.pushObservedAt(receivedAtEpochMs);
    updatePushDiagnostics(runtime.motion.diagnostics, result.status, result.droppedSampleCount);
    runtime.motion.diagnostics.lastSampleAgeMs = 0;
    return result.status === 'accepted';
}

export function isRelicMotionPayload(payload: unknown): payload is RelicMotionPayload {
    if (!isRecord(payload)) {
        return false;
    }
    return payload.protocol === RELIC_MOTION_PROTOCOL &&
        payload.version === 1 &&
        payload.kind === 'relic-motion' &&
        typeof payload.pid === 'string' &&
        payload.pid.length > 0 &&
        typeof payload.roomId === 'string' &&
        payload.roomId.length > 0 &&
        Number.isSafeInteger(payload.seq) &&
        isFiniteNumber(payload.x) &&
        isFiniteNumber(payload.y) &&
        isFiniteNumber(payload.z) &&
        isFiniteNumber(payload.ox) &&
        isFiniteNumber(payload.oz) &&
        isFiniteNumber(payload.r) &&
        isFiniteNumber(payload.sentAtEpochMs) &&
        isRelicMotionPhase(payload.phase) &&
        optionalFinite(payload.vx) &&
        optionalFinite(payload.vy) &&
        optionalFinite(payload.vz) &&
        optionalFinite(payload.vr);
}

export function resolveRelicMotionPosition(
    update: RelicMotionPayload,
    snapshot: RelicPublicSnapshot | undefined
): RallarMotionVec3 | undefined {
    const room = snapshot?.map.find((candidate) => candidate.id === update.roomId);
    if (room) {
        const world = roomWorldPosition(room);
        return [world.x + update.ox, update.y, world.z + update.oz];
    }

    if (isFiniteNumber(update.x) && isFiniteNumber(update.y) && isFiniteNumber(update.z)) {
        return [update.x, update.y, update.z];
    }

    return undefined;
}

export function isRelicMotionEstimateFreshForPlayer(
    estimate: RallarMotionEstimate<RelicMotionMetadata> | undefined,
    playerRoomId: string,
    nowEpochMs: number
): estimate is RallarMotionEstimate<RelicMotionMetadata> {
    return !!estimate &&
        estimate.metadata?.roomId === playerRoomId &&
        nowEpochMs - estimate.observedAtEpochMs < POS_MAX_AGE_MS;
}

export async function broadcastLocalPosition(
    runtime: RelicScenePositionRuntime
): Promise<void> {
    if (!runtime.rtcReady.value) {
        return;
    }
    if (rallar.rooms.state().currentRoom?.group.transportState === 'halted') {
        recordHaltedRelicMotion(runtime);
        return;
    }
    const nowEpochMs = Date.now();
    const sample = resolveRelicLocalMotionSample(runtime, nowEpochMs);
    if (!sample) {
        return;
    }
    const sampleForGate = { position: sample.position, rotation: sample.rotation };
    const decision = runtime.motion.sendGate.check(sampleForGate, nowEpochMs);
    runtime.motion.diagnostics.lastSendReason = decision.reason;
    if (!decision.shouldSend) {
        return;
    }

    const seq = runtime.motion.seq.value + 1;
    runtime.motion.seq.value = seq;
    const localSample = {
        entityId: sample.playerId,
        observedAtEpochMs: nowEpochMs,
        position: sample.position,
        rotation: sample.rotation,
        seq
    };
    const kinematics = runtime.motion.kinematics.push(localSample);
    try {
        const result = await writeRelicLocalMotion({
            runtime,
            sample,
            seq,
            velocity: kinematics.velocity,
            angularVelocity: kinematics.angularVelocity
        });
        const sent = result.status === 'sent' || result.status === 'partial';
        runtime.motion.laneReady.value = sent;
        runtime.motion.diagnostics.laneReady = sent;
        runtime.motion.diagnostics.readyPeerCount = result.peerIds.length;
        runtime.motion.diagnostics.lastReadyWaitStatus = result.readiness?.status ?? result.transportStatus?.rtc.state;
        runtime.motion.diagnostics.lastSendStatus = result.status;
        if (sent) {
            runtime.motion.sendGate.recordSent(sampleForGate, nowEpochMs);
        }
    }
    catch {
        runtime.motion.laneReady.value = false;
        runtime.motion.diagnostics.laneReady = false;
        runtime.motion.diagnostics.lastSendStatus = 'failed';
    }
}

function recordHaltedRelicMotion(runtime: RelicScenePositionRuntime): void {
    runtime.motion.laneReady.value = false;
    runtime.motion.diagnostics.laneReady = false;
    runtime.motion.diagnostics.readyPeerCount = 0;
    runtime.motion.diagnostics.lastSendStatus = 'halted';
    runtime.motion.diagnostics.lastSendReason = 'Room transport is halted by authoritative group state.';
}

function resolveRelicLocalMotionSample(
    runtime: RelicScenePositionRuntime,
    nowEpochMs: number
): RelicLocalMotionSample | undefined {
    const snapshot = runtime.snapshot.value;
    const localPlayerId = runtime.localPlayerId.value;
    const localPlayer = snapshot?.players.find((player) => player.playerId === localPlayerId);
    if (!snapshot || !localPlayer || localPlayer.escaped || localPlayer.defeated) {
        return undefined;
    }
    const room = snapshot.map.find((candidate) => candidate.id === localPlayer.roomId);
    if (!room) {
        return undefined;
    }
    const world = roomWorldPosition(room);
    return {
        snapshotRoomId: snapshot.roomId,
        playerId: localPlayer.playerId,
        playerRoomId: room.id,
        nowEpochMs,
        position: [world.x + runtime.roamOffset.x, 0.65, world.z + runtime.roamOffset.z],
        rotation: [0, runtime.cameraYaw.value, 0]
    };
}

async function writeRelicLocalMotion(
    input: WriteRelicLocalMotionInput
): Promise<RallarRoomRealtimeSendResult> {
    const { runtime, sample, seq, velocity, angularVelocity } = input;
    return await rallar.realtime.room<RelicMotionPayload>({
        laneId: RELIC_MOTION_LANE_ID,
        roomId: sample.snapshotRoomId,
        openTimeoutMs: RELIC_MOTION_OPEN_TIMEOUT_MS,
        waitTimeoutMs: RELIC_MOTION_FIRST_WAIT_TIMEOUT_MS
    }).send({
        protocol: RELIC_MOTION_PROTOCOL,
        version: 1,
        kind: 'relic-motion',
        pid: sample.playerId,
        roomId: sample.playerRoomId,
        seq,
        x: sample.position[0],
        y: sample.position[1],
        z: sample.position[2],
        ox: runtime.roamOffset.x,
        oz: runtime.roamOffset.z,
        r: runtime.cameraYaw.value,
        phase: runtime.motionPhase.value,
        sentAtEpochMs: sample.nowEpochMs,
        ...(velocity ? { vx: velocity[0], vy: velocity[1], vz: velocity[2] } : {}),
        ...(angularVelocity ? { vr: angularVelocity[1] } : {})
    }, {
        key: `relic-motion:${sample.playerId}`,
        maxAgeMs: RELIC_MOTION_MAX_AGE_MS
    });
}

function updatePushDiagnostics(
    diagnostics: RelicMotionDiagnostics,
    status: 'accepted' | 'duplicate-seq' | 'stale-seq' | 'dropped-old-sample',
    droppedSampleCount: number
): void {
    if (status === 'accepted') {
        diagnostics.acceptedSamples += 1;
    }
    else if (status === 'duplicate-seq') {
        diagnostics.duplicateSamples += 1;
    }
    else if (status === 'stale-seq') {
        diagnostics.staleSamples += 1;
    }
    else {
        diagnostics.droppedSamples += 1;
    }
    diagnostics.droppedSamples += droppedSampleCount;
}

function isRelicMotionPhase(value: unknown): value is RelicMotionPhase {
    return value === 'idle' ||
        value === 'walk' ||
        value === 'sprint' ||
        value === 'inspect';
}

function vectorIfFinite(x: unknown, y: unknown, z: unknown): RallarMotionVec3 | undefined {
    if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z)) {
        return [x, y, z];
    }
    return undefined;
}

function optionalFinite(value: unknown): boolean {
    return value === undefined || isFiniteNumber(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
