import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALOutboundDispatchPlan } from '../../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../../alm/outbound/al-outbound-transport-message.ts';
import { resolveRallarGroupLeaderSessionId } from '../../api/group-director.ts';
import type { GroupSnapshot } from '../../api/group-types.ts';
import { Either } from '../../resilience/Either.ts';

export const RTC_GRANTED_PUBLICATION_REFUSALS = {
    notMulticast: 'RTC carries a granted publication only as a room multicast.',
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

/** The shape a granted publication must have before its origin signs it; `undefined` when RTC can carry it. */
export function resolveRtcGrantedPublicationShapeRefusal(msg: ALMessage): string | undefined {
    return msg.targets?.mode === 'multicast' ? undefined : RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast;
}

/**
 * RTC carries a granted publication only as a room multicast, and a stored one (`storedSend`) only signed: a first
 * admission carries it unsigned, since its admission signs it after the read stamped it. Any other is refused as
 * unsupported, the refusal a fallback carrier takes over. Its shape is judged, and the refusal named, by the targets
 * its sender gave, never by the multicast the origin froze them to.
 */
export function computeRtcGrantedPublicationRefusal(
    msg: ALMessage,
    original: ALMessage,
    storedSend: boolean
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    const refusal = resolveRtcGrantedPublicationShapeRefusal(original) ??
        (storedSend && msg.proof === undefined ? RTC_GRANTED_PUBLICATION_REFUSALS.unsigned : undefined);
    return refusal === undefined
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg: { ...msg, targets: original.targets },
            dropReason: refusal,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}
