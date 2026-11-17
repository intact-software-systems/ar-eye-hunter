import { createBoundedHistogram, type BoundedHistogram } from './bounded-histogram.ts';

export function assertBoundedHistogram(upperBounds: readonly number[], named: string): BoundedHistogram {
    const created = createBoundedHistogram(upperBounds);
    if (created.right === undefined) {
        throw new Error(`${named} is not a valid set of histogram bounds: ${created.left}`);
    }
    return created.right;
}
