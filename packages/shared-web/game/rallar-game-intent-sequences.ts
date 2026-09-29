/** Covers every intent one sender can issue within a command's 30 s life, so a retried or fallback copy stays inside it. */
export const RALLAR_GAME_INTENT_SEQUENCE_WINDOW = 1_024;

/** Intents cross two carriers out of order (C10): a lower sequence is new unless seen; past the window it is stale. */
export class RallarGameIntentSequences {
    private readonly seen = new Set<number>();
    private forgottenThrough = -1;

    public accept(seq: number): 'duplicate-sequence' | 'stale-sequence' | undefined {
        if (seq <= this.forgottenThrough) {
            return 'stale-sequence';
        }
        if (this.seen.has(seq)) {
            return 'duplicate-sequence';
        }
        this.seen.add(seq);
        if (this.seen.size > RALLAR_GAME_INTENT_SEQUENCE_WINDOW) {
            this.forgetOldest();
        }
        return undefined;
    }

    private forgetOldest(): void {
        const oldest = Math.min(...this.seen);
        this.seen.delete(oldest);
        this.forgottenThrough = oldest;
    }
}
