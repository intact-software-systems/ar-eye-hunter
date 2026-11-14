import { createSeededRandom } from '../../../../black-box-runner/recipes/create-seeded-random.ts';
import type { AlmLaneOrder } from './decode-alm-lane-parameters.ts';

export interface ResolveAlmLaneCellOrderInput<T extends Readonly<{ scenarioKey: string; }>> {
    /** The family's cells in catalog order. */
    readonly scenarios: readonly T[];
    readonly order: AlmLaneOrder;
    /** Null for a declared order, and for a shuffled one whose seed is minted. */
    readonly seed: number | null;
    /** The scenario keys kept; empty keeps every cell. */
    readonly only: readonly string[];
    /** Called once, for a shuffled order that names no seed. */
    readonly mintSeed: () => number;
}

export interface AlmLaneCellOrder<T> {
    readonly scenarios: readonly T[];
    /** The seed the shuffle used, given or minted; null for the declared order. */
    readonly seed: number | null;
}

/** A Fisher-Yates shuffle over the seeded generator: one seed gives one order of the same cells on every machine. */
export function resolveAlmLaneCellOrder<T extends Readonly<{ scenarioKey: string; }>>(
    input: ResolveAlmLaneCellOrderInput<T>
): AlmLaneCellOrder<T> {
    const kept = input.only.length === 0
        ? input.scenarios
        : input.scenarios.filter((scenario) => input.only.includes(scenario.scenarioKey));
    if (input.order === 'declared') {
        return { scenarios: kept, seed: null };
    }
    const seed = input.seed ?? input.mintSeed();
    const random = createSeededRandom(seed);
    const shuffled = [...kept];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
    }
    return { scenarios: shuffled, seed };
}
