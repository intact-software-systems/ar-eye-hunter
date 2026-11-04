import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import { type RelicAnimationCue, type RelicEvent, type RelicPublicSnapshot } from '@relic-hunters/mod.ts';

import { facilityRoomPosition } from '../relic-scene-model.ts';
import { type FacilityMaterials } from './relic-materials.ts';
import { computeRelicCuePosition } from './relic-relics.ts';
import { spawnBeamEffect, spawnBurstEffect, spawnPulseEffect } from './relic-review-effects.ts';
import { type RelicSceneRuntime } from './relic-scene-runtime.ts';
import { AVATAR_Y, clamp, smoothstep } from './relic-scene-space.ts';

interface ReviewPlaybackCue {
    readonly eventId: string;
    readonly cue: RelicAnimationCue;
    readonly durationMs: number;
}

export interface ReviewAvatarMotion {
    readonly playerId: string;
    readonly from: Vector3;
    readonly to: Vector3;
    readonly startedAtMs: number;
    readonly durationMs: number;
}

export interface ReviewPlaybackState {
    key?: string;
    queue: ReviewPlaybackCue[];
    index: number;
    cueStartedAtMs?: number;
    completed: boolean;
    notifiedKey?: string;
}

export function syncReviewPlayback(runtime: RelicSceneRuntime, snapshot: RelicPublicSnapshot): void {
    if (runtime.terminal || snapshot.phase !== 'review') {
        resetReviewPlayback(runtime);
        return;
    }
    const key = computeReviewPlaybackKey(snapshot);
    if (runtime.review.key === key) {
        return;
    }
    runtime.review = {
        key,
        queue: computeReviewQueue(snapshot),
        index: 0,
        cueStartedAtMs: undefined,
        completed: false,
        notifiedKey: runtime.review.notifiedKey
    };
    runtime.reviewAvatarMotions.clear();
}

export function resetReviewPlayback(runtime: RelicSceneRuntime): void {
    runtime.review = {
        key: undefined,
        queue: [],
        index: 0,
        cueStartedAtMs: undefined,
        completed: false,
        notifiedKey: runtime.review.notifiedKey
    };
    runtime.reviewAvatarMotions.clear();
}

function computeReviewQueue(snapshot: RelicPublicSnapshot): ReviewPlaybackCue[] {
    const seen = new Set<string>();
    return snapshot.events
        .filter((event) => event.round === snapshot.round && !!event.animationCue)
        .sort((left, right) =>
            left.createdAtEpochMs === right.createdAtEpochMs
                ? left.id.localeCompare(right.id)
                : left.createdAtEpochMs - right.createdAtEpochMs
        )
        .flatMap((event) => {
            if (!event.animationCue || seen.has(event.id)) {
                return [];
            }
            seen.add(event.id);
            return [{
                eventId: event.id,
                cue: event.animationCue,
                durationMs: event.animationCue.durationMs ?? resolveReviewCueDuration(event.animationCue.type)
            }];
        });
}

export function updateReviewPlayback(runtime: RelicSceneRuntime): void {
    const review = runtime.review;
    if (!review.key || review.completed) {
        return;
    }

    const now = performance.now();
    applyReviewAvatarMotions(runtime, now);
    const item = review.queue[review.index];
    if (!item) {
        completeReviewPlayback(runtime);
        return;
    }

    if (review.cueStartedAtMs === undefined) {
        review.cueStartedAtMs = now;
        startReviewCue(runtime, item, now);
    }

    if (now - review.cueStartedAtMs >= item.durationMs + REVIEW_CUE_GAP_MS) {
        review.index += 1;
        review.cueStartedAtMs = undefined;
        if (review.index >= review.queue.length) {
            completeReviewPlayback(runtime);
        }
    }
}

function completeReviewPlayback(runtime: RelicSceneRuntime): void {
    const key = runtime.review.key;
    runtime.review.completed = true;
    runtime.review.cueStartedAtMs = undefined;
    runtime.reviewAvatarMotions.clear();
    if (key && runtime.reviewDirector.value && runtime.review.notifiedKey !== key) {
        runtime.review.notifiedKey = key;
        runtime.onReviewPlaybackComplete.value();
    }
}

interface ReviewCueAppearance {
    readonly material: keyof FacilityMaterials;
    readonly radius: number;
    readonly burst: { readonly material: keyof FacilityMaterials; readonly height: number; } | undefined;
}

const REVIEW_CUE_APPEARANCES: Record<Exclude<RelicAnimationCue['type'], 'noise_pulse'>, ReviewCueAppearance> = {
    camera_move: { material: 'cyan', radius: 2.3, burst: undefined },
    search_altar: { material: 'amber', radius: 2.8, burst: { material: 'white', height: 0.8 } },
    relic_reveal: { material: 'green', radius: 3.2, burst: { material: 'amber', height: 0.9 } },
    relic_pickup: { material: 'magenta', radius: 3.0, burst: { material: 'white', height: 0.72 } },
    steal_attempt: { material: 'magenta', radius: 2.9, burst: { material: 'danger', height: 1 } },
    escape_run: { material: 'green', radius: 3.4, burst: undefined },
    damage_shake: { material: 'danger', radius: 3.5, burst: { material: 'danger', height: 1.1 } },
    room_collapse: { material: 'danger', radius: 5, burst: { material: 'amber', height: 1.2 } },
    heart_relic_victory: { material: 'white', radius: 6, burst: { material: 'green', height: 1.4 } }
};

function startReviewCue(runtime: RelicSceneRuntime, item: ReviewPlaybackCue, startedAtMs: number): void {
    const cue = item.cue;
    runtime.focusRoomId.value = cue.roomId ?? roomIdForCuePlayer(runtime.snapshot.value, cue.playerId);
    const position = cuePosition(runtime, cue);
    const appearance = computeReviewCueAppearance(cue);
    if (cue.type === 'camera_move') {
        startReviewAvatarMotion(runtime, item, startedAtMs);
    }
    spawnPulseEffect({
        runtime,
        id: `review-${cue.type}-${item.eventId}`,
        position,
        material: runtime.materials[appearance.material],
        durationMs: item.durationMs,
        maxScale: appearance.radius
    });
    if (appearance.burst) {
        spawnBurstEffect({
            runtime,
            id: `review-${cue.type}-burst-${item.eventId}`,
            position: position.add(new Vector3(0, appearance.burst.height, 0)),
            material: runtime.materials[appearance.burst.material],
            durationMs: item.durationMs
        });
    }
    if (cue.type === 'escape_run') {
        spawnBeamEffect({
            runtime,
            from: position,
            to: position.add(new Vector3(0, 0, 3.8)),
            material: runtime.materials.green,
            durationMs: item.durationMs
        });
    }
}

function startReviewAvatarMotion(runtime: RelicSceneRuntime, item: ReviewPlaybackCue, startedAtMs: number): void {
    const cue = item.cue;
    if (!cue.playerId || !cue.fromRoomId || !cue.roomId) {
        return;
    }
    const fromRoom = runtime.snapshot.value?.map.find((room) => room.id === cue.fromRoomId);
    const toRoom = runtime.snapshot.value?.map.find((room) => room.id === cue.roomId);
    if (!fromRoom || !toRoom) {
        return;
    }
    const from = facilityRoomPosition(fromRoom).add(new Vector3(0, AVATAR_Y, 0));
    const to = facilityRoomPosition(toRoom).add(new Vector3(0, AVATAR_Y, 0));
    runtime.reviewAvatarMotions.set(cue.playerId, {
        playerId: cue.playerId,
        from,
        to,
        startedAtMs,
        durationMs: item.durationMs
    });
    spawnBeamEffect({ runtime, from, to, material: runtime.materials.cyan, durationMs: item.durationMs });
}

function computeReviewCueAppearance(cue: RelicAnimationCue): ReviewCueAppearance {
    return cue.type === 'noise_pulse'
        ? { material: 'violet', radius: cue.intensity === 'high' ? 5.6 : 4.2, burst: undefined }
        : REVIEW_CUE_APPEARANCES[cue.type];
}

function applyReviewAvatarMotions(runtime: RelicSceneRuntime, now: number): void {
    for (const [playerId, motion] of runtime.reviewAvatarMotions.entries()) {
        const avatar = runtime.avatars.get(playerId);
        if (!avatar) {
            runtime.reviewAvatarMotions.delete(playerId);
            continue;
        }
        const progress = clamp((now - motion.startedAtMs) / Math.max(1, motion.durationMs), 0, 1);
        const eased = smoothstep(progress);
        const position = Vector3.Lerp(motion.from, motion.to, eased);
        position.y += Math.sin(eased * Math.PI) * 0.28;
        avatar.root.setEnabled(true);
        avatar.root.position.copyFrom(position);
        const direction = motion.to.subtract(motion.from);
        if (direction.lengthSquared() > 0.001) {
            avatar.root.rotation.y = Math.atan2(direction.x, direction.z);
        }
        avatar.trail.setEnabled(progress < 0.92);
        if (progress >= 1) {
            runtime.reviewAvatarMotions.delete(playerId);
        }
    }
}

function computeReviewPlaybackKey(snapshot: RelicPublicSnapshot): string {
    const cueEventIds = snapshot.events
        .filter((event) => event.round === snapshot.round && !!event.animationCue)
        .map((event) => event.id)
        .join(',');
    return `${snapshot.gameId}:${snapshot.round}:${snapshot.updatedAtEpochMs}:${cueEventIds}`;
}

function resolveReviewCueDuration(type: RelicAnimationCue['type']): number {
    switch (type) {
        case 'camera_move':
            return 760;
        case 'search_altar':
            return 760;
        case 'relic_reveal':
        case 'relic_pickup':
            return 980;
        case 'steal_attempt':
            return 860;
        case 'escape_run':
            return 1_250;
        case 'noise_pulse':
            return 820;
        case 'damage_shake':
            return 760;
        case 'room_collapse':
            return 1_200;
        case 'heart_relic_victory':
            return 2_200;
    }
}

export function roomIdForCuePlayer(
    snapshot: RelicPublicSnapshot | undefined,
    playerId: string | undefined
): string | undefined {
    if (!snapshot || !playerId) {
        return undefined;
    }
    return snapshot.players.find((player) => player.playerId === playerId)?.roomId;
}

function cuePosition(runtime: RelicSceneRuntime, cue: RelicAnimationCue): Vector3 {
    const snapshot = runtime.snapshot.value;
    const relicPosition = cue.relicId ? computeRelicCuePosition(snapshot, cue.relicId) : undefined;
    if (relicPosition) {
        return relicPosition;
    }
    if (cue.playerId) {
        const avatar = runtime.avatars.get(cue.playerId);
        if (avatar) {
            return avatar.root.position.clone();
        }
    }
    const roomId = cue.roomId ?? roomIdForCuePlayer(snapshot, cue.playerId);
    const room = roomId ? snapshot.map.find((candidate) => candidate.id === roomId) : undefined;
    if (room) {
        const base = facilityRoomPosition(room);
        return new Vector3(base.x, 0.48, base.z);
    }
    return Vector3.Zero();
}

const REVIEW_CUE_GAP_MS = 160;
