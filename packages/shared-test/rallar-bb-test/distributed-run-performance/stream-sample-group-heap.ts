/** A stream sample group the heap orders by insertion; a version bump marks older heap entries stale. */
export interface VersionedStreamSampleGroup {
    readonly insertionIndex: number;
    readonly version: number;
}

export interface StreamSampleGroupHeapEntry<Group extends VersionedStreamSampleGroup> {
    readonly group: Group;
    readonly version: number;
}

/** A binary min-heap on insertion index whose stale entries are dropped lazily when they reach the top. */
export interface StreamSampleGroupHeap<Group extends VersionedStreamSampleGroup> {
    readonly entries: StreamSampleGroupHeapEntry<Group>[];
}

export function createStreamSampleGroupHeap<Group extends VersionedStreamSampleGroup>(): StreamSampleGroupHeap<Group> {
    return { entries: [] };
}

export function pushStreamSampleGroup<Group extends VersionedStreamSampleGroup>(
    heap: StreamSampleGroupHeap<Group>,
    group: Group
): void {
    const entry = { group, version: group.version };
    heap.entries.push(entry);
    let position = heap.entries.length - 1;
    while (position > 0) {
        const parent = Math.floor((position - 1) / 2);
        if (computeHeapEntryOrder(heap.entries[parent], entry) <= 0) {
            break;
        }
        heap.entries[position] = heap.entries[parent];
        position = parent;
    }
    heap.entries[position] = entry;
}

/** Removes stale entries from the top of the heap and returns how many it removed. */
export function removeStaleStreamSampleGroupEntries<Group extends VersionedStreamSampleGroup>(
    heap: StreamSampleGroupHeap<Group>
): number {
    let removedEntryCount = 0;
    while (heap.entries[0] && heap.entries[0].version !== heap.entries[0].group.version) {
        removeOldestHeapEntry(heap);
        removedEntryCount += 1;
    }
    return removedEntryCount;
}

/** The oldest group, current only after its stale entries were removed. */
export function getOldestStreamSampleGroup<Group extends VersionedStreamSampleGroup>(
    heap: StreamSampleGroupHeap<Group>
): Group | undefined {
    return heap.entries[0]?.group;
}

function removeOldestHeapEntry<Group extends VersionedStreamSampleGroup>(heap: StreamSampleGroupHeap<Group>): void {
    const replacement = heap.entries.pop();
    if (!replacement || heap.entries.length === 0) {
        return;
    }
    let position = 0;
    while (true) {
        const left = position * 2 + 1;
        const right = left + 1;
        if (left >= heap.entries.length) {
            break;
        }
        const child = right < heap.entries.length &&
                computeHeapEntryOrder(heap.entries[right], heap.entries[left]) < 0
            ? right
            : left;
        if (computeHeapEntryOrder(replacement, heap.entries[child]) <= 0) {
            break;
        }
        heap.entries[position] = heap.entries[child];
        position = child;
    }
    heap.entries[position] = replacement;
}

function computeHeapEntryOrder<Group extends VersionedStreamSampleGroup>(
    left: StreamSampleGroupHeapEntry<Group>,
    right: StreamSampleGroupHeapEntry<Group>
): number {
    return left.group.insertionIndex - right.group.insertionIndex;
}
