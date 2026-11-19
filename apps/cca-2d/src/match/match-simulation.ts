import { TownRoutes } from '../town/routes.ts';
import { computeTownMatchInput, type TownMatchInput } from './match-input.ts';
import type { TownMatchFrame } from './match-protocol.ts';
import {
    computeTownMatchReady,
    computeTownMatchRematch,
    computeTownMatchStart,
    computeTownMatchTick,
    TOWN_MATCH_RATE,
    type TownMatchTick,
    type TownMatchState
} from './town-match.ts';

/** Director-owned speculative state; only the checkpoint owner may publish accepted results. */
export class TownMatchSimulation {
    private readonly routes = new TownRoutes();
    private readonly inputs = new Map<string, TownMatchInput>();
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
        if (committed && unconfirmedTime - confirmedTime >= TOWN_MATCH_RATE * 2) {
            this.lastTick = now;
            return;
        }
        const ticks = Math.min(3, Math.floor((now - this.lastTick) * TOWN_MATCH_RATE / 1000));
        for (let index = 0; index < ticks; index += 1) {
            this.state = computeTownMatchTick({
                state: this.state,
                routes: this.routes,
                clock,
                inputs: [...this.inputs.values()],
                now
            });
        }
        this.lastTick += ticks * 1000 / TOWN_MATCH_RATE;
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
            case 'start':
                this.state = computeTownMatchStart(this.state);
                break;
            case 'controls': {
                const input = computeTownMatchInput({
                    state: this.state,
                    previous: this.inputs.get(senderId),
                    playerId: member.id,
                    sessionId: senderId,
                    sequence: frame.sequence,
                    controls: frame.action,
                    now
                });
                if (input.right) {
                    this.inputs.set(senderId, input.right);
                }
                break;
            }
            case 'rematch':
                this.state = computeTownMatchRematch(this.state, frame.action.nextMatchId).right ?? this.state;
                this.inputs.clear();
                break;
        }
    }

    pause(now: number): void {
        this.lastTick = now;
        this.inputs.clear();
    }

    stop(): void {
        this.routes.clear();
        this.inputs.clear();
        this.commands.clear();
    }
}
