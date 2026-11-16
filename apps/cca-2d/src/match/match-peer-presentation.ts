import { createRallarMotionBuffer } from '@shared/rallar-motion/buffer.ts';

import type { TownPoint } from '../town/map.ts';
import { computeTownPosition } from '../town/navigation.ts';
import type { TownState } from '../town/state.ts';
import type { TownMatchPlayer } from './town-match.ts';

export namespace TownMatchPeerPresentation {
    export interface Frame {
        readonly player: TownMatchPlayer;
        readonly town: TownState;
        readonly matchId: string;
        readonly inputGeneration: number;
        readonly tick: number;
        readonly enabled: boolean;
        /** Receiver-local timeOrigin + performance.now(); never the sender's wall clock. */
        readonly nowEpochMs: number;
    }
    export interface Pose extends TownPoint {
        readonly animationTime: number;
    }
}

/** Adapts accepted peer pose observations to Rallar Motion; no output is written back to the match. */
export class TownMatchPeerPresentation {
    private readonly motion = createRallarMotionBuffer<never>({
        interpolationDelayMs: 150,
        maxExtrapolationMs: 100,
        maxSamplesPerEntity: 4,
        interpolationMode: 'linear'
    });
    private previous: TownMatchPeerPresentation.Frame | undefined;
    private observedAtEpochMs = 0;

    advance(frame: TownMatchPeerPresentation.Frame): TownMatchPeerPresentation.Pose {
        const { player, nowEpochMs } = frame;
        const previous = this.previous;
        const frozen = player.frozenUntil > player.elapsed;
        const reset = !previous || !frame.enabled || !previous.enabled || frozen ||
            previous.player.frozenUntil > previous.player.elapsed ||
            frame.matchId !== previous.matchId || frame.inputGeneration !== previous.inputGeneration ||
            frame.tick < previous.tick || player.id !== previous.player.id ||
            nowEpochMs < previous.nowEpochMs || nowEpochMs - previous.nowEpochMs > 400 ||
            Math.hypot(player.x - previous.player.x, player.z - previous.player.z) > 4;
        if (reset && previous) {
            this.motion.remove(previous.player.id);
        }
        if (reset || frame.tick !== previous?.tick) {
            this.observedAtEpochMs = nowEpochMs;
            this.motion.push({
                entityId: player.id,
                seq: frame.tick,
                observedAtEpochMs: nowEpochMs,
                position: [player.x, 0, player.z],
                velocity: [player.vx, 0, player.vz]
            });
        }
        this.previous = frame;
        if (reset) {
            return { x: player.x, z: player.z, animationTime: player.elapsed };
        }
        // Hold the capped extrapolation endpoint during silence. Sampling beyond Motion's
        // extrapolation window would fall back to the old sample and visibly jump backwards.
        const sampleAt = Math.min(nowEpochMs, this.observedAtEpochMs + 250);
        const estimate = this.motion.sample(player.id, sampleAt);
        const position = estimate
            ? computeTownPosition(frame.town, player, {
                x: estimate.position[0] - player.x,
                z: estimate.position[2] - player.z
            })
            : player;
        return {
            x: position.x,
            z: position.z,
            animationTime: player.elapsed + Math.max(0, sampleAt - this.observedAtEpochMs) / 1000
        };
    }
}
