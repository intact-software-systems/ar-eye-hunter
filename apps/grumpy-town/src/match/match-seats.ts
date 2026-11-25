import type { RallarFacade } from '@shared-web/browser/rallar.ts';
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
    readonly clock: Pick<RallarFacade, 'deadlineAfter' | 'compareDeadline'>;
}

export function createTownMatchSeats(members: readonly TownMatchIdentity[]): readonly TownMatchSeat[] {
    return members.map(({ id, sessionId }) => ({ id, sessionId, status: 'active', expiresAtEpochMs: 0 }));
}

export function computeTownMatchSeats(observation: TownMatchSeatObservation): readonly TownMatchSeat[] {
    return observation.seats.map((seat) => {
        if (seat.status === 'observer') {
            return seat;
        }
        if (observation.departedIds.includes(seat.id)) {
            return { ...seat, status: 'observer', expiresAtEpochMs: 0 };
        }
        if (seat.status === 'away') {
            const comparison = observation.clock.compareDeadline(seat.expiresAtEpochMs);
            if (comparison === 'at-or-after') {
                return { ...seat, status: 'observer', expiresAtEpochMs: 0 };
            }
            if (comparison !== 'before') {
                return seat;
            }
        }
        const controller = observation.available.find((member) => member.id === seat.id);
        if (controller) {
            return { ...seat, sessionId: controller.sessionId, status: 'active', expiresAtEpochMs: 0 };
        }
        if (seat.status === 'away') {
            return seat;
        }
        const expiresAtEpochMs = observation.clock.deadlineAfter(10_000);
        return expiresAtEpochMs === undefined ? seat : { ...seat, status: 'away', expiresAtEpochMs };
    });
}
