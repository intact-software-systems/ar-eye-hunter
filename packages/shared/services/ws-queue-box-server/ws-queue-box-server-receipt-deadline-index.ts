interface WsQueueBoxServerReceiptDeadline {
    readonly key: string;
    readonly deadlineAtMs: number;
}

/**
 * The receipt aggregates ordered by deadline: a binary min-heap with each key's position, so adding,
 * deleting and taking the earliest deadline are O(log n) and nothing rescans the aggregate map.
 */
export class WsQueueBoxServerReceiptDeadlineIndex {
    readonly #heap: WsQueueBoxServerReceiptDeadline[] = [];
    readonly #positions = new Map<string, number>();

    add(key: string, deadlineAtMs: number): void {
        this.delete(key);
        this.#heap.push({ key, deadlineAtMs });
        this.#positions.set(key, this.#heap.length - 1);
        this.siftUp(this.#heap.length - 1);
    }

    delete(key: string): void {
        const position = this.#positions.get(key);
        if (position === undefined) {
            return;
        }
        this.removeAt(position);
    }

    getNextDeadlineAtMs(): number | undefined {
        return this.#heap[0]?.deadlineAtMs;
    }

    /** Every key whose deadline is at or before `nowMs`, earliest first; each leaves the index. */
    takeDue(nowMs: number): readonly string[] {
        const due: string[] = [];
        while (this.#heap.length > 0 && this.#heap[0].deadlineAtMs <= nowMs) {
            due.push(this.#heap[0].key);
            this.removeAt(0);
        }
        return due;
    }

    private removeAt(position: number): void {
        const last = this.#heap.length - 1;
        this.#positions.delete(this.#heap[position].key);
        if (position !== last) {
            this.place(position, this.#heap[last]);
        }
        this.#heap.pop();
        if (position < this.#heap.length) {
            this.siftUp(position);
            this.siftDown(position);
        }
    }

    private siftUp(start: number): void {
        let position = start;
        while (position > 0) {
            const parent = (position - 1) >> 1;
            if (this.#heap[parent].deadlineAtMs <= this.#heap[position].deadlineAtMs) {
                return;
            }
            this.swap(position, parent);
            position = parent;
        }
    }

    private siftDown(start: number): void {
        let position = start;
        for (;;) {
            const left = position * 2 + 1;
            const right = left + 1;
            let earliest = position;
            if (left < this.#heap.length && this.#heap[left].deadlineAtMs < this.#heap[earliest].deadlineAtMs) {
                earliest = left;
            }
            if (right < this.#heap.length && this.#heap[right].deadlineAtMs < this.#heap[earliest].deadlineAtMs) {
                earliest = right;
            }
            if (earliest === position) {
                return;
            }
            this.swap(position, earliest);
            position = earliest;
        }
    }

    private swap(left: number, right: number): void {
        const entry = this.#heap[left];
        this.place(left, this.#heap[right]);
        this.place(right, entry);
    }

    private place(position: number, entry: WsQueueBoxServerReceiptDeadline): void {
        this.#heap[position] = entry;
        this.#positions.set(entry.key, position);
    }
}
