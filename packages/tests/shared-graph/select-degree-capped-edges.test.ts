import { describe, expect, it } from 'vitest';
import { selectDegreeCappedEdges } from '@shared-graph/graph/select-degree-capped-edges.ts';

// The heap pops only until no two unsaturated nodes remain rather than sorting
// every candidate, so the property that matters is that it still selects
// exactly what a full sort would, in the same order.
describe('selectDegreeCappedEdges', () => {
    it.each([
        { nodeCount: 40, degreeLimit: 4, weightBuckets: 20 },
        { nodeCount: 60, degreeLimit: 3, weightBuckets: 5 },
        { nodeCount: 25, degreeLimit: 8, weightBuckets: 200 },
    ])(
        'selects what a full candidate sort selects (n=$nodeCount, limit=$degreeLimit)',
        ({ nodeCount, degreeLimit, weightBuckets }) => {
            const computeWeight = createBucketedWeightFunction(weightBuckets);
            const selected = selectDegreeCappedEdges({ nodeCount, degreeLimit, computeWeight });
            expect(toEdgeKeys(selected)).toEqual(
                selectByFullSort({ nodeCount, degreeLimit, computeWeight }),
            );
        },
    );

    it('respects the degree limit and returns nothing for degenerate input', () => {
        const computeWeight = createBucketedWeightFunction(10);
        const selected = selectDegreeCappedEdges({ nodeCount: 30, degreeLimit: 3, computeWeight });
        const degrees = new Map<number, number>();
        for (const edge of selected) {
            degrees.set(edge.sourceIndex, (degrees.get(edge.sourceIndex) ?? 0) + 1);
            degrees.set(edge.targetIndex, (degrees.get(edge.targetIndex) ?? 0) + 1);
        }
        for (const degree of degrees.values()) {
            expect(degree).toBeLessThanOrEqual(3);
        }
        expect(selectDegreeCappedEdges({ nodeCount: 1, degreeLimit: 3, computeWeight })).toEqual([]);
        expect(selectDegreeCappedEdges({ nodeCount: 9, degreeLimit: 0, computeWeight })).toEqual([]);
    });
});

// Coarse buckets on purpose: equal weights are what make the (weight, source,
// target) tie-break observable, and collinear or co-located coordinates produce
// them constantly in production.
function createBucketedWeightFunction(buckets: number): (source: number, target: number) => number {
    const cache = new Map<string, number>();
    let seed = 7;
    return (source, target) => {
        const key = `${source}|${target}`;
        const cached = cache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const weight = seed % buckets;
        cache.set(key, weight);
        return weight;
    };
}

function selectByFullSort(input: {
    nodeCount: number;
    degreeLimit: number;
    computeWeight: (source: number, target: number) => number;
}): string[] {
    const candidates: { source: number; target: number; weight: number }[] = [];
    for (let source = 0; source < input.nodeCount; source++) {
        for (let target = source + 1; target < input.nodeCount; target++) {
            candidates.push({ source, target, weight: input.computeWeight(source, target) });
        }
    }
    candidates.sort((left, right) =>
        left.weight - right.weight || left.source - right.source || left.target - right.target
    );
    const degrees = new Array<number>(input.nodeCount).fill(0);
    const selected: string[] = [];
    for (const candidate of candidates) {
        if (
            degrees[candidate.source] >= input.degreeLimit ||
            degrees[candidate.target] >= input.degreeLimit
        ) {
            continue;
        }
        selected.push(`${candidate.source}|${candidate.target}`);
        degrees[candidate.source] += 1;
        degrees[candidate.target] += 1;
    }
    return selected;
}

function toEdgeKeys(
    edges: readonly { sourceIndex: number; targetIndex: number }[],
): string[] {
    return edges.map((edge) => `${edge.sourceIndex}|${edge.targetIndex}`);
}
