export class AtomicLong {
    private v: number;

    constructor(initial: number) {
        this.v = initial;
    }

    get(): number {
        return this.v;
    }

    set(next: number): void {
        this.v = next;
    }

    addAndGet(delta: number): number {
        this.v += delta;
        return this.v;
    }

    getAndSet(next: number): number {
        const prev = this.v;
        this.v = next;
        return prev;
    }
}
