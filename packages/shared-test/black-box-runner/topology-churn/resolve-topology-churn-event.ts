export interface TopologyChurnPresentMember {
    readonly memberId: string;
    readonly presentSinceEpochMs: number;
}

interface ResolveTopologyChurnEventInput {
    readonly presentMembers: readonly TopologyChurnPresentMember[];
    readonly creatorMemberId: string;
    readonly eventIndex: number;
}

/** `skip` is a leave turn with no member but the creator present. */
export type TopologyChurnEvent =
    | { readonly kind: 'join'; }
    | { readonly kind: 'leave'; readonly memberId: string; }
    | { readonly kind: 'skip'; };

export function resolveTopologyChurnEvent(input: ResolveTopologyChurnEventInput): TopologyChurnEvent {
    if (input.eventIndex % 2 === 0) {
        return { kind: 'join' };
    }
    const leaver = input.presentMembers
        .filter((member) => member.memberId !== input.creatorMemberId)
        .reduce<TopologyChurnPresentMember | null>(
            (longest, member) =>
                longest === null || member.presentSinceEpochMs < longest.presentSinceEpochMs ? member : longest,
            null
        );
    return leaver === null ? { kind: 'skip' } : { kind: 'leave', memberId: leaver.memberId };
}
