import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';

import type { RemotePlayer, Vec3Tuple } from '../arena-contracts.ts';
import { blocksShot } from '../arena-layout.ts';
import {
    chooseTouchAimCandidate,
    type Point2,
    type TouchAimCandidate
} from '../mobile-input.ts';
import { createTouchAimPulse } from './arena-scene-effects.ts';
import {
    addTuple,
    distanceTuple,
    dotTuple,
    normalizeTuple,
    scaleTuple,
    subTuple,
    vector3
} from './arena-scene-geometry.ts';
import type { ArenaSceneRuntime } from './arena-scene-runtime.ts';

interface FindPredictedPlayerHitInput {
    readonly nowEpochMs: number;
    readonly remotePlayers: ReadonlyMap<string, RemotePlayer>;
    readonly localSessionId: string;
    readonly origin: Vec3Tuple;
    readonly direction: Vec3Tuple;
    readonly range: number;
}

export function findPredictedPlayerHit(
    { remotePlayers, localSessionId, origin, direction, range, nowEpochMs }: FindPredictedPlayerHitInput
): Readonly<{ targetSessionId: string; targetSeq: number; impact: Vec3Tuple; }> | undefined {
    const ray = normalizeTuple(direction);
    let best:
        | Readonly<{ targetSessionId: string; targetSeq: number; impact: Vec3Tuple; distance: number; }>
        | undefined;
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
        const toTarget = subTuple(remote.pose.position, origin);
        const along = dotTuple(toTarget, ray);
        if (along < 0 || along > range) {
            continue;
        }
        const impact = addTuple(origin, scaleTuple(ray, along));
        const miss = distanceTuple(impact, remote.pose.position);
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
    readonly event: PointerEvent;
    readonly remotePlayers: ReadonlyMap<string, RemotePlayer>;
    readonly localSessionId: string;
}

interface TouchShotDirection {
    readonly direction: Vec3Tuple;
    readonly assisted: boolean;
}

export function resolveTouchShotDirection(
    { runtime, event, remotePlayers, localSessionId }: ResolveTouchShotDirectionInput
): TouchShotDirection {
    const rect = runtime.engine.getRenderingCanvas()?.getBoundingClientRect();
    const renderWidth = runtime.engine.getRenderWidth();
    const renderHeight = runtime.engine.getRenderHeight();
    const x = rect
        ? (event.clientX - rect.left) * (renderWidth / Math.max(1, rect.width))
        : event.offsetX;
    const y = rect
        ? (event.clientY - rect.top) * (renderHeight / Math.max(1, rect.height))
        : event.offsetY;
    const point = { x, y };
    const origin = runtime.localPlayer.position;
    const candidate = chooseTouchAimCandidate({
        point,
        candidates: buildTouchAimCandidates({
            runtime: runtime,
            remotePlayers: remotePlayers,
            localSessionId: localSessionId,
            origin: origin
        })
    });
    if (candidate) {
        createTouchAimPulse(runtime, candidate.world);
        return {
            direction: normalizeTuple(subTuple(candidate.world, origin)),
            assisted: true
        };
    }

    const ray = runtime.scene.createPickingRay(x, y, Matrix.Identity(), runtime.camera);
    return {
        direction: normalizeTuple([ray.direction.x, ray.direction.y, ray.direction.z]),
        assisted: false
    };
}

interface BuildTouchAimCandidatesInput {
    readonly runtime: ArenaSceneRuntime;
    readonly remotePlayers: ReadonlyMap<string, RemotePlayer>;
    readonly localSessionId: string;
    readonly origin: Vec3Tuple;
}

function buildTouchAimCandidates(
    { runtime, remotePlayers, localSessionId, origin }: BuildTouchAimCandidatesInput
): readonly TouchAimCandidate[] {
    const candidates: TouchAimCandidate[] = [];
    for (const target of runtime.arenaState.targets) {
        const world = target.position;
        const screen = projectWorldToScreen(runtime, world);
        if (!screen) {
            continue;
        }
        candidates.push({
            id: target.id,
            kind: 'eye',
            screen,
            world,
            distance: distanceTuple(origin, world),
            blocked: blocksShot(runtime.arenaState.layout, origin, world)
        });
    }

    for (const [sessionId, remote] of remotePlayers) {
        if (sessionId === localSessionId) {
            continue;
        }
        const world = remote.pose.position;
        const screen = projectWorldToScreen(runtime, world);
        if (!screen) {
            continue;
        }
        candidates.push({
            id: sessionId,
            kind: 'player',
            screen,
            world,
            distance: distanceTuple(origin, world),
            blocked: blocksShot(runtime.arenaState.layout, origin, world)
        });
    }
    return candidates;
}

function projectWorldToScreen(runtime: ArenaSceneRuntime, world: Vec3Tuple): Point2 | undefined {
    const projected = Vector3.Project(
        vector3(world),
        Matrix.Identity(),
        runtime.scene.getTransformMatrix(),
        runtime.camera.viewport.toGlobal(
            runtime.engine.getRenderWidth(),
            runtime.engine.getRenderHeight()
        )
    );
    if (projected.z < 0 || projected.z > 1) {
        return undefined;
    }
    return { x: projected.x, y: projected.y };
}
