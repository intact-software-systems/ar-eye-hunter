import type { TownMatchIdentity } from './town-match.ts';

export interface TownMatchSeat {
    readonly id: string;
    readonly sessionId: string;
    readonly status: 'active' | 'away' | 'observer';
    readonly expiresAtEpochMs: number;
}

export interface TownMatchSeatObservation {
    readonly seats: readonly TownMatchSeat[];
    readonly available: readonly TownMatchIdentity[];
    readonly departedIds: readonly string[];
    readonly now: number;
}

export function createTownMatchSeats(members: readonly TownMatchIdentity[]): readonly TownMatchSeat[] {
    return members.map(({ id, sessionId }) => ({ id, sessionId, status: 'active', expiresAtEpochMs: 0 }));
}

export function computeTownMatchSeats(observation: TownMatchSeatObservation): readonly TownMatchSeat[] {
    return observation.seats.map((seat) => {
        if (seat.status === 'observer') {
            return seat;
        }
        if (
            observation.departedIds.includes(seat.id) ||
            (seat.status === 'away' && observation.now >= seat.expiresAtEpochMs)
        ) {
            return { ...seat, status: 'observer', expiresAtEpochMs: 0 };
        }
        const controller = observation.available.find((member) => member.id === seat.id);
        if (controller) {
            return { ...seat, sessionId: controller.sessionId, status: 'active', expiresAtEpochMs: 0 };
        }
        return seat.status === 'away'
            ? seat
            : { ...seat, status: 'away', expiresAtEpochMs: observation.now + 10000 };
    });
}
