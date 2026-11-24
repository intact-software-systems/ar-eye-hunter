import type { TownMatchState } from '../town-match.ts';
import type { TownCheckpoint } from './match-checkpoints.ts';

const STALLED_COMMIT_MS = 1500;
const INTERRUPT_AFTER_MS = 10000;

export namespace TownMatchRecoveryWindow {
    export interface Observation {
        readonly match: TownMatchState | undefined;
        readonly available: boolean;
        readonly authorityAligned: boolean;
        readonly recoveryRequired: boolean;
        readonly now: number;
    }
}

/** Tracks the interval since agreement stalled and the epoch in which an active round timed out. */
export class TownMatchRecoveryWindow {
    private lastCommit: { readonly at: number; readonly epoch: number; } | undefined;
    private recoveryStartedAt: number | undefined;
    private interruptedMatch: { readonly matchId: string; readonly epoch: number; } | undefined;

    status(observation: TownMatchRecoveryWindow.Observation) {
        const { match, available, authorityAligned, recoveryRequired, now } = observation;
        const interruption = match && this.interruptedMatch?.matchId === match.matchId
            ? 'Round interrupted: recovery could not be confirmed. Your last confirmed points are preserved.'
            : undefined;
        const stalled = this.lastCommit !== undefined && now - this.lastCommit.at >= STALLED_COMMIT_MS;
        const active = match?.phase === 'playing' || match?.phase === 'countdown';
        return {
            interruption,
            recovering: active && (!available || !authorityAligned || !!interruption || recoveryRequired || stalled)
        };
    }

    resetWait(): void {
        this.recoveryStartedAt = undefined;
    }

    expire(matchId: string | undefined, now: number): void {
        if (!matchId || this.lastCommit === undefined) {
            return;
        }
        this.recoveryStartedAt ??= Math.min(now, this.lastCommit.at + STALLED_COMMIT_MS);
        if (now - this.recoveryStartedAt >= INTERRUPT_AFTER_MS && this.interruptedMatch?.matchId !== matchId) {
            this.interruptedMatch = { matchId: matchId, epoch: this.lastCommit.epoch };
        }
    }

    confirm(checkpoint: TownCheckpoint, now: number, localId: string | undefined, isDirector: boolean): void {
        this.lastCommit = { at: now, epoch: checkpoint.epoch };
        const observing = checkpoint.state.seats.some((seat) => seat.id === localId && seat.status === 'observer');
        if (observing || (this.interruptedMatch && checkpoint.epoch > this.interruptedMatch.epoch && !isDirector)) {
            this.interruptedMatch = undefined;
            this.recoveryStartedAt = undefined;
        }
    }
}
