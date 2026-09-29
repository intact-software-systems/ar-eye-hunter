export interface ALVolatileSessionRelease {
    readonly msgId: string;
    readonly deadlineAtMs: number;
}

/** A binary min-heap by deadline, so the budget releases what is due without walking what is not. */
export class ALVolatileSessionReleaseQueue {
    private readonly heap: ALVolatileSessionRelease[] = [];

    push(release: ALVolatileSessionRelease): void {
        this.heap.push(release);
        this.siftUp(this.heap.length - 1);
    }

    popDue(nowMs: number): ALVolatileSessionRelease | undefined {
        const earliest = this.heap[0];
        if (earliest === undefined || earliest.deadlineAtMs > nowMs) {
            return undefined;
        }
        const last = this.heap.pop();
        if (last !== undefined && this.heap.length > 0) {
            this.heap[0] = last;
            this.siftDown(0);
        }
        return earliest;
    }

    private siftUp(index: number): void {
        let child = index;
        while (child > 0) {
            const parent = (child - 1) >> 1;
            if (this.heap[parent]!.deadlineAtMs <= this.heap[child]!.deadlineAtMs) {
                return;
            }
            this.swap(parent, child);
            child = parent;
        }
    }

    private siftDown(index: number): void {
        let parent = index;
        for (;;) {
            const left = 2 * parent + 1;
            const right = left + 1;
            let smallest = parent;
            if (left < this.heap.length && this.heap[left]!.deadlineAtMs < this.heap[smallest]!.deadlineAtMs) {
                smallest = left;
            }
            if (right < this.heap.length && this.heap[right]!.deadlineAtMs < this.heap[smallest]!.deadlineAtMs) {
                smallest = right;
            }
            if (smallest === parent) {
                return;
            }
            this.swap(parent, smallest);
            parent = smallest;
        }
    }

    private swap(first: number, second: number): void {
        const held = this.heap[first]!;
        this.heap[first] = this.heap[second]!;
        this.heap[second] = held;
    }
}
