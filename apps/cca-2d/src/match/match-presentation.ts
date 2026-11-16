import { computePracticePlayerTick, type PracticeInput, type PracticePlayer } from '../practice-rules.ts';
import { computeTownPosition } from '../town/navigation.ts';
import type { TownState } from '../town/state.ts';
import type { TownMatchPose } from './match-protocol.ts';

export namespace TownMatchPresentation {
    export interface Frame {
        readonly player: PracticePlayer;
        readonly livePose: TownMatchPose | undefined;
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
    private displayed: PracticePlayer | undefined;
    private correction = { x: 0, z: 0 };
    private observed: PracticePlayer | undefined;
    private matchId = '';
    private inputGeneration = -1;
    private steps: TownMatchPresentation.Step[] = [];

    advance(frame: TownMatchPresentation.Frame): PracticePlayer {
        const reset = !frame.enabled || frame.player.frozenUntil > frame.player.elapsed ||
            frame.matchId !== this.matchId || frame.inputGeneration !== this.inputGeneration;
        const source = this.observe(frame, reset);
        if (reset || !this.player) {
            this.player = source;
            this.steps = [];
            this.correction = { x: 0, z: 0 };
            this.matchId = frame.matchId;
            this.inputGeneration = frame.inputGeneration;
        }
        else if (this.observed !== source) {
            this.reconcile(source, frame);
        }
        this.observed = source;
        if (!frame.enabled || frame.player.frozenUntil > frame.player.elapsed) {
            this.displayed = frame.player;
            return frame.player;
        }
        // Simulation elapsed time aligns the short replay window without comparing device clocks.
        // This is bounded visual prediction, not a claim that an input has been acknowledged.
        let remaining = Math.max(0, Math.min(frame.seconds, 0.05, source.elapsed + 0.3 - this.player.elapsed));
        while (remaining > 0.000001) {
            const seconds = Math.min(remaining, 1 / 30);
            this.player = computePracticePlayerTick({
                player: this.player,
                town: frame.town,
                controls: frame.controls,
                seconds
            }).player;
            this.steps.push({ end: this.player.elapsed, seconds, controls: frame.controls });
            remaining -= seconds;
        }
        const decay = Math.exp(-12 * Math.max(0, frame.seconds));
        this.correction = { x: this.correction.x * decay, z: this.correction.z * decay };
        this.displayed = { ...this.player, ...computeTownPosition(frame.town, this.player, this.correction) };
        return this.displayed;
    }

    private observe(frame: TownMatchPresentation.Frame, reset: boolean): PracticePlayer {
        const source = frame.livePose && frame.player.frozenUntil <= frame.player.elapsed
            ? { ...frame.player, ...frame.livePose }
            : frame.player;
        // A missing live observation is not a host rollback. Keep the newest movement base,
        // without advancing its time or renewing the 300 ms prediction budget.
        return !reset && this.observed && source.elapsed < this.observed.elapsed ? this.observed : source;
    }

    private reconcile(source: PracticePlayer, frame: TownMatchPresentation.Frame): void {
        this.steps = this.steps.filter((step) => step.end > source.elapsed);
        this.player = source;
        for (const step of this.steps) {
            const seconds = Math.min(step.seconds, step.end - this.player.elapsed);
            if (seconds > 0) {
                this.player = computePracticePlayerTick({
                    player: this.player,
                    town: frame.town,
                    controls: step.controls,
                    seconds
                }).player;
            }
        }
        const x = (this.displayed?.x ?? this.player.x) - this.player.x;
        const z = (this.displayed?.z ?? this.player.z) - this.player.z;
        this.correction = Math.hypot(x, z) < 2 ? { x, z } : { x: 0, z: 0 };
    }
}
