import type { PracticeInput } from '../../practice-rules.ts';

/** Maps device input to one match's action identities across confirmation pauses. */
export class TownMatchControls {
    private observedDash = 0;
    private publishedDash = 0;
    private readonly keys = new Map<string, boolean>();

    rebase(controls: PracticeInput, confirmedDash: number): void {
        this.observedDash = controls.dash;
        this.publishedDash = confirmedDash;
        for (const key of this.keys.keys()) {
            this.keys.set(key, false);
        }
    }

    sample(controls: PracticeInput, confirmedDash: number, paused: boolean): PracticeInput {
        if (paused) {
            for (const key of this.keys.keys()) {
                this.keys.set(key, false);
            }
        }
        this.publishedDash = Math.max(this.publishedDash, confirmedDash) +
            (paused ? 0 : Math.max(0, controls.dash - this.observedDash));
        this.observedDash = controls.dash;
        return {
            x: paused ? 0 : controls.x,
            z: paused ? 0 : controls.z,
            dash: this.publishedDash
        };
    }

    acceptKeyDown(code: string, repeat: boolean, paused: boolean): boolean {
        if (
            !['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(code)
        ) {
            return true;
        }
        if (!repeat || paused) {
            this.keys.set(code, !paused);
        }
        return this.keys.get(code) === true;
    }

    releaseKey(code: string): void {
        this.keys.delete(code);
    }

    clearKeys(): void {
        this.keys.clear();
    }
}
