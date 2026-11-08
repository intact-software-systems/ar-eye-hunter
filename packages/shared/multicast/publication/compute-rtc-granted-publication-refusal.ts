import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALOutboundDispatchPlan } from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import { resolveRallarGroupLeaderSessionId } from '../../api/group-director.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';

export const RTC_GRANTED_PUBLICATION_REFUSALS = {
    unfrozenAudience:
        'RTC carries a granted publication only as an audience its origin freezes: a room multicast, a listed or principal room broadcast, or a room unicast.',
    unsigned: 'RTC carries a granted publication only signed by its origin.',
    revokedPublisher: 'RTC re-sends a stored granted publication only while its origin holds publish.',
    leaderNotSubscribed:
        'RTC carries a granted group-leader publication only to a leader that holds subscribe on its topic.'
} as const;

export interface ResolveRtcGrantedLeaderRefusalInput {
    readonly msg: ALMessage;
    /** The origin's cached snapshot of the message's room; `null` when it holds none. */
    readonly snapshot: GroupSnapshot | null;
    readonly selfSessionId: string;
    readonly subscribeHolders: ReadonlySet<string>;
}

/**
 * A granted `group-leader` send whose room's leader holds no `subscribe` on its topic has no leader RTC may reach: it
 * is refused as unsupported, the refusal a fallback carrier takes over. A room without a leader, or one the sender
 * leads, keeps the planner's `no-leader`, as any room send does.
 */
export function resolveRtcGrantedLeaderRefusal(input: ResolveRtcGrantedLeaderRefusalInput): string | undefined {
    if (input.msg.delivery?.ack !== 'group-leader' || input.snapshot === null) {
        return undefined;
    }
    const leaderSessionId = resolveRallarGroupLeaderSessionId(input.snapshot);
    return leaderSessionId === undefined || leaderSessionId === input.selfSessionId ||
            input.subscribeHolders.has(leaderSessionId)
        ? undefined
        : RTC_GRANTED_PUBLICATION_REFUSALS.leaderNotSubscribed;
}

/**
 * The shape a granted publication must have before its origin signs it -- an audience its origin freezes: a room
 * multicast, a listed or principal room broadcast, or a room unicast; `undefined` when RTC can carry it.
 */
export function resolveRtcGrantedPublicationShapeRefusal(msg: ALMessage): string | undefined {
    return isRtcFreezableAudience(msg.targets) ? undefined : RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience;
}

function isRtcFreezableAudience(targets: ALMessage['targets']): boolean {
    switch (targets?.mode) {
        case 'multicast':
            return true;
        case 'broadcast':
            return targets.groupRef !== undefined &&
                ((targets.scope === 'room' && targets.recipientPeerIds !== undefined) ||
                    (targets.scope === 'principal' && targets.principalRef !== undefined));
        case 'unicast':
            return targets.groupRef !== undefined;
        default:
            return false;
    }
}

/** The message an origin carries, the one its sender gave, and whether the plan re-sends a stored copy. */
export interface RtcGrantedPublicationRefusalInput {
    readonly carried: ALMessage;
    readonly original: ALMessage;
    /** A re-plan or dequeue of a stored own message, which carries it only signed and re-reads `publish` (S3-R8). */
    readonly storedSend: boolean;
}

/**
 * RTC carries a granted publication only as an audience its origin freezes, and a stored one only signed and only as
 * the multicast its leg admission froze: a first admission carries it unsigned, since its admission signs it after the
 * read stamped it. Any other is refused as unsupported, the refusal a fallback carrier takes over. Its shape is judged,
 * and the refusal named, by the targets its sender gave, never by the multicast the origin froze them to.
 */
export function computeRtcGrantedPublicationRefusal(
    input: RtcGrantedPublicationRefusalInput
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    const { carried, original } = input;
    const refusal = resolveRtcGrantedPublicationShapeRefusal(original) ?? resolveRtcSignedSendRefusal(input);
    return refusal === undefined
        ? Either.ofRight(carried)
        : Either.ofLeft({
            msg: { ...carried, targets: original.targets },
            dropReason: refusal,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}

/**
 * A stored copy is re-sent only signed, and a signed one only as the multicast its leg admission produced: only a leg
 * freezes a list, a principal broadcast or a unicast before its admission signs it, so a proof on any other shape its
 * sender gave -- a stored copy or one through `enqueueIfAbsent` -- is refused.
 */
function resolveRtcSignedSendRefusal(input: RtcGrantedPublicationRefusalInput): string | undefined {
    const { carried, original } = input;
    if (carried.proof === undefined) {
        return input.storedSend ? RTC_GRANTED_PUBLICATION_REFUSALS.unsigned : undefined;
    }
    return original.targets?.mode === 'multicast' ? undefined : RTC_GRANTED_PUBLICATION_REFUSALS.unfrozenAudience;
}
