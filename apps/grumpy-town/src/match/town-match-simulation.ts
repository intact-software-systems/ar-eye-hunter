import { TownRoutes } from '../town/town-routes.ts';
import { TOWN_MATCH_CHECKPOINT_LEAD_TICKS } from './agreement/town-match-recovery-window.ts';
import { computeTownMatchExtension } from './match-extension.ts';
import { computeTownMatchInput, type TownMatchInput } from './match-input.ts';
import type { TownMatchFrame } from './match-protocol.ts';
import {
    computeTownMatchReady,
    computeTownMatchRematch,
    computeTownMatchStart,
    computeTownMatchTick,
    TOWN_MATCH_RATE,
    type TownMatchState,
    type TownMatchTick
} from './town-match.ts';

/** Director-owned speculative state; only the checkpoint owner may publish accepted results. */
export class TownMatchSimulation {
    private readonly routes = new TownRoutes();
    private inputs: TownMatchInput[] = [];
    private readonly commands = new Map<string, number>();
    private state: TownMatchState;
    private lastTick: number;

    constructor(state: TownMatchState, now: number) {
        this.state = state;
        this.lastTick = now;
    }

    getState(): TownMatchState {
        return this.state;
    }

    advance(now: number, committed: TownMatchState | undefined, clock: TownMatchTick['clock']): void {
        const confirmedTime = committed ? committed.tick - committed.countdownTicks : 0;
        const unconfirmedTime = this.state.tick - this.state.countdownTicks;
        const maxAdvance = TOWN_MATCH_CHECKPOINT_LEAD_TICKS;
        const budget = committed ? maxAdvance - (unconfirmedTime - confirmedTime) : maxAdvance;
        if (budget <= 0) {
            this.lastTick = now;
            this.inputs = this.inputs.filter(input => input.expiresAt > now);
            return;
        }
        // A delayed host pump still owes real elapsed ticks, up to the agreement lead.
        const elapsedTicks = Math.floor((now - this.lastTick) * TOWN_MATCH_RATE / 1000);
        const ticks = Math.min(maxAdvance, budget, elapsedTicks);
        // If the host slept beyond the catch-up limit, simulate the most recent playable interval.
        const start = elapsedTicks > maxAdvance ? now - ticks * 1000 / TOWN_MATCH_RATE : this.lastTick;
        for (let index = 0; index < ticks; index += 1) {
            this.state = computeTownMatchTick({
                state: this.state,
                routes: this.routes,
                clock,
                inputs: this.inputs,
                now: start + index * 1000 / TOWN_MATCH_RATE
            });
        }
        this.lastTick = start + ticks * 1000 / TOWN_MATCH_RATE;
        this.inputs = this.inputs.filter(input => input.expiresAt > this.lastTick);
    }

    /** The room session validates scope, appointment and authenticated sender before this entry. */
    accept(frame: TownMatchFrame, senderId: string, now: number): void {
        const member = this.state.members.find((member) => member.sessionId === senderId);
        if (!member || frame.matchId !== this.state.matchId || frame.sequence <= (this.commands.get(senderId) ?? 0)) {
            return;
        }
        this.commands.set(senderId, frame.sequence);
        switch (frame.action.kind) {
            case 'ready':
                this.state = computeTownMatchReady(this.state, {
                    ...member,
                    ready: frame.action.ready,
                    displayName: frame.action.displayName
                });
                break;
            case 'extend':
                this.state = computeTownMatchExtension(this.state, frame.action.expectedDurationTicks);
                break;
            case 'start':
                this.state = computeTownMatchStart(this.state);
                break;
            case 'controls': {
                const input = computeTownMatchInput({
                    state: this.state,
                    previous: this.inputs.find(sample => sample.sessionId === senderId),
                    playerId: member.id,
                    sessionId: senderId,
                    sequence: frame.sequence,
                    controls: frame.action,
                    now
                });
                if (input.right) {
                    // Newest first: each historical tick takes the last sample received by its start.
                    this.inputs.unshift(input.right);
                }
                break;
            }
            case 'rematch':
                this.state = computeTownMatchRematch(this.state, frame.action.nextMatchId).right ?? this.state;
                this.inputs = [];
                break;
        }
    }

    pause(now: number): void {
        this.lastTick = now;
        this.inputs = [];
    }

    stop(): void {
        this.routes.clear();
        this.inputs = [];
        this.commands.clear();
    }
}
