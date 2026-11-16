import { Either } from '@shared/resilience/Either.ts';

import type { PracticeInput } from '../practice-rules.ts';
import type { TownMatchState } from './town-match.ts';

export interface TownMatchInput {
    readonly matchId: string;
    readonly playerId: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly controls: PracticeInput;
    readonly expiresAt: number;
}
export interface TownMatchInputRequest {
    readonly state: TownMatchState;
    readonly previous: TownMatchInput | undefined;
    readonly playerId: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly controls: PracticeInput;
    /** Director receive time; never a timestamp claimed by the sending player. */
    readonly now: number;
}

export function computeTownMatchInput(request: TownMatchInputRequest): Either<readonly string[], TownMatchInput> {
    const issues = validateTownMatchInput(request);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    return Either.ofRight({
        matchId: request.state.matchId,
        playerId: request.playerId,
        sessionId: request.sessionId,
        sequence: request.sequence,
        controls: { ...request.controls },
        expiresAt: request.now + 250
    });
}

export function validateTownMatchInput(request: TownMatchInputRequest): readonly string[] {
    const { state, controls, previous } = request;
    const issues: string[] = [];
    if (state.phase !== 'playing') {
        issues.push('Controls are accepted only during the round.');
    }
    if (!state.members.some((member) => member.id === request.playerId && member.sessionId === request.sessionId)) {
        issues.push('The input does not belong to a current player session.');
    }
    if (
        !state.seats.some((seat) =>
            seat.id === request.playerId && seat.sessionId === request.sessionId && seat.status === 'active'
        )
    ) {
        issues.push('Only an active round seat may control a player.');
    }
    if (
        !Number.isSafeInteger(request.sequence) || request.sequence < 0 ||
        (previous?.matchId === state.matchId && previous.playerId === request.playerId &&
            previous.sessionId === request.sessionId && request.sequence <= previous.sequence)
    ) {
        issues.push('Input sequence must advance for this player session.');
    }
    if (
        !Number.isFinite(controls.x) || !Number.isFinite(controls.z) || Math.abs(controls.x) > 1 ||
        Math.abs(controls.z) > 1 || !Number.isSafeInteger(controls.dash) || controls.dash < 0 ||
        controls.dash > 1_000_000
    ) {
        issues.push('Movement and dash values exceed their bounds.');
    }
    if (!Number.isFinite(request.now) || request.now < 0) {
        issues.push('Director receive time must be finite and non-negative.');
    }
    return issues;
}
