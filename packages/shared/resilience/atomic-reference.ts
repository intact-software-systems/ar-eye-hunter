export class AtomicReference<T> {
    private v: T;

    constructor(initial: T) {
        this.v = initial;
    }

    get(): T {
        return this.v;
    }

    set(next: T): void {
        this.v = next;
    }

    getAndSet(next: T): T {
        const prev = this.v;
        this.v = next;
        return prev;
    }
}
