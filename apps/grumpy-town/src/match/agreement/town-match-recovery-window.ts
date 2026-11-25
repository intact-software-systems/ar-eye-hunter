import { TOWN_MATCH_RATE, type TownMatchState } from '../town-match.ts';
import type { TownCheckpoint } from './match-checkpoints.ts';

// A peer may render this much host progress while a checkpoint completes its WAN round trips.
const TOWN_MATCH_CHECKPOINT_LEAD_MS = 4500;
export const TOWN_MATCH_CHECKPOINT_LEAD_TICKS = TOWN_MATCH_RATE * TOWN_MATCH_CHECKPOINT_LEAD_MS / 1000;
const MAX_COMMIT_SILENCE_MS = 14_500;
// Allow the silent director’s room lease and reconnect reservation to expire, then give survivors time to agree.
const INTERRUPT_AFTER_MS = 13_000;

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
    private lastActiveCommit: { readonly at: number; readonly epoch: number; readonly matchId: string; } | undefined;
    private interruptAt: number | undefined;
    private interruptedMatch: { readonly matchId: string; readonly epoch: number; } | undefined;

    status(observation: TownMatchRecoveryWindow.Observation) {
        const { match, available, authorityAligned, recoveryRequired, now } = observation;
        const interruption = match && this.interruptedMatch?.matchId === match.matchId
            ? 'Round interrupted: recovery could not be confirmed. Your last confirmed points are preserved.'
            : undefined;
        const stalled = this.lastActiveCommit !== undefined && this.lastActiveCommit.matchId === match?.matchId &&
            now - this.lastActiveCommit.at >= TOWN_MATCH_CHECKPOINT_LEAD_MS;
        const active = match?.phase === 'playing' || match?.phase === 'countdown';
        return {
            interruption,
            recovering: active && (!available || !authorityAligned || !!interruption || recoveryRequired || stalled)
        };
    }

    resetWait(): void {
        this.interruptAt = undefined;
    }

    expire(matchId: string | undefined, now: number): void {
        if (!this.lastActiveCommit || this.lastActiveCommit.matchId !== matchId) {
            return;
        }
        this.interruptAt ??= Math.min(now + INTERRUPT_AFTER_MS, this.lastActiveCommit.at + MAX_COMMIT_SILENCE_MS);
        if (now >= this.interruptAt && this.interruptedMatch?.matchId !== matchId) {
            this.interruptedMatch = { matchId: matchId, epoch: this.lastActiveCommit.epoch };
        }
    }

    confirm(checkpoint: TownCheckpoint, now: number, localId: string | undefined, isDirector: boolean): void {
        const { state } = checkpoint;
        // Agreement ends the previous wait even if the next host pump is itself delayed.
        this.interruptAt = undefined;
        this.lastActiveCommit = state.phase === 'playing' || state.phase === 'countdown'
            ? { at: now, epoch: checkpoint.epoch, matchId: state.matchId }
            : undefined;
        const observing = checkpoint.state.seats.some((seat) => seat.id === localId && seat.status === 'observer');
        if (state.phase === 'finished' || observing || (this.interruptedMatch && checkpoint.epoch > this.interruptedMatch.epoch && !isDirector)) {
            this.interruptedMatch = undefined;
        }
    }
}
