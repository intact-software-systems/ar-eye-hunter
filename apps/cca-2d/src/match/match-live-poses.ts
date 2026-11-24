import type { TownMatchFrame, TownMatchPose } from './match-protocol.ts';
import { TOWN_MATCH_RATE, type TownMatchState } from './town-match.ts';

export namespace TownMatchLivePoses {
    export interface Sample {
        readonly matchId: string;
        readonly sequence: number;
        readonly tick: number;
        readonly players: readonly TownMatchPose[];
        readonly receivedAtMs: number;
        readonly transport: 'rtc' | 'ws' | 'local';
    }
    export interface Reception {
        readonly frame: TownMatchFrame;
        readonly match: TownMatchState;
        readonly now: number;
        readonly transport: Sample['transport'];
    }
}

/** Latest host pose observation, separate from scores and recovery truth. Scope/authority is checked by the session. */
export class TownMatchLivePoses {
    private latest: TownMatchLivePoses.Sample | undefined;

    accept(reception: TownMatchLivePoses.Reception): boolean {
        const { frame, match, now, transport } = reception;
        const action = frame.action;
        if (
            action.kind !== 'poses' || match.phase !== 'playing' || frame.matchId !== match.matchId ||
            action.tick < match.tick || action.tick > match.tick + TOWN_MATCH_RATE * 2 + 3 ||
            (this.latest && (frame.sequence <= this.latest.sequence || action.tick <= this.latest.tick))
        ) {
            return false;
        }
        const active = match.seats.filter((seat) => seat.status === 'active');
        if (
            action.players.length !== active.length ||
            new Set(action.players.map((player) => player.id)).size !== active.length ||
            action.players.some((player) => !active.some((seat) => seat.id === player.id))
        ) {
            return false;
        }
        this.latest = {
            matchId: frame.matchId,
            sequence: frame.sequence,
            tick: action.tick,
            players: action.players,
            receivedAtMs: now,
            transport
        };
        return true;
    }

    resolve(match: TownMatchState | undefined, now: number): TownMatchLivePoses.Sample | undefined {
        const latest = this.latest;
        return latest && match?.phase === 'playing' && latest.matchId === match.matchId && latest.tick >= match.tick &&
                now >= latest.receivedAtMs && now - latest.receivedAtMs <= 250
            ? latest
            : undefined;
    }

    clear(): void {
        this.latest = undefined;
    }
}
