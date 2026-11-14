import { createSeededRandom } from './create-seeded-random.ts';

/** A Fisher-Yates shuffle over the seeded generator: one seed gives one order of the same items on every machine. */
export function computeShuffledOrder<T>(items: readonly T[], seed: number): readonly T[] {
    const random = createSeededRandom(seed);
    const shuffled = [...items];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
    }
    return shuffled;
}
