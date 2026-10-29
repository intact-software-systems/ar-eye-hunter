import { Either } from '../resilience/Either.ts';

export interface RallarGameParticipant {
    readonly sessionId: string;
    /** Identifies current membership, independently of a transport connection or heartbeat. */
    readonly participationKey: string;
}

export type RallarGameRematchPlayer =
    | Readonly<{ sessionId: string; ready: false; }>
    | Readonly<{ sessionId: string; ready: true; participationKey: string; }>;

/** Player consent for exactly one completed game and one proposed setup. */
export interface RallarGameRematch {
    readonly completedGameId: string;
    readonly settingsKey: string;
    readonly players: readonly RallarGameRematchPlayer[];
}

export interface RallarGameRematchReadyAssignment {
    readonly completedGameId: string;
    readonly settingsKey: string;
    readonly sessionId: string;
    readonly ready: boolean;
    readonly participationKey: string;
}

export interface RallarGameRematchStartAuthority {
    readonly completedGameId: string;
    readonly settingsKey: string;
    readonly actorSessionId: string;
    readonly leaderSessionId: string | undefined;
    readonly participants: readonly RallarGameParticipant[];
}

export interface RallarGameRematchRefusal {
    readonly code:
        | 'invalid-preparation'
        | 'capacity-reached'
        | 'stale-preparation'
        | 'stale-participation'
        | 'player-required'
        | 'leader-required'
        | 'leader-not-ready'
        | 'players-not-ready';
    readonly message: string;
}

export interface RallarGameRematchInputDto {
    readonly completedGameId: string;
    readonly settingsKey: string;
    readonly participantSessionIds: readonly string[];
    readonly capacity: number;
}

export interface RallarGameRematchReadyInputDto {
    readonly preparation: RallarGameRematch;
    readonly assignment: RallarGameRematchReadyAssignment;
    readonly participants: readonly RallarGameParticipant[];
    readonly capacity: number;
}

export function createRallarGameRematch(
    proposal: RallarGameRematchInputDto
): Either<RallarGameRematchRefusal, RallarGameRematch> {
    if (proposal.participantSessionIds.length > proposal.capacity) {
        return Either.ofLeft({ code: 'capacity-reached', message: 'The next game is full.' });
    }
    const preparation = {
        completedGameId: proposal.completedGameId,
        settingsKey: proposal.settingsKey,
        players: proposal.participantSessionIds.toSorted().map((sessionId) => ({ sessionId, ready: false as const }))
    };
    return isRallarGameRematch(preparation, proposal.capacity)
        ? Either.ofRight(preparation)
        : Either.ofLeft({ code: 'invalid-preparation', message: 'The next game preparation is invalid.' });
}

/** Eligibility is supplied by the game authority, never by the requesting browser. */
export function setRallarGameRematchReady(
    update: RallarGameRematchReadyInputDto
): Either<RallarGameRematchRefusal, RallarGameRematch> {
    const { preparation, assignment, participants, capacity } = update;
    if (!isSamePreparation(preparation, assignment)) {
        return Either.ofLeft({ code: 'stale-preparation', message: 'The game or its settings have changed.' });
    }
    const participant = participants.find((candidate) => candidate.sessionId === assignment.sessionId);
    if (!participant) {
        return Either.ofLeft({ code: 'player-required', message: 'A present player session is required.' });
    }
    if (!assignment.participationKey || assignment.participationKey !== participant.participationKey) {
        return Either.ofLeft({ code: 'stale-participation', message: 'Your room membership changed. Confirm again.' });
    }
    const existing = preparation.players.find((player) => player.sessionId === assignment.sessionId);
    if (
        (!existing && !assignment.ready) || (existing && !existing.ready && !assignment.ready) ||
        (existing?.ready && assignment.ready && existing.participationKey === participant.participationKey)
    ) {
        return Either.ofRight(preparation);
    }
    const roster = !existing && preparation.players.length >= capacity
        ? preparation.players.filter((player) =>
            participants.some((participant) => participant.sessionId === player.sessionId)
        )
        : preparation.players;
    if (!existing && roster.length >= capacity) {
        return Either.ofLeft({ code: 'capacity-reached', message: 'The next game is full.' });
    }
    const assigned: RallarGameRematchPlayer = assignment.ready
        ? { sessionId: assignment.sessionId, ready: true, participationKey: participant.participationKey }
        : { sessionId: assignment.sessionId, ready: false };
    const players = existing
        ? roster.map((player) => player.sessionId === assignment.sessionId ? assigned : player)
        : [...roster, assigned];
    return Either.ofRight({ ...preparation, players: players.toSorted(compareRematchPlayers) });
}

export function changeRallarGameRematchSettings(
    preparation: RallarGameRematch,
    settingsKey: string
): RallarGameRematch {
    return preparation.settingsKey === settingsKey ? preparation : {
        ...preparation,
        settingsKey,
        players: preparation.players.map((player) => ({ sessionId: player.sessionId, ready: false }))
    };
}

/** The caller fences these fresh eligibility observations in its authoritative start transition. */
export function evaluateRallarGameRematchStart(
    preparation: RallarGameRematch,
    authority: RallarGameRematchStartAuthority
): Either<RallarGameRematchRefusal, readonly string[]> {
    if (!isSamePreparation(preparation, authority)) {
        return Either.ofLeft({ code: 'stale-preparation', message: 'The game or its settings have changed.' });
    }
    if (authority.actorSessionId !== authority.leaderSessionId) {
        return Either.ofLeft({ code: 'leader-required', message: 'Only the current leader can start the next game.' });
    }
    const participants = new Map(
        authority.participants.map((participant) => [participant.sessionId, participant.participationKey])
    );
    if (!participants.has(authority.actorSessionId)) {
        return Either.ofLeft({ code: 'player-required', message: 'A present player session is required.' });
    }
    const eligible = preparation.players.filter((player) => participants.has(player.sessionId));
    if (
        !eligible.some((player) =>
            player.sessionId === authority.actorSessionId && player.ready &&
            player.participationKey === participants.get(player.sessionId)
        )
    ) {
        return Either.ofLeft({ code: 'leader-not-ready', message: 'The leader must also confirm Play again.' });
    }
    if (eligible.some((player) => !player.ready || player.participationKey !== participants.get(player.sessionId))) {
        return Either.ofLeft({ code: 'players-not-ready', message: 'Waiting for the remaining players to confirm.' });
    }
    return Either.ofRight(eligible.map((player) => player.sessionId));
}

export function isRallarGameRematch(value: unknown, capacity: number): value is RallarGameRematch {
    return Number.isSafeInteger(capacity) && capacity > 0 &&
        typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 3 &&
        'completedGameId' in value && 'settingsKey' in value && 'players' in value &&
        typeof value.completedGameId === 'string' && value.completedGameId.length > 0 &&
        typeof value.settingsKey === 'string' && value.settingsKey.length > 0 &&
        Array.isArray(value.players) && value.players.length <= capacity &&
        value.players.every(isRematchPlayer) &&
        new Set(value.players.map((player) => player.sessionId)).size === value.players.length;
}

function isRematchPlayer(value: unknown): value is RallarGameRematchPlayer {
    return typeof value === 'object' && value !== null && !Array.isArray(value) &&
        'sessionId' in value && 'ready' in value && typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
        (value.ready === false && Object.keys(value).length === 2 ||
            value.ready === true && Object.keys(value).length === 3 &&
                'participationKey' in value && typeof value.participationKey === 'string' &&
                value.participationKey.length > 0);
}

function isSamePreparation(
    preparation: RallarGameRematch,
    identity: Pick<RallarGameRematch, 'completedGameId' | 'settingsKey'>
): boolean {
    return preparation.completedGameId === identity.completedGameId && preparation.settingsKey === identity.settingsKey;
}

function compareRematchPlayers(left: RallarGameRematchPlayer, right: RallarGameRematchPlayer): number {
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
}
