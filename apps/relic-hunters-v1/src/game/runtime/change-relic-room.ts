import { hasUnfinishedRelicParticipation, type RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import { relicPlayerId } from '@relic-hunters/src/relic-tournament-participation.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

import type { RelicExpeditionParticipation } from './relic-expedition-participation.ts';

/** One entry checks at most three rooms, R to S to T, before the session has none; a further move is churning. */
const MAX_FOLLOWED_ROOM_MOVES = 2;
const ROOM_ENTRY_CHANGED = 'Room entry changed while checking expedition participation.';

type RelicRoomSession = Pick<AuthSession, 'sessionId' | 'clientId'>;

export interface RelicRoomChangeDependencies {
    session(): RelicRoomSession | undefined;
    currentRoomId(): string | undefined;
    withParticipationLock<T>(roomId: string, sessionId: string, run: () => Promise<T>): Promise<T>;
    readonly participation: Pick<RelicExpeditionParticipation, 'reconcile'>;
    fetchSnapshot(roomId: string): Promise<RelicPublicSnapshot | undefined>;
}

interface RoomCheck {
    readonly dependencies: RelicRoomChangeDependencies;
    readonly session: RelicRoomSession;
    readonly roomId: string;
    readonly destinationRoomId: string | undefined;
}

type RoomCheckState = 'current' | 'current-room-moved' | 'session-changed';

type RoomCheckOutcome<T> =
    | { readonly kind: 'changed'; readonly result: T; }
    | { readonly kind: 'current-room-moved' | 'session-changed' | 'unfinished-participation'; };

/**
 * A second tab must not implicitly leave a hunter whose Join was committed after this tab's last snapshot.
 * The current room is cache-derived and can move during the check (a committed disconnect lands late), so
 * the check follows it to the room that now holds the session, or to none.
 */
export async function changeRelicRoom<T>(
    dependencies: RelicRoomChangeDependencies,
    change: () => Promise<T>,
    destinationRoomId?: string
): Promise<T> {
    const session = dependencies.session();
    if (!session) {
        return await change();
    }
    for (let followedMoves = 0;; followedMoves += 1) {
        const roomId = dependencies.currentRoomId();
        if (dependencies.session()?.sessionId !== session.sessionId) {
            throw new Error(ROOM_ENTRY_CHANGED);
        }
        if (!roomId) {
            return await change();
        }
        if (followedMoves > MAX_FOLLOWED_ROOM_MOVES) {
            throw new Error(ROOM_ENTRY_CHANGED);
        }
        const check: RoomCheck = { dependencies, session, roomId, destinationRoomId };
        const outcome = await dependencies.withParticipationLock(
            roomId,
            session.sessionId,
            () => changeFromCheckedRoom(check, change)
        );
        if (outcome.kind === 'changed') {
            return outcome.result;
        }
        if (outcome.kind === 'session-changed') {
            throw new Error(ROOM_ENTRY_CHANGED);
        }
        if (outcome.kind === 'unfinished-participation') {
            throw new Error('Use Leave expedition before entering or watching another expedition.');
        }
    }
}

async function changeFromCheckedRoom<T>(check: RoomCheck, change: () => Promise<T>): Promise<RoomCheckOutcome<T>> {
    const { dependencies, session, roomId } = check;
    const before = readRoomCheckState(check);
    if (before !== 'current') {
        return { kind: before };
    }
    await dependencies.participation.reconcile(roomId, session.sessionId);
    const snapshot = await dependencies.fetchSnapshot(roomId);
    const after = readRoomCheckState(check);
    if (after !== 'current') {
        return { kind: after };
    }
    if (
        roomId !== check.destinationRoomId &&
        hasUnfinishedRelicParticipation(snapshot, relicPlayerId(snapshot?.tournament?.binding ?? null, session))
    ) {
        return { kind: 'unfinished-participation' };
    }
    return { kind: 'changed', result: await change() };
}

function readRoomCheckState({ dependencies, session, roomId }: RoomCheck): RoomCheckState {
    if (dependencies.session()?.sessionId !== session.sessionId) {
        return 'session-changed';
    }
    return dependencies.currentRoomId() === roomId ? 'current' : 'current-room-moved';
}
