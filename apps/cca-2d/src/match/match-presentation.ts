import { computePracticePlayerTick, type PracticeInput, type PracticePlayer } from '../practice-rules.ts';
import type { TownState } from '../town/state.ts';

export namespace TownMatchPresentation {
    export interface Frame {
        readonly player: PracticePlayer;
        readonly town: TownState;
        readonly matchId: string;
        readonly inputGeneration: number;
        readonly enabled: boolean;
        readonly controls: PracticeInput;
        readonly seconds: number;
    }
    export interface Step {
        readonly end: number;
        readonly seconds: number;
        readonly controls: PracticeInput;
    }
}

/** Owns disposable local visuals. Checkpoints alone own world effects, points and recovery. */
export class TownMatchPresentation {
    private player: PracticePlayer | undefined;
    private confirmed: PracticePlayer | undefined;
    private matchId = '';
    private inputGeneration = -1;
    private steps: TownMatchPresentation.Step[] = [];

    advance(frame: TownMatchPresentation.Frame): PracticePlayer {
        const reset = !frame.enabled || frame.player.frozenUntil > frame.player.elapsed ||
            frame.matchId !== this.matchId || frame.inputGeneration !== this.inputGeneration ||
            (this.confirmed !== undefined && frame.player.elapsed < this.confirmed.elapsed);
        if (reset || !this.player) {
            this.player = frame.player;
            this.steps = [];
            this.matchId = frame.matchId;
            this.inputGeneration = frame.inputGeneration;
        }
        else if (this.confirmed !== frame.player) {
            this.reconcile(frame);
        }
        this.confirmed = frame.player;
        if (!frame.enabled || frame.player.frozenUntil > frame.player.elapsed) {
            return frame.player;
        }
        // Simulation elapsed time aligns the short replay window without comparing device clocks.
        // This is bounded visual prediction, not a claim that an input has been acknowledged.
        let remaining = Math.max(0, Math.min(frame.seconds, 0.05, frame.player.elapsed + 0.3 - this.player.elapsed));
        while (remaining > 0.000001) {
            const seconds = Math.min(remaining, 1 / 30);
            this.player = computePracticePlayerTick({
                player: this.player, town: frame.town, controls: frame.controls, seconds
            }).player;
            this.steps.push({ end: this.player.elapsed, seconds, controls: frame.controls });
            remaining -= seconds;
        }
        return this.player;
    }

    private reconcile(frame: TownMatchPresentation.Frame): void {
        this.steps = this.steps.filter((step) => step.end > frame.player.elapsed);
        this.player = frame.player;
        for (const step of this.steps) {
            const seconds = Math.min(step.seconds, step.end - this.player.elapsed);
            if (seconds > 0) {
                this.player = computePracticePlayerTick({
                    player: this.player, town: frame.town, controls: step.controls, seconds
                }).player;
            }
        }
    }
}
