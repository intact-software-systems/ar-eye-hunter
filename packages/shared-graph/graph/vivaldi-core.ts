export type VivaldiNodeData = {
    readonly id: string;
    readonly coords: readonly number[];
    readonly err: number;
    readonly rttMs: number;
};

export type VivaldiConfig = {
    readonly cc: number;
    readonly ce: number;
    readonly maxNodeErr: number;
    readonly minNodeErr: number;
    readonly useL1: boolean;
    readonly useLInf: boolean;
    readonly jitterScale: number;
};

export const DEFAULT_VIVALDI_CONFIG: VivaldiConfig = {
    cc: 0.25,
    ce: 0.5,
    maxNodeErr: 1.0,
    minNodeErr: 0.0,
    useL1: false,
    useLInf: false,
    jitterScale: 1.0,
};

export class Coordinates {
    readonly #cfg: VivaldiConfig;
    #values: number[];

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

    adjustCoordinates(scale = this.#cfg.jitterScale): void {
        this.#values = this.#values.map(value => value + scale * (Math.random() * 2 - 1));
    }

    getDirectionality(remote: Coordinates): Coordinates {
        let diff = this.subtract(remote);
        let currentNorm = diff.norm();

        while (currentNorm === 0) {
            this.adjustCoordinates();
            diff = this.subtract(remote);
            currentNorm = diff.norm();
        }

        return diff.multiply(1 / currentNorm);
    }

    isValid(): boolean {
        return this.#values.every(Number.isFinite);
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
    #coords: Coordinates;
    #myError: number;

    constructor(dimensions: number, initialError = 1.0, cfg?: Partial<VivaldiConfig>) {
        this.#cfg = { ...DEFAULT_VIVALDI_CONFIG, ...cfg };
        this.#coords = new Coordinates(new Array(dimensions).fill(0), this.#cfg);
        this.#myError = initialError;
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

        const direction = this.#coords.getDirectionality(remoteCoords);
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
    const mergedCfg = { ...DEFAULT_VIVALDI_CONFIG, ...cfg };
    const sourceCoords = new Coordinates(source.coords, mergedCfg);
    const targetCoords = new Coordinates(target.coords, mergedCfg);
    return sourceCoords.distance(targetCoords);
}
