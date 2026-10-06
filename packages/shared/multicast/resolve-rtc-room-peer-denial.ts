import type { ALMessage } from '../al-contracts/al-contract.ts';
import { isSameGroupRef } from '../api/api-type-utils.ts';
import type {
    GroupMember,
    GroupPresenceSession,
    GroupRef,
    GroupSnapshot
} from '../api/group-types.ts';

export type RtcRoomAuthorityDenial =
    | { readonly kind: 'pending'; readonly reason: string; }
    | {
        readonly kind: 'unauthorized';
        readonly reason: string;
        /**
         * Current edge absence denies sending without declaring retained origin work permanently unroutable; a
         * sender no longer in the roster it stamped is fenced, which the receiver tells its immediate hop.
         */
        readonly cause: 'authority-rejected' | 'edge-unavailable' | 'membership-fenced';
    };

export interface RtcRoomSessionObservation {
    readonly roomRef: GroupRef;
    readonly sessions: ReadonlyMap<string, GroupPresenceSession>;
    readonly members: ReadonlyMap<string, GroupMember>;
    readonly nowMs: number;
}

/** Where the receiver's roster stands against the one the copy was stamped with. */
export type RtcRoomRosterPosition = 'behind' | 'at' | 'beyond' | 'unstamped';

/** A peer needs a live session in the room and an active member behind it. */
export function resolveRtcRoomPeerDenial(
    observation: RtcRoomSessionObservation,
    peerId: string
): RtcRoomAuthorityDenial | undefined {
    const session = observation.sessions.get(peerId);
    if (!session) {
        return { kind: 'pending', reason: 'Awaiting room session authority' };
    }
    const sessionDenial = resolveLiveSessionDenial(observation, session);
    if (sessionDenial) {
        return sessionDenial;
    }
    const member = observation.members.get(session.principalId);
    if (!member) {
        return { kind: 'pending', reason: 'Awaiting room member authority' };
    }
    return isActiveRoomMember(observation, member) ? undefined : {
        kind: 'unauthorized',
        cause: 'authority-rejected',
        reason: 'Room member authority is inactive or in another scope'
    };
}

export function resolveRtcRoomRosterPosition(message: ALMessage, snapshot: GroupSnapshot): RtcRoomRosterPosition {
    const targets = message.targets;
    const stamp = targets && targets.mode !== 'unicast' ? targets.rosterVersion : undefined;
    if (stamp === undefined) {
        return 'unstamped';
    }
    const held = snapshot.group.rosterVersion;
    return held < stamp ? 'behind' : held === stamp ? 'at' : 'beyond';
}

/**
 * The sender of a copy at ingress is judged on the roster it stamped. Behind that roster the floor holds the copy; at
 * or beyond it a member that is absent or not active is fenced. An authoritative snapshot lists live sessions of
 * active members only, and presence moves no roster: so a sender with no session at its own roster is awaited, while
 * one with no session in a later roster has left the roster or its session since the stamp.
 */
export function resolveRtcRoomSenderDenial(
    observation: RtcRoomSessionObservation,
    senderId: string,
    roster: RtcRoomRosterPosition
): RtcRoomAuthorityDenial | undefined {
    const session = observation.sessions.get(senderId);
    if (!session) {
        return roster === 'beyond'
            ? toMembershipFence('Room sender has no live session in a roster beyond its stamp')
            : { kind: 'pending', reason: 'Awaiting room session authority' };
    }
    const sessionDenial = resolveLiveSessionDenial(observation, session);
    if (sessionDenial || roster === 'behind') {
        return sessionDenial;
    }
    const member = observation.members.get(session.principalId);
    return member && isActiveRoomMember(observation, member)
        ? undefined
        : toMembershipFence('Room sender is not an active member of the room roster');
}

function resolveLiveSessionDenial(
    observation: RtcRoomSessionObservation,
    session: GroupPresenceSession
): RtcRoomAuthorityDenial | undefined {
    if (
        !isSameGroupRef(session, observation.roomRef) || session.status !== 'active' ||
        session.expiresAtEpochMs <= observation.nowMs
    ) {
        return {
            kind: 'unauthorized',
            cause: 'authority-rejected',
            reason: 'Room session authority is inactive, expired, or in another scope'
        };
    }
    return undefined;
}

function isActiveRoomMember(observation: RtcRoomSessionObservation, member: GroupMember): boolean {
    return member.status === 'active' && isSameGroupRef(member, observation.roomRef);
}

function toMembershipFence(reason: string): RtcRoomAuthorityDenial {
    return { kind: 'unauthorized', cause: 'membership-fenced', reason };
}
