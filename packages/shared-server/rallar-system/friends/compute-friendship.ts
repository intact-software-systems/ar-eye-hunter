import type { FriendshipAction, FriendshipRefusal, FriendshipStatus } from '@shared/api/friends/friendship.ts';
import { Either } from '@shared/resilience/Either.ts';

export interface FriendshipRead {
    readonly action: FriendshipAction;
    readonly actor: FriendshipStatus | null;
    readonly target: FriendshipStatus | null;
}

export interface FriendshipComputed {
    readonly actor: FriendshipStatus | null;
    readonly target: FriendshipStatus | null;
}

export function computeFriendship(read: FriendshipRead): Either<FriendshipRefusal, FriendshipComputed> {
    assertConsistentFriendship(read);
    const { action, actor, target } = read;
    if (action === 'block') {
        return Either.ofRight({ actor: 'blocked', target: target === 'blocked' ? 'blocked' : null });
    }
    if (action === 'unblock') {
        return actor === 'blocked'
            ? Either.ofRight({ actor: null, target })
            : Either.ofLeft('request-unavailable');
    }
    if (actor === 'blocked' || target === 'blocked') {
        return Either.ofLeft('person-unavailable');
    }
    if (action === 'request') {
        return Either.ofRight(actor === null ? { actor: 'outgoing', target: 'incoming' } : { actor, target });
    }
    if (action === 'accept' && (actor === 'incoming' || actor === 'friend')) {
        return Either.ofRight({ actor: 'friend', target: 'friend' });
    }
    if (
        (action === 'decline' && actor === 'incoming') ||
        (action === 'cancel' && actor === 'outgoing') ||
        (action === 'remove' && actor === 'friend')
    ) {
        return Either.ofRight({ actor: null, target: null });
    }
    return Either.ofLeft('request-unavailable');
}

function assertConsistentFriendship({ actor, target }: FriendshipRead): void {
    const consistent = actor === 'friend'
        ? target === 'friend'
        : actor === 'incoming'
        ? target === 'outgoing'
        : actor === 'outgoing'
        ? target === 'incoming'
        : target === null || target === 'blocked';
    if (!consistent) {
        throw new TypeError('Friendship consent is inconsistent');
    }
}
