export type Rng = {
    readonly next: () => number; // [0, 1)
};

export function makeMulberry32(seed: number): Rng {
    let t = seed >>> 0;
    return {
        next: () => {
            t += 0x6d2b79f5;
            let x = t;
            x = Math.imul(x ^ (x >>> 15), x | 1);
            x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
            return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
        },
    };
}