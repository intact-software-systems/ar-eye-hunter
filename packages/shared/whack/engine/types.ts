export type PlayerId = string;

export enum ColorId {
    Green = 'Green',
    Blue = 'Blue',
    Red = 'Red',
    Yellow = 'Yellow',
}

export type WormId = string;
export const WormIdNA: WormId = 'NA';

export type Worm = {
    readonly id: WormId;
    readonly owner: PlayerId;
    readonly color: ColorId;

    // Normalized coordinates in [0..1]
    readonly x: number;
    readonly y: number;

    // Relative radius (0..1) scaled by min(canvasW, canvasH) on render
    readonly radius01: number;

    // Worm exists while nowMs < expiresAtMs
    readonly expiresAtMs: number;

    // Last-write-wins metadata:
    // If the same wormId exists, the record with the highest (updatedAtMs, updatedBy) wins.
    readonly updatedAtMs: number;
    readonly updatedBy: PlayerId;
};

export type EngineParams = {
    readonly tickMs: number;
    readonly wormTtlMs: number;

    // Chance of spawning a worm each tick (0..1)
    readonly spawnChancePerTick: number;

    readonly minRadius01: number;
    readonly maxRadius01: number;
};

export type EngineState = {
    readonly nowMs: number;

    // "Database" of worms
    readonly wormsById: ReadonlyMap<WormId, Worm>;

    // Local engine bookkeeping (for local worm IDs)
    readonly nextLocalSeq: number;
};

export enum WriteDecision {
    Accepted = 'Accepted',
    Rejected = 'Rejected',
}

export type UpsertResult = {
    readonly decision: WriteDecision;
    readonly output: EngineState;
};

export enum WhackOutcome {
    Hit = 'Hit',
    Miss = 'Miss',
}

export type WhackResult = {
    readonly outcome: WhackOutcome;
    readonly hitWormId: WormId;
    readonly next: EngineState;
};
