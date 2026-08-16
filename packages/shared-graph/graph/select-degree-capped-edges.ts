export interface DegreeCappedEdge {
    readonly sourceIndex: number;
    readonly targetIndex: number;
    readonly weight: number;
}

export interface DegreeCappedEdgeSelectionInput {
    readonly nodeCount: number;
    readonly degreeLimit: number;
    readonly computeWeight: (sourceIndex: number, targetIndex: number) => number;
}

/**
 * Greedy degree-capped selection over every node pair, cheapest first.
 *
 * The greedy needs a global weight ordering — an edge to a distant node is
 * accepted once all nearer candidates have saturated — so candidates cannot be
 * restricted to each node's nearest few without changing the result. What it
 * does not need is a fully sorted array: at most `nodeCount * degreeLimit / 2`
 * edges are ever accepted, so the candidates are heapified once and popped only
 * until no two unsaturated nodes remain. Ties break on (weight, source, target)
 * indices, which is why callers must pass nodes in a canonical order.
 */
export function selectDegreeCappedEdges(
    input: DegreeCappedEdgeSelectionInput,
): readonly DegreeCappedEdge[] {
    if (input.nodeCount < 2 || input.degreeLimit < 1) {
        return [];
    }
    const heap = createCandidateHeap(input);
    const degrees = new Uint32Array(input.nodeCount);
    const selected: DegreeCappedEdge[] = [];
    let unsaturatedCount = input.nodeCount;

    while (heap.size > 0 && unsaturatedCount >= 2) {
        const candidate = popCheapestCandidate(heap);
        if (
            degrees[candidate.sourceIndex] >= input.degreeLimit ||
            degrees[candidate.targetIndex] >= input.degreeLimit
        ) {
            continue;
        }
        selected.push(candidate);
        degrees[candidate.sourceIndex] += 1;
        degrees[candidate.targetIndex] += 1;
        if (degrees[candidate.sourceIndex] === input.degreeLimit) {
            unsaturatedCount -= 1;
        }
        if (degrees[candidate.targetIndex] === input.degreeLimit) {
            unsaturatedCount -= 1;
        }
    }
    return selected;
}

interface CandidateHeap {
    readonly weights: Float64Array;
    readonly sources: Uint32Array;
    readonly targets: Uint32Array;
    size: number;
}

function createCandidateHeap(input: DegreeCappedEdgeSelectionInput): CandidateHeap {
    const pairCount = (input.nodeCount * (input.nodeCount - 1)) / 2;
    const heap: CandidateHeap = {
        weights: new Float64Array(pairCount),
        sources: new Uint32Array(pairCount),
        targets: new Uint32Array(pairCount),
        size: pairCount,
    };
    let index = 0;
    for (let source = 0; source < input.nodeCount; source++) {
        for (let target = source + 1; target < input.nodeCount; target++) {
            heap.weights[index] = input.computeWeight(source, target);
            heap.sources[index] = source;
            heap.targets[index] = target;
            index += 1;
        }
    }
    // Math.floor and not a bit shift: `>>` coerces to int32, so a candidate
    // count above 2^31 would silently start heapifying from a negative index.
    for (let parent = Math.floor(pairCount / 2) - 1; parent >= 0; parent--) {
        siftDown(heap, parent);
    }
    return heap;
}

function popCheapestCandidate(heap: CandidateHeap): DegreeCappedEdge {
    const cheapest: DegreeCappedEdge = {
        sourceIndex: heap.sources[0],
        targetIndex: heap.targets[0],
        weight: heap.weights[0],
    };
    heap.size -= 1;
    if (heap.size > 0) {
        swapCandidates(heap, 0, heap.size);
        siftDown(heap, 0);
    }
    return cheapest;
}

function siftDown(heap: CandidateHeap, start: number): void {
    let parent = start;
    for (;;) {
        const left = parent * 2 + 1;
        if (left >= heap.size) {
            return;
        }
        const right = left + 1;
        const child = right < heap.size && isCheaper(heap, right, left) ? right : left;
        if (!isCheaper(heap, child, parent)) {
            return;
        }
        swapCandidates(heap, parent, child);
        parent = child;
    }
}

function isCheaper(heap: CandidateHeap, left: number, right: number): boolean {
    if (heap.weights[left] !== heap.weights[right]) {
        return heap.weights[left] < heap.weights[right];
    }
    if (heap.sources[left] !== heap.sources[right]) {
        return heap.sources[left] < heap.sources[right];
    }
    return heap.targets[left] < heap.targets[right];
}

function swapCandidates(heap: CandidateHeap, left: number, right: number): void {
    const weight = heap.weights[left];
    heap.weights[left] = heap.weights[right];
    heap.weights[right] = weight;
    const source = heap.sources[left];
    heap.sources[left] = heap.sources[right];
    heap.sources[right] = source;
    const target = heap.targets[left];
    heap.targets[left] = heap.targets[right];
    heap.targets[right] = target;
}
