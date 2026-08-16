export type VivaldiNodeData = {
    readonly id: string;
    readonly coords: readonly number[];
    readonly err: number;
    readonly rttMs: number;
};

export type VivaldiRandom = () => number;

export type VivaldiConfig = {
    readonly cc: number;
    readonly ce: number;
    readonly maxNodeErr: number;
    readonly minNodeErr: number;
    readonly useL1: boolean;
    readonly useLInf: boolean;
};

export const DEFAULT_VIVALDI_CONFIG: VivaldiConfig = {
    cc: 0.25,
    ce: 0.5,
    maxNodeErr: 1.0,
    minNodeErr: 0.0,
    useL1: false,
    useLInf: false,
};

export interface VivaldiNodeInput {
    readonly dimensions: number;
    readonly initialError?: number;
    readonly cfg?: Partial<VivaldiConfig>;
    readonly random?: VivaldiRandom;
}

export class Coordinates {
    readonly #cfg: VivaldiConfig;
    readonly #values: number[];

    constructor(values: readonly number[], cfg?: Partial<VivaldiConfig>) {
        this.#cfg = { ...DEFAULT_VIVALDI_CONFIG, ...cfg };
        this.#values = [...values];
    }

    clone(): Coordinates {
        return new Coordinates(this.#values, this.#cfg);
    }

    get values(): number[] {
        return [...this.#values];
    }

    add(other: Coordinates): Coordinates {
        this.#assertSameDimension(other);
        return new Coordinates(
            this.#values.map((value, index) => value + other.#values[index]),
            this.#cfg,
        );
    }

    subtract(other: Coordinates): Coordinates {
        this.#assertSameDimension(other);
        return new Coordinates(
            this.#values.map((value, index) => value - other.#values[index]),
            this.#cfg,
        );
    }

    multiply(scale: number): Coordinates {
        return new Coordinates(this.#values.map(value => value * scale), this.#cfg);
    }

    norm(): number {
        if (this.#cfg.useLInf) {
            let max = 0;
            for (const value of this.#values) {
                const abs = Math.abs(value);
                if (abs > max) {
                    max = abs;
                }
            }
            return max;
        }

        if (this.#cfg.useL1) {
            let sum = 0;
            for (const value of this.#values) {
                sum += Math.abs(value);
            }
            return sum;
        }

        let sumSq = 0;
        for (const value of this.#values) {
            sumSq += value * value;
        }
        return Math.sqrt(sumSq);
    }

    distance(other: Coordinates): number {
        return this.subtract(other).norm();
    }

    computeDirectionality(
        remote: Coordinates,
        random: VivaldiRandom = Math.random,
    ): Coordinates {
        const difference = this.subtract(remote);
        const norm = difference.norm();
        if (norm > 0) {
            return difference.multiply(1 / norm);
        }

        return this.#toRandomUnitVector(random);
    }

    isValid(): boolean {
        return this.#values.every(Number.isFinite);
    }

    // Collocated coordinates have no direction between them, so Vivaldi breaks
    // the tie with a random one. Drawing the vector directly keeps the function
    // total: the previous jitter-and-retry loop had no exit other than the
    // randomness happening to work.
    #toRandomUnitVector(random: VivaldiRandom): Coordinates {
        if (this.#values.length === 0) {
            throw new Error('Direction is undefined for zero-dimensional coordinates');
        }

        const candidate = new Coordinates(
            this.#values.map(() => random() * 2 - 1),
            this.#cfg,
        );
        const norm = candidate.norm();
        if (norm > 0) {
            return candidate.multiply(1 / norm);
        }

        const basis = new Array<number>(this.#values.length).fill(0);
        basis[0] = 1;
        return new Coordinates(basis, this.#cfg);
    }

    #assertSameDimension(other: Coordinates): void {
        if (this.#values.length !== other.#values.length) {
            throw new Error(
                `Coordinate dimension mismatch: ${this.#values.length} !== ${other.#values.length}`,
            );
        }
    }
}

export class VivaldiNode {
    readonly #cfg: VivaldiConfig;
    readonly #random: VivaldiRandom;
    #coords: Coordinates;
    #myError: number;

    constructor(input: VivaldiNodeInput) {
        if (!Number.isInteger(input.dimensions) || input.dimensions < 1) {
            throw new Error('Vivaldi node dimensions must be an integer >= 1');
        }

        this.#cfg = { ...DEFAULT_VIVALDI_CONFIG, ...input.cfg };
        this.#random = input.random ?? Math.random;
        this.#coords = new Coordinates(new Array(input.dimensions).fill(0), this.#cfg);
        this.#myError = input.initialError ?? 1.0;
    }

    get coords(): Coordinates {
        return this.#coords.clone();
    }

    get myError(): number {
        return this.#myError;
    }

    update(remote: VivaldiNodeData): void {
        if (!Number.isFinite(remote.rttMs) || remote.rttMs <= 0) {
            return;
        }

        const remoteCoords = new Coordinates(remote.coords, this.#cfg);
        if (!remoteCoords.isValid()) {
            return;
        }

        const denominator = this.#myError + remote.err;
        if (denominator === 0) {
            return;
        }

        const predictedRtt = this.#coords.distance(remoteCoords);
        const weight = this.#myError / denominator;
        const diffErr = remote.rttMs - predictedRtt;
        const sampleError = Math.abs(diffErr) / remote.rttMs;
        const nextErr =
            sampleError * this.#cfg.ce * weight +
            this.#myError * (1 - this.#cfg.ce * weight);
        const delta = this.#cfg.cc * weight;

        const direction = this.#coords.computeDirectionality(remoteCoords, this.#random);
        const movement = direction.multiply(delta * diffErr);
        const nextCoords = this.#coords.add(movement);

        if (!nextCoords.isValid() || !Number.isFinite(nextErr)) {
            return;
        }

        this.#coords = nextCoords;
        this.#myError = Math.min(
            this.#cfg.maxNodeErr,
            Math.max(this.#cfg.minNodeErr, nextErr),
        );
    }

    toNodeData(id: string, rttMs = 0): VivaldiNodeData {
        return {
            id,
            coords: this.#coords.values,
            err: this.#myError,
            rttMs,
        };
    }
}

export function predictedRttMs(
    source: VivaldiNodeData,
    target: VivaldiNodeData,
    cfg?: Partial<VivaldiConfig>,
): number {
    return computePredictedRttMs(source, target, { ...DEFAULT_VIVALDI_CONFIG, ...cfg });
}

/**
 * Allocation-free distance over an already-merged config. Graph construction
 * calls this once per candidate pair, so it is O(N^2) per build; going through
 * `Coordinates` there would allocate a merged config, two coordinate copies,
 * and a difference vector for every pair.
 */
export function computePredictedRttMs(
    source: VivaldiNodeData,
    target: VivaldiNodeData,
    cfg: VivaldiConfig,
): number {
    const sourceCoords = source.coords;
    const targetCoords = target.coords;
    if (sourceCoords.length !== targetCoords.length) {
        throw new Error('Coordinates must have the same dimension');
    }
    if (cfg.useLInf) {
        let max = 0;
        for (let axis = 0; axis < sourceCoords.length; axis++) {
            const difference = Math.abs(sourceCoords[axis] - targetCoords[axis]);
            if (difference > max) {
                max = difference;
            }
        }
        return max;
    }
    if (cfg.useL1) {
        let sum = 0;
        for (let axis = 0; axis < sourceCoords.length; axis++) {
            sum += Math.abs(sourceCoords[axis] - targetCoords[axis]);
        }
        return sum;
    }
    let sumSquares = 0;
    for (let axis = 0; axis < sourceCoords.length; axis++) {
        const difference = sourceCoords[axis] - targetCoords[axis];
        sumSquares += difference * difference;
    }
    return Math.sqrt(sumSquares);
}
