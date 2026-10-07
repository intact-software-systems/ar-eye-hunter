/**
 * `recipient-b` is the second, distinguishable recipient of a three-agent scenario. `successor` is a second page
 * in the sender's own browser context: the same storage and auth session under an agent of its own. `sibling` is a
 * second session of the sender's principal: a browser context and sign-in of its own as the sender's user. Room
 * membership is per principal, so a sibling shares the sender's membership; no same-principal scenario leaves the room.
 */
export const ALM_CONFORMANCE_ROLES = ['sender', 'receiver', 'recipient-b', 'successor', 'sibling'] as const;

export type AlmConformanceRole = typeof ALM_CONFORMANCE_ROLES[number];

/** An origin and two distinguishable recipients: every `three-agent` scenario declares these roles. */
export const ALM_CONFORMANCE_THREE_AGENT_ROLES: readonly AlmConformanceRole[] = ['sender', 'receiver', 'recipient-b'];

/** The sender's principal twice and another principal once: every `same-principal` scenario declares these roles. */
export const ALM_CONFORMANCE_SAME_PRINCIPAL_ROLES: readonly AlmConformanceRole[] = ['sender', 'receiver', 'sibling'];

export function isAlmConformanceRole(value: string): value is AlmConformanceRole {
    return (ALM_CONFORMANCE_ROLES as readonly string[]).includes(value);
}
