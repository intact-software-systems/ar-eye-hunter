/** Covers every intent one sender can issue within a command's 30 s life, so a retried or fallback copy stays inside it. */
export const RALLAR_GAME_INTENT_SEQUENCE_WINDOW = 1_024;

export class RallarGameIntentSequences {
    private readonly seen = new Set<number>();
    private highest = Number.NEGATIVE_INFINITY;

    public accept(seq: number): 'duplicate-sequence' | 'stale-sequence' | undefined {
        if (seq <= this.highest - RALLAR_GAME_INTENT_SEQUENCE_WINDOW) {
            return 'stale-sequence';
        }
        if (this.seen.has(seq)) {
            return 'duplicate-sequence';
        }
        this.seen.add(seq);
        this.highest = Math.max(this.highest, seq);
        if (this.seen.size > 2 * RALLAR_GAME_INTENT_SEQUENCE_WINDOW) {
            this.forgetBelowWindow();
        }
        return undefined;
    }

    private forgetBelowWindow(): void {
        const floor = this.highest - RALLAR_GAME_INTENT_SEQUENCE_WINDOW;
        for (const seq of this.seen) {
            if (seq <= floor) {
                this.seen.delete(seq);
            }
        }
    }
}
