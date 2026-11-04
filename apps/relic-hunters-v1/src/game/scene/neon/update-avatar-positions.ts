import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import { type RelicPlayer, type RelicPublicSnapshot } from '@relic-hunters/mod.ts';

import { isRelicMotionEstimateFreshForPlayer } from '../networking.ts';
import { facilityRoomPosition } from '../relic-scene-model.ts';
import { type AvatarBundle } from './relic-avatars.ts';
import { type RelicSceneRuntime } from './relic-scene-runtime.ts';
import { AVATAR_Y } from './relic-scene-space.ts';

export function updateAvatarPositions(runtime: RelicSceneRuntime): void {
    const snapshot = runtime.snapshot.value;
    if (!snapshot) {
        return;
    }
    const nowEpochMs = Date.now();
    const nowMs = performance.now();
    for (const player of snapshot.players) {
        const avatar = runtime.avatars.get(player.playerId);
        if (!avatar || player.escaped || player.defeated) {
            continue;
        }
        const target = updateAvatarTarget({ runtime, player, avatar, nowEpochMs, snapshot });

        const delta = target.subtract(avatar.root.position);
        const smoothing = player.playerId === runtime.localPlayerId.value ? 0.72 : 0.42;
        avatar.root.position.addInPlace(delta.scale(smoothing));
        const moved = avatar.root.position.subtract(avatar.lastPosition).lengthSquared() > 0.0005;
        if (moved) {
            avatar.lastMovedAtMs = nowMs;
            if (player.playerId === runtime.localPlayerId.value) {
                avatar.root.rotation.y = runtime.cameraYaw.value;
            }
        }
        const recentMove = nowMs - avatar.lastMovedAtMs < 180;
        avatar.trail.setEnabled(recentMove);
        avatar.ring.scaling.setAll(1 + Math.sin(runtime.pulsePhase.value * 4.6) * 0.035);
        avatar.root.position.y = target.y + (recentMove ? Math.sin(nowMs / 82) * 0.045 : 0);
        avatar.lastPosition.copyFrom(avatar.root.position);
    }
}

interface AvatarTargetInput {
    readonly runtime: RelicSceneRuntime;
    readonly player: RelicPlayer;
    readonly avatar: AvatarBundle;
    readonly nowEpochMs: number;
    readonly snapshot: RelicPublicSnapshot;
}

function updateAvatarTarget({ runtime, player, avatar, nowEpochMs, snapshot }: AvatarTargetInput): Vector3 {
    let target = avatar.target;
    if (player.playerId === runtime.localPlayerId.value && snapshot.phase !== 'lobby') {
        const room = snapshot.map.find((candidate) => candidate.id === player.roomId);
        if (room) {
            const world = facilityRoomPosition(room);
            target = new Vector3(world.x + runtime.roamOffset.x, AVATAR_Y, world.z + runtime.roamOffset.z);
        }
    }
    else {
        let estimate = runtime.motion.buffer.sample(player.playerId, nowEpochMs);
        const estimateRoomId = estimate?.metadata?.roomId;
        if (!isRelicMotionEstimateFreshForPlayer(estimate, player.roomId, nowEpochMs)) {
            if (estimateRoomId && estimateRoomId !== player.roomId) {
                runtime.motion.buffer.remove(player.playerId);
                runtime.motion.kinematics.remove(player.playerId);
            }
            estimate = undefined;
        }
        if (estimate) {
            target = new Vector3(estimate.position[0], estimate.position[1], estimate.position[2]);
            if (estimate.rotation) {
                avatar.root.rotation.y = estimate.rotation[1];
            }
            runtime.motion.diagnostics.lastEstimateMode = estimate.mode;
            runtime.motion.diagnostics.lastConfidence = estimate.confidence;
            runtime.motion.diagnostics.lastSampleAgeMs = Math.max(0, nowEpochMs - estimate.observedAtEpochMs);
        }
    }

    return target;
}
