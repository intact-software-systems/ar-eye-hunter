import {
    WormIdNA,
    WriteDecision,
    WhackOutcome,
    type ColorId,
    type EngineParams,
    type EngineState,
    type PlayerId,
    type UpsertResult,
    type Worm,
    type WormId,
    type WhackResult,
} from './types.ts';

import {Rng} from './rng.ts';

function clamp01(v: number): number {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

function randomBetween(rng: Rng, min: number, max: number): number {
    return min + (max - min) * rng.next();
}

function makeLocalWormId(owner: PlayerId, seq: number): WormId {
    // Unique enough for single-player and also safe to mix with multiplayer later:
    // "<playerId>:<seq>"
    return `${owner}:${seq}`;
}

function compareLww(a: Worm, b: Worm): number {
    // Returns:
    //  > 0 if a wins
    //  < 0 if b wins
    //  = 0 if equal
    if (a.updatedAtMs !== b.updatedAtMs) return a.updatedAtMs - b.updatedAtMs;
    // Tie-breaker: updatedBy lexicographical compare
    if (a.updatedBy === b.updatedBy) return 0;
    return a.updatedBy < b.updatedBy ? -1 : 1;
}

export function createInitialState(nowMs: number): EngineState {
    return {
        nowMs,
        wormsById: new Map(),
        nextLocalSeq: 1,
    };
}

export function readWorm(state: EngineState, id: WormId): Worm | undefined {
    return state.wormsById.get(id);
}

export function readAllWorms(state: EngineState): readonly Worm[] {
    return [...state.wormsById.values()];
}

export function createWorm(args: {
    readonly id: WormId;
    readonly owner: PlayerId;
    readonly color: ColorId;
    readonly x: number;
    readonly y: number;
    readonly radius01: number;
    readonly expiresAtMs: number;
    readonly updatedAtMs: number;
    readonly updatedBy: PlayerId;
}): Worm {
    // Inline clamps to ensure the engine never produces invalid coordinates.
    return {
        id: args.id,
        owner: args.owner,
        color: args.color,
        x: clamp01(args.x), // ensure [0..1]
        y: clamp01(args.y), // ensure [0..1]
        radius01: clamp01(args.radius01), // radius01 expected small but still clamp
        expiresAtMs: args.expiresAtMs,
        updatedAtMs: args.updatedAtMs,
        updatedBy: args.updatedBy,
    };
}

export function putIfAbsentWorm(state: EngineState, worm: Worm): UpsertResult {
    const existing = state.wormsById.get(worm.id);
    if (existing) {
        return { decision: WriteDecision.Rejected, output: state };
    }
    const next = new Map(state.wormsById);
    next.set(worm.id, worm);
    return { decision: WriteDecision.Accepted, output: { ...state, wormsById: next } };
}

export function upsertWormLww(state: EngineState, worm: Worm): UpsertResult {
    const existing = state.wormsById.get(worm.id);
    if (!existing) {
        const next = new Map(state.wormsById);
        next.set(worm.id, worm);
        return { decision: WriteDecision.Accepted, output: { ...state, wormsById: next } };
    }

    // LWW winner: keep the worm with the highest (updatedAtMs, updatedBy).
    const cmp = compareLww(existing, worm);
    if (cmp >= 0) {
        return { decision: WriteDecision.Rejected, output: state };
    }

    const next = new Map(state.wormsById);
    next.set(worm.id, worm);
    return { decision: WriteDecision.Accepted, output: { ...state, wormsById: next } };
}

export function deleteWorm(state: EngineState, wormId: WormId): EngineState {
    if (!state.wormsById.has(wormId)) return state;
    const next = new Map(state.wormsById);
    next.delete(wormId);
    return { ...state, wormsById: next };
}

export function deleteExpiredWorms(state: EngineState, nowMs: number): EngineState {
    if (state.wormsById.size === 0) return { ...state, nowMs };

    // Inline expiration check; keep survivors only.
    let changed = false;
    const next = new Map<WormId, Worm>();

    for (const [id, w] of state.wormsById.entries()) {
        if (w.expiresAtMs > nowMs) next.set(id, w);
        else changed = true;
    }

    if (!changed) return { ...state, nowMs };
    return { ...state, nowMs, wormsById: next };
}

export function computeNextState(args: {
    readonly state: EngineState;
    readonly nowMs: number;
    readonly rng: Rng;
    readonly params: EngineParams;

    // Local identity used for worm id & LWW stamps
    readonly localPlayerId: PlayerId;
    readonly localColor: ColorId;
}): EngineState {
    const advanced: EngineState = { ...args.state, nowMs: args.nowMs };

    // Spawn decision: keep it simple; one possible spawn per tick.
    // (If you later need more density, you can loop with a capped max.)
    const roll = args.rng.next();
    if (roll <= args.params.spawnChancePerTick) {
        // Inline calculations with comments:
        // - x,y are normalized screen positions
        // - radius is normalized relative to min(canvasW, canvasH)
        const x = args.rng.next(); // [0..1)
        const y = args.rng.next(); // [0..1)
        const radius01 = randomBetween(args.rng, args.params.minRadius01, args.params.maxRadius01);

        const id = makeLocalWormId(args.localPlayerId, advanced.nextLocalSeq);

        const worm = createWorm({
            id,
            owner: args.localPlayerId,
            color: args.localColor,
            x,
            y,
            radius01,
            expiresAtMs: args.nowMs + args.params.wormTtlMs,
            updatedAtMs: args.nowMs,
            updatedBy: args.localPlayerId,
        });

        const up = upsertWormLww({ ...advanced, nextLocalSeq: advanced.nextLocalSeq + 1 }, worm);
        const withSpawn = up.output;
        return deleteExpiredWorms(withSpawn, args.nowMs);
    }

    return deleteExpiredWorms(advanced, args.nowMs);
}

// Remote/state merge API (used later for P2P/CRDT).
export function applyRemoteWorm(state: EngineState, worm: Worm): EngineState {
    return upsertWormLww(state, worm).output;
}

export function mergeStateLww(local: EngineState, incoming: EngineState): EngineState {
    // Merge wormsById using LWW.
    // Keep local nextLocalSeq and update nowMs to the max observed.
    const nowMs = Math.max(local.nowMs, incoming.nowMs);

    let out = new Map(local.wormsById);

    for (const w of incoming.wormsById.values()) {
        const existing = out.get(w.id);
        if (!existing) {
            out.set(w.id, w);
            continue;
        }

        // Choose winner by (updatedAtMs, updatedBy)
        const cmp = compareLww(existing, w);
        if (cmp < 0) out.set(w.id, w);
    }

    return {
        nowMs,
        wormsById: out,
        nextLocalSeq: local.nextLocalSeq,
    };
}

export function whackAtNormalizedPoint(args: {
    readonly state: EngineState;
    readonly x01: number;
    readonly y01: number;

    // This is single-player scoring for Phase 3.
    // In multiplayer you’ll record whack events and derive score elsewhere.
}): WhackResult {
    if (args.state.wormsById.size === 0) {
        return { outcome: WhackOutcome.Miss, hitWormId: WormIdNA, next: args.state };
    }

    // Hit test: pick the closest worm within its radius.
    let bestId: WormId = WormIdNA;
    let bestDist2 = Number.POSITIVE_INFINITY;

    for (const [id, w] of args.state.wormsById.entries()) {
        const dx = args.x01 - w.x;
        const dy = args.y01 - w.y;
        const dist2 = dx * dx + dy * dy;
        const r2 = w.radius01 * w.radius01;

        if (dist2 <= r2 && dist2 < bestDist2) {
            bestDist2 = dist2;
            bestId = id;
        }
    }

    if (bestId === WormIdNA) {
        return { outcome: WhackOutcome.Miss, hitWormId: WormIdNA, next: args.state };
    }

    const next = deleteWorm(args.state, bestId);
    return { outcome: WhackOutcome.Hit, hitWormId: bestId, next };
}