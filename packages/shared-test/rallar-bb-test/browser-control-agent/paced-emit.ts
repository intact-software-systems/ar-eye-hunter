/** Runs `emit` once per interval in which it was requested, at the interval's end, however often it was requested. */
export class PacedEmit {
    readonly #intervalMs: number;
    readonly #emit: () => void;
    #timer: ReturnType<typeof setTimeout> | undefined;

    constructor(intervalMs: number, emit: () => void) {
        this.#intervalMs = intervalMs;
        this.#emit = emit;
    }

    request(): void {
        if (this.#timer !== undefined) {
            return;
        }
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#emit();
        }, this.#intervalMs);
    }
}
