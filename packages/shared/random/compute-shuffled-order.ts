/**
 * A Fisher-Yates shuffle drawing from the given generator: a seeded generator gives one order of the same items on
 * every machine.
 */
export function computeShuffledOrder<T>(items: readonly T[], random: () => number): readonly T[] {
    const shuffled = [...items];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
    }
    return shuffled;
}
