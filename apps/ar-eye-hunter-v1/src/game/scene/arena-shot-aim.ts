import { add3, distance3, dot3, scale3, sub3 } from '@ar-eye-hunter/arena-math.ts';
import { CreatePickingRay } from '@babylonjs/core/Culling/ray.core.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import type { ArenaSimulationState, Vec3Tuple } from '@ar-eye-hunter/arena-contracts.ts';
import type { TournamentArena } from '@ar-eye-hunter/tournament-arena.ts';
import { blocksShot } from '@ar-eye-hunter/arena-layout.ts';
import type { RemotePlayer } from '../arena-contracts.ts';
import {
    chooseTouchAimCandidate,
    type Point2,
    type TouchAimCandidate
} from '../mobile-input.ts';
import { createTouchAimPulse } from './arena-scene-effects.ts';
import { normalizeTuple, vector3 } from './arena-scene-geometry.ts';
import type { ArenaSceneRuntime } from './arena-scene-runtime.ts';

interface FindPredictedPlayerHitInput {
    readonly nowEpochMs: number;
    readonly remotePlayers: ReadonlyMap<string, RemotePlayer>;
    readonly localSessionId: string;
    readonly origin: Vec3Tuple;
    readonly direction: Vec3Tuple;
    readonly range: number;
}

interface PredictedPlayerHit {
    readonly targetSessionId: string;
    readonly targetSeq: number;
    readonly impact: Vec3Tuple;
}

interface PredictedPlayerHitCandidate extends PredictedPlayerHit {
    readonly distance: number;
}

export function findPredictedPlayerHit(
    { remotePlayers, localSessionId, origin, direction, range, nowEpochMs }: FindPredictedPlayerHitInput
): PredictedPlayerHit | undefined {
    const ray = normalizeTuple(direction);
    let best: PredictedPlayerHitCandidate | undefined;
    for (const [sessionId, remote] of remotePlayers) {
        if (sessionId === localSessionId) {
            continue;
        }
        if (
            remote.pose.vitals?.deadUntilEpochMs &&
            remote.pose.vitals.deadUntilEpochMs > nowEpochMs
        ) {
            continue;
        }
        const toTarget = sub3(remote.pose.position, origin);
        const along = dot3(toTarget, ray);
        if (along < 0 || along > range) {
            continue;
        }
        const impact = add3(origin, scale3(ray, along));
        const miss = distance3(impact, remote.pose.position);
        if (miss > 0.95) {
            continue;
        }
        if (!best || along < best.distance) {
            best = {
                targetSessionId: sessionId,
                targetSeq: remote.pose.seq,
                impact,
                distance: along
            };
        }
    }
    return best;
}

interface ResolveTouchShotDirectionInput {
    readonly runtime: ArenaSceneRuntime;
    readonly tournamentState: TournamentArena | null | undefined;
    readonly event: PointerEvent;
    readonly remotePlayers: ReadonlyMap<string, RemotePlayer>;
    readonly localSessionId: string;
}

interface TouchShotDirection {
    readonly direction: Vec3Tuple;
    readonly assisted: boolean;
}

export function resolveTouchShotDirection(
    { runtime, tournamentState, event, remotePlayers, localSessionId }: ResolveTouchShotDirectionInput
): TouchShotDirection {
    const canvas = runtime.engine.getRenderingCanvas();
    if (!canvas) {
        throw new Error('Touch aiming requires the arena canvas.');
    }
    const rect = canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    // Native snapshots may advance while graphics are delayed. Input uses accepted state immediately.
    const arenaState = tournamentState?.arena ?? runtime.arenaState;
    const origin = tournamentState?.players.find((player) => player.principalId === localSessionId)?.simulation.position
        ?? runtime.localPlayer.position;
    const candidate = chooseTouchAimCandidate({
        point,
        candidates: computeTouchAimCandidates({
            runtime,
            arenaState,
            remotePlayers: remotePlayers,
            localSessionId: localSessionId,
            origin: origin,
            viewport: rect
        })
    });
    if (candidate) {
        createTouchAimPulse(runtime, candidate.world);
        return {
            direction: normalizeTuple(sub3(candidate.world, origin)),
            assisted: true
        };
    }

    // Babylon applies hardware scaling to picking coordinates. Keep assistance in CSS pixels.
    const scaling = runtime.engine.getHardwareScalingLevel();
    const x = point.x * runtime.engine.getRenderWidth() * scaling / Math.max(1, rect.width);
    const y = point.y * runtime.engine.getRenderHeight() * scaling / Math.max(1, rect.height);
    const ray = CreatePickingRay(runtime.scene, x, y, Matrix.Identity(), runtime.camera);
    return {
        direction: normalizeTuple([ray.direction.x, ray.direction.y, ray.direction.z]),
        assisted: false
    };
}

interface ComputeTouchAimCandidatesInput {
    readonly arenaState: ArenaSimulationState;
    readonly viewport: Pick<DOMRect, 'width' | 'height'>;
    readonly runtime: ArenaSceneRuntime;
    readonly remotePlayers: ReadonlyMap<string, RemotePlayer>;
    readonly localSessionId: string;
    readonly origin: Vec3Tuple;
}

function computeTouchAimCandidates(
    { runtime, arenaState, remotePlayers, localSessionId, origin, viewport }: ComputeTouchAimCandidatesInput
): readonly TouchAimCandidate[] {
    const candidates: TouchAimCandidate[] = [];
    for (const target of arenaState.targets) {
        const world = target.position;
        const screen = projectWorldToScreen(runtime, world, viewport);
        if (!screen) {
            continue;
        }
        candidates.push({
            id: target.id,
            kind: 'eye',
            screen,
            world,
            distance: distance3(origin, world),
            blocked: blocksShot(arenaState.layout, origin, world)
        });
    }

    for (const [sessionId, remote] of remotePlayers) {
        if (sessionId === localSessionId) {
            continue;
        }
        const world = remote.pose.position;
        const screen = projectWorldToScreen(runtime, world, viewport);
        if (!screen) {
            continue;
        }
        candidates.push({
            id: sessionId,
            kind: 'player',
            screen,
            world,
            distance: distance3(origin, world),
            blocked: blocksShot(arenaState.layout, origin, world)
        });
    }
    return candidates;
}

function projectWorldToScreen(
    runtime: ArenaSceneRuntime,
    world: Vec3Tuple,
    viewport: Pick<DOMRect, 'width' | 'height'>
): Point2 | undefined {
    const projected = Vector3.Project(
        vector3(world),
        Matrix.Identity(),
        runtime.scene.getTransformMatrix(),
        runtime.camera.viewport.toGlobal(viewport.width, viewport.height)
    );
    if (projected.z < 0 || projected.z > 1) {
        return undefined;
    }
    return { x: projected.x, y: projected.y };
}
