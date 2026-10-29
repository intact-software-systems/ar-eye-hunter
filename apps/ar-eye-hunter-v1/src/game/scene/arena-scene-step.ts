import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import {
    estimateRallarMotionVelocity
} from '@shared/rallar-motion/mod.ts';

import type {
    ArenaSnapshot,
    EyeTargetState,
    PlayerHitAccepted,
    PlayerInputState,
    ShotIntent,
    Vec3Tuple,
    WeaponKind
} from '../arena-contracts.ts';
import { type ArenaSimulationState } from '../arena-contracts.ts';
import { stepLocalPlayer } from '../arena-player-state.ts';
import { resolveShot, type ShotResolution } from '../arena-targets.ts';
import { getWeaponStats } from '../arena-weapons.ts';
import {
    shouldFireHeldWeapon
} from '../mobile-input.ts';
import {
    applyPlayerHitAccepted,
    findPickupNearPlayer,
    toArenaSnapshot,
    upsertPlayerPose
} from '../simulation.ts';
import { syncRemoteAvatars, syncRemoteShots } from './arena-peer-view.ts';
import type {
    BabylonArenaProps,
    LocalPoseHistory,
    MutableInputState
} from './arena-scene-contracts.ts';
import {
    createArenaEventEffect,
    createImpact,
    createTracer,
    updateTransientEffects
} from './arena-scene-effects.ts';
import { syncAdaptiveAudio, triggerHaptic } from './arena-scene-feedback.ts';
import {
    addTuple,
    clamp,
    forwardFromAngles,
    round3,
    scaleTuple,
    vector3
} from './arena-scene-geometry.ts';
import type { ArenaSceneRuntime } from './arena-scene-runtime.ts';
import { ARENA_SCENE_THEME } from './arena-scene-theme.ts';
import { findPredictedPlayerHit } from './arena-shot-aim.ts';
import {
    isHostileEye,
    syncEyeAttackCues,
    syncPickupAvatars,
    syncTargetAvatars
} from './arena-target-view.ts';

const BASE_FOV = 0.94;

interface ArenaSceneStepInput extends BabylonArenaProps {
    readonly runtime: ArenaSceneRuntime;
}
export function runFrame(input: ArenaSceneStepInput): void {
    const { runtime } = input;
    const now = runtime.clock.nowEpochMs();
    const rawDtMs = now - runtime.lastFrameEpochMs;
    const dtMs = runtime.hitStopUntilEpochMs > now ? Math.min(rawDtMs, 8) : rawDtMs;
    runtime.lastFrameEpochMs = now;
    reconcileSceneObservations(input);
    if (input.spectating) {
        syncScenePresentation(input, now);
        runtime.camera.position = new Vector3(
            0,
            runtime.arenaState.layout.halfSize * 1.6,
            -runtime.arenaState.layout.halfSize
        );
        runtime.camera.setTarget(Vector3.Zero());
        return;
    }
    advancePlayerPrediction(input, dtMs, now);
    syncScenePresentation(input, now);
    if (input.networkEnabled) {
        maybeFireHeldShot(input, now);
        detectLocalPickup(input);
        publishLocalPose(input, now);
    }
    input.onLocalPlayerChange({ vitals: runtime.localPlayer.vitals, loadout: runtime.localPlayer.loadout });
    if (
        input.networkEnabled && runtime.simulation.canPublish(now) &&
        runtime.lastSnapshotRevision !== runtime.arenaState.revision
    ) {
        runtime.lastSnapshotRevision = runtime.arenaState.revision;
        const snapshot = toArenaSnapshot(runtime.arenaState, input.roomId, now);
        runtime.simulation.setPublishedSnapshot(snapshot);
        input.onArenaSnapshot(snapshot);
    }
}
function reconcileSceneObservations(input: ArenaSceneStepInput): void {
    const { runtime, arenaSnapshot, authority, remoteEvents } = input;
    if (runtime.simulation.reconcile({ snapshot: arenaSnapshot, authority }) && arenaSnapshot) {
        if (!input.spectating) {
            syncLocalPlayerFromSnapshot(runtime, input.localSessionId, arenaSnapshot);
        }
    }
    for (const event of remoteEvents) {
        if (runtime.appliedEventIds.has(event.id)) {
            continue;
        }
        runtime.appliedEventIds.add(event.id);
        runtime.simulation.applyEvent(event);
        createArenaEventEffect(runtime, event);
    }
}
function advancePlayerPrediction(input: ArenaSceneStepInput, dtMs: number, now: number): void {
    const { runtime } = input;
    runtime.localPlayer = stepLocalPlayer({
        player: runtime.localPlayer,
        input: freezeInput(runtime.input),
        dtMs,
        nowEpochMs: now,
        arenaHalfSize: runtime.arenaState.layout.halfSize
    });
    const localPlayerId = input.localSessionId ?? 'local';
    runtime.arenaState = upsertPlayerPose(runtime.arenaState, {
        sessionId: localPlayerId,
        username: input.localUsername,
        color: input.localColor,
        score: runtime.localPlayer.combat.score,
        position: runtime.localPlayer.position,
        rotation: [runtime.localPlayer.pitch, runtime.localPlayer.yaw, 0],
        vitals: runtime.localPlayer.vitals,
        loadout: runtime.localPlayer.loadout,
        seq: runtime.poseSeqRef.current,
        sentAtEpochMs: now
    }, now);
    runtime.simulation.advance(now);
    syncLocalPlayerFromArenaState(runtime, localPlayerId);
    runtime.arenaState = animateTargets(runtime.arenaState, dtMs, now);
}
function syncScenePresentation(input: ArenaSceneStepInput, now: number): void {
    const { runtime } = input;
    const localPlayerId = input.localSessionId ?? 'local';
    syncPickupAvatars(runtime, now);
    syncTargetAvatars(runtime, now);
    syncEyeAttackCues(runtime, now);
    syncAdaptiveAudio({
        runtime,
        linkState: input.linkState,
        presenceNotices: input.presenceNotices,
        localPlayerId,
        now
    });
    runtime.audio.play({
        kind: 'eye-drone',
        threatCount: runtime.arenaState.targets.filter(isHostileEye).length,
        distanceFactor: runtime.audioSettings.reducedIntensity ? 0.55 : 1
    });
    const players = new Map(input.remotePlayers);
    for (const player of runtime.arenaState.players) {
        if (input.spectating || player.sessionId !== input.localSessionId) {
            const existing = players.get(player.sessionId);
            if (!existing || existing.pose.seq <= player.seq) {
                players.set(player.sessionId, {
                    pose: { ...player, score: player.score ?? 0, sentAtEpochMs: player.updatedAtEpochMs },
                    lastSeenEpochMs: now
                });
            }
        }
    }
    syncRemoteAvatars(runtime, players);
    syncRemoteShots(runtime, input.remoteShots);
    syncRemotePlayerHits(runtime, input.remotePlayerHits, localPlayerId);
    syncCamera(runtime, now);
    updateTransientEffects(runtime);
}

function maybeFireHeldShot(input: ArenaSceneStepInput, nowEpochMs: number): void {
    if (
        shouldFireHeldWeapon(input.runtime.input.fire, nowEpochMs, input.runtime.localPlayer.combat.shotReadyAtEpochMs)
    ) {
        fireLocalShot(input);
    }
}

interface ArenaLocalShotInput extends BabylonArenaProps {
    readonly runtime: ArenaSceneRuntime;
    readonly directionOverride?: Vec3Tuple;
    readonly touchAssisted?: boolean;
}
interface ArenaLocalShot extends ShotIntent {
    readonly weaponKind: WeaponKind;
}
interface ArenaShotPresentation {
    readonly shot: ArenaLocalShot;
    readonly resolution: ShotResolution;
    readonly touchAssisted: boolean;
}
export function fireLocalShot(input: ArenaLocalShotInput): void {
    if (input.spectating) {
        return;
    }
    reconcileSceneObservations(input);
    const { runtime, localUsername, localColor, roomId } = input;
    const now = runtime.clock.nowEpochMs();
    const sessionId = input.localSessionId ?? 'local';
    const shot = createLocalShot(input, now);
    const resolution = resolveShot({
        state: runtime.arenaState,
        combat: runtime.localPlayer.combat,
        shot,
        nowEpochMs: now
    });
    presentLocalShot(runtime, { shot, resolution, touchAssisted: input.touchAssisted ?? false });
    sendPredictedPlayerHit(input, shot);
    input.onLocalCombatChange(resolution.combat);
    if (!input.networkEnabled) {
        return;
    }
    input.onLocalShot(
        {
            origin: shot.origin,
            direction: shot.direction,
            charged: shot.charged,
            overdrive: shot.overdrive,
            seq: shot.seq,
            sentAtEpochMs: shot.sentAtEpochMs,
            weaponKind: shot.weaponKind
        },
        {
            ...resolution.accepted,
            shot: {
                ...resolution.accepted.shot,
                sessionId,
                username: localUsername,
                color: localColor
            }
        }
    );

    if (runtime.simulation.canPublish(now)) {
        const snapshot = toArenaSnapshot(runtime.arenaState, roomId, now);
        runtime.simulation.setPublishedSnapshot(snapshot);
        input.onArenaSnapshot(snapshot);
    }
}
function createLocalShot(input: ArenaLocalShotInput, now: number): ArenaLocalShot {
    const { runtime, localUsername, localColor, directionOverride } = input;
    const sessionId = input.localSessionId ?? 'local';
    const origin = runtime.localPlayer.position;
    const direction = directionOverride ?? forwardFromAngles(runtime.localPlayer.yaw, runtime.localPlayer.pitch);
    const weapon = getWeaponStats(runtime.localPlayer.loadout.weaponKind);
    runtime.shotSeqRef.current += 1;
    const shot: ArenaLocalShot = {
        sessionId,
        username: localUsername,
        color: localColor,
        origin,
        direction,
        weaponKind: weapon.kind,
        charged: runtime.input.altFire,
        overdrive: runtime.input.overdrive,
        seq: runtime.shotSeqRef.current,
        sentAtEpochMs: now
    };
    return shot;
}
function presentLocalShot(runtime: ArenaSceneRuntime, presentation: ArenaShotPresentation): void {
    const { shot, resolution, touchAssisted } = presentation;
    const now = shot.sentAtEpochMs;
    const weapon = getWeaponStats(shot.weaponKind);
    const origin = shot.origin;
    const direction = shot.direction;
    const localColor = shot.color;
    runtime.arenaState = resolution.state;
    runtime.localPlayer = {
        ...runtime.localPlayer,
        combat: resolution.combat
    };
    runtime.recoil = Math.min(1, runtime.recoil + (resolution.accepted.hit ? 0.38 : 0.22));
    runtime.hitStopUntilEpochMs = resolution.accepted.hit ? now + 38 : runtime.hitStopUntilEpochMs;
    triggerHaptic(runtime, resolution.accepted.hit ? 24 : 9);
    runtime.audio.play({ kind: 'shot', weaponKind: weapon.kind });
    if (resolution.accepted.hit) {
        runtime.audio.play({ kind: 'hit' });
    }

    createTracer({
        runtime: runtime,
        origin: vector3(origin),
        direction: vector3(direction),
        color: localColor,
        hit: resolution.accepted.hit
    });
    if (touchAssisted) {
        runtime.touchAimAssistUntilMs = runtime.clock.nowMonotonicMs() + 360;
    }
    if (resolution.accepted.hit) {
        createImpact({
            runtime: runtime,
            point: vector3(resolution.accepted.impact),
            color: ARENA_SCENE_THEME.amber,
            combo: resolution.accepted.combo
        });
    }
}
function sendPredictedPlayerHit(input: ArenaLocalShotInput, shot: ArenaLocalShot): void {
    const playerHit = findPredictedPlayerHit({
        remotePlayers: input.remotePlayers,
        localSessionId: shot.sessionId,
        origin: shot.origin,
        direction: shot.direction,
        range: getWeaponStats(shot.weaponKind).range,
        nowEpochMs: shot.sentAtEpochMs
    });
    if (!playerHit) {
        return;
    }
    if (input.networkEnabled) {
        input.onPlayerHitIntent({
            shot,
            targetSessionId: playerHit.targetSessionId,
            targetSeq: playerHit.targetSeq,
            predictedImpact: playerHit.impact,
            sentAtEpochMs: shot.sentAtEpochMs
        });
    }
    createImpact({ runtime: input.runtime, point: vector3(playerHit.impact), color: ARENA_SCENE_THEME.cyan, combo: 1 });
}

function publishLocalPose(input: ArenaSceneStepInput, nowEpochMs: number): void {
    const now = nowEpochMs;
    const player = input.runtime.localPlayer;
    const { poseSeqRef, localPoseRef } = input.runtime;
    const position = player.position;
    const rotation: Vec3Tuple = [
        round3(player.pitch),
        round3(player.yaw),
        0
    ];
    const current: LocalPoseHistory = {
        observedAtEpochMs: now,
        position,
        rotation
    };
    const previous = localPoseRef.current;
    const velocity = previous
        ? estimateRallarMotionVelocity(previous, current)
        : player.velocity;
    const angularVelocity = previous
        ? estimateRallarMotionVelocity(
            {
                observedAtEpochMs: previous.observedAtEpochMs,
                position: previous.rotation
            },
            {
                observedAtEpochMs: current.observedAtEpochMs,
                position: current.rotation
            }
        )
        : undefined;

    localPoseRef.current = current;
    poseSeqRef.current += 1;
    input.onLocalPose({
        position,
        rotation,
        velocity,
        angularVelocity,
        score: player.combat.score,
        combo: player.combat.combo,
        overdrive: player.combat.overdrive,
        vitals: player.vitals,
        loadout: player.loadout,
        seq: poseSeqRef.current,
        sentAtEpochMs: now
    });
}

function syncCamera(runtime: ArenaSceneRuntime, nowEpochMs: number): void {
    const player = runtime.localPlayer;
    const speed = Math.hypot(player.velocity[0], player.velocity[2]);
    const bob = player.grounded ? Math.sin(nowEpochMs / 82) * Math.min(0.045, speed * 0.004) : 0;
    const slideDrop = player.slideUntilEpochMs && player.slideUntilEpochMs > nowEpochMs ? -0.28 : 0;
    runtime.camera.position = vector3([
        player.position[0],
        player.position[1] + bob + slideDrop,
        player.position[2]
    ]);
    runtime.camera.rotation.x = player.pitch - runtime.recoil * 0.028;
    runtime.camera.rotation.y = player.yaw;
    runtime.camera.rotation.z = (player.dashUntilEpochMs && player.dashUntilEpochMs > nowEpochMs ? 0.04 : 0) +
        (player.slideUntilEpochMs && player.slideUntilEpochMs > nowEpochMs ? -0.055 : 0);
    runtime.camera.fov = BASE_FOV +
        Math.min(0.24, speed * 0.011) +
        runtime.recoil * 0.055;
    runtime.recoil *= 0.82;
}

export function applyLook(runtime: ArenaSceneRuntime, yawDelta: number, pitchDelta: number): void {
    runtime.localPlayer = {
        ...runtime.localPlayer,
        yaw: runtime.localPlayer.yaw + yawDelta,
        pitch: clamp(
            runtime.localPlayer.pitch + pitchDelta,
            -1.22,
            1.1
        )
    };
}

function detectLocalPickup(input: ArenaSceneStepInput): void {
    const { runtime } = input;
    const sessionId = input.localSessionId ?? 'local';
    const pickupSeqRef = runtime.pickupSeqRef;

    const now = runtime.clock.nowEpochMs();
    const pickup = findPickupNearPlayer(runtime.arenaState, sessionId, now);
    if (!pickup || runtime.sentPickupIds.has(pickup.id)) {
        return;
    }
    runtime.sentPickupIds.add(pickup.id);
    pickupSeqRef.current += 1;
    input.onPickupIntent({
        pickupId: pickup.id,
        sessionId,
        position: runtime.localPlayer.position,
        seq: pickupSeqRef.current,
        sentAtEpochMs: now
    });
    createImpact({ runtime: runtime, point: vector3(pickup.position), color: ARENA_SCENE_THEME.amber, combo: 3 });
    runtime.audio.play({ kind: 'pickup' });
    triggerHaptic(runtime, 28);
}

function syncRemotePlayerHits(
    runtime: ArenaSceneRuntime,
    remotePlayerHits: readonly PlayerHitAccepted[],
    localSessionId: string
): void {
    for (const accepted of remotePlayerHits) {
        const id =
            `${accepted.intent.shot.sessionId}:${accepted.target.sessionId}:${accepted.revision}:${accepted.intent.shot.seq}`;
        if (runtime.remoteHitIds.has(id)) {
            continue;
        }
        runtime.remoteHitIds.add(id);
        runtime.acceptedHitCount += 1;
        runtime.arenaState = applyPlayerHitAccepted(runtime.arenaState, accepted);
        if (accepted.target.sessionId === localSessionId) {
            runtime.localPlayer = {
                ...runtime.localPlayer,
                vitals: accepted.target.vitals,
                loadout: accepted.target.loadout,
                position: accepted.eliminated
                    ? runtime.localPlayer.position
                    : accepted.target.position
            };
            runtime.audio.play({ kind: 'damage' });
        }
        if (accepted.attacker.sessionId === localSessionId) {
            runtime.localPlayer = {
                ...runtime.localPlayer,
                vitals: accepted.attacker.vitals
            };
        }
        createImpact({
            runtime: runtime,
            point: vector3(accepted.impact),
            color: accepted.eliminated ? ARENA_SCENE_THEME.danger : ARENA_SCENE_THEME.cyan,
            combo: accepted.eliminated ? 8 : 2
        });
    }
}

export function syncLocalPlayerFromSnapshot(
    runtime: ArenaSceneRuntime,
    localSessionId: string | undefined,
    snapshot: ArenaSnapshot
): void {
    const player = localSessionId
        ? snapshot.players.find((candidate) => candidate.sessionId === localSessionId)
        : undefined;
    if (!player) {
        return;
    }
    if (
        player.vitals.respawnedAtEpochMs &&
        player.vitals.respawnedAtEpochMs !== runtime.localPlayer.vitals.respawnedAtEpochMs
    ) {
        runtime.respawnCount += 1;
        runtime.audio.play({ kind: 'respawn' });
        triggerHaptic(runtime, 30);
    }
    if (
        player.vitals.lastDamagedAtEpochMs &&
        player.vitals.lastDamagedAtEpochMs !== runtime.localPlayer.vitals.lastDamagedAtEpochMs
    ) {
        runtime.audio.play({ kind: 'damage' });
        triggerHaptic(runtime, 42);
    }
    const respawned = player.vitals.respawnedAtEpochMs !== runtime.localPlayer.vitals.respawnedAtEpochMs;
    runtime.localPlayer = {
        ...runtime.localPlayer,
        position: respawned ? player.position : runtime.localPlayer.position,
        vitals: player.vitals,
        loadout: player.loadout
    };
}

function syncLocalPlayerFromArenaState(runtime: ArenaSceneRuntime, localSessionId: string): void {
    const player = runtime.arenaState.players.find((candidate) => candidate.sessionId === localSessionId);
    if (!player) {
        return;
    }
    if (
        player.vitals.respawnedAtEpochMs &&
        player.vitals.respawnedAtEpochMs !== runtime.localPlayer.vitals.respawnedAtEpochMs
    ) {
        runtime.respawnCount += 1;
        runtime.audio.play({ kind: 'respawn' });
    }
    runtime.localPlayer = {
        ...runtime.localPlayer,
        position: player.vitals.deadUntilEpochMs && player.vitals.deadUntilEpochMs > runtime.clock.nowEpochMs()
            ? runtime.localPlayer.position
            : player.position,
        vitals: player.vitals,
        loadout: player.loadout
    };
}

function animateTargets(
    state: ArenaSimulationState,
    dtMs: number,
    nowEpochMs: number
): ArenaSimulationState {
    const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
    const bounds = Math.max(8, state.layout.halfSize - 2.5);
    const targets = state.targets.map((target): EyeTargetState => {
        const next = addTuple(target.position, scaleTuple(target.velocity, dt));
        const bounceX = Math.abs(next[0]) > bounds;
        const bounceY = next[1] < 1.3 || next[1] > 6.2;
        const bounceZ = Math.abs(next[2]) > bounds;
        return {
            ...target,
            position: [
                clamp(next[0], -bounds, bounds),
                clamp(next[1], 1.3, 6.2),
                clamp(next[2], -bounds, bounds)
            ],
            velocity: [
                bounceX ? -target.velocity[0] : target.velocity[0],
                bounceY ? -target.velocity[1] : target.velocity[1],
                bounceZ ? -target.velocity[2] : target.velocity[2]
            ],
            rarity: target.bountyUntilEpochMs && target.bountyUntilEpochMs < nowEpochMs
                ? 'volatile'
                : target.rarity
        };
    });
    return { ...state, targets };
}

function freezeInput(input: MutableInputState): PlayerInputState {
    return {
        moveX: input.moveX,
        moveZ: input.moveZ,
        sprint: input.sprint,
        dash: input.dash,
        slide: input.slide,
        jump: input.jump,
        fire: input.fire,
        altFire: input.altFire,
        overdrive: input.overdrive,
        pause: input.pause
    };
}
